#!/usr/bin/env node
import { parseRunTarget } from "./run-target.mjs";
import { TaskUpdateError } from "./task-update-error.mjs";
import { recordedWrites, coordinatedWrites, assertNoPendingWrite, RecordedWriteError } from "./recorded-write.mjs";
// sage: the state tool of sage mode. The chief of staff calls it through the shell: one command in, one line out.
// The store is plain TSV and Markdown under the configured root ($SAGE_HOME overrides it), and every
// table has one writer: this tool. It holds the rules that prompts alone did not hold in Orchestrator: no dropped
// findings, bounded repair rounds, one writer per branch, and a merge only of a head SHA with the clean cycles that
// its route needs. The sage hook calls mergeCheck before any `gh pr merge` in sage mode.
// Several chief sessions may share one store: each command that changes it holds the store's lock (withLock). They may
// run two versions of this tool, so a command refuses to change a logbook that a newer version wrote (ready).
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fchmodSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, rmSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, hostname, platform, tmpdir, uptime } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { boardView } from "./board-view.mjs";
import { projectName as shownName } from "./board-model.mjs";
import { logbookIdentity } from "./board-reader.mjs";
import { createBoard } from "./board.mjs";
import { PR } from "./pull-request.mjs";
import { parseReport } from "./report.mjs";
import { REVIEW_ROLES, parseReviewTarget, parseReviewReport } from "./review.mjs";
import { ROLES } from "./roles.mjs";
import { AGENT_CAPS, HIDDEN, NAME_MAX, PRIORITIES, TABLES, TASK_KINDS, countOf, nameProblem } from "./logbook-fields.mjs";
import { OBSERVATIONS_MAX_BYTES, OBSERVATION_DATA_MAX_BYTES, validateObservation, validateObservations } from "./observations.mjs";

export function createStateTool({ defaultRoot, models = ["inherit"], modelDefaults = {} }) {
if (typeof defaultRoot !== "function") throw new TypeError("defaultRoot must be a function");
const MODELS = [...models];

/** The least route for each size. The chief may add blocks, never remove these. */
const SIZES = {
  tiny: ["build"],
  small: ["build", "code-review", "qa"],
  large: ["design", "pe", "build", "code-review", "security-review", "ux-review", "qa"],
  investigate: ["investigate", "evidence-review"],
};
const BLOCKS = ["design", "arena", "pe", "build", "code-review", "security-review", "ux-review", "qa", "investigate", "evidence-review"];
const RISKS = ["auth", "data", "schema", "money", "secrets", "input"];
/** The verdict a block gives on a head SHA. checks-pass is needed once per SHA; the others once per cycle. */
const VERDICT = { build: "checks-pass", "code-review": "review-clean", "security-review": "security-clean", "ux-review": "ux-clean", qa: "qa-pass", "evidence-review": "evidence-clean" };
/** The verdicts of a review or QA that found a medium or high problem. A failed check needs no finding. */
const FOUND = ["findings", "qa-fail"];
const NOT_CLEAN = ["checks-fail", ...FOUND];
const CLEAN = Object.values(VERDICT).filter((k) => k !== "checks-pass");
const KINDS = [...Object.values(VERDICT), ...NOT_CLEAN];
const WRITERS = ["implementer", "designer"];
/** The most running lead runs in one logbook: the owner's limit of 3 leads per project (#62, section 6). The hook holds the same limit for the agents. */
const LEADS = 3;
/** The roles of a run: sage's child roles (roles.mjs), and the steps of an investigation, whose runs the board reads by the step's name. */
const RUN_ROLES = [...ROLES, "investigate", "evidence-review"];
/** The roles of the runs whose reports give a review or QA verdict: none may still run when a task merges (F-T289-18). */
const CHECKERS = ["code-reviewer", "security-reviewer", "ux-reviewer", "qa", "evidence-review"];
/** A task's states and the moves between them (docs/design/sage-mode.html, "A task's life"). Any state may go to abandoned. */
const NEXT = {
  framed: ["designing", "briefed"],
  designing: ["awaiting-you"],
  "awaiting-you": ["briefed", "designing"],
  briefed: ["building"],
  building: ["held", "reviewing"],
  held: ["building", "briefed"],
  reviewing: ["verifying"],
  repairing: ["reviewing"],
  replan: ["briefed"],
  verifying: ["verified", "concluded", "reviewing"], // verified for a route with build; concluded for one without; reviewing when the head moved past the clean cycles (F-T301-49)
  verified: ["merged", "pr-ready", "reviewing"],
  "pr-ready": ["merged", "reviewing"],
  merged: [],
  concluded: [],
  abandoned: [],
};
const STATES = Object.keys(NEXT);
const DEFAULTS = { max_agents: AGENT_CAPS.max_agents, "cycles.small": 1, "cycles.large": 2, "cycles.risk": 2, max_rounds: 3, arena: 3, arena_models: "inherit,inherit,inherit", cap_total: AGENT_CAPS.cap_total, ...modelDefaults };
/** The counts in the config, and what a 0 would do. Each count is a whole number of 1 or more. */
/** The owner's floors (gate G18): a large or risk-flagged task needs at least 2 clean cycles. Only a code change lowers them; every other count is 1 or more. */
const FLOOR = { "cycles.large": 2, "cycles.risk": 2 };
const floor = (key) => FLOOR[key] ?? 1;
/** The limits that keep a typo from blocking every merge or starting too many agents: 10 for cycles and rounds, 50 for agent counts. */
const LIMIT = { "cycles.small": 10, "cycles.large": 10, "cycles.risk": 10, max_rounds: 10 };
const limit = (key) => LIMIT[key] ?? 50;
const COUNTS = { max_agents: "no sage agent could start", "cycles.small": "a tiny or small task would merge with no review", "cycles.large": "a large task would merge with no review", "cycles.risk": "a task with a risk flag would merge with no review", max_rounds: "no repair round could start", arena: "an arena would have no candidates", cap_total: "no sage agent could start" };
/** One project's own agent cap, cap.<project>, with the project's name as projectName gives it. Without one, max_agents is the project's cap. */
const CAP = /^cap\.[a-z0-9][a-z0-9-]*$/;
/** Model choice by role, task size or risk flag; provider defaults supply the model names. */
const MODEL = /^model\.(pe|designer|implementer|code-reviewer|security-reviewer|ux-reviewer|qa|arena-judge)(\.(tiny|small|large|investigate|risk))?$/;
const KEYS = "max_agents, cycles.small, cycles.large, cycles.risk, max_rounds, arena and cap_total as key=number, cap.<project>=number for one project's cap, model.<role>.<size>=<model>, model.<role>.risk=<model> or model.<role>=<model> for an agent role's model";
/** The columns that a later version added: an older table without them reads with them empty, and its next write adds them. */
const ADDED = { runs: ["model"], tasks: ["hold", "extra", "priority", "kind", "waits"] };
const COMMANDS = ["init", "logbook", "standing", "pages", "task", "round", "run", "finding", "verdict", "gate", "log", "status", "merge-check", "config", "projects", "board", "observe"];
/** The options of each command, by its name or by its name and first word. Every command also takes --project. */
const OPTIONS = {
  "logbook repair": ["accept-loss"],
  "projects rebuild": ["accept-listing"],
  "task add": ["title", "size", "risk", "add", "why", "priority", "kind", "waits"],
  "run add": ["role", "branch", "candidate"],
  observe: ["kind", "source", "basis", "observed-at", "data-hex"],
  "run done": ["status", "tokens", "report"],
  "finding add": ["source", "severity", "summary", "key"],
  "finding triage": ["reason"],
  "finding move": ["to", "size"],
  verdict: ["sha", "kind", "cycle", "pr", "run"],
  "gate add": ["question", "options", "recommend", "default"],
  "gate answer": ["option", "other-hex"],
  log: ["why"],
  "merge-check": ["sha", "pr", "cycles", "head"],
  board: ["remember", "name-hex", "view"],
};
/** The canonical number of a PR in an older row: "040" is PR 40. */
const prNumber = (pr) => (/^\d+$/.test(pr ?? "") ? String(BigInt(pr)) : pr);
const STANDING = `# Standing orders

Every brief carries these lines word for word. Add a line when you notice that you repeat an instruction.

1. Work only in your own worktree and branch. Never merge, never force-push, never push to main.
2. Stop at a product question: report it with your recommendation. Do not guess.
3. Every claim in your report has its evidence: the command and its output, or a screenshot.
4. Reviewers and QA report only correctness, requirements and security problems, not style.
`;

class Refusal extends Error {}
const refuse = (message) => {
  throw new Refusal(message);
};

function sageRoot(env = process.env) {
  return env.SAGE_HOME ?? defaultRoot(env);
}

/**
 * git with neutral options: no fsmonitor, no hooks and no system config of the project's machine, only local, https or
 * ssh transports, and never a prompt. Every git call of the state tool goes through it, because the tool also runs
 * outside the sandbox, on a folder that an agent may have written.
 */
function git(args, env = process.env) {
  const neutral = { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_ALLOW_PROTOCOL: "file:https:ssh", GIT_TERMINAL_PROMPT: "0" };
  return execFileSync("git", ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", ...args], { encoding: "utf8", env: neutral, stdio: ["ignore", "pipe", "ignore"] });
}

/**
 * The main checkout of a project, also from inside one of its linked worktrees. git's answer counts only when it points
 * back to the folder: the main checkout holds its git folder, or the git folder is a linked worktree of that main
 * checkout and names this folder as its worktree (a relative name counts from the git folder, as git reads it). Else (a planted .git/commondir or .git file, for example) the folder
 * is a project of its own, so no folder can borrow another project's logbook.
 */
function projectRoot(path) {
  try {
    const [common, gitDir, top] = git(["-C", path, "rev-parse", "--path-format=absolute", "--git-common-dir", "--absolute-git-dir", "--show-toplevel"]).trim().split("\n");
    const [realCommon, realGit, realTop] = [common, gitDir, top].map((p) => realpathSync(p));
    const main = realGit === realCommon && dirname(realCommon) === realTop;
    const linked = dirname(realGit) === join(realCommon, "worktrees") && realpathSync(resolve(realGit, readFileSync(join(realGit, "gitdir"), "utf8").trim())) === join(realTop, ".git");
    return main || linked ? dirname(common) : resolve(path);
  } catch {
    return resolve(path);
  }
}

/** A gate's options, numbered from 1 as the board shows them: its cell split at "|", each without spaces around it. */
const optionsOf = (g) => String(g.options ?? "").split("|").map((o) => o.trim()).filter(Boolean);
/** An option as a person sees it: compatibility forms, case, runs of spaces and invisible characters do not count. */
/**
 * Text that the owner typed, given as the hex of its UTF-8 bytes (only 0-9 and a-f), so that a command line holds none
 * of the owner's text. Undefined for anything else: an odd length, another character, no bytes or invalid UTF-8.
 */
const unhex = (hex) => {
  try {
    return /^(?:[0-9a-f]{2})+$/.test(hex) ? new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(hex, "hex")) : undefined;
  } catch {} // invalid UTF-8
};
const looks = (s) => String(s).normalize("NFKC").replace(/[\p{Cc}\p{Cf}]/gu, "").replace(/\s+/g, " ").trim().toLowerCase();
/** Names the project's main checkout in its logbook (checkout.txt), so a session of another project can answer its gates. */
const checkout = (dir, project) => put(join(dir, "checkout.txt"), `${projectRoot(resolve(project))}\n`);

/** A name as a slug: lower case, each run of other characters than a-z and 0-9 as one "-", or "project" when nothing is left. */
const slug = (name) => String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "project";

/** The folder of the task copies (default ~/sage-worktrees; $SAGE_WORKTREES overrides it). It is outside the sage root, so agents may write in it. */
const worktreeRoot = (env = process.env) => env.SAGE_WORKTREES ?? join(homedir(), "sage-worktrees");
/**
 * The folder where agents save a task's pages (research, designs, findings): <worktree root>/<logbook key>/pages/<task>.
 * The logbook key (name and hash) keeps two projects with the same folder name apart.
 */
const pagesDir = (project, task, env) => join(worktreeRoot(env), basename(storeDir(project, env)), "pages", task);
/** The largest page that pages record reads: 16 MiB, the size limit of a published page. */
const PAGE_MAX = 16 * 1024 * 1024;

/**
 * A branch that a task or a writer run may name: letters, digits and . _ / -, as today's branches (sage/t94,
 * tool/t83-agent-state-writes). Not main, master or HEAD in any case (a Mac's file names ignore case), not under refs/,
 * heads/, remotes/ or origin/ (git reads those as other refs), not starting with - or a /, and none of the
 * forms that git refuses or reads otherwise: .., //, /., a final / or ., or .lock. @{, ~, ^, :, spaces and control
 * characters are outside the letters. The one pattern for every branch check in this tool: task set and run add.
 */
const BRANCH = /^(?![-./])(?!(?:refs|heads|remotes|origin)\/)(?!(?:main|master|HEAD)$)(?!.*(?:\.\.|\/\/|\/\.|\.lock(?:\/|$)|[/.]$))[A-Za-z0-9._/-]+$/i;
/** Does a branch belong to a task: a BRANCH of the form [<prefix>/]<task>[-<words>]? task set and the PR script check this one rule. */
const ofTask = (task, name) => BRANCH.test(name) && new RegExp(`^(?:[A-Za-z0-9_-]+/)?${task}(?:-[A-Za-z0-9._-]+)?$`, "i").test(name);
const branchOf = (name) => (BRANCH.test(name) ? name : refuse(`${JSON.stringify(name)} is not a task branch: use letters, digits and . _ / - (for example sage/t12 or tool/t12-short-name), not main, master or HEAD in any case, not under refs/, heads/, remotes/ or origin/, and not a name that starts with - or holds .., @{ or a space.`));

/** The project's name: its main checkout's folder name as a slug. The store's folder and the cap.<project> config key use it. */
function projectName(path) {
  return slug(basename(projectRoot(resolve(path))));
}

function storeDir(project, env = process.env) {
  const root = projectRoot(resolve(project));
  return join(sageRoot(env), `${projectName(root)}-${createHash("sha1").update(root).digest("hex").slice(0, 6)}`);
}

/**
 * A config value in its stored form, or undefined when it has no number. One rule reads every count: a finite number,
 * or a numeric string. A cycles count rounds up, and any other count rounds down. Below its floor a count reads as the
 * floor. Above its limit, a cycles count keeps its value (fewer would ease a merge) and any other count reads as the
 * limit. So a count never starts more agents or rounds, or asks fewer cycles, than written.
 */
function valid(key, value) {
  if (key === "arena_models") {
    const models = typeof value === "string" ? list(value) : [];
    return models.length && models.every((m) => MODELS.includes(m)) ? models.join(",") : undefined;
  }
  if (MODEL.test(key)) return MODELS.includes(value) ? value : undefined;
  if (!(Object.hasOwn(COUNTS, key) || CAP.test(key))) return undefined;
  const cycles = key.startsWith("cycles.");
  return countOf(value, { floor: floor(key), limit: cycles ? Infinity : limit(key), up: cycles });
}

/** A count typed on the command line, or undefined when it is not a whole number from its floor to its limit. */
const typed = (key, text) => (/^[1-9]\d*$/.test(text) && Number(text) >= floor(key) && Number(text) <= limit(key) ? Number(text) : undefined);

/** The refusal for a path that holds something other than a regular file: a folder, a FIFO or a device. */
const notRegular = (path) => new Refusal(`${path} is not a regular file. Ask the user to fix or remove it.`);

/**
 * The text of a regular file, also through a link, or undefined when nothing is there. Something else (a FIFO, a device
 * or a folder) refuses, and so does a file it cannot read, with its path. It never blocks: the open does not wait for a
 * FIFO's writer, and the check is on the open file. With link: false a link refuses too; with max, a file over max
 * bytes refuses, and it reads at most max + 1 bytes, also from a file that grows. encoding: null gives the bytes.
 */
function readRegular(path, { link = true, max = Infinity, encoding = "utf8" } = {}) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | (link ? 0 : constants.O_NOFOLLOW));
  } catch (e) {
    if (e.code === "ENOENT") return undefined;
    if (e.code === "ELOOP") throw notRegular(path);
    throw e;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw notRegular(path);
    if (max === Infinity) return readFileSync(fd, encoding);
    const tooBig = () => new Refusal(`${path} is over ${max} bytes.`);
    if (st.size > max) throw tooBig();
    const buf = Buffer.alloc(max + 1);
    let n = 0;
    for (let r; n < buf.length && (r = readSync(fd, buf, n, buf.length - n, null)) > 0; ) n += r;
    if (n > max) throw tooBig();
    return encoding ? buf.toString(encoding, 0, n) : buf.subarray(0, n);
  } catch (e) {
    e.path ??= path; // a file too long for a string, for one
    throw e;
  } finally {
    closeSync(fd);
  }
}

