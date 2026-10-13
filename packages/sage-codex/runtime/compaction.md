# Chief context after native compaction

Codex CLI 0.160.0 removes hook-added developer context during local manual
compaction. The owner and Sage logbook can remain valid while the model loses
the chief instructions. The native probe reproduced this with both exact
instruction parts absent from the next model request.

The prepared MCP handler now supports the observed `SessionStart` event with
source `compact`. It checks the current native connection, root session
metadata, fixed project directory, and active owner mode. It returns the same
two bounded chief-instruction parts. Startup returns no new instructions.
Unknown sources, child identities, invalid parts, and unavailable evidence
return the native `continue: false` output. A rendering failure changes no
state; a later retry can restore the context. The handler rechecks mode after
rendering and never activates a mode or changes ownership.

Run `node scripts/probe-codex-compaction.mjs` with fake process tools first on
PATH. The probe activates Sage, requests actual native manual compaction, and
submits an ordinary follow-up. A fixed simulated summary deliberately excludes
the chief instructions. Matching native start/completion events and a saved
compaction record prove that compaction occurred. The next model request
must contain both exact instruction parts and the summary. Owner, epoch, mode,
tasks, runs, and admissions must remain unchanged.

Add `--sage-off` for the inactive control. It runs the same native compaction
and requires no chief instructions before or after it. Both routes use a fresh
profile, fixed simulated responses, no child dispatch, and graceful process
closure before removing temporary files.

Add `--automatic` to test native compaction before the next ordinary turn.
The simulated first response reports 200,000 tokens against a 100,000-token
threshold. The probe sends no manual compaction request. It requires native
PreCompact and PostCompact events with trigger `auto`, the saved record, and
both exact instruction parts in the next model request. Combine it with
`--sage-off` for the inactive control. Token counts are fixed fixture inputs,
not measurements of real model use.

This verifies manual and automatic local-provider compaction without active children.
Remote compaction, child context restoration, active-child
restart, cross-session transfer, real-model behavior, and installed automatic
Sage remain unverified. The required-hook outage still blocks activation.
