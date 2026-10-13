# Native task preparation

`servePreparations(options)` exposes task preparation, report reading, report recording,
chief run completion, and review acceptance in a separate MCP server. Keep the hidden hook server required, with connection
startup readiness. A visible tool on that server can delay a child's hooks.

The launcher fixes `directory`, `project`, and `observationsRoot`. The last path
contains one observation directory per native root UUID. These paths must be
trusted local storage. The preparation server never accepts paths, sessions,
issuer IDs, or ownership claims from tool arguments.

The tool accepts a task ID, run ID, unique child name, requested role, and all
ten brief fields. Native connection metadata supplies the runtime version and
actor. An activated owner acts as chief. A lead needs its saved assignment and
child binding, plus matching request, result, and start observations. Ambiguous
path reuse refuses the request. Specialists cannot prepare children.

The tool saves the instructions through core and returns a preparation receipt.
It starts no agent and occupies no capacity. The receipt includes the complete
saved role, report rules and brief as `message`, plus `fork_turns: "none"`. Pass
these exact values and the returned name to the later native spawn. The actor,
project and owner epoch must still match.
Retries cannot replace instructions. A receipt is not spawn permission.

`reservePreparedSpawn(rawInput, nativeContext, options)` handles the actual
native PreToolUse spawn. Pass the raw payload before adding a derived `agent_id`.
It records the request, including rejected or inactive attempts, then checks the
actor, the exact prepared message and the fresh-context setting. Changed,
missing, invalid UTF-8 or oversized messages are refused before capacity changes.
The admitted dispatch stores the message SHA-256 as `taskHash`. Earlier dispatch
records without that field remain readable; later delivery checks still need
exact evidence. Only `permit-once`
can pass the spawn. An `already-reserved` result must not grant another dispatch.
The command hook must retain its normal native permission checks.

Tool input validation and preparation failures return a fixed visible error.
The SDK can reject malformed outer requests before the handler. This visible
error response is separate from the successful MCP denial required by hooks.

This server is not installed. Setup and full policy assembly remain required.
Callers must capture every dispatch continuously, including mode-off and resumed
sessions. A missing callback cannot be detected from saved observations alone.
Child delivery before result publication, compaction, lifecycle recovery, and
capacity release still need integration. Neither server repairs capture gaps or
establishes authority from a saved name alone.

## Native verification

An isolated Codex 0.160.0 check uses the packaged preparation server and hidden
hook server. The owner prepares and spawns a lead. That lead prepares and spawns
QA. Both children receive their complete saved brief and role in their first
model request. The journal links two preparations to two native dispatches and
records each actual issuer. The check uses local mock responses and a test
policy; it does not establish a production project workflow.

The mock model catalog must declare `multi_agent_version: "v2"`. Without that
capability, native Codex omits collaboration tools from the lead. The initial
nested check caught that fixture error. Codex's pinned
[tool-selection source](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/core/src/tools/spec_plan.rs)
requires this capability for a V2 child's collaboration tools. Installation must
verify the selected model's capabilities too.


## Chief run completion

`sage_finish_run` accepts only a recorded assignment ID and its exact report hash.
The current native root chief must own the receipt's project, session, and epoch.
A child or another chief cannot finish that run. The receipt must already be in the shared journal.
The tool uses the launcher's fixed external logbook root and project directory.
It checks the actual task, run, and assigned role through the shared state tool.

The report status finishes only the run. Task state, findings, gates, and review verdicts stay unchanged.
The saved report file contains the receipt's exact text. Identical retries preserve the first completion time.
Manual terminal results or conflicting evidence cannot be replaced.
A report recorded before interruption can finish preserved work after Sage off or transcript removal.
This does not enable Sage, grant capacity, or dispatch new work.

The native `--sage-report` probe includes actual chief tool calls to finish and retry the run.
It checks the logbook and saved report directly, with simulated model responses in a temporary profile.
Independent review cycles, broader recovery, and a real-project pilot remain unfinished.


## Review targets

