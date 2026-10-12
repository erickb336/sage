# Claude parity audit for issue #88

This audit compares repository behavior with the prepared Codex runtime. It is a source audit, not a live Claude or installed Codex pilot.

## Current readiness

Automatic Sage remains inactive. The checks below use Codex 0.160.0 with simulated model responses, not a real-project pilot.
The required-hook outage check still permits an untracked child. This blocks activation even when the healthy lifecycle checks pass.

| Area | Implemented evidence | Work left before full parity |
| --- | --- | --- |
| Owner activation and off | Verified initial and later owner mode requests, saved mode, chief instruction assembly; off restores direct chief edits without interrupting children | Supported installed entry point and trusted hook enforcement |
| Compaction and restart | Durable records survive adapter reconstruction; native CLI resume preserves one owner; manual and automatic root compaction restore exact chief context without active children | Child compaction loses the saved assignment; report completion is repaired; remote compaction, active-child restart, and session transfer remain unverified |
| Command and write rules | Role edit refusal, original command recovery, chief-only child messages, child sandbox-request refusal | Complete command, path, file-write and workflow policy; trusted effective execution context |
| Briefs and dispatch | Saved briefs, atomic admission, initial and prepared follow-up binding, exact native task delivery | Required-hook outage protection and all missing-initial-evidence cases |
| Roles and limits | Shared limits, one active lead per task, run-target checks, lead-to-reviewer delegation | One lead per PR across distinct task records; complete installed workflow |
| Stop and capacity | Exact completion, bounded report correction, known failed-spawn reconciliation, bound interruption, missed follow-up callback recovery | Other dispatch failures, missing initial references, interrupted logbook-run repair |
| Reports and verdicts | Validated reports, durable receipts, exact-target review acceptance, chief inspection of a lead's saved child report | Independent review scheduling, repair rounds and a real task through all required review cycles |
| Routes and product gates | Shared routes and state operations; typed run creation | Complete chief execution of design, investigation, arena, build, repair and owner gates |
| Manual merging | Runtime never merges; reviewed work must stop for the owner | Real-project pilot ending in a reviewed PR with checks and accepted reports |
| Autopilot | Off; no automatic merge permission | Separate owner opt-in, exact-commit merge checks and verification |
| Setup, help and status | Installed advice hooks and manual logbook | Installed automatic capability reporting after enforcement passes; board work remains deferred |

Implementation details and repeatable checks are in [policy.md](policy.md),
[preparation.md](preparation.md), [native-followup.md](native-followup.md),
[dispatch-failure.md](dispatch-failure.md), and [native-interruption.md](native-interruption.md).
The source pointers below identify the Claude baseline. Later sections record each implementation step;
an earlier section's remaining-work statement describes that step, not the current summary above.

## Interpretation boundaries

Parity means the same owner experience, task routes and shared rules through each provider's supported transport. It does not mean copying Claude-specific metadata, tool names or process leases into Codex.

The report hook's second-stop escape prevents a continuation loop. It does not provide evidence that missing report fields became valid. Separate report acceptance from the native terminal result and capacity accounting.

Claude's lease expiry and registry cleanup cannot be assumed to map to Codex. Issue #88 explicitly requires authoritative lifecycle evidence and protection against stale releases. Verify the Codex-native mechanism while preserving the owner's limits and visible task behavior.

## First implementation unit

Produce a reproducible isolated native transport probe for the supported installed runtime. Record matching dispatch/result/start/stop identities and running/completed states. Check owner prompt identity, race ordering and compaction in later units. Do not activate the automatic workflow until those boundaries and the complete tool policy pass.

Current local CLI reports version 0.160.0, matching the prepared adapter's exact version. Generated native schemas expose turn interruption keyed by both thread and turn, and a separate turn-completed notification. Schema presence is not proof that an active child stopped.

## Baseline source pointers

- `packages/sage-claude/hooks/sage-hook.mjs`: mode switching, compaction, brief/report validation and slot lifecycle.
- `packages/sage-core/roles/chief-of-staff.md`: routes, reports, repairs, cycles, owner gates and arena.
- `packages/sage-claude/chief-bindings.json`: provider dispatch and autopilot behavior.
- `packages/sage-codex/runtime/mode.mjs`, `policy.mjs`, `events.mjs`: prepared native integration and current omissions.

