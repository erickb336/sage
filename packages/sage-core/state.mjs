#!/usr/bin/env node
import { USAGE_FIELDS, tokenCount, usageText, usageRegistry, usageSnapshot, validUsageSnapshot, usageSummary } from "./usage.mjs";
import { readLocalGit } from "./local-git.mjs";
import { PENDING, recordedWrites, assertNoPendingWrite, hasPendingWrite, pendingRequest, pendingNames, settlePendingWrite, verifyPendingWrite, RecordedWriteError } from "./recorded-write.mjs";
// sage: the state tool of sage mode. The chief of staff calls it through the shell: one command in, one line out.
// The store is plain TSV and Markdown under the configured root ($SAGE_HOME overrides it), and every
// table has one writer: this tool. It holds the rules that prompts alone did not hold in Orchestrator: no dropped
// findings, bounded repair rounds, one writer per branch, and a merge only of a head SHA with the clean cycles that
// its route needs. The sage hook calls mergeCheck before any `gh pr merge` in sage mode.
// Several chief sessions may share one store: each command that changes it holds the store's lock (withLock). They may
// run two versions of this tool, so a command refuses to change a logbook that a newer version wrote (ready).
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fchmodSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, rmSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, hostname, platform, tmpdir, uptime } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { boardView, sessionRoots, sessionSources } from "./board-view.mjs";
import { projectName as shownName } from "./board-model.mjs";
import { agentCaps } from "./logbook-fields.mjs";
import { logbookIdentity } from "./board-reader.mjs";
import { PR, pullRequestHead } from "./pull-request.mjs";
import { REPORT_FIELDS } from "./report.mjs";
import { cleanReport, fieldsOf, proofResults, readReport } from "./report-reader.mjs";
import { ROLES } from "./roles.mjs";
import { AGENT_CAPS, BREAKS, FINDING_CLASSES, HIDDEN, LINE, NAME_MAX, PRIORITIES, PRIORITY_SCALE, START_SAGE_MODE, TABLES as PLAIN_TABLES, TASK_KINDS, breakdownLine, countOf, nameProblem, proposalOf } from "./logbook-fields.mjs";
import { BREAKDOWN, ENDED, GATE_ID, MET, MILESTONE_ID, TASK_ID, breakdownGate, renameRows, renamedIds, byIds, dead, droppedBy, gateLines, lostClause, milestoneState, milestoneWordOf, progressOf, progressText, releaseKey, releaseNameProblem, releasesOf, shownGraph, shownMilestoneState, shownWaits, unmetWaits, waitGraph, waitWords, waitsOf, waitsWithState } from "./milestone-rules.mjs";
import { OBSERVATIONS_MAX_BYTES, OBSERVATION_DATA_MAX_BYTES, validateObservation, validateObservations } from "./observations.mjs";
import { MOVES, PLAN_MAX, checkoutGone, createSharedRoot, sharedRoot, unreadableFolder } from "./shared-root.mjs";
import { changedText, countsOf, endText, gateQuestion, gateText, localTime, mapHtml, mismatchText, previewText, providersOf, reconciliationText, startText, stepText, stoppedText, title } from "./move-text.mjs";
import { worktreeRoot, worktrees } from "./worktrees.mjs";
import { CHIEF, TAKEOVER_OPTIONS, chiefOnly, createChiefs, crossed, offerOf, replaceOf, replaceQuestion, writerClass } from "./chiefs.mjs";
import { LEAD_COMMANDS, leadProblem as leadPolicy, leadRequest } from "./lead-policy.mjs";

/** The one line for a saved change that cannot finish: the settle step refuses with it, and `sage logbook repair` is its way out. */
export const STUCK_WRITE = 'This command changed nothing. This project cannot save changes; other projects work. Tell the owner. There are two ways out. With a backup: the owner restores the folder that `sage logbook` prints; rows newer than the backup are lost. With no backup: after the owner accepts the loss of this saved change, the chief runs `sage logbook repair --accept-change-loss yes --project <the project>`, or the owner runs it in a terminal when the chief cannot; it keeps the file, and a half-published update keeps mixed tables. Do not remove review-pending.json by hand.';

/** The roles that a model key names (MODEL). */
const MODEL_ROLES = ["pe", "designer", "implementer", "code-reviewer", "security-reviewer", "ux-reviewer", "qa", "arena-judge"];

/**
 * The Balanced defaults of the model keys, for a provider's strong and light model: the light one for UX review, QA of
 * tiny and small tasks, and code review and implementation of tiny tasks; the strong one for every other role.
 */
export const balancedModels = (strong, light) => ({
  ...Object.fromEntries(MODEL_ROLES.map((role) => [`model.${role}`, role === "ux-reviewer" ? light : strong])),
  "model.implementer.tiny": light, "model.code-reviewer.tiny": light, "model.qa.tiny": light, "model.qa.small": light,
});

