# Native child completion

The Codex adapter connects authenticated stop callbacks and parent status checks to admission completion. A stop callback alone does not release capacity. Another hook can refuse that stop.

The adapter verifies the saved assignment, task hash, native child, turn, and protected transcript. Only terminal evidence releases the matching slot. Interruption records a separate outcome and evidence hash. Neither outcome accepts a report, completes a logbook run, or proves task success.

A no-tool child can supply its transcript through the authenticated stop callback. If the parent result has not arrived, the adapter retains the verified transcript reference. Later parent reconciliation validates that reference again and binds it only after the matching result arrives. Missing, changed, or ambiguous evidence retains capacity. The parent cannot reconcile another parent's assignments.

Sage off preserves pending assignments and permits their verified completion. An ordinary unassigned child can stop without acquiring a Sage claim. A managed child receives at most one report-field correction through the native stop retry flag. Every retry still requires identity checks.

This component supports initial and prepared continuation assignments. After compaction, a child must read its exact saved assignment before it can complete. The protected transcript must prove that recovery followed the latest compaction. A new successful completion after compaction requires the current saved run and review targets. Historical completion retries and verified interruption remain available when targets change. They grant no new success. The installed hook manifest stays unchanged. Automatic activation and real-model behavior remain unverified.

## Native check

Run `node scripts/probe-codex-lifecycle.mjs --sage-completion` with fake process tools first on PATH. The probe requires CLI 0.160.0 and uses a fresh temporary profile with simulated responses. It prepares and spawns one child through the packaged runtime. A separate hook blocks the first stop. The next native request must find the slot occupied. Parent reconciliation must later record one completion. Both stop receipts must precede terminal evidence. The probe removes its temporary profile. On this integration branch, the command selects the broader blocked-stop route and also verifies subsequent report handling.

This fixed route uses a narrow test tool policy. It does not verify the complete installed policy or real-model behavior. Deterministic packaged tests cover an early stop whose parent spawn result arrives later; that ordering is not forced by this native probe.

## Native interruption check

`node scripts/probe-codex-lifecycle.mjs --sage-interruption` verifies existing bound interruption recovery with the same temporary fixture and hardware guard.
The probe holds a real child's response until a harmless read establishes its binding.
The chief interrupts that exact child while its next response remains held.
Parent reconciliation must match the native interrupted turn and evidence hash, without a stop callback.
The original assignment stays in history. Reconciliation creates no report, verdict, task transition, or logbook run completion.
The chief then calls `sage_finish_run` with that run ID and an explicit `blocked` status.
The probe checks the exact run change, unchanged task and review state, and an identical retry.
It then creates an eligible replacement run through `sage_create_run`. This does not start a replacement native child.
A fixture capacity check refuses a replacement before interruption, then admits one replacement and refuses a third reservation.
That replacement is a synthetic admission check, not a second native child.
The probe removes its temporary profile. It uses simulated responses and does not activate installed Sage.

Packaged tests also cover interruption after Sage off, later assignments, stale evidence, conflicting terminal records, and exact retries.
The earlier interruption-reconciliation tests pass on the preceding main because that support already exists.
The T63 finish tests cover the separate [interrupted-run operation](interrupted-run.md).
Isolated mutations verify that the tests detect lost reconciliation, incorrect outcomes, conflicting evidence, stale bindings, and retained capacity.