/** config.json as an object, or {} when it is missing, torn, not an object or not a regular file. It never throws or waits. */
function saved(env) {
  try {
    const value = JSON.parse(readRegular(join(sageRoot(env), "config.json")));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

/**
 * The settings for all projects. The hooks call this, so it never throws or waits: a missing, torn or bad value (a count
 * as "3x", for one), or a config.json that is not a regular file, gives the default. A count reads as valid() gives it:
 * never below its floor, and never more agents or rounds, or fewer cycles, than written. A cycles key that is there but
 * has no number (Infinity, [3], true, "abc") reads as "invalid", and the merge check refuses every merge. A file of
 * an older sage holds autopilot_cycles for cycles.large: it counts, or reads as invalid, when cycles.large is absent, never below the floor.
 */
function config(env = process.env) {
  let c = { ...DEFAULTS };
  try {
    const s = saved(env);
    if (!Object.hasOwn(s, "cycles.large") && Object.hasOwn(s, "autopilot_cycles")) s["cycles.large"] = s.autopilot_cycles; // a broken one is an invalid cycles.large
    const extra = Object.keys(s).filter((k) => (CAP.test(k) || MODEL.test(k)) && !Object.hasOwn(DEFAULTS, k)).map((k) => [k, valid(k, s[k])]).filter(([, v]) => v !== undefined);
    c = Object.fromEntries([...Object.entries(DEFAULTS).map(([k, d]) => [k, valid(k, s[k]) ?? (k.startsWith("cycles.") && Object.hasOwn(s, k) ? "invalid" : d)]), ...extra]); // the defaults, then the caps and models without one
  } catch {}
  return c;
}

/** The clean cycles that a task needs before its merge: cycles.small for every task, cycles.large for a large one, and cycles.risk for any task with a risk flag (the largest count wins). */
function cyclesFor(task, c) {
  return Math.max(...cycleKeys(task).map((k) => c[k]));
}

/** The cycles keys that apply to a task: cycles.small, and cycles.large or cycles.risk when it is large or has a risk flag. */
const cycleKeys = (task) => ["cycles.small", task.size === "large" && "cycles.large", task.risk && "cycles.risk"].filter(Boolean);

/**
 * The model to pass on a run's agent call, or "" for the agent's own model: an arena candidate's place in arena_models,
 * else model.<role>.risk for a risk flag, else model.<role>.<size>, else model.<role>. inherit at a level gives the next one.
 */
function modelFor(role, size, candidate, c, risk = "") {
  const arena = /^[1-9]\d*$/.test(candidate) ? list(c.arena_models)[(Number(candidate) - 1) % list(c.arena_models).length] : undefined;
  if (arena !== undefined) return arena === "inherit" ? "" : arena;
  return [risk && c[`model.${role}.risk`], c[`model.${role}.${size}`], c[`model.${role}`]].find((m) => m && m !== "inherit") ?? "";
}

/** The file that a write to file replaces: file, or the target of its link. Something there that is not a regular file refuses. */
function target(file) {
  let real = file;
  try {
    real = realpathSync(file);
  } catch {} // nothing there yet
  if (lstatSync(real, { throwIfNoEntry: false })?.isFile() === false) throw notRegular(file); // a rename onto it would fail and leave the temp file
  return real;
}

/** Writes a whole file or nothing: readers take no lock, so they must never see half a file. A link stays a link: its target gets the text. */
function put(file, text) {
  const real = target(file);
  writeFileSync(`${real}.${process.pid}`, text);
  renameSync(`${real}.${process.pid}`, real);
}

/**
 * Writes a whole file of the sage folder and never follows a link (sec15d), also one that replaces file after a check
 * (F-T42-2): the text goes to a new temp file (wx: never through a planted link), and a rename onto the path itself
 * replaces whatever is there, a link too. put() would rename onto the link's target.
 */
function swap(file, text) {
  const temp = `${file}.${randomUUID()}`;
  const was = lstatSync(file, { throwIfNoEntry: false });
  const fd = openSync(temp, "wx");
  try {
    try {
      if (was?.isFile()) fchmodSync(fd, was.mode & 0o7777); // config.json stays 600 when the owner made it so
      writeFileSync(fd, text);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, file);
  } catch (e) {
    rmSync(temp, { force: true }); // a failed write or rename leaves no temp file
    throw e;
  }
}

/** A cell as the tables hold it: on one line, without a hidden character. */
const cell = (v) => String(v ?? "").replace(/[\t\r\n]+/g, " ").replace(HIDDEN, "").trim();
/** Text with each hidden character, tab and line feed shown as \xNN or \u{N}, so that a printed line never drives the terminal or hides text. */
const visible = (s) => String(s).replace(new RegExp(`[\\t\\n]|${HIDDEN.source}`, "gu"), (c) => (c.codePointAt(0) < 0x100 ? `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}` : `\\u{${c.codePointAt(0).toString(16)}}`));

/** What to ask the user about a file that cannot be read: never to remove the root, which holds every logbook, nor a file that a permission keeps shut, whose rows are there. */
const fixIt = (at, why, root) => `Ask the user to ${["EACCES", "EPERM"].includes(why) ? "fix the permissions of " : at === root ? "fix " : "fix or remove "}${at}.`;

/**
 * The refusal for a table of a logbook that lost its rows: it is missing, or has no header line. It names both ways out,
 * and the repair names also the tables that the refused command already repairs (also), so one command repairs them all.
 */
const lost = (dir, table, what, also = []) =>
  new Refusal(`${join(dir, `${table}.tsv`)} ${what}, but every table of a logbook has at least its header line, so its rows are lost. Ask the user to restore it from a copy. If the user accepts the loss, run: sage logbook repair --accept-loss ${[...also, table].join(",")} --project <the project>. If no project uses ${dir}, ask the user to remove it.`);

/**
 * A table of a logbook as its header's columns and its data lines. It refuses, with the path, a table that is missing or
 * a link to nothing, one with no line (0 bytes, or only blank lines), one that is not a regular file, and one whose first
 * line does not name every column of this version (the header was lost or edited), so no data line is taken for it. A
 * header-only table is a table without rows: a cut that keeps only the header cannot be told from it. An editor's BOM
 * and CRLF line ends read as a plain file.
 */
function sheet(dir, table, also = [], max = Infinity) {
  const file = join(dir, `${table}.tsv`);
  let text;
  try {
    text = readRegular(file, { max });
  } catch (e) {
    if (e instanceof Refusal || !e.code) throw e;
    refuse(`${file} cannot be read (${e.code}). ${fixIt(file, e.code)}`);
  }
  if (text === undefined) throw lost(dir, table, "is missing or is a link to nothing", also);
  const { cols, lines } = sheetText(text);
  if (!cols.length) throw lost(dir, table, text ? "has only blank lines" : "is empty (0 bytes)", also);
  if (!TABLES[table].every((c) => cols.includes(c) || ADDED[table]?.includes(c))) refuse(`the header of ${file} is damaged: its first line must be the column names ${TABLES[table].join(", ")}, separated by tabs. Ask the user to fix or add that line.`);
  return { cols, lines };
}

function sheetText(text) {
  const [head, ...lines] = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);
  return { cols: head?.split("\t") ?? [], lines };
}

const rowsOf = ({ cols, lines }) =>
  lines.map((line) => {
    const v = line.split("\t");
    return Object.fromEntries(cols.map((c, i) => [c, v[i] ?? ""]));
  });
const read = (dir, table) => rowsOf(sheet(dir, table));

/**
 * The integrity check of a logbook: every table (but skip, the ones that a repair starts again) is there, is a regular
 * file that it can read, is not empty, and has its header line. It refuses the first that fails and names its file. The
 * merge check runs it on every logbook, and every write on its own, so no command hides a lost table or makes a new one.
 */
const check = (dir, skip = [], max = Infinity) => {
  const version = JSON.stringify([taskWrites.readVersion(dir), runWrites.readVersion(dir), reviewWrites.readVersion(dir), interruptedWrites.readVersion(dir), taskUpdates.readVersion(dir)]);
  const tables = Object.fromEntries(Object.keys(TABLES).filter((t) => !skip.includes(t)).map((t) => [t, sheet(dir, t, skip, max)]));
  if (JSON.stringify([taskWrites.readVersion(dir), runWrites.readVersion(dir), reviewWrites.readVersion(dir), interruptedWrites.readVersion(dir), taskUpdates.readVersion(dir)]) !== version) refuse("A task, run, or review receipt was created while this logbook was read. Retry the read.");
  return tables;
};

/**
 * Refuses, before any change, a logbook that a command could not change whole: one that fails the integrity check, or a
 * table that a newer version of this tool wrote. A write keeps only the columns that this version knows, so another
 * chief session's values would be lost in silence. Reading a newer logbook is safe. A folder without tasks.tsv is init's
 * new logbook (init writes tasks.tsv last), and it may have only tables without rows: rows without their tasks are a loss.
 */
/** Does any table of the logbook folder hold a row? A folder without tasks.tsv that has one lost its tasks. */
const hasRows = (dir, max = Infinity) => Object.keys(TABLES).some((t) => (readRegular(join(dir, `${t}.tsv`), { max }) ?? "").trim().split(/\r?\n/).length > 1);

function ready(dir, skip = []) {
  assertNoPendingWrite(dir);
  for (const file of ["status.md", "standing.md"]) target(join(dir, file));
  if (!skip.includes("tasks") && !lstatSync(join(dir, "tasks.tsv"), { throwIfNoEntry: false })) {
    if (skip.length || hasRows(dir)) throw lost(dir, "tasks", "is missing", skip);
    return;
  }
  for (const [table, { cols }] of Object.entries(check(dir, skip))) {
    const extra = cols.filter((c) => c && !TABLES[table].includes(c));
    if (extra.length) refuse(`${join(dir, `${table}.tsv`)} has columns that this version of sage does not know (${extra.join(", ")}): a newer sage wrote this logbook, and a write of this version would lose them. Update the sage plugin and restart this session. Nothing changed; status, logbook, standing and merge-check still work.`);
  }
}

const taskVersion = task => createHash("sha256").update(JSON.stringify(task)).digest("hex");

function taskSnapshot(dir, id) {
  const matches = read(dir, "tasks").filter(row => row.id === id);
  if (matches.length !== 1) refuse("The task is missing or ambiguous.");
  return { task: matches[0], version: taskVersion(matches[0]) };
}

/** Read a current task and a task-metadata token; neither grants workflow permission. */
function readTaskSnapshot(input, env = process.env) {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== 2
    || !Object.hasOwn(input, "project") || !Object.hasOwn(input, "task")
    || typeof input.project !== "string" || !input.project || typeof input.task !== "string" || !/^T[1-9]\d*$/.test(input.task)) refuse("Invalid task read");
  const dir = storeDir(input.project, env);
  if (realpathSync(dir) !== resolve(dir)) refuse("Invalid logbook location");
  return withLock(dir, () => { ready(dir); return taskSnapshot(dir, input.task); });
}

const updateKeys = (value, keys) => value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const updateDeny = () => { throw new TaskUpdateError("invalid-request"); };
function updateReference(input) {
  if (!updateKeys(input, ["owner", "request", "task", "version", "changes"])
    || typeof input.owner !== "string" || !input.owner || input.owner.length > 1024 || /\p{Cc}/u.test(input.owner)
    || typeof input.request !== "string" || !new RegExp(`^${UUID}$`).test(input.request)
    || typeof input.task !== "string" || !/^T[1-9]\d*$/.test(input.task)
    || typeof input.version !== "string" || !/^[0-9a-f]{64}$/.test(input.version)
    || !input.changes || typeof input.changes !== "object" || Array.isArray(input.changes)) updateDeny();
  const keys = ["title", "branch", "pr", "state"].filter(key => Object.hasOwn(input.changes, key));
  if (!keys.length || !updateKeys(input.changes, keys) || keys.some(key => typeof input.changes[key] !== "string"
    || input.changes[key].length > 4096 || cell(input.changes[key]) !== input.changes[key])
    || (Object.hasOwn(input.changes, "state") && (!STATES.includes(input.changes.state) || ["merged", "repairing"].includes(input.changes.state)))) updateDeny();
  return { owner: input.owner, request: input.request, task: input.task, version: input.version,
    changes: Object.fromEntries(keys.map(key => [key, input.changes[key]])) };
}
function updateRows(table, text) {
  const sheet = sheetText(text);
  if (!TABLES[table].every(key => sheet.cols.includes(key) || ADDED[table]?.includes(key))
    || sheet.cols.some(key => !TABLES[table].includes(key)) || new Set(sheet.cols).size !== sheet.cols.length) updateDeny();
  return rowsOf(sheet);
}
function updateFacts(rows, readiness) {
  return { findings: rows.findings, ledger: rows.ledger, gates: rows.gates, readiness };
}
function checkUpdateFacts(facts) {
  if (!updateKeys(facts, ["findings", "ledger", "gates", "readiness"])) updateDeny();
  for (const table of ["findings", "ledger", "gates"]) {
    if (!Array.isArray(facts[table]) || facts[table].some(row => !updateKeys(row, TABLES[table])
      || Object.values(row).some(value => typeof value !== "string" || cell(value) !== value))) updateDeny();
  }
  const r = facts.readiness;
  if (r !== null && (!updateKeys(r, ["head", "branch", "cycles", "config"]) || typeof r.head !== "string" || notFull(r.head)
    || typeof r.branch !== "string" || !r.branch
    || !Number.isSafeInteger(r.cycles) || r.cycles < 1
    || !updateKeys(r.config, ["cycles.small", "cycles.large", "cycles.risk"])
    || Object.entries(r.config).some(([key, value]) => !Number.isSafeInteger(value) || valid(key, value) !== value))) updateDeny();
}
function planNativeTaskUpdate(before, reference, at, facts) {
  checkUpdateFacts(facts);
  const old = before.tasks.filter(row => row.id === reference.task);
  if (old.length !== 1 || taskVersion(old[0]) !== reference.version) updateDeny();
  const changes = Object.entries(reference.changes).map(([key, value]) => `${key}=${value}`);
  const planned = planTaskChanges(before, reference.task, changes, at, facts);
  // Validate the caller's original row version, then publish complete current columns.
  for (const table of ["tasks", "runs", "decisions"]) planned[table] = planned[table].map(row =>
    Object.fromEntries(TABLES[table].map(key => [key, row[key] ?? ""])));
  planned.task = planned.tasks.find(row => row.id === reference.task);
  const task = planned.task, needsReady = ["verified", "pr-ready"].includes(task.state);
  if (needsReady) {
    if (!facts.readiness || !task.branch) throw new TaskUpdateError("readiness-branch");
    if (task.state === "pr-ready" && !task.pr) throw new TaskUpdateError("readiness-pr");
    const blocking = facts.findings.filter(row => row.task === task.id && row.status === "open");
    if (blocking.length) throw new TaskUpdateError("readiness-findings", blocking.map(row => row.key));
    const gate = facts.gates.find(row => row.task === task.id && !row.answer);
    if (gate) throw new TaskUpdateError("readiness-gates", [gate.id]);
    const live = planned.runs.filter(row => row.task === task.id && row.status === "running" && CHECKERS.includes(row.role));
    if (live.length) throw new TaskUpdateError("readiness-runs", live.map(row => row.id));
    const verdict = judge("", task, facts.findings, task.id, facts.ledger.filter(row => row.task === task.id
      && row.sha === facts.readiness.head), facts.readiness.cycles, false, {});
    if (!verdict.ok) throw new TaskUpdateError("readiness");
    if (facts.readiness.branch !== branchOf(task.branch)
      || facts.readiness.cycles !== cyclesFor(task, facts.readiness.config)) updateDeny();
  } else if (facts.readiness !== null) updateDeny();
  const disruptive = (Object.hasOwn(reference.changes, "branch") && task.branch !== old[0].branch)
    || (Object.hasOwn(reference.changes, "state") && (task.state !== old[0].state)
      && (["held", "replan"].includes(old[0].state) || ["briefed", "verified", "pr-ready", "concluded", "abandoned"].includes(task.state)));
  return { ...planned, disruptive };
}
function validateTaskUpdateData(intent) {
  const reference = updateReference(intent.reference), proposal = intent.proposal;
  if (JSON.stringify(reference) !== JSON.stringify(intent.reference)
    || !updateKeys(proposal, ["at", "facts", "task", "version", "disruptive"])
    || typeof proposal.at !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(proposal.at)
    || !Number.isFinite(Date.parse(proposal.at)) || new Date(proposal.at).toISOString().replace(".000Z", "Z") !== proposal.at) updateDeny();
  const before = Object.fromEntries(["tasks", "runs", "decisions"].map(table => [table, updateRows(table, intent.tables[table].before)]));
  const planned = planNativeTaskUpdate(before, reference, proposal.at, proposal.facts);
  if (JSON.stringify(proposal.task) !== JSON.stringify(planned.task) || proposal.version !== taskVersion(planned.task)
    || proposal.disruptive !== planned.disruptive) updateDeny();
  for (const table of ["tasks", "runs", "decisions"]) if (intent.tables[table].after !== tableText(table, planned[table])) updateDeny();
}
function validateTaskUpdate(intent) {
  try { validateTaskUpdateData(intent); } catch { throw new TaskUpdateError("invalid-state"); }
}
const taskUpdates = coordinatedWrites({ schema: 6, tables: ["tasks", "runs", "decisions"], folder: "task-updates", validate: validateTaskUpdate });

/** Native task updates require a trusted durable admission decision, never a model-supplied proof. */
function updateRequestedTask(input, env, coordination) {
  if (!input || typeof input.project !== "string" || !input.project || !coordination
    || ["decide", "acknowledge", "release", "history"].some(key => typeof coordination[key] !== "function")) updateDeny();
  const { project, ...request } = input, reference = updateReference(request), dir = storeDir(project, env);
  if (realpathSync(dir) !== resolve(dir)) updateDeny();
  let phase = "state";
  try { return withLock(dir, () => {
    const prior = taskUpdates.readReceipt(dir, reference);
    const pending = !prior && taskUpdates.pending(dir);
    if (pending && pending.reference.owner !== reference.owner) throw new TaskUpdateError("old-owner");
    if (pending && JSON.stringify(pending.reference) !== JSON.stringify(reference)) throw new TaskUpdateError("pending-request");
    if (!prior && !pending) {
      ready(dir);
      const before = Object.fromEntries(["tasks", "runs", "decisions"].map(table => [table, read(dir, table)]));
      const current = before.tasks.filter(row => row.id === reference.task);
      if (current.length !== 1) throw new TaskUpdateError("invalid-state");
      if (taskVersion(current[0]) !== reference.version) throw new TaskUpdateError("stale-version");
      const facts = updateFacts(Object.fromEntries(["findings", "ledger", "gates"].map(table => [table, read(dir, table)])), null);
      const needsReady = ["verified", "pr-ready"].includes(reference.changes.state ?? current[0].state);
      phase = needsReady ? "readiness" : "plan";
      const openFindings = facts.findings.filter(row => row.task === reference.task && row.status === "open");
      if (needsReady && openFindings.length) throw new TaskUpdateError("readiness-findings", openFindings.map(row => row.key));
      const at = now();
      const preliminary = planTaskChanges(before, reference.task, Object.entries(reference.changes).map(([key, value]) => `${key}=${value}`), at, facts);
      if (["verified", "pr-ready"].includes(preliminary.task.state)) {
        const cfg = config(env);
        if (Object.values(cfg).includes("invalid")) throw new TaskUpdateError("readiness-config");
        const branch = branchOf(preliminary.task.branch);
        let head;
        try { head = reviewHead(project, branch, env); } catch { throw new TaskUpdateError("readiness-branch"); }
        facts.readiness = { head, branch, cycles: cyclesFor(preliminary.task, cfg),
          config: Object.fromEntries(["cycles.small", "cycles.large", "cycles.risk"].map(key => [key, cfg[key]])) };
      }
      const planned = planNativeTaskUpdate(before, reference, at, facts);
      phase = "publish";
      taskUpdates.prepare(dir, reference, { at, facts, task: planned.task, version: taskVersion(planned.task), disruptive: planned.disruptive },
        Object.fromEntries(["tasks", "runs", "decisions"].map(table => [table, tableText(table, planned[table])])));
    }
    phase = "publish";
    const receipt = taskUpdates.recover(dir, reference, coordination);
    return receipt.outcome.accepted ? { decision: prior ? "task-update-history" : "task-updated", task: receipt.intent.proposal.task, version: receipt.intent.proposal.version }
      : { decision: "task-update-rejected", reason: receipt.outcome.reason };
  }); } catch (error) {
    if (error instanceof TaskUpdateError) throw error;
    throw new TaskUpdateError(error instanceof RecordedWriteError || phase === "state" ? "invalid-state"
      : phase === "publish" ? "uncertain-outcome" : phase === "readiness" ? "readiness" : "invalid-change");
  }
}

/** Transaction integrity is independent of the provider's Sage on/off policy. */
function assertTaskUpdateOpen(input, env = process.env) {
  const dir = storeDir(input.project, env);
  // Every supported writer observes the common marker. No mixed snapshot grants authority.
  assertNoPendingWrite(dir);
  return true;
}

const taskWrites = recordedWrites({ schema: 2, tables: ["tasks", "decisions"], folder: "task-requests",
  name: /^[0-9a-f]{64}\.json$/, receiptName: reference => createHash("sha256").update(JSON.stringify([reference.owner, reference.request])).digest("hex") + ".json",
  validate: validateTaskWrite });

/** Validate saved task publication as one pure update before any recovery write. */
function validateTaskWrite({ reference, result }, tables) {
  const deny = () => refuse("The saved task update is damaged. No task table changed.");
  if (!result || typeof result.id !== "string" || !/^T[1-9]\d*$/.test(result.id)
    || JSON.stringify(result) !== JSON.stringify(taskFrame(result.id, reference.title, reference.size, reference.risk, reference.add))) deny();
  if (!tables) return;
  const rows = (table, text) => {
    const { cols, lines } = sheetText(text);
    if (!TABLES[table].every(c => cols.includes(c) || ADDED[table]?.includes(c))
      || cols.some(c => !TABLES[table].includes(c)) || new Set(cols).size !== cols.length) deny();
    return rowsOf({ cols, lines });
  };
  const tasks = rows("tasks", tables.tasks.before), decisions = rows("decisions", tables.decisions.before);
  if (tasks.some(task => task.id === result.id)
    || tables.tasks.after !== tableText("tasks", [...tasks, result])) deny();
  if (reference.add.length) {
    const after = rows("decisions", tables.decisions.after), at = after.at(-1)?.at;
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(at ?? "")
      || !Number.isFinite(Date.parse(at)) || new Date(at).toISOString().replace(".000Z", "Z") !== at) deny();
    decisions.push({ at, task: result.id, decision: `added ${reference.add.join(",")}`, why: reference.why });
  }
  if (tables.decisions.after !== tableText("decisions", decisions)) deny();
}

