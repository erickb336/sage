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
needs a fresh read and a new request UUID. `pending-request` and
`uncertain-outcome` require the original UUID and identical contents.
`old-owner` requires recovery through the original owner connection; automatic
takeover is unavailable. `invalid-state` requires preserved-state inspection or
repair. Readiness errors name the missing prerequisite and bounded task, gate,
run or finding IDs. They do not include private exception text or finding summaries.

After an uncertain error, retry the identical request. Do not replace its UUID.
A durable `task-update-rejected` result keeps its reason. Reconcile or interrupt
the listed assignments, then read the current task and submit a new UUID.
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

The logbook writer and admission journal remain separate stores. A durable
intent, immutable decision, receipt acknowledgement and explicit fence release
make interrupted publication recoverable. Terminal evidence can settle a native
slot during recovery. Report and verdict publication cannot cross the pending
logbook marker.

The isolated `--sage-update-task` lifecycle probe uses simulated model replies.
It checks the native read, update, historical retry and fresh-read route. It does
not prove real-model behavior, installed automatic Sage, or cross-root PR ownership.
