# Chief context after native compaction

Codex CLI 0.160.0 removes hook-added developer context during local manual
compaction. The owner and Sage logbook can remain valid while the model loses
the chief instructions. The native probe reproduced this with both exact
instruction parts absent from the next model request.

The prepared MCP handler now supports the observed `SessionStart` event with
source `compact`. It checks the current native connection, root session
metadata, fixed project directory, and active owner mode. It returns the same
two bounded chief-instruction parts. Startup returns no new instructions.
Unknown sources, child identities, invalid parts, and unavailable evidence
return the native `continue: false` output. A rendering failure changes no
state; a later retry can restore the context. The handler rechecks mode after
rendering and never activates a mode or changes ownership.

Run `node scripts/probe-codex-compaction.mjs` with fake process tools first on
PATH. The probe activates Sage, requests actual native manual compaction, and
submits an ordinary follow-up. A fixed simulated summary deliberately excludes
the chief instructions. Matching native start/completion events and a saved
compaction record prove that compaction occurred. The next model request
must contain both exact instruction parts and the summary. Owner, epoch, mode,
tasks, runs, and admissions must remain unchanged.

Add `--sage-off` for the inactive control. It runs the same native compaction
and requires no chief instructions before or after it. Both routes use a fresh
profile, fixed simulated responses, no child dispatch, and graceful process
closure before removing temporary files.

Add `--automatic` to test native compaction before the next ordinary turn.
The simulated first response reports 200,000 tokens against a 100,000-token
threshold. The probe sends no manual compaction request. It requires native
PreCompact and PostCompact events with trigger `auto`, the saved record, and
both exact instruction parts in the next model request. Combine it with
`--sage-off` for the inactive control. Token counts are fixed fixture inputs,
not measurements of real model use.

This verifies manual and automatic local-provider compaction without active children.
Remote compaction, child context restoration, active-child
restart, cross-session transfer, real-model behavior, and installed automatic
Sage remain unverified. The required-hook outage still blocks activation.


## Child compaction readiness

Run `node scripts/probe-codex-lifecycle.mjs --sage-child-compaction` with fake
process tools first on PATH. This is a readiness check, not a passing feature
check. The actual 0.160.0 CLI compacts a running child after a fixed simulated
response reports 200,000 tokens against a 100,000-token threshold.

The probe requires a saved child compaction record and matching automatic
PreCompact and PostCompact events. It checks the child's next model request
for the exact prepared assignment. The current runtime loses that assignment;
Codex sends no child SessionStart event with source compact. The saved
reservation and binding remain intact. The initial diagnostic also found that
Sage rejected the subsequent report: its reader treated the native compaction
summary as an unverified report. The reader now excludes authenticated native
compaction output and requires a later retained final message. A summary cannot
complete a task or preserve an earlier final message as the report.

Without an assignment read, the stop gate refuses the report and retains the
reservation. This readiness route supplies no recovery read. It remains a
negative control; use the recovery route below for the repaired path.

The root restoration handler cannot cover this native event gap. The child
reader below restores the complete prepared role instructions, report format,
saved target, and brief. The native probe compares that exact message with the
child's next model input. No installed automatic activation or real model
participates in this probe.

## Read the current child assignment

The visible `sage_read_assignment` tool takes no arguments. Its native caller
must have one active, delivered assignment in the current owner epoch. The
reader checks the saved child transcript, current turn, task hash, run target,
and review commit when present. It returns the exact prepared role and brief.
A completed or interrupted turn, changed target, missing evidence, or another
actor cannot read an active assignment. An existing child can read its task
after Sage off, so it can finish the work already assigned to it.

The reader changes no admission or task state and grants no tool permission.
It refuses a concurrent lifecycle change observed during the read. Existing
native permission and workflow checks still apply to later actions.

Run `node scripts/probe-codex-lifecycle.mjs --sage-child-recovery` to compact
a native child and attempt a tool call and a report before recovery. The
production gates deny both. The same child then reads its assignment, receives
the exact saved instructions, and attempts another report after the fixture
changes its task branch. The gate refuses that stale target too. After the
fixture restores the saved target, the child completes once. The probe checks
three stops in the same turn and no premature completion. Responses are
simulated; this does not prove that a real model follows the recovery instruction.


## Verify complete reader output