/** Create one task for a durable caller request. The provider authenticates the opaque owner scope. */
function createRequestedTask(input, env = process.env) {
  const fields = ["project", "owner", "request", "title", "size", "risk", "add", "why"];
  const deny = () => refuse("Task creation needs a complete, unchanged request and a valid route.");
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== fields.length
    || fields.some(key => !Object.hasOwn(input, key)) || typeof input.project !== "string" || !input.project
    || typeof input.owner !== "string" || !input.owner || input.owner.length > 1024 || /\p{Cc}/u.test(input.owner)
    || typeof input.request !== "string" || !new RegExp(`^${UUID}$`).test(input.request)
    || !["title", "why"].every(key => typeof input[key] === "string" && input[key].length <= 4096 && cell(input[key]) === input[key])
    || !input.title.trim() || typeof input.size !== "string" || !Object.hasOwn(SIZES, input.size)
    || !Array.isArray(input.risk) || input.risk.length > RISKS.length || input.risk.some(value => !RISKS.includes(value))
    || !Array.isArray(input.add) || input.add.length > BLOCKS.length || input.add.some(value => !BLOCKS.includes(value))
    || new Set(input.risk).size !== input.risk.length || new Set(input.add).size !== input.add.length
    || (input.add.length && !input.why.trim()) || (!input.add.length && input.why)
    || (input.size === "investigate" && input.add.includes("build"))) deny();
  const { project, ...request } = input;
  // Property order supplied by a transport must not change retry identity.
  const reference = Object.fromEntries(fields.filter(key => key !== "project").map(key => [key, request[key]]));
  const dir = storeDir(project, env);
  if (realpathSync(dir) !== resolve(dir)) deny();
  const checked = receipt => {
    const result = receipt.result;
    const matches = read(dir, "tasks").filter(row => row.id === result.id);
    if (matches.length !== 1) deny();
    return result;
  };
  return withLock(dir, () => {
    const recovered = taskWrites.recover(dir, reference);
    if (recovered) { const task = checked(recovered); status(dir, true); return { decision: "task-created", task }; }
    const prior = taskWrites.readReceipt(dir, reference);
    if (prior) return { decision: "already-created", task: checked(prior) };
    ready(dir);
    const task = taskFrame(nextId(dir, "T"), input.title, input.size, input.risk, input.add);
    const decisions = read(dir, "decisions");
    if (input.add.length) decisions.push({ at: now(), task: task.id, decision: `added ${input.add.join(",")}`, why: input.why });
    taskWrites.commit(dir, { reference, result: task }, { tasks: tableText("tasks", [...read(dir, "tasks"), task]), decisions: tableText("decisions", decisions) });
    status(dir, true);
    return { decision: "task-created", task };
  });
}

const runWrites = recordedWrites({ schema: 3, tables: ["runs"], folder: "run-requests",
  name: /^[0-9a-f]{64}\.json$/, receiptName: reference => createHash("sha256").update(JSON.stringify([reference.owner, reference.request])).digest("hex") + ".json", validate: validateRunWrite });

/** Record one run request using the same writer, branch, round and model rules as the CLI. */
function createRequestedRun(input, env = process.env) {
  const fields = ["project", "owner", "request", "task", "role", "branch", "candidate"];
  const deny = () => refuse("Run creation needs a complete, unchanged request and an existing task.");
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== fields.length
    || fields.some(key => !Object.hasOwn(input, key) || typeof input[key] !== "string") || !input.project
    || !input.owner || input.owner.length > 1024 || /\p{Cc}/u.test(input.owner)
    || !new RegExp(`^${UUID}$`).test(input.request) || !/^T[1-9]\d*$/.test(input.task)
    || !/^[a-z][a-z0-9-]{0,63}$/.test(input.role)
    || !["branch", "candidate"].every(key => input[key].length <= 4096 && cell(input[key]) === input[key])) deny();
  if (input.branch) branchOf(input.branch);
  const { project, ...request } = input;
  const reference = Object.fromEntries(fields.filter(key => key !== "project").map(key => [key, request[key]]));
  const dir = storeDir(project, env);
  if (realpathSync(dir) !== resolve(dir)) deny();
  const checked = receipt => {
    const run = receipt.result;
    const matches = read(dir, "runs").filter(row => row.id === run.id);
    if (matches.length !== 1 || matches[0].task !== input.task || matches[0].role !== input.role) deny();
    return run;
  };
  return withLock(dir, () => {
    const recovered = runWrites.recover(dir, reference);
    if (recovered) { const run = checked(recovered); status(dir, true); return { decision: "run-created", run }; }
    const prior = runWrites.readReceipt(dir, reference);
    if (prior) return { decision: "already-created", run: checked(prior) };
    ready(dir);
    const matches = read(dir, "tasks").filter(row => row.id === input.task);
    if (matches.length !== 1 || !/^(0|[1-9]\d*)$/.test(matches[0].round) || !Number.isSafeInteger(Number(matches[0].round))) deny();
    notHeld(matches[0], "run add");
    const run = runFrame(dir, matches[0], input.role, input.branch, input.candidate, env);
    runWrites.commit(dir, { reference, result: run }, { runs: tableText("runs", [...read(dir, "runs"), run]) });
    status(dir, true);
    return { decision: "run-created", run };
  });
}

/** A recorded running run is an assignment record, not proof that a native agent started. */
function runFrame(dir, task, role, branch, candidate, env) {
  if (!RUN_ROLES.includes(role)) refuse(`${JSON.stringify(role)} is not a role of a run. Roles: ${RUN_ROLES.join(", ")}.`);
  if (WAIT_ROLES.includes(role)) waitsMet(task, read(dir, "tasks"), `${role} run`);
  if (role === "lead") {
    // A lead carries one task's pull request: one running lead per task, and at most LEADS per project.
    if (["merged", "abandoned", "concluded"].includes(task.state)) refuse(`${task.id} is ${task.state}, so it takes no lead run: the task has ended.`);
    if (!builds(task)) refuse(`${task.id} is an investigation: it has no build and no pull request, so it takes no lead run. The chief runs its steps.`);
    const leads = read(dir, "runs").filter((r) => r.role === "lead" && r.status === "running");
    const same = leads.find((r) => r.task === task.id);
    if (same) refuse(`${same.id} is the running lead run of ${task.id}, and a task has one running lead. Finish ${same.id} first (sage run done ${same.id} --status done, blocked, question or failed).`);
    if (leads.length >= LEADS) refuse(`the project has ${leads.length} running lead runs, the most it holds: ${leads.map((r) => `${r.id} on ${r.task}`).join(", ")}. Finish one of them first (sage run done <R> --status done, blocked, question or failed).`);
  }
  if (WRITERS.includes(role)) {
    if (!branch) refuse(`a ${role} run needs --branch`);
    const other = read(dir, "runs").find(row => row.branch === branch && row.status === "running" && WRITERS.includes(row.role));
    if (other) refuse(`${other.id} (${other.role}) still writes ${branch}, and a branch has one writer. Finish that run first (sage run done ${other.id} --status done, blocked, question or failed), or give this run another branch.`);
  }
  return { id: nextId(dir, "R"), task: task.id, role, round: task.round, candidate, branch,
    status: "running", started: now(), model: modelFor(role, task.size, candidate, config(env), task.risk) };
}

/** Saved run facts survive later task/config changes; validate the record rather than recompute them. */
function validateRunWrite({ reference, result: run }, tables) {
  const deny = () => refuse("The saved run update is damaged. No run table changed.");
  if (!run || typeof run.id !== "string" || !/^R[1-9]\d*$/.test(run.id) || typeof run.round !== "string" || !/^(0|[1-9]\d*)$/.test(run.round)
    || !Number.isSafeInteger(Number(run.round)) || !RUN_ROLES.includes(run.role) || typeof run.model !== "string" || cell(run.model) !== run.model
    || typeof run.started !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(run.started)
    || !Number.isFinite(Date.parse(run.started)) || new Date(run.started).toISOString().replace(".000Z", "Z") !== run.started
    || JSON.stringify(run) !== JSON.stringify({ id: run.id, task: reference.task, role: reference.role, round: run.round,
      candidate: reference.candidate, branch: reference.branch, status: "running", started: run.started, model: run.model })) deny();
  if (!tables) return;
  const { cols, lines } = sheetText(tables.runs.before);
  if (!TABLES.runs.every(c => cols.includes(c) || ADDED.runs?.includes(c))
    || cols.some(c => !TABLES.runs.includes(c)) || new Set(cols).size !== cols.length) deny();
  const runs = rowsOf({ cols, lines });
  if (runs.some(row => row.id === run.id) || tables.runs.after !== tableText("runs", [...runs, run])) deny();
}

const reviewWrites = recordedWrites({ schema: 4, tables: ["tasks", "findings", "ledger", "decisions"], folder: "reviews",
  name: /^[0-9a-f-]{36}-[0-9a-f]{64}\.json$/, receiptName: reference => `${reference.assignment}-${reference.reportHash}.json`, validate: validateReviewWrite });

function reviewResult(reference, claims, at) {
  return { task: reference.task, run: reference.run, sha: reference.review.sha, cycle: reference.review.cycle,
    kind: claims.kind, findings: claims.findings.map((_, index) => `F-${reference.task}-${reference.run}-${index + 1}`), at };
}

/** The same pure delta defines fresh publication and validates a saved recovery intent. */
function reviewDelta({ reference, result }, claims, rows) {
  const deny = () => refuse("The saved review update is damaged. No review tables changed.");
  const { task: id, run, role, review } = reference;
  const { tasks, findings, ledger, decisions } = structuredClone(rows);
  const matches = tasks.filter(row => row.id === id);
  if (matches.length !== 1) deny();
  const task = matches[0];
  if (!builds(task) || task.round !== String(review.round) || task.branch !== review.branch || task.state === "held"
    || ledger.some(row => row.run === run && !["checks-pass", "checks-fail"].includes(row.kind))
    || findings.some(row => result.findings.includes(row.key))) deny();
  claims.findings.forEach((finding, index) => findings.push({ task: id, key: result.findings[index], round: task.round,
    source: role, severity: finding.severity, summary: cell(finding.summary), triage: "", reason: "", status: "open" }));
  ledger.push({ task: id, pr: task.pr, sha: review.sha, kind: claims.kind, cycle: String(review.cycle), run, at: result.at });
  if (["verified", "pr-ready"].includes(task.state) && NOT_CLEAN.includes(claims.kind)) {
    const before = task.state;
    task.state = "reviewing";
    decisions.push({ at: result.at, task: id, decision: `${before} → reviewing`, why: `${claims.kind} verdict on ${review.sha}` });
  }
  return Object.fromEntries(Object.entries({ tasks, findings, ledger, decisions }).map(([table, values]) => [table, tableText(table, values)]));
}

/** Validate authenticated report bytes and every saved after-image before publication. No current Git reads. */
function validateReviewWrite({ reference, result }, tables) {
  const deny = () => refuse("The saved review update is damaged. No review tables changed.");
  const keys = ["task", "run", "role", "assignment", "reportHash", "review", "text"];
  if (!reference || typeof reference !== "object" || Array.isArray(reference) || Object.keys(reference).length !== keys.length
    || keys.some(key => !Object.hasOwn(reference, key)) || typeof reference.task !== "string" || !/^T[1-9]\d*$/.test(reference.task)
    || typeof reference.run !== "string" || !/^R[1-9]\d*$/.test(reference.run)
    || typeof reference.assignment !== "string" || !new RegExp(`^${UUID}$`).test(reference.assignment)
    || typeof reference.reportHash !== "string" || !/^[0-9a-f]{64}$/.test(reference.reportHash)) deny();
  const review = parseReviewTarget(reference.review);
  const claims = parseReviewReport(parseReport(reference.text), reference.role, review);
  if (createHash("sha256").update(reference.text).digest("hex") !== reference.reportHash
    || !result || typeof result.at !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(result.at)
    || !Number.isFinite(Date.parse(result.at)) || new Date(result.at).toISOString().replace(".000Z", "Z") !== result.at
    || JSON.stringify(result) !== JSON.stringify(reviewResult(reference, claims, result.at))) deny();
  if (!tables) return;
  const rows = Object.fromEntries(Object.keys(tables).map(table => {
    const { cols, lines } = sheetText(tables[table].before);
    if (!TABLES[table].every(c => cols.includes(c) || ADDED[table]?.includes(c))
      || cols.some(c => !TABLES[table].includes(c)) || new Set(cols).size !== cols.length) deny();
    return [table, rowsOf({ cols, lines })];
  }));
  const expected = reviewDelta({ reference, result }, claims, rows);
  if (Object.keys(expected).some(table => tables[table].after !== expected[table])) deny();
}

function acceptReportedReview(input, env = process.env) {
  const fields = ["project", "task", "run", "role", "assignment", "reportHash", "text", "review"];
  const deny = () => refuse("The review does not match its completed run, report, or current commit.");
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== fields.length
    || fields.some(key => !Object.hasOwn(input, key)) || typeof input.project !== "string" || !input.project
    || typeof input.task !== "string" || !/^T[1-9]\d*$/.test(input.task)
    || typeof input.run !== "string" || !/^R[1-9]\d*$/.test(input.run)
    || typeof input.assignment !== "string" || !new RegExp(`^${UUID}$`).test(input.assignment)
    || typeof input.reportHash !== "string" || !/^[0-9a-f]{64}$/.test(input.reportHash)) deny();
  const review = parseReviewTarget(input.review);
  const report = parseReport(input.text);
  const claims = parseReviewReport(report, input.role, review);
  if (createHash("sha256").update(input.text).digest("hex") !== input.reportHash) deny();
  const reference = { task: input.task, run: input.run, role: input.role, assignment: input.assignment, reportHash: input.reportHash, review, text: input.text };
  const dir = storeDir(input.project, env);
  if (realpathSync(dir) !== resolve(dir)) deny();
  return withLock(dir, () => {
    const recovered = reviewWrites.recover(dir, reference);
    if (recovered) { const result = recovered.result; status(dir, true); return { decision: "review-accepted", ...result }; }
    const prior = reviewWrites.readReceipt(dir, reference);
    if (prior) return { decision: "already-accepted", ...prior.result };
    ready(dir);
    const tasks = read(dir, "tasks"), runs = read(dir, "runs");
    const matches = tasks.filter(row => row.id === input.task), assigned = runs.filter(row => row.id === input.run);
    if (matches.length !== 1 || assigned.length !== 1) deny();
    const task = matches[0], run = assigned[0];
    notHeld(task, "review acceptance");
    const path = `reports/${input.run}-${input.assignment}-${input.reportHash}.md`;
    if (run.task !== task.id || run.role !== input.role || run.round !== String(review.round) || task.round !== run.round
      || run.status !== "done" || !run.ended || run.report !== path || task.branch !== review.branch
      || (run.branch && run.branch !== review.branch) || realpathSync(join(dir, "reports")) !== join(dir, "reports")
      || readRegular(join(dir, path), { link: false, max: 32 * 1024 }) !== input.text
      || reviewHead(input.project, branchOf(task.branch), env) !== review.sha) deny();
    const findings = read(dir, "findings"), ledger = read(dir, "ledger"), decisions = read(dir, "decisions");
    const receipt = { reference, result: reviewResult(reference, claims, now()) };
    const after = reviewDelta(receipt, claims, { tasks, findings, ledger, decisions });
    reviewWrites.commit(dir, receipt, after);
    status(dir, true);
    return { decision: "review-accepted", ...receipt.result };
  });
}

const interruptedWrites = recordedWrites({ schema: 5, tables: ["runs"], folder: "interrupted-runs",
  name: /^[0-9a-f-]{36}\.json$/, receiptName: reference => `${reference.binding.assignment}.json`, validate: validateInterruptedWrite });
const interruptedKeys = ["binding", "task", "run", "role", "status", "evidenceHash", "runTarget"];
function interruptedReference(value) {
  const deny = () => refuse("The interrupted run reference is damaged.");
  const exact = (object, keys) => object && typeof object === "object" && !Array.isArray(object)
    && Object.keys(object).length === keys.length && keys.every(key => Object.hasOwn(object, key));
  const bindingKeys = ["project", "session", "epoch", "assignment", "issuer", "call", "child", "turn"];
  if (!exact(value, interruptedKeys) || !exact(value.binding, bindingKeys)
    || bindingKeys.some(key => typeof value.binding[key] !== "string" || !/^[A-Za-z0-9_.:-]{1,256}$/.test(value.binding[key]))
    || !new RegExp(`^${UUID}$`).test(value.binding.assignment) || !new RegExp(`^${UUID}$`).test(value.binding.epoch)
    || typeof value.task !== "string" || !/^T[1-9]\d*$/.test(value.task)
    || typeof value.run !== "string" || !/^R[1-9]\d*$/.test(value.run) || !RUN_ROLES.includes(value.role)
    || !["blocked", "question", "failed"].includes(value.status)
    || typeof value.evidenceHash !== "string" || !/^[0-9a-f]{64}$/.test(value.evidenceHash)) deny();
  const runTarget = parseRunTarget(value.runTarget);
  if (runTarget.task !== value.task || runTarget.run !== value.run || runTarget.role !== value.role) deny();
  return { binding: Object.fromEntries(bindingKeys.map(key => [key, value.binding[key]])),
    task: value.task, run: value.run, role: value.role, status: value.status, evidenceHash: value.evidenceHash, runTarget };
}
function interruptedResult(reference, ended) {
  return { task: reference.task, run: reference.run, assignment: reference.binding.assignment, evidenceHash: reference.evidenceHash,
    status: reference.status, report: "", ended };
}
function validateInterruptedWrite({ reference, result }, tables) {
  const deny = () => refuse("The saved interrupted run update is damaged. No run table changed.");
  const parsed = interruptedReference(reference);
  if (JSON.stringify(reference) !== JSON.stringify(parsed) || !result || typeof result.ended !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(result.ended)
    || !Number.isFinite(Date.parse(result.ended)) || new Date(result.ended).toISOString().replace(".000Z", "Z") !== result.ended
    || JSON.stringify(result) !== JSON.stringify(interruptedResult(reference, result.ended))) deny();
  if (!tables) return;
  const { cols, lines } = sheetText(tables.runs.before);
  if (!TABLES.runs.every(c => cols.includes(c) || ADDED.runs?.includes(c))
    || cols.some(c => !TABLES.runs.includes(c)) || new Set(cols).size !== cols.length) deny();
  const rows = rowsOf({ cols, lines }), matches = rows.filter(row => row.id === reference.run);
  if (matches.length !== 1 || matches[0].task !== reference.task || matches[0].role !== reference.role
    || matches[0].round !== String(reference.runTarget.round) || matches[0].branch !== reference.runTarget.runBranch
    || matches[0].candidate !== reference.runTarget.candidate
    || matches[0].status !== "running" || matches[0].ended || matches[0].report) deny();
  Object.assign(matches[0], { status: reference.status, ended: result.ended, report: "" });
  if (tables.runs.after !== tableText("runs", rows)) deny();
}

/** Trusted provider callbacks acquire and acknowledge admission ownership under the logbook lock.
 * They must be synchronous and must never acquire another logbook lock. */
function finishInterruptedRun(input, env = process.env, fence) {
  const deny = () => refuse("The interrupted run does not match its immutable finish evidence.");
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).length !== interruptedKeys.length + 1 || typeof input.project !== "string" || !input.project
    || !Object.hasOwn(input, "project") || interruptedKeys.some(key => !Object.hasOwn(input, key))
    || typeof fence?.begin !== "function" || typeof fence?.end !== "function") deny();
  const reference = interruptedReference(Object.fromEntries(interruptedKeys.map(key => [key, input[key]])));
  const dir = storeDir(input.project, env);
  if (realpathSync(dir) !== resolve(dir)) deny();
  return withLock(dir, () => {
    const subject = () => {
      const tasks = read(dir, "tasks").filter(row => row.id === reference.task);
      const rows = read(dir, "runs").filter(row => row.id === reference.run);
      if (tasks.length !== 1 || rows.length !== 1 || rows[0].task !== reference.task || rows[0].role !== reference.role
        || rows[0].round !== String(reference.runTarget.round) || rows[0].branch !== reference.runTarget.runBranch
        || rows[0].candidate !== reference.runTarget.candidate) deny();
      return rows[0];
    };
    const begin = () => {
      subject();
      const claim = fence.begin(reference);
      if (!claim || claim.then || JSON.stringify(claim.request) !== JSON.stringify(reference) || claim.receiptHash) deny();
    };
    const acknowledge = receipt => {
      validateInterruptedWrite(receipt);
      subject();
      const rows = read(dir, "runs").filter(row => row.id === reference.run);
      if (rows.length !== 1 || rows[0].task !== reference.task || rows[0].role !== reference.role
        || rows[0].status !== receipt.result.status || rows[0].ended !== receipt.result.ended || rows[0].report) deny();
      const receiptHash = createHash("sha256").update(JSON.stringify(receipt)).digest("hex");
      const finished = fence.end(reference, receiptHash);
      if (!finished || finished.then || JSON.stringify(finished.request) !== JSON.stringify(reference) || finished.receiptHash !== receiptHash) deny();
      return receipt.result;
    };
    const recovered = interruptedWrites.recover(dir, reference, begin);
    if (recovered) { const result = acknowledge(recovered); status(dir, true); return { decision: "run-finished", ...result }; }
    const prior = interruptedWrites.readReceipt(dir, reference);
    if (prior) return { decision: "already-finished", ...acknowledge(prior) };
    ready(dir);
    subject();
    const tasks = read(dir, "tasks").filter(row => row.id === reference.task), rows = read(dir, "runs");
    const matches = rows.filter(row => row.id === reference.run);
    if (tasks.length !== 1 || matches.length !== 1 || matches[0].task !== reference.task || matches[0].role !== reference.role
      || matches[0].status !== "running" || matches[0].ended || matches[0].report) deny();
    const receipt = { reference, result: interruptedResult(reference, now()) };
    Object.assign(matches[0], { status: reference.status, report: "", ended: receipt.result.ended });
    interruptedWrites.commit(dir, receipt, { runs: tableText("runs", rows) }, begin);
    const result = acknowledge(receipt);
    status(dir, true);
    return { decision: "run-finished", ...result };
  });
}

