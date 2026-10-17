# Atomic admission

This store records session ownership and reserves capacity before a dispatch. It covers only sessions that use this same canonical local directory. Role-aware admission checks role permissions in the same atomic operation as capacity. The older roleless API checks capacity only. The store trusts issuer evidence from its caller. It does not authenticate native identity, release reservations, or recover a session automatically.

The base API has five operations:

1. `configureAdmission(directory, {total, projects})` fixes the store and project limits. Each project entry has `project` and `limit`. Repeated equal configuration is safe; changed limits require reconciliation.
2. `activateAdmission(directory, {project, session, activation}, {sage})` records scoped session identity and creates its epoch. The third argument defaults to `{sage: true}`. Use `{sage: false}` to record an initial verified off request without enabling Sage. The adapter must obtain activation authority through the verified entry path. The same request returns the same owner. Another activation cannot replace it.
3. `reserveAdmission(directory, scope, request, dispatch)` saves an assignment and consumes its single dispatch permit atomically. Scope and request use the assignment API. Dispatch contains the native `tool`, parent `turn`, requested child `name`, and `argumentsHash` of all relevant native arguments.
4. `changeAdmissionMode(directory, {project, session, epoch, after, turn, sage})` records a verified owner mode request. `after` must name the current mode turn; `turn` names this prompt, and `sage` is boolean.
5. `readAdmission(directory)` returns the configuration, session records, held reservations, mode records, preparations, and child bindings.

Only a newly committed reservation returns `decision: "permit-once"`. An exact retry returns `"already-reserved"` with the saved assignment. It must not permit another native call. Changed arguments, tool, turn, name, task, or run are refused. After an uncertain result, keep the reservation held; do not invent another call identity to repeat the same work.

All reserved assignments without verified completion count toward both limits. A report submission, native stop, elapsed time, or new activation does not release one. Project and session names are identity keys, not paths. The adapter must validate issuer rights separately and convert every refusal or storage error into an explicit native denial. Throwing from a hook alone might not deny the tool.

The journal consists of immutable, numbered, hash-linked records. Each reader checks the complete prefix and its state transitions. A writer syncs the pending record before linking it to the next revision. Only one concurrent writer can publish that revision. A loser reads again and rechecks capacity. Directory sync precedes permission, including when a retry finds an existing reservation. A failure after publication keeps the record and its reservation.

The journal permits 4,096 records and 64 KiB per record. Unpublished pending files do not change state, but count toward the scan bound. Gaps, invalid files, conflicting records, exhausted bounds, or excessive contention cause refusal. No PID probe, process signal, timeout expiry, or shared mutable lock file is used.

This requires a local filesystem with atomic hard links and directory sync. The containing directory must remain controlled by the caller. Hostile replacement of ancestor directories by another same-user process is outside this API's boundary. Tests cover local concurrency and an injected sync failure; they do not simulate physical power loss. Production activation, native denial, completion, and recovery need their own integration checks. No installed hook calls this API yet.


## Mode continuity

Activation uses its requested initial mode and the activation ID as its first mode turn. The default is on. An explicit initial off still leaves a durable request receipt. A later change must name the same owner epoch and the expected prior mode turn. Concurrent changes cannot both replace that turn. Read current state after a conflict; do not automatically turn a stale request into a new one.

An exact retry returns `already-recorded` and the current mode, which may differ from its old request. It never reapplies that request. Reusing a turn with different fields is refused. A new transition returns `changed` and its mode record. Mode records retain identity and booleans only, never prompt text.

Off mode refuses new admission without releasing any held reservation. An exact reservation retry still returns its saved receipt, never another dispatch permit. On restores admission under the existing limits and epoch. Neither transition revokes an already-issued native call, proves a child stopped, or permits a merge. Autopilot remains separate. The adapter must partition native session identity by provider and verify ownership before it calls this API.