export function createStateTool({ defaultRoot, legacyRoots: namedRoots = () => [], provider, models = ["inherit"], modelDefaults = {}, spawnFields = (model) => (model ? { model } : {}), usageInterfaces = [], claimStep = (task, version, chief) => `run sage claim ${task} --version ${version} --chief ${chief}`, replaceStep = (task, chief) => `run sage gate replace ${task} --to ${chief} --chief ${chief}`, takeoverCycle, autopilot = () => false }) {
if (typeof defaultRoot !== "function") throw new TypeError("defaultRoot must be a function");
if (typeof namedRoots !== "function") throw new TypeError("legacyRoots must be a function");
/**
 * Each provider's legacy logbook root, as the adapter names it: { provider, path }, or a bare path, whose provider is
 * unknown (null). The move needs the name of each old root; every other reader takes only the paths.
 */
const rootsOf = (env) => namedRoots(env).map((root) => {
  if (typeof root === "string") return { provider: null, path: root };
  if (typeof root?.path !== "string") refuse(`The plugin's legacyRoots gave ${JSON.stringify(root) ?? String(root)}, but each root must be a path or { provider, path } with a path. Nothing changed. Update the sage plugin.`);
  return { provider: root.provider ?? null, path: root.path };
});
const legacyRoots = (env) => rootsOf(env).map((root) => root.path);
const MODELS = [...models];
const USAGE_INTERFACES = usageRegistry(usageInterfaces);

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
/** The verdicts of a review or QA cycle, clean or not; checks-pass and checks-fail count for their own SHA only. */
const REVIEWED = [...CLEAN, ...FOUND];
const KINDS = [...Object.values(VERDICT), ...NOT_CLEAN];
const CANDIDATES = ["implementer", "designer"];
const WRITERS = [...CANDIDATES, "arena-judge"];
/** The roles of a run: sage's child roles (roles.mjs), and the steps of an investigation, whose runs the board reads by the step's name. */
const RUN_ROLES = [...ROLES];
/** The roles of the runs whose reports give a review or QA verdict: none may still run when a task merges (F-T289-18). */
const CHECKERS = ["code-reviewer", "security-reviewer", "ux-reviewer", "qa", "evidence-review"];
/** A task's states and the moves between them (docs/design/sage-mode.md, "A task's life"). Any state may go to abandoned. */
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
const DEFAULTS = { max_agents: AGENT_CAPS.max_agents, max_leads: AGENT_CAPS.max_leads, "cycles.small": 1, "cycles.large": 2, "cycles.risk": 2, max_rounds: 3, arena: 3, arena_models: "inherit,inherit,inherit", cap_total: AGENT_CAPS.cap_total, ...modelDefaults };
/** The counts in the config, and what a 0 would do. Each count is a whole number of 1 or more. */
/** The owner's floors (gate G18): a large or risk-flagged task needs at least 2 clean cycles. Only a code change lowers them; every other count is 1 or more. */
const FLOOR = { "cycles.large": 2, "cycles.risk": 2 };
const floor = (key) => FLOOR[key] ?? 1;
/** The limits that keep a typo from blocking every merge or starting too many agents: 10 for cycles and rounds, 50 for agent counts. */
const LIMIT = { "cycles.small": 10, "cycles.large": 10, "cycles.risk": 10, max_rounds: 10 };
const limit = (key) => LIMIT[key] ?? 50;
const COUNTS = { max_agents: "no sage agent could start", max_leads: "no lead could start", "cycles.small": "a tiny or small task would merge with no review", "cycles.large": "a large task would merge with no review", "cycles.risk": "a task with a risk flag would merge with no review", max_rounds: "no repair round could start", arena: "an arena would have no candidates", cap_total: "no sage agent could start" };
/** One project's own agent cap, cap.<project>, with the project's name as projectName gives it. Without one, max_agents is the project's cap. */
const CAP = /^cap\.[a-z0-9][a-z0-9-]*$/;
/** Model choice by role, task size or risk flag; provider defaults supply the model names. */
const MODEL = new RegExp(`^model\\.(${MODEL_ROLES.join("|")})(\\.(tiny|small|large|investigate|risk))?$`);
const KEYS = "max_agents, max_leads, cycles.small, cycles.large, cycles.risk, max_rounds, arena and cap_total as key=number, cap.<project>=number for one project's cap, model.<role>.<size>=<model>, model.<role>.risk=<model> or model.<role>=<model> for an agent role's model";
/** The columns that a later version added: an older table without them reads with them empty, and its next write adds them. */
const FILLED = { runs: ["model", ...USAGE_FIELDS], tasks: ["hold", "extra", "priority", "kind", "waits", "milestone", "adoption", "approvals"], findings: ["run", "class"] };
/**
 * The column that only a table with a chief row has: a table without it reads as it is, so its rows and their task
 * versions stay. An older sage refuses to write a table with a column that it does not know, so a legacy logbook never
 * gets it (columnsOf). It comes last.
 */
const CHIEF_COLUMN = "chief";
/** A shared logbook's run also names its checkout: the main checkout of the folder that the run started from (T625). */
const CHECKOUT_COLUMN = "checkout";
/**
 * The release of a milestone, or of a task outside a milestone (T1003). A table gets the column only when a row has it, so
 * an older sage still writes a logbook until a release is set; from then on it refuses, as for any column that it does not know.
 */
const RELEASE_COLUMN = "release";
/** All the columns of that rule: also a task's open offer, and the kind of a gate, which only the state tool writes. */
const SPARSE = { tasks: [CHIEF_COLUMN, "offer", RELEASE_COLUMN], runs: [CHIEF_COLUMN, CHECKOUT_COLUMN], gates: ["kind"], milestones: [RELEASE_COLUMN] };
const TABLES = { ...PLAIN_TABLES, ...Object.fromEntries(Object.entries(SPARSE).map(([t, cols]) => [t, [...PLAIN_TABLES[t], ...cols]])) };
/** The columns that a table may lack. */
const ADDED = { ...FILLED, ...Object.fromEntries(Object.entries(SPARSE).map(([t, cols]) => [t, [...(FILLED[t] ?? []), ...cols]])) };
/** The status of a run that ended. Any other status is an active or an unknown run. */
const RUN_ENDS = ["done", "blocked", "question", "failed"];
const COMMANDS = ["init", "logbook", "standing", "pages", "task", "task-adopt", "milestone", "release", "round", "run", "finding", "verdict", "gate", "log", "status", "stats", "merge-check", "config", "projects", "board", "observe", "link", "claim", "offer", "cancel", "accept", "unclaim", "move", "worktrees"];
/** The options of each command, by its name or by its name and first word. Every command also takes --project. */
const OPTIONS = {
  "logbook repair": ["accept-loss", "accept-change-loss"],
  link: ["to", "separate"],
  move: ["preview", "plan", "gate"],
  claim: ["version"],
  offer: ["to"],
  cancel: ["offer"],
  accept: ["offer", "version"],
  "gate replace": ["to"],
  "projects rebuild": ["accept-listing"],
  "task add": ["title", "size", "risk", "add", "why", "priority", "kind", "waits", "milestone"],
  task: ["why"], // task <T> set state=abandoned --why <reason>
  round: ["why"], // round <T> --why <reason>: the chief's extra round in autopilot (T804)
  "task-adopt": ["source-logbook", "source-provider", "source-task", "pr", "branch"],
  "milestone propose": ["name", "goal", "pilot", "tasks"],
  "release add": ["name", "goal"],
  "run add": ["role", "branch", "candidate", "usage-interface"],
  observe: ["kind", "source", "basis", "observed-at", "data-hex"],
  "run done": ["status", "tokens", "report", "usage", "usage-source", "usage-evidence"],
  "run usage": ["tokens", "usage-source", "usage-evidence"],
  "finding add": ["source", "severity", "summary", "key", "run", "class"],
  "finding triage": ["reason", "proof"],
  "finding move": ["to", "size"],
  verdict: ["sha", "kind", "cycle", "pr", "run"],
  "gate add": ["question", "options", "recommend", "default"],
  "gate answer": ["option", "other-hex"],
  log: ["why"],
  "merge-check": ["sha", "pr", "cycles", "head"],
  board: ["name-hex", "view"],
  stats: ["task"],
  pages: ["run", "text"],
  "worktrees prune": ["yes"],
};
/** The canonical number of a PR in an older row: "040" is PR 40. */
const prNumber = (pr) => (/^\d+$/.test(pr ?? "") ? String(BigInt(pr)) : pr);
const STANDING = `# Standing orders

Every agent reads these orders before it starts; a brief points to them. Add a line when you notice that you repeat an instruction.

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
  return execFileSync("git", ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", ...args], { encoding: "utf8", env: neutral, stdio: ["ignore", "pipe", "pipe"] }); // a failure's message ends with git's reason
}

/**
 * The main checkout of a project, also from inside one of its linked worktrees. git's answer counts only when it points
 * back to the folder: the main checkout holds its git folder, or the git folder is a linked worktree of that main
 * checkout and names this folder as its worktree (a relative name counts from the git folder, as git reads it). Else (a planted .git/commondir or .git file, for example) the folder
 * is a project of its own, so no folder can borrow another project's logbook.
 */
function projectRoot(path) {
  try {
    const [common, gitDir, top] = readLocalGit(path, ["rev-parse", "--path-format=absolute", "--git-common-dir", "--absolute-git-dir", "--show-toplevel"]).toString().trim().split("\n");
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
/** Names the project's main checkout in a legacy logbook (checkout.txt), so a session of another project can answer its gates. A shared logbook has bindings.tsv instead: it may have several checkouts. */
const checkout = (dir, project, env) => {
  if (!isShared(dir, env)) put(join(dir, "checkout.txt"), `${projectRoot(resolve(project))}\n`);
};

/** A name as a slug: lower case, each run of other characters than a-z and 0-9 as one "-", or "project" when nothing is left. */
const slug = (name) => String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "project";

/**
 * The folder where agents save a project's pages (research, designs, findings): <worktree root>/<logbook key>/pages, one
 * folder for each task in it. The logbook key (name and hash) keeps two projects with the same folder name apart. The
 * Claude hook lets the investigate agent write here (T932).
 */
const pagesRoot = (project, env = process.env) => join(worktreeRoot(env), basename(storeDir(project, env)), "pages");
const pagesDir = (project, task, env) => join(pagesRoot(project, env), task);
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
/** Does a branch belong to a task: a BRANCH of the form [<prefix>/]<task>[-<words>]? task set checks this one rule. */
const ofTask = (task, name) => BRANCH.test(name) && new RegExp(`^(?:[A-Za-z0-9_-]+/)?${task}(?:-[A-Za-z0-9._-]+)?$`, "i").test(name);
/**
 * May a task name this branch: a branch of the task, or the branch that another task of its logbook names, so that two
 * tasks share one pull request (T439). The merge check then wants each task of that branch on the pull request.
 */
/** Is it the same branch: letters in any case, as ofTask reads a task's name (R1740-3). */
const sameBranch = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
/** A run of an arena's candidate, on its own branch. A review run may carry a candidate's number, but it writes nothing. */
const isCandidate = (run) => !!run.candidate && !!run.branch && CANDIDATES.includes(run.role);
/**
 * Is a task's arena step open: its route has the block or it has a candidate run, and no judge of it ended done? A repair
 * after that needs no number. An abandoned task has no open step: abandon is one of the step's exits, so it ends the step.
 */
const arenaOpen = (task, runs) => task.state !== "abandoned"
  && (list(task.route).includes("arena") || runs.some((r) => r.task === task.id && isCandidate(r)))
  && !runs.some((r) => r.task === task.id && r.role === "arena-judge" && r.status === "done");
const ARENA_STEP = "its route has the arena block or it has a candidate run, and no arena-judge run of it ended done";
/** The ways out of an open arena step. --candidate is none of them for a task with no arena: it marks the build's branch as a candidate's. */
const arenaExits = (id) => `Finish a judge: sage run add ${id} --role arena-judge --branch sage/${id.toLowerCase()}-judge, then sage run done <R> --status done. A task that needs no arena: sage task ${id} set state=abandoned, then frame it again with sage task add, on a new branch.`;
/** Why a task with an open arena step cannot end, or "". */
const openBar = (task, runs) => (arenaOpen(task, runs) ? `${task.id}'s arena step is open: ${ARENA_STEP}, so ${task.id} has no final version yet. ${arenaExits(task.id)}` : "");
/**
 * Why a task must not go on, or "": the branch that would land is an arena candidate's, its arena step is open, or it
 * has candidates and names no branch. The rule reads the branch, not the SHA: a judge with no graft keeps the candidate's
 * commit on its own branch. The move to verified and the merge check share it (T584), so no task reaches
 * the owner as ready before a judge ended done. runs holds at least the task's own runs.
 */
const candidateBar = (task, landing, candidates, runs) => {
  const { id } = task, entry = landing && candidates.find((r) => sameBranch(r.branch, landing));
  if (entry) return `${id} would land ${landing}, the branch of arena candidate ${entry.candidate} (${entry.id}), and a candidate's branch never merges. Open the pull request from the judge's or the build's branch, then run sage task ${id} set branch=<that branch>. With no such branch yet, start a judge: sage run add ${id} --role arena-judge --branch sage/${id.toLowerCase()}-judge.`;
  const open = openBar(task, runs);
  if (open) return open;
  if (!landing && candidates.some((r) => r.task === id)) return `${id} has arena candidate runs and no branch=, so nothing says what would land, and a candidate's branch never merges. Run sage task ${id} set branch=<the judge's or the build's branch>, then try again.`;
  return "";
};
/** The bar on what a task's branch= would land, for a new command only. A replay of a saved update keeps the rules of its writer. */
const landingBar = (task, runs) => candidateBar(task, task.branch, runs.filter(isCandidate), runs);
/**
 * A planned move that the arena refuses: to verified, by what would land; to concluded, by the open step, because an
 * investigation lands nothing. changes are the command's key=value pairs. Planning replays saved updates, so each new
 * command calls this, and planTaskChanges does not. It gives the reason, or "".
 */
const moveBar = (changes, { task, runs }) => (changes.includes("state=verified") ? landingBar(task, runs) : changes.includes("state=concluded") ? openBar(task, runs) : "");
/** An arena candidate's number as the table stores it: a whole number from 1, after the same cleaning as every cell. */
const candidateOf = (value) => {
  const k = cell(value);
  return /^[1-9]\d*$/.test(k) ? k : refuse(`--candidate is a whole number from 1, not ${JSON.stringify(visible(String(value)))}. Nothing changed.`);
};
/** The fields that each adoption version has: the source provider, task, logbook and project, the spent rounds and the source digest. */
const adoptionBase = (a, version) => a?.version === version && /^[a-z][a-z0-9-]*$/.test(a.provider ?? "") && TASK_ID.test(a.task ?? "")
  && isAbsolute(a.logbook ?? "") && isAbsolute(a.project ?? "") && Number.isSafeInteger(a.round) && a.round >= 0
  && (a.cycles === undefined || (Number.isInteger(a.cycles) && a.cycles >= 1)) && /^[a-f0-9]{64}$/.test(a.digest ?? "");
/** Version 1, from task-adopt: the PR and the branch, named for the source task, are required. */
const adoptionV1 = (a) => adoptionBase(a, 1) && PR.test(a.pr ?? "") && ofTask(a.task, a.branch);
/**
 * Version 2, from the move (T641 reads it; the move writes it): the PR and the branch are optional, and from keeps the
 * moved task's own version 1 record. A branch is named for the source task or is the branch of from.
 */
const adoptionV2 = (a) => adoptionBase(a, 2) && (a.from === undefined || adoptionV1(a.from)) && (a.pr === undefined || PR.test(a.pr))
  && (a.branch === undefined || ofTask(a.task, a.branch) || a.branch === a.from?.branch);
/** A task's adoption record. A version 2 record without its own PR, branch or cycles takes those of from, so its branch stays the task's own. */
const adoptionOf = task => {
  if (!task.adoption) return null;
  let a;
  try { a = JSON.parse(task.adoption); } catch { /* Refuse below. */ }
  if (adoptionV1(a)) return a;
  if (!adoptionV2(a)) refuse(`${task.id} has a damaged adoption record.`);
  return { ...a, pr: a.pr ?? a.from?.pr, branch: a.branch ?? a.from?.branch, cycles: a.cycles ?? a.from?.cycles };
};
/** Is a branch this task's own: named for its id, or the branch that it adopted, which carries the source task's number. */
const branchOfTask = (task, name) => ofTask(task.id, name) || adoptionOf(task)?.branch === name;
const mayName = (tasks, task, name) => branchOfTask(task, name) || tasks.some((other) => other.id !== task.id && other.branch === name);
const branchOf = (name) => (BRANCH.test(name) ? name : refuse(`${JSON.stringify(name)} is not a task branch: use letters, digits and . _ / - (for example sage/t12 or tool/t12-short-name), not main, master or HEAD in any case, not under refs/, heads/, remotes/ or origin/, and not a name that starts with - or holds .., @{ or a space.`));

/** The project's name: its main checkout's folder name as a slug. The store's folder and the cap.<project> config key use it. */
function projectName(path) {
  return slug(basename(projectRoot(resolve(path))));
}

/** The logbook of a project: every caller finds it again through the one resolver (shared-root.mjs). */
function storeDir(project, env = process.env) {
  return locate(project, env).dir;
}

/** Is this logbook folder in the shared root? */
const isShared = (dir, env) => !!dir && dirname(dir) === sharedRoot(env);

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

/** A root's config.json as an object, or {} when it is missing, torn, not an object or not a regular file. It never throws or waits. */
function savedIn(root) {
  try {
    const value = JSON.parse(readRegular(join(root, "config.json")));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}
/** The keys that the shared root holds for a shared project: one project needs the same clean cycles from either chief. */
const SHARED_KEYS = ["cycles.small", "cycles.large", "cycles.risk", "max_rounds"];
const pick = (object, keys) => Object.fromEntries(Object.entries(object).filter(([k]) => keys.includes(k)));
/** The saved config for a logbook: the provider root's, and for a shared logbook the shared root's SHARED_KEYS in place of the provider's. */
function saved(env, dir) {
  const own = savedIn(sageRoot(env));
  if (!isShared(dir, env)) return own;
  const { "cycles.small": _s, "cycles.large": _l, "cycles.risk": _r, max_rounds: _m, autopilot_cycles: _a, ...rest } = own;
  return { ...rest, ...pick(savedIn(sharedRoot(env)), SHARED_KEYS) };
}

/**
 * The settings for all projects. The hooks call this, so it never throws or waits: a missing, torn or bad value (a count
 * as "3x", for one), or a config.json that is not a regular file, gives the default. A count reads as valid() gives it:
 * never below its floor, and never more agents or rounds, or fewer cycles, than written. A cycles key that is there but
 * has no number (Infinity, [3], true, "abc") reads as "invalid", and the merge check refuses every merge. A file of
 * an older sage holds autopilot_cycles for cycles.large: it counts, or reads as invalid, when cycles.large is absent, never below the floor.
 * With dir, a logbook's folder: a shared logbook reads SHARED_KEYS from the shared root.
 */
function config(env = process.env, dir) {
  let c = { ...DEFAULTS };
  try {
    const s = saved(env, dir);
    if (!Object.hasOwn(s, "cycles.large") && Object.hasOwn(s, "autopilot_cycles")) s["cycles.large"] = s.autopilot_cycles; // a broken one is an invalid cycles.large
    const extra = Object.keys(s).filter((k) => (CAP.test(k) || MODEL.test(k)) && !Object.hasOwn(DEFAULTS, k)).map((k) => [k, valid(k, s[k])]).filter(([, v]) => v !== undefined);
    c = Object.fromEntries([...Object.entries(DEFAULTS).map(([k, d]) => [k, valid(k, s[k]) ?? (k.startsWith("cycles.") && Object.hasOwn(s, k) ? "invalid" : d)]), ...extra]); // the defaults, then the caps and models without one
  } catch {}
  return c;
}

/** The clean cycles that a task needs: its current configuration and any saved source minimum from adoption (the largest count wins). */
function cyclesFor(task, c) {
  return Math.max(adoptionOf(task)?.cycles ?? 0, ...cycleKeys(task).map((k) => c[k]));
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
/**
 * Text with each hidden character, tab, line feed and line or paragraph separator shown as \xNN or \u{N}, so that a
 * printed line never drives the terminal, breaks a line or hides text (F-T639-1). The link prompt prints paths with it.
 */
const visible = (s) => String(s).replace(new RegExp(`[\\t\\n\\u2028\\u2029]|${HIDDEN.source}`, "gu"), (c) => (c.codePointAt(0) < 0x100 ? `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}` : `\\u{${c.codePointAt(0).toString(16)}}`));

/** What to ask the user about a file that cannot be read: never to remove the root, which holds every logbook, a saved change's marker, which the stuck line forbids, nor a file that a permission keeps shut, whose rows are there. */
const fixIt = (at, why, root) => `Ask the user to ${["EACCES", "EPERM"].includes(why) ? "fix the permissions of " : at === root || basename(at) === PENDING ? "fix " : "fix or remove "}${visible(at)}.`;

/**
 * The refusal for a table of a logbook that lost its rows: it is missing, or has no header line. It names both ways out,
 * and the repair names also the tables that the refused command already repairs (also), so one command repairs them all.
 */
const lost = (dir, table, what, also = []) => {
  const fault = `${join(dir, `${table}.tsv`)} ${what}, but every table of a logbook has at least its header line, so its rows are lost.`;
  // fault: the problem alone, for a refusal that prints its own repair line (K1).
  return Object.assign(new Refusal(`${fault} Ask the user to restore it from a copy. If the user accepts the loss, run: sage logbook repair --accept-loss ${[...also, table].join(",")} --project <the project>. If no project uses ${dir}, ask the user to remove it.`), { fault });
};

/**
 * A table of a logbook as its header's columns and its data lines. It refuses, with the path, a table that is missing or
 * a link to nothing, one with no line (0 bytes, or only blank lines), one that is not a regular file, and one whose first
 * line does not name every column of this version (the header was lost or edited), so no data line is taken for it. A
 * header-only table is a table without rows: a cut that keeps only the header cannot be told from it. An editor's BOM
 * and CRLF line ends read as a plain file.
 */
function sheet(dir, table, also = [], max = Infinity) {
  if (!RENAMED_TABLES.includes(table)) return fileSheet(dir, table, also, max);
  // A logbook from before the rename (T995) has programs.tsv, or the old program column in tasks.tsv: its renamed tables
  // read as the migration writes them, and the program column is the old name of the milestone column, not a newer one.
  const file = table === "tasks" ? fileSheet(dir, table, also, max) : undefined;
  return lstatSync(join(dir, "programs.tsv"), { throwIfNoEntry: false }) || file?.cols.includes("program") ? renamedSheet(dir, table, also, max) : (file ?? fileSheet(dir, table, also, max));
}
/** The tables that the rename of program to milestone changes (T995), in the order that its migration writes them: the decisions first, so a stop leaves the id map. */
const RENAMED_TABLES = ["decisions", "milestones", "tasks", "gates"];
/**
 * The table of a logbook from before the rename (T995) that no table of this version has: programs.tsv, the milestones
 * table of then, with the same columns. Its read has every check of a table, and a repair can start it again.
 */
const OLD_TABLES = { programs: PLAIN_TABLES.milestones };
const tableCols = (table) => TABLES[table] ?? OLD_TABLES[table];
/**
 * A renamed table of a logbook from before the rename (T995), as a read gives it in memory and the migration of the next
 * write gives it on disk (renameRows), so the two agree: the milestones from programs.tsv with their new ids, the
 * milestone column of tasks.tsv in place of the program column. The table itself is read with every check, and for the
 * milestones also programs.tsv (unless a repair starts it again: also). The other tables give only the id map and the
 * old ids: one that fails its own check adds nothing here, so its own read refuses it, and a repair of it reads the rest
 * (F-T995-1). A missing milestones.tsv or programs.tsv has no rows here.
 */
function renamedSheet(dir, table, also = [], max = Infinity) {
  const exists = (t) => lstatSync(join(dir, `${t}.tsv`), { throwIfNoEntry: false });
  const own = (t) => (exists(t) || !["milestones", "programs"].includes(t) ? fileSheet(dir, t, also, max) : undefined);
  const other = (t) => {
    try { return own(t); } catch (e) { if (e instanceof Refusal) return undefined; throw e; }
  };
  const mine = (t) => t === table || (table === "milestones" && t === "programs" && !also.includes(t));
  const sheets = Object.fromEntries([...RENAMED_TABLES, "programs"].map((t) => [t, mine(t) ? own(t) : other(t)]));
  const rows = (t) => (sheets[t] ? rowsOf(sheets[t]) : ["milestones", "programs"].includes(t) ? undefined : []);
  const out = renameRows({ tasks: rows("tasks"), decisions: rows("decisions"), gates: rows("gates"), milestones: rows("milestones"), programs: rows("programs") }, now())[table];
  const cols = (sheets[table]?.cols ?? PLAIN_TABLES.milestones).filter((c) => c !== "program");
  if (table === "tasks" && !cols.includes("milestone")) cols.push("milestone");
  return { cols, lines: out.map((row) => cols.map((c) => row[c] ?? "").join("\t")) };
}
/**
 * The migration of the rename (T995): once, at the first write of this version, under the write lock, before the
 * integrity check. It reads each renamed table as a read gives it (renamedSheet), so a damaged table, programs.tsv too,
 * refuses before the first write (F-T995-2). Then it writes them, the decisions first, and removes programs.tsv last,
 * when milestones.tsv holds each of its rows; the milestones table only from programs.tsv, so a lost table stays lost. A
 * stop between two writes leaves the id map in the decisions, so the next write finishes it with the same ids, and a
 * read before it gives the same rows. A logbook with no program column and no programs.tsv is not changed, so a second
 * run changes nothing. A repair of lost tables (skip) runs first: the next write migrates.
 */
function renameLogbook(dir, skip) {
  const programs = join(dir, "programs.tsv"), old = lstatSync(programs, { throwIfNoEntry: false });
  if (skip.length || (!old && !programColumn(dir))) return;
  const tables = RENAMED_TABLES.filter((t) => old || t !== "milestones").map((t) => [t, rowsIn(t, renamedSheet(dir, t))]);
  for (const [table, rows] of tables) write(dir, table, rows);
  if (old) unlinkSync(programs);
}
/** Does tasks.tsv have the program column of a logbook from before the rename? A file that cannot be read has none here: the integrity check refuses it. */
function programColumn(dir) {
  try { return sheetText(readRegular(join(dir, "tasks.tsv")) ?? "").cols.includes("program"); } catch { return false; }
}
/** A table of a logbook as its file holds it (sheet). */
function fileSheet(dir, table, also = [], max = Infinity) {
  const file = join(dir, `${table}.tsv`);
  let text;
  try {
    text = readRegular(file, { max });
  } catch (e) {
    if (e instanceof Refusal || !e.code) throw e;
    refuse(`${file} cannot be read (${e.code}). ${fixIt(file, e.code)}`);
  }
  if (text === undefined && Object.hasOwn(NAMED_BY, table) && !namedBy(dir, table, max)) return { cols: PLAIN_TABLES[table], lines: [] };
  if (text === undefined) throw lost(dir, table, "is missing or is a link to nothing", also);
  const { cols, lines } = sheetText(text);
  if (!cols.length) throw lost(dir, table, text ? "has only blank lines" : "is empty (0 bytes)", also);
  if (!tableCols(table).every((c) => cols.includes(c) || ADDED[table]?.includes(c))) refuse(`the header of ${file} is damaged: its first line must be the column names ${(PLAIN_TABLES[table] ?? OLD_TABLES[table]).join(", ")}, separated by tabs. Ask the user to fix or add that line.`);
  return { cols, lines };
}

/** The tables that came later, each with the column and the tables whose cells name its rows: milestones (T337) and releases (T1003). */
const NAMED_BY = { milestones: ["milestone", ["tasks"]], releases: [RELEASE_COLUMN, ["tasks", "milestones"]] };
/**
 * Does a row of the logbook name a row of this later table? A logbook made before the table has no file for it, and that
 * reads as a table with no rows while no cell names one. Once a cell does, the file is missing rows, and a missing file
 * is a loss as for any table. The first write of a row adds it. A table that cannot be read names none here: its own
 * check refuses it.
 */
function namedBy(dir, table, max) {
  const [column, tables] = NAMED_BY[table];
  return tables.some((t) => {
    try {
      return rowsOf(sheet(dir, t, [], max)).some((row) => row[column]); // a program cell reads as its milestone cell (T995)
    } catch {
      return false;
    }
  });
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
/** A table's rows, with an empty cell after the others for each column that a later version added and the file does not have yet. */
const rowsIn = (table, text) => rowsOf(text).map((row) => ({ ...row, ...Object.fromEntries((FILLED[table] ?? []).filter((c) => !Object.hasOwn(row, c)).map((c) => [c, ""])) }));
const read = (dir, table) => rowsIn(table, sheet(dir, table));

/**
 * The integrity check of a logbook: every table (but skip, the ones that a repair starts again) is there, is a regular
 * file that it can read, is not empty, and has its header line. It refuses the first that fails and names its file. The
 * merge check runs it on every logbook, and every write on its own, so no command hides a lost table or makes a new one.
 */
const check = (dir, skip = [], max = Infinity) => {
  const receipts = () => replaceWrites.readVersion(dir);
  const version = receipts();
  const tables = Object.fromEntries(Object.keys(TABLES).filter((t) => !skip.includes(t)).map((t) => [t, sheet(dir, t, skip, max)]));
  // A milestone's id is on one row: with two, a line could read the wrong one (R1208-3).
  const seen = new Set();
  const twice = (tables.milestones ? rowsOf(tables.milestones) : []).find(({ id }) => seen.has(id) || !seen.add(id))?.id;
  if (twice !== undefined) refuse(`${join(dir, "milestones.tsv")} has two rows for ${visible(twice)}, but a milestone's id is on one row. Ask the user to fix the file: keep one row of ${visible(twice)}.`);
  // A release's name is its key, also without case or width (T1003): with two rows, a cell could name either.
  const names = new Set();
  const same = (tables.releases ? rowsOf(tables.releases) : []).find(({ name }) => names.has(releaseKey(name)) || !names.add(releaseKey(name)));
  if (same) refuse(`${join(dir, "releases.tsv")} has two rows for the release ${visible(same.name)} (case and width do not count), but a release's name is on one row. Ask the user to fix the file: keep one row of it.`);
  if (receipts() !== version) refuse("A Replace receipt was created while this logbook was read. Retry the read.");
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

function ready(dir, env, skip = []) {
  // A writer finds its logbook before it takes the lock, so a writer that waited here during the move would write into
  // the old logbook, also by settling a saved change. A read may still read it: the board shows it read-only.
  if (lstatSync(join(dir, "moved.json"), { throwIfNoEntry: false })) refuse(`this logbook moved to the shared root (${join(dir, "moved.json")}), so sage writes no more to it. Nothing changed. Run the command again: it then finds the shared logbook.`);
  // The move saves its plan, then marks the old logbooks one by one: a stop between two marks leaves one unmarked, and a
  // writer that waited here must not change it, or the move cannot finish. So a plan that names this logbook refuses too (T647).
  if (env) for (const { file, plan } of movePlans(rootOf(env))) if (!plan || plan.sources?.some((s) => sameDir(s?.dir, dir))) refuse(stoppedText(plan, file));
  settle(dir);
  renameLogbook(dir, skip);
  for (const file of ["status.md", "standing.md"]) target(join(dir, file));
  if (!skip.includes("tasks") && !lstatSync(join(dir, "tasks.tsv"), { throwIfNoEntry: false })) {
    if (skip.length || hasRows(dir)) throw lost(dir, "tasks", "is missing", skip);
    return;
  }
  for (const [table, { cols }] of Object.entries(check(dir, skip))) knownColumns(dir, table, cols);
}
function knownColumns(dir, table, cols) {
  const extra = cols.filter((c) => c && !TABLES[table].includes(c));
  if (extra.length) refuse(`${join(dir, `${table}.tsv`)} has columns that this version of sage does not know (${extra.join(", ")}): a newer sage wrote this logbook, and a write of this version would lose them. Update the sage plugin and restart this session. Nothing changed; status, logbook, standing and merge-check still work.`);
}

/** The hash of a task's row. An empty offer cell counts as no cell, so the first offer of a logbook changes no other task's version. */
const taskVersion = ({ offer, ...task }) => createHash("sha256").update(JSON.stringify(offer ? { ...task, offer } : task)).digest("hex");

const updateKeys = (value, keys) => value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
/** A saved writer may add known optional columns, but cannot discard existing cells. */
function savedWriteColumns(tables, deny) {
  return Object.fromEntries(Object.entries(tables).map(([table, pair]) => {
    const before = sheetText(pair.before).cols, after = sheetText(pair.after).cols;
    for (const cols of [before, after]) {
      if (!TABLES[table].every(key => cols.includes(key) || ADDED[table]?.includes(key))
        || cols.some(key => !TABLES[table].includes(key)) || new Set(cols).size !== cols.length) deny();
    }
    if (before.some(key => !after.includes(key))) deny();
    return [table, after];
  }));
}

/** A recorded running run is an assignment record, not proof that a native agent started. */
function runFrame(dir, project, task, role, branch, candidate, env) {
  if (!RUN_ROLES.includes(role)) refuse(`${JSON.stringify(role)} is not a role of a run. Roles: ${RUN_ROLES.join(", ")}.`);
  if (WAIT_ROLES.includes(role)) waitsMet(task, graphOf(dir), `${role} run`);
  if (role === "lead") {
    // A lead carries one task's pull request: one running lead per task, and at most max_leads per project (the hook holds the same key for the agents).
    if (["merged", "abandoned", "concluded"].includes(task.state)) refuse(`${task.id} is ${task.state}, so it takes no lead run: the task has ended.`);
    if (!builds(task)) refuse(`${task.id} is an investigation: it has no build and no pull request, so it takes no lead run. The chief runs its steps.`);
    const leads = read(dir, "runs").filter((r) => r.role === "lead" && r.status === "running");
    const same = leads.find((r) => r.task === task.id);
    if (same) refuse(`${same.id} is the running lead run of ${task.id}, and a task has one running lead. Finish ${same.id} first (sage run done ${same.id} --status done, blocked, question or failed).`);
    if (leads.length >= config(env, dir).max_leads) refuse(`the project has ${leads.length} running lead runs, the most it holds: ${leads.map((r) => `${r.id} on ${r.task}`).join(", ")}. Finish one of them first (sage run done <R> --status done, blocked, question or failed).`);
  }
  if (WRITERS.includes(role)) {
    if (!branch) refuse(`the ${role} run needs --branch`);
    const runs = read(dir, "runs"), there = runs.filter(row => sameBranch(row.branch, branch));
    // An arena's branches are its evidence, so they stay apart after a run ends too (T584). This comes before the one-writer
    // rule, so a refusal never says to wait for a run when the end of that run changes nothing.
    const judge = role === "arena-judge", seat = !judge && candidate;
    const clash = there.find(row => (seat && row.role === "arena-judge") || (isCandidate(row) && !(row.task === task.id && row.role === role && row.candidate === candidate)));
    if (clash) refuse(`${clash.id} (${clash.role}${isCandidate(clash) ? `, candidate ${clash.candidate}` : ""}) is on ${branch}, and ${judge || !isCandidate(clash) ? "an arena's judge never shares a branch with a candidate" : seat ? "each candidate of an arena has its own branch" : "a candidate's branch stays as it is"}. Give this run a new branch. Nothing changed.`);
    // A candidate's row bars every task from its branch for good (candidateBar), so a candidate takes no branch of another task (T601).
    const owner = seat && (read(dir, "tasks").find(row => row.id !== task.id && sameBranch(row.branch, branch))?.id ?? there.find(row => row.task !== task.id && WRITERS.includes(row.role))?.task);
    if (owner) refuse(`${branch} belongs to ${owner}, and a candidate run there would bar ${owner} from its own branch. Give this run another branch. Nothing changed.`);
    if (CANDIDATES.includes(role) && !candidate && arenaOpen(task, runs)) refuse(`${task.id}'s arena step is open: ${ARENA_STEP}. So this ${role} run needs --candidate <k>, on its own branch. ${arenaExits(task.id)} Nothing changed.`);
    // An arena on a large task is a design arena: arena, PE, the owner's approval, build. So its build waits for briefed.
    if (role === "implementer" && candidate && task.size === "large" && ["framed", "designing", "awaiting-you"].includes(task.state)) refuse(`${task.id} is large and ${task.state}, so its arena is a design arena, and an implementer is no candidate of it: use --role designer. A build arena runs on a tiny or small task, or on a briefed task after an approved design. Nothing changed.`);
    // A candidate run opens the step with no arena block, and a run cannot change the route, so a build with no code review takes none.
    if (CANDIDATES.includes(role) && candidate && builds(task) && !list(task.route).includes("code-review")) refuse(`${task.id}'s route has no code review, so it takes no arena candidate: a judge's graft is new code that nobody read. Abandon ${task.id}: sage task ${task.id} set state=abandoned. Then frame it again on a new branch with sage task add --add arena, which adds the code review. Nothing changed.`);
    const other = there.find(row => row.status === "running" && WRITERS.includes(row.role));
    if (other) refuse(`${other.id} (${other.role}) still writes ${branch}, and a branch has one writer. Finish that run first (sage run done ${other.id} --status done, blocked, question or failed), or give this run another branch.`);
  }
  // The project's agent cap holds every running run of the logbook, of each role and each provider (T952): in Codex it is
  // the only agent cap, and in Claude the hook also counts the live agents against the same value.
  const cap = agentCaps(config(env, dir)).cap(projectName(project));
  const running = read(dir, "runs").filter((r) => r.status === "running");
  if (running.length >= cap) refuse(`the project has ${running.length} running runs, its agent cap (max_agents, or cap.<project>): ${running.map((r) => `${r.id} ${r.role} on ${r.task}`).join(", ")}. Wait for one of them to end, or end a run whose agent has stopped (sage run done <R> --status done, blocked, question or failed). Nothing changed.`);
  return { id: nextId(dir, "R"), task: task.id, role, round: task.round, candidate, branch,
    status: "running", started: now(), model: modelFor(role, task.size, candidate, config(env), task.risk) };
}

const usageReference = (run, opt) => ({ run, tokens: opt.tokens, source: opt["usage-source"], evidence: opt["usage-evidence"] });
function validateUsageWrite({ reference, result }, tables) {
  const deny = () => refuse("The saved usage update is damaged. Nothing changed.");
  if (!reference || Object.keys(reference).sort().join() !== "evidence,run,source,tokens" || !/^R[1-9]\d*$/.test(reference.run)
    || !tokenCount(reference.tokens) || !usageText(reference.source) || !usageText(reference.evidence)
    || !result || Object.keys(result).sort().join() !== "at,task" || !/^T[1-9]\d*$/.test(result.task)
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(result.at) || !Number.isFinite(Date.parse(result.at)) || new Date(result.at).toISOString().replace(".000Z", "Z") !== result.at) deny();
  if (!tables) return;
  const decode = (table, text) => {
    const sheet = sheetText(text);
    if (!TABLES[table].every(c => sheet.cols.includes(c) || ADDED[table]?.includes(c))
      || sheet.cols.some(c => !TABLES[table].includes(c)) || new Set(sheet.cols).size !== sheet.cols.length) deny();
    return rowsOf(sheet);
  };
  const runs = decode("runs", tables.runs.before), decisions = decode("decisions", tables.decisions.before);
  const matches = runs.filter(r => r.id === reference.run), run = matches[0];
  if (matches.length !== 1 || run.task !== result.task || run.status === "running" || run.tokens
    || !["", "unavailable"].includes(run.usage_status ?? "")) deny();
  Object.assign(run, { tokens: reference.tokens, usage_status: "measured", usage_source: reference.source, usage_evidence: reference.evidence });
  decisions.push({ at: result.at, task: result.task, decision: `${reference.run} usage measured`, why: JSON.stringify(reference) });
  if (tables.runs.after !== tableText("runs", runs) || tables.decisions.after !== tableText("decisions", decisions)) deny();
}
const usageWrites = recordedWrites({ schema: 7, tables: ["runs", "decisions"], folder: "usage-requests",
  name: /^[0-9a-f]{64}\.json$/, receiptName: reference => createHash("sha256").update(JSON.stringify(reference)).digest("hex") + ".json", validate: validateUsageWrite });
function enrichUsage(dir, id, opt) {
  const reference = usageReference(id, opt);
  validateUsageWrite({ reference, result: { task: "T1", at: now() } });
  const runs = read(dir, "runs"), matches = runs.filter(r => r.id === id), run = matches[0];
  if (matches.length !== 1 || run.status === "running") refuse("Usage enrichment needs one ended run. Nothing changed.");
  const prior = usageWrites.readReceipt(dir, reference);
  if (prior) {
    if (run.tokens !== reference.tokens || run.usage_status !== "measured" || run.usage_source !== reference.source || run.usage_evidence !== reference.evidence) refuse("The usage receipt differs from the run. Nothing changed.");
    return `${id} usage measured (already recorded)`;
  }
  if (run.tokens || !["", "unavailable"].includes(run.usage_status)) refuse("A measured count never changes. Nothing changed.");
  const result = { task: run.task, at: now() }, decisions = read(dir, "decisions");
  Object.assign(run, { tokens: reference.tokens, usage_status: "measured", usage_source: reference.source, usage_evidence: reference.evidence });
  decisions.push({ at: result.at, task: run.task, decision: `${id} usage measured`, why: JSON.stringify(reference) });
  usageWrites.commit(dir, { reference, result }, { runs: tableText("runs", runs), decisions: tableText("decisions", decisions) });
  return `${id} usage measured`;
}

/** The verdict kinds that a finished run of each review or QA role backs (T483): its clean kind, then its problem kind. */
const BACKS = { "code-reviewer": ["review-clean", "findings"], "security-reviewer": ["security-clean", "findings"], "ux-reviewer": ["ux-clean", "findings"], qa: ["qa-pass", "qa-fail"] };
/** The most bytes of a kept report's text. */
const KEPT_MAX = 1 << 20;
/** A run's kept report: one file for each run, in the logbook, that only a provider's stop hook writes (keepReport). */
const keptFile = (dir, run) => join(dir, "kept", `${run}.json`);

/**
 * Keep a helper's report at its stop, for the verdict that it backs (T483). A provider's stop hook calls it with the
 * report as the helper gave it, and the commit that the hook saw the helper review ("" when it saw none). No command of the
 * state tool keeps a report, so a chief cannot make one. The first report of a run stays: a later one never replaces it.
 * A run that ended as blocked or failed keeps a report that arrives late, with its arrival time, in every logbook: so a
 * transfer or Replace loses no report, and its findings hold the lead (the gap rule) as a report in time does (T970). Such
 * a run backs no verdict (backingProblem). The path of the kept report, or a refusal.
 */
function keepReport(project, { task, run, role, sha = "", text } = {}, env = process.env) {
  const dir = storeDir(project, env);
  if (!existsSync(join(dir, "tasks.tsv"))) refuse(`no logbook for the project ${visible(project)}, so no report is kept.`);
  // A logbook that moved takes no more reports (F-T641-15): its runs ended before the move, and the move keeps no report.
  if (lstatSync(join(dir, "moved.json"), { throwIfNoEntry: false })) refuse(`this logbook moved to the shared root (${join(dir, "moved.json")}), so no report is kept.`);
  if (!/^R[1-9]\d*$/.test(String(run)) || typeof text !== "string" || Buffer.byteLength(text) > KEPT_MAX || !/^(?:[0-9a-f]{40})?$/.test(String(sha))) {
    refuse("a kept report needs its run id, its text (at most 1 MiB) and the full SHA of its commit or none. No report is kept.");
  }
  const row = read(dir, "runs").find((r) => r.id === run);
  if (row?.task !== task || row.role !== role) refuse(`${run} is not a ${role} run of ${task}, so no report is kept.`);
  if (!["running", "blocked", "failed"].includes(row.status)) refuse(`${run} ended as ${row.status} before this stop, so no report is kept.`);
  const folder = join(dir, "kept"), file = keptFile(dir, run), temporary = join(folder, `.kept-${randomUUID()}`);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  // The whole file appears at once, by a link of a full temporary file, and never over a kept one.
  writeFileSync(temporary, JSON.stringify({ task, run, role, sha, text, at: now() }), { flag: "wx", mode: 0o600 });
  let kept = true;
  try { linkSync(temporary, file); } catch (e) { if (e.code !== "EEXIST") throw e; kept = false; } finally { unlinkSync(temporary); }
  // A report is kept once: the same text again is the same report, and another text is refused, so its hook can say so.
  if (!kept && keptOf(dir, run)?.text !== text) refuse(`${run} already has a kept report, and a report is kept once: this other report of ${run} is not kept.`);
  return file;
}

/** A run's token count from its agent's stop (T954): one file for each run, beside its kept report, that only a provider's stop hook writes. */
const usageFile = (dir, run) => join(dir, "kept", `${run}.usage.json`);
/**
 * Keep a running run's usage at its agent's stop (T954): its token count (tokens, a whole number as text) or, when the
 * provider's record gives none, no tokens and the reason as evidence. The source names where the count came from. A later
 * stop of the same agent replaces it, as its count only grows, but a stop that reads no count (for example a half-written last
 * line) keeps a measured one (T969). `run done` takes it when the chief gives no --tokens.
 */
function keepUsage(project, { task, run, role, tokens, source, evidence } = {}, env = process.env) {
  const dir = storeDir(project, env);
  if (!existsSync(join(dir, "tasks.tsv")) || lstatSync(join(dir, "moved.json"), { throwIfNoEntry: false })) refuse(`no logbook takes usage for the project ${visible(project)}.`);
  if (!/^R[1-9]\d*$/.test(String(run)) || !(tokens === undefined || tokenCount(tokens)) || !usageText(source) || !usageText(evidence)) refuse("kept usage needs its run id, a source, evidence and tokens of 1 to 12 digits or none. No usage is kept.");
  const row = read(dir, "runs").find((r) => r.id === run);
  if (row?.task !== task || row.role !== role || row.status !== "running") refuse(`${run} is not a running ${role} run of ${task}, so no usage is kept.`);
  if (tokens === undefined && keptUsage(dir, row)?.tokens) return usageFile(dir, run);
  const folder = join(dir, "kept"), temporary = join(folder, `.usage-${randomUUID()}`);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  writeFileSync(temporary, JSON.stringify({ task, run, role, ...(tokens === undefined ? {} : { tokens }), source, evidence, at: now() }), { flag: "wx", mode: 0o600 });
  renameSync(temporary, usageFile(dir, run));
  return usageFile(dir, run);
}
/** A run's kept usage as run done records it, or undefined when none is kept or the file does not read as one. */
function keptUsage(dir, run) {
  try {
    const kept = JSON.parse(readRegular(usageFile(dir, run.id), { link: false, max: 16384 }) ?? "null");
    if (kept?.run !== run.id || kept.task !== run.task || kept.role !== run.role || !usageText(kept.source) || !usageText(kept.evidence)
      || !(kept.tokens === undefined || tokenCount(kept.tokens))) return undefined;
    return { tokens: kept.tokens ?? "", usage_status: kept.tokens ? "measured" : "unavailable", usage_source: kept.source, usage_evidence: kept.evidence };
  } catch { return undefined; }
}

/** A run's kept report, or undefined when none is kept. A kept file that does not read as one is damaged. */
function keptOf(dir, run) {
  const text = readRegular(keptFile(dir, run), { link: false, max: 6 * KEPT_MAX + 4096 }); // JSON writes a control character as 6 bytes
  if (text === undefined) return undefined;
  try {
    const kept = JSON.parse(text);
    if (kept && typeof kept.text === "string" && kept.run === run && /^(?:[0-9a-f]{40})?$/.test(kept.sha)) return kept;
  } catch {}
  return { damaged: true };
}

/** One line for each kept report of a task's blocked or failed runs: its path and its arrival time, for the owning chief to read. */
const keptLines = (dir, task) => read(dir, "runs").filter((r) => r.task === task && ["blocked", "failed"].includes(r.status) && keptOf(dir, r.id)?.at)
  .map((r) => `\n${r.id} ${r.status} · report kept ${keptOf(dir, r.id).at} · backs no verdict · ${keptFile(dir, r.id)}`).join("");

/** Compare one existing report. Admission belongs to the caller; this read creates no state or review authority. */
function compareRetainedReport(input, env = process.env) {
  if (!updateKeys(input, ["project", "task", "run", "sha256"])
    || typeof input.project !== "string" || !isAbsolute(input.project)
    || typeof input.task !== "string" || !/^T[1-9]\d*$/.test(input.task)
    || typeof input.run !== "string" || !/^R[1-9]\d*$/.test(input.run)
    || typeof input.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(input.sha256)) refuse("Invalid retained report comparison input.");
  const result = status => ({ status });
  try {
    const project = projectRoot(input.project), dir = storeDir(project, env);
    if (realpathSync(dir) !== resolve(dir)
      || (!isShared(dir, env) && readRegular(join(dir, "checkout.txt"), { link: false, max: 65536 }) !== `${project}\n`))
      refuse("Invalid retained report comparison project.");
    const tasks = read(dir, "tasks").filter(row => row.id === input.task);
    const runs = read(dir, "runs").filter(row => row.id === input.run);
    if (tasks.length !== 1 || runs.length !== 1 || runs[0].task !== input.task || !RUN_ROLES.includes(runs[0].role))
      refuse("Invalid retained report comparison task or run association.");
    const folder = join(dir, "kept"), folderStat = lstatSync(folder, { throwIfNoEntry: false });
    if (!folderStat) return result("missing");
    if (!folderStat.isDirectory()) return result("damaged");
    let bytes;
    try { bytes = readRegular(keptFile(dir, input.run), { link: false, max: 6 * KEPT_MAX + 4096, encoding: null }); }
    catch (error) {
      if (error instanceof Refusal || ["ELOOP", "ENOTDIR"].includes(error.code)) return result("damaged");
      throw error;
    }
    if (bytes === undefined) return result("missing");
    let kept;
    try { kept = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    catch { return result("damaged"); }
    // The existing format has no stored digest. Reject incomplete or unknown formats instead of guessing their meaning.
    if (!updateKeys(kept, ["task", "run", "role", "sha", "text", "at"])
      || kept.task !== input.task || kept.run !== input.run || kept.role !== runs[0].role
      || typeof kept.sha !== "string" || !/^(?:[0-9a-f]{40})?$/.test(kept.sha)
      || typeof kept.at !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(kept.at)
      || !Number.isFinite(Date.parse(kept.at)) || new Date(kept.at).toISOString() !== kept.at.replace("Z", ".000Z")
      || typeof kept.text !== "string" || Buffer.byteLength(kept.text, "utf8") > KEPT_MAX
      || Buffer.from(kept.text, "utf8").toString("utf8") !== kept.text) return result("damaged");
    const digest = createHash("sha256").update(kept.text, "utf8").digest("hex");
    return result(digest === input.sha256 ? "match" : "mismatch");
  } catch (error) {
    // Never disclose private storage paths or table contents, including through filesystem errors.
    if (error instanceof Refusal && /^Invalid retained report comparison/.test(error.message)) throw error;
    refuse("Retained report comparison cannot read the project or report; check access and permissions.");
  }
}

/** A task's open findings that block it (T671): an open low finding never blocks a merge; it stays on the task's polish list. */
const blockingOf = (findings, id) => findings.filter((f) => f.task === id && f.status === "open" && f.severity !== "low");
/** Is a finding one of this run's, by its run cell or by the run in an older key? */
const ofRun = (f, run) => f.run === run || f.key.startsWith(`${run}-`);
/** The decisions that moved a task's findings of one run to a follow-up task, of one severity when given: a move clears the finding's run, so only these keep the link. */
const movedOf = (decisions, task, run, severity = "") => decisions.filter((d) => d.task === task.id && / moved to T[1-9]\d* as /.test(d.decision) && d.why.startsWith(`the follow-up task (from ${run}, ${severity}`));

/**
 * The medium and high findings of a run's report ({ key, severity }, highest first) that the task's finding rows do not
 * hold (T483, T956). Each one needs its own row of the run (its run cell, or an older key with the run) at its severity or
 * above, in any status; a medium one may have moved to a follow-up task instead, as its move's decision says. A low
 * finding needs no row.
 */
function unheld(findings, decisions, task, run, reported) {
  const level = { medium: 2, high: 3 }, down = (a, b) => b - a;
  const held = [...findings.filter((f) => f.task === task.id && ofRun(f, run) && f.severity !== "low").map((f) => level[f.severity]), ...movedOf(decisions, task, run, "medium").map(() => level.medium)].sort(down);
  // The highest finding takes the highest row left; a finding that the highest row left does not cover has none.
  let k = 0;
  return reported.filter((f) => f.severity !== "low").sort((a, b) => down(level[a.severity], level[b.severity])).filter((f) => !(held[k] >= level[f.severity] && ++k));
}

/**
 * Does triage clear this findings or qa-fail verdict (T294)? Its run links it to its findings: at least one, and each is
 * moved, or dismissed by a triage that still says so, below high. A row back on the task under a moved key counts as that
 * finding. A closed finding does not clear it: a new head confirms a fix, not this one. A high finding needs a new head
 * too. With no link, the verdict stays a block. A cleared verdict only stops refusing: it never counts toward a clean cycle.
 * An open low finding of the run does not count: it stays on the task's polish list (T671).
 */
function cleared(verdict, task, findings, decisions) {
  if (!FOUND.includes(verdict.kind) || !verdict.run) return false;
  const moved = movedOf(decisions, task, verdict.run), keys = moved.map((d) => d.decision.split(" ")[0]);
  const stayed = findings.filter((f) => f.task === task.id && (ofRun(f, verdict.run) || keys.includes(f.key)) && !(f.status === "open" && f.severity === "low"));
  return stayed.every((f) => f.status === "dismissed" && f.triage === "dismiss" && f.severity !== "high") && stayed.length + moved.length > 0;
}

/**
 * The commit of a run's kept report: the commit that the hook saw the helper review, or the full SHA that the report's
 * BRANCH names (its one full SHA, or the one after the word head when it names more, a base and a head). { sha } (none
 * when neither gives one: the report may be of an older head, R1908-1), or { problem } when they disagree or BRANCH names
 * more than one and none as its head.
 */
function reportHead(kept, run) {
  const branch = fieldsOf(kept.text, REPORT_FIELDS).filter((f) => f.name === "BRANCH").flatMap((f) => [f.rest, ...f.lines]).join("\n");
  const full = /(?<![0-9a-f])[0-9a-f]{40}(?![0-9a-f])/gi, named = [...new Set((branch.match(full) ?? []).map((s) => s.toLowerCase()))];
  const afterHead = /\bhead\b[^\n]{0,40}?(?<![0-9a-f])([0-9a-f]{40})(?![0-9a-f])/i.exec(branch)?.[1]?.toLowerCase();
  const head = named.length < 2 ? named[0] : afterHead ?? named.find((s) => s === kept.sha);
  if (named.length > 1 && !head) return { problem: `${run}'s report names ${named.length} commits in BRANCH and none as its head (the word head before it)` };
  if (kept.sha && head && kept.sha !== head) return { problem: `${run}'s report names ${head.slice(0, 7)} as its head, and the hook saw it review ${kept.sha.slice(0, 7)}: the report and the hook disagree` };
  return { sha: kept.sha || head };
}

/**
 * The proof check behind a triage with --proof (T947): run id is a done qa run of the finding's task whose kept report
 * lists the finding in EVIDENCE, on the head that the kept report of the finding's own run names. Not reproduced backs a
 * dismissal; reproduced or could not run backs a fix (could not run keeps the finding). Its outcome and head, or a refusal.
 */
function proofOf(dir, f, decision, id) {
  const run = read(dir, "runs").find((r) => r.id === id), how = "A proof check is the done qa run that reran the finding's proof on its head (the proof-check reference).";
  const no = (why) => refuse(`${why}. ${how} Nothing changed.`);
  if (decision === "ask") no("--proof goes with fix or dismiss, not with ask");
  if (!run) no(`${visible(id)} is not a run in this logbook`);
  if (run.task !== f.task) no(`${run.id} is a run of ${run.task}, not of ${f.task}`);
  if (run.role !== "qa") no(`${run.id} is a ${run.role} run, not a qa run`);
  if (run.status !== "done") no(`${run.id} ${run.status === "running" ? "still runs" : `ended as ${run.status}`}, and only a done proof check backs a triage`);
  const kept = keptOf(dir, run.id), outcome = kept && !kept.damaged ? proofResults(kept.text).get(f.key) : undefined;
  if (!outcome) no(`${run.id}'s kept report does not list ${f.key}: its EVIDENCE gives a line "- ${f.key} reproduced", "- ${f.key} not reproduced" or "- ${f.key} could not run"`);
  const from = f.run || /^(R[1-9]\d*)-/.exec(f.key)?.[1], source = from && keptOf(dir, from);
  const found = source && !source.damaged ? reportHead(source, from) : {}, checked = reportHead(kept, run.id);
  if (!found.sha) no(found.problem ?? `${f.key} names no run with a kept report whose head reads, so no proof check backs its triage: ask your chief`);
  if (checked.sha !== found.sha) no(checked.problem ?? `${run.id} checked ${checked.sha ? checked.sha.slice(0, 7) : "no head that its report names"}, and ${f.key}'s report (${from}) is on ${found.sha.slice(0, 7)}: a proof check reruns the proof on that head`);
  if ((decision === "dismiss") !== (outcome === "not reproduced")) no(`${run.id} says ${f.key} ${outcome}, so ${decision === "dismiss" ? "it is not dismissed: triage it fix" : "triage it dismiss"}`);
  return { outcome, sha: found.sha };
}

/**
 * Does a kept report back this review or QA verdict on a task with a build block (T483)? The run that --run names is a
 * run of the task, of a role that gives the kind, that ended done, with a kept report that reads, on the commit of --sha
 * when the report names one. A clean report backs only a clean kind. A report with a medium or high finding backs findings
 * or qa-fail, and a clean kind after triage, when each of its medium and high findings is recorded on the task for the run
 * at its severity or above (T294: triage can clear a problem verdict, so a part of its report must not); for a clean kind,
 * none of them is open. A check verdict and an investigation's evidence-clean need no run here. The reason, or undefined.
 */
function backingProblem(dir, task, kind, opt) {
  const roles = Object.keys(BACKS).filter((role) => BACKS[role].includes(kind));
  if (!roles.length || !builds(task)) return undefined;
  const who = roles.length === 1 ? roles[0] : `${roles.slice(0, -1).join(", ")} or ${roles.at(-1)}`;
  const again = `Run the review again under a new run (sage run add ${task.id} --role ${roles.length === 1 ? roles[0] : "<role>"}), whose helper's brief starts with "Run <R> · task ${task.id}" (or whose task name carries the run), and record its verdict with --run after it ends.`;
  if (opt.run === undefined) return `${kind} is a review or QA verdict, so it names the run whose kept report backs it: add --run with the ${who} run of ${task.id} whose helper ended with its report.`;
  const run = read(dir, "runs").find((r) => r.id === opt.run);
  if (!run) return `${opt.run} is not a run in this logbook: name the ${who} run of ${task.id} whose report backs this verdict.`;
  if (run.task !== task.id) return `${run.id} is a run of ${run.task}, not of ${task.id}: name the ${who} run of ${task.id} whose report backs this verdict.`;
  if (!roles.includes(run.role)) return `${run.id} is a ${run.role} run, so it backs no ${kind} verdict: only a ${who} run does.`;
  if (run.status === "running") return `${run.id} still runs: end it after its helper's report (sage run done ${run.id} --status done --tokens <n>), then record its verdict.`;
  if (run.status !== "done") return `${run.id} ended as ${run.status}, so it backs no verdict. ${again}`;
  const kept = keptOf(dir, run.id);
  if (!kept) return `${run.id} has no kept report: sage keeps a helper's report at its stop only when it knows the helper's run, by the first line of its brief, "Run ${run.id} · task ${task.id}", or by its task name with the run (sage_<role>_t<n>_r<n>). ${again}`;
  if (kept.damaged || kept.task !== task.id || kept.role !== run.role) return `${run.id}'s kept report is damaged, so it backs no verdict. ${again}`;
  // A proof check reruns the proofs of other runs' findings (T947): its report backs a triage, never a verdict.
  if (proofResults(kept.text).size) return `${run.id}'s report is a proof check (its EVIDENCE lists findings as reproduced or not), so it backs no verdict: name it in the triage of each finding with --proof ${run.id}, and record the verdict from the report of the run that found it.`;
  const report = readReport(kept.text, { requireComplete: true });
  if (report.unreadable) return `${run.id}'s kept report cannot be read (${report.problem}), so it backs no verdict: read it yourself. ${again}`;
  const { sha: seen, problem } = reportHead(kept, run.id), sha = String(opt.sha ?? "").toLowerCase();
  if (problem) return `${problem}, so it backs no verdict. ${again}`;
  if (!seen) return `${run.id}'s report names no full 40-character head SHA in BRANCH, and the hook saw none, so it backs no verdict: it may be of an older head. ${again} Its brief asks for the full head SHA in BRANCH.`;
  if (seen !== sha) return `${run.id}'s report is on ${seen.slice(0, 7)}, not on ${sha.slice(0, 7)}: a verdict names the commit that its helper reviewed. Record it on ${seen}, or review ${sha.slice(0, 7)} under a new run.`;
  const said = `RESULT ${report.result}${report.severities.length ? ` with ${report.severities.join(", ")} findings` : ""}`;
  const clean = cleanReport(report), [cleanKind, problemKind] = BACKS[run.role], found = FOUND.includes(kind);
  if (clean) return found ? `${run.id}'s report is clean (${said}), so it backs only ${cleanKind}.` : undefined;
  // A report with findings backs a clean verdict after the chief's triage: the cycles rule (T483 decision).
  const rows = read(dir, "findings").filter((f) => f.task === task.id && ofRun(f, run.id) && f.severity !== "low");
  const open = rows.filter((f) => f.status === "open");
  if (open.length && !found) return `${run.id}'s report has findings (${said}), and ${open.map((f) => `${f.key} (${f.severity})`).join(", ")} ${open.length === 1 ? "is" : "are"} still open: so it backs ${problemKind}, or ${cleanKind} after each one is dismissed with a reason, moved or closed.`;
  const decisions = read(dir, "decisions"), needed = report.severities.filter((s) => s !== "low");
  if (!unheld(rows, decisions, task, run.id, report.findings).length) return undefined;
  // The rows by severity, as the report gives its findings, so the line says which severity lacks a row (F-T294-6).
  const held = [...rows.map((f) => f.severity), ...movedOf(decisions, task, run.id, "medium").map(() => "medium")];
  const tally = ["high", "medium"].map((s) => [held.filter((v) => v === s).length, s]).filter(([n]) => n).map(([n, s]) => `${n} ${s}`).join(" and ") || "none";
  // --key with the run's prefix: a retry finds the same row, so a lost reply adds no second one.
  const record = `record each one first (sage finding add ${task.id} --source ${run.role} --run ${run.id} --key ${run.id}-<its key> --class <class> --severity <its severity> --summary "<the problem>")`;
  return `${run.id}'s report has ${needed.length} medium or high finding${needed.length === 1 ? "" : "s"} (${said}), and ${task.id} holds ${tally} of ${run.id}, but each one needs a row at its severity or above: ${found ? `${record}, then record ${kind}.` : `so it backs ${problemKind}. For ${cleanKind}, ${record}, then dismiss it with a reason, move it or close it.`}`;
}

/**
 * The tables after a takeover answer, from the tables before it: the one write of the design's table, with the gate's
 * answer. An approve sets the chief, clears an open offer and ends the runs. A decline with an offer ends only that offer.
 */
function replaceDelta({ reference: { gate, task, to, runs, offer }, result: { at, answer } }, rows) {
  const row = rows.tasks.find((t) => t.id === task), asked = rows.gates.find((g) => g.id === gate);
  if (!row || !asked || runs.some((id) => !rows.runs.some((r) => r.id === id))) return false;
  if (offer !== undefined) {
    if (offerOf(row)?.id !== offer) return false;
    row.offer = "";
  } else Object.assign(row, { chief: to, ...(row.offer ? { offer: "" } : {}) });
  for (const run of rows.runs) if (runs.includes(run.id)) Object.assign(run, { status: "failed", ended: at });
  asked.answer = answer;
  rows.decisions.push({ at, task, decision: `${asked.question} → ${answer}`, why: "the user's answer" });
  return true;
}
function validateReplaceWrite(receipt, tables) {
  const deny = () => refuse("The saved Replace is damaged. No table changed.");
  const { reference, result } = receipt;
  if (typeof reference?.gate !== "string" || typeof reference.task !== "string" || !CHIEF.test(reference.to) || !Array.isArray(reference.runs)
    || !["undefined", "string"].includes(typeof reference.offer) || typeof result?.at !== "string" || typeof result.answer !== "string") deny();
  if (!tables) return;
  const columns = savedWriteColumns(tables, deny);
  const rows = Object.fromEntries(Object.entries(tables).map(([table, { before }]) => [table, rowsOf(sheetText(before))]));
  if (!replaceDelta(receipt, rows) || Object.keys(tables).some((table) => tables[table].after !== tableText(table, rows[table], columns[table]))) deny();
}
const REPLACE_TABLES = ["tasks", "runs", "gates", "decisions"];
const replaceWrites = recordedWrites({ schema: 9, tables: REPLACE_TABLES, folder: "replace-requests",
  name: /^[0-9a-f]{64}\.json$/, receiptName: reference => createHash("sha256").update(JSON.stringify(reference)).digest("hex") + ".json", validate: validateReplaceWrite });

/**
 * The writer of each schema of a saved change. Schemas 2 to 6 and 8 were the Codex native runtime's writers (T914): a saved
 * change of one of them cannot finish, so it stops writes until the owner accepts its loss (sage logbook repair).
 */
const SAVED = { 7: usageWrites, 9: replaceWrites };
/**
 * Step 3 of every writer, and of a read that takes the lock. Call under the lock. A file fault leaves the marker for the
 * next writer, and its error keeps the code, so that a caller reads the outcome as uncertain.
 */
function settle(dir) {
  let settled;
  try { settled = settlePendingWrite(dir, SAVED); }
  catch (error) { throw settleFailure(dir, error); }
  if (settled) status(dir, true);
}
/** The request of a saved change, for a line that names it, only in a form that prints safely. */
const savedRequest = (dir) => {
  const request = pendingRequest(dir);
  return new RegExp(`^(?:R[1-9]\\d{0,9}|${UUID})$`).test(request) ? ` (request ${visible(request)})` : "";
};
function settleFailure(dir, error) {
  if (!error.code) return Object.assign(new RecordedWriteError(STUCK_WRITE), { code: "stuck-write" });
  return Object.assign(new RecordedWriteError(`A saved change${savedRequest(dir)} did not finish because of a file error (${error.code}). The saved change stays. Run the command again. If it repeats, check the logbook folder permissions.`), { code: error.code });
}
/**
 * The one way past a stuck saved change: the owner accepts its loss. It refuses, with no change, unless the marker truly
 * cannot finish, here or from the real folder or on a newer sage, the next write can work, and decisions.tsv can take the
 * decision row. It writes nothing itself.
 */
function stuckChange(dir, skip, env) {
  if (!hasPendingWrite(dir)) refuse("This logbook has no saved change, so there is nothing to repair. Nothing changed.");
  const real = realpathSync(dir);
  if (real !== resolve(dir)) refuse(`This logbook is reached through a link, so its saved change may finish from the real folder ${visible(real)}. Nothing changed. Run sage on a path with no link. When ${visible(dir)} is the link itself, move the real folder there, in place of the link. When a folder above it is the link, set ${isShared(dir, env) ? "SAGE_SHARED_HOME" : "SAGE_HOME"} to ${visible(realpathSync(dirname(dir)))}. Then any write finishes the change or says what to do.`);
  try { verifyPendingWrite(dir, SAVED); }
  catch (error) {
    const failure = settleFailure(dir, error);
    if (failure.code !== "stuck-write") throw failure;
    const newest = Math.max(...Object.keys(SAVED));
    if (Number.isSafeInteger(error.schema) && error.schema > newest) refuse(`This saved change has schema ${error.schema}, and this version of sage knows schemas up to ${newest}: a newer sage wrote it and may finish it. Nothing changed. Update the sage plugin and restart this session. Then any write finishes the change or says what to do.`);
    for (const table of Object.keys(TABLES)) {
      let cols = [];
      try { ({ cols } = sheet(dir, table)); }
      catch (damaged) {
        if (!(damaged instanceof Refusal)) throw damaged;
        if (table === "decisions" && !skip.includes(table)) refuse(`The repair records its decision first, and decisions.tsv fails the logbook check: ${damaged.fault ?? damaged.message} Nothing changed. If the owner accepts the loss of those rows too, run: sage logbook repair --accept-change-loss yes --accept-loss decisions --project <the project>.`);
      }
      knownColumns(dir, table, cols);
    }
    const marker = join(dir, PENDING);
    return { request: savedRequest(dir), marker, aside: lostName(marker) };
  }
  refuse("This saved change can finish, so it needs no repair: any write in this project finishes it. Nothing changed.");
}

/** git in a folder, with no GIT_ variable of the caller: repository-selection and injected-config variables cannot redirect it. */
const gitIn = (folder, env) => (args) => git(["-C", folder, ...args], Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith("GIT_"))));

/**
 * Where a branch lives: the checkout of its newest writer run, or the project of the command when that run names none
 * (a legacy logbook, or a run from before T625). The checkout must be the root of a bindings.tsv row of this logbook's
 * folder, so that a table cell alone never chooses the folder for git. A gone folder refuses with the run's ID.
 */
function branchCheckout(dir, project, branch, env) {
  const writer = read(dir, "runs").filter((r) => WRITERS.includes(r.role) && sameBranch(r.branch, branch))
    .sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1))).at(-1);
  if (!writer?.checkout) return project;
  const row = bindings(dirname(dir)).find((r) => r.folder === basename(dir) && r.root === writer.checkout);
  if (!row) refuse(`The checkout of ${writer.id} is not a checkout of this logbook in bindings.tsv, so sage cannot read ${branch}. Nothing changed.`);
  if (checkoutGone(row)) refuse(`The checkout of ${writer.id} (${visible(basename(row.root))}) is gone, so sage cannot read ${branch}. Nothing changed.`);
  return row.root;
}
/**
 * The tip of a branch where it lives (branchCheckout), or "" on any failure, so that a hook fails closed. When the local
 * branch is behind origin's copy (its tip is an ancestor of refs/remotes/origin/<branch>, as after gh pr update-branch
 * and a fetch), the tip is origin's (T670). A local branch that is ahead or has diverged stays as it is: nothing replaces it.
 */
function branchTip(project, branch, env = process.env) {
  try {
    const run = gitIn(branchCheckout(storeDir(project, env), project, branch, env), env);
    const tip = (ref) => run(["rev-parse", "--verify", `${ref}^{commit}`]).trim();
    const local = tip(`refs/heads/${branch}`);
    try {
      const origin = tip(`refs/remotes/origin/${branch}`);
      run(["merge-base", "--is-ancestor", local, origin]); // exits 1 when local is not behind
      return origin;
    } catch {
      return local;
    }
  } catch {
    return "";
  }
}

/** The columns that a write gives a table: all, but a sparse column only when a row has it. */
const columnsOf = (table, rows) => tableCols(table).filter((c) => !SPARSE[table]?.includes(c) || rows.some((r) => Object.hasOwn(r, c)));
function tableText(table, rows, cols = columnsOf(table, rows)) {
  return [cols.join("\t"), ...rows.map((r) => cols.map((c) => cell(r[c])).join("\t"))].join("\n") + "\n";
}
function write(dir, table, rows) {
  put(join(dir, `${table}.tsv`), tableText(table, rows));
}

const now = () => new Date().toISOString().slice(0, 19) + "Z";
/** The cells that hold ids: each table's own id, the columns that name the id of another row, and a decision's subject. */
const IDS = { tasks: ["id", "keys", "waits", "milestone"], runs: ["id", "task"], findings: ["task", "key", "run"], ledger: ["task", "run"], gates: ["id", "task"], decisions: ["task"], milestones: ["id", "pilot", "gate"] };
/**
 * A new id: the highest whole number after the prefix that any id cell of the logbook names, plus 1. So an id never
 * comes back, also when its own row is lost while another row (a verdict's or a finding's run, a decision, a round's keys) still names
 * it. Free text does not count: a path or a title can hold "-T9" by chance. In a decision, only its subjects count: the
 * first word ("F-T2-1 opened again", "G1 was answered by phone"), and in a move, also the new task and key ("F-T1-1 moved
 * to T2 as F-T2-1: …"). Only digits count ("Infinity" does not), and BigInt keeps a long number exact.
 */
/**
 * The ids a decision is about: its first word, and the new task and key of a move. Only finding move writes the move form,
 * and its why says "the follow-up task", so free text in another row, such as a release's name, takes no id (T1003).
 */
const subjects = ({ decision, why }) => (why.startsWith("the follow-up task") && /^(\S+) moved to (\S+) as (\S+):/.exec(decision)?.slice(1)) || [decision];
function nextId(dir, prefix) {
  let max = 0n;
  const take = (text, re) => {
    for (const [, n] of text.matchAll(re)) if (BigInt(n) > max) max = BigInt(n);
  };
  for (const [table, cols] of Object.entries(IDS)) {
    for (const row of read(dir, table)) {
      for (const c of cols) take(row[c], new RegExp(`(?<![A-Za-z0-9])${prefix}(\\d+)`, "g"));
      if (table === "decisions") for (const word of subjects(row)) take(word, new RegExp(`^${prefix}(\\d+)(?![A-Za-z0-9])`, "g"));
    }
  }
  return `${prefix}${max + 1n}`;
}
/** The words of each id floor that the move writes: the prefixes that count across the whole logbook. A finding's key counts within its task. */
const FLOORS = { T: "task", R: "run", G: "gate", M: "milestone" };
/**
 * The move's id floors (T641): for each prefix, one decision row in the new logbook whose first word is the highest id
 * of the old logbooks, so that nextId, also an older sage's, never gives an old number again. sources are the old
 * logbooks, as locate's old lists them. The caller holds the new logbook's lock. A prefix with no id gets no row.
 */
function writeIdFloors(dir, sources) {
  const floors = idFloors(sources);
  if (floors.length) write(dir, "decisions", [...read(dir, "decisions"), ...floors]);
  return floors;
}
/** The floor rows of writeIdFloors, which a repair of a moved logbook's decisions also writes again (F-T641-8). */
function idFloors(sources) {
  const from = [...new Set(sources.map((s) => s.provider ?? s.dir))].join(" and "), at = now();
  return Object.entries(FLOORS).map(([prefix, noun]) => {
    const top = sources.map((s) => BigInt(nextId(s.dir, prefix).slice(prefix.length)) - 1n).reduce((a, b) => (b > a ? b : a), 0n);
    return top > 0n && { at, task: "", decision: `${prefix}${top} is the ${noun} floor of the move from ${from}`, why: "the move keeps every new id above the ids of the old logbooks" };
  }).filter(Boolean);
}
/**
 * The round keys that name no finding: a key that the move carried for a finding that closed before it (F-T640-61). Only its
 * decision row keeps it taken after the next round, so a new decisions table takes one row for each again (F-T648-5).
 */
function keyFloors(dir) {
  let tasks = [], findings = [];
  try { tasks = read(dir, "tasks"); findings = read(dir, "findings"); } catch {}
  const have = new Set(findings.map((f) => `${f.task} ${f.key}`)), at = now();
  // The keys that the move carried stay in the task's adoption record after the round that held them ended (F-T648-7).
  const carried = (t) => { try { const k = JSON.parse(t.adoption || "{}").carried; return Array.isArray(k) ? k.filter((x) => typeof x === "string" && x.startsWith(`F-${t.id}-`) && /^F-T[1-9]\d*-[1-9]\d*$/.test(x)): []; } catch { return []; } };
  return tasks.flatMap((t) => [...new Set([...roundKeys(t), ...carried(t)])].filter((k) => !have.has(`${t.id} ${k}`)).map((k) => ({ at, task: t.id, decision: `${k} is a round key of ${t.id} with no finding`, why: "the repair keeps the round's keys, and no new finding takes this key" })));
}
/** The old logbooks of a moved logbook, from its sources.tsv, that are still on the disk: a repair takes their floors again. */
function movedFrom(dir) {
  try {
    const text = readRegular(join(dir, "sources.tsv"), { link: false, max: 65536 });
    return text ? rowsOf(sheetText(text)).filter((r) => isAbsolute(r.path ?? "") && existsSync(join(r.path, "tasks.tsv"))).map((r) => ({ provider: r.provider || null, dir: r.path })) : [];
  } catch {
    return [];
  }
}

/*
 * The move (T640, PR 7b of the shared logbook). `sage move` takes the open work of a project's old logbooks (its Claude
 * and Codex logbooks, and those of its clones) into one new shared logbook, once, after the owner's answer to one gate:
 *   --preview     reads, takes no lock and changes nothing: what moves, the new numbers, the checks, and the plan.
 *   --plan <p>    opens the move gate in this provider's logbook, if the logbooks still give plan p.
 *   --gate <G>    the move itself, after the owner answered G: under the shared root's lock and each old logbook's lock,
 *                 it checks again, saves the plan, builds the new logbook, marks the old ones, links the checkouts,
 *                 counts what it wrote, and removes the plan. A stop at any step: the same command finishes it.
 * The plan is a fingerprint of everything that the move would write, so the owner's answer covers what the preview showed.
 * While moves/<folder>.json exists, every command of the project refuses and names the command (locate). The texts are in
 * move-text.mjs. Runs, verdicts, the ledger and kept reports never move; a moved task gets fresh reviews and QA.
 */
const NO = { throwIfNoEntry: false };
const hash = (text) => createHash("sha256").update(text).digest("hex");
/** The parts of a plan that its digest covers, in this order: a saved plan's digest is computed again from them (F-T640-50). */
const PLAN_CONTENT = ["version", "folder", "checkout", "sources", "checkouts", "floors", "next", "rows", "standing", "config", "marks", "map"];
const planDigest = (plan) => hash(JSON.stringify(Object.fromEntries(PLAN_CONTENT.map((k) => [k, plan[k]]))));
const idNumber = (id) => BigInt(String(id).replace(/^\D+/, ""));
const byIdNumber = (a, b) => (idNumber(a.id) < idNumber(b.id) ? -1 : idNumber(a.id) > idNumber(b.id) ? 1 : 0);
/**
 * Why a test write failed, in plain words (F-T640-17): EACCES is the folder's rights, EPERM a sandbox (as the Codex one)
 * or a lock of the system. Any other code prints as it is.
 */
const WRITE_REFUSED = { EACCES: "no write permission", EPERM: "a sandbox or the system does not permit it", EROFS: "the disk is read-only" };
/** A task in verifying, verified or pr-ready goes back to reviewing: its verdicts stay in the old logbook. */
const BACK = ["verifying", "verified", "pr-ready"];
/** The fixed first line of a move gate, which holds the first 8 hex of the plan, and its option that records a provider as unused. */
const MOVE_HEAD = /^move · plan ([0-9a-f]{8})$/;
const UNUSED = /^move, and record ([a-z][a-z0-9-]*) as unused$/i;
const moveOf = (gate) => MOVE_HEAD.exec(String(gate?.question ?? "").split(LINE)[0])?.[1];
/** Whether the owner answered a move gate with a move: its first option, or "move, and record <provider> as unused". */
const movesOn = (g) => !!g.answer && (g.answer === optionsOf(g)[0] || (optionsOf(g).includes(g.answer) && UNUSED.test(g.answer)));
const planFile = (shared, folder) => join(shared, MOVES, `${folder}.json`);
const askedFile = (shared, folder, gate) => join(shared, MOVES, `${folder}.${gate}.asked.json`);
/** The files of an old logbook that the move reads: a re-run finds out whether one changed after the plan was saved. */
const RAW = [...Object.keys(TABLES).map((t) => `${t}.tsv`), "standing.md", "config.json", "checkout.txt", PENDING];
const rawDigest = (dir) => hash(JSON.stringify(RAW.map((f) => readRegular(join(dir, f)) ?? null)));
/** Adds a new shared logbook to the shared root's known project list. The caller holds the root's lock (link, the move). */
const enroll = (root, folder, make) => known(root, folder, make, false, true);
const withLocks = (dirs, fn) => (dirs.length ? withLock(dirs[0], () => withLocks(dirs.slice(1), fn)) : fn());
/** A test stops a move after a step, as a Mac that sleeps there would (SAGE_TEST_MOVE_STOP, only under node --test). */
const testStop = (env, step) => {
  if (process.env.NODE_TEST_CONTEXT && env.SAGE_TEST_MOVE_STOP === String(step)) throw new Error(`test stop after step ${step}`);
};
/** A path as the chat shows it: ~ for the home folder. */
const shownPath = (env) => (path) => (env.HOME && path.startsWith(`${env.HOME}/`) ? `~${path.slice(env.HOME.length)}` : path);
/** The day of the move in the heading of the moved standing orders, set when the logbook is built, so the plan does not change at midnight. */
const DAY = "\u0000day";
/** The heading that the move writes before each later logbook's standing orders, as the end check finds it: the split keeps it in its part. */
const MOVED_HEADING = /\n(?=## From the [^\n]+ logbook \(moved [^\n;]+; the old [A-Z][a-z]* number in brackets\)\n)/;
/** Keeps a table's columns, and leaves out an empty column that only some logbooks have (a moved task starts with no chief or offer). */
const keepColumns = (table, row) => Object.fromEntries(TABLES[table].filter((c) => Object.hasOwn(row, c) && !(SPARSE[table]?.includes(c) && !row[c])).map((c) => [c, row[c]]));

/** What the move works on: this checkout, the shared root, the new folder, and every old logbook of the repository. */
function moveScope(project, env) {
  const checkout = projectRoot(resolve(project)), shared = rootOf(env), folder = folderOf(checkout);
  if (lstatSync(shared, NO)?.isSymbolicLink()) refuse(`refused: the shared root ${visible(shared)} is a link, and the board reads no project there. Nothing changed. Ask the owner to set SAGE_SHARED_HOME to the folder itself.`);
  const rows = bindings(shared), { sources, checkouts, gone, forks } = repositoryLogbooks(checkout, env), key = checkouts[0].root;
  for (const { file, plan } of movePlans(shared)) if (!plan || plan.folder === folder || plan.sources?.some((s) => sources.some((o) => sameDir(s?.dir, o.dir)))) refuse(stoppedText(plan, file));
  const linked = rows.find((r) => checkouts.some((c) => c.root === r.root));
  if (linked) refuse(linked.root === key ? `refused: this project already uses the shared logbook ${linked.folder}, so nothing moves. Nothing changed.` : `refused: the checkout ${visible(linked.root)} of this repository already uses the shared logbook ${linked.folder}, and a checkout has one logbook. Nothing changed. Ask the owner which project it belongs to.`);
  if (!sources.length) refuse("refused: this project has no logbook in the Claude or the Codex root, so nothing moves. Nothing changed.");
  if (lstatSync(join(shared, folder), NO)) refuse(`refused: the folder ${visible(join(shared, folder))} is already in the shared root, so the new logbook has no place. Nothing changed. Ask the owner to rename or remove it.`);
  return { checkout, key, shared, folder, sources, checkouts, gone, forks, own: join(sageRoot(env), folder) };
}

/** The refusal of a provider whose plugin may still write an old logbook without the move's rules. */
function pluginRefusal(waiting, env) {
  const rows = pluginRows(env), [first] = waiting;
  const head = !first.provider ? `refused: the logbook root ${visible(first.path)} has no provider name; the move needs each root's provider`
    : first.contract === null ? `refused: the ${title(first.provider)} plugin has no row in plugins.tsv; the move needs contract ${2}` : `refused: the ${title(first.provider)} plugin is at contract ${visible(first.contract)}; the move needs 2`;
  const line = (name) => {
    const row = rows.find((r) => r.provider === name);
    return `  ${title(name).padEnd(8)}${row ? `contract ${visible(row.contract).padEnd(4)}written ${localTime(row.at).date} ${localTime(row.at).clock}` : name === provider ? "contract 2   this session" : "no row"}`;
  };
  return [head, ...[...new Set([provider, ...rootsOf(env).map((r) => r.provider), ...rows.map((r) => r.provider)].filter(Boolean))].map(line), "Nothing changed."].join("\n");
}

/**
 * The plan of the move: every row that it would write, the old-to-new numbers, the counts and the checks, from the old
 * logbooks as they are now. gate is the move gate { dir, id }: it takes its G number before the floors, so the moved gates
 * start after it. The same logbooks give the same plan, so the digest tells the move whether they changed.
 */
function movePlan(scope, env, gate) {
  const { folder, sources, key } = scope, shown = shownPath(env);
  const books = sources.map((s, i) => {
    if (lstatSync(join(s.dir, "moved.json"), NO)) refuse(`refused: the logbook ${visible(s.dir)} has a moved marker (moved.json), but no move of it runs. Nothing changed. Ask the owner to check that folder.`);
    for (const [table, { cols }] of Object.entries(check(s.dir))) knownColumns(s.dir, table, cols);
    return { ...s, i, rows: Object.fromEntries(Object.keys(TABLES).map((t) => [t, read(s.dir, t)])) };
  });
  const named = (b, id) => `${title(b.provider)} ${id}`;
  // Only the chief of a logbook's provider writes that logbook, so a refusal that names a command says whose (F-T640-60).
  const chief = (b) => `the ${title(b.provider)} chief runs it`;
  // A damaged adoption cell, of an open task or of a finished task that moves with its milestone, names its file and row (F-T647-2).
  const damaged = (b, t) => refuse(`refused: ${visible(join(b.dir, "tasks.tsv"))} has a damaged adoption cell in the row of ${visible(t.id)}, so the move cannot keep the task's record. Nothing changed. Ask the owner to fix that row.`);
  const running = books.flatMap((b) => b.rows.runs.filter((r) => !RUN_ENDS.includes(r.status)).map((r) => ({ b, r })));
  if (running.length) refuse([`refused: ${running.length === 1 ? "1 run is" : `${running.length} runs are`} running in this project`, ...running.map(({ b, r }) => `  ${title(b.provider).padEnd(8)}${visible(r.id).padEnd(7)}${visible(r.task).padEnd(6)}${visible(r.role).padEnd(11)}started ${localTime(r.started).clock}`), "The move needs zero running runs. Nothing changed."].join("\n"));
  // This tool runs the move's contract, so its own provider is ready. A provider with no row may be one that the owner does not use.
  const waiting = waitingPlugins(env).filter((w) => w.provider !== provider), norow = waiting.filter((w) => w.provider && w.contract === null).map((w) => w.provider);
  const blocked = waiting.filter((w) => !norow.includes(w.provider));
  if (blocked.length) refuse(pluginRefusal(blocked, env));
  // The writability check: a test file in each old logbook and in the shared root (or the folder that will hold it).
  let base = scope.shared;
  while (!existsSync(base) && dirname(base) !== base) base = dirname(base);
  const tried = [...books.map((b) => [`${title(b.provider)} logbook folder`, b.dir]), ["shared root", base]].map(([what, dir]) => {
    const file = join(dir, `.sage-move-test-${randomUUID()}`);
    try {
      writeFileSync(file, "", { flag: "wx" });
      unlinkSync(file);
      return { what, dir, why: "" };
    } catch (e) {
      return { what, dir, why: WRITE_REFUSED[e.code] ?? e.code ?? e.message };
    }
  });
  const unwritable = tried.filter((t) => t.why);
  if (unwritable.length) refuse([`refused: cannot write the ${unwritable.map((t) => t.what).join(" and the ")}`, ...tried.map((t) => `  ${shown(t.dir).padEnd(27)}  ${t.why ? `test write refused (${t.why})` : "ok"}`), "Nothing changed. Ask the other provider's chief to move the project."].join("\n"));

  const real = (dir) => { try { return realpathSync(dir); } catch { return dir; } };
  // A task that a task of another old logbook adopted moves with it: its row gets the adopter's new number (F7).
  const adopted = new Map();
  for (const b of books) {
    const ids = new Set();
    for (const t of b.rows.tasks) {
      if (!TASK_ID.test(t.id) || ids.has(t.id)) refuse(`refused: ${visible(join(b.dir, "tasks.tsv"))} has ${ids.has(t.id) ? `two rows for ${t.id}` : `a row whose id is not a task id (${visible(t.id)})`}, so the move cannot number its tasks. Nothing changed. Ask the owner to fix that row.`);
      ids.add(t.id);
    }
    for (const t of b.rows.tasks.filter((t) => !ENDED.includes(t.state) && t.adoption)) {
      let a;
      try { a = adoptionOf(t); } catch (e) { if (e instanceof Refusal) damaged(b, t); throw e; }
      if (a.version !== 1) refuse(`refused: ${named(b, t.id)} has an adoption record of version ${a.version}, which only a move writes. Nothing changed. Ask the owner to check ${visible(b.dir)}.`);
      const from = books.find((o) => o !== b && o.provider === a.provider && real(o.dir) === a.logbook);
      if (from) adopted.set(`${from.i} ${a.task}`, `${b.i} ${t.id}`);
    }
  }
  const top = (prefix) => books.reduce((m, b) => { const n = idNumber(nextId(b.dir, prefix)) - 1n; return n > m ? n : m; }, prefix === "G" && gate && books.some((b) => b.dir === gate.dir) ? idNumber(gate.id) : 0n);
  const floors = Object.fromEntries(Object.keys(FLOORS).map((p) => [p, top(p)])), counter = { ...floors };
  const next = (p) => `${p}${(counter[p] += 1n)}`;
  // A chain of adoptions (Codex T3 adopted Claude T2, which adopted Codex T1) ends at the task that moves (F-T640-49).
  const adopter = (k, seen = []) => {
    if (!adopted.has(k)) return k;
    if (seen.includes(k)) { const [i, id] = k.split(" "); refuse(`refused: ${named(books[i], id)} is in a loop of adoptions, so no task of the loop moves. Nothing changed. Ask the owner to fix their adoption records.`); }
    return adopter(adopted.get(k), [...seen, k]);
  };
  // A milestone moves whole: its finished tasks, the pilot too, move with its open ones as finished rows, so that its pilot,
  // its breakdown approval and its done condition hold (F-T640-59).
  const going = (b, t) => !ENDED.includes(t.state) || adopted.has(`${b.i} ${t.id}`);
  const whole = new Set(books.flatMap((b) => b.rows.tasks.filter((t) => t.milestone && going(b, t)).map((t) => `${b.i} ${t.milestone}`)));
  const moves = (b, t) => (going(b, t) || whole.has(`${b.i} ${t.milestone}`)) && !adopted.has(`${b.i} ${t.id}`);
  // New numbers: Claude's first, then Codex's, each logbook's in old-number order (F5, F12: one map, made once).
  const ids = new Map(), moving = [];
  for (const b of books) for (const t of b.rows.tasks.filter((t) => moves(b, t)).sort(byIdNumber)) {
    ids.set(`${b.i} ${t.id}`, next("T"));
    moving.push({ b, t });
  }
  for (const from of adopted.keys()) ids.set(from, ids.get(adopter(from)));
  // Every old task that moves, as "<book> <id>": the moved tasks, then the adopted ones, whose rows (gates, findings, a
  // milestone) move with the task that adopted them (F-T640-1, F-T640-18).
  const rowOf = (k) => { const [i, id] = k.split(" "); return { b: books[i], t: books[i].rows.tasks.find((t) => t.id === id) }; };
  const milestoneIds = new Map();
  for (const b of books) for (const p of b.rows.milestones.filter((p) => [...ids.keys()].some((k) => rowOf(k).b === b && rowOf(k).t.milestone === p.id)).sort(byIdNumber)) milestoneIds.set(`${b.i} ${p.id}`, next("M"));
  for (const k of ids.keys()) { const { b, t } = rowOf(k); if (t.milestone && !milestoneIds.has(`${b.i} ${t.milestone}`)) refuse(`refused: ${named(b, t.id)} names the milestone ${visible(t.milestone)}, which its logbook lacks, so the move cannot map it. Nothing changed. Ask the owner to fix its milestone cell.`); }
  for (const [k] of milestoneIds) {
    const [i, id] = k.split(" "), b = books[i], p = b.rows.milestones.find((x) => x.id === id);
    const state = b.rows.tasks.find((t) => t.id === p.pilot)?.state;
    if (!ids.has(`${i} ${p.pilot}`)) refuse(`refused: ${named(b, id)}'s pilot ${visible(p.pilot)} ${state ? `is ${state}, but not a task of ${id}` : "is not in the logbook"}, so ${id} would lose its pilot. Nothing changed. Ask the owner to fix the pilot's milestone cell, or take the open tasks out of ${id} (sage task <T> set milestone=none; ${chief(b)}), then run the preview again.`);
  }
  // Gates: each gate of a moved task, answered ones too (approvals and a milestone's gate name them), and each open gate
  // with no task. A move gate stays. The open gates take the first numbers, so the owner's new gates are in one range.
  // An open gate of a finished task would stay in its old logbook, which is read-only after the move: no one could answer
  // it, and the board would not show it (F-T640-27). So the owner answers it first.
  // The refusal lists every such gate, so that the owner answers them all before the next preview (F-T640-34).
  const stranded = books.flatMap((b) => b.rows.gates.filter((g) => !g.answer && g.task && !moveOf(g) && !ids.has(`${b.i} ${g.task}`)).map((g) => ({ b, g, state: b.rows.tasks.find((t) => t.id === g.task)?.state })));
  // Each gate shows its options, so that the owner can answer it from this text, and the chief of its provider records the answer (F-T640-37).
  const whose = [...new Set(stranded.map(({ b }) => title(b.provider)))].map((p) => `the ${p} chief for a ${p} gate`);
  if (stranded.length) refuse([`refused: ${stranded.length === 1 ? "1 open gate is" : `${stranded.length} open gates are`} of a finished task, and a finished task does not move, so no one could answer ${stranded.length === 1 ? "it" : "them"} after the move`, ...stranded.map(({ b, g, state }) => `  ${title(b.provider).padEnd(8)}${visible(g.id).padEnd(7)}${visible(g.task).padEnd(6)}${(state ? visible(state) : "not in the logbook").padEnd(11)}${visible(g.question)} (options: ${optionsOf(g).map((o, i) => `${i + 1} ${visible(o)}`).join(", ")})`), `Nothing changed. Ask the owner to answer ${stranded.length === 1 ? "it" : "each one"} first. The chief of the gate's provider records the answer (sage gate answer <G> --option <n>): ${whose.join(", ")}. Then run the preview again.`].join("\n"));
  const gatesOf = (b) => b.rows.gates.filter((g) => !moveOf(g) && !(gate && b.dir === gate.dir && g.id === gate.id) && (g.task ? ids.has(`${b.i} ${g.task}`) : !g.answer));
  const gateIds = new Map(), gateRows = [];
  for (const open of [true, false]) for (const b of books) for (const g of gatesOf(b).filter((g) => !g.answer === open).sort(byIdNumber)) {
    gateIds.set(`${b.i} ${g.id}`, next("G"));
    gateRows.push({ b, g, open });
  }
  // The open findings of each moved task, then of each task that it adopted: new keys of the new task, in table order;
  // the summary names the old key.
  const keys = new Map(), findingRows = [], seq = new Map();
  const newKey = (id) => `F-${id}-${seq.set(id, (seq.get(id) ?? 0) + 1).get(id)}`;
  for (const [k, id] of ids) {
    const { b, t } = rowOf(k);
    for (const f of b.rows.findings.filter((f) => f.task === t.id && f.status === "open")) {
      const key = newKey(id);
      keys.set(`${b.i} ${t.id} ${f.key}`, key);
      findingRows.push({ b, f, key });
    }
  }
  // The ids in a moved gate's question get their new numbers, as its task cell does: a repair approval names its task, a
  // breakdown gate its milestone and tasks (F-T640-3), and a move approval its finding (F-T640-23). A whole finding key maps
  // first, through keys, because its new number is not its old one; a finding key that does not move stays whole. Then
  // the task and milestone ids. An id that does not move keeps its number. A key is unique only per task (finding add), so
  // a key maps through the gate's own task first, then through the one task of the logbook that has it; a key that two
  // other tasks have stays whole (F-T640-32).
  const keyTasks = books.map((b) => b.rows.findings.reduce((m, f) => m.set(f.key, [...(m.get(f.key) ?? []), f.task]), new Map()));
  const keyOf = (b, task, word) => {
    const tasks = keyTasks[b.i].get(word), owner = tasks?.includes(task) ? task : tasks?.length === 1 ? tasks[0] : "";
    return tasks && (keys.get(`${b.i} ${owner} ${word}`) ?? word);
  };
  const renumber = (b, task, text) => String(text).replace(/[\w-]+/g, (word) => keyOf(b, task, word)
    || word.replace(/\b(?:M|T)[1-9]\d*\b/g, (id) => (id.startsWith("M") ? milestoneIds : ids).get(`${b.i} ${id}`) ?? id));
  // A task with no milestone takes the milestone of a task that it adopted, so the pilot of that milestone is in it.
  const adoptedMilestone = (b, t) => [...adopted.keys()].filter((from) => adopter(from) === `${b.i} ${t.id}`).map(rowOf).find(({ t: o }) => o.milestone);
  const met = [], back = [], was = [], waits = {};
  const tasks = moving.map(({ b, t }) => {
    const id = ids.get(`${b.i} ${t.id}`), on = [], metHere = [], { ids: wanted, odd } = waitsOf(t);
    if (odd) refuse(`refused: ${named(b, t.id)} has text in its waits cell that is not a task id, so the move cannot map it. Nothing changed. Set its waits again first: sage task ${t.id} set waits=<task ids> (${chief(b)}).`);
    for (const w of wanted) {
      const to = ids.get(`${b.i} ${w}`), state = b.rows.tasks.find((x) => x.id === w)?.state;
      if (to) on.push(to);
      // A finished task of a milestone waits for nothing more, so its other waits stay as text in its decision row.
      else if (MET.includes(state) || ENDED.includes(t.state)) metHere.push(`${w} (${state ?? "not in the logbook"})`);
      else refuse(`refused: ${named(b, t.id)} waits for ${w}, which ${state ? "was abandoned" : "is not in the logbook"}, so it can never start. Nothing changed. Change its waits first (sage task ${t.id} set waits=<task ids>; ${chief(b)}), then run the preview again.`);
    }
    met.push(...metHere);
    waits[b.provider] = (waits[b.provider] ?? 0) + on.length;
    // The adoption record of version 2: the old task, its logbook, its round, and its PR and branch, which stay its own.
    let from;
    try { from = t.adoption ? JSON.parse(t.adoption) : undefined; } catch { damaged(b, t); }
    const record = { version: 2, provider: b.provider, task: t.id, logbook: real(b.dir), project: b.checkout, round: Number(t.round), digest: hash(JSON.stringify(t)) };
    const cycles = cyclesFor(t, config({ ...env, SAGE_HOME: dirname(b.dir) }));
    if (Number.isSafeInteger(cycles) && cycles >= 1) record.cycles = cycles;
    if (PR.test(prNumber(t.pr) ?? "")) record.pr = prNumber(t.pr);
    if (t.branch && (ofTask(t.id, t.branch) || t.branch === from?.branch)) record.branch = t.branch;
    if (from) record.from = from;
    if (!adoptionV2(record)) refuse(`refused: ${named(b, t.id)} has a round, PR or branch cell that the move cannot keep (round ${JSON.stringify(visible(t.round))}). Nothing changed. Ask the owner to fix its row first.`);
    if (BACK.includes(t.state)) back.push(t.state);
    // A round key whose finding closed stays a key of the round with a new key of its own, which names no row, so that the
    // next round counts as before the move: a round replans only when every key of the last round is open again (F-T640-61).
    // Its decision row has the new key as its first word, so nextId counts it after the next round too (F-T647-4).
    const closed = [], round = roundKeys(t).map((k) => {
      const key = keys.get(`${b.i} ${t.id} ${k}`);
      if (key) return key;
      const fresh = newKey(id);
      closed.push({ at: "", task: id, decision: `${fresh} was the round key ${k} of ${named(b, t.id)}, whose finding closed before the move`, why: "the move keeps the round's keys, and no new finding takes this key" });
      return fresh;
    });
    // The board shows this row, so it names the old logbook's folder, never a path of the Mac (F-T640-13).
    // The adoption record keeps the carried keys too: a later round drops them from the keys cell, and a repair of the
    // decisions takes them again from this record, so no new finding takes one (F-T648-7).
    if (closed.length) record.carried = closed.map((c) => c.decision.split(" ")[0]);
    was.push({ at: "", task: id, decision: `${id} was ${named(b, t.id)}`, why: [`the move from the ${title(b.provider)} logbook ${basename(b.dir)}`, `its pages stay in ${basename(b.dir)}/pages/${t.id} of the worktree root`, metHere.length && `waits met before the move: ${metHere.join(", ")}`, BACK.includes(t.state) && `${t.state} → reviewing, because its verdicts stay in the old logbook`].filter(Boolean).join("; ") }, ...closed);
    const via = !t.milestone && adoptedMilestone(b, t);
    return keepColumns("tasks", { ...t, id, state: BACK.includes(t.state) ? "reviewing" : t.state, keys: round.join(","), waits: on.join(","), milestone: t.milestone ? milestoneIds.get(`${b.i} ${t.milestone}`) : via ? milestoneIds.get(`${via.b.i} ${via.t.milestone}`) : "", approvals: list(t.approvals).map((g) => gateIds.get(`${b.i} ${g}`)).filter(Boolean).join(","), adoption: JSON.stringify(record), chief: "", offer: "" });
  });
  const findings = findingRows.map(({ b, f, key: k }) => keepColumns("findings", { ...f, task: ids.get(`${b.i} ${f.task}`), key: k, run: "", summary: `${f.summary} (was ${named(b, f.key)})` }));
  const gates = gateRows.map(({ b, g }) => keepColumns("gates", { ...g, id: gateIds.get(`${b.i} ${g.id}`), task: g.task ? ids.get(`${b.i} ${g.task}`) : "", question: renumber(b, g.task, g.question) }));
  const milestones = [...milestoneIds].map(([k, id]) => {
    const [i, old] = k.split(" "), p = books[i].rows.milestones.find((x) => x.id === old);
    // A gate that its logbook lost gets a new number that names no gate, so the milestone stays as it was (its gate not in
    // the logbook) and its row stays one that the board reads: a gate cell is never empty (F-T640-38).
    return keepColumns("milestones", { ...p, id, pilot: ids.get(`${i} ${p.pilot}`), gate: gateIds.get(`${i} ${p.gate}`) ?? next("G") });
  });
  // prHistory reads a task's PR decisions, so a moved task stays in the merge check of each PR that it ever had.
  const decisions = [...moving.flatMap(({ b, t }) => b.rows.decisions.filter((d) => d.task === t.id && /^PR (\S+) → (\S+)$/.test(d.decision)).map((d) => ({ ...d, task: ids.get(`${b.i} ${t.id}`) }))), ...was];
  // Standing orders: the first logbook's as they are, then each other's under a heading, numbered on, the old number in brackets.
  const texts = books.map((b) => readRegular(join(b.dir, "standing.md")) ?? "");
  let count = (texts[0].match(/^\d+\./gm) ?? []).length, standing = texts[0].trimEnd() || "# Standing orders";
  const parts = [{ provider: books[0].provider, count, first: count ? 1 : 0, last: count, base: true }];
  // A line with no number stays where it is: under its order (a continuation) or under the heading (a note), and the end
  // check counts it (F-T640-21). Only the logbook's own title and the fixed first sentence before the list go: a heading
  // of the owner's own before the list stays (F-T640-31).
  const [head, , intro] = STANDING.split("\n");
  // A logbook that init made before T669 keeps its older first sentence until the chief edits it: it goes too.
  const intros = [head, intro, "Every brief carries these lines word for word. Add a line when you notice that you repeat an instruction."];
  for (const [i, b] of books.entries()) if (i) {
    const kept = [], first = count + 1;
    let orders = 0, notes = 0;
    for (const line of texts[i].split(/\r?\n/)) {
      const order = /^(\d+)\.\s*(.*)$/.exec(line);
      if (order) kept.push(`${count + ++orders}. ${order[2]} (${title(b.provider)} ${order[1]})`);
      else if (!line.trim()) { if (kept.length && kept.at(-1) !== "") kept.push(""); }
      else if (orders || !intros.includes(line.trim())) { kept.push(line); notes++; }
    }
    while (kept.at(-1) === "") kept.pop();
    count += orders;
    parts.push({ provider: b.provider, count: orders, first, last: count, ...(notes && { notes }) });
    if (!kept.length) continue;
    const label = `${title(b.provider)}${books.filter((o) => o.provider === b.provider).length > 1 ? ` (${basename(b.dir)})` : ""}`;
    standing += `\n\n## From the ${label} logbook (moved ${DAY}; the old ${title(b.provider)} number in brackets)\n\n${kept.join("\n")}`; // MOVED_HEADING reads it
  }
  // The owner's settings of the logbook (name, archive): the first logbook's win.
  const settings = books.map((b) => {
    const text = readRegular(join(b.dir, "config.json"));
    let parsed;
    try { parsed = text === undefined ? {} : JSON.parse(text); } catch {}
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) refuse(`refused: ${visible(join(b.dir, "config.json"))} is not a JSON object, so the move cannot keep the logbook's settings. Nothing changed. Ask the owner to fix or remove it.`);
    return parsed;
  });
  const merged = Object.assign({}, ...[...settings].reverse());
  const marks = books.map((b) => Object.fromEntries([...ids].filter(([k]) => k.startsWith(`${b.i} `)).map(([k, v]) => [k.slice(String(b.i).length + 1), v])));
  const finished = {};
  for (const b of books) finished[b.provider] = (finished[b.provider] ?? 0) + b.rows.tasks.filter((t) => ENDED.includes(t.state) && !ids.has(`${b.i} ${t.id}`)).length;
  // The finished tasks that move with their milestone (F-T640-59): the preview and the end check count them apart from the open ones.
  const done = moving.filter(({ t }) => ENDED.includes(t.state));
  const map = {
    tasks: [...ids].map(([k, id]) => { const [i, old] = k.split(" "), t = books[i].rows.tasks.find((x) => x.id === old); return { provider: books[i].provider, old, new: id, title: oneLine(t.title), adopted: adopted.has(k), ...(!adopted.has(k) && ENDED.includes(t.state) && { finished: true }) }; }),
    findings: findingRows.map(({ b, f, key: k }) => ({ provider: b.provider, task: f.task, old: f.key, new: k })),
    gates: gateRows.map(({ b, g, open }) => ({ provider: b.provider, old: g.id, new: gateIds.get(`${b.i} ${g.id}`), open })),
    milestones: [...milestoneIds].map(([k, id]) => ({ provider: books[k.split(" ")[0]].provider, old: k.split(" ")[1], new: id })),
    standing: parts, waits, finished,
  };
  // The releases move by name (T1003): each name once, the first logbook's row first, and each cell keeps its name.
  const releases = [];
  for (const b of books) for (const r of b.rows.releases) if (!releases.some((o) => releaseKey(o.name) === releaseKey(r.name))) releases.push(keepColumns("releases", r));
  const rows = { tasks, findings, gates, milestones, decisions, releases };
  // The board reads at most 4 MiB a file and 16 MiB in one read: the new logbook and its old logbooks must fit (F-T641).
  const sizes = Object.entries(rows).map(([t, r]) => [t, Buffer.byteLength(tableText(t, r))]);
  const old = books.reduce((n, b) => n + RAW.reduce((m, f) => m + (statSync(join(b.dir, f), NO)?.size ?? 0), 0), 0);
  const total = sizes.reduce((n, [, s]) => n + s, old) + Buffer.byteLength(standing);
  const large = sizes.find(([, s]) => s > 4 * 1024 * 1024);
  if (large || total > 16 * 1024 * 1024) refuse(`refused: the board could not read the moved project: ${large ? `its ${large[0]}.tsv would be ${(large[1] / 1048576).toFixed(1)} MiB, and the board reads at most 4 MiB a file` : `it and its old logbooks hold ${(total / 1048576).toFixed(1)} MiB, and the board reads at most 16 MiB`}. Nothing changed. Ask the owner to abandon finished work in an old logbook first.`);
  const content = {
    version: 1, folder, checkout: key, sources: books.map(({ provider: p, dir, checkout }) => ({ provider: p, dir, checkout })), checkouts: scope.checkouts,
    floors: Object.fromEntries(Object.entries(floors).map(([k, v]) => [k, String(v)])), next: { T: `T${counter.T + 1n}`, R: `R${counter.R + 1n}`, G: `G${counter.G + 1n}`, M: `M${counter.M + 1n}` },
    rows, standing: `${standing}\n`, config: Object.keys(merged).length ? merged : null, marks, map,
  };
  const plan = { ...content, digest: planDigest(content) };
  // The checks that the preview prints: each refusal above has passed.
  const pending = books.filter((b) => hasPendingWrite(b.dir));
  const either = books.length === 1 ? "the logbook" : books.length === 2 ? "either logbook" : "any logbook";
  // The other checkouts that the move links, by provider, each by its path: a clone and a fork look alike by count (F-T640-6).
  const linked = new Set(scope.checkouts.map((c) => c.root));
  const others = (p) => [...new Set(books.filter((b) => b.provider === p && b.checkout !== key && linked.has(b.checkout)).map((b) => b.checkout))];
  const branches = new Map();
  for (const { b, t } of moving) if (t.branch && !ENDED.includes(t.state)) branches.set(t.branch.toLowerCase(), [...(branches.get(t.branch.toLowerCase()) ?? []), { b, t }]);
  const checks = [
    ["ok", "no running runs"],
    pending.length ? ["warn", `a saved change waits in the ${pending.map((b) => title(b.provider)).join(" and the ")} logbook: the move finishes it first`] : ["ok", `no saved change in ${either}`],
    ["ok", `every wait resolves${met.length ? ` (${met.length === 1 ? "1 wait on a finished task counts" : `${met.length} waits on finished tasks count`} as met)` : ""}`],
    // Each folder by name: a provider with two logbooks (a clone's) names each one by its folder (F-T640-40).
    ["ok", `${tried.length} folders can be written: ${books.map((b) => `${title(b.provider)}${books.filter((o) => o.provider === b.provider).length > 1 ? ` (${basename(b.dir)})` : ""}`).join(", ")}, shared`],
    ...[...new Set([provider, ...rootsOf(env).map((r) => r.provider)].filter(Boolean))].map((p) => {
      const row = pluginRows(env).find((r) => r.provider === p);
      return norow.includes(p) ? ["warn", `${title(p)} plugin: no row in plugins.tsv, so the gate asks whether you use ${title(p)} here`] : ["ok", `${title(p)} plugin: ${p === provider ? `contract ${2}` : row.contract === "unused" ? "unused" : `contract ${visible(row.contract)}`}`];
    }),
    ...[...new Set(books.map((b) => b.provider))].filter((p) => others(p).length).map((p) => { const n = others(p).length; return ["warn", `${n} other ${title(p)} ${n === 1 ? "checkout" : "checkouts"} of this repository:`, `the move links ${n === 1 ? "it" : "them"} to the new logbook:`, ...others(p).map((c) => visible(shown(c)))]; }),
    ...scope.gone.map((p) => ["note", `${visible(shown(p))} is gone or has no first commit in common, so it gets no link`]),
    // A fork keeps its own logbook (T646): the preview and the gate name it, so the owner sees what stays out.
    ...scope.forks.map((f) => ["note", `${visible(shown(f.root))} is a fork: its GitHub remote is ${visible(f.remote)}, not ${visible(f.of)}.`, "It keeps its own logbook, and the move leaves it out."]),
    // The states that the tasks are in, each once (F-T640-63).
    ...(back.length ? [["note", `${back.length === 1 ? "1 task" : `${back.length} tasks`} in ${BACK.filter((s) => back.includes(s)).join(" or ")} ${back.length === 1 ? "goes" : "go"} back to reviewing`]] : []),
    ...[...branches.values()].filter((g) => g.length > 1).map((g) => ["note", `${[...new Set(g.map(({ b }) => b.provider))].map((p) => `${title(p)} ${g.filter(({ b }) => b.provider === p).map(({ t }) => t.id).join(" and ")}`).join(" and ")} share one branch: ${g.length === 2 ? "two" : g.length} tasks`]),
    ...[...adopted].map(([from, to]) => ["note", `${named(books[from.split(" ")[0]], from.split(" ")[1])} is adopted by ${named(books[to.split(" ")[0]], to.split(" ")[1])}, so it moves with it`]),
    ...(done.length ? [["note", `${done.length === 1 ? "1 finished task moves" : `${done.length} finished tasks move`} with ${done.length === 1 ? "its milestone" : "their milestones"}, as ${done.length === 1 ? "it is" : "they are"}: ${done.map(({ b, t }) => `${named(b, t.id)} (${t.state})`).join(", ")}`]] : []),
  ];
  return { plan, checks, norow, finished: Object.values(finished).reduce((n, k) => n + k, 0) };
}

/** sage move: the preview, the gate, or the move. Only the owner's answer to the gate starts the move. */
function moveCommand(project, opt, env) {
  const given = ["preview", "plan", "gate"].filter((o) => opt[o] !== undefined);
  if (given.length !== 1 || (opt.preview !== undefined && opt.preview !== true)) refuse("move takes one of --preview, --plan <plan> (the 8 hex that the preview printed) or --gate <G> (the answered move gate); --preview takes no value. Nothing changed.");
  if (opt.preview) {
    const scope = moveScope(project, env), own = scope.sources.find((s) => s.dir === scope.own);
    const { plan, checks } = movePlan(scope, env, own && { dir: own.dir, id: moveGateId(scope.sources) });
    return previewText(plan, checks);
  }
  return opt.plan !== undefined ? askMove(project, opt.plan, env) : runMove(project, opt.gate, env);
}

/** --plan: opens the move gate, if the old logbooks still give the plan that the owner saw in the preview. */
function askMove(project, shown, env) {
  if (!/^[0-9a-f]{8}$/.test(shown)) refuse("--plan takes the 8 hex of the plan that the preview printed, for example --plan 7c41e09a. Nothing changed.");
  const scope = moveScope(project, env);
  if (!scope.sources.some((s) => s.dir === scope.own)) refuse(`refused: this ${title(provider)} session has no logbook of this project, so it cannot hold the move gate. Nothing changed. Ask the chief of the other provider to run the move.`);
  notePlugin(env);
  mkdirSync(scope.shared, { recursive: true });
  return withLock(scope.shared, () => withLocks(scope.sources.map((s) => s.dir).sort(), () => {
    for (const s of scope.sources) ready(s.dir, env); // a saved change finishes first, under its lock
    // The same --plan again: the open gate of that plan is the answer, and no second gate opens (F-T640-43).
    for (const g of read(scope.own, "gates").filter((g) => !g.answer && moveOf(g) === shown)) {
      const again = movePlan(scope, env, { dir: scope.own, id: g.id });
      if (again.plan.digest.slice(0, 8) === shown) return gateText(g, g.question.split(LINE), moveAdvice(scope, again.norow));
    }
    const id = moveGateId(scope.sources), { plan, norow, finished } = movePlan(scope, env, { dir: scope.own, id });
    if (plan.digest.slice(0, 8) !== shown) refuse(changedText(null, plan, shown));
    if (norow.length > 1) refuse(pluginRefusal(norow.map((p) => ({ provider: p, contract: null })), env));
    const advice = moveAdvice(scope, norow), { unused, recommendation } = advice;
    const path = shownPath(env), others = plan.checkouts.filter((c) => c.root !== plan.checkout).map((c) => `${[...new Set(plan.sources.filter((s) => s.checkout === c.root).map((s) => title(s.provider)))].join(" and ")} ${visible(path(c.root))}`);
    const lines = gateQuestion(plan, finished, others, scope.forks.map((f) => visible(path(f.root))));
    // A provider with no row refuses a plain move at --gate, so the gate does not offer it (F-T640-20).
    const g = { id, task: "", question: lines.join(LINE), options: unused ? `move, and record ${title(unused)} as unused|keep` : "move|keep", recommendation, default: "keep", at: now() };
    write(scope.own, "gates", [...read(scope.own, "gates"), g]);
    status(scope.own, true);
    mkdirSync(join(scope.shared, MOVES), { recursive: true });
    swap(askedFile(scope.shared, scope.folder, id), JSON.stringify(plan));
    return gateText(g, lines, advice);
  }));
}

/** The recommendation of a move gate: move, or keep while a provider with no plugin row has a logbook of this repository. */
function moveAdvice(scope, norow) {
  const [unused] = norow, used = unused && scope.sources.some((s) => s.provider === unused);
  const recommendation = !unused ? "move" : used ? "keep" : `move, and record ${title(unused)} as unused`;
  const why = !unused ? ", because both plugins are ready and no run is running." : used ? `. This repository has ${title(unused)} checkouts, so you likely use ${title(unused)} here: update sage in ${title(unused)} first, then ask again. Choose 1 only if you never use ${title(unused)} on this project.` : `, because no ${title(unused)} logbook of this repository exists.`;
  return { unused, recommendation, why };
}
/**
 * The id of a new move gate: above every gate of each old logbook, not only of the logbook that holds it, so that no two
 * old logbooks hold a move gate of one id and --gate always finds one (F-T640-64).
 */
const moveGateId = (sources) => `G${sources.reduce((m, s) => { const n = idNumber(nextId(s.dir, "G")); return n > m ? n : m; }, 1n)}`;

/** --gate: the move, after the owner's answer, or the end of a move that stopped (the same command, from any checkout of the move). */
function runMove(project, gateId, env) {
  if (!GATE_ID.test(gateId ?? "")) refuse("--gate takes the move gate's id, for example --gate G104. Nothing changed.");
  const checkout = projectRoot(resolve(project)), shared = rootOf(env);
  notePlugin(env);
  // A saved plan of this project, from this checkout or from any other checkout that the move links (F-T640-2).
  const [stoppedMove] = projectMoves(checkout, env);
  if (stoppedMove) return finishMove(stoppedMove.file, gateId, checkout, env);
  let scope = moveScope(project, env);
  // The plan is made from the checkout whose logbook holds the gate, as --plan made it there: a clone gives the same plan.
  const holder = scope.sources.find((s) => read(s.dir, "gates").some((g) => g.id === gateId && moveOf(g)));
  if (holder && holder.checkout !== scope.key) scope = moveScope(holder.checkout, env);
  const { folder } = scope, file = planFile(shared, folder);
  mkdirSync(shared, { recursive: true });
  return withLock(shared, () => {
    if (lstatSync(file, NO)) refuse("refused: another move of this project started just now. Nothing changed. Run the same command again.");
    return withLocks(scope.sources.map((s) => s.dir).sort(), () => {
      for (const s of scope.sources) ready(s.dir, env);
      const found = scope.sources.flatMap((s) => read(s.dir, "gates").filter((g) => g.id === gateId && moveOf(g)).map((g) => ({ dir: s.dir, g })));
      if (found.length !== 1) refuse(`refused: ${gateId} is ${found.length ? "a move gate in more than one old logbook" : "not a move gate of this project's logbooks"}. Nothing changed. Run sage move --preview, then open the gate with sage move --plan <plan>.`);
      const [{ dir, g }] = found;
      if (!g.answer) refuse(`refused: ${g.id} has no answer yet, so nothing moves. Nothing changed. The owner answers it first.`);
      if (!movesOn(g)) refuse(`refused: the owner answered ${g.id} with "${visible(g.answer)}", so nothing moves. Nothing changed. To move later, run the preview again.`);
      // A move gate moves once: after a restore by hand, its answer does not move the project again (F-T647-1).
      if (read(dir, "decisions").some((d) => d.decision.startsWith(`${g.id} ${MOVED_BY} `)) || lstatSync(join(shared, `.${folder}.restored-${moveOf(g)}`), NO)) refuse(`refused: ${g.id} moved this project once already, and a move gate moves once: after a restore by hand, the owner answers a new gate. Nothing changed. Run sage move --preview, then open a new gate with sage move --plan <plan>.`);
      const { plan, norow } = movePlan(scope, env, { dir, id: g.id });
      if (plan.digest.slice(0, 8) !== moveOf(g)) {
        // A newer move gate asks about the logbooks of a later preview: this one is older, not a sign of a change (F-T640-43).
        const newer = scope.sources.flatMap((s) => read(s.dir, "gates").filter((o) => moveOf(o) && idNumber(o.id) > idNumber(g.id))).sort(byIdNumber).at(-1);
        if (newer) refuse(`refused: ${g.id} is an older move gate: ${newer.id} asks about plan ${moveOf(newer)}, of a later preview. Nothing changed. ${newer.answer ? `Run sage move --gate ${newer.id}.` : `Ask the owner to answer ${newer.id}, then run sage move --gate ${newer.id}.`}`);
        const file = askedFile(shared, folder, g.id);
        let asked = null;
        try { asked = JSON.parse(readRegular(file, { link: false, max: PLAN_MAX })); } catch {}
        rmSync(file, { force: true }); // the gate is closed now, so its asked plan goes (F-T640-66)
        refuse(changedText(asked, plan, moveOf(g), g.id));
      }
      const unused = UNUSED.exec(g.answer)?.[1].toLowerCase(), left = norow.filter((p) => p !== unused);
      if (left.length) refuse(pluginRefusal(left.map((p) => ({ provider: p, contract: null })), env));
      if (unused) writePlugin(shared, unused, "unused");
      const at = now(), saved = { ...plan, gate: { id: g.id, dir }, saved: at, at, step: 1, raw: Object.fromEntries(scope.sources.map((s) => [s.dir, rawDigest(s.dir)])) };
      mkdirSync(join(shared, MOVES), { recursive: true });
      swap(file, JSON.stringify(saved));
      testStop(env, 1);
      return moveSteps(saved, file, env, false);
    });
  });
}

/**
 * A saved plan: the move goes on from the step after its last one, unless an old logbook that it did not mark yet changed.
 * The plan file is only a record of the move, so its folder must be its file's name, and each old logbook and checkout that
 * it names must be one of this repository now (F-T640-7): a planted plan writes nothing.
 */
function finishMove(file, gateId, checkout, env) {
  const shared = dirname(dirname(file)), shown = shownPath(env);
  // The plan is read under the shared root's lock: a move that another session finished meanwhile has no plan left.
  return withLock(shared, () => {
    let plan;
    try { plan = JSON.parse(readRegular(file, { link: false, max: PLAN_MAX }) ?? "null"); } catch { plan = undefined; }
    if (plan === null) refuse("refused: the move of this project finished just now, in another session. Nothing changed. Run the command that you need again.");
    if (!plan?.gate?.id || !Number.isInteger(plan.step) || !Array.isArray(plan.sources) || !Array.isArray(plan.checkouts)) refuse(stoppedText(plan, file));
    if (plan.gate.id !== gateId) refuse(stoppedText(plan, file));
    const { sources, checkouts, gone } = repositoryLogbooks(checkout, env, { moved: true });
    // This provider's roots may give another path to the same folder than the mover's did: a link, or another letter case (F-T648-4).
    const dirs = sources.map((s) => s.dir), roots = [...checkouts.map((c) => c.root), ...gone];
    const check = "Nothing changed. Ask the owner to check that file: sage never guesses a move.";
    if (plan.folder !== basename(file).slice(0, -5)) refuse(`refused: the plan ${file} names ${visible(String(plan.folder))}, which is not the folder of its file name. ${check}`);
    const strange = [...plan.sources.map((s) => s?.dir).filter((d) => !dirs.some((o) => sameDir(d, o))), ...plan.checkouts.map((c) => c?.root).filter((r) => !roots.some((o) => sameDir(r, o)))];
    if (strange.length) refuse(`refused: the plan ${file} names ${visible(String(strange[0]))}, which is not a logbook or a checkout of this repository now. ${check}`);
    // The plan moves at least one old logbook, and its folder and its gate are this project's (F-T640-7, F-T640-25): the new
    // logbook takes the name of the old logbook that holds the move gate, and that gate, answered with a move, names this plan.
    const holder = plan.sources.find((s) => s.dir === plan.gate.dir && basename(s.dir) === plan.folder);
    const asked = holder && read(holder.dir, "gates").find((g) => g.id === gateId && moveOf(g) === String(plan.digest).slice(0, 8));
    if (!holder || !asked || !movesOn(asked)) refuse(`refused: the plan ${file} names no old logbook of this repository that holds its answered move gate ${gateId}. ${check}`);
    // The rows that the move writes are the rows that the owner's answer covers: the plan's digest is computed again (F-T640-50).
    if (planDigest(plan) !== plan.digest) refuse(`refused: the plan ${file} does not match its own fingerprint, so its rows are not the rows that the owner's answer covers. ${check}`);
    return finishPlan(plan, file, env, shared, shown);
  });
}
function finishPlan(plan, file, env, shared, shown) {
  return withLocks(plan.sources.map((s) => s.dir).sort(), () => {
    const marked = plan.sources.filter((s) => lstatSync(join(s.dir, "moved.json"), NO));
    const changed = plan.sources.filter((s) => !marked.includes(s) && rawDigest(s.dir) !== plan.raw?.[s.dir]);
    if (changed.length) {
      const which = changed.map((s) => `  ${title(s.provider)} logbook ${shown(s.dir)}`);
      if (marked.length) refuse([`refused: the move of project ${plan.folder.slice(0, -7)} cannot finish: an old logbook changed after the plan was saved, before the move marked it`, ...which, `Nothing more changed. The plan stays, so every command of this project refuses. Ask the owner to compare that logbook with the plan ${shown(file)}.`].join("\n"));
      // Nothing is marked, so the old logbooks still hold everything: the new logbook goes aside, and a new preview starts again.
      const dir = join(shared, plan.folder), aside = join(shared, `.${plan.folder}.stale-${Date.now()}`);
      if (lstatSync(dir, NO)) renameSync(dir, aside);
      rmSync(join(shared, `.${plan.folder}.moving`), { recursive: true, force: true });
      unlinkSync(file);
      refuse([`refused: the logbooks changed after plan ${plan.digest.slice(0, 8)}, and the move had not marked them yet`, ...which, `Nothing moved: the plan is removed${lstatSync(aside, NO) ? `, and the logbook it built is set aside in ${shown(aside)}` : ""}. Run the preview again.`].join("\n"));
    }
    return moveSteps(plan, file, env, true);
  });
}

/**
 * The steps after the plan is saved, each safe to run again, under the shared root's lock and each old logbook's lock:
 * 2 builds the new logbook in a hidden folder and renames it into place, 3 marks each old logbook (a backup copy of its
 * tasks table, moved.json, then the moved column), 4 writes the checkouts' rows, then the end check counts the new
 * logbook and the old marks again, and only when every count matches does 5 remove the plan.
 */
function moveSteps(plan, file, env, resumed) {
  const shared = dirname(dirname(file)), dir = join(shared, plan.folder), shown = shownPath(env), from = plan.step;
  const lines = [...startText(plan, resumed)];
  const backups = plan.sources.map((s) => shown(join(s.dir, "tasks.before-move.tsv")));
  const others = plan.checkouts.filter((c) => c.root !== plan.checkout).map((c) => ({ provider: plan.sources.find((s) => s.checkout === c.root)?.provider }));
  const step = (n, work) => {
    if (plan.step < n) {
      work();
      Object.assign(plan, { step: n, at: now() });
      swap(file, JSON.stringify(plan));
      testStop(env, n);
    }
    if (n > from) lines.push(stepText(plan, n, resumed ? null : others));
  };
  if (!resumed) lines.push(stepText(plan, 1, others));
  step(2, () => {
    raiseCounts(shared, env); // the shared cycle counts take the largest of the provider roots, as at a link
    if (!lstatSync(dir, NO)) {
      const temp = join(shared, `.${plan.folder}.moving`), at = plan.saved, stamp = (rows) => rows.map((r) => (r.at === "" ? { ...r, at } : r));
      rmSync(temp, { recursive: true, force: true }); // an unfinished build of an earlier run: the plan builds it again
      mkdirSync(join(temp, "briefs"), { recursive: true });
      mkdirSync(join(temp, "reports"));
      for (const t of ["runs", "ledger", "findings", "gates", "milestones", "releases"]) write(temp, t, plan.rows[t] ?? []);
      write(temp, "decisions", stamp(plan.rows.decisions));
      writeIdFloors(temp, plan.sources); // under the old logbooks' locks, once for each build (F-T641-3)
      put(join(temp, "standing.md"), plan.standing.replaceAll(DAY, localTime(at).day));
      if (plan.config) swap(join(temp, "config.json"), JSON.stringify(plan.config, null, 2) + "\n");
      swap(join(temp, "sources.tsv"), ["provider\tpath\tat", ...plan.sources.map((s) => `${s.provider}\t${s.dir}\t${at}`)].join("\n") + "\n");
      swap(join(temp, "move-map.html"), mapHtml(plan, { at, backups, shown: (f) => shown(join(shared, f)) }));
      write(temp, "tasks", plan.rows.tasks); // last: a folder with tasks.tsv is a whole logbook
      renameSync(temp, dir);
    }
    enroll(shared, plan.folder, () => {});
  });
  step(3, () => {
    for (const [i, s] of plan.sources.entries()) {
      const marker = join(s.dir, "moved.json"), tasks = join(s.dir, "tasks.tsv");
      if (!lstatSync(marker, NO)) {
        swap(join(s.dir, "tasks.before-move.tsv"), readRegular(tasks)); // the owner's backup, before the first mark
        swap(marker, `${JSON.stringify({ folder: plan.folder, shared, gate: plan.gate.id, at: plan.saved })}\n`);
      }
      // Decision rows that a restore by hand keeps: the move gate moved once (F-T647-1), and the floors of the map (F-T640-47).
      const have = read(s.dir, "decisions"), more = movedRows(plan, s.dir).filter((r) => !have.some((d) => d.decision === r.decision));
      if (more.length) write(s.dir, "decisions", [...have, ...more]);
      const { cols, lines: rows } = sheetText(readRegular(tasks));
      // A raw write with the table's own columns and moved: write() keeps only the columns that it knows (columnsOf).
      if (!cols.includes("moved")) put(tasks, [[...cols, "moved"].join("\t"), ...rowsOf({ cols, lines: rows }).map((r) => [...cols.map((c) => r[c]), plan.marks[i][r.id] ?? ""].join("\t"))].join("\n") + "\n");
    }
  });
  step(4, () => {
    const rows = bindings(shared), have = new Set(rows.map((r) => r.root));
    const add = plan.checkouts.filter((c) => !have.has(c.root)).map((c) => ({ root: c.root, folder: plan.folder, commits: c.commits, at: plan.saved }));
    if (add.length) writeBindings(shared, [...rows, ...add]); // last: a row makes the new logbook this project's
  });
  const { found, missing } = recount(plan, dir);
  const match = !missing.length && providersOf(plan).every((p) => Object.entries(countsOf(plan, p)).every(([k, v]) => found[p][k] === v));
  const recon = reconciliationText(plan, found, missing);
  if (!match) {
    // The plan stays and says so: every command of the project then gives this refusal, with no command to run (F-T640-11).
    Object.assign(plan, { mismatch: missing, at: now() });
    swap(file, JSON.stringify(plan));
    // The refusal starts with its own line, and the end check alone names the missing records (F-T640-57).
    const [head, ...rest] = mismatchText({ project: plan.folder.slice(0, -7), file: shown(file), dir: shown(dir), missing, counted: true });
    refuse([head, ...lines, "6/6 new logbook read again and counted", "", recon, "", ...rest].join("\n"));
  }
  unlinkSync(file);
  rmSync(askedFile(shared, plan.folder, plan.gate.id), { force: true });
  lines.push(stepText(plan, 5, null), stepText(plan, 6, null));
  return [...lines, "", recon, "", endText(plan, shown(join(dir, "move-map.html")), backups, (f) => shown(join(shared, f)))].join("\n");
}

/**
 * The rows that the move writes in an old logbook's decisions, after its mark: in the logbook that holds the move gate, that
 * the gate moved the project, so the same gate never moves it again after a restore by hand (F-T647-1); in each, the highest
 * new id of the map for each prefix, so a new id after a restore never takes a number of the map (F-T640-47).
 */
function movedRows(plan, dir) {
  const at = plan.saved, why = "a restore by hand keeps this row";
  const floors = Object.entries(FLOORS).map(([p, noun]) => [p, noun, BigInt(plan.next[p].slice(p.length)) - 1n]).filter(([p, , top]) => top > BigInt(plan.floors[p]));
  return [
    ...(dir === plan.gate.dir ? [{ at, task: "", decision: `${plan.gate.id} ${MOVED_BY} ${plan.folder} with plan ${plan.digest.slice(0, 8)}`, why }] : []),
    ...floors.map(([p, noun, top]) => ({ at, task: "", decision: `${p}${top} is the ${noun} floor of the move to the shared logbook ${plan.folder}`, why })),
  ];
}
const MOVED_BY = "moved this project to the shared logbook";

/**
 * The end check: the counts of the new logbook, by provider, read again from its own rows and the old logbooks' marks.
 * A task counts under the provider of its adoption record; a finding, a gate and a milestone under the provider of the
 * logbook that it came from, as the plan counts them, also when it moved with a task of the other provider (F-T640-1).
 * missing: each record of the plan that the new logbook lacks, as "<new> (was <provider> <old>)".
 */
function recount(plan, dir) {
  const tasks = read(dir, "tasks"), providerOf = new Map(tasks.map((t) => [t.id, adoptionOf(t)?.provider]));
  const from = (rows) => new Map(rows.map((m) => [m.new, m.provider]));
  const findingOf = from(plan.map.findings), gateOf = from(plan.map.gates), milestoneOf = from(plan.map.milestones);
  const found = Object.fromEntries(providersOf(plan).map((p) => [p, { tasks: 0, findings: 0, gates: 0, milestones: 0, standing: 0, notes: 0, waits: 0, marked: 0 }]));
  const add = (p, k, n = 1) => { if (found[p]) found[p][k] += n; };
  for (const t of tasks) { if (!ENDED.includes(t.state)) add(providerOf.get(t.id), "tasks"); add(providerOf.get(t.id), "waits", waitsOf(t).ids.length); }
  for (const f of read(dir, "findings")) if (f.status === "open") add(findingOf.get(f.key), "findings");
  for (const g of read(dir, "gates")) if (!g.answer) add(gateOf.get(g.id), "gates");
  for (const p of read(dir, "milestones")) add(milestoneOf.get(p.id), "milestones");
  const parts = plan.map.standing.filter((s) => s.base || s.count || s.notes);
  // Only a heading that the move wrote starts a part: an owner's own heading "## From the …" stays in its part (F-T640-48).
  (readRegular(join(dir, "standing.md")) ?? "").split(MOVED_HEADING).forEach((text, k) => {
    add(parts[k]?.provider, "standing", (text.match(/^\d+\./gm) ?? []).length);
    if (k) add(parts[k]?.provider, "notes", text.split("\n").slice(1).filter((line) => line.trim() && !/^\d+\./.test(line)).length);
  });
  for (const s of plan.sources) add(s.provider, "marked", rowsOf(sheetText(readRegular(join(s.dir, "tasks.tsv")) ?? "")).filter((r) => r.moved).length);
  const lacking = (table, maps, key = "id") => {
    const have = new Set(read(dir, table).map((r) => r[key]));
    // The old id is an old logbook's cell: it prints through visible(), as every logbook text of the move does (F-T640-24).
    return maps.filter((m) => !have.has(m.new)).map((m) => visible(`${m.new} (was ${title(m.provider)} ${m.old})`));
  };
  const missing = [...lacking("tasks", plan.map.tasks.filter((m) => !m.adopted)), ...lacking("findings", plan.map.findings, "key"), ...lacking("gates", plan.map.gates), ...lacking("milestones", plan.map.milestones)];
  return { found, missing };
}
/** The next free name beside a file that a repair moves aside, under the logbook lock: an old file stays, however fast two repairs run. */
const lostName = (file) => {
  let n = 1;
  while (lstatSync(`${file}.lost-${n}`, { throwIfNoEntry: false })) n++;
  return `${file}.lost-${n}`;
};
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
      const flag = !eq && ((cmd === "link" && o === "separate") || (cmd === "move" && o === "preview") || (cmd === "worktrees" && o === "yes")); // the options with no value
      const v = flag ? true : eq ? a.slice(a.indexOf("=") + 1) : args[++i];
      if (!eq && !flag) spaced.push(o);
      if (o in opt) refuse(`--${o} is given twice. Give it once${o === "accept-loss" ? `, with the tables joined by a comma: --accept-loss ${opt[o]},${v}` : ""}.`);
      opt[o] = v;
    }
  }
  const name = OPTIONS[`${cmd} ${pos[0]}`] ? `${cmd} ${pos[0]}` : cmd;
  const takes = [...(OPTIONS[name] ?? []), "project"], actor = ["chief", "lead"]; // every command takes the actor; only a shared logbook reads it
  for (const o of Object.keys(opt)) if (![...takes, ...actor].includes(o)) refuse(`${name} takes no --${o}. Its options: ${takes.map((t) => `--${t}`).join(", ")}.`);
  for (const o of spaced) {
    const v = opt[o];
    if (v === undefined || (v.startsWith("--") && [...takes, ...actor].includes(v.slice(2).split("=")[0]))) refuse(`--${o} needs a value. A value that starts with -- goes after =: --${o}=<value>.`);
  }
  return { pos, opt };
}