/** Finish only a run from evidence already authenticated by the provider. This never records a verdict. */
function finishReportedRun(input, env = process.env) {
  const keys = ["project", "task", "run", "role", "assignment", "reportHash", "text"];
  const deny = () => refuse("The saved report does not match an unfinished run or its recorded result.");
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== keys.length
    || keys.some(key => !Object.hasOwn(input, key) || typeof input[key] !== "string") || !input.project
    || !/^T[1-9]\d*$/.test(input.task) || !/^R[1-9]\d*$/.test(input.run)
    || !/^[a-z][a-z-]{0,63}$/.test(input.role) || !new RegExp(`^${UUID}$`).test(input.assignment)
    || !/^[0-9a-f]{64}$/.test(input.reportHash)) deny();
  const report = parseReport(input.text);
  if (createHash("sha256").update(input.text).digest("hex") !== input.reportHash) deny();
  const dir = storeDir(input.project, env);
  // A report must stay in the selected logbook, with no redirected directory components.
  if (realpathSync(dir) !== resolve(dir)) deny();
  return withLock(dir, () => {
    ready(dir);
    const tasks = read(dir, "tasks").filter(row => row.id === input.task);
    const runs = read(dir, "runs");
    const matches = runs.filter(row => row.id === input.run);
    if (tasks.length !== 1 || matches.length !== 1) deny();
    const run = matches[0];
    if (run.task !== input.task || run.role !== input.role) deny();
    const name = `reports/${input.run}-${input.assignment}-${input.reportHash}.md`;
    const repeated = run.report === name && run.status === report.STATUS
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(run.ended);
    if (!repeated && (run.status !== "running" || run.report || run.ended)) deny();
    const folder = join(dir, "reports");
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    if (realpathSync(folder) !== folder) deny();
    const file = join(dir, name);
    const sameFile = () => {
      const st = lstatSync(file, { throwIfNoEntry: false });
      if (!st) return false;
      // A crash can leave the publication temp file as a second hard link. Read exact bytes; never rewrite them.
      if (!st.isFile() || readRegular(file, { link: false, max: 32 * 1024 }) !== input.text) deny();
      return true;
    };
    if (!sameFile()) {
      // A missing file on a completed run is damage, not permission to rewrite its history.
      if (repeated) deny();
      const temporary = join(folder, `.report-${randomUUID()}`);
      let fd, created = false;
      try {
        fd = openSync(temporary, "wx", 0o600);
        created = true;
        writeFileSync(fd, input.text);
        fsyncSync(fd);
        closeSync(fd); fd = undefined;
        try { linkSync(temporary, file); }
        catch (error) { if (error.code !== "EEXIST") throw error; }
      } finally {
        if (fd !== undefined) closeSync(fd);
        if (created) unlinkSync(temporary);
      }
      if (!sameFile()) deny();
    }
    // The evidence reaches disk before the run points at it. A retry can use an orphaned identical file.
    const folderFd = openSync(folder, "r");
    try { fsyncSync(folderFd); } finally { closeSync(folderFd); }
    if (!repeated) {
      Object.assign(run, { status: report.STATUS, report: name, ended: now() });
      write(dir, "runs", runs);
    }
    status(dir, true);
    return { decision: repeated ? "already-finished" : "run-finished", task: input.task,
      run: run.id, status: run.status, report: name, ended: run.ended };
  });
}


function reviewHead(project, branch, env) {
  const clean = Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith("GIT_")));
  return git(["-C", project, "rev-parse", "--verify", `refs/heads/${branch}^{commit}`], clean).trim();
}

/** Validate recorded work immediately before provider preparation or dispatch. This grants no role authority. */
function captureRunAssignment(input, env = process.env) {
  const keys = ["project", "task", "run", "role"];
  const deny = () => refuse("The assignment needs one active run on its current task, role, branch, and round.");
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== keys.length
    || keys.some(key => !Object.hasOwn(input, key)) || typeof input.project !== "string" || !input.project
    || typeof input.task !== "string" || !/^T[1-9]\d*$/.test(input.task)
    || typeof input.run !== "string" || !/^R[1-9]\d*$/.test(input.run)
    || typeof input.role !== "string" || !/^[a-z][a-z-]{0,63}$/.test(input.role)) deny();
  const dir = storeDir(input.project, env);
  if (realpathSync(dir) !== resolve(dir)) deny();
  return withLock(dir, () => {
    ready(dir);
    const tasks = read(dir, "tasks").filter(row => row.id === input.task);
    const runs = read(dir, "runs").filter(row => row.id === input.run);
    if (tasks.length !== 1 || runs.length !== 1) deny();
    const task = tasks[0], run = runs[0];
    notHeld(task, "assignment");
    if (!STATES.includes(task.state) || ["merged", "concluded", "abandoned"].includes(task.state)
      || run.task !== task.id || run.role !== input.role || run.round !== task.round || run.status !== "running"
      || run.report || run.ended || !/^(0|[1-9]\d*)$/.test(task.round)
      || !Number.isSafeInteger(Number(task.round))
      || (task.branch && !ofTask(task.id, branchOf(task.branch)))
      || (run.branch && run.branch !== task.branch) || (WRITERS.includes(run.role) && !run.branch)) deny();
    if (WRITERS.includes(run.role) && read(dir, "runs").some(row => row.id !== run.id
      && row.status === "running" && WRITERS.includes(row.role) && row.branch === run.branch)) deny();
    return { task: task.id, run: run.id, role: run.role, round: Number(task.round),
      taskBranch: task.branch, runBranch: run.branch, candidate: run.candidate };
  });
}

/** Read terminal evidence against a coherent snapshot. This never grants run authority. */
function validateTerminalAssignment(input, env = process.env, historyProof) {
  const deny = () => refuse("The terminal assignment has no coherent task and run evidence.");
  if (!updateKeys(input, ["project", "target", "review", ...(Object.hasOwn(input ?? {}, "retirement") ? ["retirement"] : [])]) || typeof input.project !== "string" || !input.project
    || !updateKeys(input.target, ["task", "run", "role", "round", "taskBranch", "runBranch", "candidate"])) deny();
  const target = parseRunTarget(input.target), dir = storeDir(input.project, env);
  if (realpathSync(dir) !== resolve(dir)) deny();
  return withLock(dir, () => {
    const pending = taskUpdates.pending(dir);
    const tables = pending ? Object.fromEntries(["tasks", "runs"].map(table => [table, updateRows(table, pending.tables[table].before)]))
      : Object.fromEntries(["tasks", "runs"].map(table => [table, read(dir, table)]));
    const pair = (rows, optional = false) => {
      const tasks = rows.tasks.filter(row => row.id === target.task), runs = rows.runs.filter(row => row.id === target.run);
      if (optional && (!tasks.length || !runs.length)) return null;
      if (tasks.length !== 1 || runs.length !== 1) deny();
      return { task: tasks[0], run: runs[0] };
    };
    const immutable = ({ task, run }) => run.task === target.task && run.role === target.role
      && Number(run.round) === target.round && run.branch === target.runBranch && run.candidate === target.candidate
      && Number(task.round) === target.round && task.branch === target.taskBranch;
    const current = pair(tables);
    const active = ({ task, run }) => STATES.includes(task.state) && !["held", "merged", "concluded", "abandoned"].includes(task.state)
      && run.status === "running" && !run.report && !run.ended;
    const retirement = input.retirement ?? null;
    if (retirement !== null && (!updateKeys(retirement, ["owner", "request", "digest"])
      || typeof retirement.owner !== "string" || typeof retirement.request !== "string"
      || !new RegExp(`^${UUID}$`).test(retirement.request) || typeof retirement.digest !== "string"
      || !/^[a-f0-9]{64}$/.test(retirement.digest))) deny();
    const retires = intent => retirement !== null && intent.reference.owner === retirement.owner
      && intent.reference.request === retirement.request
      && createHash("sha256").update(JSON.stringify(intent)).digest("hex") === retirement.digest;
    const retired = retirement !== null && !(pending && retires(pending));
    let proven = immutable(current) && active(current) && !retired;
    if (!proven) {
      const receipts = taskUpdates.history(dir).filter(row => row.intent.reference.task === target.task);
      const completed = [];
      for (const receipt of receipts) {
        if (pending && receipt.intent.reference.owner === pending.reference.owner
          && receipt.intent.reference.request === pending.reference.request) {
          taskUpdates.authenticatePending(receipt, pending, historyProof);
        } else {
          taskUpdates.authenticate(receipt, historyProof);
          completed.push(receipt);
        }
      }
      // The pending receipt is not a completed transition, even after acknowledgement.
      const history = completed.filter(row => row.outcome.accepted)
        .map(row => ({ retires: row.intent.proposal.disruptive && retires(row.intent), before: pair(Object.fromEntries(["tasks", "runs"].map(table => [table, updateRows(table, row.intent.tables[table].before)])), true),
          after: pair(Object.fromEntries(["tasks", "runs"].map(table => [table, updateRows(table, row.intent.tables[table].after)])), true) })).filter(row => row.before && row.after);
      // Follow exact coherent task/run pairs; a gap cannot explain a changed target.
      const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
      const reached = history.filter(row => immutable(row.before) && active(row.before) && (!retired || row.retires)).map(row => row.after);
      for (let index = 0; index < reached.length && index <= history.length; index++) {
        if (same(reached[index], current)) { proven = true; break; }
        for (const row of history) if (same(row.before, reached[index]) && !reached.some(value => same(value, row.after))) reached.push(row.after);
      }
    }
    if (!proven) deny();
    if (input.review !== null) {
      const review = parseReviewTarget(input.review);
      if (!REVIEW_ROLES.includes(target.role) || review.round !== target.round || review.branch !== branchOf(target.taskBranch)
        || (!retired && review.sha !== reviewHead(input.project, review.branch, env))) deny();
    } else if (REVIEW_ROLES.includes(target.role)) deny();
    return structuredClone(target);
  });
}

/** Capture a review subject from the actual logbook and local branch, never from a reported SHA. */
function captureReviewTarget(input, env = process.env) {
  const keys = ["project", "task", "run", "role", "cycle"];
  const deny = () => refuse("The review needs an active run on its task's current branch and round.");
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== keys.length
    || keys.some(key => !Object.hasOwn(input, key)) || typeof input.project !== "string" || !input.project
    || typeof input.task !== "string" || !/^T[1-9]\d*$/.test(input.task)
    || typeof input.run !== "string" || !/^R[1-9]\d*$/.test(input.run) || !REVIEW_ROLES.includes(input.role)
    || !Number.isInteger(input.cycle) || input.cycle < 1 || input.cycle > 10) deny();
  const dir = storeDir(input.project, env);
  if (realpathSync(dir) !== resolve(dir)) deny();
  return withLock(dir, () => {
    ready(dir);
    const tasks = read(dir, "tasks").filter(row => row.id === input.task);
    const runs = read(dir, "runs").filter(row => row.id === input.run);
    if (tasks.length !== 1 || runs.length !== 1) deny();
    const task = tasks[0], run = runs[0];
    notHeld(task, "assignment");
    if (run.task !== task.id || run.role !== input.role || run.round !== task.round || run.status !== "running"
      || run.report || run.ended || !/^(0|[1-9]\d*)$/.test(task.round)
      || !Number.isSafeInteger(Number(task.round)) || (run.branch && run.branch !== task.branch)) deny();
    const branch = branchOf(task.branch);
    // Repository-selection and injected-config environment variables cannot redirect this read.
    const sha = reviewHead(input.project, branch, env);
    return parseReviewTarget({ branch, sha, round: Number(task.round), cycle: input.cycle });
  });
}

function tableText(table, rows) {
  const cols = TABLES[table];
  return [cols.join("\t"), ...rows.map((r) => cols.map((c) => cell(r[c])).join("\t"))].join("\n") + "\n";
}
function write(dir, table, rows) {
  put(join(dir, `${table}.tsv`), tableText(table, rows));
}

const now = () => new Date().toISOString().slice(0, 19) + "Z";
/** The cells that hold ids: each table's own id, the columns that name the id of another row, and a decision's subject. */
const IDS = { tasks: ["id", "keys"], runs: ["id", "task"], findings: ["task", "key"], ledger: ["task", "run"], gates: ["id", "task"], decisions: ["task"] };
/**
 * A new id: the highest whole number after the prefix that any id cell of the logbook names, plus 1. So an id never
 * comes back, also when its own row is lost while another row (a verdict's run, a decision, a round's keys) still names
 * it. Free text does not count: a path or a title can hold "-T9" by chance. In a decision, only its subjects count: the
 * first word ("F-T2-1 opened again", "G1 was answered by phone"), and in a move, also the new task and key ("F-T1-1 moved
 * to T2 as F-T2-1: …"). Only digits count ("Infinity" does not), and BigInt keeps a long number exact.
 */
/** The ids a decision is about: its first word, and the new task and key of a move (the form that finding move writes). */
const subjects = (decision) => /^(\S+) moved to (\S+) as (\S+):/.exec(decision)?.slice(1) ?? [decision];
function nextId(dir, prefix) {
  let max = 0n;
  const take = (text, re) => {
    for (const [, n] of text.matchAll(re)) if (BigInt(n) > max) max = BigInt(n);
  };
  for (const [table, cols] of Object.entries(IDS)) {
    for (const row of read(dir, table)) {
      for (const c of cols) take(row[c], new RegExp(`(?<![A-Za-z0-9])${prefix}(\\d+)`, "g"));
      if (table === "decisions") for (const word of subjects(row.decision)) take(word, new RegExp(`^${prefix}(\\d+)(?![A-Za-z0-9])`, "g"));
    }
  }
  return `${prefix}${max + 1n}`;
}
const list = (s) => (s ? s.split(",").map((x) => x.trim()).filter(Boolean) : []);
/** Does a task build code? Only a route with build has commits, a pull request and a merge. */
const builds = (task) => list(task.route).includes("build");

/**
 * A command's words and options. Every option takes a value: --name value, or --name=value. The value may start with
 * "--", but it may not be another option of the command: then the value is missing. A command refuses an option that
 * it does not take, so a typo or an option of a newer version is never dropped in silence.
 */
function parse(cmd, args) {
  const pos = [];
  const opt = Object.create(null);
  const spaced = []; // the options whose value is the next word
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--")) pos.push(a);
    else {
      const eq = a.includes("=");
      const o = a.slice(2, eq ? a.indexOf("=") : undefined);
      const v = eq ? a.slice(a.indexOf("=") + 1) : args[++i];
      if (!eq) spaced.push(o);
      if (o in opt) refuse(`--${o} is given twice. Give it once${o === "accept-loss" ? `, with the tables joined by a comma: --accept-loss ${opt[o]},${v}` : ""}.`);
      opt[o] = v;
    }
  }
  const name = OPTIONS[`${cmd} ${pos[0]}`] ? `${cmd} ${pos[0]}` : cmd;
  const takes = [...(OPTIONS[name] ?? []), "project"];
  for (const o of Object.keys(opt)) if (!takes.includes(o)) refuse(`${name} takes no --${o}. Its options: ${takes.map((t) => `--${t}`).join(", ")}.`);
  for (const o of spaced) {
    const v = opt[o];
    if (v === undefined || (v.startsWith("--") && takes.includes(v.slice(2).split("=")[0]))) refuse(`--${o} needs a value. A value that starts with -- goes after =: --${o}=<value>.`);
  }
  return { pos, opt };
}

