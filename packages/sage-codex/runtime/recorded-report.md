# Read a recorded team report

The Codex chief uses `sage_read_recorded_report` to inspect a report already recorded by a parent, including a lead's child.
This supports the team workflow tracked in #88. Direct-child report reading already exists; review acceptance remains separate work.
The reader uses saved receipts instead of reconciling child execution because inspection must not change work state.

Supply the exact assignment ID and report hash from the saved receipt.
The response contains the saved text, task, run, role, child, parent, native turn, and optional pinned review target.

The reader requires the current root owner, project, owner epoch, durable receipt, and matching recovery proof.
Missing or conflicting evidence refuses the read. A proof without a receipt is insufficient.
An intact receipt and proof remain readable after the native transcript is removed or Sage is off.
Repeating the request returns the same saved evidence. The reader checks the admission snapshot again before it returns.

This tool uses version-2 configuration. It needs no logbook path and makes no state change.
It does not recover child completion, accept a report's claims, finish a run, approve a verdict, or permit a merge.
The returned review target is historical evidence; it does not prove that the current branch still matches that target.

This component does not enable installed automatic Sage or verify a real-model workflow.

Validation lives in the T43 cases in `scripts/codex-server.test.mjs`. No owner decision is needed for this read-only step.