/** These exact CLI forms read without a lock, migration or saved board selection. */
function scopedRead(cmd, pos, opt) {
  if (Object.keys(opt).some(key => !["project", ...(cmd === "board" ? ["view"] : [])].includes(key))) return false;
  if (cmd === "config") return pos.length === 0;
  if (pos.length !== 1 || !TASK_ID.test(pos[0])) return false;
  return cmd === "task" || (cmd === "board" && opt.view === "task");
}

/** Parse the role's read with the CLI grammar. The caller supplies project authority separately. */
function roleReadProject([cmd, ...args]) {
  try {
    const { pos, opt } = parse(cmd, args);
    return scopedRead(cmd, pos, opt) && typeof opt.project === "string" && isAbsolute(opt.project) ? opt.project : undefined;
  } catch { return undefined; }
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

/** The roles of build work, which a task with an unmet wait does not take (milestone-rules.mjs has the rules of waits). */
const WAIT_ROLES = ["lead", "implementer", "investigate", "arena-judge"];
const WAITS_MAX = 20;
/**
 * The chief's text (a title, name or goal) as the rest of a line after a fixed label, never in quotes (the owner,
 * 2026-10-19): every character but a line break (which becomes a space) and a hidden character, with single spaces. So it
 * adds no line, and "(no title)" stands for a text with nothing left.
 */
const flat = (text) => cell(String(text ?? "").replace(BREAKS, " ")).replace(/ {2,}/g, " ");
const oneLine = (text) => flat(text) || "(no title)";
/**
 * Does a question read as a breakdown gate's first line to the owner: "Approve milestone", or the old "Approve program"
 * (T995), in any case and Unicode form, also after a list mark or another mark or symbol (R1270-1)? Look-alike letters
 * of another script and filler letters (U+115F, U+3164, U+FFA0) are a limit (T909, F-T909-4).
 */
const readsAsBreakdown = (question) => /^approve (?:milestone|program)\b/.test(looks(question).replace(/^[^\p{L}\p{N}]+/u, ""));
/** The why of each decision row that milestone propose writes. */
const PROPOSE = "milestone propose";
/** Has the owner not yet approved or dropped the milestone's breakdown? Then no task joins it once its build has begun, and none leaves it. */
const unanswered = (milestone) => ["proposed", "changing"].includes(milestone?.state);
const graphOf = (dir) => waitGraph(...["tasks", "milestones", "gates", "decisions"].map((t) => read(dir, t)));
const ODD = "the waits cell has text that is not a task id";
/** A milestone's breakdown that is not approved, for a waits line. */
const breakdownOf = (milestone) => `the breakdown of ${milestone.id} (${{ proposed: `open, gate ${milestone.gate}`, changing: `changes asked, gate ${milestone.gate}`, dropped: `dropped, gate ${milestone.gate}` }[milestone.state] ?? lostClause(milestone)})`;
const waitList = (open) => open.map(({ id, state, odd, pilot, milestone, loop }) => (odd ? ODD : milestone ? breakdownOf(milestone) : `${id} (${state ?? "not in the logbook"}${pilot ? `, the pilot of ${pilot}` : ""}${loop ? ", in a loop of waits, never met" : dead(state) ? ", never met" : ""})`)).join(", ");
/**
 * When a task with these unmet waits goes on: after its tasks are merged or concluded, and after the owner approves its
 * breakdown. A dropped or lost breakdown is never approved, so it gives no clause, and "" is a task that never goes on (R1206-2).
 */
const until = (open) => {
  const milestone = open.find((w) => w.milestone)?.milestone;
  return [open.some((w) => !w.milestone) && `each ${milestone ? "task" : "of them"} is merged or concluded`, unanswered(milestone) && `the owner approves the breakdown of ${milestone.id}`].filter(Boolean).join(", and ");
};
/** The fix for a wait that is never met: its task was abandoned or is lost, the cell has text that is not a task id, or the breakdown is not approved. */
const waitFix = (task, open) => {
  const gone = open.filter(({ state, odd, pilot, milestone }) => !odd && !pilot && !milestone && dead(state)).map(({ id }) => id);
  const pilot = open.find(({ state, pilot }) => pilot && dead(state));
  const milestone = open.find((w) => w.milestone)?.milestone;
  const how = `sage task ${task.id} set waits=<ids>, or waits= to clear it`;
  const out = `take ${task.id} out of it (sage task ${task.id} set milestone=none), or ask the owner.`;
  return [
    gone.length ? ` ${gone.join(", ")} ${gone.length === 1 ? "is" : "are"} abandoned or not in the logbook, so ${gone.length === 1 ? "that wait is" : "those waits are"} never met: remove or change the wait (${how}), or ask the owner.` : "",
    pilot ? ` ${pilot.id}, the pilot of ${pilot.pilot}, is abandoned or not in the logbook, so no other task of ${pilot.pilot} builds: propose a new pilot (sage milestone propose ${pilot.pilot} --pilot <T>), or ${out}` : "",
    !milestone ? "" : {
      proposed: ` No task of ${milestone.id} builds before the owner approves its breakdown: ask the owner to answer gate ${milestone.gate}.`,
      changing: ` The owner asked for changes to the breakdown of ${milestone.id}: propose it again (sage milestone propose ${milestone.id}, with --name, --goal or --pilot when they change), and the owner answers the new gate.`,
      dropped: ` The owner dropped ${milestone.id}, so its breakdown is never approved: ${out}`,
    }[milestone.state] ?? ` The breakdown of ${milestone.id} is never approved: ${milestone.pilot === task.id ? `propose it again (sage milestone propose ${milestone.id}), or ask the owner.` : out}`,
    open.some(({ odd }) => odd) ? ` A hand edit put that text there: set the waits again (${how}).` : "",
  ].join("");
};
/** Refuses work of what on a task with an unmet wait, and names each unmet wait with its state. A move to merged or concluded opens the waits on it, so it refuses too. */
const waitsMet = (task, graph, what) => {
  const open = unmetWaits(task, graph);
  if (!open.length) return;
  const end = { "move to merged": "merged", "move to concluded": "concluded" }[what], when = until(open);
  const after = `${when ? `: ${end ? `it moves to ${end}` : "it starts"} after ${when}.` : "."}${end ? "" : " Its design and PE may run."}`;
  refuse(`${task.id} waits for ${waitList(open)}, so it takes no ${what}${after}${waitFix(task, open)}`);
};
/** The wait graph of a logbook as the printers show it (shownGraph), for the task line: the same waits as the board and status. */
const shownOf = (dir, tasks) => {
  const gates = read(dir, "gates");
  return shownGraph(waitGraph(tasks, read(dir, "milestones"), gates, read(dir, "decisions")), gates);
};
/** A task's unmet waits as the printers show them (shownWaits), so the status waits line and the task line say what the board says. */
const shownOpen = (task, graph) => shownWaits(task, graph).filter(({ state }) => !MET.includes(state));
/** A task's waits for a printed line: each with its task's state, then the unmet ones. */
const waitsText = (task, graph) => {
  const all = shownWaits(task, graph), open = shownOpen(task, graph);
  if (!all.length) return "";
  return ` · waits ${waitList(all)} · ${open.length ? `unmet ${open.map(({ id, odd, milestone }) => (odd ? "the odd text" : milestone ? `the breakdown of ${milestone.id}` : id)).join(", ")}` : "all met"}`;
};
/**
 * A waits value as its cell holds it: task ids joined by commas, "" for none (an empty value or none clears it). The ids may
 * be separated by commas or spaces. It refuses a word that is not a task id, a duplicate, the task itself, more than
 * WAITS_MAX and a task that this logbook does not have. The caller then refuses a loop (noLoop).
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
  const known = byIds(tasks);
  const lost = ids.find((id) => !known.has(id));
  if (lost) refuse(`no task ${lost} in this logbook: a task waits only for a task of its own logbook.${nothing}`);
  return ids.join(",");
}
/** The tasks that a task waits for in the loop check: its waits, and the pilot of its milestone, also before the approval, which would close the loop. */
const edgesOf = (task, milestones) => {
  const pilot = milestones.get(task?.milestone)?.pilot;
  return [...waitsOf(task).ids, ...(pilot && pilot !== task.id ? [pilot] : [])];
};
/**
 * Refuses a loop of waits through task, as the logbook would hold it after this change: a path from its waits back to it.
 * One depth-first search over the logbook's tasks. It names the loop, the pilot rule when the loop goes through it, and
 * the fix: each written wait of the loop to clear (R1209-4). own: the task's waits are the change, so they are not written
 * yet. oldPilot: the pilot that a new proposal replaces.
 */
function noLoop(task, { byId, milestones }, { own = false, oldPilot } = {}) {
  const of = (id) => (id === task.id ? task : byId.get(id));
  const seen = new Set();
  const back = (id, path) => {
    if (id === task.id) return path;
    if (seen.has(id)) return undefined;
    seen.add(id);
    for (const n of edgesOf(of(id), milestones)) {
      const found = back(n, [...path, n]);
      if (found) return found;
    }
    return undefined;
  };
  for (const id of edgesOf(task, milestones)) {
    const loop = back(id, [task.id, id]);
    if (!loop) continue;
    const [from, to] = loop.slice(1).map((b, i) => [loop[i], b]).find(([a, b]) => !waitsOf(of(a)).ids.includes(b)) ?? [];
    const pilot = from ? ` ${from} waits for ${to} as the pilot of ${of(from).milestone}: each task of a milestone waits for its pilot.` : "";
    const written = loop.slice(1).map((b, i) => [loop[i], b]).filter(([a, b]) => !(own && a === task.id) && waitsOf(of(a)).ids.includes(b));
    const clear = ([a, b]) => `${a} waits for ${b === oldPilot ? `the old pilot ${b}` : b}: clear that wait first (sage task ${a} set waits=${waitsOf(of(a)).ids.filter((x) => x !== b).join(",") || "none"})`;
    const fix = written.length ? ` ${written.map(clear).join("; or ")}.` : ` Give ${task.id} other waits.`;
    refuse(`these waits make a loop: ${loop.join(", ")}.${pilot} A loop never ends, so sage refuses it.${fix} Nothing changed.`);
  }
}
/** The decision row of a changed waits list, so that a replaced list leaves its record. */
const waitsDecision = (task, was, at, why) => {
  if (was === (task.waits ?? "")) return [];
  const { ids, odd } = waitsOf({ waits: was }); // the old cell through the parser: a hand edit's text never reaches the row
  return [{ at, task: task.id, decision: `waits ${[...ids, ...(odd ? ["(text that is not a task id)"] : [])].join(",") || "none"} → ${task.waits || "none"}`, why }];
};
/**
 * Refuses a task that joins a milestone after its build has begun (past briefed, or with a lead, implementer, investigate
 * or arena-judge run that runs) until when: until the owner approves the breakdown (R1208-2), and in an approved milestone
 * until its pilot is merged or concluded, so the pilot runs end to end first (R1217-1).
 */
const notStarted = (task, pid, runs, when = "the owner approves its breakdown") => {
  const run = runs.find((r) => r.task === task.id && r.status === "running" && WAIT_ROLES.includes(r.role));
  if (run || !["framed", "briefed"].includes(task.state)) refuse(`${task.id} ${run ? `has ${run.id} (${run.role}) running` : `is ${task.state}`}, so it joins ${pid} only after ${when}: before that, a task joins only while it is framed or briefed, with no lead, implementer, investigate or arena-judge run that runs. Nothing changed.`);
};
/**
 * A milestone value as its cell holds it: a M<n> of this logbook, or "" (none or an empty value takes the task out). It
 * refuses another word, a milestone that the logbook does not have or that the owner dropped, an ended task joining or
 * leaving one (R1242-3), any task joining one whose breakdown gate is open, as its question would not name the task (R1215-1), a started task
 * joining one before its pilot is merged (notStarted), the pilot leaving its milestone (unless the owner dropped it), and
 * any task leaving a milestone before the owner approves or drops it (R1204-1). The caller then refuses a loop through the pilot.
 */
function milestoneValue(task, value, { milestones, byId, renamed }, runs = []) {
  // An old program id names its milestone through the logbook's id map (T995, F-T995-16): the line then names the new id.
  const id = value === "none" ? "" : (renamed.get(value) ?? value);
  const nothing = " Nothing changed.";
  if (id === (task.milestone ?? "")) return id;
  if (ENDED.includes(task.state)) refuse(`${task.id} is ${task.state}: an ended task joins no milestone and leaves none, so its milestone keeps it in its count.${nothing}`);
  const was = milestones.get(task.milestone);
  if (was?.pilot === task.id && was.state !== "dropped") refuse(`${task.id} is the pilot of ${was.id}, so it stays in ${was.id}: propose a new pilot first (sage milestone propose ${was.id} --pilot <T>).${nothing}`);
  if (unanswered(was)) refuse(`${task.id} is in ${was.id}, and the owner has not approved or dropped its breakdown (gate ${was.gate}), so ${task.id} stays in it. To leave ${task.id} out, propose ${was.id} again after a change answer, with --tasks that do not name it.${nothing}`);
  if (!id) return "";
  if (!MILESTONE_ID.test(id)) refuse(`milestone takes a milestone id such as M1, or none to take the task out; not "${visible(id)}".${nothing}`);
  const milestone = milestones.get(id) ?? missing(`milestone ${id}`, [...milestones.keys()]);
  if (milestone.state === "dropped") refuse(`the owner dropped ${id} (gate ${milestone.gate}), so it takes no task. Propose a new milestone (sage milestone propose --name <name> --goal <goal> --pilot <T> --tasks <T,T>).${nothing}`);
  if (milestone.state === "proposed") refuse(`the breakdown gate ${milestone.gate} of ${id} is open, and its question does not name ${task.id}, so no task joins ${id} before the owner answers it. Ask the owner to answer change, then propose ${id} again with --tasks that name ${task.id}.${nothing}`);
  if (milestone.state !== "active") notStarted(task, id, runs);
  else if (!MET.includes(byId.get(milestone.pilot)?.state)) notStarted(task, id, runs, `its pilot ${milestone.pilot} is merged or concluded`);
  return id;
}
/** The decision row of a changed milestone, and the note for the chief when a task joins or leaves after the breakdown approval: no new gate, so the owner hears of it (the owner, 2026-10-19). */
const milestoneDecision = (task, was, at, why, { milestones }) => {
  if (was === (task.milestone ?? "")) return { rows: [], note: "" };
  const after = [[was, "leaves"], [task.milestone, "joins"]].filter(([p]) => p && milestones.get(p)?.state === "active").map(([p, verb]) => ` · ${verb} ${p} after the owner approved its breakdown: no new gate, so tell the owner`).join("");
  return { rows: [{ at, task: task.id, decision: `milestone ${was || "none"} → ${task.milestone || "none"}`, why: `${why}${after ? "; after the breakdown approval" : ""}` }], note: after };
};

/**
 * A release value as a release cell holds it (T1003): the release's own name, also when the value has another case or
 * width, or "" for none (none or an empty value takes the item out). It refuses a name that the logbook does not have,
 * and two names: who (a milestone or a task) is in at most one release.
 */
function releaseValue(value, releases, who) {
  if (value === "" || releaseKey(value) === "none") return "";
  if (value.includes(",")) refuse(`${who} is in at most one release: name one release, not ${visible(value)}. Nothing changed.`);
  const release = releases.find((r) => releaseKey(r.name) === releaseKey(value));
  return release?.name ?? refuse(`no release ${visible(value)}. ${releases.length ? `The releases: ${releases.map((r) => visible(r.name)).join(", ")}.` : "There is none yet."} To add a release: sage release add --name "<name>". Nothing changed.`);
}

/** The most repair rounds that the chief gives itself in autopilot, with a reason; above it only the owner's gate gives one (T804). */
const ROUND_CEILING = 5;
/** Is autopilot on for this chief's session? Only a chief of this provider, by its session, through the adapter's reader. */
const autopilotOf = (dir, chief, env) => {
  const row = chief === undefined ? undefined : chiefs(dir).find((r) => r.id === chief);
  return row?.provider === provider && autopilot(row.native, env) === true;
};
/** The extra rounds of a task's holds by round: a whole number, and 0 for any other cell, so a hand-written cell never gives NaN (F-T286-2). */
const extraOf = (task) => (/^\d+$/.test(task.extra ?? "") && Number.isSafeInteger(Number(task.extra)) ? Number(task.extra) : 0);

/** Bind a new allowance to the owner's explicit answer, the task, spent rounds and current limit. */
function repairApproval(task, approval, facts) {
  const max = facts.maxRounds, spent = Number(task.round), limit = max + extraOf(task);
  const question = `Approve one more repair round for ${task.id} after ${spent} spent rounds and limit ${limit}?`;
  const gates = facts.gates.filter(g => g.id === approval);
  if (!/^G[1-9]\d*$/.test(approval ?? "") || gates.length !== 1
    || gates[0].task !== task.id || gates[0].question !== question
    || gates[0].options !== "approve|decline" || gates[0].answer !== "approve"
    || (task.approvals ?? "").split(",").includes(approval)
    || !Number.isSafeInteger(max) || max < 1 || max > 10
    || !Number.isSafeInteger(spent) || spent < 0 || !Number.isSafeInteger(Math.max(spent, limit) + 1)) {
    refuse(`${task.id} needs a new task-specific repair approval. Ask a gate with question "${question}" and options "approve|decline". After the owner chooses approve, resume with state=building or state=briefed and approval=<G>. Nothing changed.`);
  }
  return Math.max(spent, limit) + 1 - max;
}

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
  let note = "";
  const task = matches[0], decided = [], graph = waitGraph(tasks, facts.milestones, facts.gates, decisions), had = prsOf(task, decisions, facts.ledger);
  const approvals = changes.filter(kv => kv.startsWith("approval="));
  const states = changes.filter(kv => kv.startsWith("state="));
  const resume = task.state === "held" && task.hold === "round" && states.some(kv => kv !== "state=abandoned");
  let allowance;
  if (resume || approvals.length) {
    if (approvals.length !== 1 || states.length !== 1 || !["state=building", "state=briefed"].includes(states[0])
      || task.state !== "held" || task.hold !== "round") refuse(`${task.id} needs one approval=<G> with a move from a round hold to building or briefed. Nothing changed.`);
    allowance = repairApproval(task, approvals[0].slice(9), facts);
  }
  for (const kv of changes) {
    const [k, v] = [kv.slice(0, kv.indexOf("=")), kv.slice(kv.indexOf("=") + 1)];
    if (k === "approval") continue; // validated with the whole request before any state transition
    const adoption = adoptionOf(task);
    if (adoption && ((k === "branch" && adoption.branch !== undefined && v !== adoption.branch) || (k === "pr" && adoption.pr !== undefined && v !== adoption.pr))) refuse(`${task.id}'s adoption keeps ${[adoption.pr && `PR ${adoption.pr}`, adoption.branch && `branch ${adoption.branch}`].filter(Boolean).join(" and ")}. Nothing changed.`);
    if (k === "state") {
      if (v === "repairing") refuse("start a repair with: sage round <task>");
      // Only an explicit, unused approval grants a round. Ordinary holds grant none.
      const was = task.state;
      move(task, v); // the design's states first; the table is written only if every check below passes
      if (["building", "merged", "concluded"].includes(v)) waitsMet(task, graph, `move to ${v}`);
      // A move to abandoned gives no round: the task ends (F-T286-3).
      if (was === "held" && task.hold === "round" && v !== "abandoned") {
        task.extra = String(allowance);
        const approval = approvals[0].slice(9);
        task.approvals = [task.approvals, approval].filter(Boolean).join(",");
        const decision = `held → ${v}: one more repair round (${approval})`;
        // A CLI retry after the decision write but before the task write completes the same grant.
        if (!decisions.some(row => row.task === task.id && row.decision === decision)) decided.push({ at, task: task.id, decision, why: "owner approval" });
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
        const open = blockingOf(facts.findings, task.id);
        if (open.length) refuse(`${task.id} has open findings: ${open.map((f) => `${f.key} (${f.triage || "not triaged"})`).join(", ")}. Close or dismiss each one first.`);
      }
      if (v === "concluded" && facts.ledger.filter((r) => r.task === task.id).at(-1)?.kind !== "evidence-clean") {
        refuse(`${task.id} needs a clean evidence review as its latest verdict: sage verdict ${task.id} --kind evidence-clean --run <R>`);
      }
      if (v === "verified") {
        const rows = facts.ledger.filter((r) => r.task === task.id);
        const head = rows.at(-1)?.sha ?? refuse(`${task.id} has no verdicts yet`);
        const r = judge("", task, facts.findings, decisions, task.id, rows.filter((r) => r.sha === head), 1);
        if (!r.ok) refuse(`${task.id} is not verified on ${head.slice(0, 7)}: ${r.reason}`);
      }
      if (["merged", "concluded", "abandoned"].includes(v)) decided.push({ at: at, task: task.id, decision: `state ${v}`, why: (v === "abandoned" && facts.why) || "task set" });
    } else if (k === "pr") {
      decided.push(...(notHeld(task, "pr="), setPr(task, v, "task set", at)));
      if (v) apartFromPilot(task, graph, [...decisions, ...decided], facts.ledger, "pr", had); // with the PR rows of earlier keys (R1285-1)
    }
    else if (k === "branch") notHeld(task, "branch="), task.branch = v && (mayName(tasks, task, branchOf(v)) ? v : refuse(`${JSON.stringify(v)} is not a branch of ${task.id}: use [<prefix>/]${task.id.toLowerCase()}[-<words>], for example sage task ${task.id} set branch=sage/${task.id.toLowerCase()}, or the branch of another task of this logbook, to share its pull request`)); // branch= clears it
    else if (k === "title") task.title = v;
    else if (k === "priority") task.priority = priorityOf(v, task);
    else if (k === "kind") task.kind = tag(k, v);
    else if (k === "waits") {
      const was = task.waits ?? "";
      task.waits = waitsValue(task, v, tasks);
      const milestone = graph.milestones.get(task.milestone); // the next proposal shows a change made while the owner asks for changes (R1277-2)
      if (milestone?.state === "proposed" && task.waits !== was) refuse(`${task.id} is in ${milestone.id}, and the question of its breakdown gate ${milestone.gate} shows the waits of each task, so they do not change while the gate is open. ${milestone.id} has an open breakdown gate: ask the owner to answer change, then propose again. Nothing changed.`);
      if (task.waits && ENDED.includes(task.state)) refuse(`${task.id} is ${task.state}: an ended task waits for nothing, so it takes no new wait. waits= clears a wait. Nothing changed.`);
      noLoop(task, graph, { own: true });
      decided.push(...waitsDecision(task, was, at, "task set"));
    } else if (k === "milestone") {
      const was = task.milestone ?? "";
      task.milestone = milestoneValue(task, v, graph, runs);
      noLoop(task, graph);
      apartFromPilot(task, graph, [...decisions, ...decided], facts.ledger, "join");
      const { rows, note: joined } = milestoneDecision(task, was, at, "task set", graph);
      decided.push(...rows);
      note += joined;
      // A task that joins a milestone is in the milestone's release: its own release goes (T1003).
      if (task.milestone && task.release) {
        decided.push({ at, task: task.id, decision: `release ${task.release} → none`, why: `${task.id} joins ${task.milestone}, and a task of a milestone is in its milestone's release` });
        note += ` · leaves the release ${oneLine(task.release)}: a task of ${task.milestone} is in the release of ${task.milestone}`;
        task.release = "";
      }
    } else if (k === "release") {
      if (task.milestone) refuse(`${task.id} is in ${task.milestone}, and a task of a milestone is in its milestone's release. Set the release of ${task.milestone} (sage milestone ${task.milestone} set release=<name>), or take ${task.id} out of ${task.milestone} first (sage task ${task.id} set milestone=none). Nothing changed.`);
      const was = task.release ?? "", to = releaseValue(v, facts.releases, task.id);
      if (to !== was) {
        task.release = to;
        decided.push({ at, task: task.id, decision: `release ${was || "none"} → ${to || "none"}`, why: "task set" });
      }
    } else refuse(`task set takes state=, branch=, pr=, title=, priority=, kind=, waits=, milestone=, release= or approval=`);
  }
  return { task, tasks, runs, decisions: [...decisions, ...decided], note };
}