const need = (value, what) => value || refuse(`missing ${what}`);
/** A word as a shell reads it: in single quotes when it holds anything but letters, digits and ._/-, so a pasted command does only what it says. */
const shell = (word) => (/^[\w./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`);

/**
 * A held task takes no new run, finding change or verdict, from any caller, until the sage moves it out of held (F-T273-18):
 * a lead's command that the hook checked before the round set held still stops here. Nor does it take pr= or branch=
 * (F-T284-3). The chief's own moves stay: task set state=, round, run done, finding move, and a triage ask or dismiss.
 */
const notHeld = (task, what) => task.state === "held" && refuse(`${task.id} is held, so it takes no ${what}: only the sage moves a held task (sage task ${task.id} set state=building or briefed), then ${what} again.`);

/**
 * Waits (T336): a task may wait for other tasks of its own logbook. A wait is met when that task is merged or concluded; an
 * abandoned or lost task never meets it, also in the same merge (the owner, 2026-10-19). A task with an unmet wait takes
 * no build work (WAIT_ROLES, a move to building) and does not merge; its design and PE may run.
 */
const MET = ["merged", "concluded"];
const WAIT_ROLES = ["lead", "implementer", "investigate", "arena-judge"];
const WAITS_MAX = 20;
const TASK_ID = /^T[1-9]\d*$/;
/** The words of a waits value, as a write and a read split them: by commas or spaces. */
const waitWords = (value) => String(value ?? "").split(/[\s,]+/).filter(Boolean);
/**
 * A task's waits cell, read with the parser of the writes: its task ids, and odd when a hand edit put other text there. No
 * line prints the cell itself, so its text never reaches the chief; odd counts as one unmet wait, so the task still waits.
 */
const waitsOf = (task) => {
  const words = waitWords(task?.waits);
  return { ids: [...new Set(words.filter((w) => TASK_ID.test(w)))], odd: words.some((w) => !TASK_ID.test(w)) };
};
/** The tasks by id, built once by a caller that looks up many waits, so a merge check stays linear. */
const byIds = (tasks) => new Map(tasks.map((t) => [t.id, t]));
/** A task's waits, each with the state of its task (undefined for a task that the logbook lost), and odd text as one more. */
const waitsWithState = (task, byId) => {
  const { ids, odd } = waitsOf(task);
  return [...ids.map((id) => ({ id, state: byId.get(id)?.state })), ...(odd ? [{ odd }] : [])];
};
/** The waits of a task that are not met. passes(id) meets a wait too: a task that passes in the same merge. */
const unmetWaits = (task, byId, passes = () => false) => waitsWithState(task, byId).filter(({ id, state, odd }) => odd || (!MET.includes(state) && !passes(id)));
const ODD = "the waits cell has text that is not a task id";
const waitList = (open) => open.map(({ id, state, odd }) => (odd ? ODD : `${id} (${state ?? "not in the logbook"})`)).join(", ");
/** A task that never meets a wait: abandoned, or lost from the logbook. */
const dead = (state) => state === "abandoned" || state === undefined;
/** The fix for a wait that is never met: its task was abandoned or is lost, or the cell has text that is not a task id. */
const waitFix = (task, open) => {
  const gone = open.filter(({ state, odd }) => !odd && dead(state)).map(({ id }) => id);
  const how = `sage task ${task.id} set waits=<ids>, or waits= to clear it`;
  return [
    gone.length ? ` ${gone.join(", ")} ${gone.length === 1 ? "is" : "are"} abandoned or not in the logbook, so ${gone.length === 1 ? "that wait is" : "those waits are"} never met: remove or change the wait (${how}), or ask the owner.` : "",
    open.some(({ odd }) => odd) ? ` A hand edit put that text there: set the waits again (${how}).` : "",
  ].join("");
};
/** Refuses work of what on a task with an unmet wait, and names each unmet task with its state. A move to merged or concluded opens the waits on it, so it refuses too. */
const waitsMet = (task, tasks, what) => {
  const open = unmetWaits(task, byIds(tasks));
  const end = { "move to merged": "merged", "move to concluded": "concluded" }[what];
  const after = end ? `it moves to ${end} after each of them is merged or concluded.` : "it starts after each of them is merged or concluded. Its design and PE may run.";
  if (open.length) refuse(`${task.id} waits for ${waitList(open)}, so it takes no ${what}: ${after}${waitFix(task, open)}`);
};
/** A task's waits for a printed line: each with its task's state, then the unmet ones. */
const waitsText = (task, tasks) => {
  const byId = byIds(tasks), all = waitsWithState(task, byId), open = unmetWaits(task, byId);
  if (!all.length) return "";
  return ` · waits ${waitList(all)} · ${open.length ? `unmet ${open.map(({ id, odd }) => (odd ? "the odd text" : id)).join(", ")}` : "all met"}`;
};
/**
 * A waits value as its cell holds it: task ids joined by commas, "" for none (an empty value or none clears it). The ids may
 * be separated by commas or spaces. It refuses a word that is not a task id, a duplicate, the task itself, more than
 * WAITS_MAX, a task that this logbook does not have, and a loop, which it names (T8, T9, T8).
 */
function waitsValue(task, value, tasks) {
  const ids = value === "none" ? [] : waitWords(value);
  const nothing = " Nothing changed.";
  const odd = ids.find((id) => !TASK_ID.test(id));
  if (odd !== undefined) refuse(`waits takes task ids such as T7, separated by commas or spaces, or none to clear it; not "${visible(odd)}".${nothing}`);
  const twice = ids.find((id, i) => ids.indexOf(id) !== i);
  if (twice) refuse(`waits names ${twice} twice: give each task once.${nothing}`);
  if (ids.includes(task.id)) refuse(`${task.id} cannot wait for itself.${nothing}`);
  if (ids.length > WAITS_MAX) refuse(`waits names ${ids.length} tasks, more than the ${WAITS_MAX} that a task may wait for. Split the task, or wait for fewer.${nothing}`);
  const known = new Map(tasks.map((t) => [t.id, t]));
  const lost = ids.find((id) => !known.has(id));
  if (lost) refuse(`no task ${lost} in this logbook: a task waits only for a task of its own logbook.${nothing}`);
  // A loop: a path of waits from one of the new ids back to the task. One depth-first search over the logbook's tasks.
  const next = (id) => (id === task.id ? ids : waitsOf(known.get(id)).ids);
  const seen = new Set();
  const back = (id, path) => {
    if (id === task.id) return path;
    if (seen.has(id)) return undefined;
    seen.add(id);
    for (const n of next(id)) {
      const found = back(n, [...path, n]);
      if (found) return found;
    }
    return undefined;
  };
  for (const id of ids) {
    const loop = back(id, [task.id, id]);
    if (loop) refuse(`these waits make a loop: ${loop.join(", ")}. A loop never ends, so sage refuses it.${nothing}`);
  }
  return ids.join(",");
}
/** The decision row of a changed waits list, so that a replaced list leaves its record. */
const waitsDecision = (task, was, at, why) => {
  if (was === (task.waits ?? "")) return [];
  const { ids, odd } = waitsOf({ waits: was }); // the old cell through the parser: a hand edit's text never reaches the row
  return [{ at, task: task.id, decision: `waits ${[...ids, ...(odd ? ["(text that is not a task id)"] : [])].join(",") || "none"} → ${task.waits || "none"}`, why }];
};

/** The extra rounds of a task's holds by round: a whole number, and 0 for any other cell, so a hand-written cell never gives NaN (F-T286-2). */
const extraOf = (task) => (/^\d{1,3}$/.test(task.extra ?? "") ? Number(task.extra) : 0);

/** Refuses an id that the logbook does not have, and names the latest ids that it has, to pick from. */
const missing = (what, ids) => refuse(`no ${what}. ${ids.length ? `The latest: ${ids.slice(-10).join(", ")}.` : "There is none yet."}`);

/** The keys of a task's current round: round sets them to its fix findings, and a move out of replan clears them. */
const roundKeys = (task) => String(task.keys ?? "").split(",").filter(Boolean);

function taskOf(dir, id) {
  const tasks = read(dir, "tasks");
  const task = tasks.find((t) => t.id === id) ?? missing(`task ${id}`, tasks.map((t) => t.id));
  return { tasks, task };
}

/** Calculate ordered task changes over one coherent snapshot. No files or clock are read. */
function planTaskChanges(before, id, changes, at, facts) {
  const { tasks, runs, decisions } = structuredClone(before);
  const matches = tasks.filter(row => row.id === id);
  if (matches.length !== 1) refuse("The task is missing or ambiguous.");
  const task = matches[0], decided = [];
  for (const kv of changes) {
    const [k, v] = [kv.slice(0, kv.indexOf("=")), kv.slice(kv.indexOf("=") + 1)];
    if (k === "state") {
      if (v === "repairing") refuse("start a repair with: sage round <task>");
      // A move out of a hold that round set gives the task one more repair round, once per such hold (F-T284-14,
      // F-T284-15). Only the state tool writes hold and extra (F-T284-16); a hold by task set gives none.
      const was = task.state;
      move(task, v); // the design's states first; the table is written only if every check below passes
      if (["building", "merged", "concluded"].includes(v)) waitsMet(task, tasks, `move to ${v}`);
      // A move to abandoned gives no round: the task ends (F-T286-3).
      if (was === "held" && task.hold === "round" && v !== "abandoned") {
        task.extra = String(extraOf(task) + 1);
        decided.push({ at: at, task: task.id, decision: `held → ${v}: one more repair round`, why: "task set" });
      }
      if (was === "held" || v === "held") task.hold = "";
      // A new premise starts its own count: the round keys of the old plan go when the task leaves replan (F-T284-19).
      if (was === "replan") task.keys = "";
      // A re-plan (held or replan back to briefed) ends the running lead run: the old lead works to the old brief, so
      // its writes and helper starts stop here, and the chief starts a new lead with the new brief (F-T289-9).
      if (v === "briefed" && ["held", "replan"].includes(was)) {

        for (const r of runs.filter((r) => r.task === task.id && r.role === "lead" && r.status === "running")) {
          Object.assign(r, { status: "blocked", ended: at });
          decided.push({ at: at, task: task.id, decision: `${r.id} blocked: ${task.id} went back to briefed`, why: "a re-plan: a new lead starts with the new brief" });
        }
      }
      const build = builds(task);
      if ((v === "verified" && !build) || (v === "concluded" && build)) refuse(`${task.id} ${build ? "has a build block, so it ends at verified" : "has no build block, so it ends at concluded"}`);
      if (v === "verifying" || v === "concluded") {
        const open = facts.findings.filter((f) => f.task === task.id && f.status === "open");
        if (open.length) refuse(`${task.id} has open findings: ${open.map((f) => `${f.key} (${f.triage || "not triaged"})`).join(", ")}. Close or dismiss each one first.`);
      }
      if (v === "concluded" && facts.ledger.filter((r) => r.task === task.id).at(-1)?.kind !== "evidence-clean") {
        refuse(`${task.id} needs a clean evidence review as its latest verdict: sage verdict ${task.id} --kind evidence-clean --run <R>`);
      }
      if (v === "verified") {
        const rows = facts.ledger.filter((r) => r.task === task.id);
        const head = rows.at(-1)?.sha ?? refuse(`${task.id} has no verdicts yet`);
        const r = judge("", task, facts.findings, task.id, rows.filter((r) => r.sha === head), 1);
        if (!r.ok) refuse(`${task.id} is not verified on ${head.slice(0, 7)}: ${r.reason}`);
      }
      if (["merged", "concluded", "abandoned"].includes(v)) decided.push({ at: at, task: task.id, decision: `state ${v}`, why: "task set" });
    } else if (k === "pr") decided.push(...(notHeld(task, "pr="), setPr(task, v, "task set", at)));
    else if (k === "branch") notHeld(task, "branch="), task.branch = v && (ofTask(task.id, branchOf(v)) ? v : refuse(`${JSON.stringify(v)} is not a branch of ${task.id}: use [<prefix>/]${task.id.toLowerCase()}[-<words>], for example sage task ${task.id} set branch=sage/${task.id.toLowerCase()}`)); // branch= clears it
    else if (k === "title") task.title = v;
    else if (k === "priority" || k === "kind") task[k] = tag(k, v);
    else if (k === "waits") {
      const was = task.waits ?? "";
      task.waits = waitsValue(task, v, tasks);
      if (task.waits && ["merged", "concluded", "abandoned"].includes(task.state)) refuse(`${task.id} is ${task.state}: an ended task waits for nothing, so it takes no new wait. waits= clears a wait. Nothing changed.`);
      decided.push(...waitsDecision(task, was, at, "task set"));
    } else refuse(`task set takes state=, branch=, pr=, title=, priority=, kind= or waits=`);
  }
  return { task, tasks, runs, decisions: [...decisions, ...decided] };
}

/** A task's priority or kind as its cell holds it: "" for none, else a value of the fixed list. Any other value refuses, with the list. */
const tag = (key, value) => {
  const values = key === "priority" ? PRIORITIES : TASK_KINDS;
  return value === "none" ? "" : values.includes(value) ? value : refuse(`${key} is one of ${values.join(", ")}, or none to clear it; not "${visible(String(value ?? ""))}". Nothing changed.`);
};

/** Frames a task with its route and writes it: the least route of its size, the security review for a risk, and the added blocks. */
function taskFrame(id, title, size, risk, add) {
  const blocks = new Set([...SIZES[size], ...(risk.length && size !== "investigate" ? ["security-review"] : []), ...add]);
  const task = { id, title, size, risk: risk.join(","), route: BLOCKS.filter((b) => blocks.has(b)).join(","), state: "framed", round: 0 }; // the blocks in their order
  return task;
}
function frame(dir, title, size, risk, add, tags = {}) {
  const task = { ...taskFrame(nextId(dir, "T"), title, size, risk, add), ...tags };
  write(dir, "tasks", [...read(dir, "tasks"), task]);
  return task;
}
/** A task's priority and kind for a printed line: nothing when it has none. */
const tagsOf = (task) => `${task.priority ? ` · ${task.priority}` : ""}${task.kind ? ` · kind ${task.kind}` : ""}`;
const framed = (task) => `${task.id} framed · ${task.size}${task.risk ? ` · risk ${task.risk}` : ""} · route ${task.route}${tagsOf(task)}${task.waits ? ` · waits ${task.waits.replaceAll(",", ", ")}` : ""}`;

function move(task, to) {
  if (to !== "abandoned" && !(NEXT[task.state] ?? []).includes(to)) refuse(`${task.id} cannot go from ${task.state} to ${to}. Next: ${(NEXT[task.state] ?? []).join(", ") || "none"}`);
  task.state = to;
}

/**
 * Gives a task its pull request, or clears it with "". An investigation changes no code, so it may only clear one. A
 * change gives its decision row (S1), which the caller writes before the task: a task that was ever on a PR stays in
 * that PR's merge check (prHistory), so a cleared or changed pr= cannot take its verdicts out of the merge.
 */
function setPr(task, pr, why, at = now()) {
  if (pr && !builds(task)) refuse(`${task.id} is an investigation: it changes no code, so it has no pull request. A build is its own task: sage task add --size tiny, small or large, then give that task the PR.`);
  if (pr && !PR.test(pr)) refuse(`${JSON.stringify(pr)} is not a pull request number. Give only its digits, with no leading zero, for example pr=5 or --pr 5.`);
  const was = task.pr;
  task.pr = pr;
  // An investigation never has commits on a PR, so the PR that an old logbook gave it leaves no trace when it is cleared.
  return was === pr || !builds(task) ? [] : [{ at, task: task.id, decision: `PR ${was || "none"} → ${pr || "none"}`, why }];
}
/** The ids of the tasks that are or ever were on PR pr: by the tasks' pr, the decision rows of setPr, and their verdicts on a commit of the PR. */
const prHistory = (pr, tasks, decisions, ledger) =>
  new Set([
    ...tasks.filter((t) => prNumber(t.pr) === pr).map((t) => t.id),
    ...decisions.filter((d) => /^PR (\S+) → (\S+)$/.exec(d.decision)?.slice(1).map(prNumber).includes(pr)).map((d) => d.task),
    ...ledger.filter((r) => prNumber(r.pr) === pr && r.sha).map((r) => r.task),
  ]);

/** Why sha cannot name a commit in the ledger, or "". A short SHA could match another commit with the same prefix. Case does not matter. */
const notFull = (sha) => (/^[0-9a-f]{40}$/i.test(sha) ? "" : `${JSON.stringify(sha)} is not a full commit SHA: a short one can match another commit. Give all 40 characters: git rev-parse <branch>.`);

/**
 * Does one task have the clean cycles its route needs on one SHA? tasks and findings are its logbook's tables, read once
 * by the caller; rows are only that task's ledger rows for the SHA. A task without rows is in the merge check only through
 * its PR history (prHistory).
 */
function judge(dir, task, findings, id, rows, cycles, repaired, cfg, pr) {
  if (!task) return { ok: false, reason: `${id} is in ${join(dir, "ledger.tsv")} but not in its tasks.tsv: ${repaired ? `tasks.tsv was started again without rows (see decisions.tsv), so the verdicts of ${id} are on a lost task. Push a new commit, and record its verdicts under a task that the logbook has.` : `a stray or damaged logbook. If no project uses it, ask the user to remove ${dir}.`}` };
  const who = task.state === "abandoned" ? `${task.id} (abandoned)` : task.id; // it still counts: the merge check fails closed
  if (!rows.length && !builds(task)) return { ok: false, reason: `${who} is an investigation, so it has no pull request, but it has PR ${task.pr}: clear its PR (sage task ${task.id} set pr=).` };
  if (!rows.length) return { ok: false, reason: `${who} ${prNumber(task.pr) === pr ? "is" : "was"} a task of PR ${pr} but has no verdicts on this SHA. Every task that was ever on PR ${pr} counts for its merge, also after its pr= changed (see decisions.tsv): record its verdicts on this SHA, or the user merges.` };
  const open = findings.filter((f) => f.task === task.id && f.status === "open");
  if (open.length) return { ok: false, reason: `${who} has open findings: ${open.map((f) => f.key).join(", ")}. Triage and close them first.` };
  const bad = rows.find((r) => NOT_CLEAN.includes(r.kind));
  if (bad) return { ok: false, reason: `${who}: cycle ${bad.cycle} found problems on this SHA (${bad.kind}). Repair, then review the new SHA.` };
  if (!rows.some((r) => r.kind === "checks-pass")) return { ok: false, reason: `${who}: no checks-pass on this SHA. Run the checks on it and record checks-pass.` };
  const perCycle = cleanKinds(task);
  const want = perCycle.length ? cycles : 1;
  const clean = perCycle.length ? cleanCycles(task, rows) : 1;
  if (clean < want) {
    const missing = perCycle.filter((k) => !rows.some((r) => r.kind === k));
    const high = want > LIMIT["cycles.small"] && cycleKeys(task).find((k) => cfg[k] === want); // only config.json holds a count above the limit
    return { ok: false, reason: `${who}: ${clean} of ${want} clean cycles on this SHA${high ? ` (${high} is ${want} in config.json; the config command takes 1 to 10)` : ""}${missing.length ? `; never recorded: ${missing.join(", ")}` : ""}. Run the next cycle of its reviews on this SHA and record each verdict.` };
  }
  return { ok: true, reason: `${task.id} may merge: ${clean} clean cycle${clean === 1 ? "" : "s"} on this SHA` };
}

/** The clean verdicts that each cycle of a task needs: those of its route's reviews and QA. */
const cleanKinds = (task) => list(task.route).map((b) => VERDICT[b]).filter((k) => k && k !== "checks-pass");
/** The cycles of a task's ledger rows on one SHA that have every clean verdict of its route (the judge's count). */
const cleanCycles = (task, rows) => [...new Set(rows.map((r) => r.cycle))].filter((c) => cleanKinds(task).every((k) => rows.some((r) => r.cycle === c && r.kind === k))).length;

/** The rows of a table by their task. */
const group = (rows) => rows.reduce((m, r) => (m.has(r.task) ? m.get(r.task).push(r) : m.set(r.task, [r]), m), new Map());

/**
 * The folders of the sage root, also links to folders: the writes go through a link, so the merge check reads through
 * it too. A link to nothing holds no logbook, for the writes either; one that cannot be followed refuses.
 */
const folders = (root) => (existsSync(root) ? readdirSync(root).map((name) => join(root, name)).filter((path) => statSync(path, { throwIfNoEntry: false })?.isDirectory()).sort() : []);

const PROJECTS = ["logbook", "at", "how"];
/** The deliberate command that lists the logbook folders of the root again, for the owner to check. */
const REBUILD = "sage projects rebuild --accept-listing yes";
/** The folders of the root that hold a logbook's tasks or verdicts: what a migration or a rebuild lists. */
const logbooks = (root) => folders(root).filter((dir) => ["tasks.tsv", "ledger.tsv"].some((f) => lstatSync(join(dir, f), { throwIfNoEntry: false }))).map((dir) => basename(dir));

/**
 * Writes the known project list. The marker projects.made goes first: once the list was made, a list that goes missing
 * refuses (known) and is never listed again by itself, so a removed list cannot take in a folder planted after it.
 */
function enlist(root, rows) {
  const made = join(root, "projects.made");
  if (!lstatSync(made, { throwIfNoEntry: false })) swap(made, `${now()}\n`);
  swap(join(root, "projects.tsv"), [PROJECTS.join("\t"), ...rows.map((r) => PROJECTS.map((c) => cell(r[c])).join("\t"))].join("\n") + "\n");
}

/**
 * The known project list: the names of the logbook folders that init made, from projects.tsv in the sage root. Only
 * init adds a line, so a folder that appears there by any other way cannot lend its verdicts to a merge (T77 round 3).
 * The first command of this version finds no list and no marker (enlist) and lists today's logbooks once (how:
 * migration). After that, a missing list refuses, and only the owner's rebuild lists the folders again. The list must be
 * a regular file, not a link, with its header line; anything else refuses. It never removes a line. With add (init),
 * make runs under the root's lock after the list passed and before add joins it, so a refusal here changes nothing.
 * With readOnly, it takes no lock and writes nothing: a missing list gives undefined.
 */
function known(root, add, make, readOnly) {
  const file = join(root, "projects.tsv");
  const names = () => {
    let text;
    try {
      text = readRegular(file, { link: false });
    } catch (e) {
      if (e instanceof Refusal) refuse(`${file}, the known project list, is not a regular file. Ask the user to remove it, then to run ${REBUILD}, which lists the logbook folders that are there now.`);
      throw e;
    }
    if (text === undefined) return undefined;
    const [head, ...lines] = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);
    if (!PROJECTS.every((c) => head?.split("\t").includes(c))) refuse(`the header of ${file}, the known project list, is damaged: its first line must be the column names ${PROJECTS.join(", ")}, separated by tabs. Ask the user to fix that line, or to run ${REBUILD}, which lists the logbook folders that are there now. Each line after the header names one logbook folder that init made.`);
    return rowsOf({ cols: head.split("\t"), lines });
  };
  if (!add && !statSync(root, { throwIfNoEntry: false })?.isDirectory()) return new Set(); // no root, no logbook
  const list = !add && names(); // one read: no gap between a look and the read
  if (list) return new Set(list.map((r) => r.logbook));
  if (readOnly) return undefined;
  if (add) mkdirSync(root, { recursive: true });
  return withLock(root, () => {
    const was = names();
    if (!was && lstatSync(join(root, "projects.made"), { throwIfNoEntry: false }))
      refuse(`${file}, the known project list, is missing, but sage made it before (${join(root, "projects.made")}). Every merge and every init refuses until it is back, because a list made again without the user could take in a forged logbook. Ask the user to restore it from a copy, or to run ${REBUILD} and check each folder that it prints.`);
    const rows = was ?? logbooks(root).filter((name) => name !== add).map((logbook) => ({ at: now(), logbook, how: "migration" }));
    make?.();
    const more = add && !rows.some((r) => r.logbook === add);
    if (more) rows.push({ at: now(), logbook: add, how: "init" });
    if (!was || more) enlist(root, rows);
    return new Set(rows.map((r) => r.logbook));
  });
}

/** The owner's rebuild of the known project list: each logbook folder of the root now, printed so that the owner checks each one. */
function rebuild(root) {
  mkdirSync(root, { recursive: true });
  return withLock(root, () => {
    const names = logbooks(root);
    const file = join(root, "projects.tsv");
    try {
      enlist(root, names.map((logbook) => ({ at: now(), logbook, how: "rebuild" })));
    } catch (e) {
      if (lstatSync(file, { throwIfNoEntry: false })?.isDirectory()) refuse(`${file} is a folder, so the rebuild wrote nothing. Ask the user to remove it, then run the command again.`);
      throw e;
    }
    return [
      `${file}, the known project list, now names the ${names.length} logbook folder${names.length === 1 ? "" : "s"} of ${root}:`,
      ...names.map((n) => `  ${visible(n)}`),
      "Show this listing to the user. A folder that no project of the user's uses may be forged: ask the user to remove it, then run the rebuild again.",
    ].join("\n");
  });
}

/**
 * The judgment of the merge check: may this head SHA merge? Every task that has verdicts on the full SHA, in every
 * project's logbook, must pass on its own rows, also an abandoned one, so no other logbook or task can lend its verdicts.
 * With pr, the tasks of that pull request in those logbooks must pass too, and there must be one. Each task wants the
 * clean cycles of its size and risk (cyclesFor), or cycles when it is given and higher: cycles only raises. The hook calls this, so it
 * never throws: what it cannot read refuses the merge. With readOnly (the board), it takes no lock and writes nothing, so
 * it refuses when the known project list is missing instead of making it. With head (it needs pr), the name of the pull
 * request's head branch on GitHub: each task of that pull request, now or in its PR history, must own it, by its branch=
 * or as a branch of the task (ofTask), so a task cannot lend its verdicts to another task's pull request (F-T273-8).
 * With project, the folder of the project being merged: only a task of its logbook counts as a task of the pull request
 * that may approve the merge. A task of another logbook with verdicts on the SHA must still pass (F-T273-9).
 */
function mergeCheck(sha, env = process.env, { cycles, pr, readOnly, head, project } = {}) {
  const root = sageRoot(env);
  try {
    if (notFull(sha)) return { ok: false, reason: notFull(sha) };
    if (head !== undefined && !pr) return { ok: false, reason: "--head needs --pr: the head branch is the pull request's." };
    if (head === "") return { ok: false, reason: "--head is empty: give the pull request's head branch (F-T273-10)." };
    const mine = project === undefined ? undefined : basename(storeDir(project, env)); // the merged project's logbook
    sha = String(sha).toLowerCase(); // the ledger holds SHAs as git prints them
    pr &&= prNumber(String(pr)); // the tasks table holds it as text; "040" is PR 40
    const cfg = config(env); // once: the merge check may judge thousands of tasks
    const broken = Object.keys(cfg).find((k) => cfg[k] === "invalid"); // fail closed: a default would ask fewer cycles than the owner meant
    if (broken) return { ok: false, reason: `the merge check refuses every merge, because ${broken} in ${join(root, "config.json")} is not a number. Set it with sage config ${broken}=<n> (a whole number from ${floor(broken)} to 10), or remove the key.` };
    const [listed, strangers] = [known(root, undefined, undefined, readOnly), []];
    if (!listed) return { ok: false, reason: `the known project list is missing. This read-only check does not make it: sage merge-check --sha <sha> makes ${join(root, "projects.tsv")} or says how to get it back.` };
    const each = folders(root).flatMap((dir) => {
      // A folder with tasks.tsv, also a link, is a logbook, and it must pass the integrity check. A folder without it is
      // none: init has not finished it, or it lost its tasks. Its verdicts name tasks that it does not have, so they refuse.
      const book = lstatSync(join(dir, "tasks.tsv"), { throwIfNoEntry: false }) && check(dir);
      if (!book && !readRegular(join(dir, "ledger.tsv"))?.trim()) return [];
      const ledger = rowsOf(book ? book.ledger : sheet(dir, "ledger"));
      const rows = ledger.filter((r) => r.sha === sha);
      if (!rows.length) return [];
      if (!listed.has(basename(dir))) return strangers.push(dir), [];
      const [tasks, findings, decisions, runs] = book ? [rowsOf(book.tasks), rowsOf(book.findings), rowsOf(book.decisions), rowsOf(book.runs)] : [[], [], [], []];
      const repaired = decisions.some((d) => d.decision.startsWith("tasks.tsv started again without rows"));
      const ofPr = pr && (mine === undefined || basename(dir) === mine) ? prHistory(pr, tasks, decisions, ledger) : new Set();
      // Each table is grouped by task once, so thousands of tasks on one SHA take linear time, not the square of it.
      const [byId, ownOf, findingsOf, runsOf] = [new Map(tasks.map((t) => [t.id, t])), group(rows), group(findings), group(runs)];
      const checked = [...new Set([...rows.map((r) => r.task), ...ofPr])].map((id) => {
        const [own, task] = [ownOf.get(id) ?? [], byId.get(id)];
        // A held task never merges until the sage moves it (F-T273-12).
        const held = task?.state === "held" && { ok: false, reason: `${id} is held: only the sage moves a held task, and it does not merge until then.` };
        const verdict = judge(dir, task, findingsOf.get(id) ?? [], id, own, task ? Math.max(cycles ?? 0, cyclesFor(task, cfg)) : cycles, repaired, cfg, pr);
        // A review or QA run that still runs may hold a finding that no verdict shows yet (F-T289-18). It refuses a task that
        // would pass, so a refusal still names an open finding first.
        const live = (runsOf.get(id) ?? []).filter((r) => r.status === "running" && CHECKERS.includes(r.role)).map((r) => `${r.id} (${r.role})`);
        const busy = verdict.ok && live.length > 0 && { ok: false, reason: `${id} has a review or QA run that still runs: ${live.join(", ")}. End it with its report's findings recorded, then check again.` };
        return { dir, id, ofPr: ofPr.has(id), owns: task?.branch === head || ofTask(id, String(head)), own: own.length, ...verdict, ...busy, ...held };
      });
      // A task with an unmet wait does not merge. A wait on a task of the same PR is met when that task passes in this merge
      // too, its own waits included: else two tasks of one PR could never merge. The same PR is the PR of --pr for both
      // tasks, or without --pr the same recorded PR number; a task of another PR with verdicts on this SHA meets no wait,
      // and an abandoned or lost task meets none. clear() keeps each task's answer, so the check is linear in the tasks
      // and their waits; a task counts as failing while its answer is open, so a loop of a hand-edited logbook never passes.
      const here = new Map(checked.map((r) => [r.id, r]));
      const samePr = (a, b) => (pr ? !!(here.get(a.id)?.ofPr && here.get(b.id)?.ofPr) : !!a.pr && prNumber(a.pr) === prNumber(b.pr));
      const answers = new Map();
      const clear = (task) => {
        if (answers.has(task.id)) return answers.get(task.id);
        answers.set(task.id, false);
        const ok = here.get(task.id)?.ok === true && !unmetWaits(task, byId, (u) => passes(task, u)).length;
        answers.set(task.id, ok);
        return ok;
      };
      const passes = (waiter, id) => {
        const up = byId.get(id);
        return !!up && !dead(up.state) && samePr(waiter, up) && clear(up);
      };
      // A wait on a task of a PR that the waiting task is not on: name the PR to set, not a new commit (R1140-1).
      // Only a task of this merge check has a PR to name, and only a cell of digits names one (R1155-2, R1154-2).
      const prOf = (up) => (pr ? (here.get(up.id)?.ofPr ? pr : "") : here.has(up.id) && PR.test(prNumber(up.pr)) ? prNumber(up.pr) : "");
      const offPr = (task, open) => {
        const by = new Map();
        for (const { id } of open) {
          const up = id && byId.get(id), n = up && !dead(up.state) && !samePr(task, up) && prOf(up);
          if (n) by.set(n, [...(by.get(n) ?? []), id]);
        }
        return [...by].map(([n, ids]) => ` ${task.id} is not on PR ${n}, so its wait on ${ids.join(", ")} cannot pass in this merge: run sage task ${task.id} set pr=${n}, and record its verdicts with --pr ${n}.`).join("");
      };
      return checked.map((r) => {
        const task = byId.get(r.id), open = task ? unmetWaits(task, byId, (u) => passes(task, u)) : [];
        if (!open.length || task.state === "held") return r;
        return { ...r, ok: false, reason: `${r.id} waits for ${waitList(open)}: it merges after ${open.length === 1 ? "that task is" : "each of them is"} merged or concluded, or passes in this same merge on the same PR.${waitFix(task, open)}${offPr(task, open)}` };
      });
    });
    const one = strangers.length === 1;
    if (strangers.length) return { ok: false, reason: `${strangers.map(visible).join(" and ")} ${one ? "has" : "have"} verdicts on ${sha.slice(0, 7)} but ${one ? "is" : "are"} not in the known project list (${join(root, "projects.tsv")}), so the merge check refuses: a logbook that init did not make may be forged. init adds only a project's own logbook folder, so it does not help here. If ${one ? "it is" : "one is"} a project's logbook under another name (a renamed folder or a link), ask the user to give the folder back its own name, or to run ${REBUILD} and check each folder that it prints. If no project uses ${one ? "it" : "one"}, ask the user to remove it.` };
    if (!each.length) return { ok: false, reason: `no verdicts recorded for ${sha}. Record the reviews and QA with sage verdict first.` };
    if (pr && !each.some((r) => r.ofPr)) return { ok: false, reason: `no task of PR ${pr}${mine === undefined ? "" : ` in this project's logbook (${visible(mine)})`} has verdicts on ${sha.slice(0, 7)}: only ${each.map((r) => `${visible(r.dir)} ${r.id}`).join(", ")} ${each.length === 1 ? "has" : "have"}. Record PR ${pr}'s verdicts under its own task (sage verdict <T> --sha <sha> --pr ${pr}), or set its PR: sage task <T> set pr=${pr}.` };
    // The head branch rule comes after each task's own judgment, so a refusal names a task's missing verdicts first.
    const strays = head === undefined ? [] : each.filter((r) => r.ofPr && !r.owns);
    if (strays.length && each.every((r) => r.ok)) return { ok: false, reason: `PR ${pr}'s head branch ${JSON.stringify(head)} is not a branch of ${strays.map((r) => `${visible(r.dir)} ${r.id}`).join(", ")}, so the merge check refuses: each task that is or was on a pull request must own its head branch, a branch named for the task. Rename the branch to a task name (for example sage/${strays[0].id.toLowerCase()}-<words>), or the user lands this pull request.` };
    if (each.length === 1) return { ok: each[0].ok, reason: each[0].reason };
    const all = `${each.length} tasks have verdicts on ${sha.slice(0, 7)}${pr ? ` or belong to PR ${pr}` : ""}, and each must pass`;
    const bad = each.filter((r) => !r.ok);
    if (!bad.length) return { ok: true, reason: `${all}: ${each.map((r) => `${visible(r.dir)} ${r.reason}`).join("; ")}` };
    const out = bad.some((r) => r.own) ? ", or push a new commit and record its verdicts under the live tasks only" : ""; // a new commit leaves behind only verdicts
    return { ok: false, reason: `${all}; ${bad.length} fail${bad.length === 1 ? "s" : ""}. ${bad.map((r) => `${visible(r.dir)} ${r.reason}`).join(" ")} To merge, make each one pass${out}.` };
  } catch (e) {
    if (e instanceof Refusal) return { ok: false, reason: `the merge check refuses every merge, because ${e.message}` }; // it names the file and what to do
    const [at, why] = [e?.path, e?.code ?? e?.message ?? e];
    if (at === undefined) return { ok: false, reason: `the merge check failed (${why}), so it refuses every merge.` };
    return { ok: false, reason: `the merge check cannot read ${at} (${why}), so it refuses every merge. ${fixIt(at, why, root)}` };
  }
}

