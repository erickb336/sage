import assert from "node:assert/strict";

// The simulated child may report completion only after its real tool succeeds.
export function freshControlCompletion(output, marker) {
  assert.deepEqual(output, { resources: [] }, "fresh_control_not_successful");
  return marker;
}

// Exact prepared-message matches separate the first turn from a later assignment.
export function capacityChildPhase({ initialPrompt, freshPrompt, freshDispatched }) {
  assert(initialPrompt !== freshPrompt, "capacity_child_assignment_ambiguous");
  if (freshPrompt) {
    assert(freshDispatched, "unrequested_A_followup");
    return "fresh";
  }
  assert(initialPrompt && !freshDispatched, "capacity_child_assignment_missing");
  return "initial";
}