The journal reader reconstructs mode from activation and subsequent changes after restart. The same atomic publication and sync rules cover these records. Existing records without an explicit initial mode retain their original on meaning. Older readers refuse the new activation fields or an unknown mode record, so update participating adapters together before sharing a store. No installed automatic hook uses this API yet.


## Role reservations

`reserveRoleAdmission(directory, scope, request, dispatch, rolePlan)` applies the
lead-build rules in the same atomic transaction as project and total capacity.
`rolePlan` has exactly `issuerRole` and `role`. The adapter must establish the
issuer's role from verified native binding and saved assignment evidence.
An agent's name, tool arguments, or message cannot establish that role.

Only the chief can start leads. A lead can start implementer, code-reviewer,
security-reviewer, ux-reviewer, and qa. Specialists cannot start agents.
The chief may still start the existing specialist roles directly for framing
and other current workflows. The chief itself is the owner session, never a
child role.

The project holds at most three leads across its participating sessions. Each
lead holds at most three children in its session and epoch. All reservations
also count toward project and total limits, so the lowest applicable limit wins.
No stop, report, or mode change releases these slots. Completion and recovery
still need their separate protocol.

Legacy reservations retain their original shape and consume normal capacity.
Their role is unknown, so each also counts as a possible lead for the three-lead
limit. They confer no role authority. The legacy reservation API remains for
existing callers; an adapter that enforces roles must use a role-aware reservation API.
A retry cannot change or remove a recorded role plan, and it never permits a
second dispatch. Older readers reject role-bearing records rather than ignore
the new rule. Update all participants before sharing this journal.

This API checks supplied role facts; it does not authenticate them. Native role
binding, readable briefs, report acceptance, and launcher integration remain
required before automatic Sage activation. Claude hook wiring stays in its
separate lead-build issue.

## Initial child binding

`bindAdmission(directory, binding)` records which verified child belongs to an
admitted assignment. The binding carries project, session, epoch, assignment ID,
issuer, dispatch call, child identity, and initial callback turn. It must match a
reservation with a saved role. The result reports that role from the reservation;
a caller cannot supply a replacement role. `readAdmission` now also returns
`bindings`.

Publication enforces one initial binding per assignment and one assignment per
child within a provider session. Exact retries return the saved binding. Changed
identities, reused child names, and self-binding fail. New role reservations
cannot reuse a child name under the same issuer and scope. Older roleless APIs
can still record ambiguous names; those records cannot produce a child binding.
New role reservations carry an explicit unique-name rule. Older records retain
both their bytes and their replay behavior, including reused names. An ambiguous
old name cannot receive a new binding. An existing exact binding receipt remains
readable after a later legacy name collision. Older readers reject the new rule
and binding events.

Binding records an already-admitted child even when Sage mode is now off. It does
not grant another spawn permit, allow work, release capacity, accept a report,
or prove that a brief arrived. The trusted adapter must authenticate the child,
namespace sessions by provider, verify the parent and child address, and apply
current mode and task policy before allowing tools. Initial binding does not
implement later tasks, agent reuse, or recovery.

## Durable task briefs

`reserveBriefAdmission` takes the same arguments as `reserveRoleAdmission`, then
a structured brief. It saves the assignment, role, brief, and capacity in one
journal event before it returns the single dispatch permit. Every brief has the
existing ten Sage fields, each with nonempty text. Its canonical JSON is at most
32 KiB, uses valid Unicode text, and contains no NUL bytes. `parseBrief` validates and copies those fields;
`renderBrief` produces their text in the fixed field order.

An exact retry retains the saved brief. Changing it, adding it to an earlier
reservation, or dropping it through an older API fails. Older reservations retain
their format and remain readable. They do not acquire instructions automatically.
Invalid briefs and capacity failures publish no reservation.

The reservation includes the saved brief when present. A trusted delivery
policy must use that brief, rather than a fresh model-supplied replacement. Brief
text is task context, not role authority or permission to run a command. Native
context limits must fit the rendered brief and the role instructions together.
The visible preparation tool, instruction assembly, and complete delivery policy
remain integration work. State files stay private to the local Sage store.

