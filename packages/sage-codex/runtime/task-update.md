# Native task updates

The prepared `sage_update_task` tool lets the current root owner update a task
in the configured Codex logbook. Children and unknown roots cannot use it.
The separate [task reader](task-read.md), implemented by `task-read.mjs`, supplies
`sage_read_task`. The installed manifest is unchanged.

Read a task to get its stored fields and version. Submit that version with a
fresh request UUID, the task ID, and changes to title, branch, PR, or state.
The version covers task metadata. A concurrent change makes it stale; read
again before you submit a new request. The connection fixes the project and
owner. A recorded owner can update manual records while Sage is off.

The shared state tool applies its transition rules, branch ownership, findings,
and PR history. Unanswered task gates block forward work. Native verification
requires the configured review cycles on the current local branch commit.
PR readiness also requires a PR number. A new branch commit invalidates earlier
review evidence. Metadata edits cannot retain readiness with stale evidence.
The native tool refuses merged state and direct repair state. Gate answers,
repair rounds, and remote merge checks remain separate operations.

Task updates alone still use the legacy recorded-write implementation in
`review-write.mjs` until their writer migration. Task creation, run creation,
and review acceptance use the validated `recorded-write.mjs` implementation.
The read-only task adapter does not recover either writer.

After a lost response, repeat the exact request. Its receipt returns the
historical result; it does not reset a newer task or prove current readiness.
Partial writes block other writes and merge checks until that request recovers.
Recovery refuses unrelated table changes. It completes the original validated
intent; it does not check a changed branch commit again. Read current state and
check current evidence before you act on readiness.

Run `node scripts/probe-codex-lifecycle.mjs --sage-task-lifecycle` with fake
process tools first on PATH. Native calls create a task and run, advance through
briefed and building, complete a child report, and enter reviewing and verifying.
A repeated update creates no duplicate decision. An attempt to verify without
review evidence fails. Direct reads check the task, run, decisions, and ledger.

The probe uses disposable profiles and simulated model responses. It does not
prove real-model use, independent review quality, every workflow route, remote
PR readiness, or installed automatic operation. Full policy and a real-project
pilot remain required. Autopilot remains off.
