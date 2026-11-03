// The chiefs of a shared logbook and the one guard (T604): each writer class and each command of the design's table.
// Each shared case runs twice: a Claude chief against a Codex chief, then the other way, so both providers give one result.
import "./test-env.mjs";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { shellCommands } from "../plugins/sage/core/command-reader.mjs";
import * as claude from "../plugins/sage/skills/sage/sage.mjs";
import { tool as codex } from "../plugins/sage-codex/skills/sage/sage.mjs";
import { backed } from "./verdict-backing.mjs";

const at = (path) => fileURLToPath(new URL(path, import.meta.url));
const LAUNCHER = [at("../plugins/sage/hooks/launcher.mjs"), "sage-hook.mjs"], TOOL = at("../plugins/sage/skills/sage/sage.mjs"), PR_TOOL = at("../plugins/sage/skills/sage/sage-pr.mjs"), CODEX_TOOL = at("../plugins/sage-codex/skills/sage/sage.mjs");
const SHA = "a".repeat(40);
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
const ADD = ["--size", "small", "--priority", "P2"];
const QA = ["--source", "qa", "--severity", "medium", "--summary", "a problem", "--run", "R1", "--class", "other"];
const NO_CHIEF = /a command with no chief only reads: add --chief/;

function scratch(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "sage-chiefs-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const env = { ...process.env, HOME: join(base, "home"), CLAUDE_CONFIG_DIR: join(base, "claude"), CODEX_HOME: join(base, "codex"), SAGE_SHARED_HOME: join(base, "shared"), SAGE_WORKTREES: join(base, "worktrees"), SAGE_TEST_PIDS: "{}" };
  delete env.SAGE_HOME;
  const project = join(base, "project");
  mkdirSync(project);
  execFileSync("git", ["init", "-q", "-b", "main", project]);
  execFileSync("git", ["-C", project, "commit", "-q", "--allow-empty", "-m", "first"], { env: gitEnv });
  return { base, env, project };
}
/** A linked project with a chief of each provider: own is C1, other is C2. */
function world(t, own, other) {
  const w = scratch(t);
  own.sage(["link", "--separate", "--project", w.project], w.env);
  const dir = own.storeDir(w.project, w.env);
  const chief = own.chiefFor(w.project, "session-a", w.env), rival = other.chiefFor(w.project, "session-b", w.env);
  const owner = (...args) => own.sage([...args, "--project", w.project, "--chief", chief], w.env);
  const intruder = (...args) => other.sage([...args, "--project", w.project, "--chief", rival], w.env);
  const nobody = (...args) => own.sage([...args, "--project", w.project], w.env);
  const lead = (run, ...args) => own.sage([...args, "--project", w.project, "--lead", run], w.env);
  const cells = (table) => readFileSync(join(dir, `${table}.tsv`), "utf8");
  const tables = () => ["tasks", "runs", "findings", "gates", "ledger", "programs", "decisions"].map(cells).join("\f");
  return { ...w, dir, chief, rival, owner, intruder, nobody, lead, cells, tables };
}
/** The cell of a column in a table's row. */
function row(text, id) {
  const [head, ...lines] = text.trim().split("\n"), cols = head.split("\t");
  return Object.fromEntries(cols.map((c, k) => [c, lines.map((l) => l.split("\t")).find((l) => l[0] === id)?.[k]]));
}
const pairs = [["Claude", claude, codex], ["Codex", codex, claude]];
/** The whole question of a replace gate of T1 from C1 to C2. */
const asked = (from, to, title, runs) => `Replace chief C1 (${from}) of T1 with C2 (${to})? Runs that end as failed: ${runs}. Replace: C2 owns T1, each of those runs ends as failed and work that it did not report may be lost, C1 can no longer write T1, and an open offer is cleared. Then C2 goes on with T1. Keep: nothing changes, and C1 stays the owning chief. Title of T1: ${title}`;
/** A command as the owner runs it in a terminal: a process of its own, with no hook and no chief id. */
const owned = (w, name, ...args) => spawnSync(process.execPath, [name === "Claude" ? TOOL : CODEX_TOOL, ...args], { cwd: w.base, env: w.env, encoding: "utf8", timeout: 60_000 });
/** The words of the line that a refusal prints, with the owner's project in place of its placeholder. */
const printed = (text, project) => text.match(/run: sage (logbook repair .*? --project) <the project>\./)[1].split(" ").concat(project);

test("F-T604-23: the printed repair line on a legacy project adds no chiefs.tsv and no chief column", (t) => {
  const w = scratch(t);
  const run = (...args) => claude.sage([...args, "--project", w.project], w.env);
  run("init");
  run("task", "add", "--title", "a", ...ADD);
  const dir = claude.storeDir(w.project, w.env), head = readFileSync(join(dir, "tasks.tsv"), "utf8").split("\n")[0];
  writeFileSync(join(dir, "tasks.tsv"), "");
  assert.throws(() => run("status"), /--accept-loss tasks/);
  const line = printed(owned(w, "Claude", "task", "add", "--title", "b", ...ADD, "--project", w.project).stderr, w.project);
  assert.equal(owned(w, "Claude", ...line).status, 0);
  run("task", "add", "--title", "c", ...ADD);
  assert.equal(readFileSync(join(dir, "tasks.tsv"), "utf8").split("\n")[0], head);
  assert.equal(existsSync(join(dir, "chiefs.tsv")), false);
});

test("a legacy project has no chief: no chiefs.tsv, no chief column, the same task version, and no option or claim", (t) => {
  const w = scratch(t);
  const run = (...args) => codex.sage([...args, "--project", w.project], w.env);
  run("init");
  run("task", "add", "--title", "a", ...ADD);
  run("run", "add", "T1", "--role", "qa");
  const dir = codex.storeDir(w.project, w.env), [head, line] = readFileSync(join(dir, "tasks.tsv"), "utf8").split("\n");
  assert.equal(head, "id\ttitle\tsize\trisk\troute\tstate\tbranch\tpr\tround\tkeys\thold\textra\tpriority\tkind\twaits\tprogram\tadoption\tapprovals");
  assert.equal(readFileSync(join(dir, "runs.tsv"), "utf8").split("\n")[0].endsWith("\tusage_evidence"), true);
  assert.equal(existsSync(join(dir, "chiefs.tsv")), false);
  assert.equal(codex.chiefFor(w.project, "session-a", w.env), undefined);
  assert.deepEqual(codex.actorOptions(w.project, ["task", "add"], { native: "session-a" }, w.env), []);
  // The version is the hash of the row of today's columns, so a legacy task's version does not change.
  const cells = line.split("\t"), legacy = Object.fromEntries(head.split("\t").map((column, k) => [column, cells[k] ?? ""]));
  assert.equal(codex.readTaskSnapshot({ project: w.project, task: "T1" }, w.env).version, createHash("sha256").update(JSON.stringify(legacy)).digest("hex"));
  for (const args of [["status", "--chief", "C1"], ["task", "T1", "set", "title=b", "--chief", "C1"], ["status", "--lead", "R1"], ["claim", "T1", "--version", "0".repeat(64)]]) {
    assert.throws(() => run(...args), /only a shared logbook has chiefs/);
  }
});

test("F-T604-8: a legacy project refuses --chief and --lead also on the commands that return before they open a logbook, and makes no row", (t) => {
  const w = scratch(t);
  const run = (...args) => claude.sage([...args, "--project", w.project], w.env);
  run("init");
  for (const args of [["config", "--chief", "C1"], ["config", "max_rounds=4", "--lead", "R1"], ["link", "--separate", "--chief", "C1"], ["projects", "rebuild", "--accept-listing", "yes", "--lead", "R1"],
    ["board", "--chief", "C1"], ["board", "--remember", "no", "--lead", "R1"], ["merge-check", "--sha", SHA, "--chief", "C1"]]) {
    assert.throws(() => run(...args), /only a shared logbook has chiefs: leave out --chief and --lead/, args.join(" "));
  }
  assert.equal(claude.locate(w.project, w.env).shared, false, "the refused link made no row");
  assert.match(run("config"), /max_rounds=3/, "the refused config changed nothing");
});

test("a legacy project has no transfer: each command refuses, and a replace gate never opens", (t) => {
  const w = scratch(t);
  const run = (...args) => claude.sage([...args, "--project", w.project], w.env);
  run("init");
  run("task", "add", "--title", "a", ...ADD);
  const dir = claude.storeDir(w.project, w.env), before = ["tasks", "gates"].map((table) => readFileSync(join(dir, `${table}.tsv`), "utf8")).join("\f");
  for (const args of [["offer", "T1", "--to", "C2"], ["cancel", "T1", "--offer", "x"], ["accept", "T1", "--offer", "x", "--version", "0".repeat(64)], ["release", "T1"], ["gate", "replace", "T1", "--to", "C2"]]) {
    assert.throws(() => run(...args), /has no shared logbook, so it has no chiefs to hand a task to\. Nothing changed\.$/, args.join(" "));
  }
  assert.throws(() => run("claim", "T1", "--version", "0".repeat(64)), /only a shared logbook has chiefs: leave out --chief and --lead, and a task here needs no claim/);
  assert.equal(["tasks", "gates"].map((table) => readFileSync(join(dir, `${table}.tsv`), "utf8")).join("\f"), before);
  assert.equal(before.split("\f")[1].split("\n")[0], "id\ttask\tquestion\toptions\trecommendation\tdefault\tanswer\tat", "a legacy gates table has no kind column");
});

test("a legacy run that ended keeps no late report, as before", (t) => {
  const w = scratch(t);
  const run = (...args) => claude.sage([...args, "--project", w.project], w.env);
  run("init");
  run("task", "add", "--title", "a", ...ADD);
  run("run", "add", "T1", "--role", "qa");
  run("run", "done", "R1", "--status", "failed");
  assert.throws(() => claude.keepReport(w.project, { task: "T1", run: "R1", role: "qa", text: "late" }, w.env), /R1 ended as failed before this stop, so no report is kept/);
});

