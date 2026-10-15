import assert from "node:assert/strict";

// The simulated child may report completion only after its real tool succeeds.
export function freshControlCompletion(output, marker) {
  assert.deepEqual(output, { resources: [] }, "fresh_control_not_successful");
  return marker;
}
