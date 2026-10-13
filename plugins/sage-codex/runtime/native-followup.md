# Native follow-up dispatch evidence

`readNativeFollowup` reads one accepted `collaboration.followup_task` call from
the sender's protected native transcript. The trusted caller supplies the sender,
parent, session, path, turn, call ID, exact target text, and task-message hash.

The reader checks native version 0.160.0, server-authored call and result records,
the matching turn context, the exact two input fields, and the empty success
result. An exact pending request in the current unfinished turn returns null. Invalid, failed,
duplicate, altered, or late results throw a fixed error. An interrupted turn cannot retain a pending call or accept a later result. A receipt accepted before interruption remains readable. No private input appears
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
from a failed follow-up dispatch, missing initial transcript references, or changed sessions remains unfinished.
A reused lead can reconcile its own rejected child spawn; see `dispatch-failure.md`.
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

## Parent recovery without a child callback

The native parent can recover its own pending follow-up through a transcript path
already verified for the completed predecessor. `readDeliveredAssignment` finds
one exact prepared message in the current native child turn. The parent then
uses the same sender-receipt and child-delivery checks as a child callback.
No path scan, guessed turn, invented stop event, or new dispatch permission is used.

An interrupted transcript-reference publication retries the same binding without changing its child or turn.
Missing delivery retains capacity. A delivered task binds once, but only its
native terminal record releases capacity. Recovery also works after Sage off.
Changed identity, duplicate delivery, stale turns, and an unaccepted sender
receipt refuse recovery. Bound interruptions have a separate verified path in `native-interruption.md`.
First assignments without a saved transcript reference, compaction, and cross-session handoff remain separate work.

Run `node scripts/probe-codex-lifecycle.mjs --sage-followup-missed-callbacks`.
The real CLI uses simulated responses. Sage's stop hook is absent, and the second
assignment calls no tool. The parent recovers that assignment, reads both reports,
and records the second. The probe checks zero saved Sage stop callbacks, two
bindings, and two completions. It does not prove installed automatic operation.


## Binding saved continuations

The native child adapter binds a later turn only when two records match its saved reservation:

- The sender transcript contains an accepted native follow-up call with the exact target and task hash.
- The recipient transcript contains the exact prepared message in the current child turn.

The saved `followup-transcript` observation locates the sender evidence. The adapter rechecks that file; the observation alone grants no authority.
The binding retains the initial child identity and each assignment's separate turn, brief, and targets.
Changed, pending, ambiguous, foreign, and stale evidence refuses binding without releasing capacity.

A parent can recover missed child callbacks through the completed predecessor's verified transcript path.
Recovery does not search for files or invent native callbacks. Missing delivery retains the reservation.
A retry can finish publication of a transcript reference after the binding was saved.
A named recovery inspects only the named assignment owned by that parent.

A pending continuation stays managed after Sage off. A no-tool stop can bind it, but only native terminal evidence releases capacity.
A prior stop cannot complete the next assignment. Repeated recovery and completion retain one binding and one completion per assignment.

This component consumes saved continuation reservations and observations. Native preparation and dispatch must still produce them through verified boundaries.
It does not check current Git/logbook targets, accept a review verdict, or enable installed automatic Sage.