/** A task's kind as its cell holds it: "" for none, else a value of the fixed list. Any other value refuses, with the list. */
const tag = (key, value) => value === "none" ? "" : TASK_KINDS.includes(value) ? value
  : refuse(`${key} is one of ${TASK_KINDS.join(", ")}, or none to clear it; not "${visible(String(value ?? ""))}". Nothing changed.`);
/**
 * A task's priority (T500): one of the scale, for task add (no task yet) and task set. Only an ended task's priority
 * clears, with none. An older row with no priority stays valid; status and the board flag it.
 */
const priorityOf = (value, task) => {
  if (PRIORITIES.includes(value)) return value;
  if (value === "none" && task && ENDED.includes(task.state)) return "";
  const why = value === undefined ? "Give it with --priority."
    : task && ["none", ""].includes(value) && !ENDED.includes(task.state) ? `${task.id} is ${task.state}, so its priority does not clear: set another one.`
    : `"${visible(String(value))}" is not one of them.`;
  return refuse(`${PRIORITY_SCALE} ${why} Nothing changed.`);
};

/**
 * Frames a task with its route and writes it: the least route of its size, the security review for a risk, the added
 * blocks, and the code review of a tiny arena, because a judge's graft is new code that nobody read.
 */
function taskFrame(id, title, size, risk, add) {
  const blocks = new Set([...SIZES[size], ...(risk.length && size !== "investigate" ? ["security-review"] : []), ...(size === "tiny" && add.includes("arena") ? ["code-review"] : []), ...add]);
  const task = { id, title, size, risk: risk.join(","), route: BLOCKS.filter((b) => blocks.has(b)).join(","), state: "framed", round: 0 }; // the blocks in their order
  return task;
}
function frame(dir, title, size, risk, add, tags = {}) {
  const task = { ...taskFrame(nextId(dir, "T"), title, size, risk, add), ...tags };
  write(dir, "tasks", [...read(dir, "tasks"), task]);
  return task;
}
/** A task's priority, kind and milestone for a printed line: nothing when it has none. */
const tagsOf = (task) => `${task.priority ? ` · ${task.priority}` : ""}${task.kind ? ` · kind ${task.kind}` : ""}${task.milestone ? ` · milestone ${task.milestone}` : task.release ? ` · release ${oneLine(task.release)}` : ""}${task.chief ? ` · chief ${task.chief}` : ""}${offerOf(task) ? ` · offer ${offerOf(task).id} to ${offerOf(task).to} · version ${taskVersion(task)}` : ""}`;
const framed = (task) => `${task.id} framed · ${task.size}${task.risk ? ` · risk ${task.risk}` : ""} · route ${task.route}${tagsOf(task)}${task.waits ? ` · waits ${task.waits.replaceAll(",", ", ")}` : ""}`;

