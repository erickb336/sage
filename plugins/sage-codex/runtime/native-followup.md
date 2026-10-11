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
Later-turn binding, report intake, and capacity release remain required before
Sage can reuse an agent automatically.

Run `node scripts/probe-codex-lifecycle.mjs --follow-up` with fake process tools
first on PATH. The isolated native probe verifies the sender receipt and each
recipient turn separately. It uses simulated responses, not a real-project
pilot, and removes its temporary profile. The installed runtime stays inactive.
