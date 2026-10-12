# Native follow-up dispatch evidence

`readNativeFollowup` reads one accepted `collaboration.followup_task` call from
the sender's protected native transcript. The trusted caller supplies the sender,
parent, session, path, turn, call ID, exact target text, and task-message hash.

The reader checks native version 0.160.0, server-authored call and result records,
the matching turn context, the exact two input fields, and the empty success
result. An exact pending request in the current unfinished turn returns null. Invalid, failed,
duplicate, altered, or late results throw a fixed error. No private input appears
in that error. Linked, incomplete, oversized, and out-of-profile files refuse.

A receipt contains the call, turn, target text, task hash, native result ID, and
a hash of the complete expected identity plus that result ID. Re-reading the
same historical call returns the same receipt after later turns. It never issues
another permission or changes the admission journal.

A successful dispatch does not establish recipient delivery. Relative target
text still needs resolution against verified agent identities. The recipient's
protected transcript must separately bind the saved message hash to its exact
turn. The preparation adapter now pins the recipient and reserves outgoing capacity.
Later-turn binding now verifies the accepted sender receipt and the exact received
message in the current child turn. The child keeps its original identity and path.
Each assignment has a separate binding, transcript-turn reference, completion, and
report. An old stop cannot release later work. A pending continuation stays managed
after Sage off, including when its first callback is a no-tool stop.

A resumed lead uses its current assignment for delegation and its original spawn
for identity. A completed or ended lead run cannot prepare more work. Recovery
from interrupted dispatch, unbound delivery, or changed sessions remains unfinished.
An already-bound child can recover after a missing stop callback; see `child-binding.md`.

Run `node scripts/probe-codex-lifecycle.mjs --follow-up` with fake process tools
first on PATH. The isolated native probe verifies the sender receipt and each
recipient turn separately. It uses simulated responses, not a real-project
pilot, and removes its temporary profile. The installed runtime stays inactive.

Run `node scripts/probe-codex-lifecycle.mjs --sage-followup` for the integrated
route. The real CLI receives simulated responses. A chief creates a second run,
prepares a follow-up, and reuses the same native child. The probe checks two
turns and completions, records the second report, and reads the first report
unchanged. This does not verify full policy, recovery, or a real-project pilot.

Run `node scripts/probe-codex-lifecycle.mjs --sage-followup-no-tool` to check a
later assignment that returns its report without calling a tool. The first
assignment binds through its first tool. The second stays unbound until its
stop callback verifies delivery. The probe checks zero tool calls in that
second turn, two exact bindings and completions, and both preserved reports.
It uses the real CLI with simulated responses; it is not a real-project pilot.