function move(task, to) {
  if (to !== "abandoned" && !(NEXT[task.state] ?? []).includes(to)) refuse(`${task.id} cannot go from ${task.state} to ${to}. Next: ${(NEXT[task.state] ?? []).join(", ") || "none"}`);
  task.state = to;
}

/**
 * Gives a task its pull request, or clears it with "". An investigation changes no code, so it may only clear one. A
 * change gives its decision row (S1), which the caller writes before the task: a task that was ever on a PR stays in
 * that PR's merge check (prHistory), so a cleared or changed pr= cannot take its verdicts out of the merge. The caller
 * then checks a new PR against the pilot (apartFromPilot).
 */
function setPr(task, pr, why, at = now()) {
  const adoption = adoptionOf(task);
  if (adoption?.pr !== undefined && pr !== adoption.pr) refuse(`${task.id}'s adoption keeps PR ${adoption.pr}. Nothing changed.`);
  if (pr && !builds(task)) refuse(`${task.id} is an investigation: it changes no code, so it has no pull request. A build is its own task: sage task add --size tiny, small or large, then give that task the PR.`);
  if (pr && !PR.test(pr)) refuse(`${JSON.stringify(pr)} is not a pull request number. Give only its digits, with no leading zero, for example pr=5 or --pr 5.`);
  const was = task.pr;
  task.pr = pr;
  // An investigation never has commits on a PR, so the PR that an old logbook gave it leaves no trace when it is cleared.
  return was === pr || !builds(task) ? [] : [{ at, task: task.id, decision: `PR ${was || "none"} → ${pr || "none"}`, why }];
}
/** The PR numbers that a task has or ever had: its pr cell, its PR decision rows and its verdicts, as prHistory reads them. */
const prsOf = (task, decisions, ledger) =>
  new Set([task.pr, ...decisions.filter((d) => d.task === task.id).flatMap((d) => /^PR (\S+) → (\S+)$/.exec(d.decision)?.slice(1) ?? []), ...ledger.filter((r) => r.task === task.id && r.sha).map((r) => r.pr)].map(prNumber).filter((n) => PR.test(n ?? "")));
/**
 * Refuses a task of a milestone and its pilot that have or ever had one PR, before the pilot is merged or concluded, in
 * every state of the milestone but dropped (R1279-1): a task that was ever on a PR stays in its merge check, and the task
 * builds only after its pilot, so that PR could never merge (R1273-1). task is the task whose PR or milestone changed: a
 * member, whose PRs meet the pilot's, or the pilot, whose PRs meet each member's. how names the way out: "pr" (task set
 * pr= or verdict --pr), "join" (task set milestone=) or "propose" (milestone propose). had (for "pr") is the PRs of task
 * before the command, which a new PR cannot take out.
 */