## Prepare a task before dispatch

`prepareAdmission(directory, scope, request, rolePlan, brief)` saves the task,
run, issuer, unique child name, role plan, and complete brief. The request has
`task`, `run`, `issuer`, and `name`. The trusted adapter supplies the current
scope and issuer role. A preparation ID is a reference, not proof of authority.

Preparation creates no assignment, occupies no agent slot, and grants no spawn
permission. It checks the role relationship and requires Sage mode. An exact
retry returns the original preparation, even after mode turns off. A changed
task, role, run, or brief needs a new child name. The journal bounds apply to
preparations too; this API does not provide deletion or reclamation.

`reservePreparedAdmission(directory, scope, request, dispatch, issuerRole)`
consumes the saved work at the actual native dispatch. Its request has
`preparation`, `issuer`, and `call`. The adapter must establish these values
from trusted runtime evidence and verify the current issuer role again.
The transaction checks scope, issuer, child name, role, mode, and capacity.
It copies the saved brief and links the resulting assignment to its preparation.
Only one call can consume a preparation. An exact retry returns the existing
assignment and grants no additional permission.

Legacy events retain their bytes and semantics. Callers that use the older
reservation APIs do not automatically enforce preparation. A production adapter
must use the prepared path consistently. The model-visible preparation server,
its native identity checks, and the spawn correlation policy remain separate
integration work. These core APIs do not start native agents.


## Verified terminal evidence

`completeAdmission(directory, binding)` records the exact bound assignment as
complete and releases only its capacity. `interruptAdmission(directory, binding,
evidenceHash)` records an interrupted outcome with its evidence hash. The trusted
provider adapter must first verify terminal evidence from the native runtime.
These core calls do not authenticate a caller or inspect a native transcript.

Every binding field must match the saved record and current owner epoch. An exact
retry returns the first completion without another journal write. A changed child,
turn, outcome or interruption hash is refused. History stays intact. A late event
for an older assignment cannot release newer work. Sage off still accepts valid
terminal evidence; it does not enable new dispatch.

Only unfinished assignments occupy total, project, lead and team slots. Completing
a lead does not release its children's slots. A completed child cannot prepare or
reserve more work. The atomic binding transition also refuses completed work,
including an identical binding retry after a concurrent completion. The Codex binding adapter refuses renewed instructions for a
completed assignment. Native delivery, terminal verification and recovery remain
provider responsibilities; this extraction does not wire automatic completion.

Completion records neither task success nor a review verdict. Report acceptance,
run completion, failed dispatch before binding and later-turn reuse remain separate
protocols. Concurrent journal writers still compete for one immutable next record.

## Failed initial dispatch

`failAdmission` records a verified failure for one exact unbound reservation.
The receipt includes the owner epoch, issuer, native call, assignment, and evidence hash.
The provider must verify the native rejection before it calls this operation.

A failure releases that reservation's slot without creating a child completion.
The same receipt is an unchanged retry. Changed identity or evidence refuses.
A bound assignment cannot fail dispatch, and a failed assignment cannot bind later.
The failed reservation remains in history; retrying it never grants another dispatch permission.
Failure and binding use the same journal lock, so only one can win a concurrent attempt.

## One lead per task

A project can hold only one active lead or lead-owned team for a task.
The role reservation checks this rule inside the admission transaction, across owners.
An identical retry retains its reservation; a distinct run cannot claim a second lead slot.
Completing the lead does not release task ownership while its team still runs.
The issuer binding retains the lead’s task even if a child names another task.
Existing journal records remain readable. New reservations cannot add an overlapping lead.
Proven completion or dispatch failure releases the matching reservation.
An independent chief-assigned specialist does not claim lead ownership.
This component covers initial reservations. Prepared continuation on an existing lead is separate work.


## Prepared continuations