for (const [name, own, other] of pairs) {
  test(`${name}: a session is one chief: chiefs.tsv holds its row once, and a second write of the session is the same chief`, (t) => {
    const w = world(t, own, other);
    assert.equal(w.chief, "C1");
    assert.equal(w.rival, "C2");
    assert.equal(own.chiefFor(w.project, "session-a", w.env), "C1", "a resume keeps its session id, so it is the same chief");
    const lines = readFileSync(join(w.dir, "chiefs.tsv"), "utf8").trim().split("\n");
    assert.equal(lines[0], "id\tprovider\tnative\tat");
    assert.deepEqual(lines.slice(1).map((l) => l.split("\t").slice(0, 3)), [["C1", name.toLowerCase(), "session-a"], ["C2", name === "Claude" ? "codex" : "claude", "session-b"]]);
    assert.throws(() => own.chiefFor(w.project, "bad id\twith a tab", w.env), /no session identity/);
    writeFileSync(join(w.dir, "chiefs.tsv"), "id\tother\n");
    assert.throws(() => w.owner("task", "add", "--title", "a", ...ADD), /chiefs\.tsv is damaged/);
  });

  test(`${name}: task add claims the task for the chief that adds it, and a run names the chief that dispatched it`, (t) => {
    const w = world(t, own, other);
    assert.match(w.owner("task", "add", "--title", "a", ...ADD), /^T1 framed .* · chief C1$/);
    assert.equal(row(w.cells("tasks"), "T1").chief, "C1");
    assert.match(w.owner("run", "add", "T1", "--role", "qa"), /^R1 running/);
    assert.equal(row(w.cells("runs"), "R1").chief, "C1");
    assert.match(w.owner("task", "T1"), /· chief C1/);
    w.intruder("task", "add", "--title", "b", ...ADD);
    assert.equal(row(w.cells("tasks"), "T2").chief, "C2");
  });

  test(`${name}: each task write refuses another chief, names the owning chief, and changes nothing; the owning chief passes the guard`, (t) => {
    const w = world(t, own, other);
    w.owner("task", "add", "--title", "a", ...ADD);
    w.owner("run", "add", "T1", "--role", "qa");
    w.owner("finding", "add", "T1", ...QA);
    const adopt = ["--source-logbook", "/nowhere", "--source-provider", "codex", "--source-task", "T9", "--pr", "1", "--branch", "sage/t9"];
    const writes = [["task", "T1", "set", "title=x"], ["round", "T1"], ["run", "add", "T1", "--role", "code-reviewer"], ["run", "done", "R1", "--status", "failed"],
      ["finding", "add", "T1", "--source", "sage", "--severity", "low", "--summary", "s"], ["finding", "triage", "T1", "F-T1-1", "fix"], ["finding", "close", "T1", "F-T1-1"],
      ["finding", "move", "T1", "F-T1-1", "--to", "later"], ["verdict", "T1", "--sha", SHA, "--kind", "checks-pass"], ["task-adopt", "T1", ...adopt],
      ["gate", "add", "T1", "--question", "q?", "--options", "a|b", "--recommend", "a"], ["log", "T1", "a decision", "--why", "w"], ["program", "propose", "--name", "n", "--goal", "g", "--pilot", "T1", "--tasks", "none"]];
    const provider = name === "Claude" ? "claude" : "codex";
    for (const args of writes) {
      const before = w.tables();
      assert.throws(() => w.intruder(...args), { message: `T1 belongs to chief C1 (${provider}), not to C2. Nothing changed. Change only your own tasks. If C1 stopped, open a replace gate for the owner to answer: ${name === "Claude" ? "call the gate_replace tool with this task and to C2" : "run sage gate replace T1 --to C2 --chief C2"}.` }, args.join(" "));
      assert.throws(() => w.nobody(...args), NO_CHIEF, args.join(" "));
      assert.equal(w.tables(), before, args.join(" "));
    }
    for (const args of writes) {
      try { w.owner(...args); } catch (e) { assert.doesNotMatch(e.message, /belongs to|no chief/, args.join(" ")); }
    }
  });

  test(`${name}: a program proposed again checks each task of the program, also with no --pilot and no --tasks`, (t) => {
    const w = world(t, own, other);
    w.owner("task", "add", "--title", "a", ...ADD);
    w.intruder("task", "add", "--title", "b", ...ADD);
    assert.throws(() => w.owner("program", "propose", "--name", "n", "--goal", "g", "--pilot", "T1", "--tasks", "T2"), /T2 belongs to chief C2/);
    w.owner("program", "propose", "--name", "n", "--goal", "g", "--pilot", "T1", "--tasks", "none");
    assert.throws(() => w.intruder("program", "propose", "PG1"), /T1 belongs to chief C1/);
  });

  test(`${name}: any chief of the project runs the commands that change no task; a command with no chief refuses`, (t) => {
    const w = world(t, own, other);
    w.owner("task", "add", "--title", "a", ...ADD);
    w.owner("run", "add", "T1", "--role", "qa");
    const page = join(own.sage(["pages", "T1", "--project", w.project], w.env), "page.md");
    writeFileSync(page, "a page");
    w.owner("run", "done", "R1", "--status", "failed");
    const some = [["standing", "add", "an order"], ["log", "-", "a decision", "--why", "w"], ["gate", "add", "--question", "q?", "--options", "a|b", "--recommend", "a"], ["config", "max_rounds=4"], ["config", "name=Shown"],
      ["init"], ["pages", "T1", "record", page], ["observe", "T1", "--kind", "completion"], ["run", "usage", "R1", "--tokens", "5", "--usage-source", "s", "--usage-evidence", "e"]];
    assert.throws(() => w.nobody("standing", "add", "an order"), { message: "this logbook is shared, and a command with no chief only reads: add --chief <your C id> to standing add. Nothing changed. Only a chief's session writes here. In a Claude session, run this write again as one command of its own, and the hook names your id. A Codex chief writes through the sage tools, which add its id. A terminal with no chief session only reads." }, "F-T604-28: no hook is promised where none runs");
    for (const args of some) {
      assert.throws(() => w.nobody(...args), NO_CHIEF, args.join(" "));
      try { w.intruder(...args); } catch (e) { assert.doesNotMatch(e.message, /belongs to|no chief/, args.join(" ")); }
    }
    assert.match(w.cells("decisions"), /page .*page\.md sha256/, "another chief records a page on this task");
  });

  test(`${name}: a read needs no chief, and a gate answer is the owner's, from either provider`, (t) => {
    const w = world(t, own, other);
    w.owner("task", "add", "--title", "a", ...ADD);
    w.owner("gate", "add", "T1", "--question", "q?", "--options", "a|b", "--recommend", "a");
    for (const args of [["status"], ["stats"], ["task", "T1"], ["logbook"], ["standing"], ["pages", "T1"], ["config"], ["merge-check", "--sha", SHA, "--pr", "1"], ["board", "--remember", "no"]]) {
      try { w.nobody(...args); } catch (e) { assert.doesNotMatch(e.message, /no chief|belongs to/, args.join(" ")); }
    }
    assert.match(other.sage(["gate", "answer", "G1", "--option", "1", "--project", w.project], w.env), /^G1 answered/);
    assert.deepEqual(own.actorOptions(w.project, ["gate", "answer", "G1"], { native: "session-a" }, w.env), [], "no chief goes on a gate answer");
    assert.deepEqual(own.actorOptions(w.project, ["status"], { native: "session-new" }, w.env), [], "a read makes no chief");
    assert.equal(readFileSync(join(w.dir, "chiefs.tsv"), "utf8").includes("session-new"), false);
  });

  test(`F-T604-23 ${name}: the line that the integrity refusal prints works in the owner's terminal on a shared logbook`, (t) => {
    const w = world(t, own, other), people = readFileSync(join(w.dir, "chiefs.tsv"), "utf8");
    w.owner("task", "add", "--title", "a", ...ADD);
    writeFileSync(join(w.dir, "tasks.tsv"), "");
    const out = owned(w, name, "task", "add", "--title", "b", ...ADD, "--project", w.project, "--chief", w.chief);
    assert.notEqual(out.status, 0);
    const line = printed(out.stderr, w.project);
    assert.deepEqual(line, ["logbook", "repair", "--accept-loss", "tasks", "--project", w.project]);
    const repair = owned(w, name, ...line);
    assert.equal(repair.status, 0, repair.stderr);
    assert.match(repair.stdout, /^tasks\.tsv started again without rows; its old file is \S+tasks\.tsv\.lost-1\./);
    assert.match(w.cells("decisions"), /the user accepts the loss of its rows/);
    assert.equal(readFileSync(join(w.dir, "chiefs.tsv"), "utf8"), people, "the repair names no chief, so it adds none");
    assert.match(w.owner("task", "add", "--title", "c", ...ADD), /^T1 framed .* · chief C1$/);
  });

  test(`F-T617-1 ${name}: the projects rebuild line that a refusal prints works in the owner's terminal on a shared logbook`, (t) => {
    const w = world(t, own, other), people = readFileSync(join(w.dir, "chiefs.tsv"), "utf8"), list = join(dirname(w.dir), "projects.tsv");
    w.owner("task", "add", "--title", "a", ...ADD);
    writeFileSync(list, "damaged\n");
    const refused = owned(w, name, "merge-check", "--sha", SHA, "--project", w.project);
    assert.notEqual(refused.status, 0);
    const line = refused.stderr.match(/to run sage (projects rebuild --accept-listing yes),/)[1].split(" ");
    const out = owned(w, name, ...line, "--project", w.project);
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /the known project list, now names the 1 logbook folder/);
    assert.equal(readFileSync(join(w.dir, "chiefs.tsv"), "utf8"), people, "the rebuild names no chief, so it adds none");
    assert.deepEqual(own.actorOptions(w.project, ["projects", "rebuild"], { native: "session-a" }, w.env), [], "no chief goes on it from a provider either");
  });

  test(`${name}: a lead acts for the chief of its lead run, on the task of that run only, while that run runs`, (t) => {
    const w = world(t, own, other);
    w.owner("task", "add", "--title", "a", ...ADD);
    w.owner("task", "add", "--title", "b", ...ADD);
    w.intruder("task", "add", "--title", "c", ...ADD);
    w.owner("task", "T1", "set", "state=briefed");
    w.owner("run", "add", "T1", "--role", "lead"); // R1
    w.owner("run", "add", "T2", "--role", "qa"); // R2
    assert.match(w.lead("R1", "task", "T1", "set", "state=building"), /^T1 building/);
    assert.match(w.lead("R1", "run", "add", "T1", "--role", "qa"), /^R3 running/);
    assert.equal(row(w.cells("runs"), "R3").chief, "C1", "the lead's run names its chief");
    const acts = /is not a write on T1, and a lead acts only on the task of its lead run/;
    assert.throws(() => w.lead("R1", "task", "T2", "set", "title=x"), acts);
    assert.throws(() => w.lead("R1", "task", "T3", "set", "title=x"), acts);
    assert.throws(() => w.lead("R1", "run", "done", "R2", "--status", "failed"), acts);
    assert.throws(() => w.lead("R1", "task", "add", "--title", "d", ...ADD), acts);
    assert.throws(() => w.lead("R1", "standing", "add", "an order"), acts);
    assert.throws(() => w.lead("R2", "task", "T2", "set", "title=x"), /R2 is not a running lead run/, "another role is no lead");
    assert.throws(() => own.sage(["task", "T1", "set", "title=x", "--project", w.project, "--lead", "R1", "--chief", "C1"], w.env), /takes --chief or --lead, not both/);
    const tasks = w.cells("tasks");
    writeFileSync(join(w.dir, "tasks.tsv"), tasks.replace(/^(T1\t.*)\tC1$/m, "$1\tC2")); // as a task that moved under a running lead
    assert.throws(() => w.lead("R1", "task", "T1", "set", "title=x"), { message: `T1 belongs to chief C2 (${name === "Claude" ? "codex" : "claude"}), not to C1. Nothing changed. Report this to your chief: a lead writes only while its chief owns the task.` }, "F-T604-27: a lead opens no gate");
    writeFileSync(join(w.dir, "tasks.tsv"), tasks.replace(/^(T1\t.*)\tC1$/m, "$1\t"));
    assert.throws(() => w.lead("R1", "task", "T1", "set", "title=x"), { message: "T1 has no owning chief, so C1 cannot change it. Nothing changed. Report this to your chief: a lead writes only while its chief owns the task." }, "F-T604-27: a lead claims nothing");
    writeFileSync(join(w.dir, "tasks.tsv"), tasks);
    w.owner("run", "done", "R1", "--status", "failed");
    assert.throws(() => w.lead("R1", "task", "T1", "set", "title=x"), /R1 is not a running lead run, so this lead writes nothing/, "a lead whose run ended writes nothing");
  });

  test(`${name}: a task with no owning chief takes a claim at its current version, once; a write before it names the claim`, (t) => {
    const w = world(t, own, other);
    w.owner("task", "add", "--title", "a", ...ADD);
    writeFileSync(join(w.dir, "tasks.tsv"), w.cells("tasks").replace(/\tC1\n/, "\t\n")); // as a moved task starts
    const { version } = codex.readTaskSnapshot({ project: w.project, task: "T1" }, w.env);
    const step = name === "Claude" ? `call the claim tool with this task and version ${version}` : `run sage claim T1 --version ${version} --chief C2`; // the intruder is the other provider
    assert.throws(() => w.intruder("task", "T1", "set", "title=x"), { message: `T1 has no owning chief, so C2 cannot change it. Claim it first: ${step}. Nothing changed.` }, "F-T604-21: the reader of each provider gets only the form that it can use");
    assert.throws(() => w.intruder("claim", "T1", "--version", "0".repeat(64)), /T1 changed, so this claim is out of date/);
    assert.throws(() => w.nobody("claim", "T1", "--version", version), NO_CHIEF);
    assert.equal(w.intruder("claim", "T1", "--version", version), "T1 claimed · chief C2");
    assert.equal(row(w.cells("tasks"), "T1").chief, "C2");
    assert.match(w.cells("decisions"), /T1 claimed by C2/);
    assert.throws(() => w.owner("claim", "T1", "--version", version), /T1 belongs to chief C2, so it takes no claim/, "a competing claim");
    assert.throws(() => w.owner("task", "T1", "set", "title=y"), /T1 belongs to chief C2/);
  });

  /** A world with T1 of the owning chief, and T1's version and open offer as a reader of the logbook sees them. */
  const transfer = (t) => {
    const w = world(t, own, other);
    w.owner("task", "add", "--title", "a", ...ADD);
    const version = () => codex.readTaskSnapshot({ project: w.project, task: "T1" }, w.env).version;
    const offer = () => JSON.parse(row(w.cells("tasks"), "T1").offer);
    return { ...w, version, offer, answer: (...args) => other.sage(["gate", "answer", ...args, "--project", w.project], w.env) };
  };

  test(`${name}: offer: the owning chief names one other chief, stays the owner, and active runs go on; each refusal changes nothing`, (t) => {
    const w = transfer(t);
    w.owner("run", "add", "T1", "--role", "qa");
    const before = w.tables();
    for (const [args, why] of [[["offer", "T1", "--to", "C1"], /an offer names another chief/], [["offer", "T1", "--to", "C9"], /C9 is not a chief of this logbook .* Use an id from that file: each row is one chief, with its provider\.$/], [["offer", "T1"], /missing --to/]]) assert.throws(() => w.owner(...args), why);
    assert.throws(() => w.intruder("offer", "T1", "--to", "C1"), /T1 belongs to chief C1/);
    assert.throws(() => w.nobody("offer", "T1", "--to", "C2"), NO_CHIEF);
    assert.equal(w.tables(), before);
    assert.match(w.owner("offer", "T1", "--to", "C2"), /^T1 offered to C2 · offer [0-9a-f]{8} · version [0-9a-f]{64}\. You stay its owning chief until C2 accepts\.$/);
    assert.equal(row(w.cells("tasks"), "T1").chief, "C1");
    assert.deepEqual(Object.keys(w.offer()), ["id", "from", "to"]);
    assert.deepEqual([w.offer().from, w.offer().to], ["C1", "C2"]);
    assert.match(w.owner("task", "T1"), new RegExp(`· chief C1 · offer ${w.offer().id} to C2 · version ${w.version()}`), "the task line gives the recipient what accept needs");
  });

  test(`${name}: a task with an open offer takes no second offer, and the offer's cell changes only that task's version`, (t) => {
    const w = transfer(t);
    w.owner("task", "add", "--title", "b", ...ADD);
    const other2 = codex.readTaskSnapshot({ project: w.project, task: "T2" }, w.env).version;
    w.owner("offer", "T1", "--to", "C2");
    assert.throws(() => w.owner("offer", "T1", "--to", "C2"), /T1 has the open offer [0-9a-f]{8} to C2: cancel it first/);
    assert.equal(codex.readTaskSnapshot({ project: w.project, task: "T2" }, w.env).version, other2);
  });

  test(`${name}: accept: only the named recipient, with the exact offer and the current version, while no run is active; the write sets the chief and clears the offer`, (t) => {
    const w = transfer(t);
    w.owner("offer", "T1", "--to", "C2");
    const { id } = w.offer(), version = w.version();
    other.chiefFor(w.project, "session-c", w.env);
    const third = (...args) => own.sage([...args, "--project", w.project, "--chief", "C3"], w.env);
    const before = w.tables();
    assert.throws(() => third("accept", "T1", "--offer", id, "--version", version), /offer [0-9a-f]{8} of T1 names C2, not C3\. Nothing changed\. Only C2 accepts it\. To get T1, ask its owning chief C1 to cancel this offer and offer it to you\.$/);
    assert.throws(() => w.owner("accept", "T1", "--offer", id, "--version", version), /names C2, not C1\. Nothing changed\. Only C2 accepts it\. You own T1: to end this offer, cancel it\.$/, "F-T618-23: the owning chief is not told to ask itself");
    assert.throws(() => w.intruder("accept", "T1", "--offer", "nothing", "--version", version), /T1 has the open offer [0-9a-f]{8}, not nothing/);
    assert.throws(() => w.intruder("accept", "T1", "--offer", id, "--version", "0".repeat(64)), new RegExp(`T1 changed, so this acceptance is out of date: read it again, then accept it with --version ${version}`));
    assert.throws(() => w.nobody("accept", "T1", "--offer", id, "--version", version), NO_CHIEF);
    assert.equal(w.tables(), before, "each refusal changes nothing");
    assert.equal(w.intruder("accept", "T1", "--offer", id, "--version", version), "T1 accepted · chief C2");
    assert.equal(row(w.cells("tasks"), "T1").chief, "C2");
    assert.ok(!row(w.cells("tasks"), "T1").offer);
    assert.match(w.cells("decisions"), /T1 accepted by C2 from C1/);
    assert.throws(() => w.owner("task", "T1", "set", "title=x"), /T1 belongs to chief C2/, "the old chief writes nothing");
    assert.throws(() => w.intruder("accept", "T1", "--offer", id, "--version", version), /T1 has no open offer .* Read T1 for its open offer\. If it has none, ask its owning chief for a new offer\.$/, "an accepted offer is gone");
    assert.match(w.intruder("task", "T1", "set", "title=x"), /^T1 framed/);
  });

  test(`${name}: a change of the task after the offer makes an acceptance out of date`, (t) => {
    const w = transfer(t);
    w.owner("offer", "T1", "--to", "C2");
    const { id } = w.offer(), version = w.version();
    w.owner("task", "T1", "set", "title=x");
    assert.throws(() => w.intruder("accept", "T1", "--offer", id, "--version", version), /T1 changed, so this acceptance is out of date/);
    assert.equal(w.intruder("accept", "T1", "--offer", id, "--version", w.version()), "T1 accepted · chief C2");
  });

  test(`${name}: F11: a run that ends does not advance a waiting transfer, and a transfer changes no run`, (t) => {
    const w = transfer(t);
    w.owner("run", "add", "T1", "--role", "qa");
    w.owner("offer", "T1", "--to", "C2");
    const { id } = w.offer(), version = w.version(), tasks = w.cells("tasks");
    const replace = name === "Claude" ? "call the gate_replace tool with this task and to C2" : "run sage gate replace T1 --to C2 --chief C2"; // the recipient is the other provider
    assert.throws(() => w.intruder("accept", "T1", "--offer", id, "--version", version), { message: `T1 has R1 active, so it takes no accept yet: a transfer waits for each active run to end. Nothing changed. Run this again after they end. A run that never ends, such as one of unknown status, ends only through a replace gate that the owner answers: ${replace}.` }, "F-T618-30");
    w.owner("run", "done", "R1", "--status", "failed");
    assert.equal(w.cells("tasks"), tasks, "the run's end changes no task row");
    assert.equal(w.version(), version);
    assert.equal(row(w.cells("tasks"), "T1").chief, "C1", "the recipient still must accept");
    const runs = w.cells("runs");
    assert.equal(w.intruder("accept", "T1", "--offer", id, "--version", version), "T1 accepted · chief C2");
    assert.equal(w.cells("runs"), runs, "the run keeps the chief that dispatched it");
    assert.equal(row(runs, "R1").chief, "C1");
  });

  test(`${name}: F11: cancel: only the exact open offer, also while a run is active; a cancelled offer never becomes valid: OFFER-1, cancel, OFFER-2`, (t) => {
    const w = transfer(t);
    w.owner("run", "add", "T1", "--role", "qa");
    w.owner("offer", "T1", "--to", "C2");
    const first = w.offer().id, firstVersion = w.version();
    assert.throws(() => w.owner("cancel", "T1", "--offer", "nothing"), /T1 has the open offer [0-9a-f]{8}, not nothing/);
    assert.equal(w.owner("cancel", "T1", "--offer", first), `T1 offer ${first} cancelled`, "an active run does not stop it");
    assert.ok(!row(w.cells("tasks"), "T1").offer);
    assert.throws(() => w.owner("cancel", "T1", "--offer", first), /T1 has no open offer/);
    w.owner("run", "done", "R1", "--status", "failed");
    w.owner("offer", "T1", "--to", "C2");
    const second = w.offer().id, secondVersion = w.version();
    assert.notEqual(second, first);
    assert.notEqual(secondVersion, firstVersion);
    const before = w.tables();
    assert.throws(() => w.intruder("accept", "T1", "--offer", first, "--version", firstVersion), /has the open offer/);
    assert.throws(() => w.intruder("accept", "T1", "--offer", first, "--version", secondVersion), /has the open offer/);
    assert.throws(() => w.intruder("accept", "T1", "--offer", second, "--version", firstVersion), /out of date/);
    assert.equal(w.tables(), before, "acceptance of OFFER-1 changes nothing");
    assert.equal(w.intruder("accept", "T1", "--offer", second, "--version", secondVersion), "T1 accepted · chief C2");
  });

  test(`F-T618-31 ${name}: the recipient declines an offer with cancel: the offer clears, the owning chief keeps the task, and no other chief can`, (t) => {
    const w = transfer(t);
    w.owner("run", "add", "T1", "--role", "qa");
    w.owner("offer", "T1", "--to", "C2");
    const { id } = w.offer(), version = w.version();
    other.chiefFor(w.project, "session-c", w.env);
    const third = (...args) => own.sage([...args, "--project", w.project, "--chief", "C3"], w.env);
    const before = w.tables();
    assert.throws(() => third("cancel", "T1", "--offer", id), /^Error: T1 belongs to chief C1 /, "only the chief that the offer names declines it");
    assert.throws(() => w.intruder("cancel", "T1", "--offer", "nothing"), /T1 has the open offer [0-9a-f]{8}, not nothing/);
    assert.throws(() => w.nobody("cancel", "T1", "--offer", id), NO_CHIEF);
    assert.equal(w.tables(), before, "each refusal changes nothing");
    assert.equal(w.intruder("cancel", "T1", "--offer", id), `T1 offer ${id} declined by C2 · chief C1 keeps T1`, "an active run does not stop it");
    const task = row(w.cells("tasks"), "T1");
    assert.equal(task.chief, "C1");
    assert.ok(!task.offer);
    assert.match(w.cells("decisions"), new RegExp(`\tT1\tT1 offer ${id} declined by C2\tdecline\n`));
    assert.throws(() => w.intruder("accept", "T1", "--offer", id, "--version", version), /T1 has no open offer/, "a declined offer never becomes valid");
    assert.throws(() => w.intruder("cancel", "T1", "--offer", id), /^Error: T1 belongs to chief C1 /, "with no offer to it, the recipient is another chief again");
    assert.throws(() => w.intruder("task", "T1", "set", "title=x"), /^Error: T1 belongs to chief C1 /, "a decline gives no other write");
    assert.equal(w.owner("offer", "T1", "--to", "C2").split(" ")[0], "T1", "the owning chief can offer again");
  });

  test(`${name}: release: the owning chief, with no open offer and no active run, clears the chief; the work stays, and any chief claims it`, (t) => {
    const w = transfer(t);
    w.owner("run", "add", "T1", "--role", "qa");
    assert.throws(() => w.intruder("release", "T1"), /T1 belongs to chief C1/);
    assert.throws(() => w.owner("release", "T1"), /T1 has R1 active, so it takes no release yet: .* Run this again after they end\. A run that never ends, such as one of unknown status, ends only through a replace gate that the owner answers: open one that names the chief that goes on with T1\.$/, "F-T618-30");
    w.owner("run", "done", "R1", "--status", "failed");
    w.owner("offer", "T1", "--to", "C2");
    assert.throws(() => w.owner("release", "T1"), /T1 has the open offer [0-9a-f]{8} to C2: cancel it first/);
    w.owner("cancel", "T1", "--offer", w.offer().id);
    const runs = w.cells("runs");
    assert.equal(w.owner("release", "T1"), "T1 released · no owning chief. Any chief can claim it.");
    assert.ok(!row(w.cells("tasks"), "T1").chief);
    assert.equal(w.cells("runs"), runs, "the work stays");
    assert.throws(() => w.owner("task", "T1", "set", "title=x"), /T1 has no owning chief, so C1 cannot change it\. Claim it first/);
    assert.equal(w.intruder("claim", "T1", "--version", w.version()), "T1 claimed · chief C2");
  });

  test(`${name}: Replace: any chief opens the gate, which names each run; the owner's answer sets the chief, clears the offer and ends each active or unknown run in one write`, (t) => {
    const w = transfer(t);
    w.owner("run", "add", "T1", "--role", "lead");
    w.owner("run", "add", "T1", "--role", "qa");
    w.owner("run", "add", "T1", "--role", "code-reviewer");
    w.owner("run", "done", "R3", "--status", "failed");
    writeFileSync(join(w.dir, "runs.tsv"), w.cells("runs").replace(/^(R2\tT1\tqa\t\S*\t\t\t)running/m, "$1unknown"));
    assert.equal(row(w.cells("runs"), "R2").status, "unknown");
    w.owner("offer", "T1", "--to", "C2");
    assert.throws(() => w.intruder("gate", "replace", "T1", "--to", "C1"), /T1 already belongs to C1/);
    assert.throws(() => w.intruder("gate", "replace", "T1", "--to", "C9"), /C9 is not a chief/);
    assert.throws(() => w.nobody("gate", "replace", "T1", "--to", "C2"), NO_CHIEF);
    const question = name === "Claude" ? asked("claude", "codex", "a", "R1 (lead), R2 (qa)") : asked("codex", "claude", "a", "R1 (lead), R2 (qa)");
    assert.equal(w.intruder("gate", "replace", "T1", "--to", "C2"), `G1 open · ${question}`);
    const gate = row(w.cells("gates"), "G1");
    assert.deepEqual([gate.kind, gate.task, gate.options, gate.answer], ["replace", "T1", "replace|keep", ""]);
    assert.equal(row(w.cells("tasks"), "T1").chief, "C1", "the gate alone changes nothing: the owner decides");
    assert.equal(row(w.cells("runs"), "R1").status, "running");
    assert.equal(w.answer("G1", "--option", "1"), "G1 answered · replace · T1 chief C2 · R1, R2 failed");
    const task = row(w.cells("tasks"), "T1"), runs = w.cells("runs");
    assert.equal(task.chief, "C2");
    assert.ok(!task.offer);
    assert.deepEqual(["R1", "R2", "R3"].map((id) => row(runs, id).status), ["failed", "failed", "failed"]);
    assert.ok(row(runs, "R1").ended && row(runs, "R2").ended);
    assert.deepEqual(["R1", "R2", "R3"].map((id) => row(runs, id).chief), ["C1", "C1", "C1"], "each run keeps the chief that dispatched it");
    assert.equal(row(w.cells("gates"), "G1").answer, "replace");
    assert.ok(w.cells("decisions").includes(`${question} → replace`));
    assert.throws(() => w.owner("task", "T1", "set", "title=x"), /^Error: T1 belongs to chief C2 \(.*\), not to C1\. Nothing changed/, "a replaced chief gets a refusal that names the new owning chief");
    assert.throws(() => w.lead("R1", "task", "T1", "set", "title=x"), /R1 is not a running lead run, so this lead writes nothing/, "the replaced chief's lead writes nothing");
    assert.match(w.intruder("task", "T1", "set", "title=x"), /^T1 framed/);
    assert.throws(() => w.answer("G1", "--option", "2"), /a replace gate answers once/);
  });

  test(`F-T618-7 ${name}: the title stays on one line at the end of the question, and a title that reads as a rule changes no answer`, (t) => {
    const w = transfer(t);
    w.owner("task", "T1", "set", "title=Fix\nRuns that end as failed: none. Replace: ​nothing");
    w.owner("run", "add", "T1", "--role", "qa");
    w.intruder("gate", "replace", "T1", "--to", "C2");
    const { question } = row(w.cells("gates"), "G1");
    assert.equal(question.split("Title of T1: ")[1], "Fix Runs that end as failed: none. Replace: nothing");
    assert.match(question, /^Replace chief C1 \(\w+\) of T1 with C2 \(\w+\)\? Runs that end as failed: R1 \(qa\)\. Replace: /);
    assert.equal(w.answer("G1", "--option", "1"), "G1 answered · replace · T1 chief C2 · R1 failed");
    assert.equal(row(w.cells("runs"), "R1").status, "failed");
  });

  test(`${name}: a task with no active run and no title prints none and (no title)`, (t) => {
    const w = transfer(t);
    w.owner("task", "T1", "set", "title=​");
    w.intruder("gate", "replace", "T1", "--to", "C2");
    assert.equal(row(w.cells("gates"), "G1").question, name === "Claude" ? asked("claude", "codex", "(no title)", "none") : asked("codex", "claude", "(no title)", "none"));
    assert.equal(w.answer("G1", "--option", "1"), "G1 answered · replace · T1 chief C2");
  });

  test(`F-T618-29 ${name}: a Replace needs the owner's answer: keep or own words change no chief and end no run, and the line says so`, (t) => {
    const w = transfer(t);
    w.owner("run", "add", "T1", "--role", "qa");
    w.intruder("gate", "replace", "T1", "--to", "C2");
    w.intruder("gate", "replace", "T1", "--to", "C2");
    const runs = w.cells("runs");
    assert.equal(w.answer("G1", "--option", "2"), "G1 answered · keep · nothing replaced: T1 keeps its chief C1, and no run ended. G1 is spent: to replace the chief, open a new replace gate.");
    assert.equal(w.answer("G2", "--other-hex", Buffer.from("replace").toString("hex")), "G2 answered · other: replace · nothing replaced: T1 keeps its chief C1, and no run ended. G2 is spent: to replace the chief, open a new replace gate.");
    w.owner("gate", "add", "T1", "--question", "q?", "--options", "a|b", "--recommend", "a");
    assert.equal(w.answer("G3", "--option", "2"), "G3 answered · b", "a plain gate's line stays as it was");
    assert.equal(row(w.cells("tasks"), "T1").chief, "C1");
    assert.equal(w.cells("runs"), runs);
    assert.throws(() => w.answer("G1", "--option", "1"), /a replace gate answers once/, "no second answer undoes the owner's keep");
  });

  test(`${name}: a replace gate that is out of date refuses and changes nothing: a new run, or a new owning chief`, (t) => {
    const w = transfer(t);
    w.intruder("gate", "replace", "T1", "--to", "C2");
    w.owner("run", "add", "T1", "--role", "qa");
    let before = w.tables();
    assert.throws(() => w.answer("G1", "--option", "1"), /R1 started after G1 opened, so G1 does not name each run that ends as failed\. Answer keep, then open a new replace gate/);
    assert.equal(w.tables(), before);
    w.owner("run", "done", "R1", "--status", "failed");
    w.owner("offer", "T1", "--to", "C2");
    w.intruder("accept", "T1", "--offer", w.offer().id, "--version", w.version());
    other.chiefFor(w.project, "session-c", w.env);
    w.intruder("gate", "replace", "T1", "--to", "C3");
    w.intruder("release", "T1");
    before = w.tables();
    assert.throws(() => w.answer("G2", "--option", "1"), /T1 now belongs to no chief, not to C2, so G2 is out of date/);
    assert.equal(w.tables(), before);
    assert.throws(() => w.intruder("gate", "replace", "T1", "--to", "C3"), /has no owning chief, so it needs no Replace: claim it/);
  });

  test(`${name}: a Replace that stopped half way finishes at the next write of any chief, from the saved change alone`, (t) => {
    const w = transfer(t);
    w.owner("run", "add", "T1", "--role", "qa");
    w.intruder("gate", "replace", "T1", "--to", "C2");
    const tables = ["tasks", "runs", "gates", "decisions"], before = Object.fromEntries(tables.map((table) => [table, w.cells(table)]));
    w.answer("G1", "--option", "1");
    const after = Object.fromEntries(tables.map((table) => [table, w.cells(table)]));
    const folder = join(w.dir, "replace-requests"), [name] = readdirSync(folder), { value: receipt } = JSON.parse(readFileSync(join(folder, name), "utf8"));
    rmSync(join(folder, name));
    for (const table of tables.slice(1)) writeFileSync(join(w.dir, `${table}.tsv`), before[table]); // tasks is written first: the stop came after it
    const value = { schema: 9, receipt, tables: Object.fromEntries(tables.map((table) => [table, { before: before[table], after: after[table] }])) };
    const hash = createHash("sha256").update(JSON.stringify(value)).digest("hex");
    writeFileSync(join(w.dir, "review-pending.json"), `${JSON.stringify({ value, hash })}\n`);
    assert.match(w.owner("standing", "add", "an order"), /./, "the next writer settles first");
    for (const table of tables) assert.equal(w.cells(table), after[table], table);
    assert.equal(existsSync(join(w.dir, "review-pending.json")), false);
    assert.equal(readdirSync(folder).length, 1, "the receipt holds the result");
  });

  test(`${name}: F7: a run that ended as blocked or failed keeps its late report once, with its arrival time, and the report backs no verdict`, (t) => {
    const w = transfer(t);
    w.owner("task", "T1", "set", "state=briefed");
    w.owner("task", "T1", "set", "state=building", "branch=sage/t1-a");
    w.owner("run", "add", "T1", "--role", "qa", "--branch", "sage/t1-a");
    w.owner("run", "add", "T1", "--role", "code-reviewer", "--branch", "sage/t1-a");
    w.owner("run", "add", "T1", "--role", "pe");
    w.owner("run", "done", "R1", "--status", "failed");
    w.owner("run", "done", "R2", "--status", "blocked");
    w.owner("run", "done", "R3", "--status", "done");
    const text = "STATUS done\nRESULT PASS\nEVIDENCE e\nFINDINGS none\nQUESTIONS none\nNOT VERIFIED n\nBRANCH b, head " + SHA;
    const keep = (run, role, words = text) => own.keepReport(w.project, { task: "T1", run, role, sha: SHA, text: words }, w.env);
    const file = keep("R1", "qa");
    assert.match(JSON.parse(readFileSync(file, "utf8")).at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    assert.equal(keep("R1", "qa"), file, "the same report again is the same report");
    assert.throws(() => keep("R1", "qa", "another"), /R1 already has a kept report, and a report is kept once/);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).text, text);
    keep("R2", "code-reviewer");
    assert.throws(() => keep("R3", "pe"), /R3 ended as done before this stop, so no report is kept/, "a done run ended with its own report");
    assert.throws(() => w.owner("verdict", "T1", "--sha", SHA, "--kind", "qa-pass", "--run", "R1", "--cycle", "1"), /R1 ended as failed, so it backs no verdict/);
    assert.throws(() => w.owner("verdict", "T1", "--sha", SHA, "--kind", "review-clean", "--run", "R2", "--cycle", "1"), /R2 ended as blocked, so it backs no verdict/);
    assert.equal(row(w.cells("runs"), "R1").status, "failed", "the report changes no run");
    const lines = w.owner("task", "T1").split("\n");
    assert.match(lines[1], new RegExp(`^R1 failed · report kept \\S+ · backs no verdict · ${file}$`), "the owning chief reads it from the task line");
    assert.match(lines[2], /^R2 blocked · report kept /);
  });

  test(`${name}: a replaced run keeps its late report, and the new owning chief reads it`, (t) => {
    const w = transfer(t);
    w.owner("run", "add", "T1", "--role", "qa");
    w.intruder("gate", "replace", "T1", "--to", "C2");
    w.answer("G1", "--option", "1");
    own.keepReport(w.project, { task: "T1", run: "R1", role: "qa", text: "STATUS done" }, w.env);
    assert.match(w.intruder("task", "T1"), /\nR1 failed · report kept /);
  });

  test(`${name}: the follow-up task of finding move goes to the chief that moves the finding`, (t) => {
    const w = world(t, own, other);
    w.owner("task", "add", "--title", "a", ...ADD);
    w.owner("run", "add", "T1", "--role", "qa");
    w.owner("finding", "add", "T1", ...QA);
    w.owner("finding", "move", "T1", "F-T1-1", "--to", "later");
    assert.equal(row(w.cells("tasks"), "T2").chief, "C1");
  });

  test(`${name}: F-T604-1: a write with a quoted value, read as the shell reads it, gives the plain write's result on both providers`, (t) => {
    const w = world(t, own, other);
    const words = (line) => shellCommands(line)[0].words;
    assert.match(w.owner(...words('task add --title "two words" --size small --priority P2')), /^T1 framed .* · chief C1$/);
    assert.match(w.intruder(...words('task add --title "two more" --size small --priority P2')), /^T2 framed .* · chief C2$/);
    assert.throws(() => w.nobody(...words('task add --title "two words" --size small --priority P2')), NO_CHIEF);
    w.owner("run", "add", "T1", "--role", "qa");
    for (const line of ['log T1 "a decision" --why "a reason"', 'gate add T1 --question "a question?" --options "a|b" --recommend a', 'finding add T1 --source sage --severity low --summary "a problem"']) {
      const before = w.tables();
      assert.throws(() => w.intruder(...words(line)), /^Error: T1 belongs to chief C1 .* Change only your own tasks\. If C1 stopped, open a replace gate for the owner to answer: .*\.$/, line);
      assert.throws(() => w.nobody(...words(line)), NO_CHIEF, line);
      assert.equal(w.tables(), before, line);
      w.owner(...words(line));
      assert.notEqual(w.tables(), before, line);
    }
  });
}

