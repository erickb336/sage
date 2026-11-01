// The chiefs of a shared logbook and the one guard (T604): each writer class and each command of the design's table.
// Each shared case runs twice: a Claude chief against a Codex chief, then the other way, so both providers give one result.
import "./test-env.mjs";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { shellCommands } from "../plugins/sage/core/command-reader.mjs";
import * as claude from "../plugins/sage/skills/sage/sage.mjs";
import { tool as codex } from "../plugins/sage-codex/skills/sage/sage.mjs";

const at = (path) => fileURLToPath(new URL(path, import.meta.url));
const LAUNCHER = [at("../plugins/sage/hooks/launcher.mjs"), "sage-hook.mjs"], TOOL = at("../plugins/sage/skills/sage/sage.mjs");
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
      assert.throws(() => w.intruder(...args), new RegExp(`^Error: T1 belongs to chief C1 \\(${provider}\\), not to C2\\. Nothing changed\\. Change only your own tasks\\. If C1 stopped, ask the owner\\.$`), args.join(" "));
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
      ["projects", "rebuild", "--accept-listing", "yes"], ["init"], ["pages", "T1", "record", page], ["observe", "T1", "--kind", "completion"], ["run", "usage", "R1", "--tokens", "5", "--usage-source", "s", "--usage-evidence", "e"], ["logbook", "repair", "--accept-loss", "programs"]];
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
    w.owner("run", "done", "R1", "--status", "failed");
    assert.throws(() => w.lead("R1", "task", "T1", "set", "title=x"), /R1 is not a running lead run, so this lead writes nothing/, "a lead whose run ended writes nothing");
  });

  test(`${name}: a task with no owning chief takes a claim at its current version, once; a write before it names the claim`, (t) => {
    const w = world(t, own, other);
    w.owner("task", "add", "--title", "a", ...ADD);
    writeFileSync(join(w.dir, "tasks.tsv"), w.cells("tasks").replace(/\tC1\n/, "\t\n")); // as a moved task starts
    const [, version] = (() => { try { w.intruder("task", "T1", "set", "title=x"); } catch (e) { return /--version ([0-9a-f]{64}) --chief C2/.exec(e.message); } return []; })();
    assert.match(version, /^[0-9a-f]{64}$/, "the refusal names the claim that works");
    assert.throws(() => w.intruder("task", "T1", "set", "title=x"), new RegExp(`Claim it first: call the claim tool with this task and version ${version}, or run sage claim T1 --version ${version} --chief C2\\.`), "F-T604-11: each provider has a form that works");
    assert.throws(() => w.intruder("claim", "T1", "--version", "0".repeat(64)), /T1 changed, so this claim is out of date/);
    assert.throws(() => w.nobody("claim", "T1", "--version", version), NO_CHIEF);
    assert.equal(w.intruder("claim", "T1", "--version", version), "T1 claimed · chief C2");
    assert.equal(row(w.cells("tasks"), "T1").chief, "C2");
    assert.match(w.cells("decisions"), /T1 claimed by C2/);
    assert.throws(() => w.owner("claim", "T1", "--version", version), /T1 belongs to chief C2, so it takes no claim/, "a competing claim");
    assert.throws(() => w.owner("task", "T1", "set", "title=y"), /T1 belongs to chief C2/);
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
      assert.throws(() => w.intruder(...words(line)), /^Error: T1 belongs to chief C1 .* Change only your own tasks\. If C1 stopped, ask the owner\.$/, line);
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
  const owned = "T1 belongs to chief C1 (codex), not to C4. Nothing changed. Change only your own tasks. If C1 stopped, ask the owner.";
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

test("F-T604-4, F-T604-12: a native update of a task with no owning chief gives the guard's words, with the version to claim", (t) => {
  const w = world(t, codex, claude);
  w.owner("task", "add", "--title", "a", ...ADD);
  writeFileSync(join(w.dir, "tasks.tsv"), w.cells("tasks").replace(/\tC1\n/, "\t\n"));
  const { version } = codex.readTaskSnapshot({ project: w.project, task: "T1" }, w.env);
  const never = () => { throw Error("an update of a task with no owning chief reaches no decision"); };
  const update = { project: w.project, owner: "o", request: "00000000-0000-4000-8000-000000000609", task: "T1", version, changes: { title: "b" } };
  assert.throws(() => codex.updateRequestedTask(update, w.env, { native: "session-a", decide: never, acknowledge: never, release: never, void: never, history: never }),
    (e) => e.code === "other-chief" && e.message.startsWith(`T1 has no owning chief, so C1 cannot change it. Claim it first: call the claim tool with this task and version ${version}`));
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
  const older = source.replace(", tasks: [...PLAIN_TABLES.tasks, CHIEF_COLUMN], runs: [...PLAIN_TABLES.runs, CHIEF_COLUMN] };", " };");
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
  const env = { ...w.env, SAGE_HOOKS_STATE: join(w.base, "hooks") };
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