`reservePreparedContinuation(directory, scope, request, dispatch, issuerRole)`
reserves a new run on a completed child. Its request has `preparation`, `issuer`,
`call`, and `previous`, the prior assignment ID. Preparation still uses the
normal API with a fresh logical name, saved brief, and run target. The dispatch
must carry the task-message hash. The adapter must verify the actual task,
current run, native recipient, and exact outgoing message before calling it.

The predecessor must have an exact completed binding. Project, session, epoch,
issuer, task, and role plan must stay the same. A changed task, role, or owner
uses a new child; this API does not transfer ownership. The run must be new.
Each predecessor has at most one continuation, including while the new child
turn remains unbound. Concurrent requests cannot fork that history. An exact
retry returns the old reservation and never grants another dispatch permit.

The new reservation takes normal project, total, and role capacity in the same
journal transaction. A resumed lead keeps its existing team: its running children
still consume their own slots and count toward its child limit. Those children
do not count as a competing lead, but another team still blocks admission.
Neither an idle native child nor its earlier completion
is permission to bypass those limits. Mode off refuses new reservations while
retaining exact retry receipts. Unknown or failed continuation dispatches stay
held: the initial-spawn failure API cannot release them.

`bindContinuationAdmission(directory, binding)` binds the new assignment to
the same native child and a new turn. The initial binding API refuses this
assignment kind. The continuation API refuses an initial assignment, a different
child, a reused turn, or a child with active work. The adapter must prove exact
sender dispatch and recipient delivery before binding; this API does not read
native transcripts. Completion and report operations retain each assignment's
own binding. An old stop cannot complete the new assignment. A reused lead
regains admission authority only after its new turn binds.

These records add an explicit continuation reference and binding action. Older
readers refuse them; update every participant before sharing this journal.
Existing records retain their bytes and initial-binding rules. The Codex native
adapter does not yet call these APIs. Recipient resolution, follow-up dispatch,
later-turn tool binding, report intake, and recovery remain integration work.


Preparation can also pin `continuation`, the completed predecessor's assignment
ID. Core checks the saved owner, task, role, completion, and run target before
publishing it. A retry cannot change or remove that predecessor. Dispatch must
use the pinned continuation; the initial-spawn API cannot consume it. Older
preparations retain their format, but the native continuation path requires this
pin before accepting the recipient supplied by a tool call.


## Saved run target

`prepareAdmission` accepts an optional final object with `runTarget` and `continuation` fields.
A run target contains `task`, `run`, `role`, `round`, `taskBranch`, `runBranch`, and `candidate`.
Its task, run, and role must match the preparation. Every saved field is immutable.
A repeated name with changed work refuses. Unknown options and malformed targets refuse before writing.
Old preparations remain readable. A continuation requires a saved target and task-message hash.
The provider must compare this snapshot with the actual current logbook before dispatch or tool permission.
Core validates the snapshot and reservation; it does not establish logbook truth.


## One dispatch per run

A run names one execution within its project, across owners and task labels.
New reservations refuse a run with an earlier dispatch, even after completion.
A proven initial dispatch failure permits a new attempt; an exact retry retains its receipt.
Other projects can use the same run name.

Older journals can contain duplicate initial dispatches. They remain readable and retain their bytes.
New work still cannot reuse any run with an earlier dispatch that did not fail.
Continuations retain their existing replay checks and require a new run.
The provider must still verify the current logbook before dispatch.


## Saved review target

The optional `review` preparation field pins `branch`, `sha`, `round`, and `cycle`.
Only code-reviewer, security-reviewer, ux-reviewer, and qa roles can carry it.
The branch must be a valid task branch; the commit is a lowercase 40-digit hexadecimal SHA.
Round is a nonnegative safe integer, and cycle is an integer from 1 through 10.

