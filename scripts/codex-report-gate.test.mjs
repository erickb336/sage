// The Codex report gate and the role text script, run as Codex runs them: JSON on stdin, JSON on stdout.
// The input shape is a SubagentStop input that stock Codex 0.160.0 sent in run R1648 (paths replaced).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const GATE = join(ROOT, "plugins/sage-codex/hooks/report-gate.mjs");
const ROLE = join(ROOT, "plugins/sage-codex/skills/sage/role.mjs");
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
function gate(input) {
  const r = spawnSync("node", [GATE], { input: typeof input === "string" ? input : JSON.stringify(input), encoding: "utf8" });
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
  assert.deepEqual(gate(stop({ stop_hook_active: true })), { systemMessage: "sage: sage_implementer_t1 stopped, and its report still has no EVIDENCE, FINDINGS, QUESTIONS, NOT VERIFIED, BRANCH. Read the report as it is." });
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
// spawn_agent parameters. MCP: the tools of the plugin's sage MCP server (T454, PR 327).
const STOCK = ["exec", "wait", "request_user_input", "request_user_input_async", "sleep", "followup_task", "interrupt_agent",
  "list_agents", "send_message", "spawn_agent", "wait_agent", "task_name", "fork_turns", "reasoning_effort", "exec_command",
  "write_stdin", "view_image", "close_agent", "resume_agent", "send_input", "fork_context", "get_goal", "create_goal", "update_goal", "web_search"];
const MCP = ["init", "status", "task_add", "task_set", "run_add", "run_done", "finding_add", "finding_triage", "finding_close",
  "finding_move", "verdict", "round", "merge_check", "log", "standing", "standing_add", "pages", "gate_add", "gate_answer"];
/** Each tool-like name (snake case in a code span) that a binding text names, except an example sage task name. */
const named = (text) => [...text.matchAll(/`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`/g)].map((m) => m[1]).filter((name) => !/^sage_[a-z_]+_t\d+$/.test(name));

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
