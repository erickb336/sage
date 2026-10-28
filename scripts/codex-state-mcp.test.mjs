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

// T54: saving a page and ending a run are separate from the provider's capture
// of the child's report. Exercise the whole MCP flow, without native Codex.
for (const capture of ["none", "start-only", "start-stop", "documented-child", "documented-parent", "documented-null", "delayed-metadata"]) test(`T54: pages and run_done with ${capture} report capture`, async t => {
  const s = await connect(t);
  const git = (...args) => execFileSync("git", ["-C", s.project, "-c", "user.name=test", "-c", "user.email=test@example.com", ...args], { encoding: "utf8" }).trim();
  git("checkout", "-qb", "codex/t1-report");
  git("commit", "--allow-empty", "-qm", "sample review head");
  const head = git("rev-parse", "HEAD");
  const logbook = (await s.call("init")).replace(/^logbook /, "");
  await s.call("task_add", { title: "Sample review", size: "small", priority: "P2" });
  await s.call("task_set", { task: "T1", fields: { state: "briefed", branch: "codex/t1-report" } });
  const run = (await s.call("run_add", { task: "T1", role: "code-reviewer", "usage-interface": "collaboration-tools" })).split(" ")[0];
  const brief = "Run R1 · task T1\n" + ["GOAL", "SCOPE", "CONTEXT", "DECISIONS", "ACCEPTANCE", "VERIFY", "BUDGET", "FORBIDDEN", "REPORT", "STANDING"]
    .map(field => `${field}: Sample ${field.toLowerCase()}.`).join("\n");
  assert.equal(await s.call("brief", { task_name: "sage_code_reviewer_t1_r1", brief }),
    "brief sage_code_reviewer_t1_r1 checked: all 10 fields. Spawn the agent with this task name and this brief.");
  const text = `STATUS done\nRESULT CLEAN\nEVIDENCE sample check passed\nFINDINGS none\nQUESTIONS none\nNOT VERIFIED installed behavior\nBRANCH codex/t1-report; head ${head}`;
  // Sample hook inputs only: never a kept-report file or native receipt.
  // The release contract does not promise the transcript's internal format:
  // https://learn.chatgpt.com/docs/hooks (read 2026-10-28). Test both possible
  // start transcript owners and its documented null value. These are fixture
  // cases, not observations of which transcript the installed host supplies.
  const documented = capture.startsWith("documented-") || capture === "delayed-metadata";
  const bound = ["start-only", "start-stop", "documented-child"].includes(capture);
  const stopped = capture === "start-stop" || documented;
  const transcript = join(s.dir, "sample-child.jsonl");
  const parentTranscript = join(s.dir, "sample-parent.jsonl");
  const parent = "019a0000-0000-7000-8000-0000000000aa";
  const child = "019a0000-0000-7000-8000-0000000000bb";
  writeFileSync(parentTranscript, `${JSON.stringify({ type: "session_meta", payload: { id: parent } })}\n`);
  const role = execFileSync(process.execPath, [join(s.dir, "plugin/skills/sage/role.mjs"), "code-reviewer"], { env: s.env, encoding: "utf8" });
  writeFileSync(transcript, `${JSON.stringify({ type: "session_meta", payload: {
    id: child, agent_path: "/root/sage_code_reviewer_t1_r1",
    ...(capture === "delayed-metadata" ? { session_id: parent, parent_thread_id: parent, cwd: s.project,
      source: { subagent: { thread_spawn: { depth: 1, parent_thread_id: parent, agent_path: "/root/sage_code_reviewer_t1_r1", agent_role: null } } } } : {}),
  } })}\n${documented ? "" : `${JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: `${role}\n\n${brief}` }] } })}\n`}`);
  const common = { session_id: parent, turn_id: "sample-turn", transcript_path: parentTranscript,
    model: "gpt-6.1-sol", permission_mode: "default", agent_id: child, agent_type: "default" };
  const hook = (file, input) => {
    const result = spawnSync(process.execPath, [join(s.dir, "plugin/hooks", file)], {
      input: JSON.stringify({ cwd: s.project, ...common, ...input }), env: s.env, encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  if (capture !== "none") {
    const start = hook("brief-hook.mjs", { hook_event_name: "SubagentStart",
      transcript_path: ["documented-null", "delayed-metadata"].includes(capture) ? null : capture === "documented-parent" ? parentTranscript : transcript });
    if (bound) {
      assert.equal(start.hookSpecificOutput.hookEventName, "SubagentStart");
      assert.ok(start.hookSpecificOutput.additionalContext.endsWith(brief));
    } else if (capture === "documented-parent") assert.deepEqual(start, {});
    else assert.match(start.systemMessage, /could not read what Codex sent it/);
  }
  assert.equal(existsSync(join(logbook, "kept", "R1.child")), bound);
  if (stopped) assert.deepEqual(hook("report-gate.mjs", {
    hook_event_name: "SubagentStop", agent_transcript_path: transcript, stop_hook_active: false, last_assistant_message: text,
  }), bound || capture === "delayed-metadata" ? {} : { systemMessage: "sage: R1's report is not kept: no child started for R1 while it ran, so it backs no verdict." });
  const saved = await s.call("pages", { task: "T1", run, text });
  const report = saved.match(/^page (\/.+) · sha256 [0-9a-f]{64}$/)?.[1];
  assert.ok(report, saved);
  assert.equal(await s.call("run_done", { run, status: "done", usage: "unavailable", "usage-source": "codex collaboration-tools", "usage-evidence": "wait_agent gives no token count", report }), `${run} done`);
  const before = readFileSync(join(logbook, "ledger.tsv"), "utf8");
  const verdict = await s.call("verdict", { task: "T1", run, kind: "review-clean", sha: head, cycle: 1 });
  // Characterize the unsupported cases; this is not a production repair.
  // Start must currently expose the child's session_meta.agent_path. The
  // documented event fields alone provide no task/run correlation.
  if (stopped && (bound || capture === "delayed-metadata")) {
    assert.equal(verdict, `T1 review-clean · ${head.slice(0, 7)} · cycle 1`);
    assert.match(readFileSync(join(logbook, "ledger.tsv"), "utf8"), new RegExp(`\\nT1\\t\\t${head}\\treview-clean\\t1\\tR1\\t`));
  } else {
    assert.match(verdict.error, /^sage: R1 has no kept report:/);
    assert.equal(readFileSync(join(logbook, "ledger.tsv"), "utf8"), before);
    assert.deepEqual(hook("report-gate.mjs", {
      hook_event_name: "SubagentStop", agent_transcript_path: transcript, stop_hook_active: false, last_assistant_message: text,
    }), { systemMessage: !bound
      ? "sage: R1's report is not kept: no child started for R1 while it ran, so it backs no verdict."
      : "sage: R1's report is not kept: R1 ended as done before this stop, so no report is kept." });
    assert.equal(existsSync(join(logbook, "kept", "R1.json")), false);
  }
});

// T54: disposable hook and MCP fixtures. No installed session or logbook is read.
async function delayedFixture(t) {
  const s = await connect(t);
  const git = (...args) => execFileSync("git", ["-C", s.project, "-c", "user.name=test", "-c", "user.email=test@example.com", ...args], { encoding: "utf8" }).trim();
  git("checkout", "-qb", "codex/t1-review");
  git("commit", "--allow-empty", "-qm", "review head");
  const head = git("rev-parse", "HEAD"), root = "019a0000-0000-7000-8000-0000000000aa", child = "019a0000-0000-7000-8000-0000000000bb";
  const other = "019a0000-0000-7000-8000-0000000000cc", name = "sage_code_reviewer_t1_r1";
  const logbook = (await s.call("init")).slice(8);
  await s.call("task_add", { title: "Sample review", size: "small", priority: "P2" });
  await s.call("task_set", { task: "T1", fields: { state: "briefed", branch: "codex/t1-review" } });
  await s.call("run_add", { task: "T1", role: "code-reviewer", "usage-interface": "collaboration-tools" });
  const brief = "Run R1 · task T1\n" + ["GOAL", "SCOPE", "CONTEXT", "DECISIONS", "ACCEPTANCE", "VERIFY", "BUDGET", "FORBIDDEN", "REPORT", "STANDING"]
    .map(field => `${field}: Sample ${field.toLowerCase()}.`).join("\n");
  assert.match(await s.call("brief", { task_name: name, brief }), /checked: all 10 fields/);
  const path = `/root/${name}`;
  const meta = { id: child, session_id: root, parent_thread_id: root, cwd: s.project, agent_path: path,
    source: { subagent: { thread_spawn: { depth: 1, parent_thread_id: root, agent_path: path, agent_role: null } } } };
  const transcript = join(s.dir, "sample.jsonl"), reservation = join(logbook, "briefs", `${name}.reservation.json`);
  const text = `STATUS done\nRESULT CLEAN\nEVIDENCE sample check passed\nFINDINGS none\nQUESTIONS none\nNOT VERIFIED installed behavior\nBRANCH codex/t1-review; head ${head}`;
  const writeMeta = value => writeFileSync(transcript, `${JSON.stringify({ type: "session_meta", payload: value })}\n`);
  const hook = (file, input) => {
    const result = spawnSync(process.execPath, [join(s.dir, "plugin/hooks", file)], { encoding: "utf8", env: s.env,
      input: JSON.stringify({ cwd: s.project, session_id: root, agent_id: child, turn_id: "sample-turn", ...input }) });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const start = fields => hook("brief-hook.mjs", { hook_event_name: "SubagentStart", transcript_path: null, ...fields });
  const stop = fields => hook("report-gate.mjs", { hook_event_name: "SubagentStop", agent_transcript_path: transcript,
    stop_hook_active: false, last_assistant_message: text, ...fields });
  const finish = async (reportText = text) => {
    const page = await s.call("pages", { task: "T1", run: "R1", text: reportText });
    const report = page.match(/^page (\/.+) · sha256 [0-9a-f]{64}$/)?.[1];
    assert.ok(report, page);
    assert.equal(await s.call("run_done", { run: "R1", status: "done", usage: "unavailable", "usage-source": "codex collaboration-tools", "usage-evidence": "sample", report }), "R1 done");
    return s.call("verdict", { task: "T1", run: "R1", kind: "review-clean", sha: head, cycle: 1 });
  };
  writeMeta(meta);
  return { ...s, git, head, root, child, other, name, logbook, brief, meta, transcript, reservation, text, writeMeta, start, stop, finish };
}

const delayedRefusals = [
  ["different metadata child", f => { f.meta.id = f.other; }],
  ["different event child", f => ({ agent_id: f.other })],
  ["different metadata root", f => { f.meta.session_id = f.other; }],
  ["different event root", f => ({ session_id: f.other })],
  ["different immediate parent", f => { f.meta.parent_thread_id = f.other; }],
  ["different source parent", f => { f.meta.source.subagent.thread_spawn.parent_thread_id = f.other; }],
  ["different project in metadata", f => { f.meta.cwd = f.dir; }],
  ["different project in event", f => ({ cwd: f.dir })],
  ["nested path", f => { f.meta.agent_path = `/root/lead/${f.name}`; }],
  ["inconsistent source path", f => { f.meta.source.subagent.thread_spawn.agent_path = "/root/other"; }],
  ["wrong source depth", f => { f.meta.source.subagent.thread_spawn.depth = 2; }],
  ["wrong source", f => { f.meta.source = { subagent: "review" }; }],
  ["wrong task", f => { f.meta.agent_path = "/root/sage_code_reviewer_t2_r1"; f.meta.source.subagent.thread_spawn.agent_path = f.meta.agent_path; }],
  ["wrong run", f => { f.meta.agent_path = "/root/sage_code_reviewer_t1_r2"; f.meta.source.subagent.thread_spawn.agent_path = f.meta.agent_path; }],
  ["wrong role", f => { f.meta.agent_path = "/root/sage_security_reviewer_t1_r1"; f.meta.source.subagent.thread_spawn.agent_path = f.meta.agent_path; }],
  ["missing reservation", f => { rmSync(f.reservation); }],
  ["replaced reservation", f => { const prior = JSON.parse(readFileSync(f.reservation, "utf8")); prior.id = f.other; writeFileSync(f.reservation, JSON.stringify(prior)); }],
  ["replaced brief", f => { writeFileSync(join(f.logbook, "briefs", `${f.name}.json`), JSON.stringify({ task: f.name, text: "other" })); }],
  ["changed head", f => { f.git("commit", "--allow-empty", "-qm", "changed head"); }],
  ["null metadata", f => { f.meta = null; }],
  ["malformed metadata", f => { f.meta = []; }],
];

for (const [label, mutate] of delayedRefusals) test(`T54: delayed binding refuses ${label}`, async t => {
  const f = await delayedFixture(t);
  f.start();
  const fields = mutate(f) ?? {};
  f.writeMeta(f.meta);
  f.stop(fields);
  assert.equal(existsSync(join(f.logbook, "kept", "R1.json")), false, label);
  assert.match((await f.finish()).error, /^sage: R1 has no kept report:/, label);
});

for (const [label, mutate] of [
  ["child", (meta, f) => { meta.id = f.other; }],
  ["root", (meta, f) => { meta.session_id = f.other; }],
  ["parent", (meta, f) => { meta.parent_thread_id = f.other; }],
  ["source path", meta => { meta.source.subagent.thread_spawn.agent_path = "/root/other"; }],
]) test(`T54: contradictory Start ${label} cannot be repaired at Stop`, async t => {
  const f = await delayedFixture(t), startMeta = structuredClone(f.meta);
  mutate(startMeta, f);
  f.writeMeta(startMeta);
  f.start({ transcript_path: f.transcript });
  f.writeMeta(f.meta);
  f.stop();
  assert.match((await f.finish()).error, /^sage: R1 has no kept report:/);
});

test("T54: no metadata at either event remains unavailable and names issue 376", async t => {
  const f = await delayedFixture(t);
  f.start();
  assert.match(f.stop({ agent_transcript_path: null }).systemMessage, /issues\/376/);
  assert.match((await f.finish()).error, /^sage: R1 has no kept report:/);
});

test("T54: a reservation made after Start cannot authorize that child", async t => {
  const f = await delayedFixture(t);
  const saved = readFileSync(f.reservation, "utf8");
  rmSync(f.reservation);
  f.start();
  writeFileSync(f.reservation, saved);
  f.stop();
  assert.match((await f.finish()).error, /^sage: R1 has no kept report:/);
});

test("T54: a checked review brief cannot be replaced under its reservation", async t => {
  const f = await delayedFixture(t);
  assert.match((await f.call("brief", { task_name: f.name, brief: f.brief.replace("Sample goal", "Changed goal") })).error, /already has a different review reservation/);
  assert.match((await f.call("brief", { task_name: f.name, brief: "incomplete" })).error, /already has a different review reservation/);
  f.start();
  assert.deepEqual(f.stop(), {});
  assert.equal(await f.finish(), `T1 review-clean · ${f.head.slice(0, 7)} · cycle 1`);
});

test("T54: a head changed before Start cannot use the earlier reservation", async t => {
  const f = await delayedFixture(t);
  f.git("commit", "--allow-empty", "-qm", "changed before start");
  f.start();
  f.stop();
  assert.match((await f.finish()).error, /^sage: R1 has no kept report:/);
});

test("T54: readable Start metadata cannot replace the reserved head", async t => {
  const f = await delayedFixture(t);
  f.git("commit", "--allow-empty", "-qm", "changed before readable start");
  f.start({ transcript_path: f.transcript });
  f.stop();
  assert.equal(existsSync(join(f.logbook, "kept", "R1.json")), false);
  assert.match((await f.finish()).error, /^sage: R1 has no kept report:/);
});

test("T54: a head changed after readable Start cannot back a new head", async t => {
  const f = await delayedFixture(t);
  f.start({ transcript_path: f.transcript });
  f.git("commit", "--allow-empty", "-qm", "changed after readable start");
  assert.match(f.stop().systemMessage, /the reviewed head changed/);
  assert.equal(existsSync(join(f.logbook, "kept", "R1.json")), false);
  assert.match((await f.finish()).error, /^sage: R1 has no kept report:/);
});

test("T54: a deleted reservation cannot fall back to a readable Start", async t => {
  const f = await delayedFixture(t);
  rmSync(f.reservation);
  f.start({ transcript_path: f.transcript });
  f.stop();
  assert.equal(existsSync(join(f.logbook, "kept", "R1.json")), false);
  assert.match((await f.finish()).error, /^sage: R1 has no kept report:/);
});

test("T54: a live delayed report cannot be captured after the run ends", async t => {
  const f = await delayedFixture(t);
  f.start();
  assert.match((await f.finish()).error, /^sage: R1 has no kept report:/);
  assert.match(f.stop().systemMessage, /no child started/);
  assert.equal(existsSync(join(f.logbook, "kept", "R1.json")), false);
});

test("T54: a competing child cannot replace the first delayed report", async t => {
  const f = await delayedFixture(t);
  f.start();
  f.start({ agent_id: f.other });
  assert.deepEqual(f.stop(), {});
  f.meta.id = f.other;
  f.writeMeta(f.meta);
  assert.match(f.stop({ agent_id: f.other }).systemMessage, /not the child that started/);
  assert.equal(await f.finish(), `T1 review-clean · ${f.head.slice(0, 7)} · cycle 1`);
});

test("T54: a reused child identity cannot change its Start observation", async t => {
  const f = await delayedFixture(t);
  f.start();
  f.start({ turn_id: "another-turn" });
  f.stop();
  assert.match((await f.finish()).error, /^sage: R1 has no kept report:/);
});

test("T54: an incomplete delayed report is blocked and a complete report can follow", async t => {
  const f = await delayedFixture(t);
  f.start();
  assert.equal(f.stop({ last_assistant_message: "STATUS done\nRESULT CLEAN" }).decision, "block");
  assert.equal(existsSync(join(f.logbook, "kept", "R1.json")), false);
  assert.deepEqual(f.stop(), {});
  assert.equal(await f.finish(), `T1 review-clean · ${f.head.slice(0, 7)} · cycle 1`);
});

test("T54: a conflicting delayed report cannot replace the first report", async t => {
  const f = await delayedFixture(t);
  f.start();
  assert.deepEqual(f.stop(), {});
  assert.match(f.stop({ last_assistant_message: f.text.replace("sample check passed", "different check") }).systemMessage, /already has a kept report/);
  assert.equal(await f.finish(), `T1 review-clean · ${f.head.slice(0, 7)} · cycle 1`);
});

test("T54: a delayed report with a finding cannot back a clean verdict", async t => {
  const f = await delayedFixture(t);
  const text = f.text.replace("FINDINGS none", "FINDINGS\n- T1-1 medium sample problem");
  f.start();
  assert.deepEqual(f.stop({ last_assistant_message: text }), {});
  assert.match((await f.finish(text)).error, /report has 1 medium or high finding/);
});

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