/** The status lines. With save, also status.md: only a command that holds the lock saves, so status.md never lags. */
function status(dir, save) {
  const tasks = read(dir, "tasks");
  const runs = read(dir, "runs");
  const gates = read(dir, "gates").filter((g) => !g.answer);
  const count = {};
  for (const t of tasks) count[t.state] = (count[t.state] ?? 0) + 1;
  const tokens = runs.reduce((n, r) => n + (Number(r.tokens) || 0), 0);
  const lines = [
    // The name that the board shows (T305): the display name, the upstream's or origin's repository, the checkout's folder.
    `sage · ${shownName({ name: basename(dir), ...logbookIdentity(dir) })} · ${now().slice(11, 16)} UTC`,
    `tasks   ${tasks.length}${Object.entries(count).map(([s, n]) => ` · ${s} ${n}`).join("")}`,
    `gates   ${gates.length} open${gates.map((g) => ` · ${g.id} ${g.question} (default: ${g.default || "none"})`).join("")}`,
    `agents  ${runs.length} runs · ${runs.filter((r) => r.status === "running").length} running · about ${Math.round(tokens / 1000)}k tokens`,
  ];
  // The open tasks that wait, each with its unmet waits: a line only when one waits.
  const byId = byIds(tasks);
  const waiting = tasks.filter((t) => !["merged", "concluded", "abandoned"].includes(t.state)).map((t) => [t, unmetWaits(t, byId)]).filter(([, open]) => open.length);
  if (waiting.length) lines.push(`waits   ${waiting.length} waiting${waiting.map(([t, open]) => ` · ${t.id} for ${waitList(open)}`).join("")}`);
  const table = ["", "| Task | State | Size | Round | PR | Title |", "| --- | --- | --- | --- | --- | --- |", ...tasks.map((t) => `| ${t.id} | ${t.state} | ${t.size} | ${t.round} | ${t.pr} | ${t.title} |`)];
  if (save) put(join(dir, "status.md"), [`# ${lines[0]}`, "", ...lines.slice(1).map((l) => `    ${l}`), ...table].join("\n") + "\n");
  return lines.join("\n");
}

/**
 * A read-only view of the project's logbook, so that the hook can keep a lead's writes on its own task: its folder
 * (dir), a task's row, the row of a run id (R<n>) or a finding key (F-T<n>-<k>), a task's one running lead run, and the
 * tasks that are or were on a PR. Each lookup gives undefined for an id of another form, an id that the logbook does not
 * have, or an id on two rows; a project without a logbook (no tables with rows, as before init) has no rows. It reads
 * every table once, takes no lock and writes nothing. A logbook that fails the integrity check, also one that lost
 * tasks.tsv but has rows, throws its refusal, which names the file at fault, so a caller fails closed. With max, a table
 * of more than max bytes throws too.
 */
function logbookView(project, env = process.env, { max = Infinity } = {}) {
  const dir = storeDir(project, env);
  const none = !lstatSync(join(dir, "tasks.tsv"), { throwIfNoEntry: false }) && !hasRows(dir, max);
  const tables = Object.fromEntries(Object.entries(none ? {} : check(dir, [], max)).map(([t, sheet]) => [t, rowsOf(sheet)]));
  const rows = (table) => tables[table] ?? [];
  const one = (found) => (found.length === 1 ? found[0] : undefined);
  return {
    dir,
    task: (id) => one(rows("tasks").filter((t) => t.id === id)),
    row(id) {
      const [table, col] = /^R[1-9]\d*$/.test(id) ? ["runs", "id"] : /^F-T[1-9]\d*-[1-9]\d*$/.test(id) ? ["findings", "key"] : [];
      return table ? one(rows(table).filter((r) => r[col] === id)) : undefined;
    },
    leadRun: (task) => one(rows("runs").filter((r) => r.task === task && r.role === "lead" && r.status === "running")),
    findings: (task) => rows("findings").filter((f) => f.task === task),
    /**
     * The row of a finding key now, in any status: its own row, or after finding move (once or more), the row that the
     * moves gave it. A move counts only as the decision that finding move writes: on the key's task, in the form "<key>
     * moved to <task> as <new key on that task>: <summary>", where the summary is the one of the row at the end
     * (F-T289-44, F-T289-49). Undefined when a key on the way is on no row and in no one such move, or on two rows.
     */
    traced(key) {
      const said = [];
      for (let k = key, seen = new Set(); !seen.has(k); ) {
        seen.add(k);
        const now = rows("findings").filter((f) => f.key === k);
        if (now.length) return said.every((s) => s === now[0].summary) ? one(now) : undefined;
        const moves = rows("decisions").filter((d) => d.task === /^F-(T[1-9]\d*)-[1-9]\d*$/.exec(k)?.[1] && subjects(d.decision)[0] === k && /^F-T[1-9]\d*-[1-9]\d*$/.test(subjects(d.decision)[2] ?? ""));
        const [, to, next] = moves.length === 1 ? subjects(moves[0].decision) : [];
        if (!next?.startsWith(`F-${to}-`)) return undefined;
        said.push(moves[0].decision.slice(`${k} moved to ${to} as ${next}: `.length));
        k = next;
      }
      return undefined;
    },
    shas: (task) => new Set(rows("ledger").filter((r) => r.task === task && r.sha).map((r) => r.sha)),
    verdicts: (task) => rows("ledger").filter((r) => r.task === task),
    /** The clean cycles of a task on one SHA, as the merge check counts them: 0 for a task with no review or QA. */
    cleanCycles: (id, sha) => {
      const task = one(rows("tasks").filter((t) => t.id === id)), on = rows("ledger").filter((r) => r.task === id && String(r.sha).toLowerCase() === String(sha).toLowerCase());
      return task && cleanKinds(task).length ? cleanCycles(task, on) : 0;
    },
    endedLeadRuns: () => rows("runs").filter((r) => r.role === "lead" && r.status !== "running"),
    prTasks: (pr) => prHistory(prNumber(pr), rows("tasks"), rows("decisions"), rows("ledger")),
  };
}

/** Refuses a path that holds something other than a regular file, as config writes nothing then. */
function fileOrNone(file) {
  const st = lstatSync(file, { throwIfNoEntry: false });
  if (st && !st.isFile()) refuse(`${file} is ${st.isSymbolicLink() ? "a link" : st.isDirectory() ? "a folder" : st.isFIFO() ? "a named pipe" : st.isSocket() ? "a socket" : "a device"}, not a regular file, so config writes nothing. Replace it with a regular file.`);
}
/** The config keys of one logbook, kept in its own config.json: the others are for all projects. */
const ownKey = (kv) => /^(name|archived)(=|$)/.test(kv);

/**
 * Sets the keys of one logbook in its own config.json: name= (the board's display name of the project; name= alone
 * removes it) and archived=yes or no (the board folds an archived project away). A key of a newer version stays.
 */
function logbookConfig(dir, pairs) {
  const set = {};
  for (const kv of pairs) {
    const at = kv.indexOf("="), k = at < 0 ? kv : kv.slice(0, at), v = at < 0 ? undefined : kv.slice(at + 1);
    if (!ownKey(kv)) refuse(`"${visible(k)}" is a key for all projects, and name= and archived= are keys of one logbook: set them in a config command of their own.`);
    if (v === undefined) refuse(`${k} needs a value: write ${k}=<value>`);
    if (k === "name") {
      const name = v.normalize("NFC"), why = name && nameProblem(name);
      if (why) refuse(`the name "${visible(name)}" ${why}. Nothing changed.`);
      set.name = name || undefined; // name= alone removes it
    } else set.archived = v === "yes" ? true : v === "no" ? undefined : refuse(`archived is yes or no, not "${visible(v)}". Nothing changed.`);
  }
  const file = join(dir, "config.json");
  fileOrNone(file);
  let old;
  try {
    old = JSON.parse(readRegular(file) ?? "{}");
  } catch {}
  if (!old || typeof old !== "object" || Array.isArray(old)) refuse(`${file} is not a JSON object, so config writes nothing. Ask the user to fix or remove it.`);
  const next = { ...old, ...set };
  for (const k of Object.keys(set)) if (set[k] === undefined) delete next[k];
  swap(file, JSON.stringify(next, null, 2) + "\n");
  return `name=${visible(typeof next.name === "string" ? next.name : "")} archived=${next.archived === true ? "yes" : "no"}`;
}