With a configured logbook, code, security, UX, and QA reviewers must supply `reviewCycle` from 1 through 10.
The caller cannot supply a commit ID. The state tool reads the task branch's current commit from Git.
It checks the actual task, active run, assigned role, and matching task round.
Git repository-selection variables cannot redirect the commit read. The checkout's HEAD can differ from the task branch.

The immutable preparation saves the branch, full commit ID, task round, and review cycle.
Both the dispatched message and bound child instructions include this target.
Dispatch rechecks the current task, run, and branch before reserving capacity.
A changed head or round, completed run, or missing target refuses dispatch under the configured logbook workflow.
A new target needs a new assignment; a retry cannot replace the old preparation.

The report probe now uses a code reviewer and an actual commit in a temporary Git repository.
It compares the preparation to a direct Git read and verifies native delivery, report storage, and run completion.
Responses remain simulated. The target records intended review scope; it does not prove a review occurred.
The next section describes acceptance. Independent review cycles remain unfinished.


## Chief review acceptance

`sage_accept_review` accepts only a recorded assignment ID and its exact report hash.
The current root chief must own the recorded receipt. The run must already be done.
The immutable preparation supplies the review role, branch, commit, round, and cycle.
The tool checks the saved report against that target and the current task branch.
A changed commit or round refuses a new acceptance. A child cannot accept its own review.

Reviewers retain the seven report fields. A completed review uses these values:

| Field | Required value |
| --- | --- |
| STATUS | `done` |
| RESULT | `CLEAN` or `FINDINGS`; QA uses `PASS` or `FAIL` |
| EVIDENCE | JSON with `commit`, `round`, `cycle`, and a nonempty `summary` |
| FINDINGS | JSON array of objects with `severity` and `summary`; `[]` when empty |
| QUESTIONS | `none`; use a question report for an unresolved choice |
| BRANCH | The prepared task branch |
| NOT VERIFIED | What the reviewer did not check |

Each finding uses severity `low`, `medium`, or `high` and a nonempty summary.
Medium or high findings require a blocking result. Low findings can accompany a clean result but remain open for triage.
A blocking result returns a verified or PR-ready task to reviewing and saves the reason.
A clean result does not approve the task, record project checks, or grant merge permission.

Acceptance saves a durable intent before it changes tasks, findings, verdicts, or decisions.
An interrupted update blocks logbook changes and merge checks. Retry the same acceptance to finish it.
Recovery checks each table against the saved before and after values. It refuses unrelated changes or damaged intent.
A concurrent acceptance also invalidates a merge check that read tables from different versions.
An immutable receipt makes later identical requests return the original result without duplicate findings or verdicts.
If the branch changes after a saved intent, recovery retains evidence for the original commit only.

The native report probe checks acceptance and a retry through actual Codex tools, then reads the saved verdict.
Its model responses are simulated. Acceptance validates provenance and report structure, not the truth of review claims.
Full review cycles, repair scheduling, project checks, and a real-project pilot still need integration.


## Chief inspection of saved reports

`sage_read_recorded_report` lets the chief inspect an assignment's saved report by ID and exact hash.
This includes reports that a lead recorded for its own children. The lead must first read and record the child's report.
The chief gets the saved text, assigned role, native issuer, child, turn, and prepared review target when present.
The tool checks the current native root chief, project, owner epoch, and recorded receipt.
It uses the fixed version 3 configuration and cannot select another logbook or project from tool input.

The read changes no task, run, finding, verdict, or admission record. A missing receipt refuses the read.
The chief still cannot read an unrecorded grandchild report through the parent's name-based tool.
A saved report remains readable after Sage off or transcript removal under the same owner.
Cross-session recovery remains separate work.

Packaged tests cover nested lead reports and chief-only access. The native report probe checks the tool and returned evidence directly.
Native model responses remain simulated; these checks do not establish a real-project review.


## Native lead-to-reviewer handoff

`node scripts/probe-codex-lifecycle.mjs --sage-nested-report` checks the complete report handoff through Codex CLI 0.160.0.
The chief prepares a lead. That lead prepares and spawns a code reviewer for an actual temporary Git commit.
The reviewer receives its fixed role, brief, and target. Its first tool binds the assignment to the native child.
The lead waits for completion, reads its child's report, and records the exact hash.
Its own report passes the saved assignment ID and hash to the chief.