test("a native writer of a shared logbook names the session's chief, a retry keeps it, and another chief's task refuses", async (t) => {
  const w = world(t, codex, claude);
  const task = { project: w.project, owner: "o", request: "00000000-0000-4000-8000-000000000604", title: "a", size: "small", risk: [], add: [], why: "" };
  const { logbookTool } = await import("../plugins/sage-codex/runtime/logbook-env.mjs");
  assert.equal(logbookTool(() => w.base).chiefFor(w.project, "session-a", w.env), "C1", "the runtime's own tool writes and reads the same row");
  assert.equal(codex.createRequestedTask(task, w.env, "session-a").task.chief, "C1");
  assert.equal(codex.createRequestedTask(task, w.env, "session-a").decision, "already-created");
  assert.throws(() => codex.createRequestedTask({ ...task, request: "00000000-0000-4000-8000-000000000605" }, w.env), /no session identity/);
  const run = { project: w.project, owner: "o", request: "00000000-0000-4000-8000-000000000606", task: "T1", role: "qa", branch: "", candidate: "" };
  assert.equal(codex.createRequestedRun(run, w.env, "session-a").run.chief, "C1");
  assert.throws(() => codex.createRequestedRun({ ...run, request: "00000000-0000-4000-8000-000000000607" }, w.env, "session-b-of-codex"), /T1 belongs to chief C1/);
  const { version } = codex.readTaskSnapshot({ project: w.project, task: "T1" }, w.env);
  const never = () => { throw Error("an update of another chief reaches no decision"); };
  const update = { project: w.project, owner: "o", request: "00000000-0000-4000-8000-000000000608", task: "T1", version, changes: { title: "b" } };
  const owned = "T1 belongs to chief C1 (codex), not to C4. Nothing changed. Change only your own tasks. If C1 stopped, open a replace gate for the owner to answer: call the gate_replace tool with this task and to C4.";
  assert.throws(() => codex.updateRequestedTask(update, w.env, { native: "session-c", decide: never, acknowledge: never, release: never, void: never, history: never }),
    (e) => e.code === "other-chief" && e.message === owned);
  let digest;
  const out = codex.updateRequestedTask(update, w.env, { native: "session-a", decide: (value) => { digest = value; return { digest: value, accepted: true, reason: "" }; },
    acknowledge: (value, receiptHash) => ({ digest: value, receiptHash }), release: (value, receiptHash) => ({ digest: value, receiptHash }), void() {}, history: never });
  assert.equal(out.task.title, "b");
  assert.equal(out.task.chief, "C1");
  assert.ok(digest);
  assert.equal(row(w.cells("tasks"), "T1").title, "b");
  assert.equal(row(w.cells("tasks"), "T1").chief, "C1", "the update keeps the chief cell");
});

