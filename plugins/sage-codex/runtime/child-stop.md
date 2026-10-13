# Native child completion

The Codex adapter connects authenticated stop callbacks and parent status checks to admission completion. A stop callback alone does not release capacity. Another hook can refuse that stop.

The adapter verifies the saved assignment, task hash, native child, turn, and protected transcript. Only terminal evidence releases the matching slot. Interruption records a separate outcome and evidence hash. Neither outcome accepts a report, completes a logbook run, or proves task success.

A no-tool child can supply its transcript through the authenticated stop callback. If the parent result has not arrived, the adapter retains the verified transcript reference. Later parent reconciliation validates that reference again and binds it only after the matching result arrives. Missing, changed, or ambiguous evidence retains capacity. The parent cannot reconcile another parent's assignments.

Sage off preserves pending assignments and permits their verified completion. An ordinary unassigned child can stop without acquiring a Sage claim. A managed child receives at most one report-field correction through the native stop retry flag. Every retry still requires identity checks.

This component supports initial assignments. Compacted work cannot report successful completion through this adapter; verified interruption remains available. Later assignments and complete recovery remain separate integration work. The installed hook manifest stays unchanged. Automatic activation and real-model behavior remain unverified.

## Native check

Run `node scripts/probe-codex-lifecycle.mjs --sage-completion` with fake process tools first on PATH. The probe requires CLI 0.160.0 and uses a fresh temporary profile with simulated responses. It prepares and spawns one child through the packaged runtime. A separate hook blocks the first stop. The next native request must find the slot occupied. Parent reconciliation must later record one completion. Both stop receipts must precede terminal evidence. The probe also checks that no report was accepted and removes its temporary profile.

This fixed route uses a narrow test tool policy. It does not verify the complete installed policy or real-model behavior. Deterministic packaged tests cover an early stop whose parent spawn result arrives later; that ordering is not forced by this native probe.
