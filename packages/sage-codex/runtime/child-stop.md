# Native child completion

The Codex adapter connects authenticated stop callbacks and parent status checks to admission completion. A stop callback alone does not release capacity. Another hook can refuse that stop.

The adapter verifies the saved assignment, task hash, native child, turn, and protected transcript. Only terminal evidence releases the matching slot. Interruption records a separate outcome and evidence hash. Neither outcome accepts a report, completes a logbook run, or proves task success.

A no-tool child can supply its transcript through the authenticated stop callback. If the parent result has not arrived, the adapter retains the verified transcript reference. Later parent reconciliation validates that reference again and binds it only after the matching result arrives. Missing, changed, or ambiguous evidence retains capacity. The parent cannot reconcile another parent's assignments.

Sage off preserves pending assignments and permits their verified completion. An ordinary unassigned child can stop without acquiring a Sage claim. A managed child receives at most one report-field correction through the native stop retry flag. Every retry still requires identity checks.

This component supports initial assignments. Compacted work cannot report successful completion through this adapter; verified interruption remains available. Later assignments and complete recovery remain separate integration work. The installed hook manifest stays unchanged. Automatic activation and real-model behavior remain unverified.
