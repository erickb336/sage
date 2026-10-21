import assert from "node:assert/strict";
import { createHash } from "node:crypto";

// Consistency only. The native caller authenticates terminal evidence with readNativeCompletion first.
export function validateAdmissionEvidence(input) {
  const { scenario, before, after, bookBefore, bookAfter, terminal, denial, call, events, childRequests } = input;
  assert(scenario === "unprepared-followup", "unknown_admission_scenario");
  assert.equal(call, "admission_follow", "wrong_denied_call");
  assert.equal(typeof denial, "string");
  assert(denial.includes("Sage could not verify this tool call."), "missing_native_denial");
  for (const key of ["preparations", "reservations", "bindings"]) {
    assert.equal(before[key].length, 1, `original_${key}_count`);
    assert.deepEqual(after[key], before[key], `${key}_changed`);
  }
  assert.equal(before.completions.length, 1, "original_completion_count");
  assert.equal(after.completions.length, 1, "completion_count");
  assert.deepEqual(after.completions[0], after.bindings[0], "completion_identity");
  assert.equal(after.reports?.length ?? 0, 0, "unexpected_report_acceptance");
  const bound = after.bindings[0], preparation = after.preparations[0], reserved = after.reservations[0];
  assert.equal(bound.assignment, reserved.assignment.id, "reservation_binding_mismatch");
  assert.equal(reserved.preparation, preparation.id, "preparation_mismatch");
  for (const key of ["session", "child", "turn"]) {
    assert.equal(terminal[key], key === "session" ? bound.session.slice(6) : bound[key], `terminal_${key}_mismatch`);
  }
  assert.equal(terminal.taskHash, reserved.dispatch.taskHash, "terminal_task_hash");
  assert.equal(terminal.reportHash, createHash("sha256").update(terminal.text).digest("hex"), "terminal_report_hash");
  assert.match(terminal.reportMessage, /^[A-Za-z0-9_-]{1,256}$/, "terminal_message_source");
  const denied = events.filter(row => row.tool_use_id === call);
  assert.equal(denied.filter(row => row.hook_event_name === "PreToolUse").length, 1, "denial_not_observed");
  assert.equal(denied.filter(row => row.hook_event_name === "PostToolUse").length, 0, "denied_tool_executed");
  assert.equal(denied[0].tool_name, "collaborationfollowup_task", "wrong_denied_tool");
  assert.equal(denied[0].session_id, bound.session.slice(6), "wrong_denied_session");
  assert.equal(events.filter(row => row.hook_event_name === "SubagentStart").length, 1, "extra_child_start");
  assert.equal(childRequests, 2, "unexpected_child_request");
  assert.deepEqual(after, before, "refused_followup_changed_admission");
  assert.deepEqual(bookAfter, bookBefore, "refused_followup_changed_logbook");
  return { scenario, preparations: 1, reservations: 1, bindings: 1, completions: 1,
    originalTargetPreserved: true, noPostToolUse: true, noExtraChildTurn: true };
}
