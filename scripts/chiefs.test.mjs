import "./test-env.mjs";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { shellCommands } from "../plugins/sage/core/command-reader.mjs";
import { landingRule } from "../plugins/sage/core/board-view.mjs";
import { chiefOnly, writerClass } from "../plugins/sage/core/chiefs.mjs";
import { RENAME_WHY } from "../plugins/sage/core/milestone-rules.mjs";
import * as claude from "../plugins/sage/skills/sage/sage.mjs";
import { tool as codex } from "../plugins/sage-codex/skills/sage/sage.mjs";
import { modeDirectory, stateKey } from "../plugins/sage-codex/hooks/hook-state.mjs";
import { backed, reportFor } from "./verdict-backing.mjs";

const at = (path) => fileURLToPath(new URL(path, import.meta.url));
const LAUNCHER = [at("../plugins/sage/hooks/launcher.mjs"), "sage-hook.mjs"], TOOL = at("../plugins/sage/skills/sage/sage.mjs"), CODEX_TOOL = at("../plugins/sage-codex/skills/sage/sage.mjs");
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
  const tables = () => ["tasks", "runs", "findings", "gates", "ledger", "milestones", "decisions"].map(cells).join("\f");
  return { ...w, dir, chief, rival, owner, intruder, nobody, lead, cells, tables };
}
function row(text, id) {
  const [head, ...lines] = text.trim().split("\n"), cols = head.split("\t");
  return Object.fromEntries(cols.map((c, k) => [c, lines.map((l) => l.split("\t")).find((l) => l[0] === id)?.[k]]));
}
function versionOf(project, env, id) {
  const { offer, ...task } = codex.read(codex.storeDir(project, env), "tasks").find((r) => r.id === id);
  return createHash("sha256").update(JSON.stringify(offer ? { ...task, offer } : task)).digest("hex");
}
function setCells(dir, table, match, column, value) {
  const file = join(dir, `${table}.tsv`), [head, ...lines] = readFileSync(file, "utf8").split("\n"), k = head.split("\t").indexOf(column);
  writeFileSync(file, [head, ...lines.map((l) => (l && match(l) ? l.split("\t").with(k, value).join("\t") : l))].join("\n"));
}
const pairs = [["Claude", claude, codex], ["Codex", codex, claude]];
const asked = (from, to, title, runs, offered = false) => `Hand T1 from C1 (${from}) to C2 (${to})? Runs that end as failed: ${runs}. Approve: C2 owns T1.${runs === "none" ? "" : " Each of those runs ends as failed, and work that it did not report may be lost."} C1 can no longer write T1. The answer clears an open offer. The branch keeps its name. ${to === "claude" && from !== "claude" ? "The verdicts stay, and C2 runs one fresh cycle on its head before it merges." : "The verdicts on its head still count."} Decline: ${offered ? "C1 stays the owning chief, and the offer to C2 ends" : "nothing changes, and C1 stays the owning chief"}. Title of T1: ${title}`;
const next = (gate) => `\nAsk the owner to answer ${gate}, in either chat. Nothing changes until then.`;
const owned = (w, name, ...args) => spawnSync(process.execPath, [name === "Claude" ? TOOL : CODEX_TOOL, ...args], { cwd: w.base, env: w.env, encoding: "utf8", timeout: 60_000 });
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

test("T995 F4: every command of the state tool is a read or has a writer class, also the old words program and release <T>, and the release level (T1003)", () => {
  let listed;
  try { claude.sage(["no-such-command"]); } catch (error) { listed = /Commands: (.*)$/.exec(error.message)[1].split(", "); }
  const READS = ["status", "stats", "merge-check", "board", "link", "worktrees", "message"];
  const WRITES = {
    init: [[]], logbook: [["repair"]], standing: [["add"]], pages: [["T1", "record"]], task: [["add"], ["T1", "set"]], "task-adopt": [["T1"]],
    milestone: [["propose"], ["M1", "set"]], release: [["add"], ["T1"]], round: [["T1"]], run: [["add", "T1"], ["done", "R1"], ["usage", "R1"]], finding: [["add", "T1"], ["triage", "T1"], ["close", "T1"], ["move", "T1"]],
    verdict: [["T1"]], lint: [["T1"]], gate: [["add"], ["add", "T1"], ["answer", "G1"], ["replace", "T1"]], log: [["T1"], ["-"]], config: [["max_rounds=3"]], projects: [["rebuild"]],
    observe: [["T1"]], claim: [["T1"]], offer: [["T1"]], cancel: [["T1"]], accept: [["T1"]], unclaim: [["T1"]], move: [[]], chief: [["name", "C1"]],
  };
  assert.deepEqual([...READS, ...Object.keys(WRITES)].sort(), [...listed].sort(), "each listed command is a read or has its write forms here");
  for (const [cmd, forms] of Object.entries({ ...WRITES, program: [["propose"], ["M1", "set"]] })) for (const pos of forms) assert.notEqual(writerClass(cmd, pos).kind, "read", `${cmd} ${pos.join(" ")}`);
  assert.deepEqual([writerClass("program", ["propose"]), writerClass("release", ["T1"])], [writerClass("milestone", ["propose"]), writerClass("unclaim", ["T1"])], "an old word has the class of its new word");
  assert.deepEqual([writerClass("release", ["add"]).kind, writerClass("milestone", ["M1", "set"]).kind], ["any", "any"]);
  assert.deepEqual([chiefOnly("release", ["T1"]), chiefOnly("release", ["add"])], [true, false]);
});

test("a legacy project has no chief: no chiefs.tsv, no chief column, and no option or claim", (t) => {
  const w = scratch(t);
  const run = (...args) => codex.sage([...args, "--project", w.project], w.env);
  run("init");
  run("task", "add", "--title", "a", ...ADD);
  run("run", "add", "T1", "--role", "qa");
  const dir = codex.storeDir(w.project, w.env), [head] = readFileSync(join(dir, "tasks.tsv"), "utf8").split("\n");
  assert.equal(head, "id\ttitle\tsize\trisk\troute\tstate\tbranch\tpr\tround\tkeys\thold\textra\tpriority\tkind\twaits\tmilestone\tadoption\tapprovals");
  assert.equal(readFileSync(join(dir, "runs.tsv"), "utf8").split("\n")[0].endsWith("\tusage_evidence"), true);
  assert.equal(existsSync(join(dir, "chiefs.tsv")), false);
  assert.equal(codex.chiefFor(w.project, "session-a", w.env), undefined);
  assert.deepEqual(codex.actorOptions(w.project, ["task", "add"], { native: "session-a" }, w.env), []);
  for (const args of [["status", "--chief", "C1"], ["task", "T1", "set", "title=b", "--chief", "C1"], ["status", "--lead", "R1"], ["claim", "T1", "--version", "0".repeat(64)]]) {
    assert.throws(() => run(...args), /only a shared logbook has chiefs/);
  }
});

test("F-T604-8: a legacy project refuses --chief and --lead also on the commands that return before they open a logbook, and makes no row", (t) => {
  const w = scratch(t);
  const run = (...args) => claude.sage([...args, "--project", w.project], w.env);
  run("init");
  for (const args of [["config", "--chief", "C1"], ["config", "max_rounds=4", "--lead", "R1"], ["link", "--separate", "--chief", "C1"], ["projects", "rebuild", "--accept-listing", "yes", "--lead", "R1"],
    ["board", "--chief", "C1"], ["board", "--view", "chat", "--lead", "R1"], ["merge-check", "--sha", SHA, "--chief", "C1"]]) {
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
  for (const args of [["offer", "T1", "--to", "C2"], ["cancel", "T1", "--offer", "x"], ["accept", "T1", "--offer", "x", "--version", "0".repeat(64)], ["unclaim", "T1"], ["release", "T1"], ["gate", "replace", "T1", "--to", "C2"]]) {
    assert.throws(() => run(...args), /has no shared logbook, so it has no chiefs to hand a task to\. Nothing changed\.$/, args.join(" "));
  }
  assert.throws(() => run("claim", "T1", "--version", "0".repeat(64)), /only a shared logbook has chiefs: leave out --chief and --lead, and a task here needs no claim/);
  assert.equal(["tasks", "gates"].map((table) => readFileSync(join(dir, `${table}.tsv`), "utf8")).join("\f"), before);
  assert.equal(before.split("\f")[1].split("\n")[0], "id\ttask\tquestion\toptions\trecommendation\tdefault\tanswer\tat", "a legacy gates table has no kind column");
});

test("T970 F3: a legacy run that ended as failed keeps its late report, as in a shared logbook; a done run keeps none", (t) => {
  const w = scratch(t);
  const run = (...args) => claude.sage([...args, "--project", w.project], w.env);
  run("init");
  run("task", "add", "--title", "a", ...ADD);
  run("run", "add", "T1", "--role", "qa");
  run("run", "add", "T1", "--role", "pe");
  run("run", "done", "R1", "--status", "failed");
  run("run", "done", "R2", "--status", "done");
  const file = claude.keepReport(w.project, { task: "T1", run: "R1", role: "qa", text: "late" }, w.env);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).text, "late");
  assert.match(run("task", "T1"), new RegExp(`\\nR1 failed · report kept \\S+ · backs no verdict · ${file}$`), "the chief reads it from the task line");
  assert.throws(() => claude.keepReport(w.project, { task: "T1", run: "R2", role: "pe", text: "late" }, w.env), /R2 ended as done before this stop, so no report is kept/);
});

