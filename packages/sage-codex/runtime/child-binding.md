# Bind a native child to an assignment

`bindNativeChild(configuration, identity)` joins a verified child start to one
role reservation in the configured project and current session epoch. Its input
must come from `nativeChildStart` on the current trusted connection. Calling this
function with arbitrary JSON does not authenticate an agent.

The configured `observationsDirectory` must contain authenticated native request,
successful result, and child-start records. Their exact join must name the admitted
call, parent turn, parent actor, child, and path. A held name alone is insufficient:
a failed spawn can leave that name available for an unadmitted call. Missing,
conflicting, or reused paths refuse binding. The launcher must record these events
through trusted hooks, including spawns while mode is off. A capture gap requires
reconciliation. Arbitrary files are not native authority. A second same-name
request is ambiguous even before its result arrives. The adapter does
not wait for a missing result, and cannot yet resolve delivery before result
publication. A saved receipt is retained, but conflicting native observations still
prevent this adapter from supplying it as current role authority.

The adapter derives each parent's path and role from saved bindings and admitted
assignments. The root is the chief. A nested child requires a bound parent. The
child path must extend that exact parent path by the reserved name. Exactly one
reservation must match. Its recorded issuer role must match the bound parent.
The shared journal atomically binds the assignment to the child, so conflicting
initial identities cannot both win.

The result contains the saved assignment, binding, and role. It is not permission
to run tools or proof of instruction delivery. The trusted start policy must load
the matching durable brief, and tool policy must check current mode, task scope,
and role. Those policies and the visible preparation tool remain integration work.
The adapter does not start agents or clear reservations.

A reservation made through `reserveBriefAdmission` adds its saved structured brief
to the binding result. The snapshot is part of the same immutable reservation as
the role. Legacy reservations return no brief. The delivery policy must refuse
missing instructions when the task requires a brief; it must not fill the gap
with unverified new input.


## Initial children that use no tool

The native `SubagentStop` callback provides `agent_transcript_path` for the child and `transcript_path` for its parent.
The adapter can bind an admitted initial child from the child path before it records completion.
It verifies the current native actor and version, owner epoch, spawn result, transcript metadata, exact turn, and prepared task hash.
This uses the same binding checks as the first-tool path; it does not invent a tool call or scan for a transcript.

A missing or conflicting result retains the reservation. A retry can complete after the matching result arrives, including after Sage off.
A failed transcript-observation write can retry an already saved binding. Identical completion retries preserve one record.
An initial-task binding cannot authorize a different turn. Prepared later tasks use the separate checks in `native-followup.md`.

The isolated `--sage-no-tool` native probe returns a structured review without any child tool call.
The chief then reads, records, inspects, finishes, and accepts it on the actual temporary branch commit.
The responses are simulated. This checks the configured fixture hooks, not every combination of other stop hooks or interruption behavior.

## A stop hook can block completion

A stop callback records an observation. It does not prove that the child finished.
Another hook can block that stop and let the same child continue.
Sage retains capacity until the protected native transcript contains `task_complete` for the admitted turn and its retained final message.
The parent's list, wait, or report-read operation checks that evidence and releases the slot once.
For an already-bound child, this check does not require a delivered stop callback.
The saved child identity, assignment, turn, transcript reference, and native terminal record must all match.
Recovery does not invent a stop event, accept a report, or apply a verdict.
An unbound child, missing transcript, incomplete turn, or invalid evidence retains capacity.
A start binding waits when its first transcript reference has not arrived.
A tool result that says “completed” cannot replace transcript evidence.

The isolated `--sage-stop-block` probe adds a second hook that blocks the first stop.
It checks that Sage keeps the slot while the child continues, then records one completion after the native turn ends.
This uses a simulated model. It does not verify interruption, later assignments, or a real project pilot.

## One report correction

The native stop boundary requires a boolean `stop_hook_active` and text `last_assistant_message` from the authenticated callback.
After binding the admitted child and recording its stop, Sage checks the report's seven field headings.
Missing fields block the first stop with a correction request. A native retry with `stop_hook_active: true` passes this field check.
This matches Claude's bounded correction rule. It does not accept the report or verify its values.
A malformed callback or unverified assignment still refuses; the retry flag cannot bypass identity checks.

Capacity stays reserved through correction. A native terminal record releases it even when the final report is empty, too long, or invalid.
The report reader still refuses those reports. A saved terminal record also prevents a late callback from requesting another correction.

The isolated `--sage-report-correction` probe returns missing fields, then a valid review on the same native turn.
The isolated `--sage-report-escape` probe returns the same invalid report twice; it releases one slot without saving a report or verdict.
Both use simulated responses in native Codex. They do not prove review quality or installed automatic Sage.

## Missing stop callback

The isolated `--sage-missed-stop` probe omits Sage's stop hook from its temporary
configuration. It keeps the observer and the first-tool binding checks. The same
native child completes two prepared assignments. The parent reconciles both
terminal records, reads both reports, and records the second report.

The probe checks that no Sage stop callback was stored. It uses real CLI 0.160.0
with simulated responses. This proves recovery for already-bound children only.
Unbound delivery, failed starts, interrupted turns, compaction, and cross-session
recovery remain separate work. The required-validation activation blocker remains.
