// The Codex report gate and the role text script, run as Codex runs them: JSON on stdin, JSON on stdout.
// The input shape is a SubagentStop input that stock Codex 0.160.0 sent in run R1648 (paths replaced).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const GATE = join(ROOT, "plugins/sage-codex/hooks/report-gate.mjs");
const ROLE = join(ROOT, "plugins/sage-codex/skills/sage/role.mjs");
const TOOL = join(ROOT, "plugins/sage-codex/skills/sage/sage.mjs");
const BRIEF_HOOK = join(ROOT, "plugins/sage-codex/hooks/brief-hook.mjs");
const FULL = "STATUS done\nRESULT PASS\nEVIDENCE echo ok printed ok\nFINDINGS none\nQUESTIONS none\nNOT VERIFIED none\nBRANCH none";
const UNREAD = { systemMessage: "sage: the report check could not read this agent's stop, so it did not check its report." };
const BLOCK = { decision: "block", reason: 'sage: your report has no EVIDENCE, FINDINGS, QUESTIONS, NOT VERIFIED, BRANCH. End with the sage report: STATUS, RESULT, EVIDENCE, FINDINGS, QUESTIONS, NOT VERIFIED, BRANCH, each at the start of a line that is not in a list or a code block, with "none" where a field has nothing.' };

const dir = mkdtempSync(join(tmpdir(), "sage-report-gate-"));
test.after(() => rmSync(dir, { recursive: true, force: true }));
/** A child transcript as Codex writes it: a session_meta line with the agent path, then items. */
function transcript(agentPath) {
  const file = join(dir, `${agentPath.replaceAll("/", "_")}.jsonl`);
  writeFileSync(file, [{ timestamp: "2026-10-25T09:39:59.000Z", type: "session_meta", payload: { id: "01a1726e-61b6-7a01-a9bb-7a01f6164881", agent_path: agentPath, agent_nickname: "Lorentz", source: { subagent: { thread_spawn: { depth: 1, agent_path: agentPath, agent_role: null } } } } },
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "STATUS done" }] } }].map((row) => JSON.stringify(row)).join("\n") + "\n");
  return file;
}
const stop = (fields) => ({ session_id: "01a1726e-6149-7c53-b2c2-24302efa1ced", turn_id: "01a1726e-61d5-7183-8dd7-d4c0edc9fd41",
  transcript_path: join(dir, "root.jsonl"), agent_transcript_path: transcript("/root/sage_implementer_t1"), cwd: dir,
  hook_event_name: "SubagentStop", model: "gpt-6.1-sol", permission_mode: "bypassPermissions", stop_hook_active: false,
  agent_id: "01a1726e-61b6-7a01-a9bb-7a01f6164881", agent_type: "default", last_assistant_message: "STATUS done\nRESULT PASS", ...fields });
