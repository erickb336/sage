import "./test-env.mjs";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { ROOT } from "./build.mjs";

const SHA = "1".repeat(40);

/** The built plugin's state server in a scratch folder, with a scratch CODEX_HOME and no SAGE_HOME. */
async function connect(t, overrides = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "sage-state-mcp-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(join(ROOT, "plugins/sage-codex"), join(dir, "plugin"), { recursive: true });
  const project = join(dir, "project");
  mkdirSync(project);
  execFileSync("git", ["init", "-q", project]);
  const { SAGE_HOME, ...inherited } = process.env;
  const env = { ...inherited, HOME: join(dir, "home"), CODEX_HOME: join(dir, "codex-home"), SAGE_WORKTREES: join(dir, "worktrees"), ...overrides };
  const child = spawn(process.execPath, [join(dir, "plugin/mcp/state-server.mjs")], { cwd: dir, env, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "", id = 0, calls = 0;
  const { gate: gateOf } = await import(pathToFileURL(join(dir, "plugin/hooks/gate-hook.mjs")).href);
  child.stderr.on("data", (data) => { stderr += data; });
  const closed = new Promise((resolve) => child.once("close", (code) => resolve(code)));
  const pending = new Map();
  createInterface({ input: child.stdout }).on("line", (line) => { const reply = JSON.parse(line); pending.get(reply.id)(reply); });
  const rpc = (method, params) => new Promise((resolve) => {
    pending.set(++id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "codex", version: "0.160.0" } });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  t.after(async () => { child.stdin.end(); assert.equal(await closed, 0); assert.equal(stderr, ""); });
  return {
    dir, project, env,
    tools: async () => (await rpc("tools/list", {})).result.tools,
    /**
     * A tool's text, or { error } with the text of a refusal. As in Codex, the built gate first sees the call as
     * PreToolUse with its id, then the server gets the same id and session in _meta (R1916-2); gate: false skips the gate.
     */
    call: async (name, args = {}, { gate = true, callId = `call_${++calls}` } = {}) => {
      const sessionId = "019a0000-0000-7000-8000-0000000000aa";
      if (gate) assert.equal(await gateOf({ hook_event_name: "PreToolUse", session_id: sessionId, turn_id: "t1", transcript_path: null, cwd: project, model: "m",
        permission_mode: "default", tool_name: `mcp__sage__${name}`, tool_use_id: callId, tool_input: { project, ...args } }, { env }), undefined);
      const reply = await rpc("tools/call", { name, arguments: { project, ...args }, _meta: { callId, sessionId, threadId: sessionId } });
      assert.equal(reply.error, undefined);
      const text = reply.result.content.map((part) => part.text).join("\n");
      return reply.result.isError ? { error: text } : text;
    },
  };
}

test("the state server serves only a call that sage's gate saw: with no hook running, sage records nothing and says why (R1916-2)", async (t) => {
  const s = await connect(t);
  const NO_GATE = "sage's gate is not running: trust sage's hooks with /hooks in the Codex CLI (or the app's hook review), then try again.";
  assert.deepEqual(await s.call("init", {}, { gate: false }), { error: NO_GATE }, "no proof");
  assert.deepEqual(await s.call("status", {}, { gate: false }), { error: NO_GATE }, "a read too");
  assert.equal(existsSync(join(s.env.CODEX_HOME, "sage")), false, "nothing written");
  assert.equal((await s.call("init", {}, { callId: "call_once" })).error, undefined, "the gate saw it");
  assert.equal(existsSync(join(s.env.CODEX_HOME, "sage")), true, "the logbook is made");
  assert.deepEqual(await s.call("init", {}, { gate: false, callId: "call_once" }), { error: NO_GATE }, "a proof serves one call");
  const { writeProof } = await import(pathToFileURL(join(s.dir, "plugin/hooks/gate-hook.mjs")).href);
  writeProof({ tool_use_id: "call_other", session_id: "019a0000-0000-7000-8000-0000000000aa", tool_name: "mcp__sage__status" }, s.env);
  assert.deepEqual(await s.call("init", {}, { gate: false, callId: "call_other" }), { error: NO_GATE }, "a proof of another tool");
});

test("the state server lists one tool for each state-tool command, and marks only the reads read-only", async (t) => {
  const s = await connect(t);
  const tools = await s.tools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ["brief", "finding_add", "finding_close", "finding_move", "finding_triage", "gate_add", "gate_answer",
    "init", "log", "merge_check", "pages", "round", "run_add", "run_done", "standing", "standing_add", "status", "task_add", "task_adopt", "task_set", "verdict"]);
  assert.deepEqual(tools.filter((tool) => tool.annotations.readOnlyHint).map((tool) => tool.name).sort(), ["merge_check", "standing", "status"]);
  assert.ok(tools.every((tool) => tool.inputSchema.required.includes("project") && tool.inputSchema.additionalProperties === false));
  // T500: a task_add needs its priority, from the scale.
  const add = tools.find((tool) => tool.name === "task_add").inputSchema;
  assert.deepEqual([add.required.sort(), add.properties.priority.enum], [["priority", "project", "size", "title"], ["P0", "P1", "P2", "P3"]]);
});

test("T48: task_adopt and approved repair reach the shared rule through Codex MCP", async t => {
  const bin = mkdtempSync(join(tmpdir(), 'sage-adoption-mcp-'));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  const fake = join(bin, 'gh');
  writeFileSync(fake, `#!${process.execPath}\nif (process.argv[2] === '--fake-proof') console.log('FAKE_mcp_adoption'); else if (process.argv.slice(2).join(' ') === 'pr view 362 --json headRefName,isCrossRepository') console.log(JSON.stringify({ headRefName: 'sage/t536-adopt', isCrossRepository: false })); else process.exit(1);\n`);
  chmodSync(fake, 0o755);
  assert.equal(spawnSync(fake, ['--fake-proof'], { encoding: 'utf8' }).stdout.trim(), 'FAKE_mcp_adoption');
  const s = await connect(t, { PATH: `${bin}:${process.env.PATH}` });
  const { tool } = await import(pathToFileURL(join(s.dir, 'plugin/skills/sage/sage.mjs')).href);
  const sourceEnv = { ...s.env, SAGE_HOME: join(s.dir, 'claude', 'sage') };
  const source = tool.command(['init', '--project', s.project], sourceEnv).text.slice(8);
  assert.equal(tool.command(['task', 'add', '--title', 'Source', '--size', 'small', '--risk', 'auth', '--priority', 'P0', '--project', s.project], sourceEnv).code, 0);
  const tasks = join(source, 'tasks.tsv'), rows = readFileSync(tasks, 'utf8').trimEnd().split('\n');
  const cols = rows[0].split('\t'), values = rows[1].split('\t');
  for (const [key, value] of Object.entries({ id: 'T536', pr: '362', round: '4', state: 'reviewing' })) values[cols.indexOf(key)] = value;
  writeFileSync(tasks, `${rows[0]}\n${values.join('\t')}\n`);
  const before = readFileSync(tasks, 'utf8');
  const dest = (await s.call('init')).slice(8);
  await s.call('task_add', { title: 'Destination', size: 'small', priority: 'P0', risk: 'auth' });
  const args = { task: 'T1', 'source-logbook': source, 'source-provider': 'claude', 'source-task': 'T536', pr: '362', branch: 'sage/t536-adopt' };
  assert.equal(await s.call('task_adopt', args), 'T1 adopted · claude T536 · PR 362 · sage/t536-adopt · round 4; fresh destination reviews and QA required');
  assert.equal(tool.read(dest, 'tasks')[0].round, '4');
  assert.equal(readFileSync(tasks, 'utf8'), before);
  assert.match(await s.call('task_set', { task: 'T1', fields: { branch: 'sage/t536-adopt', state: 'briefed' } }), /T1 briefed.*round 4/);
  assert.match((await s.call('merge_check', { sha: SHA, pr: 362, head: 'sage/t536-adopt' })).error, /no verdicts/);
  for (const state of ['building', 'reviewing']) await s.call('task_set', { task: 'T1', fields: { state } });
  const run = (await s.call('run_add', { task: 'T1', role: 'qa' })).split(' ')[0];
  await s.call('run_done', { run, status: 'done', tokens: 1 });
  await s.call('finding_add', { task: 'T1', source: 'qa', severity: 'medium', summary: 'Repair needed', run, class: 'state-edge' });
  assert.match(await s.call('finding_triage', { task: 'T1', key: 'F-T1-1', decision: 'fix' }), /open · fix/);
  assert.match(await s.call('round', { task: 'T1' }), /held: 4 repair rounds/);
  assert.match((await s.call('task_set', { task: 'T1', fields: { state: 'building' } })).error, /approval/);
  await s.call('gate_add', { task: 'T1', question: 'Approve one more repair round for T1 after 4 spent rounds and limit 3?', options: 'approve|decline', recommend: 'approve' });
  await s.call('gate_answer', { gate: 'G1', option: 1 });
  assert.match(await s.call('task_set', { task: 'T1', fields: { state: 'building', approval: 'G1' } }), /T1 building.*round 4/);
  assert.equal(tool.read(dest, 'tasks')[0].extra, '2');
  await s.call('task_set', { task: 'T1', fields: { state: 'reviewing' } });
  assert.match(await s.call('round', { task: 'T1' }), /round 5 of 5/);
  await s.call('task_set', { task: 'T1', fields: { state: 'reviewing' } });
  assert.match(await s.call('round', { task: 'T1' }), /held: 5 repair rounds/);
  assert.match((await s.call('task_set', { task: 'T1', fields: { state: 'building', approval: 'G1' } })).error, /approval/);
});

test("each tool writes the Codex logbook in CODEX_HOME/sage, and returns each refusal as a tool error with its reason", async (t) => {
  const s = await connect(t);
  const call = s.call;
  assert.match((await call("status")).error, /^sage: no logbook for the project .*project\. Run: sage init --project /);
  const logbook = (await call("init")).replace(/^logbook /, "");
  assert.match(logbook, new RegExp(`^${s.env.CODEX_HOME}/sage/project-[0-9a-f]{6}$`));
  assert.match(await call("status"), /^sage · project · \d\d:\d\d UTC\ntasks {3}0\n/);
  assert.match((await call("init", { project: "relative/path" })).error, /^Input validation error: .*project: an absolute path/);

  // A value that starts with -- stays a value: it is not read as an option of the command.
  assert.equal(await call("task_add", { title: "--why=x first", size: "small", priority: "P2" }), "T1 framed · small · route build,code-review,qa · P2");
  assert.match(readFileSync(join(logbook, "tasks.tsv"), "utf8"), /\nT1\t--why=x first\t/);
  assert.equal((await call("task_add", { title: "bad", size: "small", risk: "bogus", priority: "P2" })).error,
    "sage: unknown: bogus. Risks: auth, data, schema, money, secrets, input. Blocks: design, arena, pe, build, code-review, security-review, ux-review, qa, investigate, evidence-review");
  assert.match((await call("task_add", { title: "bad", size: "huge", priority: "P2" })).error, /^Input validation error: .*size/);
  assert.match((await call("task_add", { title: "bad", size: "small", colour: "red", priority: "P2" })).error, /^Input validation error: .*colour/);
  // T500: the tool needs a priority from the scale, and its refusal says the scale in the state tool's words.
  const scale = "A task needs a priority: P0 the owner's current focus and what blocks it; P1 next: function or safety bugs, work in flight, pre-pilot items; P2 later: polish, hardening lows, follow-ups; P3 parked but kept.";
  for (const input of [{ title: "none", size: "small" }, { title: "bad", size: "small", priority: "P4" }]) {
    const { error } = await call("task_add", input);
    assert.match(error, /^Input validation error: .*priority/);
    assert.ok(error.includes(scale), error);
  }
  assert.doesNotMatch(readFileSync(join(logbook, "tasks.tsv"), "utf8"), /\nT2\t/);
  assert.equal(await call("task_set", { task: "T1", fields: { priority: "none" } }).then((r) => r.error), `sage: ${scale} T1 is framed, so its priority does not clear: set another one. Nothing changed.`);

  assert.equal((await call("task_set", { task: "T1", fields: { state: "merged" } })).error, "sage: T1 cannot go from framed to merged. Next: designing, briefed");
  assert.equal(await call("task_set", { task: "T1", fields: { state: "briefed", branch: "codex/t1-a" } }), "T1 briefed · small · round 0 · route build,code-review,qa · codex/t1-a · P2");

  assert.match((await call("run_add", { task: "T1", role: "boss" })).error, /^sage: "boss" is not a role of a run\./);
  assert.equal(await call("run_add", { task: "T1", role: "lead", branch: "codex/t1-a" }), "R1 running · lead on T1 · codex/t1-a");
  assert.equal(await call("run_done", { run: "R1", status: "done" }), "R1 done");
  assert.match((await call("run_done", { run: "R1", status: "failed" })).error, /^sage: R1 already ended as done: a run ends once\./);
  assert.match(readFileSync(join(logbook, "runs.tsv"), "utf8"), /\nR1\tT1\tlead\t/);

  await call("task_set", { task: "T1", fields: { state: "building" } });
  await call("task_set", { task: "T1", fields: { state: "reviewing" } });
  assert.equal((await call("finding_add", { task: "T9", source: "code-reviewer", severity: "medium", summary: "x" })).error, "sage: no task T9. The latest: T1.");
  // A review or QA finding needs its run and class (T490): the tool takes both, and returns the refusal without them.
  for (const role of ["code-reviewer", "qa"]) await call("run_add", { task: "T1", role }); // R2, R3
  for (const run of ["R2", "R3"]) await call("run_done", { run, status: "done", tokens: 1 });
  assert.equal((await call("finding_add", { task: "T1", source: "code-reviewer", severity: "medium", summary: "a.js:1 bad", run: "R2" })).error,
    "sage: code-reviewer is a review or QA role, so finding add needs --run with the run whose report holds the finding and --class with one of state-edge, speed, copy, layout, security, other; it lacks --class. Nothing changed.");
  assert.equal(await call("finding_add", { task: "T1", source: "code-reviewer", severity: "medium", summary: "a.js:1 bad", run: "R2", class: "state-edge" }), "F-T1-1 open · medium · T1");
  assert.match(readFileSync(join(logbook, "findings.tsv"), "utf8"), /\nT1\tF-T1-1\t0\tcode-reviewer\tmedium\ta\.js:1 bad\t\t\topen\tR2\tstate-edge\n/);
  assert.equal((await call("finding_triage", { task: "T1", key: "F-T1-1", decision: "dismiss" })).error, "sage: missing --reason for a dismissal");
  assert.equal(await call("finding_triage", { task: "T1", key: "F-T1-1", decision: "fix" }), "F-T1-1 open · fix");
  assert.equal(await call("round", { task: "T1" }), "T1 repairing · round 1 of 3 · fix F-T1-1 · re-run code-reviewer on the repair's diff");
  assert.match((await call("round", { task: "T9" })).error, /^sage: no task T9/);
  assert.equal((await call("finding_close", { task: "T1", key: "F-T1-9" })).error, "sage: no finding F-T1-9 on T1. The latest: F-T1-1.");
  assert.equal(await call("finding_close", { task: "T1", key: "F-T1-1" }), "F-T1-1 closed · fix");
  await call("finding_add", { task: "T1", source: "qa", severity: "high", summary: "b.js:2 crash", run: "R3", class: "state-edge" });
  assert.match((await call("finding_move", { task: "T1", key: "F-T1-2", to: "Follow up" })).error, /^sage: F-T1-2 is high, so it blocks T1 until it is fixed/);
  await call("finding_add", { task: "T1", source: "qa", severity: "low", summary: "c.js:3 slow", run: "R3", class: "speed" });
  assert.equal(await call("finding_move", { task: "T1", key: "F-T1-3", to: "Follow up" }), "F-T1-3 moved to T2 as F-T2-1 · T2 framed · small · route build,code-review,qa · P2");

  assert.match((await call("verdict", { task: "T1", kind: "checks-pass", sha: "abc" })).error, /^sage: "abc" is not a full commit SHA/);
  assert.equal(await call("verdict", { task: "T1", kind: "checks-pass", sha: SHA }), "T1 checks-pass · 1111111 · cycle 1");
  assert.match(readFileSync(join(logbook, "ledger.tsv"), "utf8"), new RegExp(`\\nT1\\t\\t${SHA}\\tchecks-pass\\t1\\t`));
  assert.equal((await call("merge_check", { sha: SHA })).error, "sage: T1 has open findings: F-T1-2. Triage and close them first.");

  assert.equal(await call("log", { task: "T1", decision: "T1 kept", why: "a test" }), "logged");
  assert.match((await call("log", { task: "T1", decision: "--why=x", why: "y" })).error, /^Input validation error: .*does not start with --/);
  assert.match(await call("standing"), /^# Standing orders\n/);
  assert.equal(await call("standing_add", { order: "Run the checks." }), "standing order 5 added");
  assert.match(readFileSync(join(logbook, "standing.md"), "utf8"), /\n5\. Run the checks\.\n$/);
  assert.equal((await call("standing_add", { order: "" })).error, "sage: missing the order's text");

  const pages = await call("pages", { task: "T1" });
  assert.match(pages, new RegExp(`^${s.env.SAGE_WORKTREES}/project-[0-9a-f]{6}/pages/T1$`));
  writeFileSync(join(pages, "plan.md"), "# Plan\n");
  assert.match(await call("pages", { task: "T1", record: join(pages, "plan.md") }), /plan\.md/);
  assert.match((await call("pages", { task: "T1", record: join(s.dir, "elsewhere.md") })).error, /^sage: .*elsewhere\.md is not a file in .*pages\/T1\. Save the page there first\./);

  assert.match((await call("gate_add", { task: "T1", question: "Ship it?", options: "yes|no", recommend: "maybe" })).error, /^sage: --recommend is one of the options/);
  assert.equal(await call("gate_add", { task: "T1", question: "Ship it?", options: "yes|no", recommend: "yes" }), "G1 open · Ship it?");
  assert.match((await call("gate_answer", { gate: "G1", option: 9 })).error, /^sage: gate answer G1 takes --option <n>/);
  assert.equal(await call("gate_answer", { gate: "G1", option: 1 }), "G1 answered · yes");
});

test("brief checks a brief's fields, keeps it by task name in the logbook, and the start note reads it back (T462)", async (t) => {
  const s = await connect(t);
  const fields = ["GOAL", "SCOPE", "CONTEXT", "DECISIONS", "ACCEPTANCE", "VERIFY", "BUDGET", "FORBIDDEN", "REPORT", "STANDING"];
  const text = (skip = []) => fields.filter((f) => !skip.includes(f)).map((f) => `${f}\nThe ${f.toLowerCase()} of T1.`).join("\n\n");
  assert.match((await s.call("brief", { task_name: "sage_implementer_t1", brief: text() })).error, /^sage: no logbook for the project .*project\. Run init first\.$/);
  const logbook = (await s.call("init")).replace(/^logbook /, "");
  assert.equal((await s.call("brief", { task_name: "sage_implementer_t1", brief: text(["VERIFY"]) })).error,
    "sage: the brief of sage_implementer_t1 has no VERIFY. Every brief has all of GOAL, SCOPE, CONTEXT, DECISIONS, ACCEPTANCE, VERIFY, BUDGET, FORBIDDEN, REPORT, STANDING, each at the start of a line that is not in a list or a code block, with a colon, two spaces or a tab after its name (GOAL: …, GOAL   …), or its name alone on the line. Add them, then run brief again.");
  // Each form that the message names passes (R1713-2): a colon, two spaces, a tab, and the name alone.
  for (const [form, after] of [["colon", ": "], ["spaces", "  "], ["tab", "\t"]]) {
    const brief = fields.map((f) => `${f}${after}The ${f.toLowerCase()} of T1.`).join("\n");
    assert.equal(await s.call("brief", { task_name: "sage_implementer_t2", brief }), "brief sage_implementer_t2 checked: all 10 fields. Spawn the agent with this task name and this brief.", form);
  }
  assert.equal(await s.call("brief", { task_name: "sage_implementer_t1", brief: text() }), "brief sage_implementer_t1 checked: all 10 fields. Spawn the agent with this task name and this brief.");
  assert.deepEqual(JSON.parse(readFileSync(join(logbook, "briefs", "sage_implementer_t1.json"), "utf8")), { task: "sage_implementer_t1", text: text() });
  assert.match((await s.call("brief", { task_name: "../x", brief: text() })).error, /^Input validation error: .*sage_, the role with _ for -/);
  assert.match((await s.call("brief", { task_name: "sage_qa_t1", brief: "x".repeat(32 * 1024 + 1) })).error, /^Input validation error: /);
  // A second run of a role on the same task: the run id after the task gives it a new name (R1663-2).
  assert.equal(await s.call("brief", { task_name: "sage_code_reviewer_t1_r12", brief: text() }), "brief sage_code_reviewer_t1_r12 checked: all 10 fields. Spawn the agent with this task name and this brief.");
  assert.match((await s.call("brief", { task_name: "sage_code_reviewer_t1_r", brief: text() })).error, /^Input validation error: .*the task, and the run, for example sage_implementer_t12_r40/);

  // The start note of the child reads the same record (the built hook, with the server's CODEX_HOME).
  const meta = join(s.dir, "child.jsonl");
  writeFileSync(meta, JSON.stringify({ type: "session_meta", payload: { id: "c1", agent_path: "/root/sage_implementer_t1" } }) + "\n");
  const start = { session_id: "s1", turn_id: "t1", transcript_path: meta, cwd: s.project, hook_event_name: "SubagentStart", model: "m", permission_mode: "default", agent_id: "c1", agent_type: "default" };
  const out = JSON.parse(execFileSync(process.execPath, [join(s.dir, "plugin/hooks/brief-hook.mjs")], { input: JSON.stringify(start), env: s.env, encoding: "utf8" }));
  assert.ok(out.hookSpecificOutput.additionalContext.endsWith(`Your checked brief (sage_implementer_t1), as the chief recorded it:\n\n${text()}`));
  assert.match(out.hookSpecificOutput.additionalContext, /\n\nFORBIDDEN, from your checked brief\. Never do these:\nThe forbidden of T1\.\n\n/);
});

test("merge_check passes for a head with its clean cycle", async (t) => {
  const { call } = await connect(t);
  await call("init");
  await call("task_add", { title: "one", size: "tiny", priority: "P1" });
  await call("task_set", { task: "T1", fields: { state: "briefed", branch: "codex/t1-a" } });
  assert.equal((await call("merge_check", { sha: SHA })).error, `sage: no verdicts recorded for ${SHA}. Record the reviews and QA with sage verdict first.`);
  await call("verdict", { task: "T1", kind: "checks-pass", sha: SHA });
  assert.equal(await call("merge_check", { sha: SHA }), "T1 may merge: 1 clean cycle on this SHA");
});

test("merge_check gives the state tool's refusal for a task moved off a shared PR's head branch unchanged, with the branch= that puts it back (R1759-1)", async (t) => {
  const { call } = await connect(t);
  await call("init");
  for (const title of ["one", "two"]) await call("task_add", { title, size: "tiny", priority: "P1" });
  for (const task of ["T1", "T2"]) {
    await call("task_set", { task, fields: { state: "briefed", branch: "codex/t1-a", pr: "41" } });
    await call("verdict", { task, kind: "checks-pass", sha: SHA, pr: 41 });
  }
  assert.match(await call("merge_check", { sha: SHA, pr: 41, head: "codex/t1-a" }), /^2 tasks have verdicts on 1111111 or belong to PR 41, and each must pass/);
  await call("task_set", { task: "T2", fields: { branch: "codex/t2" } });
  const { error } = await call("merge_check", { sha: SHA, pr: 41, head: "codex/t1-a" });
  assert.equal(error.replace(/ \S+ T2,/, " T2,"), `sage: PR 41's head branch "codex/t1-a" is not a branch of T2, so the merge check refuses: each task that is or was on a pull request must own its head branch, a branch named for the task. It is the branch of another task, so set the branch= back to it: sage task T2 set branch=codex/t1-a, or the user lands this pull request.`);
});

test("the chief's setup text sends only read commands to the state CLI, and says that program, which has no tool, does not run in Codex (F-T471-10)", async () => {
  const setup = JSON.parse(readFileSync(join(ROOT, "plugins/sage-codex/chief-bindings.json"), "utf8")).PROJECT_SETUP;
  const { TOOLS } = await import(join(ROOT, "plugins/sage-codex/mcp/state-server.mjs"));
  const cli = setup.split(/(?<=\.) /).filter((sentence) => /state CLI/.test(sentence)).flatMap((sentence) => [...sentence.matchAll(/`([a-z-]+)`/g)].map((m) => m[1]));
  assert.ok(cli.length > 0, setup);
  assert.deepEqual(cli.filter((command) => !["board", "config", "status", "standing", "merge-check", "logbook"].includes(command)), [], "each command it runs through the CLI only reads");
  assert.equal(Object.hasOwn(TOOLS, "program"), false);
  assert.match(setup, /`program` has no tool yet, so programs do not run in Codex/);
});

// R1765 F2: a chief that ended a Codex run with only status done and usage unavailable was refused, and learned the
// fields only from the refusal; until then the open runs held the merge. The tool description and the chief's dispatch
// text each give an example call. The chief saves the report with pages (its sandbox cannot write the pages folder, and
// the hook refuses its apply_patch), then each example, with the run id and the path that pages printed, ends the run.
test("T506: the chief saves a report with pages, and each run_done example ends a Codex run on the first try", async (t) => {
  const s = await connect(t);
  const runDone = (await s.tools()).find((tool) => tool.name === "run_done");
  for (const field of ["usage", "usage-source", "usage-evidence", "report"]) {
    assert.match(runDone.inputSchema.properties[field].description, /needed with usage unavailable|it needs status done/, field);
  }
  const chief = readFileSync(join(ROOT, "plugins/sage-codex/runtime/chief-instructions.md"), "utf8").replace(/\s+/g, " ");
  const examples = { description: runDone.description.match(/for example (\{.*\})\.$/)?.[1], dispatch: chief.match(/`run_done`, no `tokens` and the path that `pages` printed as `report`, for example `(\{.*?\})`/)?.[1] };
  const usageInterface = JSON.parse(`{${chief.match(/`run_add` `("usage-interface": "[a-z-]+")`/)?.[1]}}`)["usage-interface"];
  assert.equal(usageInterface, "collaboration-tools");
  // Step 6 sends a run without a token count to the dispatch step (R1798-2).
  assert.match(chief, /`sage run done` with `--tokens` from the agent's usage \(where the host gives no token count, as \*\*Run the route\*\* says\)/);
  assert.match(chief, /\*\*Run the route\.\*\* [^*]*Codex gives no token count:/);

  const logbook = (await s.call("init")).replace(/^logbook /, "");
  for (const n of [1, 2]) {
    await s.call("task_add", { title: `task ${n}`, size: "small", priority: "P1" });
    await s.call("task_set", { task: `T${n}`, fields: { state: "briefed", branch: `codex/t${n}-a` } });
  }
  // The call of R1765, without source, evidence and report, is refused, and the run stays running.
  assert.equal(await s.call("run_add", { task: "T1", role: "code-reviewer", "usage-interface": usageInterface }), "R1 running · code-reviewer on T1");
  assert.equal(await s.call("run_add", { task: "T2", role: "qa" }), "R2 running · qa on T2");
  assert.equal((await s.call("run_done", { run: "R1", status: "done", usage: "unavailable" })).error,
    "sage: Unavailable usage needs a running run, its unsupported interface snapshot, a report, source and evidence, without tokens. Nothing changed.");

  // pages saves a report only for a run of its task, only with a text, and builds the path itself.
  const folder = join(s.env.SAGE_WORKTREES, basename(logbook), "pages", "T1");
  const report = "STATUS done\nRESULT PASS\n";
  assert.equal((await s.call("pages", { task: "T1", run: "R1", text: " \n" })).error, "sage: --text is the run's whole report, and it is empty. Nothing changed.");
  for (const run of ["R2", "../R1", "R1/../../T2/R1", "R9"]) {
    assert.equal((await s.call("pages", { task: "T1", run, text: report })).error, `sage: --run is a run of T1, for example R7; not ${JSON.stringify(run)}. Nothing changed.`, run);
  }
  assert.deepEqual(readdirSync(folder), [], "a refused save writes no file");

  // Each example ends a run: the dispatch text's ends R1, the description's a new run R3. Then no run of T1 still runs.
  for (const [where, example] of Object.entries(examples)) {
    assert.ok(example, `${where} has an example call`);
    const run = where === "dispatch" ? "R1" : "R3";
    if (run === "R3") assert.equal(await s.call("run_add", { task: "T1", role: "code-reviewer", "usage-interface": usageInterface }), "R3 running · code-reviewer on T1");
    const saved = await s.call("pages", { task: "T1", run, text: `${report}${run}\n` });
    const path = saved.match(/^page (\/.+) · sha256 [0-9a-f]{64}$/)?.[1];
    assert.equal(path, join(folder, `${run}-report.md`), saved);
    assert.equal(readFileSync(path, "utf8"), `${report}${run}\n`);
    // An exact retry gives the same page; another text never replaces a saved report.
    assert.equal(await s.call("pages", { task: "T1", run, text: `${report}${run}\n` }), saved);
    assert.equal((await s.call("pages", { task: "T1", run, text: "STATUS blocked\n" })).error, `sage: ${path} already holds another report of ${run}, and a report is saved once. Nothing changed.`);
    const call = JSON.parse(example);
    assert.equal(call.project, "/absolute/project", `${where} names the project`);
    assert.equal(await s.call("run_done", { ...call, project: s.project, run, report: path }), `${run} done`, where);
  }
  assert.deepEqual(readdirSync(folder).sort(), ["R1-report.md", "R3-report.md"]);
  assert.match(await s.call("status"), /\nagents {2}3 runs · 1 running · about 0k tokens · partial measured total; 0 measured, 2 unavailable, 0 legacy-unrecorded\n/);
});


test("T83 sample investigation and independent evidence check retain real outputs and conclude without SHA", async t => {
  const s = await connect(t);
  const book = (await s.call("init")).slice(8);
  assert.match(await s.call("task_add", { title: "SAMPLE: inspect answer", size: "investigate", priority: "P2" }), /route investigate,evidence-review/);
  for (const state of ["briefed", "building"]) assert.match(await s.call("task_set", { task: "T1", fields: { state } }), new RegExp(`T1 ${state}`));
  const sample = join(s.project, "sample.txt");
  writeFileSync(sample, "answer=42\n");
  const { briefHook } = await import(pathToFileURL(join(s.dir, "plugin/hooks/brief-hook.mjs")));
  const { reportGate } = await import(pathToFileURL(join(s.dir, "plugin/hooks/report-gate.mjs")));
  const ledger = () => readFileSync(join(book, "ledger.tsv"), "utf8");
  const before = ledger();
  let reviewRun;
  for (const role of ["investigate", "evidence-review"]) {
    if (role === "evidence-review") assert.match(await s.call("task_set", { task: "T1", fields: { state: "reviewing" } }), /T1 reviewing/);
    const run = (await s.call("run_add", { task: "T1", role })).split(" ")[0];
    const file = join(s.dir, `${run}-sample-transcript.jsonl`);
    writeFileSync(file, JSON.stringify({ type: "session_meta", payload: { id: `sample-${run}`, agent_path: `/root/sage_${role.replaceAll("-", "_")}_t1_${run.toLowerCase()}` } }) + "\n");
    briefHook({ hook_event_name: "SubagentStart", session_id: "sample-root", transcript_path: file, cwd: s.project }, s.env);
    // Two separate read-only processes: observation, then an independent assertion of the sample's value.
    const code = role === "investigate"
      ? 'process.stdout.write(require("node:fs").readFileSync(process.argv[1], "utf8"))'
      : 'require("node:assert/strict").equal(require("node:fs").readFileSync(process.argv[1], "utf8"), "answer=42\\n"); console.log("PASS answer=42")';
    const check = spawnSync(process.execPath, ["-e", code, sample], { encoding: "utf8", env: s.env });
    assert.equal(check.status, 0, check.stderr);
    const report = `STATUS done\nRESULT ${role === "investigate" ? "answer=42" : "CLEAN"}\nEVIDENCE SAMPLE T1 ${run} ${role}: node -e ${JSON.stringify(code)} ${sample} printed ${JSON.stringify(check.stdout)}\nFINDINGS none\nQUESTIONS none\nNOT VERIFIED installed or native dispatch; synthetic hook events\nBRANCH none\n`;
    assert.deepEqual(reportGate({ hook_event_name: "SubagentStop", stop_hook_active: false, agent_transcript_path: file, cwd: s.project, last_assistant_message: report }, s.env), {});
    assert.equal(JSON.parse(readFileSync(join(book, "kept", `${run}.json`), "utf8")).text, report);
    const page = await s.call("pages", { task: "T1", run, text: report });
    assert.equal(typeof page, "string", JSON.stringify(page));
    const path = join(s.env.SAGE_WORKTREES, basename(book), "pages", "T1", `${run}-report.md`);
    assert.equal(readFileSync(path, "utf8"), report);
    // One token is a sample fixture value, not measured agent usage.
    assert.equal(await s.call("run_done", { run, status: "done", report: path, tokens: 1 }), `${run} done`);
    assert.equal(ledger(), before, "retention and manual records create no verdict");
    reviewRun = run;
  }
  assert.match((await s.call("verdict", { task: "T1", kind: "evidence-clean", run: reviewRun, sha: SHA })).error, /leave out --sha/);
  assert.equal(await s.call("verdict", { task: "T1", kind: "evidence-clean", run: reviewRun }), "T1 evidence-clean · cycle 1");
  for (const state of ["verifying", "concluded"]) assert.match(await s.call("task_set", { task: "T1", fields: { state } }), new RegExp(`T1 ${state}`));
  const { tool } = await import(pathToFileURL(join(s.dir, "plugin/skills/sage/sage.mjs")));
  assert.deepEqual(tool.read(book, "ledger").map(row => [row.task, row.kind, row.run, row.sha]), [["T1", "evidence-clean", reviewRun, ""]]);
  assert.match((await s.call("merge_check", { sha: SHA, pr: 1, head: "codex/sample" })).error, /no verdicts/);
  console.log("T83 SAMPLE: investigate R1 answer=42; independent evidence-review R2 PASS; exact reports retained; chief evidence-clean without SHA; T1 concluded; merge refused");
});

test("T85 synthetic designer prototype, separate PE report and chief artifact records preserve authority", async t => {
  const s = await connect(t);
  const book = (await s.call("init")).slice(8);
  assert.match(await s.call("task_add", { title: "SAMPLE: design review", size: "large", priority: "P2" }), /route design,pe,build/);
  const folder = await s.call("pages", { task: "T1" });
  assert.equal(typeof folder, "string");
  const branch = "codex/t1-sample-design";
  assert.match((await s.call("run_add", { task: "T1", role: "designer" })).error, /designer run needs --branch/);
  assert.match(await s.call("run_add", { task: "T1", role: "designer", branch }), /^R1 running/);
  for (const role of ["designer", "implementer"]) {
    assert.match((await s.call("run_add", { task: "T1", role, branch })).error, /branch has one writer/);
  }
  const prototype = join(folder, "sample-prototype.html");
  const html = '<!doctype html><title>SAMPLE DATA: design fixture</title><h1>SAMPLE DATA</h1><details><summary>Show sample result</summary><p>Sample success</p></details>\n';
  // This fixture writes sample artifacts itself. It does not dispatch a designer or verify a browser screenshot.
  writeFileSync(prototype, html);
  const { briefHook } = await import(pathToFileURL(join(s.dir, "plugin/hooks/brief-hook.mjs")));
  const { reportGate } = await import(pathToFileURL(join(s.dir, "plugin/hooks/report-gate.mjs")));
  const ledger = () => readFileSync(join(book, "ledger.tsv"), "utf8"), before = ledger();
  const retained = [];
  for (const [role, run] of [["designer", "R1"], ["pe", "R2"]]) {
    if (role === "pe") {
      assert.match(await s.call("run_add", { task: "T1", role }), /^R2 running/);
      assert.equal(readFileSync(prototype, "utf8"), html, "PE receives the actual recorded sample artifact");
      assert.equal(readFileSync(join(folder, "R1-report.md"), "utf8"), retained[0]);
    }
    const file = join(s.dir, `${run}-synthetic-transcript.jsonl`);
    writeFileSync(file, JSON.stringify({ type: "session_meta", payload: { id: `sample-${run}`, agent_path: `/root/sage_${role}_t1_${run.toLowerCase()}` } }) + "\n");
    briefHook({ hook_event_name: "SubagentStart", session_id: "sample-root", transcript_path: file, cwd: s.project }, s.env);
    const report = `STATUS done\nRESULT ${role === "designer" ? prototype : "OK: sample artifact contains the agreed example"}\nEVIDENCE SYNTHETIC SAMPLE T1 ${run} ${role}: ${prototype}; fixture reads match saved bytes\nFINDINGS none\nQUESTIONS none\nNOT VERIFIED actual role dispatch, screenshots, installed hooks or owner approval\nBRANCH ${role === "designer" ? branch : "none"}\n`;
    assert.deepEqual(reportGate({ hook_event_name: "SubagentStop", stop_hook_active: false, agent_transcript_path: file, cwd: s.project, last_assistant_message: report }, s.env), {});
    assert.equal(JSON.parse(readFileSync(join(book, "kept", `${run}.json`), "utf8")).text, report);
    assert.match(await s.call("pages", { task: "T1", run, text: report }), /^page /);
    assert.equal(readFileSync(join(folder, `${run}-report.md`), "utf8"), report);
    if (role === "designer") {
      assert.match(await s.call("pages", { task: "T1", record: prototype }), /^page .*sample-prototype\.html · sha256 [0-9a-f]{64}$/);
      assert.equal(readFileSync(prototype, "utf8"), html, "recording preserves the artifact");
    }
    // One token is a sample fixture value, not measured agent usage.
    assert.equal(await s.call("run_done", { run, status: "done", report: join(folder, `${run}-report.md`), tokens: 1 }), `${run} done`);
    assert.match((await s.call("verdict", { task: "T1", kind: "review-clean", sha: SHA, run })).error, /backs no review-clean verdict/);
    assert.equal(ledger(), before, "design reports grant no review verdict or design approval");
    retained.push(report);
  }
  assert.match(await s.call("gate_add", { task: "T1", question: "SAMPLE: approve this design?", options: "approve|change", recommend: "approve" }), /^G1 open/);
  assert.match((await s.call("merge_check", { sha: SHA, pr: 1, head: branch })).error, /no verdicts/);
  // Chief procedure: only a simulated owner answer in this fixture permits its next build step.
  assert.match(await s.call("gate_answer", { gate: "G1", option: "1" }), /G1/);
  assert.match(await s.call("run_add", { task: "T1", role: "implementer", branch }), /^R3 running/);
  assert.equal(await s.call("run_done", { run: "R3", status: "blocked" }), "R3 blocked");
  console.log("T85 SYNTHETIC SAMPLE: designer R1 → recorded prototype/report → separate PE R2 → simulated owner answer → build R3; no verdict; missing-review merge refusal preserved; no installed execution");
});
