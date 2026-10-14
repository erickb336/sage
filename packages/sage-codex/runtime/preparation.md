# Native task preparation

`servePreparations(options)` exposes one model-visible tool, `sage_prepare_task`,
in a separate MCP server. Keep the hidden hook server required, with connection
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

## Finish a recorded run

`sage_finish_run` accepts an assignment ID and exact saved report hash from the current chief.
The launcher supplies configuration version 3 with a fixed external `logbookRoot`.
The tool requires a saved receipt and recovery proof, writes exact report bytes, and finishes only its matching run.
Identical retries preserve the original result; an interrupted publication can resume without rewriting evidence.
Tasks, verdicts, admission, and mode remain unchanged. This does not enable installed automatic Sage.

The consumed native check is `node scripts/probe-codex-lifecycle.mjs --sage-report`.
It uses a fresh profile and simulated responses, records the verified report, removes its child transcript,
finishes the run, and retries. It checks exact saved report bytes and unchanged task, verdict, admission, and mode records.
Run it with fake process tools first on PATH. It does not verify a real model or installed automatic activation.