/** Codex's homes in the test folder, so that no gate run reads or writes the real ~/.codex (order 42). */
const ENV = { ...process.env, HOME: join(dir, "home"), CODEX_HOME: join(dir, "codex-home") };
function gate(input) {
  const r = spawnSync("node", [GATE], { input: typeof input === "string" ? input : JSON.stringify(input), encoding: "utf8", env: ENV });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test("a sage agent's report with every field passes", () => {
  assert.deepEqual(gate(stop({ last_assistant_message: FULL })), {});
});

test("a sage agent's report without fields continues once, with the missing fields", () => {
  assert.deepEqual(gate(stop({})), BLOCK);
  assert.deepEqual(gate(stop({ last_assistant_message: null })), { ...BLOCK, reason: BLOCK.reason.replace("no EVIDENCE", "no STATUS, RESULT, EVIDENCE") });
});

test("a second miss stops the agent with one plain line", () => {
  assert.deepEqual(gate(stop({ stop_hook_active: true })), { systemMessage: "sage: the agent sage_implementer_t1 ended without a full report (no EVIDENCE, FINDINGS, QUESTIONS, NOT VERIFIED, BRANCH). The chief reads it as it is." });
});

test("a task name with a run, or a sage_ name in another letter case, gets the report check too (R1663-2, R1664-6)", () => {
  for (const path of ["/root/sage_code_reviewer_t12_r40", "/root/Sage_QA_T1", "/root/SAGE_implementer_t01"]) {
    assert.deepEqual(gate(stop({ agent_transcript_path: transcript(path) })), BLOCK, path);
  }
});

test("T483: the chief's review child keeps its report with the head that the gate saw, and only that report backs the run's verdict in the Codex state tool", () => {
  // A project with T1 on its branch: the gate reads the branch's head at the stop, as the Claude hook does (R1908-1).
  const project = realpathSync(mkdtempSync(join(dir, "project-")));
  const git = (...args) => spawnSync("git", ["-C", project, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8" }).stdout.trim();
  git("init", "-q", "-b", "codex/t12-a");
  git("commit", "-q", "--allow-empty", "-m", "work");
  let head = git("rev-parse", "HEAD");
  const sage = (...args) => spawnSync("node", [TOOL, ...args, "--project", project], { encoding: "utf8", env: ENV });
  const ok = (...args) => { const r = sage(...args); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  ok("init");
  // T12 and runs from R40: ids of more than one digit, as real ones are (R1933-2).
  for (let k = 1; k <= 12; k++) ok("task", "add", "--priority", "P2", "--title", `t${k}`, "--size", "small");
  for (let k = 1; k < 40; k++) ok("run", "add", "T1", "--role", "pe");
  ok("task", "T12", "set", "branch=codex/t12-a");
  const clean = "STATUS done\nRESULT CLEAN\nEVIDENCE npm test passed\nFINDINGS none\nQUESTIONS none\nNOT VERIFIED none\nBRANCH codex/t12-a";
  let threads = 0;
  // A child's start (the brief hook binds the run to the chief's direct child) and its stop (the gate keeps its report).
  const child = (path, thread = `01a1726e-0000-7000-8000-${String(++threads).padStart(12, "0")}`) => {
    const file = join(dir, `child-${threads}-${path.replaceAll("/", "_")}.jsonl`);
    writeFileSync(file, JSON.stringify({ type: "session_meta", payload: { id: thread, agent_path: path } }) + "\n");
    return file;
  };
  const begin = (file) => assert.equal(spawnSync("node", [BRIEF_HOOK], { input: JSON.stringify({ hook_event_name: "SubagentStart", session_id: "s", transcript_path: file, cwd: project }), encoding: "utf8", env: ENV }).status, 0);
  const end = (file, message = clean) => gate(stop({ agent_transcript_path: file, cwd: project, last_assistant_message: message }));
  const verdict = (run, sha = head) => sage("verdict", "T12", "--kind", "review-clean", "--sha", sha, "--run", run);
  const run = () => ok("run", "add", "T12", "--role", "code-reviewer").split(" ")[0];
  // The bound child's report, with no SHA of its own, backs review-clean on the head that the gate saw.
  assert.equal(run(), "R40", "the runs have two-digit ids");
  ok("run", "done", "R40", "--status", "done", "--tokens", "1");
  const kept = run(), mine = child(`/root/sage_code_reviewer_t12_${kept.toLowerCase()}`);
  begin(mine);
  assert.deepEqual(end(mine), {});
  ok("run", "done", kept, "--status", "done", "--tokens", "1");
  assert.equal(verdict(kept).status, 0, "the kept CLEAN report backs review-clean on the head");
  // The branch moves during the review: the tip at the start is not the head at the stop, so the gate keeps no commit,
  // and a report whose BRANCH names no full SHA backs no verdict on the new head (R1933-1).
  const moved = run(), during = child(`/root/sage_code_reviewer_t12_${moved.toLowerCase()}`);
  begin(during);
  git("commit", "-q", "--allow-empty", "-m", "pushed during the review");
  const newer = git("rev-parse", "HEAD");
  assert.deepEqual(end(during), {});
  ok("run", "done", moved, "--status", "done", "--tokens", "1");
  assert.match(verdict(moved, newer).stderr, new RegExp(`^sage: ${moved}'s report names no full 40-character head SHA in BRANCH, and the hook saw none`), "the new head is not the reviewed commit");
  head = newer; // the reviews below start on the new head
  // A child of a child with the run's name binds nothing and keeps nothing; the real child's report stays its own (R1908-3).
  const nested = run(), sub = child(`/root/sage_qa_t12_r1/sage_code_reviewer_t12_${nested.toLowerCase()}`), real = child(`/root/sage_code_reviewer_t12_${nested.toLowerCase()}`);
  begin(sub);
  begin(real);
  assert.deepEqual(end(sub, clean.replace("CLEAN", "PASS")), {});
  assert.deepEqual(end(real, "STATUS done\nRESULT FINDINGS\nEVIDENCE x\nFINDINGS\n- K1 high a.js:1 data loss\nQUESTIONS none\nNOT VERIFIED none\nBRANCH codex/t12-a"), {});
  ok("run", "done", nested, "--status", "done", "--tokens", "1");
  assert.match(verdict(nested).stderr, /report has 1 medium or high finding/, "the canned PASS of the sub-child was not kept");
  // Another thread with the same task name: its report is not kept, and the gate says so to the chief.
  const twice = run(), first = child(`/root/sage_code_reviewer_t12_${twice.toLowerCase()}`), second = child(`/root/sage_code_reviewer_t12_${twice.toLowerCase()}`);
  begin(first);
  begin(second);
  assert.deepEqual(end(second), { systemMessage: `sage: ${twice}'s report is not kept: this agent is not the child that started for ${twice}, so it backs no verdict.` });
  assert.deepEqual(end(first), {}, "the bound child's report is kept");
  assert.match(end(first, clean.replace("npm test passed", "a second stop")).systemMessage ?? "", /^sage: R\d+'s report is not kept: (?!this agent)/, "a second report of the bound child is refused, and said");
  // No start, no run in the task name, another role or task, or a first stop without the full report: nothing is kept.
  for (const [why, name, message, start = true] of [["no start", "sage_code_reviewer_t12_<R>", clean, false], ["no run in the task name", "sage_code_reviewer_t1", clean],
    ["another role in the task name", "sage_implementer_t12_<R>", clean], ["another task in the task name", "sage_code_reviewer_t2_<R>", clean],
    ["a first stop without the full report", "sage_code_reviewer_t12_<R>", "STATUS done\nRESULT CLEAN"]]) {
    const id = run(), file = child(`/root/${name.replace("<R>", id.toLowerCase())}`);
    if (start) begin(file);
    gate(stop({ agent_transcript_path: file, cwd: project, last_assistant_message: message }));
    ok("run", "done", id, "--status", "done", "--tokens", "1");
    assert.match(verdict(id).stderr, new RegExp(`^sage: ${id} has no kept report`), why);
  }
});

test("T483 R1933-2: a review child's task name gives its role, task and run, also for ids of many digits", async () => {
  const { reviewChild } = await import(pathToFileURL(GATE));
  const of = (name, path = `/root/${name}`) => reviewChild({ id: "thread-1", agent_path: path });
  assert.deepEqual(of("sage_code_reviewer_t483_r1932"), { role: "code-reviewer", task: "T483", run: "R1932", thread: "thread-1" });
  assert.deepEqual(of("sage_qa_t12_r40"), { role: "qa", task: "T12", run: "R40", thread: "thread-1" });
  assert.deepEqual(of("sage_security_reviewer_t1_r9"), { role: "security-reviewer", task: "T1", run: "R9", thread: "thread-1" });
  for (const name of ["sage_implementer_t12_r40", "sage_qa_t12", "sage_qa_t012_r40", "sage_qa_t12_r40x", "sage_qa_tdd_rdd"]) assert.equal(of(name), undefined, name);
  assert.equal(of("sage_qa_t12_r40", "/root/sage_lead_t12_r1/sage_qa_t12_r40"), undefined, "a child of a child");
});

test("an agent without the sage_ task name passes, with or without a report", () => {
  assert.deepEqual(gate(stop({ agent_transcript_path: transcript("/root/explorer") })), {});
  assert.deepEqual(gate(stop({ agent_transcript_path: transcript("/root/explorer_sage_t1"), last_assistant_message: null })), {});
});

test("an input that the gate cannot read stops nothing and gives one plain line", () => {
  const notMeta = join(dir, "not-meta.jsonl");
  writeFileSync(notMeta, '{"type":"response_item","payload":{}}\n');
  for (const input of ["not json", "null", { ...stop({}), hook_event_name: "Stop" }, stop({ stop_hook_active: "no" }),
    stop({ last_assistant_message: 7 }), stop({ agent_transcript_path: null }), stop({ agent_transcript_path: join(dir, "missing.jsonl") }),
    stop({ agent_transcript_path: notMeta })]) assert.deepEqual(gate(input), UNREAD, JSON.stringify(input));
});

// The tools that the chief and role texts may name. STOCK: the tool lists of stock Codex 0.160.0 in run R1648
// (gpt-6.1-sol: functions, clock and collaboration namespaces; fake-model: the multi_agent_v1 list), with the
// spawn_agent parameters. MCP: the tools of the plugin's sage MCP server (T454, PR 327), read from the server itself.
const STOCK = ["exec", "wait", "request_user_input", "request_user_input_async", "sleep", "followup_task", "interrupt_agent",
  "list_agents", "send_message", "spawn_agent", "wait_agent", "task_name", "fork_turns", "reasoning_effort", "exec_command",
  "write_stdin", "view_image", "close_agent", "resume_agent", "send_input", "fork_context", "get_goal", "create_goal", "update_goal", "web_search"];
const MCP = Object.keys((await import(pathToFileURL(join(ROOT, "plugins/sage-codex/mcp/state-server.mjs")))).TOOLS);
/** Each tool-like name (snake case in a code span) that a binding text names, except an example sage task name. */
const named = (text) => [...text.matchAll(/`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`/g)].map((m) => m[1]).filter((name) => !/^sage_[a-z_]+_t\d+(?:_r\d+)?$/.test(name));

test("every tool that a Codex chief or role binding names is a stock Codex tool or a sage MCP tool", () => {
  const texts = [JSON.parse(readFileSync(join(ROOT, "plugins/sage-codex/chief-bindings.json"), "utf8")),
    ...Object.values(JSON.parse(readFileSync(join(ROOT, "plugins/sage-codex/role-bindings.json"), "utf8")))]
    .flatMap((bindings) => Object.values(bindings)).join("\n");
  assert.deepEqual(named(texts).filter((name) => !STOCK.includes(name) && !MCP.includes(name)), []);
  assert.doesNotMatch(texts, /admission|preparation|approved worktree tool/i);
  assert.deepEqual(named("use `sage_prepare_task`, then `spawn_agent` as `sage_qa_t3`"), ["sage_prepare_task", "spawn_agent"], "the reader finds a fork-only tool");
});

test("role.mjs prints the role text and the sage report, and refuses an unknown role", () => {
  const r = spawnSync("node", [ROLE, "implementer"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^# Implementer\n\nYou build one task for the chief of staff\./);
  assert.match(r.stdout, /\n# The sage report\n[\s\S]*\nSTATUS {8}done, blocked or question\n/);
  const bad = spawnSync("node", [ROLE, "chief"], { encoding: "utf8" });
  assert.equal(bad.status, 1);
  assert.equal(bad.stdout, "");
  assert.equal(bad.stderr, "sage: Unknown child role. Give one role from references/roles.md.\n");
});