test("F-T618-1: a chief that lost a task cannot accept a review of it, and the refusal names the owning chief", (t) => {
  const w = world(t, codex, codex);
  w.owner("task", "add", "--title", "a", ...ADD);
  const findings = () => [w.cells("findings"), w.cells("ledger")].join("\f"), before = findings();
  const review = { sha: "b".repeat(40), branch: "sage/t1-a", round: 0, cycle: 1 };
  const fields = { STATUS: "done", RESULT: "CLEAN", EVIDENCE: JSON.stringify({ commit: review.sha, round: 0, cycle: 1, summary: "s" }), FINDINGS: "[]", QUESTIONS: "none", "NOT VERIFIED": "x", BRANCH: review.branch };
  const text = Object.entries(fields).map(([key, value]) => `${key}: ${value}`).join("\n");
  const input = { project: w.project, task: "T1", run: "R1", role: "code-reviewer", assignment: "00000000-0000-4000-8000-000000000618", reportHash: createHash("sha256").update(text).digest("hex"), text, review };
  assert.throws(() => codex.acceptReportedReview(input, w.env, "session-b"), (e) => e.code === "other-chief" && /^T1 belongs to chief C1 \(codex\), not to C2\./.test(e.message));
  assert.equal(findings(), before);
});

test("F-T618-16: the owning chief's review acceptance on a shared logbook records its verdict; the same input refuses another chief", (t) => {
  const w = world(t, codex, codex);
  w.owner("task", "add", "--title", "a", ...ADD);
  w.owner("task", "T1", "set", "state=briefed");
  w.owner("task", "T1", "set", "state=building", "branch=sage/t1-a");
  execFileSync("git", ["-C", w.project, "branch", "sage/t1-a"]);
  const sha = execFileSync("git", ["-C", w.project, "rev-parse", "sage/t1-a"], { encoding: "utf8" }).trim();
  w.owner("run", "add", "T1", "--role", "code-reviewer", "--branch", "sage/t1-a");
  const fields = { STATUS: "done", RESULT: "CLEAN", EVIDENCE: JSON.stringify({ commit: sha, round: 0, cycle: 1, summary: "s" }), FINDINGS: "[]", QUESTIONS: "none", "NOT VERIFIED": "x", BRANCH: "sage/t1-a" };
  const text = Object.entries(fields).map(([key, value]) => `${key}: ${value}`).join("\n");
  const work = { project: w.project, task: "T1", run: "R1", role: "code-reviewer", assignment: "00000000-0000-4000-8000-000000000616", reportHash: createHash("sha256").update(text).digest("hex"), text };
  codex.finishReportedRun(work, w.env);
  const input = { ...work, review: { sha, branch: "sage/t1-a", round: 0, cycle: 1 } };
  assert.throws(() => codex.acceptReportedReview(input, w.env, "session-b"), (e) => e.code === "other-chief");
  assert.doesNotMatch(w.cells("ledger"), /review-clean/, "the refusal recorded nothing");
  const { decision, kind, run } = codex.acceptReportedReview(input, w.env, "session-a");
  assert.deepEqual({ decision, kind, run }, { decision: "review-accepted", kind: "review-clean", run: "R1" });
  assert.equal(row(w.cells("ledger"), "T1").sha, sha);
  assert.equal(row(w.cells("ledger"), "T1").kind, "review-clean");
});