## Native transport result

The isolated 0.160.0 probe observed one spawn request, matching successful result, child start and child stop. It verified the same child/session/path identities, a running child while its model response was held, and the exact terminal completion marker. No real model or owner logbook participated.

The native task arrived as an `agent_message` with an opaque payload. The fixture compares exact transport bytes; it cannot prove real-model consumption. Earlier fixture failures came from a noncanonical temporary path and an incorrect user-message assertion. Both were corrected before the successful result.

Run `node scripts/probe-codex-lifecycle.mjs` with fake process tools first on PATH. It requires Codex 0.160.0 and a loopback listener. It creates an isolated temporary profile and trusts only the test observer there. It does not trust or change hooks in the owner's profile.

Run the same probe with `--deny-spawn` to check a fixed pre-tool denial. The native parent receives the exact denial reason and finishes. The observer must record one spawn attempt, no successful spawn result, no child start and no child stop. The simulated response server must receive no child request.

Both saved variants passed locally on Codex 0.160.0. This proves the denial boundary for this native spawn path. It does not prove complete Sage command policy or coverage of other tools.

Event ordering under races, compaction, subsequent child tasks and real-model consumption remain separate checks. These results do not activate Sage.

## Subsequent assignment evidence

Run `node scripts/probe-codex-lifecycle.mjs --follow-up` with fake process tools first on PATH.
The isolated fixture gives the completed child a second task, then checks its native completion marker.
It requires the same child identity, one start event, and two stop events with distinct turn IDs.
The follow-up tool returns an empty string. That result does not identify the child's new turn.
A wait can time out when completion already reached the parent. The fixture checks native status after the wait.

The probe uses simulated model responses. It does not establish real-model report acceptance or authorize capacity release.
The runtime must bind each accepted assignment to its own child turn before a stop can release that assignment.
A child's earlier stop must never release its later assignment. This binding remains unfinished.

The stop callback's transcript path names the parent transcript in the isolated 0.160.0 probe.
The observer instead reads the child transcript saved at its verified start.
Each task message follows a matching `task_started` and `turn_context` record.
The probe checks the message's author, recipient, and content hash against the expected task for each stopped turn.
These checks pass for the initial task and its follow-up. They establish fixture delivery, not real-model consumption.
The protected transcript reader now checks these identities and message hashes against an exact expected turn.
It refuses linked files, incomplete snapshots, conflicting messages, and oversized transcripts.
Its bounds are 16 MiB and 65,536 records; exceeding either bound requires reconciliation.
It does not authenticate the hook caller or allow a journal update.
The follow-up probe now also checks an exact accepted sender call with
`readNativeFollowup`, including target text and the saved task hash.
This receipt does not resolve the target or grant permission. Atomic admission
and later-assignment lifecycle integration remain required before capacity release.

## MCP lifecycle readiness

The isolated 0.160.0 probe received child stop events through MCP with the child's thread ID on the connection.
The callback's transcript path still named the parent transcript.
The child's first supported tool call supplied both the child connection ID and its own transcript.