/** Runs one command and returns its output line(s). A refused command throws, with the reason. */
function sage(argv, env = process.env) {
  const [cmd, ...rest] = argv;
  if (!COMMANDS.includes(cmd)) refuse(`unknown command "${cmd ?? ""}". Commands: ${COMMANDS.join(", ")}`);
  const { pos, opt } = parse(cmd, rest);
  const root = sageRoot(env);
  if (cmd === "board" && opt.view !== undefined) {
    if (pos.length > 1 || opt.remember !== undefined) refuse("rich board takes one scope or task id and never remembers state");
    const scope = opt["name-hex"] !== undefined ? unhex(opt["name-hex"]) : /^T[1-9]\d*$/.test(pos[0] ?? "") ? "this" : pos[0] ?? "this";
    let sources;
    try {
      if (env.SAGE_BOARD_ROOTS && Buffer.byteLength(env.SAGE_BOARD_ROOTS) > 65536) throw new Error("root configuration is too large");
      sources = env.SAGE_BOARD_ROOTS ? JSON.parse(env.SAGE_BOARD_ROOTS) : [{ id: "current", label: "Current provider", path: root }];
      return boardView({ sources, scope, project: opt.project ?? env.PWD, taskId: /^T[1-9]\d*$/.test(pos[0] ?? "") ? pos[0] : null, format: opt.view });
    } catch (error) { refuse(error.message); }
  }
  if (statSync(root, { throwIfNoEntry: false })?.isDirectory() && ["projects.tsv", "projects.made"].every((f) => !lstatSync(join(root, f), { throwIfNoEntry: false }))) known(root); // the first command of this version lists today's logbooks
  if (cmd === "projects") return pos.join(" ") === "rebuild" && opt["accept-listing"] === "yes" ? rebuild(root) : refuse(`projects takes only: ${REBUILD.slice(5)}. It lists each logbook folder that is in ${root} now as a known project, so that its verdicts count in the merge check. Run it only when the user asks for it, and show the user the folders that it prints.`);
  if (cmd === "merge-check") {
    const cycles = opt.cycles === undefined ? undefined : (typed("cycles.small", opt.cycles) ?? refuse("--cycles is a whole number from 1 to 10")); // the chief's explicit count: it only raises a task's own count
    if (opt.pr !== undefined && !PR.test(opt.pr)) refuse("--pr is the pull request's number, with no leading zero, for example --pr 5");
    const r = mergeCheck(opt.sha ?? refuse("merge-check needs --sha with the full 40-character SHA of the head commit: git rev-parse <branch>"), env, { cycles, pr: opt.pr, head: opt.head, project: resolve(opt.project ?? env.SAGE_PROJECT ?? process.cwd()) });
    return r.ok ? r.reason : refuse(r.reason);
  }
  if (cmd === "config" && !pos.some(ownKey)) {
    const set = {};
    for (const kv of pos) {
      const [k, v = "", ...more] = kv.split("=");
      if (more.length) refuse(`${JSON.stringify(k)} has more than one "=": write key=value`);
      const count = Object.hasOwn(COUNTS, k) || CAP.test(k);
      if (count && /^[1-9]\d*$/.test(v) && Number(v) > limit(k)) refuse(`${k} must be ${limit(k)} or less: ${v} is above the limit, which keeps a typo from blocking every merge or starting too many agents`);
      if (count && typed(k, v) === undefined) refuse(`${k} must be a whole number of ${floor(k)} or more${/^0+$/.test(v) ? `: with 0, ${COUNTS[k] ?? "no sage agent could start for that project"}` : /^[1-9]\d*$/.test(v) ? `: ${v} is below the floor of ${floor(k)}, which only a code change lowers` : `, not ${JSON.stringify(v)}`}`);
      if (MODEL.test(k) && valid(k, v) === undefined) refuse(`${k} is ${MODELS.length < 2 ? MODELS[0] : `${MODELS.slice(0, -1).join(", ")}, or ${MODELS.at(-1)}`} for the agent's own model; not ${JSON.stringify(v)}`);
      set[k] = (count ? typed(k, v) : valid(k, v)) ?? refuse(`config takes ${KEYS}, and arena_models as a list of ${MODELS.join(", ")}`);
    }
    if (pos.length) {
      const file = join(sageRoot(env), "config.json");
      mkdirSync(sageRoot(env), { recursive: true });
      const st = lstatSync(file, { throwIfNoEntry: false });
      fileOrNone(file);
      swap(file, JSON.stringify({ ...saved(env), ...set }, null, 2) + "\n"); // a key of a newer version stays
    }
    const c = { ...config(env), ...set };
    const models = Object.keys(c).filter((k) => MODEL.test(k));
    return [...Object.keys(c).filter((k) => !models.includes(k)), ...models].map((k) => `${k}=${c[k]}`).join(" "); // the numbers, then the models
  }
  const project = resolve(opt.project ?? env.SAGE_PROJECT ?? process.cwd());
  // The board reads every logbook and takes no lock. --remember no leaves board.json as it is. --name-hex gives the scope
  // as the hex of its UTF-8 bytes, so that the hook's command line holds no text that the owner typed.
  if (cmd === "board") {
    const hex = opt["name-hex"];
    if (pos.length + (hex === undefined ? 0 : 1) > 1 || !["yes", "no", undefined].includes(opt.remember) || (hex !== undefined && unhex(hex) === undefined))
      refuse("board takes one scope (this, all or a project's name, or --name-hex with the name's UTF-8 bytes in hex) and --remember yes or no");
    return board({ scope: hex === undefined ? pos[0] : unhex(hex), project, env, save: opt.remember !== "no" });
  }
  const dir = storeDir(project, env);
  const repair = cmd === "logbook" && pos[0] === "repair";
  const skip = repair ? [...new Set(list(opt["accept-loss"]))] : [];
  const odd = skip.filter((t) => !Object.hasOwn(TABLES, t));
  if (repair && (odd.length || !skip.length)) refuse(`logbook repair needs --accept-loss with the tables whose rows the user accepts to lose, joined by a comma: ${Object.keys(TABLES).join(", ")}.${odd.length ? ` Not ${odd.join(", ")}.` : ""}`);
  if (cmd !== "init" && !(repair && existsSync(dir)) && !existsSync(join(dir, "tasks.tsv"))) {
    const printed = visible(project); // a path with control characters prints otherwise than it is, so it gets no line to paste
    refuse(`no logbook for the project ${printed}. ${printed === project ? `Run: sage init --project ${shell(project)}` : "Its path has control characters, so no command is printed to paste. Rename the folder, or run sage init from inside it."}`);
  }
  // A read takes no lock: every file is replaced whole, so it sees the store before or after a change, never half of one.
  if ((cmd === "logbook" && !repair) || cmd === "status" || (cmd === "standing" && pos[0] !== "add") || (cmd === "pages" && pos[1] !== "record")) return act(cmd, pos, opt, dir, env, [], project);
  const run = () =>
    withLock(dir, () => {
      ready(dir, skip);
      const out = act(cmd, pos, opt, dir, env, skip, project);
      status(dir, true);
      return out;
    });
  if (cmd !== "init") return run();
  // init takes the root's lock and checks the known project list first, so a refusal there makes no logbook.
  let out;
  known(root, basename(dir), () => {
    mkdirSync(join(dir, "briefs"), { recursive: true });
    mkdirSync(join(dir, "reports"), { recursive: true });
    out = run();
  });
  return out;
}

function act(cmd, pos, opt, dir, env, skip, project) {
  const [sub, id, ...more] = pos;
  switch (cmd) {
    case "config":
      return logbookConfig(dir, pos);
    case "init":
      // A new logbook's tables, tasks.tsv last: the merge check takes a folder with it for a whole logbook. An existing
      // logbook passed the integrity check (ready), so init makes no table there.
      for (const t of Object.keys(TABLES).reverse()) if (!existsSync(join(dir, `${t}.tsv`))) write(dir, t, []);
      if (!existsSync(join(dir, "standing.md"))) put(join(dir, "standing.md"), STANDING);
      checkout(dir, project);
      return `logbook ${dir}`;
    case "logbook": {
      if (sub !== "repair") return dir;
      // The user accepts the loss of the rows of each table in skip: its old file goes aside, never away, and the table
      // starts again. The decisions come first, so a write that fails or is stopped leaves no table reset without its
      // decision; a table reset without the others leaves the check failing, so nothing passes before the repair is whole.
      const tables = skip.map((table) => {
        const file = join(dir, `${table}.tsv`);
        try {
          sheet(dir, table);
        } catch {
          const aside = lstatSync(file, { throwIfNoEntry: false }) ? `${file}.lost-${Date.now()}` : "";
          return { table, file, aside, was: aside ? `; its old file is ${aside}` : "" };
        }
        return refuse(`${file} passes the logbook check, so it has nothing to repair. Nothing changed.`);
      });
      const decided = tables.map(({ table, was }) => ({ at: now(), task: "", decision: `${table}.tsv started again without rows${was}`, why: "the user accepts the loss of its rows" }));
      const trail = tables.find((t) => t.table === "decisions");
      if (trail?.aside) renameSync(trail.file, trail.aside);
      write(dir, "decisions", [...(trail ? [] : read(dir, "decisions")), ...decided]);
      for (const { table, file, aside } of tables.filter((t) => t !== trail)) {
        if (aside) renameSync(file, aside);
        write(dir, table, []);
      }
      const kept = tables.filter((t) => t.aside);
      const old = kept.length === 1 ? (tables.length === 1 ? `; its old file is ${kept[0].aside}` : `; the old file of ${kept[0].table}.tsv is ${kept[0].aside}`) : kept.length ? `; the old files are ${kept.map((t) => t.aside).join(" and ")}` : "";
      return `${tables.map((t) => `${t.table}.tsv`).join(" and ")} started again without rows${old}. The decision${tables.length === 1 ? " is" : "s are"} in decisions.tsv.`;
    }
    case "observe": {
      if (pos.length !== 1) refuse("observe takes one task id and explicit observation options");
      const { task } = taskOf(dir, need(sub, "the task id"));
      const file = join(dir, "observations.json"), captured = Date.now();
      let prior, record;
      try {
        const bytes = readRegular(file, { link: false, max: OBSERVATIONS_MAX_BYTES, encoding: null });
        prior = bytes === undefined ? { version: 1, records: [] } : validateObservations(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), { now: captured });
        const encoded = need(opt["data-hex"], "--data-hex");
        if (encoded.length > OBSERVATION_DATA_MAX_BYTES * 2) refuse("observation data exceeds 64 KiB");
        const decoded = unhex(encoded);
        if (decoded === undefined) refuse("--data-hex must be the hex of UTF-8 JSON");
        record = validateObservation({ id: `O${prior.records.length + 1}`, task: task.id, kind: opt.kind, source: opt.source, basis: opt.basis,
          observedAt: opt["observed-at"], recordedAt: new Date(captured).toISOString(), data: JSON.parse(decoded) }, { now: captured });
      } catch (error) {
        if (error instanceof Refusal) throw error;
        refuse(`the observation cannot be recorded: ${error.message}. Nothing changed.`);
      }
      if (record.data.run !== undefined) {
        const run = read(dir, "runs").find(row => row.id === record.data.run) ?? missing(`run ${record.data.run}`, read(dir, "runs").map(row => row.id));
        if (run.task !== task.id) refuse(`${run.id} belongs to ${run.task}, not ${task.id}. Nothing changed.`);
      }
      if (record.kind === "completion" && record.data.state !== task.state) refuse(`${task.id} is ${task.state}, not ${record.data.state}. Nothing changed.`);
      const text = JSON.stringify({ version: 1, records: [...prior.records, record] }, null, 2) + "\n";
      if (Buffer.byteLength(text) > OBSERVATIONS_MAX_BYTES) refuse("the observation file would exceed 4 MiB. Nothing changed.");
      // An explicit observation changes no table or verdict. A reader must never promote it into a merge decision.
      swap(file, text);
      return `${record.id} observed ${record.kind} for ${task.id}`;
    }
    case "standing": {
      if (sub === "add") {
        const text = (readRegular(join(dir, "standing.md")) ?? "").trimEnd();
        const n = (text.match(/^\d+\./gm) ?? []).length + 1;
        put(join(dir, "standing.md"), `${text}\n${n}. ${cell(need([id, ...more].join(" "), "the order's text"))}\n`);
        return `standing order ${n} added`;
      }
      return (readRegular(join(dir, "standing.md")) ?? "").trimEnd();
    }
    case "task": {
      if (sub === "add") {
        const size = need(opt.size, "--size");
        if (!SIZES[size]) refuse(`size is one of ${Object.keys(SIZES).join(", ")}`);
        const risk = list(opt.risk);
        const odd = [...risk.filter((r) => !RISKS.includes(r)), ...list(opt.add).filter((b) => !BLOCKS.includes(b))];
        if (odd.length) refuse(`unknown: ${odd.join(", ")}. Risks: ${RISKS.join(", ")}. Blocks: ${BLOCKS.join(", ")}`);
        if (size === "investigate" && list(opt.add).includes("build")) refuse("an investigation changes no code, so it takes no build block. Frame the build as its own task: sage task add --size tiny, small or large");
        const why = opt.add ? need(opt.why, "--why for the added blocks") : ""; // refuse before anything is written
        const tags = Object.fromEntries(["priority", "kind"].filter((k) => opt[k] !== undefined).map((k) => [k, tag(k, opt[k])]));
        if (opt.waits !== undefined) tags.waits = waitsValue({ id: nextId(dir, "T") }, opt.waits, read(dir, "tasks"));
        const task = frame(dir, need(opt.title, "--title"), size, risk, list(opt.add), tags);
        checkout(dir, project);
        const at = now(), decided = [...(opt.add ? [{ at, task: task.id, decision: `added ${opt.add}`, why }] : []), ...waitsDecision(task, "", at, "task add")];
        if (decided.length) write(dir, "decisions", [...read(dir, "decisions"), ...decided]);
        return framed(task);
      }
      const { tasks, task } = taskOf(dir, need(sub, "the task id")); // task <T> [set key=value ...]
      if (id === "set") {
        const before = { tasks, runs: read(dir, "runs"), decisions: read(dir, "decisions") };
        const planned = planTaskChanges(before, task.id, more, now(), { findings: read(dir, "findings"), ledger: read(dir, "ledger") });
        if (JSON.stringify(planned.decisions) !== JSON.stringify(before.decisions)) write(dir, "decisions", planned.decisions);
        if (JSON.stringify(planned.runs) !== JSON.stringify(before.runs)) write(dir, "runs", planned.runs);
        write(dir, "tasks", planned.tasks);
        Object.assign(task, planned.task);
      }
      return `${task.id} ${task.state} · ${task.size} · round ${task.round} · route ${task.route}${task.branch ? ` · ${task.branch}` : ""}${task.pr ? ` · PR ${task.pr}` : ""}${tagsOf(task)}${waitsText(task, tasks)}`;
    }
    case "round": {
      const { tasks, task } = taskOf(dir, need(sub, "the task id"));
      if (!["reviewing", "verifying"].includes(task.state)) refuse(`${task.id} is ${task.state}. A repair starts from reviewing or verifying.`);
      const fix = read(dir, "findings").filter((f) => f.task === task.id && f.status === "open" && f.triage === "fix");
      const keys = fix.map((f) => f.key).sort().join(",");
      if (!keys) refuse(`${task.id} has no open findings marked fix`);
      if (fix.every((f) => f.severity === "low")) refuse(`${task.id}: only low findings are marked fix (${keys}). A repair round needs a medium or high finding. Dismiss the low ones with a reason, or let them join the next round.`);
      const round = Number(task.round) + 1;
      const limit = config(env).max_rounds + extraOf(task); // the extra rounds of earlier holds by round (F-T284-14)
      if (round > limit) {
        Object.assign(task, { state: "held", hold: "round" });
        write(dir, "tasks", tasks);
        return `${task.id} held: ${round - 1} repair rounds did not make it clean. Stop and ask the user.`;
      }
      // A round that fixed none of the last round's findings re-plans: also when new ones join them, and on the retry after
      // a hold, whose last round's findings are still open (F-T284-17, option a).
      const last = roundKeys(task);
      if (last.length && last.every((k) => keys.split(",").includes(k))) {
        task.state = "replan";
        write(dir, "tasks", tasks);
        return `${task.id} replan: round ${round - 1} did not fix ${task.keys}. Attack the premise, then brief again.`;
      }
      Object.assign(task, { state: "repairing", round, keys });
      write(dir, "tasks", tasks);
      const roles = [...new Set(fix.map((f) => f.source))].sort().join(","); // the repair's diff goes back to the roles that found the problems
      return `${task.id} repairing · round ${round} of ${limit} · fix ${keys} · re-run ${roles} on the repair's diff`;
    }
    case "run": {
      const runs = read(dir, "runs");
      if (sub === "add") {
        const { task } = taskOf(dir, need(id, "the task id"));
        notHeld(task, "run add");
        // The role as the table stores it, in lower case, so that every check below sees the stored value ("Lead " is lead).
        const role = cell(need(opt.role, "--role")).toLowerCase();
        const branch = opt.branch === undefined ? "" : branchOf(opt.branch);
        const candidate = opt.candidate ?? "";
        const run = runFrame(dir, task, role, branch, candidate, env);
        write(dir, "runs", [...runs, run]);
        return `${run.id} running · ${role} on ${task.id}${branch ? ` · ${branch}` : ""}${candidate ? ` · candidate ${candidate}` : ""}${run.model ? ` · model ${run.model}` : ""}`;
      }
      if (sub === "done") {
        const run = runs.find((r) => r.id === id) ?? missing(`run ${id}`, runs.map((r) => r.id));
        const st = need(opt.status, "--status");
        if (!["done", "blocked", "question", "failed"].includes(st)) refuse("status is done, blocked, question or failed");
        Object.assign(run, { status: st, tokens: opt.tokens ?? run.tokens, report: opt.report ?? run.report, ended: now() });
        write(dir, "runs", runs);
        return `${run.id} ${st}`;
      }
      refuse("run add or run done");
    }
    case "finding": {
      const findings = read(dir, "findings");
      if (sub === "add") {
        const { task } = taskOf(dir, need(id, "the task id"));
        notHeld(task, "finding add");
        const severity = need(opt.severity, "--severity");
        if (!["high", "medium", "low"].includes(severity)) refuse("severity is high, medium or low");
        const key = cell(opt.key) || nextId(dir, `F-${task.id}-`); // as the table holds it, so the same --key finds its finding again
        const again = findings.find((f) => f.task === task.id && f.key === key);
        // Without --summary, a known key keeps its summary. An empty one is refused, so no summary is ever lost.
        const summary = opt.summary === undefined ? again?.summary : cell(opt.summary) || refuse(`${key} on ${task.id}: --summary is empty. Give the finding in a few words${again ? ", or leave out --summary to keep its summary" : ""}.`);
        if (again && summary !== again.summary) write(dir, "decisions", [...read(dir, "decisions"), { at: now(), task: task.id, decision: `${key} opened again: ${summary}`, why: `the summary before: ${again.summary}` }]);
        if (again) Object.assign(again, { status: "open", triage: "", round: task.round, severity, source: opt.source ?? again.source, summary }); // it came back
        else findings.push({ task: task.id, key, round: task.round, source: need(opt.source, "--source"), severity, summary: need(summary, "--summary"), status: "open" });
        write(dir, "findings", findings);
        return `${key} open${again ? " again" : ""} · ${severity} · ${task.id}`;
      }
      const f = findings.find((x) => x.task === id && x.key === more[0]) ?? missing(`finding ${more[0]} on ${id}`, findings.filter((x) => x.task === id).map((x) => x.key));
      // While held, the sage may still triage ask, or dismiss with a reason (F-T284-1); a fix or a close waits.
      if (sub === "close" || (sub === "triage" && more[1] === "fix")) notHeld(taskOf(dir, id).task, sub === "close" ? "finding close" : "fix triage");
      if (sub === "triage") {
        const t = need(more[1], "fix, dismiss or ask");
        if (!["fix", "dismiss", "ask"].includes(t)) refuse("triage is fix, dismiss or ask");
        // A low fix key of the round joins the next round while a medium or high finding of the task is open, in any
        // triage and any state, so it is not dismissed then (F-T301-59, F-T301-66).
        const big = t === "dismiss" && f.status === "open" && f.severity === "low" && roundKeys(taskOf(dir, id).task).includes(f.key)
          ? findings.filter((g) => g.task === id && g.status === "open" && g.severity !== "low").map((g) => g.key) : [];
        if (big.length) refuse(`${f.key} is a low fix of ${id}'s current round, and ${big.join(", ")} is open: ${f.key} joins the next round with it, so it is not dismissed now.`);
        if (t === "dismiss") Object.assign(f, { reason: need(opt.reason, "--reason for a dismissal"), status: "dismissed" });
        f.triage = t;
      } else if (sub === "close") {
        if (f.triage !== "fix" && f.triage !== "ask") refuse(`${f.key} is not triaged as fix or ask`);
        f.status = "closed";
      } else if (sub === "move") {
        // A new medium finding of a repair round goes to a follow-up task, not to another round. A high one blocks until it is fixed.
        if (f.status !== "open") refuse(`${f.key} is ${f.status}: only an open finding moves.`);
        if (f.severity === "high") refuse(`${f.key} is high, so it blocks ${id} until it is fixed: a high finding never moves to a follow-up task.`);
        // A fix key of the round stays on its task, at any severity and in any state (F-T301-40), until the owner answers a
        // gate of the task that names the key with the gate's first option (F-T301-65).
        if (roundKeys(taskOf(dir, id).task).includes(f.key) && !read(dir, "gates").some((g) => g.task === id && g.question.split(/[^\w-]+/).includes(f.key) && g.answer && g.answer === optionsOf(g)[0])) {
          refuse(`${f.key} is a fix of ${id}'s current round, so it stays on ${id}: it is fixed in a round, or dismissed with a reason. It moves to a follow-up task only after the owner chose the first option of a gate of ${id} whose question names ${f.key}: sage gate add ${id} --question "Move ${f.key} to a follow-up task?" --options "move|keep" --recommend <move or keep>.`);
        }
        const title = need(cell(opt.to), '--to "<the follow-up task\'s title>"');
        const size = opt.size ?? "small";
        if (!SIZES[size] || size === "investigate") refuse("--size is tiny, small or large");
        const to = frame(dir, title, size, [], []);
        const was = f.key;
        Object.assign(f, { task: to.id, key: nextId(dir, `F-${to.id}-`), round: 0, triage: "" });
        write(dir, "findings", findings);
        write(dir, "decisions", [...read(dir, "decisions"), { at: now(), task: id, decision: `${was} moved to ${to.id} as ${f.key}: ${f.summary}`, why: `the follow-up task: ${title}` }]);
        return `${was} moved to ${to.id} as ${f.key} · ${framed(to)}`;
      } else refuse("finding add, triage, close or move");
      write(dir, "findings", findings);
      return `${f.key} ${f.status} · ${f.triage}`;
    }
    case "verdict": {
      const { tasks, task } = taskOf(dir, need(sub, "the task id"));
      notHeld(task, "verdict");
      const kind = need(opt.kind, "--kind");
      if (!KINDS.includes(kind)) refuse(`kind is one of ${KINDS.join(", ")}`);
      // The clean rule: a cycle is clean when no medium or high finding is open. Low ones are fixed, moved or dismissed
      // before a merge, and an open one blocks it. So a problem verdict needs an open finding that is not low.
      const findings = read(dir, "findings").filter((f) => f.task === task.id && f.status === "open");
      // The refusal names the finding first: a chief that recorded the verdict before its finding must not hide the finding.
      if (FOUND.includes(kind) && findings.every((f) => f.severity === "low")) {
        const reviews = CLEAN.filter((k) => k !== "qa-pass"); // the clean verdicts of the blocks that give findings
        const fits = kind === "qa-fail" ? ["qa-pass"] : reviews.filter((k) => list(task.route).some((b) => VERDICT[b] === k));
        const clean = fits.length === 1 ? fits[0] : `this review's clean verdict (${(fits.length ? fits : reviews).join(", ")})`;
        refuse(`${task.id} has no open medium or high finding, so ${kind} is refused. If this review found a medium or high problem, record it first: sage finding add ${task.id} --source <role> --severity <medium or high> --summary "<the problem>", then ${kind} again. If it found only low ones, its cycle is clean: record ${clean}, and fix, move or dismiss each low finding before the merge.`);
      }
      // A route without build has no commit to judge. Its rows have no SHA, so the merge check never reads them.
      if (builds(task) && !opt.sha) refuse(`${task.id} has a build block, so each verdict names its commit: add --sha with the full 40-character SHA (git rev-parse <branch>)`);
      if (!builds(task) && opt.sha) refuse(`${task.id} has no build block, so its verdicts name no commit: leave out --sha`);
      if (opt.sha && notFull(opt.sha)) refuse(notFull(opt.sha));
      // A run backs one review or QA verdict of its task (F-T289-2): the hook's own check and this write can race. A check
      // verdict needs no run, so the chief may still name a run on checks-pass beside its review or QA verdict.
      const check = (k) => k.startsWith("checks-");
      const backed = opt.run && !check(kind) && read(dir, "ledger").find((r) => r.task === task.id && r.run === opt.run && !check(r.kind));
      if (backed) refuse(`${opt.run} already backs the ${backed.kind} verdict of ${task.id} on ${backed.sha.slice(0, 7) || "its task"}: one run backs one review or QA verdict. Run the review again under a new run.`);
      const sha = opt.sha?.toLowerCase() ?? ""; // as git prints it
      const decided = opt.pr ? setPr(task, opt.pr, "verdict --pr") : [];
      const beforeReview = task.state;
      const backToReview = ["verified", "pr-ready"].includes(beforeReview) && NOT_CLEAN.includes(kind);
      if (backToReview) {
        move(task, "reviewing");
        decided.push({ at: now(), task: task.id, decision: `${beforeReview} → reviewing`, why: `${kind} verdict on ${sha}` });
      }
      if (decided.length) write(dir, "decisions", [...read(dir, "decisions"), ...decided]);
      write(dir, "tasks", tasks);
      write(dir, "ledger", [...read(dir, "ledger"), { task: task.id, pr: task.pr, sha, kind, cycle: opt.cycle ?? "1", run: opt.run ?? "", at: now() }]);
      const open = NOT_CLEAN.includes(kind) ? [] : findings.filter((f) => f.triage === "fix");
      return `${task.id} ${kind}${sha ? ` · ${sha.slice(0, 7)}` : ""} · cycle ${opt.cycle ?? "1"}${backToReview ? " · reviewing" : ""}${open.length ? ` · still open: ${open.map((f) => f.key).join(", ")}. Close the ones that this review confirmed fixed.` : ""}`;
    }
    case "gate": {
      const gates = read(dir, "gates");
      if (sub === "add") {
        // The owner tells options apart by eye, and the recommendation and the default are two of them: options that
        // look the same (case, width or hidden characters) are refused, and so is an option that reads as an own answer.
        const options = optionsOf({ options: cell(need(opt.options, "--options")) });
        const twin = options.find((o, i) => options.findIndex((x) => looks(x) === looks(o)) !== i);
        if (twin !== undefined) refuse(`two options look the same: ${JSON.stringify(twin)} and ${JSON.stringify(options.find((x) => looks(x) === looks(twin)))}. Make them differ in more than case.`);
        if (options.some((o) => /^other ?:/.test(looks(o)))) refuse(`an option may not start with "other:": it marks an answer in the owner's own words.`);
        const pick = (v, what) => options.find((o) => o === v.trim()) ?? options.find((o) => looks(o) === looks(v)) ?? (/^[1-9]\d*$/.test(v.trim()) ? options[Number(v) - 1] : undefined) ?? refuse(`${what} is one of the options, by its text or its number (1 to ${options.length}): ${options.map((o) => JSON.stringify(o)).join(", ")}.`);
        const recommendation = pick(need(opt.recommend, "--recommend"), "--recommend");
        const g = { id: nextId(dir, "G"), task: id ?? "", question: need(opt.question, "--question"), options: opt.options, recommendation, default: opt.default === undefined ? "" : pick(opt.default, "--default"), at: now() };
        write(dir, "gates", [...gates, g]);
        return `${g.id} open · ${g.question}`;
      }
      if (sub === "answer") {
        const g = gates.find((x) => x.id === id) ?? missing(`gate ${id}`, gates.map((x) => x.id));
        // By number only, as the board numbers the options: no agent-written text goes into the command. The owner's own
        // words come as the hex of their UTF-8 bytes, so no text of theirs is in the command either, and are kept with
        // "other: " before them, so they never pass for one of the options.
        const options = optionsOf(g);
        const how = `gate answer ${g.id} takes --option <n>, the number of one of its options (1 to ${options.length}), or --other-hex <hex>, the owner's own words as the hex of their UTF-8 bytes (0-9 and a-f). Nothing changed.`;
        const own = opt["other-hex"];
        if (more.length || (opt.option === undefined) === (own === undefined) || (own !== undefined && unhex(own) === undefined)) refuse(how);
        if (own !== undefined) g.answer = `other: ${need(cell(unhex(own)), "the owner's own words: --other-hex gives only spaces")}`;
        else g.answer = (/^[1-9]\d*$/.test(opt.option) && options[Number(opt.option) - 1]) || refuse(how);
        write(dir, "gates", gates);
        write(dir, "decisions", [...read(dir, "decisions"), { at: now(), task: g.task, decision: `${g.question} → ${g.answer}`, why: own === undefined ? "the user's answer" : "the user's own words" }]);
        return `${g.id} answered · ${g.answer}`;
      }
      refuse("gate add or gate answer");
    }
    case "log": {
      write(dir, "decisions", [...read(dir, "decisions"), { at: now(), task: sub === "-" ? "" : sub, decision: need(id, "the decision"), why: need(opt.why, "--why") }]);
      return "logged";
    }
    case "status":
      return status(dir);
    case "pages": {
      // pages <T> makes the task's pages folder (mode 700) and prints it. pages <T> record <file> logs a page in it, with its sha256.
      const folder = pagesDir(project, taskOf(dir, need(sub, "the task id")).task.id, env);
      mkdirSync(folder, { recursive: true, mode: 0o700 });
      if (id === undefined) return folder;
      if (id !== "record" || more.length !== 1) refuse(`pages takes <task>, or <task> record <file>`);
      if (/\p{Cc}/u.test(more[0])) refuse(`${JSON.stringify(more[0])} has a control character (a tab, a line break or another): give the page a name without one.`);
      // The page must be inside the folder (by its real path, where its folder exists) before it must exist.
      const path = resolve(more[0]);
      const file = existsSync(dirname(path)) ? join(realpathSync(dirname(path)), basename(path)) : path;
      if (![folder, realpathSync(folder)].some((f) => file.startsWith(`${f}/`))) refuse(`${file} is not a file in ${folder}. Save the page there first.`);
      // The page is the regular file itself: one open that follows no link and never waits, and at most PAGE_MAX bytes.
      let bytes;
      try {
        bytes = readRegular(file, { link: false, max: PAGE_MAX, encoding: null });
      } catch (e) {
        if (!(e instanceof Refusal)) throw e;
        refuse(`${file} is not a page that pages record takes: it takes only a regular file of at most 16 MiB, not a link, a named pipe, a folder or a device. Save the page itself in ${folder}.`);
      }
      if (bytes === undefined) refuse(`${file} does not exist. Save the page in ${folder} first.`);
      const sha = createHash("sha256").update(bytes).digest("hex");
      write(dir, "decisions", [...read(dir, "decisions"), { at: now(), task: sub, decision: `page ${file} sha256 ${sha}`, why: "the chief recorded a page" }]);
      return `page ${file} · sha256 ${sha}`;
    }
  }
}