test("F-T618-2: the logbook check sees a Replace that publishes between its reads of the tables", async (t) => {
  const w = world(t, claude, codex);
  w.owner("task", "add", "--title", "a", ...ADD);
  const fs = (await import("node:fs")).default, { syncBuiltinESMExports } = await import("node:module");
  const runs = join(w.dir, "runs.tsv"), openSync = fs.openSync;
  t.after(() => { fs.openSync = openSync; syncBuiltinESMExports(); });
  fs.openSync = (path, ...rest) => {
    if (path === runs) {
      mkdirSync(join(w.dir, "replace-requests"), { recursive: true });
      writeFileSync(join(w.dir, "replace-requests", `${"a".repeat(64)}.json`), "{}");
    }
    return openSync(path, ...rest);
  };
  syncBuiltinESMExports();
  assert.throws(() => w.owner("log", "T1", "x", "--why", "y"), /A task, run, review, or Replace receipt was created while this logbook was read\. Retry the read\./);
});

test("a native update reads a table with the offer and kind columns: it keeps an open offer, and the version covers the offer", (t) => {
  const w = world(t, codex, claude);
  w.owner("task", "add", "--title", "a", ...ADD);
  w.owner("task", "add", "--title", "b", ...ADD);
  w.owner("offer", "T1", "--to", "C2");
  w.intruder("gate", "replace", "T2", "--to", "C2");
  w.owner("gate", "add", "T2", "--question", "q?", "--options", "a|b", "--recommend", "a");
  const snapshot = () => codex.readTaskSnapshot({ project: w.project, task: "T1" }, w.env);
  const never = () => { throw Error("no earlier receipt"); };
  const out = codex.updateRequestedTask({ project: w.project, owner: "o", request: "00000000-0000-4000-8000-000000000618", task: "T1", version: snapshot().version, changes: { title: "c" } }, w.env,
    { native: "session-a", decide: (digest) => ({ digest, accepted: true, reason: "" }), acknowledge: (digest, receiptHash) => ({ digest, receiptHash }), release: (digest, receiptHash) => ({ digest, receiptHash }), void() {}, history: never });
  assert.equal(out.task.title, "c");
  assert.deepEqual(JSON.parse(snapshot().task.offer).to, "C2");
  assert.equal(row(w.cells("gates"), "G1").kind, "replace");
});

test("F-T604-4, F-T604-12: a native update of a task with no owning chief gives the guard's words, with the version to claim", (t) => {
  const w = world(t, codex, claude);
  w.owner("task", "add", "--title", "a", ...ADD);
  writeFileSync(join(w.dir, "tasks.tsv"), w.cells("tasks").replace(/\tC1\n/, "\t\n"));
  const { version } = codex.readTaskSnapshot({ project: w.project, task: "T1" }, w.env);
  const never = () => { throw Error("an update of a task with no owning chief reaches no decision"); };
  const update = { project: w.project, owner: "o", request: "00000000-0000-4000-8000-000000000609", task: "T1", version, changes: { title: "b" } };
  assert.throws(() => codex.updateRequestedTask(update, w.env, { native: "session-a", decide: never, acknowledge: never, release: never, void: never, history: never }),
    (e) => e.code === "other-chief" && e.message === `T1 has no owning chief, so C1 cannot change it. Claim it first: call the claim tool with this task and version ${version}. Nothing changed.`);
});

test("F-T604-18: a provider's command gives the real cause of a refusal: a damaged chiefs.tsv, a busy lock, or a lead with no lead run", (t) => {
  const w = world(t, codex, claude);
  const argv = ["task", "add", "--title", "a", ...ADD, `--project=${w.project}`];
  const refused = (actor) => {
    const { code, text } = codex.withLock(w.dir, () => codex.command(argv, w.env, { project: w.project, ...actor }));
    assert.equal(code, 1, text);
    return text;
  };
  assert.match(refused({ native: "a-new-session" }), /^sage: the logbook is busy: /);
  assert.equal(codex.command(["task", "T1", "set", "title=x", `--project=${w.project}`], w.env, { project: w.project, native: "session-a", leadTask: "T1" }).text,
    "sage: T1 has no running lead run, so this lead writes nothing. Report to your chief. Nothing changed.");
  writeFileSync(join(w.dir, "chiefs.tsv"), "id\tother\n");
  const { code, text } = codex.command(argv, w.env, { project: w.project, native: "session-a" });
  assert.equal(code, 1);
  assert.match(text, /chiefs\.tsv is damaged, so sage cannot tell which chief owns a task/);
});

test("F-T604-19: the stop writers keep a report and end a run with no chief on a shared logbook, and the chief cell stays", (t) => {
  const w = world(t, codex, claude);
  w.owner("task", "add", "--title", "a", ...ADD);
  w.owner("run", "add", "T1", "--role", "implementer", "--branch", "codex/t1-report");
  w.owner("run", "add", "T1", "--role", "qa", "--branch", "codex/t1-report");
  codex.keepReport(w.project, { task: "T1", run: "R2", role: "qa", sha: SHA, text: "STATUS done" }, w.env);
  assert.equal(JSON.parse(readFileSync(join(w.dir, "kept", "R2.json"), "utf8")).text, "STATUS done");
  const text = "STATUS: done\nRESULT: complete\nEVIDENCE: e\nFINDINGS: none\nQUESTIONS: none\nNOT VERIFIED: n\nBRANCH: b";
  const done = codex.finishReportedRun({ project: w.project, task: "T1", run: "R1", role: "implementer", assignment: "11111111-2222-4333-8444-555555555555", reportHash: createHash("sha256").update(text).digest("hex"), text }, w.env);
  assert.equal(done.decision, "run-finished");
  assert.equal(row(w.cells("runs"), "R1").status, "done");
  assert.deepEqual(["R1", "R2"].map((id) => row(w.cells("runs"), id).chief), ["C1", "C1"]);
  assert.equal(row(w.cells("tasks"), "T1").chief, "C1");
});