The chief reads and records the lead report, then finishes the lead's run.
It inspects the review through `sage_read_recorded_report`, finishes that run, and accepts the review.
A repeated acceptance returns the first result. Direct logbook checks require two completed runs, two saved reports, and one verdict.
Both native completions must match their saved bindings. Task and gate state stay unchanged; merge readiness stays false.

This route uses two real native agents with simulated model responses and temporary state that the probe removes.
It verifies report transport and acceptance, not review quality, project checks, a complete review cycle, or installed automatic operation.


## A reviewer that returns without a tool

`node scripts/probe-codex-lifecycle.mjs --sage-no-tool` checks a native reviewer that returns its report immediately.
The stop callback's `agent_transcript_path` supplies the child transcript. The adapter verifies and binds its exact initial assignment at that point.
The chief report workflow then proceeds through one accepted verdict and an identical retry.
Missing, changed, foreign, or stale transcript evidence refuses completion and retains the reservation.
The later-turn path below adds follow-up binding. Cross-session recovery remains unfinished.


The prepared server also exposes `sage_create_task`; see `task-create.md`.
It frames a task through the shared state tool with a durable request UUID.
Preparation still requires task and run IDs; creating a task does not create
its run or grant an agent slot. `sage_create_run` records the run separately;
see `run-create.md`.

## Saved run target

Native preparation captures the current task, run, role, round, task branch,
run branch, and candidate through the shared state tool. It saves that target
with the brief and includes its branch, round, and candidate in the instructions.
Dispatch, lead delegation, and child tool evaluation compare the current logbook
with the saved target. A changed target requires a new run and brief.

An older preparation without a target cannot authorize new native work. Its
records remain available for report and completion handling. This does not
rewrite old history, infer a target, or change the task's recorded branch.


## Outgoing follow-up admission

`sage_prepare_task` accepts optional `previous`, a completed assignment ID.
The same owner must keep the task and role and record a new run. Use a fresh
logical name for the new assignment. Core pins the predecessor with the brief
and target. The response returns its fixed native child ID as `target` and the
exact task `message`, instead of initial-spawn `fork_turns`.

`reservePreparedFollowup` accepts only that target and complete message. The
message's preparation ID locates one candidate; it confers no authority. The
adapter verifies current ownership, task, run target, and review commit before
reserving capacity. The protected sender transcript must contain the exact
pending native call in its current unfinished turn. A completed call cannot
become a new permission. A duplicate reservation never permits another dispatch.

The composed policy applies this admission check after the supplied evaluator
passes an active-mode follow-up. It saves the sender transcript reference for
later receipt verification. Preparation alone cannot start a child, and an
initial-spawn call cannot consume a pinned continuation. Off mode retains
ordinary policy evaluation.

The packaged checks cover successful reservation and fixed recipients. The
native `--sage-unprepared-followup` probe verifies refusal through the real CLI
with simulated responses: the completed child stays stopped, no second turn or
reservation appears, and the temporary profile is removed. The `--sage-followup`
probe verifies accepted dispatch, a second bound turn, separate completion, and
report intake for the same native child. See `native-followup.md`. Continuation
recovery and installed activation remain unfinished.

## Extraction checks

The prepared-message extraction checks the packaged tool and admission policy.
It verifies complete instructions, exact-byte refusals, fresh context, stable
retries and saved message hashes. It does not establish child delivery through
the native transport, report completion or installed automatic operation.

## A lead's current task

A native lead can prepare and dispatch children only for its unfinished saved assignment's task.
The adapter selects one unfinished binding. Completed and interrupted assignments grant no preparation authority.
A reused lead keeps its original native spawn identity, but its unfinished continuation supplies the current task.
Missing, ambiguous or inconsistent identity evidence refuses preparation.

The adapter checks task scope both when it saves a brief and when it reserves a spawn.
A foreign-task brief saved by an earlier runtime cannot bypass the dispatch check.
Chief preparation remains separate and can select another task.
These checks enforce admission ownership. Current logbook run and held-task checks remain separate work before automatic activation.