A retry cannot change or remove its saved target. Other preparations remain readable.
The review field can accompany a run target and a continuation reference.
Core validates these supplied snapshots; the provider must check them against current Git and logbook records.
Saving a target does not accept a verdict, count clean cycles, or authorize a merge.


## Review report claims

`parseReviewReport(report, role, target)` checks a structured report from `parseReport`.
Evidence contains exactly `commit`, `round`, `cycle`, and a nonempty `summary`.
The report branch and evidence must match the saved target. Questions must be `none`, and status must be `done`.
Findings are an array of objects with `severity` and a nonempty `summary`. Severity is low, medium, or high.

Code, security, and UX reviews use CLEAN or FINDINGS. QA uses PASS or FAIL.
A medium or high finding requires the failure result. Low-only findings can accompany a clean result.
The returned kind describes the claim, not an accepted verdict. This function changes no state.
The caller must still verify current assignment, report identity, Git commit, and logbook before acceptance.

### Issuing assignment for nested native work

A preparation can carry `issuerAssignment`, an immutable assignment UUID. Core
checks that it names a bound, uncompleted lead in the same project, session,
epoch and task. The preparation's issuer must be that lead's child actor.
Chief-issued preparations do not use this field.

The Codex adapter requires this reference for new nested preparations. Before
Sage-on dispatch, binding or tool permission, it checks the original lead's saved
run target. It never substitutes the actor's latest assignment. Recovery that
grants authority uses the same check. Legacy preparations remain readable, but
nested preparations without this reference cannot grant new authority.

Verified terminal delivery remains ingestible after the lead loses authority.
Recording completion or interruption settles the native slot; it does not certify
the logbook task or run. Permission refusal alone does not stop the native child.
This check does not provide atomic task updates or whole-team settlement.

## Task update transactions

The state tool's `updateRequestedTask` takes a fixed project and owner, a request
UUID, a task version, and title, branch, PR or state changes. Native changes use
that order. The CLI keeps its supplied order. Both paths use the same pure plan.
The native path refuses merged and direct repairing states.

A schema 6 intent saves exact before and after tables for tasks, runs and
decisions. It also saves the plan's timestamp, findings, ledger, gates and any
readiness facts. Readiness facts include the branch, actual head and normalized
review-cycle configuration. Recovery reconstructs the plan from these saved
facts. It does not use today's Git head or configuration to change an old plan.

The coordinated writer uses the common pending marker. It publishes this marker
before admission decides the update. `decideTaskUpdate` records an immutable
accepted or rejected decision for the exact owner, request and intent digest.
An unknown result retains the marker. A known rejection preserves the before
images and records a rejection receipt. The same UUID cannot later succeed.

Acceptance fences new work. After table publication and the durable receipt,
`acknowledgeTaskUpdate` saves its exact hash while keeping that fence. The writer
checks all after images, durably removes the marker, then calls
`releaseTaskUpdate`. Each callback must return its matching synchronous result.
A retry finishes this sequence. An old receipt returns historical data without
restoring old tables or clearing another update's fence.

Disruptive changes require every reservation for that project and task to have
authentic completion, interruption or failed-dispatch evidence. This includes
other owner sessions, unbound children and continuation reservations. Such an
accepted update advances the task generation. A rejection does not advance it.

`assertTaskAdmissionOpen` checks the fence and any supplied preparation, then
returns the current generation. A provider must pin this value before it captures
run or review data. Pass it as the optional `generation` preparation option.
Admission compares it again when it saves the preparation and reserves work.
Legacy preparations remain readable; a missing generation means zero.

`validateTerminalAssignment` grants no authority and writes no task data. During
an interrupted publication, it validates the whole intent and reads its coherent
before image. Outside that publication, exact accepted history can explain a
retired target. Unchanged review targets still need the current branch head.
The provider supplies the exact owner, request and digest of the first disruptive
update after the preparation's saved generation. Core checks that receipt and its
coherent history. An explained retired target keeps its original candidate for
terminal evidence only. It cannot authorize tools, accept a review, or certify task success.
