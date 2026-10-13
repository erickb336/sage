# Initial child assignment recovery

`sage_read_assignment` returns the authenticated child's own active assignment. It takes no arguments. The reader checks the current owner, reservation, binding, native turn, original task delivery, and exact saved message hash. It changes no admission state and grants no tool or completion permission.

After native compaction, ordinary child work waits for a matching assignment-read result in the protected transcript. The existing native reader verifies the result's provenance, turn, message hash, and replay budget. Each compaction requires a new recovery result. The policy checks recovery before and after its asynchronous evaluator.

Recovery remains available for preserved assignments after Sage off. A pending initial assignment must bind before it can use that recovery path. Off does not permit a reserved child to bypass its saved assignment.

A stop without recovery evidence remains blocked. Recovery alone does not release capacity: completion still requires native terminal evidence. An interruption remains a distinct outcome. Report claims do not establish task success.

This component covers initial assignments. Later assignments and shared logbook task/run checks remain separate components. It does not enable installed automatic Sage or prove real-model behavior.

Run `node scripts/probe-codex-lifecycle.mjs --sage-child-repeat-recovery` with fake process tools first on PATH. The isolated CLI 0.160.0 probe triggers two native compactions with simulated responses. It checks work and stop refusal, exact assignment recovery after each compaction, completion, receipt storage, and cleanup. `--sage-child-recovery` covers one compaction. Neither route establishes real-model behavior or installed activation.

The broader integration also checks the saved task/run target during assignment recovery. Later assignments remain prepared integration work, separate from the merged initial-assignment component.