`readRecoveryOutput` checks one saved native reader result against the child's
turn and exact task hash. It requires native MCP attribution and the saved
output budget. The complete two-part text output must survive native replay
without a change. Each part costs the ceiling of its UTF-8 byte length divided
by four. The saved budget already includes the native serialization allowance.
Missing budgets, unknown shapes, changed assignments, and insufficient budgets
are refused. This follows Codex `rust-v0.160.0`:

- [MCP output and the first truncation pass](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/core/src/tools/context.rs).
- [History replay and the saved budget](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/core/src/context_manager/history.rs).
- [Content-item truncation](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/utils/output-truncation/src/lib.rs).
- [UTF-8 token estimate](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/utils/string/src/truncate.rs).

The native recovery probe checks this output evidence before declaring recovery.
The function does not authenticate a transcript path, find the matching call,
or prove ordering after the latest compaction. The production gates use the
protected transcript reader below to establish those facts. Installed Sage
remains disabled.


## Bind the recovery to compaction

`readNativeRecovery` reads a bounded, protected transcript snapshot. It verifies
the exact assignment delivery and native child identity before inspecting
compaction. A matching reader call and complete output must follow the latest
checkpoint in that assignment's turn. A later checkpoint invalidates the read.
An earlier turn, an orphan result, a failed read, or a shortened result cannot
restore the assignment. A new valid read can retry a failed result.

The reader refuses conflicting checkpoints, duplicate calls or results, pending
compaction, and recovery after a native terminal event. Its result includes the
recovery output's position so report acceptance can require a later report.
The native recovery probe verifies that compaction first requires recovery,
then verifies the matching call and output after the reader returns.

Child tool permission now requires this evidence before ordinary work continues.
The assignment reader still passes through the normal tool policy. The gate
checks again after an awaited policy evaluation. Existing children keep this
requirement after Sage off. A reserved task can reach its first tool before
Sage records a child binding. The off-mode path now checks that pending claim
against the native transcript and parent result before treating the child as
unmanaged. This also covers a reserved follow-up. It creates no new reservation
and does not turn Sage on. Changed delivery or missing parent evidence refuses
the operation; a later valid parent result can retry the same binding.

Child stop blocks until recovery, including repeated stop attempts. Parent
reconciliation cannot release an unrecovered assignment as successful. Native
interruption can still end it without a report. Report intake requires the final
report to follow recovery in the same protected snapshot. The low-level report
readers expose this acceptance check through `requireRecovery`; both production
completion and report intake enable it.

Before recording a report, the provider saves a recovery proof in its protected
observation store. The proof binds the exact assignment, task, run, owner epoch,
brief hash, report identity, and report hash. It contains no report text. The
provider verifies the native transcript before it writes this proof.

A cached receipt needs one matching proof before it can finish a run, supply a
review verdict, or return through the chief's saved-report tool. Missing or
conflicting evidence refuses the operation. An older receipt can acquire a proof
when its parent records it again and the original transcript passes all checks.
The provider never assumes that an older receipt proves recovery.

The proof is saved before the receipt. A proof without a receipt cannot finish
a run. Identical retries reuse both records. Once both exist, the receipt remains
usable after transcript removal.

Before new success after compaction, child stop and parent reconciliation check
the current run against its saved preparation. Review roles also need the same
commit, round, and cycle. A changed or ended run refuses completion in either
Sage mode. Native interruption can still end the assignment without success.
A completion already recorded under these checks remains historical evidence.
These checks detect the observed target; they do not lock Git and both stores
in one transaction.

Independent reviews and a real-model pilot remain. These changes do not enable
installed automatic Sage.


## Repeated reader calls

Codex MCP attribution records cumulative source checkpoints. It does not repeat
an unchanged checkpoint for each tool result. Its first-turn field identifies
the source's first use, not the current reader call. See the
[pinned native recorder](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/core/src/tools/executed_tool_calls/mcp_attribution.rs).

Recovery now joins the saved result to its exact native reader call. Both records
must belong to the assignment turn and come from native history. The call must
use the fixed reader namespace and name with empty arguments. The result must
still pass the child, task hash, complete-message, and replay-budget checks.
Cumulative source metadata cannot replace this call evidence.

Run `node scripts/probe-codex-lifecycle.mjs --sage-child-repeat-recovery` with
fake process tools first on PATH. The isolated probe compacts one child twice
in the same turn. It verifies that the second checkpoint invalidates the first
recovery, denies an ordinary tool and early report again, and accepts a fresh
read. A changed target still blocks completion. After target restoration, the
same assignment completes once, with no duplicate reservation or binding.
The native run uses simulated model responses and removes its temporary profile.