/**
 * The store's lock. The folder <store>/.lock holds one owner file, <token>.json, with the holder's pid, host, boot time
 * and start time. A process makes the folder with its owner file under a temporary name, then renames it to .lock. The
 * rename is atomic and fails while .lock holds a file, so the lock never exists without its owner. A waiter removes
 * the lock only when its holder is surely gone, and only by the holder's own file name and an rmdir that works only
 * on an empty folder, so it can never remove a newer holder. After LOCK_WAIT_MS it refuses. The hooks read without
 * the lock, so they never wait for it.
 */
const LOCK_WAIT_MS = 3000;
const START = Date.now() - process.uptime() * 1000;
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * The owner of a lock folder (.lock, or a waiter's temp folder), with its file name from the folder, never from the
 * record. Undefined when the folder is gone or is not a real folder, or does not hold exactly one regular <uuid>.json
 * file: nobody removes such a lock but a person.
 */
function holder(folder) {
  try {
    const names = lstatSync(folder).isDirectory() ? readdirSync(folder) : [];
    if (names.length !== 1 || !new RegExp(`^${UUID}\\.json$`).test(names[0])) return undefined;
    return { ...JSON.parse(readRegular(join(folder, names[0]))), file: names[0] };
  } catch {
    return undefined; // released between the reads, or not an owner record
  }
}

/**
 * How the lock asks about a process on this machine: is the pid alive, and when did it start (ms, NaN when unknown).
 * It asks for one pid only (kill 0 and ps -p), never for the process list.
 */
const realProbe = {
  alive(pid) {
    try {
      return process.kill(pid, 0);
    } catch (e) {
      return e.code !== "ESRCH";
    }
  },
  started(pid) {
    try {
      return Date.parse(execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" }, stdio: ["ignore", "pipe", "ignore"] }).trim());
    } catch {
      return NaN;
    }
  },
};

/**
 * The probe for the lock in dir. In a node test run (NODE_TEST_CONTEXT), on a logbook in the temp folder, SAGE_TEST_PIDS,
 * a JSON map of pid to start time (null for a dead pid; a pid not in it is alive, start unknown), replaces the real one,
 * so that no test reads or signals a real process. Anywhere else the variable is ignored, so it cannot weaken a real lock.
 */
function probeFor(dir) {
  const pids = process.env.SAGE_TEST_PIDS;
  if (!pids || !process.env.NODE_TEST_CONTEXT) return realProbe;
  try {
    if (!realpathSync(dir).startsWith(realpathSync(tmpdir()) + sep)) return realProbe;
  } catch {
    return realProbe;
  }
  let map;
  try {
    map = JSON.parse(pids);
  } catch {}
  if (!map || typeof map !== "object" || Array.isArray(map)) refuse(`SAGE_TEST_PIDS is not a JSON object of pid to start time or null: ${pids}`);
  return { alive: (pid) => map[pid] !== null, started: (pid) => map[pid] ?? NaN };
}

/**
 * This machine's boot time (ms), or null when the system does not tell it: in the macOS sandbox, uptime() throws EPERM.
 * It is read only when a command takes the lock, so that no other command depends on it.
 */
function bootTime() {
  try {
    return Date.now() - uptime() * 1000;
  } catch {
    return null;
  }
}

/**
 * True only when the holder is surely gone: an earlier boot of this machine, no process under its pid, or a newer one.
 * Stable identities distinguish machines despite changed or shared hostnames. Only legacy records use the hostname.
 * On the same machine, an unknown boot time leaves only the pid and its start time to decide.
 */
function gone(h, boot, checkStart, probe, machineId) {
  if (Object.hasOwn(h, "machineId")) {
    if (!machineId || h.machineId !== machineId) return false;
  } else if (h.host !== hostname()) return false;
  if (Number.isFinite(h.boot) && Number.isFinite(boot) && Math.abs(h.boot - boot) > 60_000) return true;
  if (!probe.alive(h.pid)) return true;
  return checkStart && probe.started(h.pid) > h.start + 2000; // the pid now names a process that started after the holder
}

/** Removes a lock folder by its owner file's name, then the folder, which must then be empty. False if either fails. */
function clear(folder, file) {
  try {
    unlinkSync(join(folder, file));
    rmdirSync(folder);
    return true;
  } catch {
    return false;
  }
}

/** A stable machine identity; an unavailable identity never clears a holder that has one. */
function machineIdentity(dir) {
  if (process.env.NODE_TEST_CONTEXT) {
    // Every test uses an injected identity, never the real hardware or machine-id file.
    try {
      if (!realpathSync(dir).startsWith(realpathSync(tmpdir()) + sep)) return null;
    } catch { return null; }
    return /^[A-Za-z0-9-]{1,128}$/.test(process.env.SAGE_TEST_MACHINE_ID ?? "") ? process.env.SAGE_TEST_MACHINE_ID : null;
  }
  // An explicit test identity outside its allowed scope is unavailable, never a hardware query.
  if (Object.hasOwn(process.env, "SAGE_TEST_MACHINE_ID")) return null;
  try {
    if (platform() === "linux") {
      const id = readFileSync("/etc/machine-id", "utf8").trim();
      return /^[a-fA-F0-9]{32}$/.test(id) ? id.toLowerCase() : null;
    }
    if (platform() === "darwin") {
      // A hardware query, never a process-list query. Bound a stalled system command.
      const text = execFileSync("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], {
        encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "ignore"],
      });
      return /"IOPlatformUUID"\s*=\s*"([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})"/.exec(text)?.[1]?.toLowerCase() ?? null;
    }
  } catch { /* Keep the legacy host rule only for legacy holders. */ }
  return null;
}

/** Runs fn while this process holds the store's lock. Refuses, with nothing changed, when the store stays busy. */
function withLock(dir, fn) {
  const probe = probeFor(dir);
  const boot = bootTime();
  const machineId = machineIdentity(dir);
  const lock = join(dir, ".lock");
  const token = randomUUID();
  const tmp = `${lock}.${token}`;
  mkdirSync(tmp);
  // A new unavailable identity is explicit; only old records use the hostname fallback.
  // An unknown boot time has no key: an older sage reads boot: null as 0, an earlier boot, and would clear a live lock.
  writeFileSync(join(tmp, `${token}.json`), JSON.stringify({ pid: process.pid, host: hostname(), machineId, ...(boot === null ? {} : { boot }), start: START, at: Date.now() }));
  const t0 = Date.now();
  for (let checked = ""; ; ) {
    try {
      renameSync(tmp, lock);
      break;
    } catch (e) {
      if (!["ENOTEMPTY", "EEXIST", "ENOTDIR"].includes(e.code)) {
        rmSync(tmp, { recursive: true, force: true });
        throw e;
      }
    }
    const h = holder(lock);
    const waited = Date.now() - t0;
    const checkStart = h && waited > 500 && checked !== h.file; // ps once per holder, and only for a slow one
    if (checkStart) checked = h.file;
    if (h && gone(h, boot, checkStart, probe, machineId) && clear(lock, h.file)) continue; // if clear fails, another waiter was first
    if (waited >= LOCK_WAIT_MS) {
      rmSync(tmp, { recursive: true, force: true });
      const who = h ? `pid ${cell(h.pid)} on ${cell(h.host)} has held ${lock}${Number.isFinite(h.at) ? ` for ${((Date.now() - h.at) / 1000).toFixed(1)} s` : ""}` : `${lock} has no valid owner file`;
      refuse(`the logbook is busy: ${who}. Nothing changed. Run the command again; if no sage command runs${h ? ` on ${cell(h.host)}` : ""}, remove ${lock} first.`);
    }
    pause(5 + Math.floor(Math.random() * 20));
  }
  try {
    // The temp folder of a waiter that was killed stays behind. Remove it by the lock's rules: owner surely gone, by name.
    for (const name of readdirSync(dir).filter((n) => new RegExp(`^\\.lock\\.${UUID}$`).test(n))) {
      const h = holder(join(dir, name));
      if (h && gone(h, boot, false, probe, machineId)) clear(join(dir, name), h.file);
    }
    return fn();
  } finally {
    clear(lock, `${token}.json`);
  }
}

/** The text that the tool prints: its lines, each with its control characters shown as \xNN. Ids, columns and paths come from files and the user. */
const shown = (text) => text.split("\n").map(visible).join("\n");
/** The standing orders as a person wrote them, for briefs to copy word for word: tabs stay, a CRLF or CR line end prints as a plain one, and no hidden character stays. */
const orders = (text) => text.replace(/\r\n?/g, "\n").replace(HIDDEN, "");

function runCli(argv = process.argv.slice(2)) {
  try {
    console.log((argv[0] === "standing" ? orders : shown)(sage(argv)));
  } catch (err) {
    console.error(`sage: ${shown(err instanceof Refusal ? err.message : err.stack)}`);
    process.exit(err instanceof Refusal ? 1 : 2);
  }
}

const { board, answerPaths } = createBoard({ BLOCKS, BRANCH, RISKS, STATES, mergeCheck, optionsOf, projectName, projectRoot, read, sageRoot, slug, storeDir, withLock });
return { SIZES, BLOCKS, RISKS, KINDS, STATES, DEFAULTS, PR, sageRoot, git, projectRoot, optionsOf, slug, worktreeRoot, BRANCH, ofTask, projectName, storeDir, config, cyclesFor, modelFor, read, mergeCheck, logbookView, sage, readTaskSnapshot, updateRequestedTask, assertTaskUpdateOpen, createRequestedTask, createRequestedRun, finishReportedRun, finishInterruptedRun, acceptReportedReview, captureRunAssignment, captureReviewTarget, validateTerminalAssignment, withLock, board, answerPaths, runCli };
}