function apartFromPilot(task, { byId, milestones }, decisions, ledger, how, had) {
  const milestone = milestones.get(task.milestone);
  const pilot = milestone && (milestone.pilot === task.id ? task : byId.get(milestone.pilot));
  if (!pilot || milestone.state === "dropped" || MET.includes(pilot.state)) return;
  const pilotPrs = prsOf(pilot, decisions, ledger);
  const members = pilot === task ? [...byId.values()].filter((t) => t.milestone === milestone.id && t.id !== pilot.id) : [task];
  for (const m of members) {
    const n = [...prsOf(m, decisions, ledger)].find((n) => pilotPrs.has(n));
    if (n === undefined) continue;
    const out = unanswered(milestone) ? `propose ${milestone.id} again after a change answer, with --tasks that do not name ${m.id}` : `sage task ${m.id} set milestone=none`;
    // A PR that the logbook already has for the task stays in its history, so another PR does not help (R1285-2).
    const pr = !had?.has(n) ? `Give ${task.id} another PR, or take ${m.id} out of ${milestone.id} (${out}).` : `${task.id} had PR ${n} before, and that stays, so another PR does not help: take ${m.id} out of ${milestone.id} (${out}).`;
    const way = { pr, join: `${m.id} joins ${milestone.id} only after ${pilot.id} is merged or concluded.`, propose: `Leave ${m.id} out of --tasks, or name another pilot with --pilot.` }[how];
    refuse(`${m.id} and ${pilot.id}, the pilot of ${milestone.id}, have or had PR ${n}, and ${m.id} builds only after ${pilot.id} is merged or concluded. A task that was ever on a PR stays in its merge check, so PR ${n} could never merge. ${way} Nothing changed.`);
  }
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
 * Does one task have the clean cycles its route needs on one SHA? findings and decisions are from its logbook's tables, read
 * once by the caller; rows are only that task's ledger rows for the SHA. A task without rows is in the merge check only through
 * its PR history (prHistory). from: the earlier head whose cycles rows carries (carryOver), if any.
 */
function judge(dir, task, findings, decisions, id, rows, cycles, repaired, cfg, pr, from) {
  if (!task) return { ok: false, reason: `${id} is in ${join(dir, "ledger.tsv")} but not in its tasks.tsv: ${repaired ? `tasks.tsv was started again without rows (see decisions.tsv), so the verdicts of ${id} are on a lost task. Push a new commit, and record its verdicts under a task that the logbook has.` : `a stray or damaged logbook. If no project uses it, ask the user to remove ${dir}.`}` };
  const who = task.state === "abandoned" ? `${task.id} (abandoned)` : task.id; // it still counts: the merge check fails closed
  if (!rows.length && !builds(task)) return { ok: false, reason: `${who} is an investigation, so it has no pull request, but it has PR ${task.pr}: clear its PR (sage task ${task.id} set pr=).` };
  if (!rows.length) return { ok: false, reason: `${who} ${prNumber(task.pr) === pr ? "is" : "was"} a task of PR ${pr} but has no verdicts on this SHA. Every task that was ever on PR ${pr} counts for its merge, also after its pr= changed (see decisions.tsv): record its verdicts on this SHA, or the user merges.` };
  const open = blockingOf(findings, task.id);
  if (open.length) return { ok: false, reason: `${who} has open findings: ${open.map((f) => f.key).join(", ")}. Triage and close them first.` };
  const bad = rows.find((r) => NOT_CLEAN.includes(r.kind) && !cleared(r, task, findings, decisions));
  if (bad) return { ok: false, reason: `${who}: cycle ${bad.cycle} found problems on this SHA (${bad.kind}). Repair, then review the new SHA.` };
  if (!rows.some((r) => r.kind === "checks-pass")) return { ok: false, reason: `${who}: no checks-pass on this SHA. Run the checks on it and record checks-pass.` };
  const perCycle = cleanKinds(task);
  const want = perCycle.length ? cycles : 1;
  const clean = perCycle.length ? cleanCycles(task, rows) : 1;
  if (clean < want) {
    const missing = perCycle.filter((k) => !rows.some((r) => r.kind === k));
    const high = want > LIMIT["cycles.small"] && cycleKeys(task).find((k) => cfg[k] === want); // only config.json holds a count above the limit
    return { ok: false, reason: `${who}: ${clean} of ${want} clean cycles on this SHA${high ? ` (${high} is ${want} in config.json; the config command takes 1 to 10)` : ""}${missing.length ? `; never recorded: ${missing.join(", ")}` : ""}. ${from ? `A review or QA verdict on this SHA replaces the carried cycles of ${from}, so this SHA then needs all ${want} clean cycles of its own: run them on this SHA, or run the missing cycles on ${from}.` : "Run the next cycle of its reviews on this SHA and record each verdict."}` };
  }
  return { ok: true, reason: `${task.id} may merge: ${clean} clean cycle${clean === 1 ? "" : "s"} on this SHA` };
}

/** The clean verdicts that each cycle of a task needs: those of its route's reviews and QA. */
const cleanKinds = (task) => list(task.route).map((b) => VERDICT[b]).filter((k) => k && k !== "checks-pass");
/** The cycles of a task's ledger rows on one SHA that have every clean verdict of its route (the judge's count). */
const cleanCycles = (task, rows) => [...new Set(rows.map((r) => r.cycle))].filter((c) => cleanKinds(task).every((k) => rows.some((r) => r.cycle === c && r.kind === k))).length;

/**
 * The review and QA rows that count for head from an earlier head (T805, the owner's Q3 of T668): those of the task's
 * reviewed head with the most clean cycles (the latest on a tie), when head is that head plus clean merges of origin/main
 * and the pull request's own diff is the same (cleanMergesOfMain), and no commit between them has a review or QA verdict of
 * the task, so the carry skips no findings (F-T805-9). head keeps its own checks rows, so CI must pass on head
 * itself, and a head with a review or QA verdict of its own judges on its own rows only: the carry is all or nothing. git
 * runs in checkout, the merged project's folder. It returns the rows to judge, and from (the earlier head) or why (it did
 * not carry). Any git error carries nothing: the merge check fails closed.
 */
function carryOver(checkout, task, head, own, all) {
  if (!task || checkout === undefined) return { rows: own };
  const earlier = new Map();
  for (const r of all) if (r.sha !== head && /^[0-9a-f]{40}$/.test(r.sha) && REVIEWED.includes(r.kind)) (earlier.get(r.sha) ?? earlier.set(r.sha, []).get(r.sha)).push(r);
  const [best] = [...earlier].reverse().map(([sha, rows]) => ({ sha, rows, n: cleanCycles(task, rows) })).filter((c) => c.n).sort((a, b) => b.n - a.n);
  if (!best) return { rows: own };
  if (own.some((r) => REVIEWED.includes(r.kind))) return { rows: own, why: `The cycles of ${best.sha} do not carry to this SHA: it has review or QA verdicts of its own, so only its own cycles count.` };
  let why;
  try {
    why = cleanMergesOfMain(checkout, best.sha, head, new Set([...earlier.keys()].filter((sha) => sha !== best.sha)));
  } catch (e) {
    // exit 128 is git's answer for a folder that is no clone, or a commit or ref that the clone does not have.
    why = `git could not read it (${e?.code ?? (typeof e?.status === "number" ? `exit ${e.status}` : e?.signal ?? e?.message)})${e?.status === 128 ? ": the folder is not a git clone, or it lacks origin/main or a head (fetch origin)" : ""}`;
  }
  return why ? { rows: own, why: `The cycles of ${best.sha} do not carry to this SHA: ${why}.` } : { rows: [...own, ...best.rows], from: best.sha };
}

/**
 * Why head is not from plus clean merges of main, or "". Each commit on head's first-parent line back to from must merge
 * one commit of origin/main (the last fetched main of GitHub, which the pull request merges into) into the line, with the
 * tree of a clean git merge-tree of its two parents: a conflict resolution or an edit in the merge refuses, and so does a
 * commit of another kind. The merge reads its attributes (a merge=union, for example) from the merged commit of main,
 * never from the checkout or the pull request (F-T805-4). Then the patch-id of the pull request's own diff (from the
 * merge base with main to the head) must be the same for from and head. reviewed: the task's other heads with a review or
 * QA verdict; none of them may be between from and head (on either side of a merge), because the carry would skip its
 * verdict, such as a findings verdict on a middle head. A git error throws.
 */
function cleanMergesOfMain(project, from, head, reviewed) {
  const out = (args, input) => readLocalGit(project, args, input).toString();
  const yes = (args) => {
    try {
      return out(args), true;
    } catch (e) {
      if (e?.status === 1) return false;
      throw e;
    }
  };
  const main = out(["rev-parse", "--verify", "--end-of-options", "refs/remotes/origin/main^{commit}"]).trim();
  const line = out(["rev-list", "--first-parent", "--parents", `${from}..${head}`]).trim().split("\n").filter(Boolean).map((l) => l.split(" "));
  if (!line.length) return `${head} is not a later commit than ${from}`;
  if (line.some(([, first], i) => first !== (line[i + 1]?.[0] ?? from))) return `${from} is not on the first-parent line of ${head} (a rebase or an amended commit)`;
  const skipped = out(["rev-list", `${from}..${head}`]).split("\n").find((commit) => reviewed.has(commit));
  if (skipped) return `${skipped}, between them, has a review or QA verdict of the task, which the carry would skip`;
  for (const [commit, first, other, ...more] of line) {
    if (!other || more.length) return `${commit} is not a merge of two parents`;
    if (!yes(["merge-base", "--is-ancestor", other, main])) return `${commit} merges ${other}, which is not on origin/main (fetch origin if main moved)`;
    const tree = (() => {
      try {
        return out([`--attr-source=${other}`, "-c", "core.attributesFile=/dev/null", "merge-tree", "--write-tree", "--no-messages", first, other]).split("\n")[0];
      } catch (e) {
        if (e?.status === 1) return "conflict";
        if (e?.status === 129) return "old git"; // git's exit for an option that it does not know
        throw e;
      }
    })();
    if (tree === "conflict") return `${commit} merges ${other} with a conflict`;
    if (tree === "old git") return "this Git has no --attr-source option, so it cannot read the merge with the attributes of main (update Git)";
    if (tree !== out(["rev-parse", "--verify", `${commit}^{tree}`]).trim()) return `${commit} is not the clean merge of its parents (it resolves a conflict or adds an edit)`;
  }
  const patchId = (sha) => {
    const base = out(["merge-base", main, sha]).trim();
    const diff = readLocalGit(project, ["diff-tree", "-r", "-p", "--binary", "--no-color", "--no-ext-diff", "--no-textconv", base, sha]);
    return out(["patch-id", "--stable"], diff).split(" ")[0];
  };
  const [before, after] = [patchId(from), patchId(head)];
  if (!before) return `${from} has no diff of its own from origin/main`;
  return before === after ? "" : "the pull request's own diff changed (its patch-id is not the same)";
}

/**
 * The time after which a task's owning chief needs one fresh cycle, from the task's decision rows, or "". It reads the
 * owner's takeover answers from the last one back (F-T656-20). An answer that needs a fresh cycle gives its time: a gate
 * whose question says so (any reader, the board too), or, for the provider whose merge path needs it (takeoverCycle), a
 * gate that gave the task to its chief from another provider's. A move between chiefs of one provider changes nothing,
 * so the answer before it decides. A move to another provider whose chief needs no fresh cycle gives "".
 */
function takenAt(decisions) {
  for (const d of decisions.filter((d) => / → (?:approve|replace)$/.test(d.decision)).reverse()) {
    const p = replaceOf({ question: d.decision });
    if (p && (p.fresh || (!!takeoverCycle && p.toProvider === provider && crossed(p)))) return d.at;
    if (p && crossed(p)) return "";
  }
  return "";
}
/**
 * Is a ledger row of a task older than its takeover answer at since: recorded before it, or backed by a run that did not
 * start after it (F-T656-23)? The fresh cycle needs runs of the new chief: a run that the old chief started and that
 * ended before the answer backs no fresh verdict, also when the new chief records it later. A check verdict names no run.
 */
const olderThan = (since, runs) => (r) => !(Date.parse(r.at) > Date.parse(since)) || (!!r.run && !(Date.parse(runs.find((x) => x.id === r.run)?.started) > Date.parse(since)));

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
/** The folders of the root that hold a logbook's tasks or verdicts: what a migration or a rebuild lists. A folder that sage may not search refuses, with no stack. */
const logbooks = (root) => folders(root).filter((dir) => ["tasks.tsv", "ledger.tsv"].some((f) => {
  try {
    return lstatSync(join(dir, f), { throwIfNoEntry: false });
  } catch (e) {
    refuse(unreadableFolder(visible(dir), e));
  }
})).map((dir) => basename(dir));

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
 * With readOnly, it takes no lock and writes nothing: a missing list gives undefined. With fresh (the first link of a
 * shared root), the caller already holds the root's lock, and a new list starts empty: that root has no logbook of an
 * older version to list, so a folder planted there before the link stays out.
 */
function known(root, add, make, readOnly, fresh) {
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
  const change = () => {
    const was = names();
    if (!was && lstatSync(join(root, "projects.made"), { throwIfNoEntry: false }))
      refuse(`${file}, the known project list, is missing, but sage made it before (${join(root, "projects.made")}). Every merge and every init refuses until it is back, because a list made again without the user could take in a forged logbook. Ask the user to restore it from a copy, or to run ${REBUILD} and check each folder that it prints.`);
    const rows = was ?? (fresh ? [] : logbooks(root).filter((name) => name !== add).map((logbook) => ({ at: now(), logbook, how: "migration" })));
    make?.();
    const more = add && !rows.some((r) => r.logbook === add);
    if (more) rows.push({ at: now(), logbook: add, how: "init" });
    if (!was || more) enlist(root, rows);
    return new Set(rows.map((r) => r.logbook));
  };
  return fresh ? change() : withLock(root, change);
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
 * request's head branch on GitHub: each task of that pull request, now or in its PR history, must own it, by its
 * branch=, as a branch of the task (ofTask) or by a run of it on that branch, so a task cannot lend its verdicts to another task's
 * pull request (F-T273-8). Each task of the logbook that owns it must be on the pull request too (T439).
 * With project, the folder of the project being merged: only a task of its logbook counts as a task of the pull request
 * that may approve the merge. A task of another logbook with verdicts on the SHA must still pass (F-T273-9).
 * With locked, the caller already holds that project's lock, so the check finishes its saved change without taking it.
 * With session, a hook's session id in that project: a task of a shared logbook lands only by its owning chief, as its
 * later state=merged would refuse (F-T618-17). A legacy project has no chief, and a read with no session judges no chief.
 * With readOnly, no project and checkout ({ logbook, root }: a logbook folder and its project's folder), the board's
 * check runs the carry of earlier cycles (T805) for that logbook in that folder, as it runs for project (F-T805-1).
 */
function mergeCheck(sha, env = process.env, options = {}) {
  return assessMerge(sha, env, options);
}

/** Display-only judgment of one logbook. This is never the chief's permission to merge. checkout: as for mergeCheck. */
function boardLandingCheck(sha, env, logbook, pr, checkout) {
  if (!/^[a-z0-9-]+-[0-9a-f]{6}$/.test(logbook)) throw new TypeError("invalid logbook folder");
  return assessMerge(sha, env, { pr, readOnly: true, checkout }, logbook);
}

function assessMerge(sha, env, options, logbook = null) {
  const skipped = [], verdict = judgeMerge(sha, env, options, logbook, skipped);
  return skipped.length ? { ...verdict, reason: `${verdict.reason} Skipped ${skipped.map(visible).join(", ")}: a saved change is incomplete there, and it has no row for this commit. Any write there finishes it or says what to do.` } : verdict;
}

function judgeMerge(sha, env, { cycles, pr, readOnly, head, project, locked, session, chief: merger, checkout }, logbook, skipped) {
  let root = sageRoot(env);
  try {
    if (notFull(sha)) return { ok: false, reason: notFull(sha) };
    if (head !== undefined && !pr) return { ok: false, reason: "--head needs --pr: the head branch is the pull request's." };
    if (head === "") return { ok: false, reason: "--head is empty: give the pull request's head branch (F-T273-10)." };
    const home = project === undefined ? undefined : storeDir(project, env), mine = home && basename(home); // the merged project's logbook
    if (home) root = dirname(home); // the check reads the logbooks and the known project list of the logbook's root
    // The folder where a logbook's carry reads git (T805): project for its own logbook, or the board's checkout for its one.
    const gitOf = (dir) => (basename(dir) === mine ? project : readOnly && mine === undefined && checkout?.logbook === basename(dir) ? checkout.root : undefined);
    if (mine !== undefined && !readOnly && hasPendingWrite(home)) {
      if (locked) settle(home);
      else withLock(home, () => settle(home));
    }
    sha = String(sha).toLowerCase(); // the ledger holds SHAs as git prints them
    pr &&= prNumber(String(pr)); // the tasks table holds it as text; "040" is PR 40
    const cfg = config(env, home); // once: the merge check may judge thousands of tasks
    const broken = Object.keys(cfg).find((k) => cfg[k] === "invalid"); // fail closed: a default would ask fewer cycles than the owner meant
    if (broken) return { ok: false, reason: `the merge check refuses every merge, because ${broken} in ${join(root, "config.json")} is not a number. Set it with sage config ${broken}=<n> (a whole number from ${floor(broken)} to 10), or remove the key.` };
    const [listed, strangers, absent] = [known(root, undefined, undefined, readOnly), [], []];
    if (!listed) return { ok: false, reason: `the known project list is missing. This read-only check does not make it: sage merge-check --sha <sha> makes ${join(root, "projects.tsv")} or says how to get it back.` };
    const each = (logbook === null ? folders(root) : [join(root, logbook)]).flatMap((dir) => {
      // A saved change stops the project that holds it: this check refuses for that logbook only when it names this commit, or when its marker cannot be read.
      if (hasPendingWrite(dir)) {
        if (!readRegular(join(dir, "ledger.tsv"))?.includes(sha) && !pendingNames(dir, sha)) return skipped.push(basename(dir)), [];
        throw new RecordedWriteError(`Project ${visible(basename(dir))} holds an incomplete saved change, and its ledger or that change names ${sha.slice(0, 7)}. Any write in that project finishes it or says what to do. Then check again.`);
      }
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
      const [byId, ownOf, findingsOf, runsOf, decisionsOf, ledgerOf] = [new Map(tasks.map((t) => [t.id, t])), group(rows), group(findings), group(runs), group(decisions), group(ledger)];
      const candidates = runs.filter(isCandidate);
      // A task owns the head branch by its branch=, by its name, or by a run of it on that branch: a task that ran work
      // there and then moved to another branch still owns it (R1709-1).
      const ranOn = new Map();
      for (const r of runs) if (sameBranch(r.branch, head) && !ranOn.has(r.task)) ranOn.set(r.task, r.id);
      // An adopted branch carries the source task's number, so an unrelated task of that number owns it only by a record (T575).
      const adopter = head === undefined ? undefined : tasks.find((t) => adoptionOf(t)?.branch === head);
      const named = (id) => ofTask(id, String(head)) && (!adopter || adopter.id === id);
      // How a task owns the head: the refusal says what will work, for only a task that owns it by branch= alone can move off it (R1741-1).
      const how = (id) => (named(id) ? "by its name" : ranOn.has(id) ? `by run ${ranOn.get(id)} on it` : byId.get(id)?.branch === head ? "by its branch=" : "");
      const owns = (id) => how(id) !== "";
      // The way back for a task of the PR that does not own the head (R1759-1): a rename leaves the other task behind, so
      // set its branch= to the head. A task shares only another task's branch= (mayName), so the task whose name the head
      // carries names it first when no task does.
      const sharer = head !== undefined && (tasks.find((t) => t.branch === head) ?? tasks.find((t) => ofTask(t.id, String(head))));
      const back = (id) => sharer && [...(sharer.branch === head ? [] : [sharer.id]), id];
      // A shared head branch (T439): each task that owns it must be a task of the PR too, so a task that joins another
      // task's branch cannot merge that task's work on its own verdicts (F-T273-8).
      if (head !== undefined && ofPr.size) absent.push(...tasks.filter((t) => !ofPr.has(t.id) && owns(t.id)).map((t) => ({ name: `${visible(dir)} ${t.id}`, how: how(t.id) })));
      const graph = waitGraph(tasks, book ? rowsOf(book.milestones) : [], book ? rowsOf(book.gates) : [], decisions);
      const chief = basename(dir) !== mine ? undefined : merger ?? (session !== undefined ? chiefFor(project, session, env) : undefined);
      const checked =[...new Set([...rows.map((r) => r.task), ...ofPr])].map((id) => {
        // The cycles of an earlier head of the task count after clean merges of main, in the merged project's git only (T805).
        const task = byId.get(id), carry = carryOver(gitOf(dir), task, sha, ownOf.get(id) ?? [], ledgerOf.get(id) ?? []), own = carry.rows;
        // A held task never merges until the sage moves it (F-T273-12).
        const held = task?.state === "held" && { ok: false, reason: `${id} is held: only the sage moves a held task, and it does not merge until then.` };
        const judged = judge(dir, task, findingsOf.get(id) ?? [], decisionsOf.get(id) ?? [], id, own, task ? Math.max(cycles ?? 0, cyclesFor(task, cfg)) : cycles, repaired, cfg, pr, carry.from);
        // The reason says which head's cycles it used, or, on a refusal, why an earlier head's did not count.
        const note = carry.from ? `cycles from ${carry.from} carried to ${sha}: clean merge of main, same patch-id` : carry.why;
        const verdict = !note ? judged : judged.ok ? (carry.from ? { ...judged, reason: judged.reason.replace(/ on this SHA$/, `, ${note}`) } : judged) : { ...judged, reason: `${judged.reason} ${carry.from ? `(${note})` : note}` };
        // A review or QA run that still runs may hold a finding that no verdict shows yet (F-T289-18). It refuses a task that
        // would pass, so a refusal still names an open finding first.
        const live = (runsOf.get(id) ?? []).filter((r) => r.status === "running" && CHECKERS.includes(r.role)).map((r) => `${r.id} (${r.role})`);
        const busy = verdict.ok && live.length > 0 && { ok: false, reason: `${id} has a review or QA run that still runs: ${live.join(", ")}. End it with its report's findings recorded, then check again.` };
        // With no --head, the task's branch= says what would land.
        const bar = candidateBar(task ?? { id }, head ?? task?.branch, candidates, runsOf.get(id) ?? []), arena = bar && { ok: false, reason: bar };
        // A task whose new chief needs it (takenAt) passes only with one clean cycle on this SHA from runs that started after
        // the owner's answer to the takeover gate (T656, the owner's Q2; F-T656-23). The board reads the gate's question, so
        // it agrees (F-T656-1).
        const since = verdict.ok && task && takenAt(decisionsOf.get(id) ?? []), older = since && olderThan(since, runsOf.get(id) ?? []);
        const fresh = since && !cleanCycles(task, own.filter((r) => !older(r))) && { ok: false, reason: `${id} came from a chief of another provider through a takeover gate (${since}), so the cycles before that do not merge it alone: ${takeoverCycle ? takeoverCycle(id) : "its owning chief runs one cycle of its reviews and QA on this SHA, and records each verdict"}.` };
        // Nothing else helps a chief that does not own the task, so this refusal comes last and replaces the others.
        const notOwn = chief && task && liveBar(dir, task, chief), owner = notOwn && { ok: false, reason: notOwn };
        return { dir, id, ofPr: ofPr.has(id), owns: owns(id), back: !owns(id) && back(id), own: own.length, ...verdict, ...fresh, ...busy, ...arena, ...held, ...owner };
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
        const ok = here.get(task.id)?.ok === true && !unmetWaits(task, graph, (u) => passes(task, u)).length;
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
        for (const { id, pilot } of open) {
          const up = id && !pilot && byId.get(id), n = up && !dead(up.state) && !samePr(task, up) && prOf(up); // a pilot wait never passes in the same merge
          if (n) by.set(n, [...(by.get(n) ?? []), id]);
        }
        return [...by].map(([n, ids]) => ` ${task.id} is not on PR ${n}, so its wait on ${ids.join(", ")} cannot pass in this merge: run sage task ${task.id} set pr=${n}, and record its verdicts with --pr ${n}.`).join("");
      };
      return checked.map((r) => {
        const task = byId.get(r.id), open = task ? unmetWaits(task, graph, (u) => passes(task, u)) : [];
        if (!open.length || task.state === "held") return r;
        const milestone = open.some((w) => w.milestone), same = open.some((w) => !w.milestone && !w.pilot);
        const when = milestone ? until(open) : `${open.length === 1 ? "that task is" : "each of them is"} merged or concluded`;
        const after = when && `: it merges after ${when}${same ? `, or ${milestone ? "each such task passes" : "passes"} in this same merge on the same PR` : ""}`;
        return { ...r, ok: false, reason: `${r.id} waits for ${waitList(open)}${after}.${waitFix(task, open)}${offPr(task, open)}` };
      });
    });
    const one = strangers.length === 1;
    if (strangers.length) return { ok: false, reason: `${strangers.map(visible).join(" and ")} ${one ? "has" : "have"} verdicts on ${sha.slice(0, 7)} but ${one ? "is" : "are"} not in the known project list (${join(root, "projects.tsv")}), so the merge check refuses: a logbook that init did not make may be forged. init adds only a project's own logbook folder, so it does not help here. If ${one ? "it is" : "one is"} a project's logbook under another name (a renamed folder or a link), ask the user to give the folder back its own name, or to run ${REBUILD} and check each folder that it prints. If no project uses ${one ? "it" : "one"}, ask the user to remove it.` };
    if (!each.length) return { ok: false, reason: `no verdicts recorded for ${sha}. Record the reviews and QA with sage verdict first.` };
    if (pr && !each.some((r) => r.ofPr)) return { ok: false, reason: `no task of PR ${pr}${mine === undefined ? "" : ` in this project's logbook (${visible(mine)})`} has verdicts on ${sha.slice(0, 7)}: only ${each.map((r) => `${visible(r.dir)} ${r.id}`).join(", ")} ${each.length === 1 ? "has" : "have"}. Record PR ${pr}'s verdicts under its own task (sage verdict <T> --sha <sha> --pr ${pr}), or set its PR: sage task <T> set pr=${pr}.` };
    // The head branch rule comes after each task's own judgment, so a refusal names a task's missing verdicts first.
    const strays = head === undefined ? [] : each.filter((r) => r.ofPr && !r.owns);
    if (strays.length && each.every((r) => r.ok)) {
      const back = strays.every((r) => r.back) && [...new Set(strays.flatMap((r) => r.back))].map((id) => `sage task ${id} set branch=${head}`).join(", then ");
      const fix = back ? `It is the branch of another task, so set the branch= back to it: ${back}` : `Rename the branch to a task name (for example sage/${strays[0].id.toLowerCase()}-<words>)`;
      return { ok: false, reason: `PR ${pr}'s head branch ${JSON.stringify(head)} is not a branch of ${strays.map((r) => `${visible(r.dir)} ${r.id}`).join(", ")}, so the merge check refuses: each task that is or was on a pull request must own its head branch, a branch named for the task. ${fix}, or the user lands this pull request.` };
    }
    if (absent.length && each.every((r) => r.ok)) {
      const movable = absent.filter((a) => a.how === "by its branch=").map((a) => a.name);
      const move = !movable.length ? "" : movable.length === absent.length ? `, or move ${absent.length === 1 ? "it" : "them"} to another branch` : `, or move ${movable.join(", ")} to another branch`;
      return { ok: false, reason: `PR ${pr}'s head branch ${JSON.stringify(head)} also belongs to ${absent.map((a) => `${a.name} (${a.how})`).join(", ")}, which ${absent.length === 1 ? "is" : "are"} not on PR ${pr}, so the merge check refuses: each task of a shared branch must be on its pull request and pass on its own verdicts. Set ${absent.length === 1 ? "its" : "the"} pr=${pr}${absent.length === 1 ? "" : " of each"} and record its verdicts with --pr ${pr}${move}.` };
    }
    if (each.length === 1) return { ok: each[0].ok, reason: each[0].reason };
    const all = `${each.length} tasks have verdicts on ${sha.slice(0, 7)}${pr ? ` or belong to PR ${pr}` : ""}, and each must pass`;
    const bad = each.filter((r) => !r.ok);
    if (!bad.length) return { ok: true, reason: `${all}: ${each.map((r) => `${visible(r.dir)} ${r.reason}`).join("; ")}` };
    const out = bad.some((r) => r.own) ? ", or push a new commit and record its verdicts under the live tasks only" : ""; // a new commit leaves behind only verdicts
    return { ok: false, reason: `${all}; ${bad.length} fail${bad.length === 1 ? "s" : ""}. ${bad.map((r) => `${visible(r.dir)} ${r.reason}`).join(" ")} To merge, make each one pass${out}.` };
  } catch (e) {
    if (e instanceof RecordedWriteError) return { ok: false, reason: `the merge check refuses this merge: ${e.message}` };
    if (e instanceof Refusal) return { ok: false, reason: `the merge check refuses every merge, because ${e.message}` }; // it names the file and what to do
    const [at, why] = [e?.path, e?.code ?? e?.message ?? e];
    if (at === undefined) return { ok: false, reason: `the merge check failed (${why}), so it refuses every merge.` };
    return { ok: false, reason: `the merge check cannot read ${visible(at)} (${why}), so it refuses every merge. ${fixIt(at, why, root)}` };
  }
}

/**
 * The milestone lines of status, one for each milestone: the owner's state word, its progress (progressText: its merged or concluded tasks of all its
 * tasks, and each abandoned task by id, the owner's Q3), its pilot and what it waits for, then its name last, after a
 * label, so the name cannot pass for the status. A done or dropped milestone keeps its name and count, and a dropped one
 * names the next step for its tasks that have not ended. A milestone whose pilot is abandoned or lost is stuck, also before
 * its approval, as on the board. The graph has the tasks by milestone (shownGraph), so the lines are linear in the tasks (R1208-5).
 */
function milestonesLine(graph) {
  const { byId, milestones, byMilestone } = graph;
  return [...milestones.values()].map((p) => {
    const own = byMilestone.get(p.id) ?? [], text = progressText(progressOf(own));
    const open = own.filter((t) => !ENDED.includes(t.state)).length;
    const state = shownMilestoneState(p, graph), pilot = byId.get(p.pilot)?.state;
    // The board's words for each state (F-T233-11), and why a lost milestone is lost (F-T233-2).
    const why = { proposed: ` · breakdown waits for you (${p.gate})`, changing: ` · you asked for changes (${p.gate}): the chief revises the breakdown`, lost: ` · ${lostClause(p)}` }[p.state] ?? "";
    const line = state === "dropped" ? `dropped${open ? `: ${open} ${open === 1 ? "task" : "tasks"} still in it, take each out with milestone=none` : ""}`
      : state === "done" ? text
      : state === "stuck" ? `${text} · pilot ${p.pilot} ${pilot ?? "not in the logbook"}: choose a new pilot, or drop the milestone`
      : `pilot ${p.pilot}: ${text}${why}`;
    // The owner's word (state-words.mjs, T997) comes first after the release, as on the release line.
    return `milestone ${p.id}${p.release ? ` · release ${oneLine(p.release)}` : ""} · ${milestoneWordOf(p, graph).word} · ${line} · name: ${oneLine(p.name)}`;
  });
}

/**
 * The release line of status (T1003), one for each release in row order: its state, the count of its tasks (done, of all
 * the tasks of its milestones and its single tasks, and the stopped ones), its milestones and single tasks, then its goal
 * last, after a label. A release that a cell names and the releases table lacks says so.
 */
const releaseLine = (r) => `release ${oneLine(r.name)} · ${r.missing ? "not in the logbook: add it with release add, or set the release of each milestone and single task again" : r.state} · ${r.done} of ${r.total} ${r.total === 1 ? "task" : "tasks"} done${r.stopped ? ` · ${r.stopped} stopped` : ""}`
  + `${r.milestones.length ? ` · milestones ${r.milestones.map((m) => m.id).join(", ")}` : ""}${r.singles.length ? ` · single tasks ${r.singles.map((t) => t.id).join(", ")}` : ""}${r.goal ? ` · goal: ${oneLine(r.goal)}` : ""}`;

/**
 * A gate's question on the status line: a breakdown gate's first line and its count of tasks (each task line starts with
 * two spaces), as the board shows it whole. Only the data rule (breakdownGate) marks a breakdown gate, never its text.
 */
const gateShort = (g, { milestones, renamed }) => {
  const [first, ...rest] = gateLines(g, milestones, renamed);
  const n = rest.filter((l) => l.startsWith("  ")).length;
  // A move gate's first two lines: its plan and its question, as a breakdown gate shows its first line (F-T640-55).
  if (moveOf(g)) return String(g.question).split(LINE).slice(0, 2).join(" · ");
  return breakdownGate(g, milestones, renamed) ? `${first} (breakdown, ${n} ${n === 1 ? "task" : "tasks"})` : first;
};
/** The status lines. With save, also status.md: only a command that holds the lock saves, so status.md never lags. */
function status(dir, save) {
  assertNoPendingWrite(dir);
  const tasks = read(dir, "tasks");
  const runs = read(dir, "runs");
  const all = read(dir, "gates"), gates = all.filter((g) => !g.answer);
  // The graph as the boards show it (shownGraph): a breakdown waits for the owner only on its breakdown gate by the data rule.
  const graph = shownGraph(waitGraph(tasks, read(dir, "milestones"), all, read(dir, "decisions")), all);
  const count = {};
  for (const t of tasks) count[t.state] = (count[t.state] ?? 0) + 1;
  const tokens = runs.reduce((n, r) => n + (r.status === "done" && tokenCount(r.tokens) ? Number(r.tokens) : 0), 0);
  const lines = [
    // The name that the board shows (T305): the display name, the upstream's or origin's repository, the checkout's folder.
    `sage · ${shownName({ name: basename(dir), ...logbookIdentity(dir) })} · ${now().slice(11, 16)} UTC`,
    `tasks   ${tasks.length}${Object.entries(count).map(([s, n]) => ` · ${s} ${n}`).join("")}`,
    `gates   ${gates.length} open${gates.map((g) => ` · ${g.id} ${gateShort(g, graph)} (default: ${g.default || "none"})`).join("")}`,
    `agents  ${runs.length} runs · ${runs.filter((r) => r.status === "running").length} running · about ${Math.round(tokens / 1000)}k tokens · ${usageSummary(runs)}`,
  ];
  // The open tasks that wait, each with its unmet waits: a line only when one waits. Then the milestones: a line only when there is one.
  const waiting = tasks.filter((t) => !ENDED.includes(t.state)).map((t) => [t, shownOpen(t, graph)]).filter(([, open]) => open.length);
  if (waiting.length) lines.push(`waits   ${waiting.length} waiting${waiting.map(([t, open]) => ` · ${t.id} for ${waitList(open)}`).join("")}`);
  // The open tasks with no priority (T500): older rows stay valid, so status names them for the chief to set.
  const none = tasks.filter((t) => !ENDED.includes(t.state) && !t.priority).map((t) => t.id);
  if (none.length) lines.push(`priority ${none.length} open task${none.length === 1 ? " has" : "s have"} none: ${none.slice(0, 10).join(", ")}${none.length > 10 ? `, and ${none.length - 10} more` : ""} · set them with task <T> set priority=<P0 to P3>`);
  lines.push(...releasesOf(read(dir, "releases"), graph).map(releaseLine), ...milestonesLine(graph));
  // The runs by task, once, so the usage lines are linear in the runs.
  const runsOf = new Map();
  for (const r of runs) (runsOf.get(r.task) ?? runsOf.set(r.task, []).get(r.task)).push(r);
  lines.push(...tasks.map(t => {
    const own = runsOf.get(t.id) ?? [];
    const measured = own.reduce((n, r) => n + (r.status === "done" && tokenCount(r.tokens) ? Number(r.tokens) : 0), 0);
    return `usage ${t.id} · ${measured} measured tokens · ${usageSummary(own)}`;
  }));
  const table = ["", "| Task | State | Size | Round | PR | Title |", "| --- | --- | --- | --- | --- | --- |", ...tasks.map((t) => `| ${t.id} | ${t.state} | ${t.size} | ${t.round} | ${t.pr} | ${t.title} |`)];
  if (save) put(join(dir, "status.md"), [`# ${lines[0]}`, "", ...lines.slice(1).map((l) => `    ${l}`), ...table].join("\n") + "\n");
  return lines.join("\n");
}

const TOP = 50; // the tasks that sage stats shows in its table, largest review tokens first

/**
 * The review cost of each task (T346), largest review tokens first: its review and QA runs, their tokens, the tokens of
 * its runs after round 0 (a run added in repair round 1 or later: the cycle starts again at 1 on each new commit, so the
 * run's round is what tells a repair's review), its repair rounds, and its findings by role and by cycle. One total line
 * comes before the table, which shows the TOP tasks and then says how many more there are. Only a done run's tokens
 * count. A finding's cycle is the cycle of its run's verdict in its own task's ledger rows: "none" when it names no run
 * or its run gave no verdict. Read only; each table is read and indexed once.
 */
function stats(dir, only) {
  assertNoPendingWrite(dir);
  const group = (rows, key) => rows.reduce((m, r) => (m.get(r[key])?.push(r) ?? m.set(r[key], [r]), m), new Map());
  const tasks = read(dir, "tasks").filter((t) => !only || t.id === only);
  const runs = group(read(dir, "runs").filter((r) => CHECKERS.includes(r.role)), "task"), findings = group(read(dir, "findings"), "task");
  const cycles = new Map(); // task, then run id, to the cycle of the run's first verdict
  for (const l of read(dir, "ledger")) if (l.run && !cycles.has(`${l.task}\t${l.run}`)) cycles.set(`${l.task}\t${l.run}`, l.cycle);
  const whole = (v) => (/^(0|[1-9]\d*)$/.test(v ?? "") ? Number(v) : undefined); // a hand-edited "x" is no number
  // A tokens cell counts only in the form that run done takes (1 to 12 digits); an older sage wrote any digit string.
  const tokens = (v) => (/^[1-9]\d{0,11}$/.test(v ?? "") ? Number(v) : 0);
  const tokensOf = (rs) => rs.reduce((n, r) => n + (r.status === "done" ? tokens(r.tokens) : 0), 0);
  const k = (n) => `${Math.round(n / 1000)}k`;
  const esc = (v) => String(v).replace(/\|/g, "\\|");
  const counts = (values) => [...values.reduce((m, v) => m.set(v, (m.get(v) ?? 0) + 1), new Map())].sort(([a], [b]) => (a < b ? -1 : 1)).map(([v, n]) => `${esc(v)}: ${n}`).join(" · ") || "none";
  const rows = tasks.map((t) => {
    const own = runs.get(t.id) ?? [], found = findings.get(t.id) ?? [];
    const cycle = (f) => { const c = f.run && cycles.get(`${t.id}\t${f.run}`); return c ? `cycle ${c}` : "none"; };
    return { t, own, found, tokens: tokensOf(own), later: tokensOf(own.filter((r) => whole(r.round) >= 1)), round: whole(t.round || "0"), cycle };
  }).sort((a, b) => b.tokens - a.tokens);
  const sum = (f) => rows.reduce((n, r) => n + f(r), 0);
  if (!sum((r) => r.own.length + r.found.length)) return "No review runs yet.\nData starts when a review or QA run ends with run done <R> --status done --tokens <n>, and its findings name it with finding add --run <R>.";
  // The total comes first, so that a view that cuts a long output keeps it; the table shows the TOP tasks only.
  const more = rows.length - TOP;
  return [
    "Tokens in thousands (k), of done runs only. A round is one repair of findings; after round 0 counts the runs of round 1 and later. A cycle is one set of reviews and QA on one head commit.",
    `total · ${rows.length} tasks · ${sum((r) => r.own.length)} review runs (${sum((r) => r.own.filter((x) => x.status === "done" && !tokens(x.tokens)).length)} done without tokens) · ${k(sum((r) => r.tokens))} tokens · ${k(sum((r) => r.later))} after round 0 · ${sum((r) => r.round ?? 0)} rounds · ${sum((r) => r.found.length)} findings`,
    "",
    "| Task | Review runs | Review tokens | After round 0 | Rounds | Findings by role | Findings by cycle | Usage |", "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows.slice(0, TOP).map((r) => `| ${esc(r.t.id)} | ${r.own.length} | ${k(r.tokens)} | ${k(r.later)} | ${r.round ?? "invalid"} | ${counts(r.found.map((f) => f.source))} | ${counts(r.found.map(r.cycle))} | ${usageSummary(r.own)} |`),
    "", `usage total · ${usageSummary(rows.flatMap(r => r.own))}`,
    ...(rows.some(r => usageSummary(r.own).startsWith("partial")) ? ["Partial totals do not establish which task cost less."] : []),
    ...(more > 0 ? ["", `${more} more tasks not shown; use --task <T>`] : []),
  ].join("\n");
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
    shared: isShared(dir, env),
    leadRun: (task) => one(rows("runs").filter((r) => r.task === task && r.role === "lead" && r.status === "running")),
    findings: (task) => rows("findings").filter((f) => f.task === task),
    /**
     * The task's review and QA runs, in any status, whose kept report has a medium or high finding with no row (unheld),
     * each { run, role, missing }, or whose kept report cannot be read while the run still runs, { run, role, problem }
     * (T956). A run with no kept report, or a damaged one, gives nothing here: it backs no verdict either.
     */
    unrecorded(id) {
      const task = one(rows("tasks").filter((t) => t.id === id));
      return !task ? [] : rows("runs").filter((r) => r.task === id && Object.hasOwn(BACKS, r.role)).flatMap((run) => {
        const kept = keptOf(dir, run.id);
        if (!kept || kept.damaged || kept.task !== id || kept.role !== run.role) return [];
        const report = readReport(kept.text), missing = report.unreadable ? [] : unheld(rows("findings"), rows("decisions"), task, run.id, report.findings);
        if (report.unreadable) return run.status === "running" ? [{ run: run.id, role: run.role, problem: report.problem }] : [];
        return missing.length ? [{ run: run.id, role: run.role, missing }] : [];
      });
    },
    shas: (task) => new Set(rows("ledger").filter((r) => r.task === task && r.sha).map((r) => r.sha)),
    verdicts: (task) => rows("ledger").filter((r) => r.task === task),
    /**
     * The clean cycles of a task on one SHA, as the merge check counts them: 0 for an unknown task, and null for a task whose
     * route has no review or QA (a tiny task without a risk flag or an arena), which needs no cycle (R1991-1).
     */
    cleanCycles: (id, sha) => {
      const task = one(rows("tasks").filter((t) => t.id === id)), on = rows("ledger").filter((r) => r.task === id && String(r.sha).toLowerCase() === String(sha).toLowerCase());
      return !task ? 0 : cleanKinds(task).length ? cleanCycles(task, on) : null;
    },
    endedLeadRuns: () => rows("runs").filter((r) => r.role === "lead" && r.status !== "running"),
    prTasks: (pr) => prHistory(prNumber(pr), rows("tasks"), rows("decisions"), rows("ledger")),
    /** The tasks that use a branch: by their branch= or by a run on it, in any letter case (R1740-1). */
    branchTasks: (name) => new Set([...rows("tasks").filter((t) => sameBranch(t.branch, name)).map((t) => t.id), ...rows("runs").filter((r) => sameBranch(r.branch, name)).map((r) => r.task)]),
  };
}

/** Refuses a path that holds something other than a regular file, as config writes nothing then. */
function fileOrNone(file) {
  const st = lstatSync(file, { throwIfNoEntry: false });
  if (st && !st.isFile()) refuse(`${file} is ${st.isSymbolicLink() ? "a link" : st.isDirectory() ? "a folder" : st.isFIFO() ? "a named pipe" : st.isSocket() ? "a socket" : "a device"}, not a regular file, so config writes nothing. Replace it with a regular file.`);
}
/** The config keys of one logbook, kept in its own config.json: the others are for all projects. */
const ownKey = (kv) => /^(name|archived|start)(=|$)/.test(kv);

/**
 * Sets the keys of one logbook in its own config.json: name= (the board's display name of the project; name= alone
 * removes it), archived=yes or no (the board folds an archived project away), and start=sage-mode or normal (each new
 * session of the project starts in sage mode, in Claude and in Codex, T948). A key of a newer version stays.
 */
function logbookConfig(dir, pairs) {
  const set = {};
  for (const kv of pairs) {
    const at = kv.indexOf("="), k = at < 0 ? kv : kv.slice(0, at), v = at < 0 ? undefined : kv.slice(at + 1);
    if (!ownKey(kv)) refuse(`"${visible(k)}" is a key for all projects, and name=, archived= and start= are keys of one logbook: set them in a config command of their own.`);
    if (v === undefined) refuse(`${k} needs a value: write ${k}=<value>`);
    if (k === "name") {
      const name = v.normalize("NFC"), why = name && nameProblem(name);
      if (why) refuse(`the name "${visible(name)}" ${why}. Nothing changed.`);
      set.name = name || undefined; // name= alone removes it
    } else if (k === "start") set.start = v === START_SAGE_MODE ? v : v === "normal" ? undefined : refuse(`start is ${START_SAGE_MODE} or normal, not "${visible(v)}". Nothing changed.`);
    else set.archived = v === "yes" ? true : v === "no" ? undefined : refuse(`archived is yes or no, not "${visible(v)}". Nothing changed.`);
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
  return `name=${visible(typeof next.name === "string" ? next.name : "")} archived=${next.archived === true ? "yes" : "no"} start=${next.start === START_SAGE_MODE ? START_SAGE_MODE : "normal"}`;
}


/** Runs one command and returns its output line(s). A refused command throws, with the reason. */
/** The folder of this command. A checkout that moved or was cloned again can leave a session in a folder that is gone. */
function folderHere() {
  try {
    return process.cwd();
  } catch (e) {
    if (e.code === "ENOENT") refuse("the current folder is gone: it was moved or removed. Nothing changed. Go to the project's folder, or give --project with its path.");
    throw e;
  }
}

/**
 * The old words of the renames of T995, kept for one version: program (now milestone) and release <T> (now unclaim).
 * release is the release level's word too (T1003), so only release with a task id, which no release name has, is the old word.
 */
const oldWord = (cmd, rest) => {
  if (cmd === "program") return "milestone";
  if (cmd !== "release") return undefined;
  try { return TASK_ID.test(parse(cmd, rest).pos[0] ?? "") ? "unclaim" : undefined; } catch { return undefined; } // a refusal of parse comes again from the command
};
/**
 * A command with an old word runs as its new form: the command program, release <T>, the option --program and a task set
 * key program=. Its output ends with a note that names the new word, so the chief learns it.
 */
function sage(argv, env = process.env) {
  const [cmd, ...rest] = argv, old = [], newCmd = oldWord(cmd, rest);
  const words = [newCmd ? (old.push(`${cmd} is ${newCmd} now`), newCmd) : cmd, ...rest.map((word, i) => {
    if (/^--program(?:=|$)/.test(word)) return old.push("--program is --milestone now"), word.replace("--program", "--milestone");
    if (cmd === "task" && rest[1] === "set" && i > 1 && word.startsWith("program=")) return old.push("program= is milestone= now"), `milestone=${word.slice(8)}`;
    return word;
  })];
  const out = sageCommand(words, env);
  return old.length ? `${out}\nnote: ${old.join("; ")}. The old words work for one more version.` : out;
}
/** One command, in this version's words (sage). */
function sageCommand(argv, env) {
  const [cmd, ...rest] = argv;
  if (!COMMANDS.includes(cmd)) refuse(`unknown command "${cmd ?? ""}". Commands: ${COMMANDS.join(", ")}`);
  const { pos, opt } = parse(cmd, rest);
  const readOnly = scopedRead(cmd, pos, opt);
  const root = sageRoot(env), project = resolve(opt.project ?? env.SAGE_PROJECT ?? folderHere());
  // First, because board, link, config, projects and merge-check return before they open a logbook. Only a command that names an actor locates here, so link can still replace a row that locate refuses.
  if ((opt.chief !== undefined || opt.lead !== undefined || chiefOnly(cmd, pos)) && !locate(project, env).shared) refuse(chiefOnly(cmd, pos) && cmd !== "claim" ? `${visible(project)} has no shared logbook, so it has no chiefs to hand a task to. Nothing changed.` : `${visible(project)} has no shared logbook, and only a shared logbook has chiefs: leave out --chief and --lead, and a task here needs no claim. Nothing changed.`);
  // The board reads every logbook, takes no lock and writes nothing. --name-hex gives the scope as the hex of its UTF-8
  // bytes, so that the hook's command line holds no text that the owner typed. Without --view it is the chat board.
  if (cmd === "board") {
    const hex = opt["name-hex"];
    if (pos.length > 1 || (hex !== undefined && unhex(hex) === undefined))
      refuse("board takes one scope or task id: this, all or a project's name, or --name-hex with the name's UTF-8 bytes in lower-case hex");
    const scope = hex !== undefined ? unhex(hex) : /^T[1-9]\d*$/.test(pos[0] ?? "") ? "this" : pos[0] ?? "this";
    let sources;
    try {
      if (env.SAGE_BOARD_ROOTS && Buffer.byteLength(env.SAGE_BOARD_ROOTS) > 65536) throw new Error("root configuration is too large");
      sources = env.SAGE_BOARD_ROOTS ? JSON.parse(env.SAGE_BOARD_ROOTS) : sessionSources(root, sharedRoot(env), provider);
      const folder = opt.project ?? env.PWD;
      // A chat board shows today's board when the resolver refuses; only a task view needs the logbook.
      const located = () => { try { return storeDir(folder, env); } catch (e) { if (readOnly) throw e; return null; } };
      const dir = !env.SAGE_BOARD_ROOTS && folder ? located() : null, key = dir && `${isShared(dir, env) ? "shared" : "current"}/${basename(dir)}`;
      // A shared project is this project by its logbook, also from a worktree or a subfolder; a legacy one as before.
      return boardView({ sources, scope, project: folder, logbookKey: readOnly ? key : null, here: key?.startsWith("shared/") ? key : null, providerRoots: sessionRoots(root, legacyRoots(env), provider), taskId: /^T[1-9]\d*$/.test(pos[0] ?? "") ? pos[0] : null, format: opt.view ?? "chat" });
    } catch (error) { refuse(error.message); }
  }
  if (!readOnly && statSync(root, { throwIfNoEntry: false })?.isDirectory() && ["projects.tsv", "projects.made"].every((f) => !lstatSync(join(root, f), { throwIfNoEntry: false }))) known(root); // the first writing command of this version lists today's logbooks
  if (cmd === "projects" && isShared(storeDir(project, env), env)) guard(storeDir(project, env), cmd, pos, opt, project, env);
  if (cmd === "projects") return pos.join(" ") === "rebuild" && opt["accept-listing"] === "yes" ? rebuild(dirname(storeDir(project, env))) : refuse(`projects takes only: ${REBUILD.slice(5)}. It lists each logbook folder that is in ${root} now as a known project, so that its verdicts count in the merge check. Run it only when the user asks for it, and show the user the folders that it prints.`);
  if (cmd === "link") {
    if (pos.length) refuse("link takes one of --to <folder> or --separate, and no other words.");
    return link(project, opt, env);
  }
  if (cmd === "move") return pos.length ? refuse("move takes one of --preview, --plan <plan> or --gate <G>, and no other words. Nothing changed.") : moveCommand(project, opt, env);
  if (cmd === "merge-check") {
    const cycles = opt.cycles === undefined ? undefined : (typed("cycles.small", opt.cycles) ?? refuse("--cycles is a whole number from 1 to 10")); // the chief's explicit count: it only raises a task's own count
    if (opt.pr !== undefined && !PR.test(opt.pr)) refuse("--pr is the pull request's number, with no leading zero, for example --pr 5");
    // With --chief, the check judges for that chief, as the hook does for its session: a task of another chief does not merge.
    const r = mergeCheck(opt.sha ?? refuse("merge-check needs --sha with the full 40-character SHA of the head commit: git rev-parse <branch>"), env, { cycles, pr: opt.pr, head: opt.head, project, chief: opt.chief });
    return r.ok ? r.reason : refuse(r.reason);
  }
  if (cmd === "config" && !pos.some(ownKey)) {
    const home = storeDir(project, env), set = {};
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
      if (isShared(home, env)) guard(home, cmd, pos, opt, project, env);
      notePlugin(env);
      // A shared project has one home for its cycle counts: a value that it writes never lands in a provider root.
      const common = isShared(home, env) ? pick(set, SHARED_KEYS) : {}, own = Object.fromEntries(Object.entries(set).filter(([k]) => !Object.hasOwn(common, k)));
      if (Object.keys(common).length) writeConfig(sharedRoot(env), common);
      if (Object.keys(own).length) writeConfig(sageRoot(env), own);
    }
    const c = { ...config(env, home), ...set };
    const models = Object.keys(c).filter((k) => MODEL.test(k));
    return [...Object.keys(c).filter((k) => !models.includes(k)), ...models].map((k) => `${k}=${c[k]}`).join(" "); // the numbers, then the models
  }
  const place = locate(project, env), { dir } = place;
  const repair = cmd === "logbook" && pos[0] === "repair";
  const skip = repair ? [...new Set(list(opt["accept-loss"]))] : [];
  // programs.tsv of a logbook from before the rename (T995) starts again too, while it is there: its refusal names it.
  const odd = skip.filter((t) => !Object.hasOwn(TABLES, t) && !(Object.hasOwn(OLD_TABLES, t) && lstatSync(join(dir, `${t}.tsv`), { throwIfNoEntry: false })));
  const changeLoss = repair && opt["accept-change-loss"] !== undefined;
  if (changeLoss && opt["accept-change-loss"] !== "yes") refuse("--accept-change-loss takes only yes. Run it only after the owner accepts the loss of the saved change.");
  if (repair && (odd.length || (!skip.length && !changeLoss))) refuse(`logbook repair needs --accept-loss with the tables whose rows the user accepts to lose, joined by a comma: ${Object.keys(TABLES).join(", ")}.${odd.length ? ` Not ${odd.join(", ")}.` : ""}`);
  if (!place.shared && !place.legacy && !existsSync(dir)) refuseNewLogbook(place.checkout, env);
  if (cmd !== "init" && !(repair && existsSync(dir)) && !existsSync(join(dir, "tasks.tsv"))) {
    const printed = visible(project); // a path with control characters prints otherwise than it is, so it gets no line to paste
    refuse(`no logbook for the project ${printed}. ${printed === project ? `Run: sage init --project ${shell(project)}` : "Its path has control characters, so no command is printed to paste. Rename the folder, or run sage init from inside it."}`);
  }
  // A read takes no lock: every file is replaced whole, so it sees the store before or after a change, never half of one.
  if (readOnly || (cmd === "logbook" && !repair) || cmd === "status" || cmd === "stats" || (cmd === "standing" && pos[0] !== "add") || (cmd === "pages" && pos[1] !== "record") || cmd === "worktrees") return act(cmd, pos, opt, dir, env, [], project);
  notePlugin(env);
  if (place.row && !place.row.commits && fillCommits(place.checkout, env)) locate(project, env); // the filled row may show a folder of another project
  const run = () => change(cmd, pos, opt, dir, env, skip, project, place.shared);
  if (cmd !== "init") return run();
  if (place.shared) guard(dir, cmd, pos, opt, project, env);
  // A logbook that locate sees in a provider root (also through a link, which the move does not take) wins (F-T642-5).
  else if (!existsSync(dir) && !place.legacy && startsShared(place.checkout, env)) return `${link(project, { separate: true }, env)}. Every plugin is ready, so the project starts there.`;
  // init takes the root's lock and checks the known project list first, so a refusal there makes no logbook.
  let out;
  known(dirname(dir), basename(dir), () => {
    out = makeLogbook(dir, project, env);
  });
  return out;
}

/**
 * Rule 3: a new project starts in the shared root when the adapter names each provider root (an explicit SAGE_HOME
 * gives a bare path, which stands for every root), every provider's plugin is ready (the move's contract, or "unused"),
 * and no provider root holds a logbook of its repository. Rule 2 wins, also for a clone's logbook, so that one move later
 * takes them together. Otherwise init makes a legacy logbook, as before, and the move takes it there later. A plugins.tsv
 * or a root that sage cannot trust is not ready: init then works as before. So is a folder that is no whole Git repository:
 * with no repository, the row would have no first commit, and Git would run at each write to look for one (F-T642-6); a
 * shallow clone's first commit is its newest, so it would miss the shared logbook of its repository (F-T642-3). A folder
 * that sage cannot read or a shared root that it cannot write also starts legacy, with no stack (F-T642-4, F-T649-1).
 */
function startsShared(checkout, env) {
  try {
    const named = rootsOf(env);
    if (!named.length || !named.every((root) => root.provider)) return false;
    let shallow;
    try { shallow = readLocalGit(checkout, ["rev-parse", "--is-shallow-repository"]).toString().trim(); } catch { return false; }
    // A fork's logbook counts too, as before the move left forks out (T646): rule 2 wins for every logbook of the repository.
    const logbooks = shallow === "false" && !waitingPlugins(env).length && repositoryLogbooks(checkout, env);
    if (!logbooks || logbooks.sources.length || logbooks.forks.length) return false;
    const shared = rootOf(env), test = join(shared, `.sage-init-test-${randomUUID()}`);
    mkdirSync(shared, { recursive: true });
    writeFileSync(test, "", { flag: "wx" });
    unlinkSync(test);
    return true;
  } catch (e) {
    if (e instanceof Refusal || /^E[A-Z]+$/.test(e.code ?? "")) return false;
    throw e;
  }
}

/** What a repair of a stuck saved change says: the loss in plain words, then the logbook check of what stays. */
function lostChangeLine(dir, { request, aside }) {
  const loss = `The saved change${request} is lost: ${PENDING} moved to ${aside}, and the decision is in decisions.tsv. A half-published update can leave mixed tables, where some tables hold the change and others do not. Sage does not repair them, so read the rows of the last work.`;
  try {
    ready(dir);
    status(dir, true);
    return `${loss} The logbook check passes, and writes work again. The check reads each table alone, so it cannot show that the tables agree.`;
  } catch (error) {
    if (!(error instanceof Refusal || error instanceof RecordedWriteError)) throw error;
    return `${loss} The logbook check fails, so writes still stop: ${error.message}`;
  }
}

/** One command that changes a logbook: its lock, the settle step and the integrity check, the writer guard, the command, then the status file. */
function change(cmd, pos, opt, dir, env, skip, project, guarded) {
  const changeLoss = opt["accept-change-loss"] !== undefined;
  return withLock(dir, () => {
    // A stuck saved change stops ready and status, so its repair runs them itself, after the marker moves.
    if (!changeLoss) ready(dir, env, skip);
    if (guarded) opt.chief = guard(dir, cmd, pos, opt, project, env);
    const out = act(cmd, pos, opt, dir, env, skip, project);
    if (!changeLoss) status(dir, true);
    return out;
  });
}

/** A chief's id with its provider, when chiefs.tsv has its row. */
function chiefLabel(dir, id) {
  const row = chiefs(dir).find((r) => r.id === id);
  return row ? `${id} (${row.provider})` : id;
}
/** Why this chief does not write this task, or "". An empty cell is a task with no owning chief. A lead claims nothing and opens no gate, so it reports to its chief. */
function ownerBar(dir, task, chief, lead = false) {
  if (task.chief === chief) return "";
  const report = "Report this to your chief: a lead writes only while its chief owns the task.";
  if (!task.chief) return `${task.id} has no owning chief, so ${chief} cannot change it. ${lead ? `Nothing changed. ${report}` : `Claim it first: ${claimStep(task.id, taskVersion(task), chief)}. Nothing changed.`}`;
  return `${task.id} belongs to chief ${chiefLabel(dir, task.chief)}, not to ${chief}. Nothing changed. ${lead ? report : `Change only your own tasks. To take ${task.id}, ask ${task.chief} to offer it to you, or open a takeover gate for the owner to answer: ${replaceStep(task.id, chief)}.`}`;
}
/**
 * The owner test of the merge check and of the push rule: why this chief does not land or push a task's work, or "". An
 * ended task (merged, concluded or abandoned) bars nothing: its chief has nothing left to do with it.
 */
const liveBar = (dir, task, chief) => (ENDED.includes(task.state) ? "" : ownerBar(dir, task, chief));
/** Why the chief of this session does not run a command on a task that the state tool does not write: "" for its own task, a task that the logbook lacks, or a legacy project. */
function sessionBar(project, id, native, env = process.env) {
  const { dir, shared } = locate(project, env), task = shared && read(dir, "tasks").find((t) => t.id === id);
  return task ? ownerBar(dir, task, chiefFor(project, native, env)) : "";
}
/**
 * Why the chief of this session does not push a branch (T822), or "": a live task of another chief, or of no chief, uses
 * it, by its branch= or by a run of it on the branch, as the merge check reads a task's branch. So after a takeover the
 * former chief and its agents push nothing to the task's branch. A branch that no task uses, and a legacy project, pass:
 * a legacy project's logbook is not read, so a damaged table there refuses no push (T901).
 */
function branchBar(project, branch, native, env = process.env) {
  if (!locate(project, env).shared) return "";
  const view = logbookView(project, env), tasks = [...view.branchTasks(branch)].map(view.task).filter(Boolean);
  if (!tasks.length) return "";
  const chief = chiefFor(project, native, env);
  for (const task of tasks) {
    const bar = liveBar(view.dir, task, chief);
    if (bar) return `${branch} is a branch of ${task.id}, so only its owning chief pushes it. ${bar}`;
  }
  return "";
}

/** The runs of a task that a transfer waits for, and that a takeover ends: each one that has not ended, also one of an unknown status. */
const activeRuns = (dir, id) => read(dir, "runs").filter((r) => r.task === id && !RUN_ENDS.includes(r.status));
/**
 * Refuses a change of owning chief while a run of the task is active. The run's end changes no task, so the chief runs the
 * command again then. A run of unknown status may never end: only a takeover ends it, so the refusal names that way out too.
 */
function runsBar(dir, task, what, chief) {
  const active = activeRuns(dir, task.id).map((r) => r.id);
  const replace = what === "accept" ? replaceStep(task.id, chief) : `open one that names the chief that goes on with ${task.id}`;
  if (active.length) refuse(`${task.id} has ${active.join(", ")} active, so it takes no ${what} yet: a transfer waits for each active run to end. Nothing changed. Run this again after they end. A run that never ends, such as one of unknown status, ends only through a takeover gate that the owner answers: ${replace}.`);
}
/** Appends the decision of a change of owning chief. */
const ownership = (dir, task, decision, why) => write(dir, "decisions", [...read(dir, "decisions"), { at: now(), task, decision: `${task} ${decision}`, why }]);
/** The open offer that this command names, or a refusal. */
function exactOffer(task, id) {
  const open = offerOf(task);
  if (open?.id !== need(id, "--offer with the offer's id")) refuse(`${task.id} has ${open ? `the open offer ${open.id}, not ${visible(id)}` : `no open offer ${visible(id)}`}, and an offer that was cancelled never comes back. Nothing changed. Read ${task.id} for its open offer. If it has none, ask its owning chief for a new offer.`);
  return open;
}
/** The chief that --to names. */
function chiefNamed(dir, to) {
  need(to, "--to with a chief id, for example --to C2");
  if (!chiefs(dir).some((r) => r.id === to)) refuse(`${visible(to)} is not a chief of this logbook (${join(dir, "chiefs.tsv")}). A session gets its id at its first write. Nothing changed. Use an id from that file: each row is one chief, with its provider.`);
  return to;
}

/**
 * The owner's answer to a takeover gate (kind replace): the one way that a task goes to a chief from another chief, or
 * from no chief when the claim is not that chief's to make. Tables and receipt publish as one saved change.
 */
function replaceChief(dir, g, answer, project, env) {
  const plan = replaceOf(g), task = read(dir, "tasks").find((t) => t.id === g.task);
  if (!plan || !task) refuse(`${g.id} does not name a task and two chiefs, so it replaces nobody. Answer ${optionsOf(g)[1] ?? "decline"}. Nothing changed.`);
  const active = activeRuns(dir, task.id).map((r) => r.id), added = active.filter((id) => !plan.runs.includes(id));
  const again = `Answer ${optionsOf(g)[1] ?? "decline"}, then open a new takeover gate. Nothing changed.`;
  if (task.chief !== plan.from) refuse(`${task.id} now belongs to ${task.chief ? `chief ${task.chief}` : "no chief"}, not to ${plan.from || "no chief"}, so ${g.id} is out of date. ${again}`);
  if (added.length) refuse(`${added.join(", ")} started after ${g.id} opened, so ${g.id} does not name each run that ends as failed. ${again}`);
  commitReplace(dir, { reference: { gate: g.id, task: task.id, to: plan.to, runs: active }, result: { at: now(), answer } });
  return `${g.id} answered · ${answer} · ${task.id} chief ${plan.to}${active.length ? ` · ${active.join(", ")} failed` : ""}${branchHeld(project, task.branch, plan.to, env)}`;
}
/**
 * The owner's decline of a takeover gate that an accept opened (its question says so): the task keeps its chief, and the
 * offer ends too, so the recipient does not accept again at once (F-T656-28, the design's state 7). One saved change, with
 * the answer's decision row. Undefined for any other decline, which changes no task.
 */
function declineOffer(dir, g, answer) {
  const plan = replaceOf(g), task = read(dir, "tasks").find((t) => t.id === g.task), open = task && offerOf(task);
  if (!plan?.offered || !open || task.chief !== plan.from || open.from !== plan.from || open.to !== plan.to) return undefined;
  commitReplace(dir, { reference: { gate: g.id, task: task.id, to: plan.to, runs: [], offer: open.id }, result: { at: now(), answer } });
  return `${g.id} answered · ${answer} · nothing replaced: ${task.id} keeps its chief ${task.chief}, and no run ended. The offer ${open.id} to ${plan.to} ended. ${g.id} is spent: to change the chief, open a new takeover gate.`;
}
/** Publishes the tables of a takeover answer (replaceDelta) and its receipt as one saved change. */
function commitReplace(dir, receipt) {
  const rows = Object.fromEntries(REPLACE_TABLES.map((table) => [table, read(dir, table)]));
  replaceDelta(receipt, rows);
  replaceWrites.commit(dir, receipt, Object.fromEntries(REPLACE_TABLES.map((table) => [table, tableText(table, rows[table])])));
}
/**
 * The one safe step that frees a task's branch when another worktree of the repository holds it, so that the new owning
 * chief can check it out (T656, the owner's Q3): a detach keeps that worktree's files and changes, and is never --force.
 * The path goes into the command quoted for a POSIX shell; a path with a control character gets no command (F-T656-14).
 */
function branchHeld(project, branch, to, env) {
  if (!branch) return "";
  let list = "";
  try { list = git(["-C", project, "worktree", "list", "--porcelain", "-z"], env); } catch { return ""; }
  const holder = list.split("\0\0").map((record) => record.split("\0")).find((lines) => lines.includes(`branch refs/heads/${branch}`))?.find((line) => line.startsWith("worktree "))?.slice("worktree ".length);
  if (!holder) return "";
  const then = `Then ${to} checks out ${branch} in its own worktree.`;
  if (/[\x00-\x1f\x7f]/.test(holder)) return `\n${branch} is checked out in another worktree, and git checks out a branch in one worktree only. That worktree's path has a control character, so sage prints no command for it: find it with git worktree list, and run git switch --detach in it, which keeps its files. ${then}`;
  // The command stands alone on its line, with no period after it, so that the owner can copy it as it is (F-T656-26).
  return `\n${branch} is checked out in the worktree ${holder}, and git checks out a branch in one worktree only. To free it, with its files kept, run this command:\ngit -C '${holder.replaceAll("'", "'\\''")}' switch --detach\n${then}`;
}
/**
 * Who held a task with no owning chief last: the chief that unclaimed it (an older row says released), or the provider of the logbook that the move
 * brought it from (the adoption record of version 2). Empty for a task that no chief held.
 */
function heldLast(dir, task) {
  const released = read(dir, "decisions").filter((d) => d.task === task.id).map((d) => /^T[1-9]\d* (?:unclaimed|released) by (C[1-9]\d*)$/.exec(d.decision)?.[1]).filter(Boolean).at(-1);
  const moved = adoptionOf(task);
  return released ? { released } : moved?.version === 2 ? { moved: moved.provider } : {};
}
/**
 * Opens a takeover gate (kind replace) that asks the owner to give a task to chief to; it names each active run that ends
 * as failed. A takeover gate of the same task and chiefs that is open already is the one: no second one opens (F-T656-4).
 * offered: an accept of the task's open offer opens it, so its decline ends that offer (F-T656-28).
 */
function takeoverGate(dir, task, to, offered = false) {
  const next = (id) => `Ask the owner to answer ${id}, in either chat. Nothing changes until then.`;
  const open = read(dir, "gates").find((g) => g.kind === "replace" && !g.answer && g.task === task.id && ((p) => p && p.from === task.chief && p.to === to)(replaceOf(g)));
  if (open) return `${open.id} is open already · ${open.question}\n${next(open.id)}`;
  // Only a plain PR number goes into the question, which replaceOf reads back: an older row's cell such as 040 would not (F-T656-21).
  const pr = PR.test(prNumber(task.pr)) ? prNumber(task.pr) : "";
  const ask = (fresh) => replaceQuestion({ from: task.chief, to, task: task.id, pr, title: oneLine(task.title), runs: activeRuns(dir, task.id), label: (chief) => chiefLabel(dir, chief), ...(!task.chief && heldLast(dir, task)), fresh, offered });
  // This provider's merge path needs one fresh cycle after a takeover from another provider's chief (takeoverCycle): the
  // question tells the owner, and every reader of it, the board too, keeps that rule (F-T656-1).
  const p = replaceOf({ question: ask(false) }), fresh = !!takeoverCycle && !!p && p.toProvider === provider && crossed(p);
  const g = { id: nextId(dir, "G"), task: task.id, question: ask(fresh), options: TAKEOVER_OPTIONS, recommendation: "approve", default: "", at: now(), kind: "replace" };
  write(dir, "gates", [...read(dir, "gates"), g]);
  return `${g.id} open · ${g.question}\n${next(g.id)}`;
}
/**
 * Why a task with no owning chief is not this chief's to claim, or "": another chief released it last, or the move
 * brought it from the logbook of another provider (the owner's Q1 of T656). Then only the owner's takeover gate gives it.
 */
function claimBar(dir, task, chief) {
  const held = heldLast(dir, task);
  if (held.released) return held.released === chief ? "" : `${chiefLabel(dir, held.released)} unclaimed ${task.id} last`;
  return "moved" in held && held.moved !== chiefs(dir).find((r) => r.id === chief)?.provider ? `${task.id} came in the move from the ${held.moved} logbook` : "";
}

/**
 * Is this task set the abandon of a task with no owning chief (T893)? Any chief may abandon such a task, with a reason:
 * it gives the task to no chief, so it is no takeover. Only the one change state=abandoned passes, and not for a lead.
 */
function abandonsUnclaimed(task, [, set, ...changes], opt, lead) {
  if (task.chief || lead || set !== "set" || changes.length !== 1 || changes[0] !== "state=abandoned") return false;
  if (!cell(opt.why)) refuse(`${task.id} has no owning chief. Any chief may abandon it, with a reason: add --why "<reason>". Nothing changed.`);
  return true;
}

/**
 * The one lead policy (lead-policy.mjs) on this logbook: why the lead of lead run lead ({ id, task }) may not make this
 * request, or undefined. view is the logbook's view (logbookView); project is the folder whose checkout gives the head of
 * the task's branch. The state tool's guard, the Claude hook and the Codex gate and server each call it (T928).
 */
function leadProblem(view, lead, request, project, env = process.env) {
  const head = () => { const branch = view.task(lead.task)?.branch; return branch ? branchTip(project, branch, env) : ""; };
  return leadPolicy(request, { lead, view, ofTask, branchOfTask, head });
}

/** The milestone id that milestone propose names: an old program id (PG<n>) through the logbook's id map (T995). guard and act both read it. */
const askedMilestone = (id, renamed) => (id === undefined ? undefined : (renamed.get(id) ?? id));

/**
 * The one guard of a shared logbook: step 5 of every writer. It gives the chief that this command acts for, or refuses.
 * The check prevents mistakes by normal agents; it does not stop an agent that gives another chief's id (F4). A lead acts
 * for the chief of its lead run, while that run runs, on the task of that run only (P4). A command with no chief only reads.
 */
function guard(dir, cmd, pos, opt, project, env) {
  const need = writerClass(cmd, pos);
  if (need.kind === "read" || (need.kind === "owner" && opt.lead === undefined)) return undefined;
  const name = [cmd, ...pos.slice(0, 1)].join(" ");
  if (opt.chief !== undefined && opt.lead !== undefined) refuse(`${name} takes --chief or --lead, not both. Nothing changed.`);
  const lead = opt.lead === undefined ? undefined : read(dir, "runs").find((r) => r.id === opt.lead && r.role === "lead" && r.status === "running")
    ?? refuse(`${visible(opt.lead)} is not a running lead run, so this lead writes nothing. Report to your chief. Nothing changed.`);
  // The one lead policy (T928): its list, its own task, the round order and the values of each command.
  const why = lead && leadProblem(logbookView(project, env), lead, leadRequest(cmd, pos, opt), project, env);
  if (why) refuse(`${why} Nothing changed.`);
  const chief = lead?.chief ?? opt.chief ?? refuse(`this logbook is shared, and a command with no chief only reads: add --chief <your C id> to ${name}. Nothing changed. Only a chief's session writes here. In a Claude session, run this write again as one command of its own, and the hook names your id. A Codex chief writes through the sage tools, which add its id. A terminal with no chief session only reads.`);
  if (!lead && !chiefs(dir).some((r) => r.id === chief)) refuse(`${visible(chief)} is not a chief of this logbook (${join(dir, "chiefs.tsv")}). Nothing changed.`);
  const tasks = need.kind === "any" ? [] : read(dir, "tasks");
  // A milestone proposed again: its pilot and each of its tasks, as each can leave it, and each task that the command names.
  // An old program id names its milestone as in act (F-T995-25). An ended task is history that propose never moves, so it
  // needs no owner; act refuses an ended task that the command names (F-T995-31).
  const old = need.kind === "milestone" ? read(dir, "milestones").find((p) => p.id === askedMilestone(pos[1], renamedIds(read(dir, "decisions")))) : undefined;
  const ids = need.kind === "milestone"
    ? [opt.pilot, old?.pilot, ...tasks.filter((t) => old && t.milestone === old.id).map((t) => t.id), ...(opt.tasks === undefined || opt.tasks === "none" ? [] : waitWords(opt.tasks))]
      .filter((id) => !ENDED.includes(tasks.find((t) => t.id === id)?.state))
    : [need.task ?? (need.run && read(dir, "runs").find((r) => r.id === need.run)?.task)];
  const named = ids.filter(Boolean); // a task or a run that the logbook lacks gets the command's own refusal
  if (need.kind !== "any") for (const id of new Set(named)) {
    const task = tasks.find((t) => t.id === id), declines = need.recipient && !lead && offerOf(task ?? {})?.to === chief; // the recipient declines an offer to it
    const bar = task && !declines && !(cmd === "task" && abandonsUnclaimed(task, pos, opt, lead)) && ownerBar(dir, task, chief, !!lead);
    if (bar) throw Object.assign(new Refusal(bar), { code: "other-chief" }); // a native writer passes these words on
  }
  return chief;
}

/** The chief of a provider's session in a project, its row added at its first write. Undefined for a legacy project. */
function chiefFor(project, native, env = process.env) {
  const { dir, shared } = locate(project, env);
  if (!shared) return undefined;
  return rowOf(dir, native)?.id ?? withLock(dir, () => chiefRow(dir, native).id);
}

/**
 * The options that a provider adds to a command that it runs for its caller: --chief, --lead for a lead, or none for a
 * read, a gate answer or a legacy project. The merge check reads, but it gets --chief, because it judges for the
 * session's chief (T656). A refusal here is the real cause, such as a damaged chiefs.tsv or a busy lock.
 */
function actorOptions(project, [cmd, ...rest], { native, leadTask }, env = process.env) {
  const { pos } = parse(cmd, rest);
  if (cmd === "merge-check") return locate(project, env).shared ? [`--chief=${chiefFor(project, native, env)}`] : [];
  if (["read", "owner"].includes(writerClass(cmd, pos).kind) || !locate(project, env).shared) return [];
  if (!leadTask) return [`--chief=${chiefFor(project, native, env)}`];
  const run = logbookView(project, env).leadRun(leadTask) ?? refuse(`${leadTask} has no running lead run, so this lead writes nothing. Report to your chief. Nothing changed.`);
  return [`--lead=${run.id}`];
}

/** Makes a new logbook's folders and tables, or checks an existing one, as init does. */
function makeLogbook(dir, project, env) {
  mkdirSync(join(dir, "briefs"), { recursive: true });
  mkdirSync(join(dir, "reports"), { recursive: true });
  return change("init", [], Object.create(null), dir, env, [], project);
}

/** Writes keys into a root's config.json under its lock. A key of a newer version stays. */
function writeConfig(root, values) {
  const file = join(root, "config.json");
  mkdirSync(root, { recursive: true });
  withLock(root, () => {
    fileOrNone(file);
    swap(file, JSON.stringify({ ...savedIn(root), ...values }, null, 2) + "\n");
  });
}

/**
 * At the first shared write: the shared root takes the largest value of each SHARED_KEYS count of the provider roots, so
 * a project never needs fewer cycles than the owner wrote. After that the shared root's counts are the owner's, and a
 * later link leaves them. The caller holds the root's lock. A count that has no number refuses, and no row is made,
 * because no largest value exists.
 */
function raiseCounts(shared, env) {
  const file = join(shared, "config.json"), held = savedIn(shared), roots = [...new Set([sageRoot(env), ...legacyRoots(env)])];
  if (SHARED_KEYS.some((key) => Object.hasOwn(held, key))) return;
  const next = Object.fromEntries(SHARED_KEYS.map((key) => {
    const values = roots.map((root) => [root, config({ ...env, SAGE_HOME: root })[key]]);
    const bad = values.find(([, value]) => value === "invalid");
    if (bad) refuse(`${key} in ${join(bad[0], "config.json")} is not a number, so sage cannot take the largest count for the shared root. Nothing changed. Set it to a whole number first.`);
    return [key, Math.max(...values.map(([, value]) => value))];
  }));
  fileOrNone(file);
  swap(file, JSON.stringify({ ...held, ...next }, null, 2) + "\n");
}

/** The chief cell of a new task or run: only a shared logbook's write has a chief. */
const chiefTag = (opt) => (opt.chief === undefined ? {} : { chief: opt.chief });
/** The checkout cell of a new run: only a shared logbook's run has one, the root of the project's bindings.tsv row. */
const checkoutTag = (dir, project, env) => (isShared(dir, env) ? { checkout: locate(project, env).row.root } : {});

/**
 * milestone <M> set release=<name> (T1003): puts a milestone in a release, moves it to another one (a late milestone, when
 * the owner says that a release ships), or takes it out with release=none. Each change writes a decision row.
 */
function milestoneSet(dir, asked, changes) {
  const [milestones, decisions] = ["milestones", "decisions"].map((t) => read(dir, t));
  const id = askedMilestone(asked, renamedIds(decisions)), m = milestones.find((p) => p.id === id) ?? missing(`milestone ${visible(asked)}`, milestones.map((p) => p.id));
  if (!changes.length || changes.some((kv) => !kv.startsWith("release="))) refuse(`milestone <M> set takes release=<name>, or release=none to take the milestone out of its release. Nothing changed.`);
  if (changes.length > 1) refuse(`${m.id} is in at most one release: give release= once. Nothing changed.`);
  const was = m.release ?? "", to = releaseValue(changes[0].slice("release=".length), read(dir, "releases"), m.id);
  if (to !== was) {
    write(dir, "milestones", milestones.map((p) => (p === m ? { ...p, release: to } : p)));
    write(dir, "decisions", [...decisions, { at: now(), task: "", decision: `${m.id} release ${was || "none"} → ${to || "none"}`, why: "milestone set" }]);
  }
  return `${m.id} · release ${to || "none"} · name: ${oneLine(m.name)}`;
}

function act(cmd, pos, opt, dir, env, skip, project) {
  const [sub, id, ...more] = pos;
  switch (cmd) {
    case "task-adopt": {
      if (pos.length !== 1) refuse("task-adopt takes one destination task id.");
      // After the move, the other provider's tasks are here already, and only the owner's takeover gate moves one (the owner's Q4 of T656).
      if (isShared(dir, env)) refuse(`this logbook is shared, so task-adopt takes in no task: the other provider's tasks are in it already. A task of another chief comes to you only through the owner's takeover gate: ${replaceStep("<task>", opt.chief)}. Nothing changed.`);
      const { tasks, task } = taskOf(dir, need(sub, "the destination task id"));
      const provider = need(opt["source-provider"], "--source-provider"), sourceTask = need(opt["source-task"], "--source-task");
      const path = need(opt["source-logbook"], "--source-logbook"), pr = need(opt.pr, "--pr"), branch = branchOf(need(opt.branch, "--branch"));
      if (!/^[a-z][a-z0-9-]*$/.test(provider) || !TASK_ID.test(sourceTask) || !isAbsolute(path) || !PR.test(pr)) refuse("adoption needs a provider name, source task id, absolute source logbook and PR number. Nothing changed.");
      let source;
      try { source = realpathSync(path); } catch { refuse("the source logbook does not exist. Nothing changed."); }
      const identity = { provider, task: sourceTask, logbook: source, project: projectRoot(project), pr, branch };
      if (source === realpathSync(dir) || basename(source) !== basename(dir)
        || readRegular(join(source, "checkout.txt"))?.trim() !== identity.project) refuse("the source logbook must belong to this project under another provider root. Nothing changed.");
      const prior = adoptionOf(task);
      if (prior) {
        if (Object.entries(identity).some(([key, value]) => prior[key] !== value)) refuse(`${task.id} already has a conflicting adoption. Nothing changed.`);
        return `${task.id} adopted (already recorded) · ${provider} ${sourceTask} · PR ${pr} · ${branch} · round ${task.round}`;
      }
      // The source is read only. Refuse an active writer or a changed snapshot instead of taking its lock.
      if (existsSync(join(source, ".lock"))) refuse("the source logbook is busy. Nothing changed.");
      const book = check(source), sourceRows = rowsOf(book.tasks), matches = sourceRows.filter(t => t.id === sourceTask);
      if (matches.length !== 1) refuse("the source task is missing or ambiguous. Nothing changed.");
      const old = matches[0];
      if (old.adoption || !ofTask(sourceTask, branch) || (old.branch && old.branch !== branch) || prNumber(old.pr) !== pr
        || !builds(old) || ENDED.includes(old.state) || !/^\d+$/.test(old.round) || !Number.isSafeInteger(Number(old.round))) refuse("the source task, PR or branch does not match this adoption. Nothing changed.");
      const sourceEnv = { ...env, SAGE_HOME: dirname(source) }, sourceConfig = config(sourceEnv);
      const broken = Object.keys(sourceConfig).find(k => sourceConfig[k] === "invalid");
      if (broken) refuse(`the source ${broken} is not a number. Nothing changed.`);
      const decisions = read(dir, "decisions"), ledger = read(dir, "ledger"), runs = read(dir, "runs");
      // Only a record claims: provider task numbers overlap, so a branch name that looks like a task's number is no claim (T575).
      const claims = (t, decisions, ledger, runs) => prsOf(t, decisions, ledger).has(pr) || sameBranch(t.branch, branch)
        || runs.some(r => r.task === t.id && sameBranch(r.branch, branch));
      const claimed = tasks.find(t => t.id !== task.id && claims(t, decisions, ledger, runs));
      if (claimed) refuse(`${claimed.id} already claimed this PR or branch. Nothing changed.`);
      const sourceClaim = sourceRows.find(t => t.id !== sourceTask && claims(t, rowsOf(book.decisions), rowsOf(book.ledger), rowsOf(book.runs)));
      if (sourceClaim) refuse(`${sourceClaim.id} also claims the source PR or branch. Adopt shared work only after the owner resolves its task mapping. Nothing changed.`);
      if (!["framed", "briefed"].includes(task.state) || !builds(task) || (task.branch && task.branch !== branch) || (task.pr && task.pr !== pr)
        || [...prsOf(task, decisions, ledger)].some(n => n !== pr) || runs.some(r => r.task === task.id && (!r.ended || !["blocked", "failed"].includes(r.status)))
        || ledger.some(r => r.task === task.id) || read(dir, "findings").some(f => f.task === task.id)) refuse("adoption needs a framed or briefed destination with only ended blocked or failed runs, no findings or verdicts, and no conflicting PR/branch history. Nothing changed.");
      if (list(old.risk).some(r => !RISKS.includes(r)) || list(old.route).some(b => !BLOCKS.includes(b))) refuse("the source route or risk flags are unknown. Nothing changed.");
      let head;
      try { head = pullRequestHead(pr, project, env); } catch (error) { refuse(`adoption cannot check the PR: ${error.message}. Nothing changed.`); }
      if (head !== branch) refuse("the PR head branch does not match this adoption. Nothing changed.");
      const graph = graphOf(dir);
      const adopted = { ...task, pr, branch, round: Math.max(Number(task.round), Number(old.round)),
        risk: RISKS.filter(r => list(task.risk).includes(r) || list(old.risk).includes(r)).join(","),
        route: BLOCKS.filter(b => list(task.route).includes(b) || list(old.route).includes(b)).join(","),
        adoption: JSON.stringify({ version: 1, ...identity, round: Number(old.round), cycles: cyclesFor(old, sourceConfig), digest: createHash("sha256").update(JSON.stringify(old)).digest("hex"), at: now() }) };
      // A large source retains its two-cycle floor even when the destination was framed as small.
      if (old.size === "large") adopted.size = "large";
      apartFromPilot(adopted, graph, decisions, ledger, "pr", prsOf(task, decisions, ledger));
      if (existsSync(join(source, ".lock")) || JSON.stringify(check(source)) !== JSON.stringify(book)
        || JSON.stringify(config(sourceEnv)) !== JSON.stringify(sourceConfig)) refuse("the source changed during adoption. Nothing changed.");
      // All adopted fields and provenance share one atomic task-table replacement. No source proof is copied.
      Object.assign(task, adopted);
      write(dir, "tasks", tasks);
      return `${task.id} adopted · ${provider} ${sourceTask} · PR ${pr} · ${branch} · round ${task.round}; fresh destination reviews and QA required`;
    }
    case "config":
      return logbookConfig(dir, pos);
    case "claim": {
      const { tasks, task } = taskOf(dir, need(sub, "the task id"));
      if (task.chief) refuse(`${task.id} belongs to chief ${task.chief}, so it takes no claim. Nothing changed.`);
      const held = claimBar(dir, task, opt.chief);
      if (held) refuse(`${held}, so ${opt.chief} takes it only through the owner's takeover gate. Nothing changed. Open one for the owner to answer: ${replaceStep(task.id, opt.chief)}.`);
      if (opt.version !== taskVersion(task)) refuse(`${task.id} changed, so this claim is out of date: read it again, then claim it with --version ${taskVersion(task)}. Nothing changed.`);
      task.chief = opt.chief;
      write(dir, "tasks", tasks);
      ownership(dir, task.id, `claimed by ${opt.chief}`, "claim");
      return `${task.id} claimed · chief ${opt.chief}`;
    }
    case "offer": {
      const { tasks, task } = taskOf(dir, need(sub, "the task id")), to = chiefNamed(dir, opt.to), open = offerOf(task);
      if (open) refuse(`${task.id} has the open offer ${open.id} to ${open.to}: cancel it first. Nothing changed.`);
      if (to === opt.chief) refuse(`${task.id} is yours, so an offer names another chief. Nothing changed.`);
      task.offer = JSON.stringify({ id: randomUUID().slice(0, 8), from: opt.chief, to });
      write(dir, "tasks", tasks);
      ownership(dir, task.id, `offered to ${to}`, "offer");
      return `${task.id} offered to ${to} · offer ${offerOf(task).id} · version ${taskVersion(task)}. You stay its owning chief until ${to} accepts.`;
    }
    case "cancel": {
      // The owning chief cancels its offer. The chief that the offer names declines it (the guard lets it pass); the task keeps its chief.
      const { tasks, task } = taskOf(dir, need(sub, "the task id")), open = exactOffer(task, opt.offer), declined = open.to === opt.chief;
      task.offer = "";
      write(dir, "tasks", tasks);
      ownership(dir, task.id, declined ? `offer ${open.id} declined by ${opt.chief}` : `offer ${open.id} cancelled`, declined ? "decline" : "cancel");
      return declined ? `${task.id} offer ${open.id} declined by ${opt.chief} · chief ${task.chief} keeps ${task.id}` : `${task.id} offer ${open.id} cancelled`;
    }
    case "accept": {
      const { task } = taskOf(dir, need(sub, "the task id")), open = exactOffer(task, opt.offer);
      if (open.to !== opt.chief) refuse(`offer ${open.id} of ${task.id} names ${open.to}, not ${opt.chief}. Nothing changed. Only ${open.to} accepts it. ${task.chief === opt.chief ? `You own ${task.id}: to end this offer, cancel it.` : `To get ${task.id}, ask its owning chief ${task.chief} to cancel this offer and offer it to you.`}`);
      if (opt.version !== taskVersion(task)) refuse(`${task.id} changed, so this acceptance is out of date: read it again, then accept it with --version ${taskVersion(task)}. Nothing changed.`);
      runsBar(dir, task, "accept", opt.chief);
      // The owner decides each change of owning chief (T656): accept asks through a takeover gate, and the answer moves the task (replaceChief).
      return takeoverGate(dir, task, opt.chief, true);
    }
    case "unclaim": {
      const { tasks, task } = taskOf(dir, need(sub, "the task id")), open = offerOf(task);
      if (open) refuse(`${task.id} has the open offer ${open.id} to ${open.to}: cancel it first. Nothing changed.`);
      runsBar(dir, task, "unclaim", opt.chief);
      task.chief = "";
      write(dir, "tasks", tasks);
      ownership(dir, task.id, `unclaimed by ${opt.chief}`, "unclaim");
      return `${task.id} unclaimed · no owning chief. Only ${opt.chief} claims it back; another chief needs the owner's takeover gate.`;
    }
    case "init":
      // A new logbook's tables, tasks.tsv last: the merge check takes a folder with it for a whole logbook. An existing
      // logbook passed the integrity check (ready), so init makes no table there.
      for (const t of Object.keys(TABLES).reverse()) if (!existsSync(join(dir, `${t}.tsv`))) write(dir, t, []);
      if (!existsSync(join(dir, "standing.md"))) put(join(dir, "standing.md"), STANDING);
      checkout(dir, project, env);
      return `logbook ${dir}`;
    case "logbook": {
      if (sub !== "repair") return dir;
      // The user accepts the loss of the rows of each table in skip: its old file goes aside, never away, and the table
      // starts again. The decisions come first, so a write that fails or is stopped leaves no table reset without its
      // decision; a table reset without the others leaves the check failing, so nothing passes before the repair is whole.
      // A stuck saved change takes the same order: its decision, then its marker goes aside. A table that it left damaged
      // stays damaged, and the check says so.
      const change = opt["accept-change-loss"] ? stuckChange(dir, skip, env) : undefined;
      const tables = skip.map((table) => {
        const file = join(dir, `${table}.tsv`);
        try {
          sheet(dir, table);
        } catch {
          const aside = lstatSync(file, { throwIfNoEntry: false }) ? lostName(file) : "";
          return { table, file, aside, was: aside ? `; its old file is ${aside}` : "" };
        }
        return refuse(`${file} passes the logbook check, so it has nothing to repair. Nothing changed.`);
      });
      const decided = tables.map(({ table, was }) => ({ at: now(), task: "", decision: `${table}.tsv started again without rows${was}`, why: "the user accepts the loss of its rows" }));
      if (change) decided.push({ at: now(), task: "", decision: `saved change${change.request} moved aside to ${change.aside}`, why: "the owner accepts the loss of this saved change" });
      const trail = tables.find((t) => t.table === "decisions");
      if (trail?.aside) renameSync(trail.file, trail.aside);
      // A moved logbook's id floors are decision rows: a new decisions table takes them again from its old logbooks (F-T641-8).
      let floors = [];
      try { floors = trail ? idFloors(movedFrom(dir)) : []; } catch {}
      // The line about the move's id floors prints only when those came back, not for round keys alone (F-T648-8).
      const keys = trail ? keyFloors(dir) : [];
      write(dir, "decisions", [...(trail ? [] : read(dir, "decisions")), ...decided, ...floors, ...keys]);
      if (change) renameSync(change.marker, change.aside);
      for (const { table, file, aside } of tables.filter((t) => t !== trail)) {
        if (aside) renameSync(file, aside);
        write(dir, table, []);
      }
      const kept = tables.filter((t) => t.aside);
      const old = kept.length === 1 ? (tables.length === 1 ? `; its old file is ${kept[0].aside}` : `; the old file of ${kept[0].table}.tsv is ${kept[0].aside}`) : kept.length ? `; the old files are ${kept.map((t) => t.aside).join(" and ")}` : "";
      const restarted = tables.length ? `${tables.map((t) => `${t.table}.tsv`).join(" and ")} started again without rows${old}. The decision${tables.length === 1 ? " is" : "s are"} in decisions.tsv.${floors.length ? " The move's id floors are in it again, from the old logbooks." : ""}` : "";
      return change ? [restarted, lostChangeLine(dir, change)].filter(Boolean).join(" ") : restarted;
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
        const tags = { priority: priorityOf(opt.priority), ...(opt.kind !== undefined ? { kind: tag("kind", opt.kind) } : {}), ...chiefTag(opt) };
        const graph = graphOf(dir), next = { id: nextId(dir, "T"), state: "framed" };
        if (opt.waits !== undefined) tags.waits = waitsValue(next, opt.waits, [...graph.byId.values()]);
        if (opt.milestone !== undefined) tags.milestone = milestoneValue(next, opt.milestone, graph); // no loop: no task or pilot cell names a new id (IDS)
        const task = frame(dir, need(opt.title, "--title"), size, risk, list(opt.add), tags);
        checkout(dir, project, env);
        const at = now(), joined = milestoneDecision(task, "", at, "task add", graph);
        const decided = [...(opt.add ? [{ at, task: task.id, decision: `added ${opt.add}`, why }] : []), ...waitsDecision(task, "", at, "task add"), ...joined.rows];
        if (decided.length) write(dir, "decisions", [...read(dir, "decisions"), ...decided]);
        return `${framed(task)}${joined.note}`;
      }
      const { tasks, task } = taskOf(dir, need(sub, "the task id")); // task <T> [set key=value ...]
      let note = "";
      // --why is the reason of an abandon (T893): its decision row keeps the reason and the chief that acted.
      if (opt.why !== undefined && (id !== "set" || !more.includes("state=abandoned") || !cell(opt.why))) refuse(`--why gives the reason of an abandon: give a reason with state=abandoned, for example sage task ${task.id} set state=abandoned --why "<reason>". Nothing changed.`);
      const why = opt.why === undefined ? undefined : [cell(opt.why), opt.chief && `abandoned by ${opt.chief}${task.chief ? "" : ", with no owning chief"}`].filter(Boolean).join(" · ");
      if (id === "set") {
        const before = { tasks, runs: read(dir, "runs"), decisions: read(dir, "decisions") };
        const planned = planTaskChanges(before, task.id, more, now(), { ...Object.fromEntries(["findings", "ledger", "gates", "milestones", "releases"].map((t) => [t, read(dir, t)])), maxRounds: config(env, dir).max_rounds, why });
        const bar = moveBar(more, planned); // after the plan, so that a branch= in the same command counts, in either order
        if (bar) refuse(bar);
        if (JSON.stringify(planned.decisions) !== JSON.stringify(before.decisions)) write(dir, "decisions", planned.decisions);
        if (JSON.stringify(planned.runs) !== JSON.stringify(before.runs)) write(dir, "runs", planned.runs);
        write(dir, "tasks", planned.tasks);
        Object.assign(task, planned.task);
        note = planned.note;
      }
      return `${task.id} ${task.state} · ${task.size} · round ${task.round} · route ${task.route}${task.branch ? ` · ${task.branch}` : ""}${task.pr ? ` · PR ${task.pr}` : ""}${tagsOf(task)}${waitsText(task, shownOf(dir, tasks))}${note}${keptLines(dir, task.id)}`;
    }
    case "milestone": {
      // milestone propose writes a milestone, puts its pilot and its other tasks in it, and opens its breakdown gate on the
      // pilot task, where the board shows it under Needs you. The gate's question names each task and what it waits for
      // (R1205-1). milestone propose <M> proposes it again, after the owner's change or for a new pilot: a new gate, with
      // the milestone's tasks (or a new --tasks list) and its round.
      if (id === "set" && sub !== "propose") return milestoneSet(dir, sub, more);
      if (sub !== "propose" || more.length) refuse("milestone takes: propose --name <name> --goal <goal> --pilot <T> --tasks <T,T>, or propose <M> with --name, --goal, --pilot or --tasks to propose it again, or <M> set release=<name> (release=none takes it out)");
      const [tasks, milestones, gates, runs, decisions] = ["tasks", "milestones", "gates", "runs", "decisions"].map((t) => read(dir, t));
      const nothing = " Nothing changed.";
      // An old program id names its milestone through the logbook's id map (T995, F-T995-16): the line names the new id.
      const renamed = renamedIds(decisions), asked = askedMilestone(id, renamed);
      // A milestone of that name whose gate is not in the logbook is a propose that stopped before it wrote the gate: the
      // same command finishes it (R1246-2).
      const unfinished = id === undefined && opt.name !== undefined ? milestones.find((p) => looks(p.name) === looks(opt.name) && !gates.some((g) => g.id === p.gate)) : undefined;
      const old = unfinished ?? (asked === undefined ? undefined : (milestones.find((p) => p.id === asked) ?? missing(`milestone ${asked}`, milestones.map((p) => p.id))));
      // A propose that stopped before it wrote its gate wrote no decision rows either (stopped).
      const stopped = old && !gates.some((g) => g.id === old.gate);
      const state = old && milestoneState(gates.find((g) => g.id === old.gate), old, droppedBy(decisions));
      if (state === "proposed") refuse(`the breakdown gate ${old.gate} of ${old.id} is still open: the owner answers it first. To change the breakdown, the owner answers change, then propose it again.${nothing}`);
      if (state === "dropped") refuse(`the owner dropped ${old.id}${stopped ? "" : ` (gate ${old.gate})`}, and a dropped milestone does not come back. Propose a new milestone.${nothing}`);
      const name = opt.name ?? old?.name ?? need(undefined, "--name");
      const goal = opt.goal ?? old?.goal ?? need(undefined, "--goal");
      const pid = old?.id ?? nextId(dir, "M");
      const nameWhy = nameProblem(name), goalWhy = nameProblem(goal, 300);
      if (nameWhy) refuse(`the milestone's name ${nameWhy}.${nothing}`);
      if (goalWhy) refuse(`the milestone's goal ${goalWhy}.${nothing}`);
      if (/^m\d+$/.test(looks(name))) refuse(`the milestone's name looks like a milestone id (${visible(name)}), so a line could name the wrong milestone: give it a name of words, such as Codex support.${nothing}`);
      const twin = milestones.find((p) => p.id !== pid && looks(p.name) === looks(name));
      if (twin) refuse(`${twin.id} has that name already: give each milestone its own name.${nothing}`);
      const byId = byIds(tasks);
      const pilot = byId.get(opt.pilot ?? old?.pilot ?? need(undefined, "--pilot")) ?? missing(`task ${visible(opt.pilot ?? old.pilot)}`, tasks.map((t) => t.id));
      if (ENDED.includes(pilot.state)) refuse(`${pilot.id} is ${pilot.state}: an ended task is no pilot, as it runs nothing more. Name a task that has not ended with --pilot${old ? ` (sage milestone propose ${old.id} --pilot <T>)` : ""}.${nothing}`);
      // The other tasks: --tasks names each of them (none for no other task); without it, the milestone keeps its tasks. An
      // ended task of the milestone stays in it either way, so the count keeps it and the question lists it (R1219-1).
      const words = opt.tasks === undefined ? undefined : opt.tasks === "none" ? [] : waitWords(opt.tasks);
      const odd = words?.find((w) => !TASK_ID.test(w));
      if (odd !== undefined) refuse(`--tasks takes task ids such as T7, separated by commas or spaces, or none; not "${visible(odd)}".${nothing}`);
      const twice = words?.find((w, i) => words.indexOf(w) !== i);
      if (twice) refuse(`--tasks names ${twice} twice: give each task once.${nothing}`);
      if (words?.includes(pilot.id)) refuse(`${pilot.id} is the pilot: --tasks names the other tasks of the milestone.${nothing}`);
      const named = words && new Set(words.map((w) => byId.get(w) ?? missing(`task ${w}`, tasks.map((t) => t.id))));
      const others = tasks.filter((t) => t !== pilot && (named?.has(t) || (t.milestone === pid && (!named || ENDED.includes(t.state)))));
      for (const t of [pilot, ...others].filter((t) => t.milestone !== pid)) {
        if (ENDED.includes(t.state)) refuse(`${t.id} is ${t.state}: an ended task joins no milestone. Leave it out of --tasks.${nothing}`); // before the milestone check, as an ended task takes no milestone=none (R1248-1)
        if (t.milestone) refuse(`${t.id} is in ${t.milestone}, and a task is in one milestone: take it out first (sage task ${t.id} set milestone=none)${t === pilot ? ", or give another pilot" : ", or leave it out of --tasks"}.${nothing}`);
        notStarted(t, pid, runs);
      }
      const at = now();
      const round = gates.filter((g) => proposalOf(g, renamed) === pid).length + 1;
      // Each task that joins or leaves; the pilot's move is the proposal's own.
      const members = new Set([pilot.id, ...others.map((t) => t.id)]);
      const toOf = (t) => (members.has(t.id) ? pid : t.milestone === pid ? "" : (t.milestone ?? ""));
      const moved = tasks.map((t) => ({ t, to: toOf(t) })).filter(({ t, to }) => to !== (t.milestone ?? ""));
      // The question, one part on each line: the fixed text first, then each free text after a fixed label or a task id
      // (the owner, 2026-10-19). An ended task's state or its waits but the pilot come in brackets after the id, and a
      // colon ends the fixed part, so a title cannot pass for a tag (R1249-3): "  T3 [merged]: Fix it", "  T4: Add it".
      // A wait on an abandoned or lost task is never met, and says so as status does (R1259-1): "T3 [waits for T2 (abandoned, never met)]".
      const wait = (w, state = byId.get(w)?.state) => (dead(state) ? `${w} (${state ?? "not in the logbook"}, never met)` : w);
      const tag = (t, waits = waitsOf(t).ids.filter((w) => w !== pilot.id)) => (ENDED.includes(t.state) ? t.state : waits.length ? `waits for ${waits.map((w) => wait(w)).join(", ")}` : "");
      const item = (t) => `  ${t.id}${tag(t) ? ` [${tag(t)}]` : ""}: ${oneLine(t.title)}`;
      const question = [`Approve milestone ${pid}${round > 1 ? ` (round ${round})` : ""}? No task builds before you approve.`, `Name: ${oneLine(name)}`, `Goal: ${oneLine(goal)}`,
        "Pilot, runs first:", item(pilot), ...(others.length ? [`Then, each after ${pilot.id}:`, ...others.map(item)] : [])].join(LINE);
      const g = { id: nextId(dir, "G"), task: pilot.id, question, options: BREAKDOWN, recommendation: "approve", default: "", at };
      // A milestone proposed again keeps its other cells, such as its release: nothing moves it to another release by itself (T1003).
      const row = { ...old, id: pid, name, goal, pilot: pilot.id, gate: g.id, at: old?.at ?? at };
      const after = old ? milestones.map((p) => (p.id === pid ? row : p)) : [...milestones, row];
      // A row for each task but the pilot whose milestone changes (R1269-3): from its cell before this command. After a stopped
      // proposal, which changed cells but wrote no rows, from what the decision rows say: a task's last move row, or a
      // proposal row on it as the pilot (R1255-2, R1266-2).
      const logged = new Map();
      for (const d of decisions) {
        // A row from before the rename (T995) reads program and PG<n>: the map gives its milestone.
        const to = /^(?:milestone|program) \S+ → (\S+)$/.exec(d.decision)?.[1] ?? ([PROPOSE, "program propose"].includes(d.why) ? /^((?:M|PG)[1-9]\d*) proposed /.exec(d.decision)?.[1] : undefined);
        if (to) logged.set(d.task, to === "none" ? "" : (renamed.get(to) ?? to));
      }
      const rowsOfMoves = tasks.filter((t) => t !== pilot).map((t) => [t, stopped ? (logged.get(t.id) ?? "") : (t.milestone ?? ""), toOf(t)])
        .filter(([, from, to]) => from !== to && (from === pid || to === pid))
        .map(([t, from, to]) => ({ at, task: t.id, decision: `milestone ${from || "none"} → ${to || "none"}`, why: PROPOSE }));
      for (const { t, to } of moved) t.milestone = to;
      // A task that joins the milestone is in the milestone's release: its own release goes (T1003).
      const unreleased = tasks.filter((t) => t.milestone === pid && t.release).map((t) => ({ at, task: t.id, decision: `release ${t.release} → none`, why: `${t.id} joins ${pid}, and a task of a milestone is in its milestone's release` }));
      for (const t of tasks) if (t.milestone === pid && t.release) t.release = "";
      const graph = waitGraph(tasks, after, gates, decisions);
      noLoop(pilot, graph, { oldPilot: old?.pilot }); // each new wait is a wait for the pilot, so a new loop goes through it
      apartFromPilot(pilot, graph, decisions, read(dir, "ledger"), "propose");
      const decision = round > 1 ? `${pid} proposed again with gate ${g.id}, round ${round}` : `${pid} proposed with gate ${g.id}, pilot ${pilot.id}, tasks ${others.map((t) => t.id).join(",") || "none"}, name: ${oneLine(name)}`;
      // The milestone's row first: until the gate's row is written, the milestone is lost, so a stop between two writes leaves
      // no task of it free to build while its gate is open, also on a new proposal of an approved milestone (R1235-1).
      write(dir, "milestones", after);
      write(dir, "tasks", tasks);
      write(dir, "gates", [...gates, g]);
      write(dir, "decisions", [...decisions, ...rowsOfMoves, ...unreleased, { at, task: pilot.id, decision, why: PROPOSE }]);
      return `${pid} proposed${round > 1 ? ` (round ${round})` : ""} · pilot ${pilot.id} · ${others.length ? `tasks ${others.map((t) => t.id).join(", ")}` : "no other task"} · ${g.id} open: ask the owner to approve, change or drop it. To say what to change, the owner may answer in own words. Until the owner approves, no task of ${pid} builds.`;
    }
    case "release": {
      // release add (T1003): a release that the owner ships, such as 1.0, in the order of the rows. Its name is its key.
      if (sub !== "add" || id !== undefined) refuse(`release takes: add --name "<name>" [--goal "<goal>"]. A milestone goes into a release with sage milestone <M> set release=<name>, and a task outside a milestone with sage task <T> set release=<name>.`);
      const releases = read(dir, "releases"), name = need(opt.name, "--name"), goal = opt.goal ?? "";
      const why = nameProblem(name) ?? releaseNameProblem(name, releases);
      if (why) refuse(`the release's name ${why}. Nothing changed.`);
      const goalWhy = opt.goal === undefined ? null : nameProblem(goal, 300);
      if (goalWhy) refuse(`the release's goal ${goalWhy}. Nothing changed.`);
      write(dir, "releases", [...releases, { name, goal, at: now() }]);
      return `release ${name} added${goal ? ` · goal: ${goal}` : ""}. Put a milestone in it with sage milestone <M> set release=<name>, and a task outside a milestone with sage task <T> set release=<name>.`;
    }
    case "round": {
      const { tasks, task } = taskOf(dir, need(sub, "the task id"));
      // From repairing too: the next round of a fix key that a re-check did not confirm, by the same count, hold and replan (T600).
      // The chief's extra round (T804) also starts from a round hold. Only the chief gives one: a lead's round has no reason.
      const why = cell(opt.why), held = task.state === "held" && task.hold === "round";
      if (opt.why !== undefined && opt.lead !== undefined) refuse(`only the chief gives an extra repair round, so a lead runs round ${task.id} with no --why. Nothing changed.`);
      if (!["reviewing", "verifying", "repairing"].includes(task.state) && !(held && why)) refuse(`${task.id} is ${task.state}. A repair starts from reviewing, verifying or repairing${held ? `, or from this round hold with round ${task.id} --why "<reason>" while autopilot is on` : ""}.`);
      // A round of low findings only is the chief's choice (T804, owner 2026-11-07): it counts like any round.
      const fix = read(dir, "findings").filter((f) => f.task === task.id && f.status === "open" && f.triage === "fix");
      const keys = fix.map((f) => f.key).sort().join(",");
      if (!keys) refuse(`${task.id} has no open findings marked fix`);
      const round = Number(task.round) + 1;
      let limit = config(env, dir).max_rounds + extraOf(task), given; // the extra rounds of earlier holds by round (F-T284-14)
      if (round > limit) {
        // In autopilot the chief gives the next round itself, with a reason, up to ROUND_CEILING rounds in all; above that,
        // or with autopilot off, only the owner's gate gives it (T804, owner 2026-11-07).
        const granted = why && round <= ROUND_CEILING && autopilotOf(dir, opt.chief, env);
        if (!granted && held) refuse(`${task.id} stays held: ${round > ROUND_CEILING ? `round ${round} is past the ${ROUND_CEILING} rounds that the chief may give` : "autopilot is off for this chief's session"}, so only the owner's gate gives round ${round}. Nothing changed.`);
        if (!granted) {
          Object.assign(task, { state: "held", hold: "round" });
          write(dir, "tasks", tasks);
          return `${task.id} held: ${round - 1} repair rounds did not make it clean. Stop and ask the user.`;
        }
        Object.assign(task, { extra: String(extraOf(task) + 1), hold: "" });
        limit += 1;
        given = { at: now(), task: task.id, decision: `round ${round} given by ${opt.chief} on autopilot`, why };
      }
      const save = () => (write(dir, "tasks", tasks), given && write(dir, "decisions", [...read(dir, "decisions"), given]));
      // A round that fixed none of the last round's findings re-plans: also when new ones join them, and on the retry after
      // a hold, whose last round's findings are still open (F-T284-17, option a).
      const last = roundKeys(task);
      if (last.length && last.every((k) => keys.split(",").includes(k))) {
        task.state = "replan";
        save();
        return `${task.id} replan: round ${round - 1} did not fix ${task.keys}. Attack the premise, then brief again.`;
      }
      Object.assign(task, { state: "repairing", round, keys });
      save();
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
        const candidate = opt.candidate === undefined ? "" : candidateOf(opt.candidate);
        const run = { ...runFrame(dir, project, task, role, branch, candidate, env), ...chiefTag(opt), ...checkoutTag(dir, project, env) };
        // The fields of the agent call for the chosen model: Claude's model, or Codex's reasoning effort (T955). The row keeps only a model.
        const fields = spawnFields(run.model);
        run.model = fields.model ?? "";
        if (opt["usage-interface"] !== undefined) {
          const entry = USAGE_INTERFACES.get(opt["usage-interface"]);
          if (!entry) refuse("Unknown usage interface. Nothing changed.");
          Object.assign(run, usageSnapshot(entry));
        }
        write(dir, "runs", [...runs, run]);
        // A lead's brief carries the final reports of the tasks that its task waits for (the brief rule): the last lead
        // or investigate run of each, with its report's path when one is recorded.
        const upstream = role !== "lead" ? [] : waitsWithState(task, graphOf(dir)).filter((w) => w.id).map(({ id: up }) => {
          const last = runs.filter((r) => r.task === up && ["lead", "investigate"].includes(r.role)).at(-1);
          return `${up} ${last?.report ? `${last.id} ${resolve(dir, last.report)}` : "no report recorded"}`;
        });
        return `${run.id} running · ${role} on ${task.id}${branch ? ` · ${branch}` : ""}${candidate ? ` · candidate ${candidate}` : ""}${Object.entries(fields).map(([k, v]) => ` · ${k} ${v}`).join("")}${upstream.length ? ` · upstream reports: ${upstream.join(", ")}` : ""}`;
      }
      if (sub === "usage") return enrichUsage(dir, id, opt);
      if (sub === "done") {
        const run = runs.find((r) => r.id === id) ?? missing(`run ${id}`, runs.map((r) => r.id));
        const st = need(opt.status, "--status");
        if (!RUN_ENDS.includes(st)) refuse("status is done, blocked, question or failed");
        // Any --tokens is a whole number of at most 12 digits, so that a typo cannot make a total that a number cannot hold.
        if (opt.tokens !== undefined && !/^[1-9]\d{0,11}$/.test(opt.tokens)) refuse(`--tokens is a whole number from 1 to 12 digits, for example --tokens 52000; not ${JSON.stringify(opt.tokens)}. Nothing changed.`);
        const unavailable = opt.usage === "unavailable";
        if (opt.tokens !== undefined && run.usage_interface && (!usageText(opt["usage-source"]) || !usageText(opt["usage-evidence"]))) refuse("A declared interface needs its measured source and evidence. Nothing changed.");
        if (opt.usage !== undefined && !unavailable) refuse("--usage is unavailable. Nothing changed.");
        if (unavailable) {
          // A lead with no declared interface and a report, whose usage the host did not give (for example after a restart), ends unavailable too (T969).
          const declared = st === "done" && validUsageSnapshot(run) && run.usage_capability === "unavailable";
          const lead = run.role === "lead" && !run.usage_interface && st !== "failed";
          if (opt.tokens !== undefined || run.status !== "running" || !(declared || lead) || !usageText(opt["usage-source"]) || !usageText(opt["usage-evidence"])
            || !usageText(opt.report)) refuse("Unavailable usage needs a running run, its unsupported interface snapshot (or a lead run with a report), a report, source and evidence, without tokens. Nothing changed.");
        } else if (opt["usage-source"] !== undefined || opt["usage-evidence"] !== undefined) {
          if (!tokenCount(opt.tokens) || !usageText(opt["usage-source"]) || !usageText(opt["usage-evidence"])) refuse("Measured usage needs tokens, source and evidence. Nothing changed.");
        }
        // A run ends once (T346). A later run done of an ended run, with its own status, only adds the tokens or the report
        // path that the run lacks: the Codex native finish and a re-plan end a run with neither. It replaces nothing.
        if (run.status !== "running") {
          if ((run.usage_status === "unavailable" && opt.tokens !== undefined) || opt["usage-source"] !== undefined || opt["usage-evidence"] !== undefined) refuse("Use run usage to audit a later measured count. Nothing changed.");
          const flag = (col) => `--${col}`, lacks = ["tokens", "report"].filter((col) => !run[col]);
          const kept = ["tokens", "report"].find((col) => opt[col] !== undefined && run[col]);
          if (kept) refuse(`${run.id} already ended as ${run.status} with its ${kept}, and ${flag(kept)} never replaces it. Nothing changed.`);
          const adds = lacks.filter((col) => opt[col]);
          if (st !== run.status || !adds.length) refuse(`${run.id} already ended as ${run.status}: a run ends once. A later run done --status ${run.status} may only add ${lacks.length ? lacks.map(flag).join(" or ") + ", which it lacks" : "nothing, as it has its tokens and its report"}. Nothing changed.`);
          for (const c of adds) run[c] = opt[c];
          write(dir, "runs", runs);
          return `${run.id} ${st} · added ${adds.join(" and ")}`;
        }
        // The usage that the agent's stop kept (T954) stands for --tokens, and it wins over a declared unavailable.
        const kept = opt.tokens === undefined ? keptUsage(dir, run) : undefined;
        const counted = opt.tokens !== undefined || unavailable || kept;
        // A done review or QA run gives its tokens, so that sage stats counts every review's cost (T346).
        if (st === "done" && CHECKERS.includes(run.role) && !counted) refuse(`${run.id} is a ${run.role} run, so run done --status done needs --tokens with its tokens as a whole number, for example --tokens 52000. Nothing changed.`);
        // A lead with a report gives its tokens too (T954): its own count, from its usage. A declared interface counts at the stop.
        if (run.role === "lead" && st !== "failed" && !run.usage_interface && !counted) refuse(`${run.id} is a lead run, so run done --status ${st} needs --tokens with the lead's own tokens from its usage, as a whole number, for example --tokens 120000. When its usage gave no count, add --usage unavailable with --usage-source, --usage-evidence (the reason) and --report. Only --status failed, for a lead that gave no report, leaves them out. Nothing changed.`);
        if (kept) Object.assign(run, kept);
        else if (unavailable) Object.assign(run, { usage_status: "unavailable", usage_source: opt["usage-source"], usage_evidence: opt["usage-evidence"] });
        else if (opt.tokens !== undefined) Object.assign(run, { usage_status: "measured", usage_source: opt["usage-source"] ?? "", usage_evidence: opt["usage-evidence"] ?? "" });
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
        // The run whose report holds the finding (a run of the same task), and its problem class, checked when given (T346).
        if (opt.run !== undefined) {
          const run = read(dir, "runs").find((r) => r.id === opt.run) ?? missing(`run ${opt.run}`, read(dir, "runs").filter((r) => r.task === task.id).map((r) => r.id));
          if (run.task !== task.id) refuse(`--run ${run.id} is a run of ${run.task}, not of ${task.id}: give the run whose report holds the finding. Nothing changed.`);
        }
        if (opt.class !== undefined && !FINDING_CLASSES.includes(opt.class)) refuse(`--class is one of ${FINDING_CLASSES.join(", ")}; not ${JSON.stringify(opt.class)}. Nothing changed.`);
        const tags = { ...(opt.run !== undefined && { run: opt.run }), ...(opt.class !== undefined && { class: opt.class }) };
        const key = cell(opt.key) || nextId(dir, `F-${task.id}-`); // as the table holds it, so the same --key finds its finding again
        const again = findings.find((f) => f.task === task.id && f.key === key);
        // Without --summary, a known key keeps its summary. An empty one is refused, so no summary is ever lost.
        const summary = opt.summary === undefined ? again?.summary : cell(opt.summary) || refuse(`${key} on ${task.id}: --summary is empty. Give the finding in a few words${again ? ", or leave out --summary to keep its summary" : ""}.`);
        // A review or QA finding needs both, given or kept by its known key, so that sage stats counts each class and
        // cycle (T490). A finding from another source, such as the sage's own note, may leave them out.
        const source = opt.source ?? again?.source;
        const lacks = CHECKERS.includes(source) ? ["run", "class"].filter((c) => !(opt[c] ?? again?.[c])) : [];
        if (lacks.length) refuse(`${source} is a review or QA role, so finding add needs --run with the run whose report holds the finding and --class with one of ${FINDING_CLASSES.join(", ")}; it lacks ${lacks.map((c) => `--${c}`).join(" and ")}. Nothing changed.`);
        if (again && summary !== again.summary) write(dir, "decisions", [...read(dir, "decisions"), { at: now(), task: task.id, decision: `${key} opened again: ${summary}`, why: `the summary before: ${again.summary}` }]);
        if (again) Object.assign(again, { status: "open", triage: "", round: task.round, severity, source, summary, ...tags }); // it came back
        else findings.push({ task: task.id, key, round: task.round, source: need(opt.source, "--source"), severity, summary: need(summary, "--summary"), status: "open", ...tags });
        write(dir, "findings", findings);
        return `${key} open${again ? " again" : ""} · ${severity} · ${task.id}`;
      }
      const f = findings.find((x) => x.task === id && x.key === more[0]) ?? missing(`finding ${more[0]} on ${id}`, findings.filter((x) => x.task === id).map((x) => x.key));
      // While held, the sage may still triage ask, or dismiss with a reason (F-T284-1); a fix or a close waits.
      if (sub === "close" || (sub === "triage" && more[1] === "fix")) notHeld(taskOf(dir, id).task, sub === "close" ? "finding close" : "fix triage");
      if (sub === "triage") {
        const t = need(more[1], "fix, dismiss or ask");
        if (!["fix", "dismiss", "ask"].includes(t)) refuse("triage is fix, dismiss or ask");
        // A close is a fix, and a dismissal would hide it from the verdict that it must keep blocking (T294).
        if (t === "dismiss" && f.status === "closed") refuse(`${f.key} is closed: a closed finding is a fix, so it is not dismissed. A new head confirms it.`);
        // A low fix key of the round joins the next round while a medium or high finding of the task is open, in any
        // triage and any state, so it is not dismissed then (F-T301-59, F-T301-66).
        const big = t === "dismiss" && f.status === "open" && f.severity === "low" && roundKeys(taskOf(dir, id).task).includes(f.key)
          ? findings.filter((g) => g.task === id && g.status === "open" && g.severity !== "low").map((g) => g.key) : [];
        if (big.length) refuse(`${f.key} is a low fix of ${id}'s current round, and ${big.join(", ")} is open: ${f.key} joins the next round with it, so it is not dismissed now.`);
        // A proof check backs the triage (T947): the decision trail keeps its run, its outcome and the head.
        const proof = opt.proof === undefined ? undefined : proofOf(dir, f, t, opt.proof);
        const reason = proof && proof.outcome === "not reproduced" ? `not reproduced in ${opt.proof}${opt.reason ? `: ${opt.reason}` : ""}` : opt.reason;
        if (t === "dismiss") Object.assign(f, { reason: need(reason, "--reason for a dismissal"), status: "dismissed" });
        if (proof) write(dir, "decisions", [...read(dir, "decisions"), { at: now(), task: id, decision: `${f.key} ${t} --proof ${opt.proof}`, why: `${opt.proof} ${proof.outcome} on ${proof.sha}` }]);
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
        const to = frame(dir, title, size, [], [], { priority: "P2", ...chiefTag(opt) }); // a follow-up is P2 on the scale; the chief may set another
        const was = f.key, from = f.run || /^(R[1-9]\d*)-/.exec(was)?.[1];
        Object.assign(f, { task: to.id, key: nextId(dir, `F-${to.id}-`), round: 0, triage: "", run: "" }); // its run is a run of the old task
        write(dir, "findings", findings);
        // The decision keeps the run whose report held the finding, and its severity, for that run's clean verdict (T483).
        write(dir, "decisions", [...read(dir, "decisions"), { at: now(), task: id, decision: `${was} moved to ${to.id} as ${f.key}: ${f.summary}`, why: `the follow-up task${from ? ` (from ${from}, ${f.severity})` : ""}: ${title}` }]);
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
      if (adoptionOf(task) && CLEAN.includes(kind)) {
        const role = { "review-clean": "code-reviewer", "security-clean": "security-reviewer", "ux-clean": "ux-reviewer", "qa-pass": "qa", "evidence-clean": "evidence-review" }[kind];
        const matches = read(dir, "runs").filter(r => r.id === opt.run);
        const run = matches[0];
        if (matches.length !== 1 || run.task !== task.id || run.role !== role || run.status !== "done" || !run.ended
          || run.round !== task.round || (run.branch && run.branch !== task.branch)) refuse(`${task.id}'s adoption needs a fresh done ${role} run on its current branch and round for ${kind}. Nothing changed.`);
      }
      // The clean rule: a cycle is clean when no medium or high finding is open. An open low finding never blocks a
      // merge; it stays on the task's polish list (T671). So a problem verdict needs an open finding that is not low.
      const findings = read(dir, "findings").filter((f) => f.task === task.id && f.status === "open");
      // The refusal names the finding first: a chief that recorded the verdict before its finding must not hide the finding.
      if (FOUND.includes(kind) && findings.every((f) => f.severity === "low")) {
        const reviews = CLEAN.filter((k) => k !== "qa-pass"); // the clean verdicts of the blocks that give findings
        const fits = kind === "qa-fail" ? ["qa-pass"] : reviews.filter((k) => list(task.route).some((b) => VERDICT[b] === k));
        const clean = fits.length === 1 ? fits[0] : `this review's clean verdict (${(fits.length ? fits : reviews).join(", ")})`;
        refuse(`${task.id} has no open medium or high finding, so ${kind} is refused. If this review found a medium or high problem, record it first: sage finding add ${task.id} --source <role> --severity <medium or high> --summary "<the problem>", then ${kind} again. If it found only low ones, its cycle is clean: record ${clean}. An open low finding never blocks a merge; it stays on the task's polish list.`);
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
      const had = prsOf(task, read(dir, "decisions"), read(dir, "ledger"));
      const decided = opt.pr ? setPr(task, opt.pr, "verdict --pr") : [];
      if (opt.pr) apartFromPilot(task, graphOf(dir), read(dir, "decisions"), read(dir, "ledger"), "pr", had);
      // The boundary of a review or QA verdict (T483): only a report that a stop hook kept backs it, in any shell form.
      // Nothing is written before it.
      const unbacked = backingProblem(dir, task, kind, opt);
      if (unbacked) refuse(`${unbacked} Nothing changed.`);
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
        // Each option, the recommendation and the default are one line, as the question is: a line break is a space (R1258-1).
        const flatOptions = flat(need(opt.options, "--options"));
        const options = optionsOf({ options: flatOptions });
        const twin = options.find((o, i) => options.findIndex((x) => looks(x) === looks(o)) !== i);
        if (twin !== undefined) refuse(`two options look the same: ${JSON.stringify(twin)} and ${JSON.stringify(options.find((x) => looks(x) === looks(twin)))}. Make them differ in more than case.`);
        if (options.some((o) => /^other ?:/.test(looks(o)))) refuse(`an option may not start with "other:": it marks an answer in the owner's own words.`);
        const pick = (raw, what, v = flat(raw)) => options.find((o) => o === v) ?? options.find((o) => looks(o) === looks(v)) ?? (/^[1-9]\d*$/.test(v) ? options[Number(v) - 1] : undefined) ?? refuse(`${what} is one of the options, by its text or its number (1 to ${options.length}): ${options.map((o) => JSON.stringify(o)).join(", ")}.`);
        const recommendation = pick(need(opt.recommend, "--recommend"), "--recommend");
        // Only milestone propose writes the first line of a breakdown gate, which marks the gate as one (proposalOf).
        const question = flat(need(opt.question, "--question")); // one line, as a title: only a breakdown gate's question has lines (R1249-1)
        if (readsAsBreakdown(question)) refuse(`a question that starts with "Approve milestone" or "Approve program" is a breakdown gate, and only milestone propose opens one. Ask it in other words.`);
        if (looks(question).startsWith("move · plan")) refuse(`a question that starts with "move · plan" is a move gate, and only sage move --plan opens one. Ask it in other words.`);
        const g = { id: nextId(dir, "G"), task: id ?? "", question: need(question, "--question"), options: flatOptions, recommendation, default: opt.default === undefined ? "" : pick(opt.default, "--default"), at: now() };
        write(dir, "gates", [...gates, g]);
        return `${g.id} open · ${g.question}`;
      }
      if (sub === "replace") {
        const { task } = taskOf(dir, need(id, "the task id")), to = chiefNamed(dir, opt.to);
        if (task.chief === to) refuse(`${task.id} already belongs to ${to}. Nothing changed.`);
        return takeoverGate(dir, task, to);
      }
      if (sub === "answer") {
        const g = gates.find((x) => x.id === id) ?? missing(`gate ${id}`, gates.map((x) => x.id));
        if (g.answer && g.kind === "replace") refuse(`${g.id} is a takeover gate, and the owner answered it already (${visible(g.answer)}): a takeover gate answers once. Open a new one. Nothing changed.`);
        // A breakdown gate answers once, current or replaced by a newer round, so no second answer undoes a drop or an
        // approval (R1208-1, R1224-1): a change of mind goes through a new proposal and its own gate. Its own question
        // marks it, so this holds after a stop between writes and after a lost table (R1240-2); a plain gate with the
        // same options takes a new answer, as other gates do (R1212-2).
        // A move gate answers once too: its answer covers one plan, and a new answer needs a new preview (the design's "kept").
        if (g.answer && moveOf(g)) refuse(`${g.id} is a move gate, and the owner answered it already (${visible(g.answer)}): a move gate answers once. To move later, run the preview again: sage move --preview. Nothing changed.`);
        if (g.answer && breakdownLine(g)) refuse(`${g.id} is a breakdown gate, and the owner answered it already (${visible(g.answer)}): a breakdown gate answers once. For a change of mind, the sage proposes the milestone again (sage milestone propose <M>) and the owner answers the new gate. A dropped milestone does not come back: propose a new one. Nothing changed.`);
        // By number only, as the board numbers the options: no agent-written text goes into the command. The owner's own
        // words come as the hex of their UTF-8 bytes, so no text of theirs is in the command either, and are kept with
        // "other: " before them, so they never pass for one of the options.
        const options = optionsOf(g);
        const how = `gate answer ${g.id} takes --option <n>, the number of one of its options (1 to ${options.length}), or --other-hex <hex>, the owner's own words as the hex of their UTF-8 bytes (0-9 and a-f). Nothing changed.`;
        const own = opt["other-hex"];
        if (more.length || (opt.option === undefined) === (own === undefined) || (own !== undefined && unhex(own) === undefined)) refuse(how);
        if (own !== undefined) g.answer = `other: ${need(cell(unhex(own)), "the owner's own words: --other-hex gives only spaces")}`;
        else g.answer = (/^[1-9]\d*$/.test(opt.option) && options[Number(opt.option) - 1]) || refuse(how);
        if (g.kind === "replace" && g.answer === options[0]) return replaceChief(dir, g, g.answer, project, env);
        const ended = g.kind === "replace" && g.answer === options[1] && declineOffer(dir, g, g.answer);
        if (ended) return ended;
        write(dir, "gates", gates);
        write(dir, "decisions", [...read(dir, "decisions"), { at: now(), task: g.task, decision: `${g.question} → ${g.answer}`, why: own === undefined ? "the user's answer" : "the user's own words" }]);
        // Any answer but the first option replaces nobody, and a takeover gate answers once: the line says so, so no chief reports a replacement.
        const kept = g.kind === "replace" && read(dir, "tasks").find((t) => t.id === g.task);
        if (kept) return `${g.id} answered · ${g.answer} · nothing replaced: ${kept.id} keeps ${kept.chief ? `its chief ${kept.chief}` : "no owning chief"}, and no run ended. ${g.id} is spent: to change the chief, open a new takeover gate.`;
        return `${g.id} answered · ${g.answer}`;
      }
      refuse("gate add, gate replace or gate answer");
    }
    case "log": {
      write(dir, "decisions", [...read(dir, "decisions"), { at: now(), task: sub === "-" ? "" : sub, decision: need(id, "the decision"), why: need(opt.why, "--why") }]);
      return "logged";
    }
    case "status":
      return status(dir);
    case "stats":
      if (pos.length) refuse("stats takes no words: sage stats [--task <T>]");
      return stats(dir, opt.task === undefined ? undefined : taskOf(dir, opt.task).task.id);
    case "worktrees": {
      // worktrees lists the worktrees of the project's repository; worktrees prune --yes removes the clean ones that may go (worktrees.mjs).
      const prune = sub === "prune";
      if (pos.length > (prune ? 1 : 0)) refuse("worktrees takes no words, or prune --yes: sage worktrees, then sage worktrees prune --yes.");
      if (prune && opt.yes !== true) refuse("worktrees prune removes worktrees, so it needs --yes: run sage worktrees first, show its list, then run sage worktrees prune --yes. Nothing changed.");
      assertNoPendingWrite(dir);
      const root = projectRoot(project);
      try { git(["-C", root, "rev-parse", "--git-dir"], env); } catch { refuse(`${visible(root)} is not a git repository, so it has no worktrees. Nothing changed.`); }
      return worktrees({ git: (args) => git(args, env), root, tasks: read(dir, "tasks"), runs: read(dir, "runs"), ledger: read(dir, "ledger"), here: [folderHere(), project], prune });
    }
    case "pages": {
      // pages <T> makes the task's pages folder (mode 700) and prints it. pages <T> record <file> logs a page in it, with its sha256.
      const taskId = taskOf(dir, need(sub, "the task id")).task.id, folder = pagesDir(project, taskId, env);
      mkdirSync(folder, { recursive: true, mode: 0o700 });
      const saves = opt.run !== undefined || opt.text !== undefined;
      if (id === undefined && !saves) return folder;
      if (id !== "record" || more.length !== (saves ? 0 : 1)) refuse(`pages takes <task>, <task> record <file>, or <task> record --run <R> --text <report>`);
      // pages <T> record --run <R> --text <report> saves a run's report as <R>-report.md in the folder, then records it as a page.
      // The tool builds the path, so a caller that cannot write the folder (a Codex chief in its sandbox) saves the report (T506).
      if (saves) {
        const run = read(dir, "runs").find((r) => r.id === opt.run);
        if (!run || run.task !== taskId) refuse(`--run is a run of ${taskId}, for example R7; not ${JSON.stringify(opt.run ?? "")}. Nothing changed.`);
        if (!opt.text?.trim()) refuse("--text is the run's whole report, and it is empty. Nothing changed.");
        if (Buffer.byteLength(opt.text) > PAGE_MAX) refuse("--text is the run's whole report, at most 16 MiB. Nothing changed.");
        const path = join(folder, `${run.id}-report.md`);
        try {
          writeFileSync(path, opt.text, { flag: "wx", mode: 0o600 });
        } catch (e) {
          if (e.code !== "EEXIST") throw e;
          // A report is saved once: an exact retry gives the same page, and another text never replaces it.
          if (readRegular(path, { link: false, max: PAGE_MAX, encoding: "utf8" }) !== opt.text) refuse(`${path} already holds another report of ${run.id}, and a report is saved once. Nothing changed.`);
        }
        more[0] = path;
      }
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
/** The standing orders as a person wrote them, for agents to read: tabs stay, a CRLF or CR line end prints as a plain one, and no hidden character stays. */
const orders = (text) => text.replace(/\r\n?/g, "\n").replace(HIDDEN, "");

/**
 * One command as the CLI runs it: the text that it prints, or its refusal (code 1) or error (code 2) after "sage: ".
 * A provider that runs it for a caller gives actor: { project, native, leadTask }, the input of actorOptions.
 */
function command(argv, env = process.env, actor) {
  try {
    return { code: 0, text: (argv[0] === "standing" ? orders : shown)(sage(actor ? [...argv, ...actorOptions(actor.project, argv, actor, env)] : argv, env)) };
  } catch (err) {
    const said = err instanceof Refusal || err instanceof RecordedWriteError; // its text is for a person
    return { code: said ? 1 : 2, text: `sage: ${shown(said ? err.message : err.stack)}` };
  }
}

function runCli(argv = process.argv.slice(2)) {
  const { code, text } = command(argv);
  if (code) {
    console.error(text);
    process.exit(code);
  }
  console.log(text);
}

const { bindings, fillCommits, folderOf, link, locate, movePlans, notePlugin, pluginRows, projectMoves, refuseNewLogbook, repositoryLogbooks, rootOf, sameDir, waitingPlugins, writeBindings, writePlugin } = createSharedRoot({ Refusal, refuse, legacyRoots: rootsOf, makeLogbook, now, projectRoot, provider, raiseCounts, readRegular, rowsOf, sageRoot, sheetText, slug, swap, visible, withLock,
  listed: (root) => known(root, undefined, undefined, true),
  enroll });
const { chiefs, chiefRow, rowOf } = createChiefs({ now, provider, readRegular, refuse, rowsOf, sheetText, swap });
return { SIZES, BLOCKS, RISKS, KINDS, STATES, DEFAULTS, PR, LEAD_COMMANDS, leadProblem, leadRequest, sageRoot, locate, chiefFor, sessionBar, branchBar, actorOptions, git, projectRoot, roleReadProject, optionsOf, slug, worktreeRoot, pagesRoot, BRANCH, ofTask, branchOfTask, branchTip, projectName, storeDir, config, cyclesFor, modelFor, read, mergeCheck, boardLandingCheck, logbookView, sage, keepReport, keepUsage, compareRetainedReport, withLock, command, runCli, waitingPlugins, writeIdFloors };
}
