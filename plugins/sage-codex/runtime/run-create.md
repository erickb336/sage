# Native run creation

The prepared `sage_create_run` tool records a run for an existing task in the
configured Codex logbook. Only the current root owner may use it, including
while Sage is off. This matches Claude's chief-only logbook writes.

The request has `request` (a UUID), `task`, `role`, `branch`, and `candidate`.
Use empty strings for an unused branch or candidate. The tool fixes the owner,
project, and logbook from its native connection and configuration. Requests
cannot select storage or override a model. The core derives the round and
recorded model from the current task and shared settings.

A writer needs a branch. Another running writer cannot use that branch,
whether the CLI or native tool created its run. The shared core owns this rule.
A run record grants no role authority. Preparation and dispatch both require a
configured logbook and one matching active task and run. They refuse missing or
duplicate records, a changed role or round, ended or reported runs, terminal
tasks, and mismatched branches. Writers need the task's branch and cannot share
it with another active writer. Unsupported roles still cannot run.

These checks read current records at each boundary. They do not pin every task
field at preparation, answer gates, or enforce every workflow route. Review
preparation also pins its current commit, round, and cycle.

One active lead owns a recorded task in the participating admission journal.
A replacement lead waits until the previous lead and its team finish, or until
an exact pre-child failure releases their reservations. Other tasks can proceed
within the shared limits. A verified Codex lead can prepare and dispatch children
only for its own task. Both boundaries recheck the parent lead's current run.

This ownership key is the project and task ID. It does not deduplicate a PR
number assigned to different task IDs or coordinate separate journals. Older
history with overlapping leads for one task is refused without rewriting it.

One run can receive one dispatch across owners in the same admission journal.
Another name, task label, or owner cannot reuse it. Concurrent requests choose
one winner. An exact dispatch retry returns the original receipt without a new
permission. Completion releases capacity but does not reopen the run. Record a
new run for another execution.

A verified failure before child creation permits a new dispatch attempt for the
same run. A late receipt from the failed attempt cannot release or bind the new
attempt. Unknown outcomes retain their reservation. Separate admission journals
are not coordinated by this rule. Earlier journal history that dispatches one
run twice without a verified failure is refused; the tool does not rewrite it.

Reuse the same request UUID and fields after a lost response. A retry returns
the original creation record. It does not reopen a completed run or reset its
report. Use a fresh request UUID for a new run. The shared `running` status
means a recorded assignment; it does not prove that a native agent started.

The core writes the run and immutable receipt under the logbook lock. Partial
writes retain an intent that blocks other writes and merge checks. The exact
request recovers it. Recovery refuses unrelated table changes. A different
request cannot take over the pending write. Earlier state tools with the
pending-review guard refuse this newer intent but cannot recover it; older
tools without that guard are not safe concurrent writers.

Run `node scripts/probe-codex-lifecycle.mjs --sage-create-run` with fake process
tools first on PATH. The probe starts with an initialized, empty logbook. Native
tool calls create a task and a run, retry both, prepare and start the child,
record its report, and finish the run. Another creation retry does not reopen
that completed run. Direct reads verify one task, run, report, and completion.
The task remains framed; no review verdict or merge permission is produced.

Versioned task transitions are described in `task-update.md`.

This uses disposable profiles and simulated model responses. Project setup,
full policy, independent review cycles, a real-project pilot,
and installed automatic operation remain separate work. The installed manifest
is unchanged, and autopilot remains off.