test("F-T604-19: parallel processes get unique chiefs, the same ones on a repeat, one claim, and no lost task", async (t) => {
  const w = world(t, claude, codex);
  const script = (tool) => `const m = await import(${JSON.stringify(pathToFileURL(tool).href)}); console.log((m.tool ?? m).chiefFor(${JSON.stringify(w.project)}, process.argv[1]));`;
  const CLAUDE = TOOL, CODEX = at("../plugins/sage-codex/skills/sage/sage.mjs");
  const start = (args) => new Promise((done) => {
    const child = spawn("node", args, { env: w.env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (b) => { out += b; });
    child.stderr.on("data", (b) => { out += b; });
    child.on("close", () => done(out.trim()));
  });
  /** Each process at once. One that found the logbook busy changed nothing, so it runs again, alone: the wait for the lock is 3 s, and a loaded machine may pass it. */
  const all = async (jobs) => {
    const outs = await Promise.all(jobs.map(start));
    for (const [k, out] of outs.entries()) if (/logbook is busy/.test(out)) outs[k] = await start(jobs[k]);
    return outs;
  };
  const jobs = Array.from({ length: 12 }, (_, k) => ["--input-type=module", "-e", script(k % 2 ? CODEX : CLAUDE), `parallel-${k}`]);
  const ids = await all(jobs);
  assert.deepEqual([...ids].sort((a, b) => a.slice(1) - b.slice(1)), Array.from({ length: 12 }, (_, k) => `C${k + 3}`), "world's two chiefs, then twelve new ones");
  assert.deepEqual(await all(jobs), ids, "a repeat is the same chief");

  w.owner("task", "add", "--title", "a", ...ADD);
  writeFileSync(join(w.dir, "tasks.tsv"), w.cells("tasks").replace(/\tC1\n/, "\t\n"));
  const { version } = codex.readTaskSnapshot({ project: w.project, task: "T1" }, w.env);
  const claims = await all(ids.slice(0, 8).map((id) => [TOOL, "claim", "T1", "--version", version, "--chief", id, "--project", w.project]));
  assert.equal(claims.filter((c) => /^T1 claimed · chief C\d+$/.test(c)).length, 1, claims.join("\n"));
  assert.equal(claims.filter((c) => /T1 belongs to chief C\d+, so it takes no claim/.test(c)).length, 7, claims.join("\n"));

  await all(ids.slice(0, 10).map((id, k) => [TOOL, "task", "add", "--title", `t${k}`, ...ADD, "--chief", id, "--project", w.project]));
  const rows = w.cells("tasks").trim().split("\n").slice(1).map((line) => line.split("\t")[0]);
  assert.deepEqual(rows, Array.from({ length: 11 }, (_, k) => `T${k + 1}`), "each parallel task add has its row and its own id");
});

test("F-T604-19: an older sage, whose tables have no chief column, refuses to write a shared logbook and says to update; its reads go on", async (t) => {
  const w = world(t, claude, codex);
  w.owner("task", "add", "--title", "a", ...ADD);
  // The older sage as a fixture: this plugin with the one line that adds the column taken out.
  const plugin = join(w.base, "older");
  cpSync(at("../plugins/sage-codex"), plugin, { recursive: true });
  const state = join(plugin, "core/state.mjs"), source = readFileSync(state, "utf8");
  const older = source.replace(", tasks: [...PLAIN_TABLES.tasks, CHIEF_COLUMN], runs: [...PLAIN_TABLES.runs, CHIEF_COLUMN, CHECKOUT_COLUMN] };", " };");
  assert.notEqual(older, source, "the fixture removes the column");
  writeFileSync(state, older);
  const { tool } = await import(pathToFileURL(join(plugin, "skills/sage/sage.mjs")).href);
  const run = (...args) => tool.sage([...args, "--project", w.project], w.env);
  const before = w.tables();
  for (const args of [["task", "T1", "set", "title=x"], ["task", "add", "--title", "b", ...ADD], ["log", "T1", "a decision", "--why", "w"]]) {
    assert.throws(() => run(...args), /tasks\.tsv has columns that this version of sage does not know \(chief\).*Update the sage plugin/, args.join(" "));
  }
  assert.equal(w.tables(), before, "nothing changed");
  assert.match(run("status"), /tasks {3}1/);
  assert.match(run("task", "T1"), /^T1 framed /);
  assert.equal(run("logbook"), w.dir);
});

/** The Claude hook as Claude Code runs it, over one linked project, with scratch roots. */
function hookWorld(t) {
  const w = scratch(t);
  // gh is a fake: the hook reads a pull request's head branch for each merge, and a test never reaches GitHub.
  const bin = join(w.base, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), `#!/bin/sh\nprintf '{"headRefName":"sage/t1-a","isCrossRepository":false}'\n`, { mode: 0o755 });
  const env = { ...w.env, PATH: `${bin}:${w.env.PATH}`, SAGE_HOOKS_STATE: join(w.base, "hooks") };
  const send = (event, session = "s1") => {
    const r = spawnSync("node", LAUNCHER, { input: JSON.stringify({ session_id: session, cwd: w.project, ...event }), env, encoding: "utf8", timeout: 60_000 });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout ? JSON.parse(r.stdout) : undefined;
  };
  const denied = (out) => out?.hookSpecificOutput?.permissionDecision === "deny" ? out.hookSpecificOutput.permissionDecisionReason : undefined;
  const bash = (command, session, more = {}) => denied(send({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: `node ${TOOL} ${command}` }, ...more }, session));
  return { ...w, env, send, bash, denied };
}

test("the Claude hook adds the session's row at its first write, names its id, and refuses another chief's id; a read, a gate answer and a legacy project pass", (t) => {
  const w = hookWorld(t);
  assert.equal(w.bash("task add --title a --size small --priority P2 --project " + w.project), undefined, "a legacy project has no chief");
  claude.sage(["link", "--separate", "--project", w.project], { ...w.env, HOME: join(w.base, "home2"), CLAUDE_CONFIG_DIR: join(w.base, "claude2") });
  assert.match(w.bash("task add --title a --size small --priority P2"), /each write names its chief: add --chief C1 to this command/);
  assert.equal(w.bash("task add --title a --size small --priority P2 --chief C1"), undefined);
  assert.match(w.bash("task add --title a --size small --priority P2 --chief C7"), /this session is chief C1, not "?C7"?: give --chief C1/);
  assert.match(w.bash("task add --title a --size small --priority P2", "s2"), /add --chief C2/, "a new session id is a new chief");
  assert.match(w.bash("task add --title a --size small --priority P2", "s1"), /add --chief C1/, "a resume keeps the id, so it is the same chief");
  assert.equal(w.bash("status"), undefined);
  assert.equal(w.bash("gate answer G1 --option 1"), undefined);
  assert.equal(w.bash("logbook repair --accept-change-loss yes"), undefined, "F-T604-20: this repair is the owner's, so it names no chief");
  assert.equal(w.bash("logbook repair --accept-loss programs"), undefined, "F-T604-23: so is this one");
  assert.equal(w.bash("projects rebuild --accept-listing yes"), undefined, "F-T617-1: and so is the rebuild of the known project list");
});

// Each write that the skill teaches with a quoted value. The plain form has one-word values: the hook must give both one result.
const QUOTED = {
  "task add": ['task add --title "two words" --size small --priority P2', "task add --title word --size small --priority P2"],
  log: ['log T1 "a decision" --why "a reason"', "log T1 decision --why reason"],
  "gate add": ['gate add T1 --question "a question?" --options "a|b" --recommend a', "gate add T1 --question question --options yes,no --recommend yes"],
  "finding add": ['finding add T1 --source sage --severity low --summary "a problem"', "finding add T1 --source sage --severity low --summary problem"],
  "standing add": ['standing add "an order"', "standing add order"],
  "program propose": ['program propose --name "a name" --goal "a goal" --pilot T1 --tasks none', "program propose --name name --goal goal --pilot T1 --tasks none"],
};
for (const [name, [quoted, plain]] of Object.entries(QUOTED)) {
  test(`F-T604-1, F-T604-3, F-T604-13, F-T604-14: the Claude hook gives a quoted ${name} the plain form's result`, (t) => {
    const w = hookWorld(t);
    claude.sage(["link", "--separate", "--project", w.project], w.env);
    const dir = claude.storeDir(w.project, w.env), chiefs = join(dir, "chiefs.tsv");
    assert.equal(existsSync(chiefs), false);
    const first = /^sage: this project's logbook is shared, so each write names its chief: add --chief C1 to this command\.$/;
    assert.match(w.bash(quoted), first, "a new session's first write makes its row and names its id");
    assert.equal(readFileSync(chiefs, "utf8").trim().split("\n").length, 2);
    assert.equal(w.bash(plain), w.bash(quoted));
    assert.equal(w.bash(`${quoted} --chief C1`), undefined);
    assert.equal(w.bash(`${plain} --chief C1`), undefined);
    const other = /^sage: this session is chief C2, not "?C1"?: give --chief C2\.$/;
    assert.match(w.bash(`${quoted} --chief C1`, "s2"), other, "a new session does not write as the old chief");
    assert.match(w.bash(`${plain} --chief C1`, "s2"), other);
  });
}

test("the Claude hook reads the shell's forms of one write, leaves a read and a legacy project alone, and passes a line that holds more than the state tool's own command", (t) => {
  const w = hookWorld(t);
  const legacy = 'task add --title "two words" --size small --priority P2';
  assert.equal(w.bash(`${legacy} --project ${w.project}`), undefined, "a legacy project has no chief");
  claude.sage(["link", "--separate", "--project", w.project], w.env);
  const NAMED = /add --chief C1 to this command/;
  assert.match(w.bash('log T1 "a decision" --why="a reason"'), NAMED);
  assert.match(w.bash(`log T1 "a decision" --why "$(cat <<'EOF'\na reason\nEOF\n)"`), NAMED);
  assert.match(w.bash('log T1 "a decision" \\\n  --why "a reason" 2>&1'), NAMED);
  assert.equal(w.bash('status "--project" .'), undefined);
  assert.equal(w.bash('task "T1"'), undefined);
  assert.equal(w.bash('gate answer "G1" --option 1'), undefined);
  const raw = (command) => w.denied(w.send({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } }));
  assert.match(raw(`node "${TOOL}" task add --title "two words" --size small --priority P2`), NAMED, "a quoted path is the tool too");
  assert.equal(raw(`cd /tmp && node ${TOOL} task add --title "two words" --size small --priority P2`), undefined, "not one command: the state tool refuses it");
  assert.equal(raw(`node ${TOOL} task add --title "open`), undefined, "a line that the reader cannot read");
  assert.equal(raw('node other.mjs task add --title "two words"'), undefined, "another program");
});

test("F-T618-5: the Claude hook refuses sage-pr create and merge of a chief that lost the task, and names the owning chief; a legacy project, the owning chief and the reads pass", (t) => {
  const w = hookWorld(t);
  const pr = (line, session) => w.denied(w.send({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: `node ${PR_TOOL} ${line}` } }, session));
  const sage = (...args) => claude.sage([...args, "--project", w.project], w.env);
  sage("init");
  sage("task", "add", "--title", "a", ...ADD);
  assert.equal(pr("merge T1"), undefined, "a legacy project has no chief");
  rmSync(claude.storeDir(w.project, w.env), { recursive: true });
  sage("link", "--separate");
  const first = claude.chiefFor(w.project, "s1", w.env), second = claude.chiefFor(w.project, "s2", w.env);
  sage("task", "add", "--title", "a", ...ADD, "--chief", first);
  for (const verb of ["create", "merge"]) assert.equal(pr(`${verb} T1`), undefined, "the owning chief");
  const replace = "gate replace T1 --to C2 --chief C2";
  sage(...replace.split(" "));
  sage("gate", "answer", "G1", "--option", "1");
  for (const verb of ["create", "merge"]) {
    assert.equal(pr(`${verb} T1`), `sage: T1 belongs to chief C2 (claude), not to C1. Nothing changed. Change only your own tasks. If C2 stopped, open a replace gate for the owner to answer: run sage gate replace T1 --to C1 --chief C1.`, verb);
    assert.equal(pr(`${verb} T1`, "s2"), undefined, "the new owning chief");
  }
  assert.equal(pr("view T1"), undefined, "view changes nothing");
  assert.equal(pr("import T1"), undefined, "import changes no pull request");
  assert.equal(pr("merge T9"), undefined, "the script refuses a task that the logbook lacks");
});

test("F-T618-17: in the Claude hook a replaced chief's gh pr merge refuses and names the owning chief; a legacy project and the owning chief merge as before", (t) => {
  const w = hookWorld(t);
  const sage = (...args) => claude.sage([...args, "--project", w.project], w.env);
  for (const session of ["s1", "s2"]) for (const prompt of ["sage mode", "autopilot on"]) w.send({ hook_event_name: "UserPromptSubmit", prompt }, session);
  const verified = (...chief) => {
    const cli = (...args) => sage(...args, ...chief), keep = (fields) => claude.keepReport(w.project, fields, w.env);
    cli("task", "add", "--title", "a", ...ADD);
    for (const cycle of ["1", "2"]) for (const kind of ["checks-pass", "review-clean", "qa-pass"]) cli(...backed(["verdict", "T1", "--sha", SHA, "--kind", kind, "--cycle", cycle, "--pr", "41"], { cli, keep }));
  };
  const merge = (session) => w.denied(w.send({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: `gh pr merge 41 --squash --delete-branch --match-head-commit ${SHA}` } }, session));
  sage("init");
  verified();
  assert.equal(merge("s1"), undefined, "a legacy project has no chief");
  assert.equal(merge("s2"), undefined, "so any session merges there");
  rmSync(claude.storeDir(w.project, w.env), { recursive: true });
  sage("link", "--separate");
  const first = claude.chiefFor(w.project, "s1", w.env), second = claude.chiefFor(w.project, "s2", w.env);
  verified("--chief", first);
  assert.equal(merge("s1"), undefined, "the owning chief merges");
  assert.match(merge("s2"), /^sage: the merge check refuses: T1 belongs to chief C1 \(claude\), not to C2\. Nothing changed\./, "a chief that never owned it");
  sage("gate", "replace", "T1", "--to", second, "--chief", second);
  sage("gate", "answer", "G1", "--option", "1");
  assert.equal(merge("s1"), "sage: the merge check refuses: T1 belongs to chief C2 (claude), not to C1. Nothing changed. Change only your own tasks. If C2 stopped, open a replace gate for the owner to answer: run sage gate replace T1 --to C1 --chief C1.", "the replaced chief");
  assert.equal(merge("s2"), undefined, "the new owning chief merges");
  for (const prompt of ["sage mode", "autopilot on"]) w.send({ hook_event_name: "UserPromptSubmit", prompt, session_id: undefined }); // the hook keeps its state as "unknown"
  const anonymous = w.denied(w.send({ hook_event_name: "PreToolUse", tool_name: "Bash", session_id: undefined, tool_input: { command: `gh pr merge 41 --squash --delete-branch --match-head-commit ${SHA}` } }));
  assert.match(anonymous ?? "", /^sage: the merge check refuses: the merge check refuses every merge, because sage has no session identity for this chief/, "F-T618-27: an event with no session id gets no pass on a shared logbook");
});

