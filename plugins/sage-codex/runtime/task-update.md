# Authenticated task updates

`sage_update_task` lets the current chief change an existing task. First call
`sage_read_task` and keep its version. Submit exactly these fields:

- `request`: a new UUID for this change;
- `task`: the task ID;
- `version`: the version returned by the read;
- `changes`: one or more of `title`, `branch`, `pr` and `state`.

The server fixes project, logbook and owner from the authenticated connection.
Children and unrelated roots cannot choose another owner or storage location.
Changes use title, branch, PR, state order. Merged and direct repairing states
remain outside this tool. It does not answer gates or merge a pull request.

A fresh success returns `task-updated`. An identical successful retry returns
`task-update-history`, with the original task and version. That result is not a
current snapshot. Read the task again for its current state.

Errors include a safe reason code and a next step. A `stale-version` refusal
needs a fresh read and a new request UUID. `uncertain-outcome` requires the
original UUID and identical contents. `invalid-state` requires preserved-state
inspection or repair. `stuck-write` gives the same line as Claude: a saved change
cannot finish, so the owner restores the logbook from a backup or accepts the
loss of that change. In Codex, the owner runs that repair in a terminal, because
the chief cannot (see the Codex guide). Readiness errors name the missing prerequisite and bounded
task, gate, run or finding IDs. They do not include private exception text or
finding summaries.

After an uncertain error, retry the identical request. Do not replace its UUID.
The retry reads the receipt if the write committed. Otherwise it runs again and
checks the task again.
A `task-update-rejected` result writes no receipt. Reconcile or interrupt the
listed assignments, then retry: the retry gets a fresh answer. An existing
rejected receipt from an earlier version still reads as rejected.
A refusal does not stop a child. Native terminal evidence must prove settlement.

All updates briefly fence managed work. A disruptive change also retires saved
preparations. Preparing, reserving, continuing and recovering authority check the
same task generation. Managed off-mode tools check transaction integrity before
and after asynchronous policy evaluation. Ordinary off-mode policy stays off.

Verified and PR-ready tasks need fresh readiness, including metadata-only
updates that retain those states. The tool checks the actual branch head,
configured review cycles, findings, gates, ledger and running reviewers.
PR-ready also needs a valid PR number. A historical retry does not run these
checks again and does not claim that the task can merge now.

The logbook writer and admission journal remain separate stores. The receipt is
the commit point, so any writer of the logbook settles a stopped update with no
journal: a marker with a receipt rolls forward, and a marker with no receipt
restores the before tables. The Codex settle step (`task-settle.mjs`) runs before
decide, prepare, assign, finish and a child's terminal check. It acknowledges and
releases a row with a receipt, and it voids a row with no receipt and no marker.
A void row is never a decision: a retry gets a fresh one.

The isolated `--sage-update-task` lifecycle probe uses simulated model replies.
It checks the native read, update, historical retry and fresh-read route. It does
not prove real-model behavior, installed automatic Sage, or cross-root PR ownership.
