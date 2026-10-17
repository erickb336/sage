import assert from "node:assert/strict";
import { waitNative } from "./wait-native.mjs";

// Register close observation immediately, including for the version process.
export function trackOwnerProcess(child, options) {
  let closed = false;
  const stopped = waitNative(child, options).then(result => { closed = true; return result; });
  child.stdin.on("error", () => {});
  return { child, stopped, get closed() { return closed; },
    eof() { child.stdin.end(); child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); },
    abrupt() { if (!closed) child.kill("SIGKILL"); } };
}

export function assertOwnerTurn(events, phase, session) {
  const starts = events.filter(event => event.type === "thread.started");
  assert.equal(starts.length, 1, "one_native_session_required");
  assert.equal(typeof starts[0].thread_id, "string");
  assert(starts[0].thread_id.length > 0);
  if (session) assert.equal(starts[0].thread_id, session, "resume_changed_session");
  assert.equal(events.filter(event => event.type === "turn.completed").length, 1, "one_completion_required");
  assert(!events.some(event => ["error", "turn.failed"].includes(event.type)), "native_turn_error");
  const items = events.filter(event => event.type.startsWith("item.")).map(event => event.item);
  assert(items.every(item => ["agent_message", "reasoning"].includes(item?.type)), "unexpected_tool_execution");
  const messages = events.filter(event => event.type === "item.completed" && event.item?.type === "agent_message");
  assert.equal(messages.length, 1, "one_fixed_message_required");
  assert.equal(messages[0].item.text, `owner-turn-${phase}-ok`, "unexpected_model_text");
  return starts[0].thread_id;
}

export function assertOwnerHistory({ requests, deliveries, states, session, initialLogbook, finalLogbook }) {
  assert.equal(requests, 4, "four_requests_required");
  assert.deepEqual(deliveries, [[0, 0], [1, 1], [1, 1], [2, 2]], "chief_instruction_delivery_changed");
  assert.equal(states.length, 4);
  assert.equal(states[0].sessions.length, 0, "owner_registered_before_activation");
  assert.equal(states[0].modes.length, 0);
  for (let i = 0; i < states.length; i++) {
    assert.equal(states[i].reservations.length, 0, "unexpected_child_reservation");
    if (!i) continue;
    assert.equal(states[i].sessions.length, 1);
    assert.equal(states[i].sessions[0].session, `codex:${session}`);
    assert.deepEqual(states[i].modes.map(row => row.sage), [true, false, true].slice(0, i));
    assert.equal(states[i].sessions[0].epoch, states[1].sessions[0].epoch, "owner_epoch_changed");
  }
  assert.equal(new Set(states[3].modes.map(row => row.turn)).size, 3, "mode_turn_reused");
  assert.deepEqual(finalLogbook, initialLogbook, "seeded_logbook_changed");
}