test("F-T618-26: an ended task of another chief on the same SHA never bars a live task's merge; a live one still does", (t) => {
  const w = world(t, claude, claude);
  const keep = (fields) => claude.keepReport(w.project, fields, w.env);
  const verified = (cli) => {
    cli("task", "add", "--title", "a", ...ADD);
    const id = `T${w.cells("tasks").trim().split("\n").length - 1}`;
    for (const kind of ["checks-pass", "review-clean", "qa-pass"]) cli(...backed(["verdict", id, "--sha", SHA, "--kind", kind, "--pr", "41"], { cli, keep }));
    return id;
  };
  const mine = verified(w.owner), theirs = verified(w.intruder);
  const check = (session) => claude.mergeCheck(SHA, w.env, { pr: "41", project: w.project, session });
  assert.match(check("session-b").reason, new RegExp(`${mine} belongs to chief C1 \\(claude\\), not to C2`), "a live task of another chief bars the merge");
  for (const state of ["merged", "concluded", "abandoned"]) {
    const [head, ...lines] = w.cells("tasks").split("\n"), at = head.split("\t").indexOf("state"); // as the PR script marks a task, or a later state
    writeFileSync(join(w.dir, "tasks.tsv"), [head, ...lines.map((l) => (l.startsWith(`${mine}\t`) ? l.split("\t").with(at, state).join("\t") : l))].join("\n"));
    assert.equal(row(w.cells("tasks"), mine).state, state);
    assert.doesNotMatch(check("session-b").reason, /belongs to chief/, `a ${state} task bars nothing`);
  }
  assert.ok(theirs);
});

test("the Claude hook names the chief on each transfer command, adds none to a gate answer, and keeps a late report of any role at the stop", (t) => {
  const w = hookWorld(t);
  const sage = (...args) => claude.sage([...args, "--project", w.project], w.env);
  sage("link", "--separate");
  for (const line of ["offer T1 --to C2", "cancel T1 --offer x", `accept T1 --offer x --version ${"0".repeat(64)}`, "release T1", "gate replace T1 --to C2", `claim T1 --version ${"0".repeat(64)}`]) {
    assert.match(w.bash(line), /add --chief C1 to this command/, line);
    assert.match(w.bash(`${line} --chief C7`), /this session is chief C1/, line);
  }
  w.send({ hook_event_name: "UserPromptSubmit", prompt: "sage mode" });
  const chief = claude.chiefFor(w.project, "s1", w.env);
  sage("task", "add", "--title", "a", ...ADD, "--chief", chief);
  sage("task", "T1", "set", "state=briefed", "--chief", chief);
  sage("task", "T1", "set", "state=building", "branch=sage/t1-a", "--chief", chief);
  sage("run", "add", "T1", "--role", "implementer", "--branch", "sage/t1-a", "--chief", chief);
  const start = { subagent_type: "sage:implementer", description: "build", prompt: "Run R1 · task T1 (build)\nGOAL a\nSCOPE b\nCONTEXT c\nDECISIONS d\nACCEPTANCE e\nVERIFY f\nBUDGET 1 hour of agent time\nFORBIDDEN g\nREPORT h\nSTANDING i", run_in_background: true };
  assert.equal(w.denied(w.send({ hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: start, tool_use_id: "start-1" })), undefined);
  w.send({ hook_event_name: "PostToolUse", tool_name: "Agent", tool_use_id: "start-1", tool_response: { status: "async_launched", agentId: "agent-1" } });
  w.send({ hook_event_name: "SubagentStart", agent_id: "agent-1", agent_type: "sage:implementer" });
  sage("run", "done", "R1", "--status", "failed", "--chief", chief);
  const text = "STATUS done\nRESULT done\nEVIDENCE e\nFINDINGS none\nQUESTIONS none\nNOT VERIFIED n\nBRANCH b";
  w.send({ hook_event_name: "SubagentStop", agent_id: "agent-1", agent_type: "sage:implementer", last_assistant_message: text, stop_hook_active: false });
  const kept = join(claude.storeDir(w.project, w.env), "kept", "R1.json");
  assert.equal(JSON.parse(readFileSync(kept, "utf8")).text, text, "the stop after the run's end keeps the report");
});

