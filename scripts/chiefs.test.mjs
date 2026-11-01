// The chiefs of a shared logbook and the one guard (T604): each writer class and each command of the design's table.
// Each shared case runs twice: a Claude chief against a Codex chief, then the other way, so both providers give one result.
import "./test-env.mjs";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
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
}

test("a native writer of a shared logbook names the session's chief, a retry keeps it, and another chief's task refuses", (t) => {
  const w = world(t, codex, claude);
  const task = { project: w.project, owner: "o", request: "00000000-0000-4000-8000-000000000604", title: "a", size: "small", risk: [], add: [], why: "" };
  assert.equal(codex.createRequestedTask(task, w.env, "session-a").task.chief, "C1");
  assert.equal(codex.createRequestedTask(task, w.env, "session-a").decision, "already-created");
  assert.throws(() => codex.createRequestedTask({ ...task, request: "00000000-0000-4000-8000-000000000605" }, w.env), /no session identity/);
  const run = { project: w.project, owner: "o", request: "00000000-0000-4000-8000-000000000606", task: "T1", role: "qa", branch: "", candidate: "" };
  assert.equal(codex.createRequestedRun(run, w.env, "session-a").run.chief, "C1");
  assert.throws(() => codex.createRequestedRun({ ...run, request: "00000000-0000-4000-8000-000000000607" }, w.env, "session-b-of-codex"), /T1 belongs to chief C1/);
  const { version } = codex.readTaskSnapshot({ project: w.project, task: "T1" }, w.env);
  const never = () => { throw Error("an update of another chief reaches no decision"); };
  const update = { project: w.project, owner: "o", request: "00000000-0000-4000-8000-000000000608", task: "T1", version, changes: { title: "b" } };
  assert.throws(() => codex.updateRequestedTask(update, w.env, { native: "session-c", decide: never, acknowledge: never, release: never, void: never, history: never }),
    (e) => e.code === "other-chief");
  let digest;
  const out = codex.updateRequestedTask(update, w.env, { native: "session-a", decide: (value) => { digest = value; return { digest: value, accepted: true, reason: "" }; },
    acknowledge: (value, receiptHash) => ({ digest: value, receiptHash }), release: (value, receiptHash) => ({ digest: value, receiptHash }), void() {}, history: never });
  assert.equal(out.task.title, "b");
  assert.equal(out.task.chief, "C1");
  assert.ok(digest);
  assert.equal(row(w.cells("tasks"), "T1").title, "b");
  assert.equal(row(w.cells("tasks"), "T1").chief, "C1", "the update keeps the chief cell");
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
  assert.equal(w.bash("task T1 set state=building --lead R1", "s1", lead), undefined);
  assert.match(w.bash("task T1 set state=building", "s1", { agent_id: "qa-1", agent_type: "sage:qa" }), /writes the logbook, or is not a read command/);
});