for (const [name, own, other] of pairs) {
  test(`${name}: T970: on a shared logbook the state tool's guard holds a lead by the gap rule (its run of the role, the run's end, its state move and its round), also for a late report of a failed run, until a row with the run, whoever adds it`, (t) => {
    const w = world(t, own, other);
    w.owner("task", "add", "--title", "a", ...ADD);
    w.owner("task", "T1", "set", "state=briefed");
    w.owner("run", "add", "T1", "--role", "lead");
    w.lead("R1", "task", "T1", "set", "state=building");
    w.lead("R1", "task", "T1", "set", "state=reviewing");
    const id = (line) => line.split(" ")[0], review = id(w.lead("R1", "run", "add", "T1", "--role", "code-reviewer"));
    const keep = (run, role, kind, findings) => own.keepReport(w.project, { task: "T1", run, role, sha: SHA, text: reportFor(kind, { findings }) }, w.env);
    keep(review, "code-reviewer", "findings", "\n- K2 low b.js:2 a typo\n- K1 medium a.js:1 a bad value");
    const gap = (run, role, key) => `${run}'s ${role} report has a medium or high finding with no row on T1: K1 (${key}). Record each one first with finding add, one row for each key: task T1, source ${role}, severity ${key} or above, run ${run}, its class and a summary. Nothing changed.`;
    const held = [["run", "add", "T1", "--role", "code-reviewer"], ["run", "done", review, "--status", "done", "--tokens", "1"], ["task", "T1", "set", "state=verifying"], ["round", "T1"]];
    const before = w.tables();
    for (const words of held) assert.throws(() => w.lead("R1", ...words), { message: gap(review, "code-reviewer", "medium") }, words.join(" "));
    assert.equal(w.tables(), before, "nothing changed");
    w.owner("finding", "add", "T1", "--source", "code-reviewer", "--severity", "medium", "--summary", "a bad value", "--run", review, "--class", "other");
    w.owner("task", "add", "--title", "b", ...ADD);
    w.owner("finding", "move", "T1", "F-T1-1", "--into", "T2");
    assert.equal(w.lead("R1", ...held[1]), `${review} done`, "a row moved into an open task still holds the finding");
    const qa = id(w.lead("R1", "run", "add", "T1", "--role", "qa"));
    w.owner("run", "done", qa, "--status", "failed");
    keep(qa, "qa", "qa-fail", "\n- K1 high a.js:1 a crash");
    assert.throws(() => w.lead("R1", "round", "T1"), { message: gap(qa, "qa", "high") });
    w.lead("R1", "finding", "add", "T1", "--source", "qa", "--severity", "high", "--summary", "a crash", "--run", qa, "--class", "other");
    for (const words of [held[0], ["run", "add", "T1", "--role", "qa"]]) assert.match(w.lead("R1", ...words), /^R\d+ running · /, words.join(" "));
  });

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
      ["gate", "add", "T1", "--question", "q?", "--options", "a|b", "--recommend", "a"], ["log", "T1", "a decision", "--why", "w"], ["milestone", "propose", "--name", "n", "--goal", "g", "--pilot", "T1", "--tasks", "none"]];
    const provider = name === "Claude" ? "claude" : "codex";
    for (const args of writes) {
      const before = w.tables();
      assert.throws(() => w.intruder(...args), { message: `T1 belongs to chief C1 (${provider}), not to C2. Nothing changed. Change only your own tasks. To take T1, ask C1 to offer it to you, or open a takeover gate for the owner to answer: ${name === "Claude" ? "call the gate_replace tool with this task and to C2" : "run sage gate replace T1 --to C2 --chief C2"}.` }, args.join(" "));
      assert.throws(() => w.nobody(...args), NO_CHIEF, args.join(" "));
      assert.equal(w.tables(), before, args.join(" "));
    }
    for (const args of writes) {
      try { w.owner(...args); } catch (e) { assert.doesNotMatch(e.message, /belongs to|no chief/, args.join(" ")); }
    }
  });

  test(`${name}: a milestone proposed again checks each task of the milestone, also with no --pilot and no --tasks`, (t) => {
    const w = world(t, own, other);
    w.owner("task", "add", "--title", "a", ...ADD);
    w.intruder("task", "add", "--title", "b", ...ADD);
    assert.throws(() => w.owner("milestone", "propose", "--name", "n", "--goal", "g", "--pilot", "T1", "--tasks", "T2"), /T2 belongs to chief C2/);
    w.owner("milestone", "propose", "--name", "n", "--goal", "g", "--pilot", "T1", "--tasks", "none");
    assert.throws(() => w.intruder("milestone", "propose", "M1"), /T1 belongs to chief C1/);
  });

  test(`${name}: F-T995-25: a milestone proposed again by its old program id, with either old word, checks the same tasks; so does a new pilot, for each task that leaves`, (t) => {
    const w = world(t, own, other);
    w.owner("task", "add", "--title", "a", ...ADD);
    w.owner("task", "add", "--title", "b", ...ADD);
    w.owner("milestone", "propose", "--name", "n", "--goal", "g", "--pilot", "T1", "--tasks", "T2");
    own.sage(["gate", "answer", "G1", "--option", "1", "--project", w.project], w.env);
    w.intruder("task", "add", "--title", "c", ...ADD);
    const file = join(w.dir, "decisions.tsv"), cols = readFileSync(file, "utf8").split("\n")[0].split("\t");
    writeFileSync(file, readFileSync(file, "utf8") + cols.map((c) => ({ at: "2026-11-11T00:00:00Z", decision: "M1 was PG1", why: RENAME_WHY })[c] ?? "").join("\t") + "\n");
    const before = w.tables();
    for (const args of [["milestone", "propose", "PG1"], ["program", "propose", "PG1"], ["milestone", "propose", "PG1", "--tasks", "T3"], ["program", "propose", "PG1", "--pilot", "T3", "--tasks", "none"],
      ["milestone", "propose", "M1", "--pilot", "T3", "--tasks", "none"], ["milestone", "propose", "M1", "--tasks", "T3"]]) {
      assert.throws(() => w.intruder(...args), /T[12] belongs to chief C1 /, args.join(" "));
    }
    assert.equal(w.tables(), before, "nothing changed");
    assert.match(w.owner("program", "propose", "PG1", "--goal", "g2"), /^M1 proposed \(round 2\) /);
  });

  for (const [ended, chief] of [["merged", ""], ["concluded", "C2"], ["abandoned", ""], ["abandoned", "C2"]]) {
    const whose = chief ? "of another chief" : "with no owning chief";
    for (const [id, args] of [["T2", ["--tasks", "T3,T4"]], ["T2", ["--pilot", "T3", "--tasks", "T4"]], ["T1", ["--pilot", "T3", "--tasks", "T4"]]]) {
      test(`${name}: F-T995-31: the owning chief proposes its milestone again (${args.join(" ")}) while it holds ${id === "T1" ? "an old pilot" : "a task"} that is ${ended}, ${whose}`, (t) => {
        const w = world(t, own, other);
        for (const title of ["a", "b", "c", "d"]) w.owner("task", "add", "--title", title, ...ADD);
        w.owner("milestone", "propose", "--name", "n", "--goal", "g", "--pilot", "T1", "--tasks", "T2,T3");
        own.sage(["gate", "answer", "G1", "--option", "1", "--project", w.project], w.env);
        setCells(w.dir, "tasks", (l) => l.startsWith(`${id}\t`), "state", ended);
        setCells(w.dir, "tasks", (l) => l.startsWith(`${id}\t`), "chief", chief);
        assert.match(w.owner("milestone", "propose", "M1", ...args), /^M1 proposed \(round 2\) /);
        assert.equal(row(w.cells("tasks"), id).milestone, "M1", `${id} stays in M1 as history`);
        setCells(w.dir, "tasks", (l) => l.startsWith("T4\t"), "chief", "C2");
        const before = w.tables();
        assert.throws(() => w.owner("milestone", "propose", "M1", ...args), /T4 belongs to chief C2 /);
        assert.equal(w.tables(), before, "nothing changed");
      });
    }
  }

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
    for (const args of [["status"], ["stats"], ["task", "T1"], ["logbook"], ["standing"], ["pages", "T1"], ["config"], ["merge-check", "--sha", SHA, "--pr", "1"], ["board", "--view", "chat"]]) {
      try { w.nobody(...args); } catch (e) { assert.doesNotMatch(e.message, /no chief|belongs to/, args.join(" ")); }
    }
    assert.match(other.sage(["gate", "answer", "G1", "--option", "1", "--project", w.project], w.env), /^G1 answered/);
    assert.deepEqual(own.actorOptions(w.project, ["gate", "answer", "G1"], { native: "session-a" }, w.env), [`--chief=${w.chief}`], "a gate answer names the chief that applies it");
    assert.deepEqual(own.actorOptions(w.project, ["gate", "answer", "G1"], { native: "session-new" }, w.env), [], "a session that is no chief here answers as the owner");
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
    assert.match(w.owner("task", "add", "--title", "c", ...ADD), /^T2 framed .* · chief C1$/, "the lost T1 keeps its id: its task-added decision row holds it");
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
    w.owner("run", "add", "T1", "--role", "lead");
    w.owner("run", "add", "T2", "--role", "qa");
    assert.match(w.lead("R1", "task", "T1", "set", "state=building"), /^T1 building/);
    assert.match(w.lead("R1", "run", "add", "T1", "--role", "qa"), /^R3 running/);
    assert.equal(row(w.cells("runs"), "R3").chief, "C1", "the lead's run names its chief");
    const acts = (id) => ({ message: `${id} is not of T1, and a lead records only its own task. Report to your chief what ${id} needs. Nothing changed.` });
    assert.throws(() => w.lead("R1", "task", "T2", "set", "state=building"), acts("T2"));
    assert.throws(() => w.lead("R1", "task", "T3", "set", "state=building"), acts("T3"));
    assert.throws(() => w.lead("R1", "run", "done", "R2", "--status", "failed"), acts("R2"));
    assert.throws(() => w.lead("R1", "task", "add", "--title", "d", ...ADD), /"task add" is not on a lead's list\./);
    assert.throws(() => w.lead("R1", "standing", "add", "an order"), /"standing add" is not on a lead's list\./);
    assert.throws(() => w.lead("R2", "task", "T2", "set", "title=x"), /R2 is not a running lead run/, "another role is no lead");
    assert.throws(() => own.sage(["task", "T1", "set", "title=x", "--project", w.project, "--lead", "R1", "--chief", "C1"], w.env), /takes --chief or --lead, not both/);
    const tasks = w.cells("tasks");
    writeFileSync(join(w.dir, "tasks.tsv"), tasks.replace(/^(T1\t.*)\tC1$/m, "$1\tC2"));
    assert.throws(() => w.lead("R1", "round", "T1"), { message: `T1 belongs to chief C2 (${name === "Claude" ? "codex" : "claude"}), not to C1. Nothing changed. Report this to your chief: a lead writes only while its chief owns the task.` }, "F-T604-27: a lead opens no gate");
    writeFileSync(join(w.dir, "tasks.tsv"), tasks.replace(/^(T1\t.*)\tC1$/m, "$1\t"));
    assert.throws(() => w.lead("R1", "round", "T1"), { message: "T1 has no owning chief, so C1 cannot change it. Nothing changed. Report this to your chief: a lead writes only while its chief owns the task." }, "F-T604-27: a lead claims nothing");
    writeFileSync(join(w.dir, "tasks.tsv"), tasks);
    w.owner("run", "done", "R1", "--status", "failed");
    assert.throws(() => w.lead("R1", "task", "T1", "set", "title=x"), /R1 is not a running lead run, so this lead writes nothing/, "a lead whose run ended writes nothing");
  });

  test(`${name}: a task with no owning chief takes a claim at its current version, once; a write before it names the claim`, (t) => {
    const w = world(t, own, other);
    w.owner("task", "add", "--title", "a", ...ADD);
    writeFileSync(join(w.dir, "tasks.tsv"), w.cells("tasks").replace(/\tC1\n/, "\t\n"));
    const version = versionOf(w.project, w.env, "T1");
    const step = name === "Claude" ? `call the claim tool with this task and version ${version}` : `run sage claim T1 --version ${version} --chief C2`;
    assert.throws(() => w.intruder("task", "T1", "set", "title=x"), { message: `T1 has no owning chief, so C2 cannot change it. Claim it first: ${step}. Nothing changed.` }, "F-T604-21: the reader of each provider gets only the form that it can use");
    assert.throws(() => w.intruder("claim", "T1", "--version", "0".repeat(64)), /T1 changed, so this claim is out of date/);
    assert.throws(() => w.nobody("claim", "T1", "--version", version), NO_CHIEF);
    assert.equal(w.intruder("claim", "T1", "--version", version), "T1 claimed · chief C2");
    assert.equal(row(w.cells("tasks"), "T1").chief, "C2");
    assert.match(w.cells("decisions"), /T1 claimed by C2/);
    assert.throws(() => w.owner("claim", "T1", "--version", version), /T1 belongs to chief C2, so it takes no claim/, "a competing claim");
    assert.throws(() => w.owner("task", "T1", "set", "title=y"), /T1 belongs to chief C2/);
  });

  const transfer = (t) => {
    const w = world(t, own, other);
    w.owner("task", "add", "--title", "a", ...ADD);
    const version = () => versionOf(w.project, w.env, "T1");
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
    const other2 = versionOf(w.project, w.env, "T2");
    w.owner("offer", "T1", "--to", "C2");
    assert.throws(() => w.owner("offer", "T1", "--to", "C2"), /T1 has the open offer [0-9a-f]{8} to C2: cancel it first/);
    assert.equal(versionOf(w.project, w.env, "T2"), other2);
  });

  test(`${name}: accept: only the named recipient, with the exact offer and the current version, while no run is active; it opens a takeover gate, and only the owner's answer sets the chief and clears the offer`, (t) => {
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
    const question = name === "Claude" ? asked("claude", "codex", "a", "none", true) : asked("codex", "claude", "a", "none", true);
    assert.equal(w.intruder("accept", "T1", "--offer", id, "--version", version), `G1 open · ${question}${next("G1")}`, "T656: accept asks the owner");
    assert.deepEqual([row(w.cells("tasks"), "T1").chief, w.offer().id, row(w.cells("gates"), "G1").kind, row(w.cells("gates"), "G1").options], ["C1", id, "replace", "approve|decline"], "the gate alone changes no chief and keeps the offer");
    const gates = w.cells("gates");
    assert.equal(w.intruder("accept", "T1", "--offer", id, "--version", version), `G1 is open already · ${question}${next("G1")}`);
    assert.equal(w.cells("gates"), gates);
    assert.throws(() => w.intruder("task", "T1", "set", "title=x"), /T1 belongs to chief C1/, "the recipient writes nothing before the answer");
    assert.equal(w.answer("G1", "--option", "1"), "G1 answered · approve · T1 chief C2");
    assert.equal(row(w.cells("tasks"), "T1").chief, "C2");
    assert.ok(!row(w.cells("tasks"), "T1").offer);
    assert.ok(w.cells("decisions").includes(`${question} → approve`));
    assert.throws(() => w.owner("task", "T1", "set", "title=x"), /T1 belongs to chief C2/, "the old chief writes nothing");
    assert.throws(() => w.intruder("accept", "T1", "--offer", id, "--version", version), /T1 has no open offer .* Read T1 for its open offer\. If it has none, ask its owning chief for a new offer\.$/, "an accepted offer is gone");
    assert.match(w.intruder("task", "T1", "set", "title=x"), /^T1 framed/);
  });

  test(`T656 ${name}: the owner's decline of the gate of an accept keeps the task with its chief and ends the offer, in one write with a decision row (F-T656-28)`, (t) => {
    const w = transfer(t);
    w.owner("offer", "T1", "--to", "C2");
    const { id } = w.offer(), version = w.version();
    const opened = w.intruder("accept", "T1", "--offer", id, "--version", version);
    const [runs, decisions] = [w.cells("runs"), w.cells("decisions")];
    assert.equal(w.answer("G1", "--option", "2"), `G1 answered · decline · nothing replaced: T1 keeps its chief C1, and no run ended. The offer ${id} to C2 ended. G1 is spent: to change the chief, open a new takeover gate.`);
    assert.match(opened, /^G1 open · Hand T1 from C1 .* Decline: C1 stays the owning chief, and the offer to C2 ends\. Title of T1: a\n/, "the question says so");
    const task = row(w.cells("tasks"), "T1");
    assert.deepEqual([task.chief, task.offer ?? ""], ["C1", ""]);
    assert.equal(w.cells("runs"), runs, "no run ended");
    assert.equal(row(w.cells("gates"), "G1").answer, "decline");
    const added = w.cells("decisions").slice(decisions.length).trim().split("\n");
    assert.deepEqual(added.map((l) => l.split("\t").slice(1)), [["T1", `${row(w.cells("gates"), "G1").question} → decline`, "the user's answer"]], "one decision row: the owner's answer");
    assert.deepEqual(readdirSync(join(w.dir, "replace-requests")).length, 1, "one saved change");
    assert.throws(() => w.intruder("accept", "T1", "--offer", id, "--version", version), /T1 has no open offer/, "the recipient cannot accept again at once");
    assert.match(w.owner("task", "T1", "set", "title=x"), /^T1 framed/, "the owning chief writes on");
    w.owner("offer", "T1", "--to", "C2");
    const second = w.offer().id, tasks = w.cells("tasks");
    assert.match(w.intruder("gate", "replace", "T1", "--to", "C2"), /^G2 open · .* Decline: nothing changes, and C1 stays the owning chief\. /);
    assert.equal(w.answer("G2", "--option", "2"), "G2 answered · decline · nothing replaced: T1 keeps its chief C1, and no run ended. G2 is spent: to change the chief, open a new takeover gate.");
    assert.equal(w.cells("tasks"), tasks);
    assert.equal(w.offer().id, second);
  });

  test(`${name}: a change of the task after the offer makes an acceptance out of date`, (t) => {
    const w = transfer(t);
    w.owner("offer", "T1", "--to", "C2");
    const { id } = w.offer(), version = w.version();
    w.owner("task", "T1", "set", "title=x");
    assert.throws(() => w.intruder("accept", "T1", "--offer", id, "--version", version), /T1 changed, so this acceptance is out of date/);
    assert.match(w.intruder("accept", "T1", "--offer", id, "--version", w.version()), /^G1 open · Hand T1 from C1 /);
  });

  test(`${name}: F11: a run that ends does not advance a waiting transfer, and a transfer changes no run`, (t) => {
    const w = transfer(t);
    w.owner("run", "add", "T1", "--role", "qa");
    w.owner("offer", "T1", "--to", "C2");
    const { id } = w.offer(), version = w.version(), tasks = w.cells("tasks");
    const replace = name === "Claude" ? "call the gate_replace tool with this task and to C2" : "run sage gate replace T1 --to C2 --chief C2";
    assert.throws(() => w.intruder("accept", "T1", "--offer", id, "--version", version), { message: `T1 has R1 active, so it takes no accept yet: a transfer waits for each active run to end. Nothing changed. Run this again after they end. A run that never ends, such as one of unknown status, ends only through a takeover gate that the owner answers: ${replace}.` }, "F-T618-30");
    w.owner("run", "done", "R1", "--status", "failed");
    assert.equal(w.cells("tasks"), tasks, "the run's end changes no task row");
    assert.equal(w.version(), version);
    assert.equal(row(w.cells("tasks"), "T1").chief, "C1", "the recipient still must accept");
    const runs = w.cells("runs");
    assert.match(w.intruder("accept", "T1", "--offer", id, "--version", version), /^G1 open · .* Runs that end as failed: none\./);
    assert.equal(w.answer("G1", "--option", "1"), "G1 answered · approve · T1 chief C2");
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
    assert.match(w.intruder("accept", "T1", "--offer", second, "--version", secondVersion), /^G1 open · Hand T1 from C1 /);
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

  test(`${name}: unclaim: the owning chief, with no open offer and no active run, clears the chief; the work stays, it claims the task back, and another chief takes it only through the owner's takeover gate`, (t) => {
    const w = transfer(t);
    w.owner("run", "add", "T1", "--role", "qa");
    assert.throws(() => w.intruder("unclaim", "T1"), /T1 belongs to chief C1/);
    assert.throws(() => w.owner("unclaim", "T1"), /T1 has R1 active, so it takes no unclaim yet: .* Run this again after they end\. A run that never ends, such as one of unknown status, ends only through a takeover gate that the owner answers: open one that names the chief that goes on with T1\.$/, "F-T618-30");
    w.owner("run", "done", "R1", "--status", "failed");
    w.owner("offer", "T1", "--to", "C2");
    assert.throws(() => w.owner("unclaim", "T1"), /T1 has the open offer [0-9a-f]{8} to C2: cancel it first/);
    w.owner("cancel", "T1", "--offer", w.offer().id);
    const runs = w.cells("runs");
    assert.equal(w.owner("unclaim", "T1"), "T1 unclaimed · no owning chief. Only C1 claims it back; another chief needs the owner's takeover gate.", "F-T656-3");
    assert.ok(!row(w.cells("tasks"), "T1").chief);
    assert.equal(w.cells("runs"), runs, "the work stays");
    assert.throws(() => w.owner("task", "T1", "set", "title=x"), /T1 has no owning chief, so C1 cannot change it\. Claim it first/);
    const replace = name === "Claude" ? "call the gate_replace tool with this task and to C2" : "run sage gate replace T1 --to C2 --chief C2";
    const tables = w.tables();
    assert.throws(() => w.intruder("claim", "T1", "--version", w.version()), { message: `C1 (${name.toLowerCase()}) unclaimed T1 last, so C2 takes it only through the owner's takeover gate. Nothing changed. Open one for the owner to answer: ${replace}.` });
    assert.equal(w.tables(), tables, "the refused claim changes nothing");
    assert.equal(w.owner("claim", "T1", "--version", w.version()), "T1 claimed · chief C1", "the unclaiming chief claims it back");
    assert.match(w.owner("release", "T1"), /^T1 unclaimed · no owning chief\. .*\nnote: release is unclaim now\. The old words work for one more version\.$/, "T995: the old word works for one version");
    assert.match(w.intruder("release", "add", "--name", "1.0"), /^release 1\.0 added\. Put a milestone in it/);
    const [mine, theirs] = name === "Claude" ? ["claude", "codex"] : ["codex", "claude"];
    const verdicts = theirs === "claude" ? "The verdicts stay, and C2 runs one fresh cycle on its head before it merges." : "The verdicts on its head still count.";
    assert.equal(w.intruder("gate", "replace", "T1", "--to", "C2"), `G1 open · Hand T1 to C2 (${theirs})? T1 has no owning chief: C1 (${mine}) unclaimed it last. Runs that end as failed: none. Approve: C2 owns T1. The answer clears an open offer. The branch keeps its name. ${verdicts} Decline: nothing changes, and T1 stays with no owning chief. Title of T1: a${next("G1")}`);
    assert.ok(!row(w.cells("tasks"), "T1").chief, "the gate alone gives nothing");
    assert.equal(w.answer("G1", "--option", "1"), "G1 answered · approve · T1 chief C2");
    assert.equal(row(w.cells("tasks"), "T1").chief, "C2");
    assert.match(w.intruder("task", "T1", "set", "title=x"), /^T1 framed/);
  });

  test(`T656 ${name}: after the move, a chief claims a task that its own provider started; a task of the other provider needs the owner's takeover gate`, (t) => {
    const w = world(t, own, other);
    w.owner("task", "add", "--title", "a", ...ADD);
    w.owner("task", "add", "--title", "b", ...ADD);
    const [mine, theirs] = name === "Claude" ? ["claude", "codex"] : ["codex", "claude"];
    const moved = (provider, task) => JSON.stringify({ version: 2, provider, task, logbook: join(w.base, "old"), project: w.project, round: 0, digest: "0".repeat(64) });
    setCells(w.dir, "tasks", (l) => /^T[12]\t/.test(l), "chief", "");
    setCells(w.dir, "tasks", (l) => l.startsWith("T1\t"), "adoption", moved(mine, "T7"));
    setCells(w.dir, "tasks", (l) => l.startsWith("T2\t"), "adoption", moved(theirs, "T8"));
    const version = (id) => versionOf(w.project, w.env, id);
    const step = name === "Claude" ? "run sage gate replace T2 --to C1 --chief C1" : "call the gate_replace tool with this task and to C1";
    assert.equal(w.owner("claim", "T1", "--version", version("T1")), "T1 claimed · chief C1", "its own provider's task: no gate");
    const before = w.tables();
    assert.throws(() => w.owner("claim", "T2", "--version", version("T2")), { message: `T2 came in the move from the ${theirs} logbook, so C1 takes it only through the owner's takeover gate. Nothing changed. Open one for the owner to answer: ${step}.` });
    assert.equal(w.tables(), before, "the refused claim changes nothing");
    assert.equal(w.intruder("claim", "T2", "--version", version("T2")), "T2 claimed · chief C2", "the chief of the provider that started it claims it");
  });

  test(`T893 ${name}: any chief abandons a task with no owning chief, with a reason; the task keeps no chief, and any other change still needs a claim`, (t) => {
    const w = world(t, own, other);
    w.owner("task", "add", "--title", "stale", ...ADD);
    w.intruder("task", "add", "--title", "owned", ...ADD);
    const theirs = name === "Claude" ? "codex" : "claude";
    setCells(w.dir, "tasks", (l) => l.startsWith("T1\t"), "chief", "");
    setCells(w.dir, "tasks", (l) => l.startsWith("T1\t"), "adoption", JSON.stringify({ version: 2, provider: theirs, task: "T7", logbook: join(w.base, "old"), project: w.project, round: 0, digest: "0".repeat(64) }));
    const before = w.tables();
    const noReason = { message: `T1 has no owning chief. Any chief may abandon it, with a reason: add --why "<reason>". Nothing changed.` };
    assert.throws(() => w.owner("task", "T1", "set", "state=abandoned"), noReason);
    assert.throws(() => w.owner("task", "T1", "set", "state=abandoned", "--why", ""), noReason);
    assert.throws(() => w.owner("task", "T1", "set", "state=abandoned", "--why", "  "), noReason);
    for (const changes of [["state=briefed"], ["priority=P1"], ["branch=sage/t1-a"], ["pr=5"], ["title=x"], ["state=abandoned", "priority=P1"], ["priority=P1", "state=abandoned"], ["state=abandoned", "state=abandoned"]]) {
      assert.throws(() => w.owner("task", "T1", "set", ...changes, "--why", "stale"), /^Error: T1 has no owning chief, so C1 cannot change it\. Claim it first: /, changes.join(" "));
    }
    assert.throws(() => w.owner("task", "T2", "set", "state=abandoned", "--why", "stale"), /^Error: T2 belongs to chief C2 \(.*\), not to C1\. Nothing changed\. Change only your own tasks\./, "another chief's task: the takeover gate, as before");
    assert.equal(w.tables(), before, "each refusal changes nothing");
    assert.match(w.owner("task", "T1", "set", "state=abandoned", "--why", "stale: an old review checkout"), /^T1 abandoned /);
    assert.equal(row(w.cells("tasks"), "T1").state, "abandoned");
    assert.equal(row(w.cells("tasks"), "T1").chief, "", "the abandon gives the task to no chief");
    assert.match(w.cells("decisions").trim().split("\n").at(-1), /\tT1\tstate abandoned\tstale: an old review checkout · abandoned by C1, with no owning chief$/);
    assert.throws(() => w.intruder("task", "T2", "set", "title=x", "--why", "a reason"), /--why gives the reason of an abandon/);
    assert.match(w.intruder("task", "T2", "set", "state=abandoned", "--why", "not needed"), /^T2 abandoned /);
    assert.match(w.cells("decisions").trim().split("\n").at(-1), /\tT2\tstate abandoned\tnot needed · abandoned by C2$/);
  });

  test(`T656 ${name}: the takeover answer names the worktree that holds the task's branch, with one safe command that frees it`, (t) => {
    const w = transfer(t);
    const held = join(w.base, "held"), mine = join(w.base, "mine");
    execFileSync("git", ["-C", w.project, "worktree", "add", "-q", "-b", "sage/t1-a", held]);
    writeFileSync(join(held, "work.txt"), "not committed\n");
    w.owner("task", "T1", "set", "branch=sage/t1-a");
    w.intruder("gate", "replace", "T1", "--to", "C2");
    const line = `sage/t1-a is checked out in the worktree ${held}, and git checks out a branch in one worktree only. To free it, with its files kept, run this command:\ngit -C '${held}' switch --detach\nThen C2 checks out sage/t1-a in its own worktree.`;
    assert.equal(w.answer("G1", "--option", "1"), `G1 answered · approve · T1 chief C2\n${line}`);
    assert.throws(() => execFileSync("git", ["-C", w.project, "worktree", "add", "-q", mine, "sage/t1-a"], { stdio: "pipe" }), /already (checked out|used by worktree)/, "git refuses while the other worktree holds it");
    execFileSync("git", ["-C", held, "switch", "--detach"]);
    execFileSync("git", ["-C", w.project, "worktree", "add", "-q", mine, "sage/t1-a"]);
    assert.equal(readFileSync(join(held, "work.txt"), "utf8"), "not committed\n", "the other worktree keeps its files");
  });

  test(`F-T656-14 ${name}: the line that frees the branch quotes the worktree's path for a POSIX shell, and prints no command for a path with a control character`, (t) => {
    const freed = (out) => shellCommands(out.split("\n").find((l) => l.startsWith("git -C ")));
    for (const folder of ["held dir", "held; touch pwned $(touch pwned) `id` it's", "held\nother"]) {
      const w = transfer(t), held = join(w.base, folder);
      execFileSync("git", ["-C", w.project, "worktree", "add", "-q", "-b", "sage/t1-a", held]);
      w.owner("task", "T1", "set", "branch=sage/t1-a");
      w.intruder("gate", "replace", "T1", "--to", "C2");
      const out = w.answer("G1", "--option", "1");
      if (folder.includes("\n")) {
        assert.equal(out, "G1 answered · approve · T1 chief C2\nsage/t1-a is checked out in another worktree, and git checks out a branch in one worktree only. That worktree's path has a control character, so sage prints no command for it: find it with git worktree list, and run git switch --detach in it, which keeps its files. Then C2 checks out sage/t1-a in its own worktree.");
        continue;
      }
      const commands = freed(out);
      assert.deepEqual(commands.map((c) => c.words), [["git", "-C", held, "switch", "--detach"]], JSON.stringify(folder));
      execFileSync("git", commands[0].words.slice(1), { stdio: "pipe" });
      execFileSync("git", ["-C", w.project, "worktree", "add", "-q", join(w.base, "mine"), "sage/t1-a"]);
    }
  });

  test(`T656 ${name}: task-adopt refuses in a shared logbook, also for the owning chief, and changes nothing`, (t) => {
    const w = world(t, own, other);
    w.owner("task", "add", "--title", "a", ...ADD);
    const adopt = ["--source-logbook", join(w.base, "old"), "--source-provider", name === "Claude" ? "codex" : "claude", "--source-task", "T9", "--pr", "1", "--branch", "sage/t9"];
    const step = name === "Claude" ? "run sage gate replace <task> --to C1 --chief C1" : "call the gate_replace tool with this task and to C1";
    const before = w.tables();
    assert.throws(() => w.owner("task-adopt", "T1", ...adopt), { message: `this logbook is shared, so task-adopt takes in no task: the other provider's tasks are in it already. A task of another chief comes to you only through the owner's takeover gate: ${step}. Nothing changed.` });
    assert.equal(w.tables(), before);
  });

  test(`T656 ${name}: one ledger after a takeover: merge-check --chief refuses the chief that lost the task, and the new chief lands under its provider's rule`, (t) => {
    const w = world(t, own, other);
    w.owner("task", "add", "--title", "a", ...ADD);
    for (const kind of ["checks-pass", "review-clean", "qa-pass"]) w.owner(...backed(["verdict", "T1", "--sha", SHA, "--kind", kind, "--pr", "41"], { cli: w.owner, keep: (fields) => own.keepReport(w.project, fields, w.env) }));
    const check = (tool, chief) => tool.sage(["merge-check", "--sha", SHA, "--pr", "41", "--project", w.project, "--chief", chief], w.env);
    assert.equal(check(own, "C1"), "T1 may merge: 1 clean cycle on this SHA");
    assert.throws(() => check(other, "C2"), /^Error: T1 belongs to chief C1 \(\w+\), not to C2\. Nothing changed\./, "a chief that does not own the task");
    w.owner("offer", "T1", "--to", "C2");
    w.intruder("accept", "T1", "--offer", JSON.parse(row(w.cells("tasks"), "T1").offer).id, "--version", versionOf(w.project, w.env, "T1"));
    other.sage(["gate", "answer", "G1", "--option", "1", "--project", w.project], w.env);
    setCells(w.dir, "ledger", () => true, "at", "2026-01-01T00:00:00Z");
    setCells(w.dir, "decisions", (l) => /→ (?:approve|replace)\tthe user's answer$/.test(l), "at", "2026-01-01T00:00:01Z");
    assert.throws(() => check(own, "C1"), /^Error: T1 belongs to chief C2 \(\w+\), not to C1\. Nothing changed\./, "the chief that lost the task");
    const hook = () => claude.mergeCheck(SHA, w.env, { pr: "41", project: w.project, session: "session-b" });
    const board = () => landingRule([{ id: "shared", path: w.env.SAGE_SHARED_HOME }])("shared", SHA, "41");
    if (name === "Claude") {
      assert.equal(check(other, "C2"), "T1 may merge: 1 clean cycle on this SHA", "a Codex chief that took a Claude task: the cycle that Claude recorded counts, and the owner lands it (design 6R)");
      assert.deepEqual(board(), { ok: true, scope: "all", reason: "T1 may merge: 1 clean cycle on this SHA" });
      return;
    }
    const fresh = /^Error: T1 came from a chief of another provider through a takeover gate \(2026-01-01T00:00:01Z\), so the cycles before that do not merge it alone: run one cycle of its reviews and QA on this SHA, record each verdict, then merge with gh pr merge\.$/;
    assert.throws(() => check(other, "C2"), fresh);
    assert.equal(hook().ok, false);
    assert.deepEqual(board(), { ok: false, scope: "all", reason: "T1 came from a chief of another provider through a takeover gate (2026-01-01T00:00:01Z), so the cycles before that do not merge it alone: its owning chief runs one cycle of its reviews and QA on this SHA, and records each verdict." }, "the board does not say may merge");
    for (const kind of ["review-clean", "qa-pass"]) w.intruder(...backed(["verdict", "T1", "--sha", SHA, "--kind", kind, "--cycle", "2", "--pr", "41"], { cli: w.intruder, keep: (fields) => other.keepReport(w.project, fields, w.env) }));
    assert.equal(check(other, "C2"), "T1 may merge: 2 clean cycles on this SHA", "the Codex cycle and the Claude one count together: one ledger");
    assert.deepEqual(hook(), { ok: true, reason: "T1 may merge: 2 clean cycles on this SHA" });
    assert.deepEqual(board(), { ok: true, scope: "all", reason: "T1 may merge: 2 clean cycles on this SHA" }, "after the cycle the board says may merge");
  });

  test(`F-T656-2 ${name}: a task that one chief unclaimed and another chief of the same provider took through the gate needs no fresh cycle`, (t) => {
    const w = world(t, own, other);
    w.owner("task", "add", "--title", "a", ...ADD);
    for (const kind of ["checks-pass", "review-clean", "qa-pass"]) w.owner(...backed(["verdict", "T1", "--sha", SHA, "--kind", kind, "--pr", "41"], { cli: w.owner, keep: (fields) => own.keepReport(w.project, fields, w.env) }));
    own.chiefFor(w.project, "session-c", w.env);
    const third = (...args) => own.sage([...args, "--project", w.project, "--chief", "C3"], w.env);
    w.owner("unclaim", "T1");
    const provider = name.toLowerCase();
    const opened = third("gate", "replace", "T1", "--to", "C3");
    own.sage(["gate", "answer", "G1", "--option", "1", "--project", w.project], w.env);
    setCells(w.dir, "ledger", () => true, "at", "2026-01-01T00:00:00Z");
    setCells(w.dir, "decisions", (l) => /→ (?:approve|replace)\tthe user's answer$/.test(l), "at", "2026-01-01T00:00:01Z");
    assert.equal(own.sage(["merge-check", "--sha", SHA, "--pr", "41", "--project", w.project, "--chief", "C3"], w.env), "T1 may merge: 1 clean cycle on this SHA");
    assert.match(opened, new RegExp(`^G1 open · Hand T1 and PR 41 to C3 \\(${provider}\\)\\? T1 has no owning chief: C1 \\(${provider}\\) unclaimed it last\\. .* The branch keeps its name, and PR 41 keeps its number\\. The verdicts on its head still count\\. Decline: `));
    third("unclaim", "T1");
    w.intruder("gate", "replace", "T1", "--to", "C2");
    other.sage(["gate", "answer", "G2", "--option", "1", "--project", w.project], w.env);
    const taken = () => other.sage(["merge-check", "--sha", SHA, "--pr", "41", "--project", w.project, "--chief", "C2"], w.env);
    if (name === "Codex") assert.throws(taken, /^Error: T1 came from a chief of another provider through a takeover gate \(.*\), so the cycles before that do not merge it alone: run one cycle of its reviews and QA on this SHA, /);
    else assert.equal(taken(), "T1 may merge: 1 clean cycle on this SHA", "a Codex chief counts the Claude cycle (design 6R)");
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
    assert.equal(w.intruder("gate", "replace", "T1", "--to", "C2"), `G1 open · ${question}${next("G1")}`);
    const gate = row(w.cells("gates"), "G1");
    assert.deepEqual([gate.kind, gate.task, gate.options, gate.answer], ["replace", "T1", "approve|decline", ""]);
    assert.equal(row(w.cells("tasks"), "T1").chief, "C1", "the gate alone changes nothing: the owner decides");
    assert.equal(row(w.cells("runs"), "R1").status, "running");
    assert.equal(w.answer("G1", "--option", "1"), "G1 answered · approve · T1 chief C2 · R1, R2 failed");
    const task = row(w.cells("tasks"), "T1"), runs = w.cells("runs");
    assert.equal(task.chief, "C2");
    assert.ok(!task.offer);
    assert.deepEqual(["R1", "R2", "R3"].map((id) => row(runs, id).status), ["failed", "failed", "failed"]);
    assert.ok(row(runs, "R1").ended && row(runs, "R2").ended);
    assert.deepEqual(["R1", "R2", "R3"].map((id) => row(runs, id).chief), ["C1", "C1", "C1"], "each run keeps the chief that dispatched it");
    assert.equal(row(w.cells("gates"), "G1").answer, "approve");
    assert.ok(w.cells("decisions").includes(`${question} → approve`));
    assert.throws(() => w.owner("task", "T1", "set", "title=x"), /^Error: T1 belongs to chief C2 \(.*\), not to C1\. Nothing changed/, "a replaced chief gets a refusal that names the new owning chief");
    assert.throws(() => w.lead("R1", "task", "T1", "set", "title=x"), /R1 is not a running lead run, so this lead writes nothing/, "the replaced chief's lead writes nothing");
    assert.match(w.intruder("task", "T1", "set", "title=x"), /^T1 framed/);
    assert.throws(() => w.answer("G1", "--option", "2"), /^Error: G1 has the answer "approve" already, from the chat at \S+: the first answer wins, so this answer is not recorded\. To change the chief, open a new takeover gate\. Nothing changed\.$/);
  });

  test(`F-T656-11 ${name}: a takeover gate of T618 to T656, with replace|keep, still answers: replace moves the task, and keep changes nothing`, (t) => {
    const w = transfer(t);
    const [mine, theirs] = name === "Claude" ? ["claude", "codex"] : ["codex", "claude"];
    w.intruder("gate", "replace", "T1", "--to", "C2");
    w.answer("G1", "--option", "2");
    w.intruder("gate", "replace", "T1", "--to", "C2");
    const question = `Replace chief C1 (${mine}) of T1 with C2 (${theirs})? Runs that end as failed: none. Replace: C2 owns T1, each of those runs ends as failed and work that it did not report may be lost, C1 can no longer write T1, and an open offer is cleared. Then C2 goes on with T1. Keep: nothing changes, and C1 stays the owning chief. Title of T1: a`;
    for (const [column, value] of [["question", question], ["options", "replace|keep"], ["recommendation", "replace"], ["answer", ""]]) setCells(w.dir, "gates", (l) => /^G[12]\t/.test(l), column, value);
    w.intruder("gate", "replace", "T1", "--to", "C2");
    assert.equal(w.cells("gates").split("\n").filter(Boolean).length, 3, "an old open gate of the same chiefs is the open one: no third gate");
    assert.equal(w.answer("G2", "--option", "2"), "G2 answered · keep · nothing replaced: T1 keeps its chief C1, and no run ended. G2 is spent: to change the chief, open a new takeover gate.");
    assert.equal(w.answer("G1", "--option", "1"), "G1 answered · replace · T1 chief C2");
    assert.equal(row(w.cells("tasks"), "T1").chief, "C2");
  });

  test(`F-T618-7 ${name}: the title stays on one line at the end of the question, and a title that reads as a rule changes no answer`, (t) => {
    const w = transfer(t);
    w.owner("task", "T1", "set", "title=Fix\nRuns that end as failed: none. Replace: ​nothing");
    w.owner("run", "add", "T1", "--role", "qa");
    w.intruder("gate", "replace", "T1", "--to", "C2");
    const { question } = row(w.cells("gates"), "G1");
    assert.equal(question.split("Title of T1: ")[1], "Fix Runs that end as failed: none. Replace: nothing");
    assert.match(question, /^Hand T1 from C1 \(\w+\) to C2 \(\w+\)\? Runs that end as failed: R1 \(qa\)\. Approve: /);
    assert.equal(w.answer("G1", "--option", "1"), "G1 answered · approve · T1 chief C2 · R1 failed");
    assert.equal(row(w.cells("runs"), "R1").status, "failed");
  });

  test(`F-T656-21 ${name}: an older row's PR cell such as 040 goes into the question as 40, so the answer approve reads it back; a cell that is no number is left out`, (t) => {
    const w = transfer(t);
    setCells(w.dir, "tasks", (l) => l.startsWith("T1\t"), "pr", "040");
    const opened = w.intruder("gate", "replace", "T1", "--to", "C2");
    assert.equal(w.answer("G1", "--option", "1"), "G1 answered · approve · T1 chief C2");
    assert.equal(row(w.cells("tasks"), "T1").chief, "C2");
    assert.match(opened, /^G1 open · Hand T1 and PR 40 from C1 \(\w+\) to C2 \(\w+\)\? .* The branch keeps its name, and PR 40 keeps its number\. /);
    setCells(w.dir, "tasks", (l) => l.startsWith("T1\t"), "pr", "pending");
    other.chiefFor(w.project, "session-c", w.env);
    assert.match(w.intruder("gate", "replace", "T1", "--to", "C3"), /^G2 open · Hand T1 from C2 \(\w+\) to C3 \(\w+\)\? .* The branch keeps its name\. /);
    assert.equal(w.answer("G2", "--option", "1"), "G2 answered · approve · T1 chief C3");
  });

  test(`${name}: a task with no active run and no title prints none and (no title)`, (t) => {
    const w = transfer(t);
    w.owner("task", "T1", "set", "title=​");
    w.intruder("gate", "replace", "T1", "--to", "C2");
    assert.equal(row(w.cells("gates"), "G1").question, name === "Claude" ? asked("claude", "codex", "(no title)", "none") : asked("codex", "claude", "(no title)", "none"));
    assert.equal(w.answer("G1", "--option", "1"), "G1 answered · approve · T1 chief C2");
  });

  test(`F-T618-29 ${name}: a Replace needs the owner's answer: keep or own words change no chief and end no run, and the line says so`, (t) => {
    const w = transfer(t);
    w.owner("run", "add", "T1", "--role", "qa");
    w.intruder("gate", "replace", "T1", "--to", "C2");
    assert.match(w.intruder("gate", "replace", "T1", "--to", "C2"), /^G1 is open already · /, "F-T656-4: the open gate of the same task and chiefs, not a second one");
    const runs = w.cells("runs");
    assert.equal(w.answer("G1", "--option", "2"), "G1 answered · decline · nothing replaced: T1 keeps its chief C1, and no run ended. G1 is spent: to change the chief, open a new takeover gate.");
    assert.match(w.intruder("gate", "replace", "T1", "--to", "C2"), /^G2 open · /, "after the answer, a new gate opens");
    assert.equal(w.answer("G2", "--other-hex", Buffer.from("approve").toString("hex")), "G2 answered · other: approve · nothing replaced: T1 keeps its chief C1, and no run ended. G2 is spent: to change the chief, open a new takeover gate.");
    w.owner("gate", "add", "T1", "--question", "q?", "--options", "a|b", "--recommend", "a");
    assert.equal(w.answer("G3", "--option", "2"), "G3 answered · b", "a plain gate's line stays as it was");
    assert.equal(row(w.cells("tasks"), "T1").chief, "C1");
    assert.equal(w.cells("runs"), runs);
    assert.throws(() => w.answer("G1", "--option", "1"), /^Error: G1 has the answer "decline" already, from the chat at \S+: the first answer wins/, "no second answer undoes the owner's decline");
  });

  test(`${name}: a takeover gate that is out of date refuses and changes nothing: a new run, or a new owning chief`, (t) => {
    const w = transfer(t);
    w.intruder("gate", "replace", "T1", "--to", "C2");
    w.owner("run", "add", "T1", "--role", "qa");
    let before = w.tables();
    assert.throws(() => w.answer("G1", "--option", "1"), /R1 started after G1 opened, so G1 does not name each run that ends as failed\. Answer decline, then open a new takeover gate/);
    assert.equal(w.tables(), before);
    w.answer("G1", "--option", "2");
    w.owner("run", "done", "R1", "--status", "failed");
    w.owner("offer", "T1", "--to", "C2");
    w.intruder("accept", "T1", "--offer", w.offer().id, "--version", w.version());
    w.answer("G2", "--option", "1");
    other.chiefFor(w.project, "session-c", w.env);
    w.intruder("gate", "replace", "T1", "--to", "C3");
    w.intruder("unclaim", "T1");
    before = w.tables();
    assert.throws(() => w.answer("G3", "--option", "1"), /T1 now belongs to no chief, not to C2, so G3 is out of date/);
    assert.equal(w.tables(), before);
    w.intruder("gate", "replace", "T1", "--to", "C3");
    w.intruder("claim", "T1", "--version", w.version());
    assert.throws(() => w.answer("G4", "--option", "1"), /T1 now belongs to chief C2, not to no chief, so G4 is out of date/, "T656: a gate of a task with no chief is out of date after a claim");
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
    for (const table of tables.slice(1)) writeFileSync(join(w.dir, `${table}.tsv`), before[table]);
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

  test(`${name}: T1025: finding move --into refuses a task of another chief`, (t) => {
    const w = world(t, own, other);
    w.owner("task", "add", "--title", "a", ...ADD);
    w.intruder("task", "add", "--title", "b", ...ADD);
    w.owner("run", "add", "T1", "--role", "qa");
    w.owner("finding", "add", "T1", ...QA);
    const before = w.tables();
    assert.throws(() => w.owner("finding", "move", "T1", "F-T1-1", "--into", "T2"), /T2 belongs to chief C2 .* Change only your own tasks\./);
    assert.equal(w.tables(), before, "nothing changed");
  });

  test(`${name}: T1025: the lead of the task that a finding moved into closes it after a re-check, like any fix finding`, (t) => {
    const w = world(t, own, other);
    w.owner("task", "add", "--title", "a", ...ADD);
    w.owner("run", "add", "T1", "--role", "qa");
    w.owner("finding", "add", "T1", ...QA);
    w.owner("finding", "move", "T1", "F-T1-1", "--to", "later");
    w.owner("task", "T2", "set", "state=briefed");
    const lead = w.owner("run", "add", "T2", "--role", "lead").split(" ")[0];
    for (const state of ["building", "reviewing"]) w.lead(lead, "task", "T2", "set", `state=${state}`);
    assert.throws(() => w.lead(lead, "finding", "close", "T2", "F-T2-1"), /T2 has a medium or high finding triaged fix and is not repairing: run round T2 first/);
    assert.match(w.lead(lead, "round", "T2"), /^T2 repairing · round 1 of 3 · fix F-T2-1 · re-run qa /);
    const check = w.lead(lead, "run", "add", "T2", "--role", "qa").split(" ")[0];
    own.keepReport(w.project, { task: "T2", run: check, role: "qa", sha: SHA, text: reportFor("qa-pass") }, w.env);
    w.lead(lead, "run", "done", check, "--status", "done", "--tokens", "1");
    assert.equal(w.lead(lead, "finding", "close", "T2", "F-T2-1"), "F-T2-1 closed · fix");
    assert.match(w.lead(lead, "task", "T2", "set", "state=reviewing"), /^T2 reviewing/);
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
      assert.throws(() => w.intruder(...words(line)), /^Error: T1 belongs to chief C1 .* Change only your own tasks\. To take T1, ask C1 to offer it to you, or open a takeover gate for the owner to answer: .*\.$/, line);
      assert.throws(() => w.nobody(...words(line)), NO_CHIEF, line);
      assert.equal(w.tables(), before, line);
      w.owner(...words(line));
      assert.notEqual(w.tables(), before, line);
    }
  });
}


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
  assert.throws(() => w.owner("log", "T1", "x", "--why", "y"), /A Replace receipt was created while this logbook was read\. Retry the read\./);
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

test("F-T604-19: the stop writer keeps a report with no chief on a shared logbook, and the chief cell stays", (t) => {
  const w = world(t, codex, claude);
  w.owner("task", "add", "--title", "a", ...ADD);
  w.owner("run", "add", "T1", "--role", "implementer", "--branch", "codex/t1-report");
  w.owner("run", "add", "T1", "--role", "qa", "--branch", "codex/t1-report");
  codex.keepReport(w.project, { task: "T1", run: "R2", role: "qa", sha: SHA, text: "STATUS done" }, w.env);
  assert.equal(JSON.parse(readFileSync(join(w.dir, "kept", "R2.json"), "utf8")).text, "STATUS done");
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
  const version = versionOf(w.project, w.env, "T1");
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
  const plugin = join(w.base, "older");
  cpSync(at("../plugins/sage-codex"), plugin, { recursive: true });
  const state = join(plugin, "core/state.mjs"), source = readFileSync(state, "utf8");
  const older = source.replace("const SPARSE = { tasks: [CHIEF_COLUMN, \"offer\", RELEASE_COLUMN], runs: [CHIEF_COLUMN, CHECKOUT_COLUMN, ADMITTED_COLUMN],", "const SPARSE = { tasks: [\"offer\", RELEASE_COLUMN],");
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

function hookWorld(t) {
  const w = scratch(t);
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
  assert.match(w.bash("gate answer G1 --option 1"), /add --chief C1 to this command/, "a gate answer names the chief that applies it");
  assert.equal(w.bash("gate answer G1 --option 1 --chief C1"), undefined);
  const rows = readFileSync(join(claude.storeDir(w.project, w.env), "chiefs.tsv"), "utf8");
  assert.equal(w.bash("gate answer G1 --option 1", "s9"), undefined, "a session that is no chief here answers as the owner");
  assert.equal(readFileSync(join(claude.storeDir(w.project, w.env), "chiefs.tsv"), "utf8"), rows, "and the answer makes it no chief");
  assert.equal(w.bash("logbook repair --accept-change-loss yes"), undefined, "F-T604-20: this repair is the owner's, so it names no chief");
  assert.equal(w.bash("logbook repair --accept-loss milestones"), undefined, "F-T604-23: so is this one");
  assert.equal(w.bash("projects rebuild --accept-listing yes"), undefined, "F-T617-1: and so is the rebuild of the known project list");
});

const QUOTED = {
  "task add": ['task add --title "two words" --size small --priority P2', "task add --title word --size small --priority P2"],
  log: ['log T1 "a decision" --why "a reason"', "log T1 decision --why reason"],
  "task set": ['task T1 set state=abandoned --why "a reason"', "task T1 set state=abandoned --why reason"],
  "gate add": ['gate add T1 --question "a question?" --options "a|b" --recommend a', "gate add T1 --question question --options yes,no --recommend yes"],
  "finding add": ['finding add T1 --source sage --severity low --summary "a problem"', "finding add T1 --source sage --severity low --summary problem"],
  "standing add": ['standing add "an order"', "standing add order"],
  "milestone propose": ['milestone propose --name "a name" --goal "a goal" --pilot T1 --tasks none', "milestone propose --name name --goal goal --pilot T1 --tasks none"],
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
  assert.match(w.bash('gate answer "G1" --option 1'), NAMED);
  const raw = (command) => w.denied(w.send({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } }));
  assert.match(raw(`node "${TOOL}" task add --title "two words" --size small --priority P2`), NAMED, "a quoted path is the tool too");
  assert.equal(raw(`cd /tmp && node ${TOOL} task add --title "two words" --size small --priority P2`), undefined, "not one command: the state tool refuses it");
  assert.equal(raw(`node ${TOOL} task add --title "open`), undefined, "a line that the reader cannot read");
  assert.equal(raw('node other.mjs task add --title "two words"'), undefined, "another program");
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
  assert.equal(merge("s1"), "sage: the merge check refuses: T1 belongs to chief C2 (claude), not to C1. Nothing changed. Change only your own tasks. To take T1, ask C2 to offer it to you, or open a takeover gate for the owner to answer: run sage gate replace T1 --to C1 --chief C1.", "the replaced chief");
  assert.equal(merge("s2"), undefined, "the new owning chief merges");
  for (const prompt of ["sage mode", "autopilot on"]) w.send({ hook_event_name: "UserPromptSubmit", prompt, session_id: undefined });
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
    const [head, ...lines] = w.cells("tasks").split("\n"), at = head.split("\t").indexOf("state");
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
  for (const line of ["offer T1 --to C2", "cancel T1 --offer x", `accept T1 --offer x --version ${"0".repeat(64)}`, "unclaim T1", "release T1", "gate replace T1 --to C2", `claim T1 --version ${"0".repeat(64)}`]) {
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

test("T928: one lead policy in core: a lead's write to another task, a command off its list and a wrong state move get the same plain reason from the state tool of each provider, the Claude hook and the Codex gate", async (t) => {
  const w = hookWorld(t);
  const { callerRefusal } = await import(at("../plugins/sage-codex/hooks/gate-hook.mjs"));
  const sage = (...args) => claude.sage([...args, "--project", w.project], w.env);
  sage("link", "--separate");
  w.send({ hook_event_name: "UserPromptSubmit", prompt: "sage mode" });
  const chief = claude.chiefFor(w.project, "s1", w.env);
  for (const title of ["mine", "theirs"]) sage("task", "add", "--title", title, ...ADD, "--chief", chief);
  sage("task", "T1", "set", "state=briefed", "--chief", chief);
  sage("run", "add", "T1", "--role", "lead", "--chief", chief);
  const start = { subagent_type: "sage:lead", name: "lead-T1", description: "lead-T1", prompt: "GOAL a\nSCOPE b\nCONTEXT c\nDECISIONS d\nACCEPTANCE e\nVERIFY f\nBUDGET 1 hour of agent time\nFORBIDDEN g\nREPORT h\nSTANDING i", run_in_background: true };
  assert.equal(w.denied(w.send({ hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: start, tool_use_id: "start-1" })), undefined);
  w.send({ hook_event_name: "PostToolUse", tool_name: "Agent", tool_use_id: "start-1", tool_response: { status: "async_launched", agentId: "lead-1" } });
  w.send({ hook_event_name: "SubagentStart", agent_id: "lead-1", agent_type: "sage:lead" });
  const lead = { agent_id: "lead-1", agent_type: "sage:lead" }, caller = { role: "lead", task: "T1", run: "R1", project: realpathSync(w.project) };
  const before = readFileSync(join(claude.storeDir(w.project, w.env), "tasks.tsv"), "utf8");
  for (const [words, name, input, reason] of [
    [["round", "T2"], "round", { task: "T2" }, "T2 is not of T1, and a lead records only its own task. Report to your chief what T2 needs."],
    [["gate", "add", "T1", "--question", "q", "--options", "a|b", "--recommend", "a"], "gate_add", { task: "T1", question: "q", options: "a|b", recommend: "a" },
      '"gate add" is not on a lead\'s list. A lead records only its own task, with run add, run done, finding add, finding close, finding triage, verdict, lint, round, pages, and task set of state, branch, pr. Put what else the logbook needs in your report.'],
    [["task", "T1", "set", "state=verified"], "task_set", { task: "T1", fields: { state: "verified" } }, "T1 is briefed: a lead moves it only to building."],
  ]) {
    for (const [provider, tool] of [["Claude", claude], ["Codex", codex]]) {
      assert.throws(() => tool.sage([...words, "--project", w.project, "--lead", "R1"], w.env), { message: `${reason} Nothing changed.` }, `the ${provider} state tool: ${words.join(" ")}`);
    }
    const hook = w.bash([...words.map((word) => (word.includes("|") ? "a,b" : word)), "--lead", "R1"].join(" "), "s1", lead) ?? "";
    assert.ok(hook.startsWith(`sage: ${reason} A lead writes the logbook only with`), `the Claude hook: ${words.join(" ")}: ${hook}`);
    assert.equal(callerRefusal(caller, name, { project: w.project, ...input }, w.env), `sage: ${reason}`, `the Codex gate and server: ${name}`);
  }
  assert.equal(readFileSync(join(claude.storeDir(w.project, w.env), "tasks.tsv"), "utf8"), before, "nothing changed");
  assert.equal(w.bash("task T1 set state=building --lead R1", "s1", lead), undefined);
  assert.equal(callerRefusal(caller, "task_set", { project: w.project, task: "T1", fields: { state: "building" } }, w.env), undefined);
  assert.match(codex.sage(["task", "T1", "set", "state=building", "--project", w.project, "--lead", "R1"], w.env), /^T1 building/);
});

test("T927: the Claude chief runs worktrees and its prune with no --chief in a shared logbook; a lead and a helper run neither", (t) => {
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
  for (const line of ["worktrees", "worktrees prune --yes"]) {
    assert.equal(w.bash(line), undefined, `the chief: ${line}`);
    assert.match(w.bash(line, "s1", { agent_id: "qa-1", agent_type: "sage:qa" }), new RegExp(`"${line.replace(" --yes", "")}" writes the logbook, or is not a read command of the state tool\\.`), `a helper: ${line}`);
    assert.match(w.bash(`${line} --lead R1`, "s1", { agent_id: "lead-1", agent_type: "sage:lead" }), /is not on a lead's list/, `a lead: ${line}`);
  }
});

const git = (...args) => execFileSync("git", args, { encoding: "utf8", env: gitEnv }).trim();
const header = (text) => text.split("\n")[0].split("\t");
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
  const capture = () => codex.branchTip(b, branch, w.env);
  return { ...w, a, b, branch, tip, behind, inB, capture };
}
test("T625: after the first run add with a checkout, a sage of PR 5a refuses to write that shared logbook and says to update; its reads go on", async (t) => {
  const w = world(t, claude, codex);
  w.owner("task", "add", "--title", "a", ...ADD);
  w.owner("run", "add", "T1", "--role", "qa");
  const plugin = join(w.base, "older");
  cpSync(at("../plugins/sage-codex"), plugin, { recursive: true });
  const state = join(plugin, "core/state.mjs"), source = readFileSync(state, "utf8");
  const older = source.replace("runs: [CHIEF_COLUMN, CHECKOUT_COLUMN, ADMITTED_COLUMN], gates", "runs: [CHIEF_COLUMN], gates");
  assert.notEqual(older, source, "the fixture removes the column");
  writeFileSync(state, older);
  const { tool } = await import(pathToFileURL(join(plugin, "skills/sage/sage.mjs")).href);
  const run = (...args) => tool.sage([...args, "--project", w.project, "--chief", w.chief], w.env), before = w.tables();
  assert.throws(() => run("run", "add", "T1", "--role", "qa"), /runs\.tsv has columns that this version of sage does not know \(checkout\).*Update the sage plugin/);
  assert.equal(w.tables(), before, "nothing changed");
  assert.match(tool.sage(["task", "T1", "--project", w.project], w.env), /^T1 framed /);
  assert.match(tool.sage(["status", "--project", w.project], w.env), /tasks {3}1/);
});

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


test("T625: the review reads the branch in the checkout of its writer run, from another clone of the logbook too", (t) => {
  const w = clones(t);
  assert.equal(row(w.cells("runs"), "R1").checkout, w.a);
  assert.equal(row(w.cells("runs"), "R2").checkout, realpathSync(w.b));
  assert.notEqual(w.tip, w.behind);
  assert.equal(w.capture(), w.tip);
});

function fakeGit(w) {
  const fake = join(w.base, "fake-git"), file = join(w.base, "git-calls");
  mkdirSync(fake);
  writeFileSync(join(fake, "git"), `#!${process.execPath}\nconst { appendFileSync } = require("node:fs"), { spawnSync } = require("node:child_process");\nappendFileSync(${JSON.stringify(file)}, JSON.stringify(process.argv.slice(2)) + "\\n");\nconst path = process.env.PATH.split(":").filter((dir) => dir !== ${JSON.stringify(fake)}).join(":");\nprocess.exit(spawnSync("git", process.argv.slice(2), { stdio: "inherit", env: { ...process.env, PATH: path } }).status ?? 1);\n`, { mode: 0o755 });
  const calls = () => (existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : []);
  const ranIn = (folder) => calls().some((args) => args.some((arg, k) => arg === "-C" && args[k + 1] === folder));
  return { env: { ...w.env, PATH: `${fake}:${w.env.PATH}` }, calls, ranIn, clear: () => rmSync(file, { force: true }) };
}

const LEAVE = {
  "missing": () => {},
  "a plain file": (w) => writeFileSync(w.a, ""),
  "an empty folder": (w) => mkdirSync(w.a),
  "an empty folder inside another repository": (w) => {
    mkdirSync(w.a);
    git("init", "-q", "-b", "main", w.base);
    git("-C", w.base, "commit", "-q", "--allow-empty", "-m", "the outer repository");
    git("-C", w.base, "branch", w.branch);
    assert.match(git("-C", w.a, "rev-parse", "--verify", `refs/heads/${w.branch}^{commit}`), /^[0-9a-f]{40}$/, "git in the folder reads the outer branch");
  },
};
for (const [form, leave] of Object.entries(LEAVE)) test(`T625: a gone checkout of the writer run (${form}) gives no branch tip, git never runs there, and no table changes`, (t) => {
  const w = clones(t), spy = fakeGit(w);
  assert.equal(codex.branchTip(w.b, w.branch, spy.env), w.tip);
  assert.ok(spy.ranIn(w.a), "git ran in the live checkout");
  spy.clear();
  rmSync(w.a, { recursive: true, force: true });
  leave(w);
  const tables = w.tables();
  assert.equal(codex.branchTip(w.b, w.branch, spy.env), "", "the state tool's tip read fails closed");
  assert.deepEqual(spy.calls(), [], "git never ran");
  assert.equal(w.capture(), "", "the hook's tip read fails closed");
  assert.equal(w.tables(), tables);
});

test("T625: the review reads the branch in the checkout of the newest writer run, by run number", (t) => {
  const w = clones(t), done = (id) => w.owner("run", "done", id, "--status", "failed");
  done("R1");
  w.inB("run", "add", "T1", "--role", "implementer", "--branch", w.branch);
  assert.equal(w.capture(), w.behind, "R3 in B is newer than R1 in A");
  done("R3");
  for (let i = 4; i <= 8; i++) w.inB("run", "add", "T1", "--role", "qa");
  w.inB("run", "add", "T1", "--role", "implementer", "--branch", w.branch);
  done("R9");
  w.owner("run", "add", "T1", "--role", "implementer", "--branch", w.branch);
  assert.deepEqual([row(w.cells("runs"), "R9").checkout, row(w.cells("runs"), "R10").checkout], [realpathSync(w.b), w.a]);
  assert.equal(w.capture(), w.tip, "R10 in A is newer than R9 in B");
});

test("T625: a writer run with no checkout cell reads the branch in the command's own folder", (t) => {
  const w = clones(t);
  setCheckout(w, "R1", "");
  assert.equal(header(w.cells("runs")).at(-1), "checkout");
  assert.equal(row(w.cells("runs"), "R2").checkout, realpathSync(w.b));
  assert.equal(w.capture(), w.behind, "B's own branch");
});

test("T625: a writer run's checkout that is no bindings.tsv row of this logbook gives no branch tip, and git never reads it", (t) => {
  const w = clones(t), planted = join(w.base, "planted"), spy = fakeGit(w);
  git("init", "-q", "-b", "main", planted);
  git("-C", planted, "commit", "-q", "--allow-empty", "-m", "planted");
  git("-C", planted, "branch", w.branch);
  setCheckout(w, "R1", planted);
  const tables = w.tables();
  assert.equal(codex.branchTip(w.b, w.branch, spy.env), "", "the state tool's tip read fails closed");
  assert.deepEqual(spy.calls(), [], "git never ran");
  assert.equal(w.tables(), tables);
  setCheckout(w, "R1", w.a);
  assert.equal(codex.branchTip(w.b, w.branch, spy.env), w.tip);
  assert.ok(spy.ranIn(w.a), "git ran in the writer's checkout");
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

function stamp(dir, at) {
  const file = join(dir, "decisions.tsv"), lines = readFileSync(file, "utf8").split("\n"), k = lines.findLastIndex((l) => /→ approve\tthe user's answer$/.test(l));
  lines[k] = lines[k].split("\t").with(lines[0].split("\t").indexOf("at"), at).join("\t");
  writeFileSync(file, lines.join("\n"));
}

test("F-T656-23: after a takeover from Codex, the fresh Claude cycle counts only the verdicts of runs that started after the owner's answer", (t) => {
  const w = world(t, codex, claude);
  w.owner("task", "add", "--title", "a", ...ADD);
  for (const kind of ["checks-pass", "review-clean", "qa-pass"]) w.owner(...backed(["verdict", "T1", "--sha", SHA, "--kind", kind, "--pr", "41"], { cli: w.owner, keep: (fields) => codex.keepReport(w.project, fields, w.env) }));
  const pending = Object.fromEntries([["review-clean", "code-reviewer"], ["qa-pass", "qa"]].map(([kind, role]) => {
    const id = /^(R\d+) running/.exec(w.owner("run", "add", "T1", "--role", role))[1];
    codex.keepReport(w.project, { task: "T1", run: id, role, sha: SHA, text: reportFor(kind) }, w.env);
    w.owner("run", "done", id, "--status", "done", "--tokens", "1");
    return [kind, id];
  }));
  w.owner("offer", "T1", "--to", "C2");
  w.intruder("accept", "T1", "--offer", JSON.parse(row(w.cells("tasks"), "T1").offer).id, "--version", versionOf(w.project, w.env, "T1"));
  claude.sage(["gate", "answer", "G1", "--option", "1", "--project", w.project], w.env);
  setCells(w.dir, "ledger", () => true, "at", "2026-01-01T00:00:00Z");
  for (const column of ["started", "ended"]) setCells(w.dir, "runs", () => true, column, "2026-01-01T00:00:00Z");
  stamp(w.dir, "2026-01-01T00:00:01Z");
  const check = () => claude.sage(["merge-check", "--sha", SHA, "--pr", "41", "--project", w.project, "--chief", "C2"], w.env);
  const fresh = /^Error: T1 came from a chief of another provider through a takeover gate \(2026-01-01T00:00:01Z\), so the cycles before that do not merge it alone: /;
  for (const kind of ["review-clean", "qa-pass"]) w.intruder("verdict", "T1", "--sha", SHA, "--kind", kind, "--cycle", "2", "--pr", "41", "--run", pending[kind]);
  assert.throws(check, fresh);
  assert.equal(claude.mergeCheck(SHA, w.env, { pr: "41", project: w.project, session: "session-b" }).ok, false, "the hook's check of C2's gh pr merge");
  assert.equal(landingRule([{ id: "shared", path: w.env.SAGE_SHARED_HOME }])("shared", SHA, "41").ok, false, "the board");
  for (const kind of ["review-clean", "qa-pass"]) w.intruder(...backed(["verdict", "T1", "--sha", SHA, "--kind", kind, "--cycle", "3", "--pr", "41"], { cli: w.intruder, keep: (fields) => claude.keepReport(w.project, fields, w.env) }));
  assert.equal(check(), "T1 may merge: 3 clean cycles on this SHA");
});

test("F-T656-20: the last takeover answer decides the fresh cycle: back to a Codex chief needs none, and a move between Claude chiefs keeps the one before it", (t) => {
  const w = world(t, codex, claude);
  w.owner("task", "add", "--title", "a", ...ADD);
  for (const kind of ["checks-pass", "review-clean", "qa-pass"]) w.owner(...backed(["verdict", "T1", "--sha", SHA, "--kind", kind, "--pr", "41"], { cli: w.owner, keep: (fields) => codex.keepReport(w.project, fields, w.env) }));
  setCells(w.dir, "ledger", () => true, "at", "2026-01-01T00:00:00Z");
  const answer = (gate, at) => {
    claude.sage(["gate", "answer", gate, "--option", "1", "--project", w.project], w.env);
    stamp(w.dir, at);
  };
  const check = (tool, chief) => tool.sage(["merge-check", "--sha", SHA, "--pr", "41", "--project", w.project, "--chief", chief], w.env);
  w.intruder("gate", "replace", "T1", "--to", "C2");
  answer("G1", "2026-01-01T00:00:01Z");
  w.intruder("gate", "replace", "T1", "--to", "C1");
  answer("G2", "2026-01-01T00:00:02Z");
  assert.equal(check(codex, "C1"), "T1 may merge: 1 clean cycle on this SHA", "a Codex chief counts the cycles before (design 6R)");
  assert.equal(landingRule([{ id: "shared", path: w.env.SAGE_SHARED_HOME }])("shared", SHA, "41").ok, true, "the board agrees");
  w.intruder("gate", "replace", "T1", "--to", "C2");
  answer("G3", "2026-01-01T00:00:03Z");
  claude.chiefFor(w.project, "session-c", w.env);
  w.intruder("gate", "replace", "T1", "--to", "C3");
  answer("G4", "2026-01-01T00:00:04Z");
  assert.throws(() => check(claude, "C3"), /^Error: T1 came from a chief of another provider through a takeover gate \(2026-01-01T00:00:03Z\)/);
});

const SESSION = new Map([[claude, "claude-session"], [codex, "codex-session"]]);
function pushWorld(t) {
  const w = scratch(t), bin = join(w.base, "bin"), calls = join(w.base, "gh-calls.log"), tree = join(w.base, "tree");
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), `#!/bin/sh\necho "$@" >> "${calls}"\nif [ "$1" = api ] && [ "$6" = .default_branch ]; then echo main; exit 0; fi\nexit 1\n`, { mode: 0o755 });
  const path = String(process.env.PATH).split(":").filter(Boolean);
  symlinkSync(path.map((d) => join(d, "git")).find((f) => existsSync(f)), join(bin, "git"));
  const env = { ...w.env, PATH: [bin, ...path.filter((d) => !existsSync(join(d, "gh")))].join(":"), SAGE_HOOKS_STATE: join(w.base, "hooks") };
  assert.equal(spawnSync("git", ["--version"], { env, encoding: "utf8" }).status, 0);
  assert.equal(spawnSync("gh", ["api", "--hostname", "github.com", "repos/acme/project", "--jq", ".default_branch"], { env, encoding: "utf8" }).stdout, "main\n");
  assert.equal(readFileSync(calls, "utf8"), "api --hostname github.com repos/acme/project --jq .default_branch\n");
  execFileSync("git", ["-C", w.project, "remote", "add", "origin", "https://github.com/acme/project.git"]);
  execFileSync("git", ["-C", w.project, "worktree", "add", "-q", "-b", "sage/t1-a", tree]);
  for (const name of ["sage/t1-r", "sage/t9-free"]) execFileSync("git", ["-C", w.project, "branch", name]);
  const answer = (r) => {
    assert.equal(r.status, 0, r.stderr);
    const out = r.stdout ? JSON.parse(r.stdout) : undefined;
    return out?.hookSpecificOutput?.permissionDecision === "deny" ? out.hookSpecificOutput.permissionDecisionReason : undefined;
  };
  const hook = (tool, event) => answer(spawnSync(process.execPath, tool === claude ? LAUNCHER : [at("../plugins/sage-codex/hooks/gate-hook.mjs")],
    { input: JSON.stringify({ session_id: SESSION.get(tool), cwd: w.project, ...event }), env, encoding: "utf8", timeout: 60_000 }));
  hook(claude, { hook_event_name: "UserPromptSubmit", prompt: "sage mode" });
  const modes = join(env.CODEX_HOME, "sage", ".hooks", "codex");
  mkdirSync(modes, { recursive: true, mode: 0o700 });
  writeFileSync(join(modes, `${stateKey({ session_id: SESSION.get(codex) })}.json`), JSON.stringify({ sage: true, autopilot: false }), { mode: 0o600 });
  const push = (tool, command, agent = false, more = {}) => hook(tool, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "call_1", tool_input: { command },
    ...(agent ? { agent_id: "agent-1", ...(tool === claude ? { agent_type: "sage:implementer" } : {}) } : {}), ...more });
  const sage = (tool, ...args) => tool.sage([...args, "--project", w.project], w.env);
  return { ...w, env, tree, calls, hook, push, sage };
}
const pushBar = (tool, branch, owner, provider, me) => `sage: ${branch} is a branch of T1, so only its owning chief pushes it. T1 belongs to chief ${owner} (${provider}), not to ${me}. Nothing changed. Change only your own tasks. To take T1, ask ${owner} to offer it to you, or open a takeover gate for the owner to answer: ${tool === claude ? `run sage gate replace T1 --to ${me} --chief ${me}.` : `call the gate_replace tool with this task and to ${me}`}`;
const providerOf = (tool) => (tool === claude ? "claude" : "codex");

for (const [name, own, other] of pairs) {
  test(`T822: after a takeover from a ${name} chief, the former chief and its agent push nothing to the task's branch, and the owning chief does; a branch with no task, an ended task and a legacy logbook pass`, (t) => {
    const w = pushWorld(t);
    w.sage(own, "link", "--separate");
    const before = own.chiefFor(w.project, SESSION.get(own), w.env), after = other.chiefFor(w.project, SESSION.get(other), w.env);
    assert.deepEqual([before, after], ["C1", "C2"]);
    w.sage(own, "task", "add", "--title", "a", ...ADD, "--chief", before);
    w.sage(own, "task", "T1", "set", "branch=sage/t1-a", "--chief", before);
    const sent = `git -C ${w.tree} push -u origin sage/t1-a`;
    assert.equal(w.push(own, sent), undefined, "the owning chief pushes its task's branch");
    assert.equal(w.push(own, sent, true), undefined, "and so does its agent");
    assert.equal(w.push(other, sent), pushBar(other, "sage/t1-a", before, providerOf(own), after), "a chief that never owned it");
    w.sage(other, "gate", "replace", "T1", "--to", after, "--chief", after);
    w.sage(other, "gate", "answer", "G1", "--option", "1");
    const lost = pushBar(own, "sage/t1-a", after, providerOf(other), before);
    for (const agent of [false, true]) {
      assert.equal(w.push(own, sent, agent), lost, `the former chief${agent ? "'s agent" : ""}`);
      assert.equal(w.push(own, `git -C ${w.tree} push --delete origin sage/t1-a`, agent), lost, "a delete of the branch is a push too");
      assert.equal(w.push(other, sent, agent), undefined, `the owning chief${agent ? "'s agent" : ""}`);
      for (const tool of [own, other]) assert.equal(w.push(tool, `git -C ${w.tree} push origin sage/t9-free`, agent), undefined, "a branch that no task uses");
    }
    w.hook(claude, { hook_event_name: "UserPromptSubmit", prompt: "sage mode", session_id: undefined });
    assert.match(w.push(claude, sent, false, { session_id: undefined }) ?? "passed", /^sage: the hook cannot tell which chief owns sage\/t1-a \(sage has no session identity for this chief/);
    assert.equal(w.push(claude, `git -C ${w.tree} push origin sage/t9-free`, false, { session_id: undefined }), undefined, "a branch that no task uses needs no chief");
    w.sage(other, "run", "add", "T1", "--role", "qa", "--branch", "sage/t1-r", "--chief", after);
    assert.equal(w.push(own, `git -C ${w.tree} push origin sage/t1-r`), pushBar(own, "sage/t1-r", after, providerOf(other), before));
    assert.equal(w.push(other, `git -C ${w.tree} push origin sage/t1-r`), undefined);
    w.sage(other, "task", "T1", "set", "state=abandoned", "--chief", after);
    assert.equal(w.push(own, sent), undefined, "the task has ended");
    assert.match(readFileSync(w.calls, "utf8"), /(?:^|\n)api --hostname github\.com repos\/acme\/project --jq \.default_branch\n[\s\S]*api --hostname/, "the hooks read the default branch from the fake gh");
    const legacy = pushWorld(t);
    legacy.sage(own, "init");
    legacy.sage(own, "task", "add", "--title", "a", ...ADD);
    legacy.sage(own, "task", "T1", "set", "branch=sage/t1-a");
    for (const tool of [own, other]) for (const agent of [false, true]) {
      assert.equal(legacy.push(tool, `git -C ${legacy.tree} push -u origin sage/t1-a`, agent), undefined, "a legacy logbook");
      assert.match(legacy.push(tool, `git -C ${legacy.tree} push --force origin sage/t1-a`, agent) ?? "passed", /^sage: sage mode never force-pushes/, "the hook judges this push");
    }
  });
}

for (const [name, tool] of [["Claude", claude], ["Codex", codex]]) {
  test(`T901: a legacy ${name} logbook with a damaged table: a plain push passes as before, because no shared-push read runs`, (t) => {
    const w = pushWorld(t);
    w.sage(tool, "init");
    w.sage(tool, "task", "add", "--title", "a", ...ADD);
    w.sage(tool, "task", "T1", "set", "branch=sage/t1-a");
    writeFileSync(join(tool.storeDir(w.project, w.env), "findings.tsv"), "");
    for (const hook of [claude, codex]) for (const agent of [false, true]) {
      assert.equal(w.push(hook, `git -C ${w.tree} push -u origin sage/t1-a`, agent), undefined, `${providerOf(hook)}${agent ? "'s agent" : ""}: a legacy logbook`);
      assert.match(w.push(hook, `git -C ${w.tree} push --force origin sage/t1-a`, agent) ?? "passed", /^sage: sage mode never force-pushes/, "the hook judges this push");
    }
  });
}

function autopilot(w, name, on) {
  const [dir, file] = name === "Claude" ? [join(w.env.CLAUDE_CONFIG_DIR, "sage", ".hooks"), "session-a.json"] : [modeDirectory(w.env), `${stateKey({ session_id: "session-a" })}.json`];
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, file), JSON.stringify({ sage: true, autopilot: on }), { mode: 0o600 });
}
function spent(w, rounds) {
  w.owner("task", "add", "--title", "a", ...ADD);
  for (const state of ["briefed", "building", "reviewing"]) w.owner("task", "T1", "set", `state=${state}`);
  w.owner("run", "add", "T1", "--role", "qa");
  w.owner("run", "done", "R1", "--status", "done", "--tokens", "1");
  for (let n = 1; n <= rounds + 1; n++) {
    if (n > 1) w.owner("finding", "close", "T1", `F-T1-${n - 1}`);
    w.owner("finding", "add", "T1", ...QA);
    w.owner("finding", "triage", "T1", `F-T1-${n}`, "fix");
    if (n <= rounds) assert.match(w.owner("round", "T1"), new RegExp(`^T1 repairing · round ${n} of 3 `));
    if (n <= rounds) w.owner("task", "T1", "set", "state=reviewing");
  }
}
function nextFix(w, n) {
  w.owner("task", "T1", "set", "state=reviewing");
  w.owner("finding", "close", "T1", `F-T1-${n - 1}`);
  w.owner("finding", "add", "T1", ...QA);
  w.owner("finding", "triage", "T1", `F-T1-${n}`, "fix");
}
const decisions = (w) => w.cells("decisions").trim().split("\n").slice(1).map((l) => l.split("\t").slice(1).join("\t"));

for (const [name, own, other] of pairs) {
  test(`T804 ${name}: with autopilot on, the chief gives rounds 4 and 5 with a reason, each in a decision row, and round 6 holds`, (t) => {
    const w = world(t, own, other);
    autopilot(w, name, true);
    spent(w, 3);
    assert.equal(w.owner("round", "T1"), "T1 held: 3 repair rounds did not make it clean. Stop and ask the user.", "an extra round needs a reason");
    assert.equal(w.owner("round", "T1", "--why", "the fix is close: one test left"), "T1 repairing · round 4 of 4 · fix F-T1-4 · re-run qa on the repair's diff", "from the round hold");
    assert.equal(row(w.cells("tasks"), "T1").hold, "");
    assert.deepEqual(decisions(w).slice(-1), ["T1\tround 4 given by C1 on autopilot\tthe fix is close: one test left"]);
    nextFix(w, 5);
    assert.equal(w.owner("round", "T1", "--why", "a new edge case"), "T1 repairing · round 5 of 5 · fix F-T1-5 · re-run qa on the repair's diff", "from reviewing");
    assert.deepEqual(decisions(w).slice(-1), ["T1\tround 5 given by C1 on autopilot\ta new edge case"]);
    nextFix(w, 6);
    assert.equal(w.owner("round", "T1", "--why", "one more"), "T1 held: 5 repair rounds did not make it clean. Stop and ask the user.");
    assert.throws(() => w.owner("round", "T1", "--why", "one more"), { message: "T1 stays held: round 6 is past the 5 rounds that the chief may give, so only the owner's gate gives round 6. Nothing changed." });
    assert.equal(row(w.cells("tasks"), "T1").extra, "2");
    assert.equal(decisions(w).filter((d) => / on autopilot\t/.test(d)).length, 2, "no row for round 6");
  });

  test(`T804 ${name}: with autopilot off, round 4 holds as before, also with a reason, and a reason from the hold changes nothing`, (t) => {
    const w = world(t, own, other);
    autopilot(w, name, false);
    spent(w, 3);
    assert.equal(w.owner("round", "T1", "--why", "the fix is close"), "T1 held: 3 repair rounds did not make it clean. Stop and ask the user.");
    const before = w.tables();
    assert.throws(() => w.owner("round", "T1", "--why", "the fix is close"), { message: "T1 stays held: autopilot is off for this chief's session, so only the owner's gate gives round 4. Nothing changed." });
    assert.throws(() => w.owner("round", "T1"), /T1 is held\. A repair starts from reviewing, verifying or repairing, or from this round hold with round T1 --why "<reason>" while autopilot is on\./);
    assert.equal(w.tables(), before);
    assert.equal(row(w.cells("tasks"), "T1").state, "held");
  });

  test(`T804 ${name}: autopilot on in another chief's session gives this chief no extra round, and a lead never gives one`, (t) => {
    const w = world(t, own, other);
    const [dir, file] = name === "Claude" ? [modeDirectory(w.env), `${stateKey({ session_id: "session-b" })}.json`] : [join(w.env.CLAUDE_CONFIG_DIR, "sage", ".hooks"), "session-b.json"];
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, file), JSON.stringify({ sage: true, autopilot: true }), { mode: 0o600 });
    spent(w, 3);
    autopilot(w, name, false);
    w.owner("run", "add", "T1", "--role", "lead");
    assert.throws(() => w.lead("R2", "round", "T1", "--why", "r"), { message: "only the chief gives an extra repair round, so a lead runs round T1 with no --why. Nothing changed." });
    assert.match(w.owner("round", "T1", "--why", "r"), /^T1 held: 3 repair rounds/, "C2's autopilot is not C1's");
  });

  test(`T804 ${name}: a round of low fix findings only starts, and counts like any round`, (t) => {
    const w = world(t, own, other);
    w.owner("task", "add", "--title", "a", ...ADD);
    for (const state of ["briefed", "building", "reviewing"]) w.owner("task", "T1", "set", `state=${state}`);
    w.owner("run", "add", "T1", "--role", "qa");
    w.owner("finding", "add", "T1", "--source", "qa", "--severity", "low", "--summary", "a typo", "--run", "R1", "--class", "other");
    w.owner("finding", "triage", "T1", "F-T1-1", "fix");
    assert.equal(w.owner("round", "T1"), "T1 repairing · round 1 of 3 · fix F-T1-1 · re-run qa on the repair's diff");
    assert.equal(row(w.cells("tasks"), "T1").round, "1");
  });
}