test("the Claude hook keeps a lead on its lead run in a shared logbook, and a helper writes nothing", (t) => {
  const w = hookWorld(t);
  const sage = (...args) => claude.sage([...args, "--project", w.project], w.env);
  sage("link", "--separate");
  w.send({ hook_event_name: "UserPromptSubmit", prompt: "sage mode" });
  const chief = claude.chiefFor(w.project, "s1", w.env);
  sage("task", "add", "--title", "a", ...ADD, "--chief", chief);
  sage("task", "T1", "set", "state=briefed", "--chief", chief);
  sage("run", "add", "T1", "--role", "lead", "--chief", chief);
  const start = { subagent_type: "sage:lead", name: "lead-T1", description: "lead-T1", prompt: "GOAL a\nSCOPE b\nCONTEXT c\nDECISIONS d\nACCEPTANCE e\nVERIFY f\nBUDGET 1 hour of agent time\nFORBIDDEN g\nREPORT h\nSTANDING i", run_in_background: true };
  assert.equal(w.denied(w.send({ hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: start, tool_use_id: "start-1" })), undefined);
  w.send({ hook_event_name: "PostToolUse", tool_name: "Agent", tool_use_id: "start-1", tool_response: { status: "async_launched", agentId: "lead-1" } });
  w.send({ hook_event_name: "SubagentStart", agent_id: "lead-1", agent_type: "sage:lead" });
  const lead = { agent_id: "lead-1", agent_type: "sage:lead" };
  assert.match(w.bash("task T1 set state=building", "s1", lead), /a lead's write names its lead run: add --lead R1, with no --chief/);
  assert.match(w.bash(`task T1 set state=building --lead R1 --chief ${chief}`, "s1", lead), /add --lead R1, with no --chief/);
  assert.match(w.bash("task T1 set state=building --lead R9", "s1", lead), /add --lead R1/);
  assert.match(w.bash("standing add order --lead R1", "s1", lead), /A lead writes the logbook only with .* on a shared logbook with --lead <its lead run>/, "F-T604-10: the lead form names the option");
  assert.equal(w.bash("task T1 set state=building --lead R1", "s1", lead), undefined);
  assert.match(w.bash("task T1 set state=building", "s1", { agent_id: "qa-1", agent_type: "sage:qa" }), /writes the logbook, or is not a read command/);
});

// T625 (PR 5b of the T306 shared logbook): each run of a shared logbook saves its checkout, and the review reads a branch
// in the checkout of the branch's writer run. A gone checkout refuses with its run's ID. A legacy logbook does not change.
const git = (...args) => execFileSync("git", args, { encoding: "utf8", env: gitEnv }).trim();
const header = (text) => text.split("\n")[0].split("\t");
/** Two clones of one project on one shared logbook: the implementer R1 runs in A, the code reviewer R2 in B. A's branch is one commit ahead of B's. */
function clones(t) {
  const w = world(t, codex, codex), a = realpathSync(w.project), b = join(w.base, "clone-b"), branch = "sage/t1-a";
  git("clone", "-q", a, b);
  codex.sage(["link", "--to", basename(w.dir), "--project", b], w.env);
  w.owner("task", "add", "--title", "a", ...ADD);
  w.owner("task", "T1", "set", "state=briefed");
  w.owner("task", "T1", "set", "state=building", `branch=${branch}`);
  const tip = git("-C", a, "commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "the implementer's work");
  git("-C", a, "update-ref", `refs/heads/${branch}`, tip);
  git("-C", b, "branch", branch);
  const behind = git("-C", b, "rev-parse", branch);
  const inB = (...args) => codex.sage([...args, "--project", b, "--chief", w.chief], w.env);
  w.owner("run", "add", "T1", "--role", "implementer", "--branch", branch);
  inB("run", "add", "T1", "--role", "code-reviewer", "--branch", branch);
  const capture = (run) => codex.captureReviewTarget({ project: b, task: "T1", run, role: "code-reviewer", cycle: 1 }, w.env);
  return { ...w, a, b, branch, tip, behind, inB, capture };
}
test("T625: after the first run add with a checkout, a sage of PR 5a refuses to write that shared logbook and says to update; its reads go on", async (t) => {
  const w = world(t, claude, codex);
  w.owner("task", "add", "--title", "a", ...ADD);
  w.owner("run", "add", "T1", "--role", "qa");
  // PR 5a's sage as a fixture: this plugin with the checkout column taken out.
  const plugin = join(w.base, "older");
  cpSync(at("../plugins/sage-codex"), plugin, { recursive: true });
  const state = join(plugin, "core/state.mjs"), source = readFileSync(state, "utf8");
  const older = source.replace("runs: [...PLAIN_TABLES.runs, CHIEF_COLUMN, CHECKOUT_COLUMN] };", "runs: [...PLAIN_TABLES.runs, CHIEF_COLUMN] };").replace("runs: [CHIEF_COLUMN, CHECKOUT_COLUMN], gates", "runs: [CHIEF_COLUMN], gates");
  assert.notEqual(older, source, "the fixture removes the column");
  writeFileSync(state, older);
  const { tool } = await import(pathToFileURL(join(plugin, "skills/sage/sage.mjs")).href);
  const run = (...args) => tool.sage([...args, "--project", w.project, "--chief", w.chief], w.env), before = w.tables();
  assert.throws(() => run("run", "add", "T1", "--role", "qa"), /runs\.tsv has columns that this version of sage does not know \(checkout\).*Update the sage plugin/);
  assert.equal(w.tables(), before, "nothing changed");
  assert.match(tool.sage(["task", "T1", "--project", w.project], w.env), /^T1 framed /);
  assert.match(tool.sage(["status", "--project", w.project], w.env), /tasks {3}1/);
});

/** A runs.tsv with one run's checkout cell set to another value, as a hand edit or an older sage leaves it. */
function setCheckout(w, id, value) {
  const [head, ...lines] = w.cells("runs").trimEnd().split("\n"), k = head.split("\t").indexOf("checkout");
  writeFileSync(join(w.dir, "runs.tsv"), [head, ...lines.map((line) => { const cells = line.split("\t"); if (cells[0] === id) cells[k] = value; return cells.join("\t"); })].join("\n") + "\n");
}

for (const [name, own, other] of pairs) {
  test(`T625 (${name}): a shared run add saves the main checkout, also from a linked worktree; a legacy logbook gets no checkout column`, (t) => {
    const w = world(t, own, other), main = realpathSync(w.project), linked = join(w.base, "linked");
    w.owner("task", "add", "--title", "a", ...ADD);
    w.owner("run", "add", "T1", "--role", "qa");
    git("-C", main, "worktree", "add", "-q", "-b", "linked", linked);
    own.sage(["run", "add", "T1", "--role", "code-reviewer", "--project", linked, "--chief", w.chief], w.env);
    assert.equal(header(w.cells("runs")).at(-1), "checkout");
    assert.equal(row(w.cells("runs"), "R1").checkout, main);
    assert.equal(row(w.cells("runs"), "R2").checkout, main, "the main checkout, not the worktree");
    const l = scratch(t), run = (...args) => own.sage([...args, "--project", l.project], l.env);
    run("init");
    run("task", "add", "--title", "a", ...ADD);
    const runs = join(own.storeDir(l.project, l.env), "runs.tsv"), before = header(readFileSync(runs, "utf8"));
    run("run", "add", "T1", "--role", "qa");
    assert.deepEqual(header(readFileSync(runs, "utf8")), before, "the header stays");
    assert.ok(!before.includes("checkout") && before.includes("model"));
    assert.equal(row(readFileSync(runs, "utf8"), "R1").checkout, undefined);
  });
}

test("T625: a native run add saves the checkout; a retry gives the same row; a receipt with a changed or relative checkout is damaged", (t) => {
  const w = world(t, codex, claude), main = realpathSync(w.project);
  w.owner("task", "add", "--title", "a", ...ADD);
  const input = { project: w.project, owner: "o", request: "00000000-0000-4000-8000-000000000625", task: "T1", role: "qa", branch: "", candidate: "" };
  const made = codex.createRequestedRun(input, w.env, "session-a");
  assert.equal(made.decision, "run-created");
  assert.equal(made.run.checkout, main);
  assert.equal(row(w.cells("runs"), "R1").checkout, main);
  assert.deepEqual(codex.createRequestedRun(input, w.env, "session-a"), { decision: "already-created", run: made.run });
  const folder = join(w.dir, "run-requests"), [file] = readdirSync(folder), receipt = join(folder, file), saved = readFileSync(receipt, "utf8");
  const tables = w.tables();
  // The receipt as the writer saves it: its value and the hash of the value, so only the checkout check can refuse it.
  for (const checkout of [join(w.base, "elsewhere"), "project"]) {
    const { value } = JSON.parse(saved);
    value.result.checkout = checkout;
    writeFileSync(receipt, JSON.stringify({ value, hash: createHash("sha256").update(JSON.stringify(value)).digest("hex") }) + "\n");
    assert.throws(() => codex.createRequestedRun(input, w.env, "session-a"), { message: "The saved run update is damaged. No run table changed." }, checkout);
  }
  assert.equal(w.tables(), tables);
});

test("T625: the review reads the branch in the checkout of its writer run, from another clone of the logbook too", (t) => {
  const w = clones(t);
  assert.equal(row(w.cells("runs"), "R1").checkout, w.a);
  assert.equal(row(w.cells("runs"), "R2").checkout, realpathSync(w.b));
  assert.notEqual(w.tip, w.behind);
  assert.deepEqual(w.capture("R2"), { branch: w.branch, sha: w.tip, round: 0, cycle: 1 });
  const target = codex.captureRunAssignment({ project: w.b, task: "T1", run: "R2", role: "code-reviewer" }, w.env);
  assert.deepEqual(codex.validateTerminalAssignment({ project: w.b, target, review: { branch: w.branch, sha: w.tip, round: 0, cycle: 1 } }, w.env), target);
});

// F-T625-6: a checkout that is now a plain file or an empty folder is gone too, with the same refusal, not a raw git error.
const LEAVE = { "missing": () => {}, "a plain file": (path) => writeFileSync(path, ""), "an empty folder": (path) => mkdirSync(path) };
for (const [form, leave] of Object.entries(LEAVE)) test(`T625: a gone checkout of the writer run (${form}) refuses each head read with the run's ID, and no table changes`, (t) => {
  const w = clones(t);
  const fields = { STATUS: "done", RESULT: "CLEAN", EVIDENCE: JSON.stringify({ commit: w.tip, round: 0, cycle: 1, summary: "s" }), FINDINGS: "[]", QUESTIONS: "none", "NOT VERIFIED": "x", BRANCH: w.branch };
  const text = Object.entries(fields).map(([key, value]) => `${key}: ${value}`).join("\n");
  const work = { project: w.b, task: "T1", run: "R2", role: "code-reviewer", assignment: "00000000-0000-4000-8000-000000000626", reportHash: createHash("sha256").update(text).digest("hex"), text };
  codex.finishReportedRun(work, w.env);
  w.inB("run", "add", "T1", "--role", "code-reviewer", "--branch", w.branch);
  const target = codex.captureRunAssignment({ project: w.b, task: "T1", run: "R3", role: "code-reviewer" }, w.env);
  // The clean cycle on A's tip, so that a move to verified reaches its head read.
  const cli = (...args) => w.owner(...args), keep = (fields) => codex.keepReport(w.project, fields, w.env);
  for (const kind of ["checks-pass", "review-clean", "qa-pass"]) cli(...backed(["verdict", "T1", "--sha", w.tip, "--kind", kind, "--cycle", "1"], { cli, keep }));
  w.owner("task", "T1", "set", "state=reviewing");
  w.owner("task", "T1", "set", "state=verifying");
  rmSync(w.a, { recursive: true, force: true });
  leave(w.a);
  const tables = w.tables(), gone = { message: `The checkout of R1 (project) is gone, so sage cannot read ${w.branch}. Nothing changed.` };
  assert.throws(() => w.capture("R3"), gone);
  assert.throws(() => codex.validateTerminalAssignment({ project: w.b, target, review: { branch: w.branch, sha: w.tip, round: 0, cycle: 1 } }, w.env), gone);
  assert.throws(() => codex.acceptReportedReview({ ...work, review: { sha: w.tip, branch: w.branch, round: 0, cycle: 1 } }, w.env, "session-a"), gone);
  const never = () => { throw Error("a refused readiness reaches no decision"); };
  const { version } = codex.readTaskSnapshot({ project: w.b, task: "T1" }, w.env);
  assert.throws(() => codex.updateRequestedTask({ project: w.b, owner: "o", request: "00000000-0000-4000-8000-000000000627", task: "T1", version, changes: { state: "verified" } }, w.env,
    { native: "session-a", decide: never, acknowledge: never, release: never, void: never, history: never }),
  (e) => e.code === "readiness-checkout" && e.message === "Readiness needs the checkout of the task branch's run, and that folder is gone. Start the run again from a live checkout before submitting a new request. IDs: R1.");
  assert.equal(w.tables(), tables);
});

// F-T625-1: the head read takes the newest writer run on the branch, by its number (R10 after R9), not the oldest.
test("T625: the review reads the branch in the checkout of the newest writer run, by run number", (t) => {
  const w = clones(t), done = (id) => w.owner("run", "done", id, "--status", "failed");
  done("R1");
  w.inB("run", "add", "T1", "--role", "implementer", "--branch", w.branch);
  assert.deepEqual(w.capture("R2"), { branch: w.branch, sha: w.behind, round: 0, cycle: 1 }, "R3 in B is newer than R1 in A");
  done("R3");
  for (let i = 4; i <= 8; i++) w.inB("run", "add", "T1", "--role", "qa");
  w.inB("run", "add", "T1", "--role", "implementer", "--branch", w.branch);
  done("R9");
  w.owner("run", "add", "T1", "--role", "implementer", "--branch", w.branch);
  assert.deepEqual([row(w.cells("runs"), "R9").checkout, row(w.cells("runs"), "R10").checkout], [realpathSync(w.b), w.a]);
  assert.deepEqual(w.capture("R2"), { branch: w.branch, sha: w.tip, round: 0, cycle: 1 }, "R10 in A is newer than R9 in B");
});

test("T625: a writer run with no checkout cell reads the branch in the command's own folder", (t) => {
  const w = clones(t);
  setCheckout(w, "R1", "");
  assert.equal(header(w.cells("runs")).at(-1), "checkout");
  assert.equal(row(w.cells("runs"), "R2").checkout, realpathSync(w.b));
  assert.deepEqual(w.capture("R2"), { branch: w.branch, sha: w.behind, round: 0, cycle: 1 }, "B's own branch");
});

test("T625: a writer run's checkout that is no bindings.tsv row of this logbook refuses before git reads it", (t) => {
  const w = clones(t), planted = join(w.base, "planted"), fake = join(w.base, "fake-git"), calls = join(w.base, "git-calls");
  git("init", "-q", "-b", "main", planted);
  git("-C", planted, "commit", "-q", "--allow-empty", "-m", "planted");
  git("-C", planted, "branch", w.branch);
  setCheckout(w, "R1", planted);
  // A git first on PATH that notes each call's arguments, then runs the real git: so the test sees whether git read the planted folder.
  mkdirSync(fake);
  writeFileSync(join(fake, "git"), `#!${process.execPath}\nconst { appendFileSync } = require("node:fs"), { spawnSync } = require("node:child_process");\nappendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + "\\n");\nconst path = process.env.PATH.split(":").filter((dir) => dir !== ${JSON.stringify(fake)}).join(":");\nprocess.exit(spawnSync("git", process.argv.slice(2), { stdio: "inherit", env: { ...process.env, PATH: path } }).status ?? 1);\n`, { mode: 0o755 });
  const env = { ...w.env, PATH: `${fake}:${w.env.PATH}` }, tables = w.tables();
  assert.throws(() => codex.captureReviewTarget({ project: w.b, task: "T1", run: "R2", role: "code-reviewer", cycle: 1 }, env),
    { message: `The checkout of R1 is not a checkout of this logbook in bindings.tsv, so sage cannot read ${w.branch}. Nothing changed.` });
  assert.equal(existsSync(calls), false, "git never ran");
  assert.equal(w.tables(), tables);
  // The same read with the writer's own checkout runs the fake git there: so the fake is what the state tool calls.
  setCheckout(w, "R1", w.a);
  assert.equal(codex.captureReviewTarget({ project: w.b, task: "T1", run: "R2", role: "code-reviewer", cycle: 1 }, env).sha, w.tip);
  assert.match(readFileSync(calls, "utf8"), new RegExp(`"-C","${w.a}","rev-parse"`));
});

test("T634: the Claude hook reads a review's branch tip in the checkout of the writer run from another clone, and none when that checkout is gone", (t) => {
  const w = hookWorld(t), a = realpathSync(w.project), b = join(w.base, "clone-b"), branch = "sage/t1-a";
  const sage = (...args) => claude.sage(args, w.env);
  sage("link", "--separate", "--project", a);
  git("clone", "-q", a, b);
  sage("link", "--to", basename(claude.storeDir(a, w.env)), "--project", b);
  w.send({ hook_event_name: "UserPromptSubmit", prompt: "sage mode", cwd: b });
  const chief = claude.chiefFor(b, "s1", w.env), inB = (...args) => sage(...args, "--project", b, "--chief", chief);
  inB("task", "add", "--title", "a", ...ADD);
  inB("task", "T1", "set", "state=briefed");
  inB("task", "T1", "set", "state=building", `branch=${branch}`);
  const tip = git("-C", a, "commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "the implementer's work");
  git("-C", a, "update-ref", `refs/heads/${branch}`, tip);
  git("-C", b, "branch", branch);
  sage("run", "add", "T1", "--role", "implementer", "--branch", branch, "--project", a, "--chief", chief);
  inB("run", "add", "T1", "--role", "code-reviewer", "--branch", branch);
  inB("run", "add", "T1", "--role", "code-reviewer", "--branch", branch);
  // The main session starts each review in B; its stop keeps the report with the tip that the hook read at the start, when the branch did not move.
  const start = (run) => {
    const brief = { subagent_type: "sage:code-reviewer", description: "review", prompt: `Run ${run} · task T1 (review)\nGOAL a\nSCOPE b\nCONTEXT c\nDECISIONS d\nACCEPTANCE e\nVERIFY f\nBUDGET 1 hour of agent time\nFORBIDDEN g\nREPORT h\nSTANDING i`, run_in_background: true };
    assert.equal(w.denied(w.send({ hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: brief, tool_use_id: `start-${run}`, cwd: b })), undefined);
    w.send({ hook_event_name: "PostToolUse", tool_name: "Agent", tool_use_id: `start-${run}`, tool_response: { status: "async_launched", agentId: `agent-${run}` }, cwd: b });
    w.send({ hook_event_name: "SubagentStart", agent_id: `agent-${run}`, agent_type: "sage:code-reviewer", cwd: b });
  };
  const text = `STATUS done\nRESULT CLEAN\nEVIDENCE e\nFINDINGS none\nQUESTIONS none\nNOT VERIFIED n\nBRANCH ${branch} head ${tip}`;
  const stop = (run) => {
    w.send({ hook_event_name: "SubagentStop", agent_id: `agent-${run}`, agent_type: "sage:code-reviewer", last_assistant_message: text, stop_hook_active: false, cwd: b });
    return JSON.parse(readFileSync(join(claude.storeDir(b, w.env), "kept", `${run}.json`), "utf8")).sha;
  };
  start("R2");
  start("R3");
  assert.equal(stop("R2"), tip, "A's tip, not B's own branch");
  rmSync(a, { recursive: true, force: true });
  assert.equal(stop("R3"), "", "a gone checkout gives no tip");
});
