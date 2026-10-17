import assert from "node:assert/strict";

const protectedReason = "This patch reaches a protected path or a file with another hard link. Use the authorized state operation for logbook changes.";
const chiefReason = "This Sage role cannot edit files. Give the change to an implementer.";

export function assertPatchEvidence({ chief, protectedTarget, commandResult, events, items, receipt, fileContents }) {
  const denied = chief || protectedTarget;
  const starts = items.filter(row => row.type === "thread.started");
  assert.equal(starts.length, 1, "one_session_required");
  assert.equal(items.filter(row => row.type === "turn.completed").length, 1, "native_completion_required");
  assert(!items.some(row => ["error", "turn.failed"].includes(row.type)), "native_turn_failed");
  const before = events.filter(row => row.hook_event_name === "PreToolUse");
  assert.equal(before.length, 1, "one_patch_hook_required");
  assert.equal(before[0].tool_name, "apply_patch");
  assert.equal(before[0].tool_use_id, "fixed_patch", "patch_call_mismatch");
  assert.equal(before[0].session_id, starts[0].thread_id, "patch_session_mismatch");
  assert.equal(typeof before[0].turn_id, "string"); assert(before[0].turn_id.length > 0);
  const after = events.filter(row => row.hook_event_name === "PostToolUse");
  assert.equal(after.length, denied ? 0 : 1, "patch_post_hook_mismatch");
  if (!denied) {
    for (const key of ["session_id", "turn_id", "tool_use_id", "tool_name"]) assert.equal(after[0][key], before[0][key]);
  }
  if (chief) assert.equal(receipt, null, "role_guard_must_precede_evaluator");
  else {
    assert(receipt, "patch_policy_receipt_required");
    assert.equal(receipt.session, before[0].session_id);
    assert.equal(receipt.turn, before[0].turn_id);
    assert.equal(receipt.call, before[0].tool_use_id);
    assert.equal(receipt.sage, false, "off_trial_must_reach_patch_policy_off");
    assert.deepEqual(receipt.result, protectedTarget ? {decision:"deny",reason:protectedReason} : {decision:"pass"});
  }
  const output = typeof commandResult === "string" ? commandResult : JSON.stringify(commandResult);
  assert.equal(typeof output, "string", "actual_tool_output_required");
  if (denied) assert(output.includes(chief ? chiefReason : protectedReason), "expected_sage_denial_required");
  else assert(output.includes("Success. Updated the following files:") && output.includes("ordinary.txt"), "native_patch_success_required");
  const changes = items.filter(row => row.type === "item.completed" && row.item?.type === "file_change");
  assert.equal(changes.length, denied ? 0 : 1, "native_file_change_mismatch");
  assert.equal(fileContents, denied ? null : "fixed native patch\n", "actual_file_contents_mismatch");
  const completed = items.filter(row => row.type === "item.completed");
  assert(completed.every(row => ["file_change", "agent_message", "reasoning"].includes(row.item?.type)), "unexpected_native_tool");
  const messages = completed.filter(row => row.item?.type === "agent_message");
  assert.equal(messages.length, 1); assert.equal(messages[0].item.text, "patch boundary checked");
}