The command observer received the initial child start. The MCP observer did not receive that start.
Root tool templates must omit `agent_id`: that field is absent from root tool events.
After correcting those templates, root tool callbacks and child stop callbacks arrived, but the MCP start callback remained absent.
The [hook contract](https://learn.chatgpt.com/docs/hooks) requires an existing MCP connection; hooks do not start or reconnect servers.

The preparation tool now returns the saved role, report format, and brief as one message.
Native spawn admission requires that exact message before it reserves a slot.
The caller copies the returned name and message unchanged; Sage does not override native approval.
Local server tests verify delivery, unchanged retries, and refusal of altered or swapped instructions.
Both new tests fail on main: it returns no message and admits arbitrary task content.
The composed policy now binds the child at its first tool call using the verified transcript, admitted dispatch, and saved task hash.
A missing parent result or conflicting identity denies the tool and retains the reservation.
The preparation receipt requires `fork_turns: "none"`; admission rejects inherited histories.
The verified child transcript path is saved for later stop processing.
The stop adapter now uses that saved child transcript, not the parent path in the stop callback.
It checks the current connection, session, assignment, exact turn, and saved task hash before releasing capacity.
Duplicate stops release no additional capacity. Stops after Sage off can still release their own bound assignment.
Missing binding or transcript evidence retains the reservation; completion does not accept a report or mark a task successful.
The packaged MCP tests cover these paths. The complete installed workflow and real-model pilot remain unverified.
Later native fixture runs also received the MCP start callback. The first-tool check does not depend on its delivery.


## Nested native lifecycle evidence

The repeatable probe now accepts `--nested` for chief, child, and grandchild execution.
Run `node scripts/probe-codex-lifecycle.mjs --nested` with the test process fixtures first on PATH.
The local 0.160.0 run returned both exact completion markers and matched both assignments to their child identities and turns.
The synthetic model catalog must declare `multi_agent_version: "v2"` so the child receives collaboration tools.
Both spawns use `fork_turns: "none"`. Inherited history adds parent metadata and is not supported by the current identity reader.
The reader now ignores plain result notifications when it checks encrypted task delivery.
A plain notification cannot establish task delivery, and duplicate encrypted task payloads still fail.
Baseline, denied-spawn, follow-up, and nested routes passed against the local CLI.
These checks use simulated model responses and temporary profiles. They do not prove installed Sage or a real-model pilot.


## Native owner activation evidence

An isolated local 0.160.0 run sent `sage mode` through the native `UserPromptSubmit` MCP callback.
The production owner-mode adapter verified the connection and transcript, then recorded one active owner in the temporary journal.
The probe used simulated model responses. It did not install or enable Sage in the owner's real profile.
The repeatable integrated check now connects activation, preparation, child binding, and completion through native callbacks.
Run `node scripts/probe-codex-lifecycle.mjs --sage` with the test process fixtures first on PATH.
It uses the packaged hook and preparation servers in a new temporary profile.
Only the temporary preparation tool receives an explicit tool approval.
The MCP start hook is absent; the journal has no binding before the child's first tool call.
The final journal contains one owner, preparation, reservation, binding, and exact completion.
The local 0.160.0 run passed and removed its temporary profile.
This fixture uses a fixed harmless tool policy and simulated responses.
It does not verify the complete product policy, installed operation, report acceptance, or real-model consumption.


## Required hook outage blocks activation

Run `node scripts/probe-codex-lifecycle.mjs --sage-hook-outage` with the test process fixtures first on PATH.
This readiness check uses the same temporary profile and preparation path as `--sage`.
After native identity validation, the test hook server records the spawn attempt and exits before admission.
The outage remains active on later connections. The fixture never signals another process.
The server remains configured with `required=true`.

On local Codex 0.160.0, the native child started and completed without a Sage reservation.
The check returned exit code 1 and `failClosed: false`, then removed its temporary profile.
The successful `--sage` control still records one preparation, reservation, binding, and completion.
These are simulated-model checks of the actual native transport. They do not establish a live project workflow.

This failure blocks automatic activation on the tested transport.
A successful startup requirement does not establish required evaluation before every tool dispatch.
The native [PreToolUse implementation](https://github.com/openai/codex/blob/main/codex-rs/hooks/src/events/pre_tool_use.rs) leaves a failed hook non-blocking.
The open [upstream issue](https://github.com/openai/codex/issues/41979) tracks a mandatory failure policy.
No proposed configuration key is treated as supported by this fixture.
A second advisory hook or a later interrupt cannot prove that the original tool never ran.

Activation requires a supported boundary that denies before dispatch when required policy evidence is missing.
Verify disconnected, absent, untrusted, timed-out, malformed, and unmatched validators, plus permission-request failure and configuration reload.
This fixture proves only the persistent disconnection case. The other failure cases remain unverified.
Report acceptance, recovery, and the complete policy can proceed while this activation dependency remains open.


## Native report intake

The preparation server now exposes `sage_read_report` for a parent's own named child.
It requires the current owner epoch, exact assignment binding, and recorded native completion.
The reader checks the assigned task and report in one bounded transcript snapshot.
It accepts only a retained assistant message that matches the completed turn's final text.
It refuses incomplete, foreign, forged, duplicate, or conflicting terminal evidence.

The shared parser requires seven nonempty report fields and status `done`, `blocked`, or `question`.
It accepts plain field labels, common Markdown labels, and a whole report enclosed in a text fence.
The 32 KiB limit applies to the complete report. The repository check keeps the fields aligned with Claude's existing contract.
The report tool returns task, run, child, turn, message identity, content hash, and parsed fields.
It reads only: it does not accept a verdict, mark a task successful, or change capacity.

Run `node scripts/probe-codex-lifecycle.mjs --sage-report` with the test process fixtures first on PATH.
The isolated 0.160.0 check passed from owner activation through the parent's native report tool call.
Its model responses are simulated. Claim verification, durable report acceptance, verdict recording, and a real-project pilot remain unfinished.
The required hook outage still blocks automatic activation.


## Durable report receipts

The parent now uses `sage_record_report` with the hash returned by `sage_read_report`.
The core journal records the exact completed binding, task, run, message identity, hash, and report text in one atomic record.
The adapter rechecks native provenance before the first write. A changed hash or another caller is refused.
Concurrent identical writes create one receipt. A conflicting report cannot replace it.
Retries return the original receipt, including after a connection restart or removal of the native transcript.
The journal checks the stored report's hash, required fields, and completed assignment when it reads the receipt.
Valid late reports can be recorded after Sage off; they cannot change mode or release another assignment.

The native `--sage-report` route now reads, records, retries, and reads back the same report through actual MCP calls.
The isolated 0.160.0 run passed with one saved report and no duplicate.
These checks use simulated model responses. They prove receipt persistence, not the report's claims or a real-project workflow.
The receipt does not change task/run status or record a review verdict.
The bridge to the shared task logbook, verdict gates, broader recovery, and installed activation remain unfinished.


## Native report-to-run connection

The chief can now call `sage_finish_run` with the saved assignment ID and report hash.
The adapter checks native chief identity and the journal's current owner epoch.
Version 3 configuration fixes an external logbook location; older versions cannot finish a run.
The shared operation checks the actual task, run, and assigned role, then saves exact evidence and finishes that run.
Task state and review gates remain unchanged. A child cannot record its own verdict through this tool.

The isolated 0.160.0 native report probe passes through run completion and an identical retry.
It directly checks the saved report, terminal run, unchanged task and gate tables, and original completion time.
The probe uses simulated responses. It does not prove report claims, a real-project workflow, or installed automatic operation.
Full review cycles, broader recovery, full policy assembly, and activation remain incomplete.
The required-hook disconnection gap still blocks activation on the tested transport.


## Exact-commit review preparation

The configured Codex workflow now saves the review branch, full commit ID, task round, and cycle before dispatch.
Shared state reads the actual task branch from Git and checks the active task/run/role relationship.
The native child receives the immutable target with its role and brief.
A changed head, changed round, or completed run blocks dispatch before capacity is reserved.
A preparation retry cannot silently select another commit or review cycle.

The isolated native report route uses a real temporary Git commit and simulated reviewer responses.
It checks the saved target against a separate Git read, then verifies delivery, receipt persistence, and run completion.
This establishes intended review scope. The next unit checks explicit chief acceptance of those reports.


## Chief review acceptance

The chief can now accept a recorded review against its prepared commit, round, cycle, and role.
Shared state checks the completed run, exact saved report, and current task branch before it adds findings and a verdict.
A blocking verdict returns verified or PR-ready work to reviewing, with a decision row.
Retries preserve the first result. Interrupted writes block changes and merge checks until the same acceptance recovers them.
Merge checks also refuse a table snapshot that overlaps a completed acceptance.

The isolated native probe checks the actual acceptance tool, saved verdict, and duplicate request with simulated reviewer output.
One clean review does not approve a task or PR. Required project checks and other review cycles still apply.
This unit does not prove review quality or full automatic coordination.
Broader recovery, full command policy, installation, and a real-project pilot remain unfinished.
The required-hook disconnection gap still blocks activation.


## Chief inspection of a lead's saved reports

The chief can inspect a recorded assignment and exact report hash through `sage_read_recorded_report`.
A lead still owns its child's initial report read and recording. The chief sees the saved text and provenance without changing state.
Packaged tests cover the nested lead-to-reviewer route, foreign caller refusal, and transcript loss after recording.
The isolated native report probe checks the visible chief read tool before run completion and review acceptance.
This does not complete cross-session recovery, independent review scheduling, or a real-project pilot.


## Native lead-to-reviewer report transfer

The `--sage-nested-report` route now verifies the complete chief-to-lead-to-reviewer path through CLI 0.160.0.
The lead prepares its reviewer, waits, reads and records the child's report, then returns the saved reference in its own report.
The chief reads and records that report, finishes both runs, inspects the saved review, and accepts one exact-commit verdict.
A retry creates no duplicate. The probe directly checks two preparations, reservations, bindings, completions, reports, and completed logbook runs.
It also checks native dispatch, start, and stop identities for both children.

The test uses an actual temporary Git commit and simulated model responses. Task and gate state stay unchanged, and merge readiness remains false.
Required project checks, other review roles and cycles, repair scheduling, and a real-project pilot remain unfinished.
This verifies the existing runtime operations together; it does not activate the installed workflow or resolve required-hook disconnection.


## Initial no-tool child completion

A native reviewer that returned immediately previously remained unbound, and Sage blocked its stop.
A callback field probe identified `agent_transcript_path` as the child transcript; the ordinary transcript field identified the parent.
The stop adapter now uses that verified field to perform the same exact initial-task binding as the first-tool path.
The real 0.160.0 CLI probe passes with one child model request and no child tool calls, through chief review acceptance.
It uses simulated responses and an actual temporary Git commit. The temporary profile is removed.

Packaged tests cover wrong identities and turns, changed task text, missing results, mode-off recovery, duplicate stops, and interrupted observation publication.
Later assignments, other blocking stop hooks, interruption, broader recovery, and installed activation remain separate checks.

## Bounded native report correction

The prepared Codex stop boundary now matches Claude's field-presence correction: block the first incomplete report, then let the native retry finish.
It requires authenticated child identity and the native boolean retry flag; malformed callbacks do not gain this escape.
Report values still need strict parsing and separate acceptance. A terminal child with an invalid report releases capacity without a saved report or verdict.

Run `--sage-report-correction` and `--sage-report-escape` with the native probe and fake process tools first on PATH.
The first route repairs the report on the same turn and records it. The second ends with the same invalid report and leaves the task run and verdicts unchanged.
These checks use simulated responses. Full policy, broader recovery, installation, and a real project pilot remain incomplete.

## Unknown-model dispatch recovery

The native failed-spawn probe verified an unknown-model rejection after Sage reserved capacity and before any child existed.
Codex emitted no post-tool hook, and its hook list omitted the configured `PostToolUseFailure` event.
The adapter now reads the protected parent transcript for this exact preflight rejection and records an immutable failure receipt.
It checks before a new spawn and after native list or wait operations. Other errors and ambiguous evidence retain their slots.

The `--sage-failed-spawn` route uses a total cap of one. It rejects one spawn, then binds and completes a new child in the freed slot.
This uses simulated responses in the actual native CLI. Other failed starts, interruption, follow-up assignments, and broader recovery remain incomplete.

## Probe cleanup

The probe removes its temporary profile after the native process closes.
Its two-minute timeout ends the transport, then waits for native process closure.
If the process does not close, the probe remains pending and must not report cleanup.
It does not inspect or signal processes. A spawn error also waits for closure.
The final cleanup record confirms that the temporary folder is absent.

Older probes can leave folders named `sage-codex-one-child-` followed by random
characters. To find the temporary directory, run `node -p 'require("node:os").tmpdir()'`.
After your probe exits, inspect each matching folder in your file manager.
Remove only old probe folders that contain the test profile, scripts, and captured
events. Keep any folder used by a probe that is still running. Do not delete the
whole temporary directory or unrelated Sage folders.


## Chief context restoration after manual compaction

The native compaction probe found that local history replacement removed both chief-instruction parts while owner and logbook state stayed unchanged.
The prepared SessionStart handler now restores both parts for the authenticated active root owner after the verified compact event.
It changes no mode, owner, task, run, or admission record. Off mode restores no instructions; failed rendering remains retryable.

The actual 0.160.0 app-server probe checks matched compaction events, a persisted record with its response and window identities,
and the next model request containing the fixed summary plus both exact chief parts. The off control contains neither part.
The automatic route also verifies native trigger `auto`, using fixed simulated token usage and no manual compaction request.
These checks use simulated responses and no active children. Remote compaction, child context, installed activation,
and a real-project pilot remain separate work. See [the compaction contract](compaction.md).
