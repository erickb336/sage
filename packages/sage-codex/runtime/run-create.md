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
A run record grants no role authority; preparation and native admission still
refuse unsupported roles and invalid dispatches.

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

This uses disposable profiles and simulated model responses. Project setup,
task transitions, full policy, independent review cycles, a real-project pilot,
and installed automatic operation remain separate work. The installed manifest
is unchanged, and autopilot remains off.
