// The Codex report gate and the role text script, run as Codex runs them: JSON on stdin, JSON on stdout.
// The input shape is a SubagentStop input that stock Codex 0.160.0 sent in run R1648 (paths replaced).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
