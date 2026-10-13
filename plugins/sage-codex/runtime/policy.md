# Native policy composition

`createNativePolicy(options, evaluateTool)` joins the prepared native adapters.
The launcher supplies validated configuration and a complete tool policy.
There is no default tool policy. This module is not an installed entry point.

The MCP boundary authenticates each tool actor, dispatch result, and child
start before calling this interface. Tool evaluation records recognized
identity events even when Sage is off or the tool policy denies the request.
It then calls the supplied tool policy with a private input copy and the native
actor, version, current Sage mode, and verified role. The role comes from the
current child binding, or from the authenticated chief. Off mode supplies null.
Only an exact pass or denial is accepted.

Every active child tool call requires its current native turn to remain unfinished.
The policy checks before binding and again after an awaited evaluator, before returning permission.
A completed or interrupted turn refuses new tools without releasing capacity or changing a run.
Report and stop readers still accept ended turns for their separate evidence checks.

Every active child tool call also checks its bound task and run in the configured
logbook. Preparation saves the run target in the admission journal: task, run, role, round,
task branch, run branch, and candidate. Dispatch, lead delegation, and child tool
calls must match those saved fields. The run must also remain running and unreported.
An older preparation without a target remains readable for reports and recovery,
but cannot permit new work. A changed target needs a new run and brief. An ended run or terminal task cannot keep using tools through
an earlier binding. Before returning a pass, the policy repeats this check and
compares the assignment fields. A change during an awaited evaluator refuses the
call. This is a boundary check, not a lock held through native execution; it
cannot revoke a permission after the hook returns. Off-mode operations keep
ordinary evaluation. Report and completion handling remain separate so stopped
work can still record evidence.

Direct `apply_patch` calls from an active chief, lead, PE, reviewer, or QA agent
are denied before the supplied evaluator runs. The shared role rule permits
implementers, designers, and arena judges to reach the evaluator. This is not
permission to write: the evaluator must still check paths, workflow, and native
permissions. A callback cannot override a read-only role. Known shell write forms also refuse read-only roles before the evaluator.
This text-only check uses the shared classifier without assuming an execution
directory. It denies redirections, writer commands, executable reader options,
and text the parser cannot read. It does not establish a trusted shell or
directory, or prove that arbitrary scripts cannot write. Other write-capable
tools and the complete command policy remain separate requirements.
For every `Bash` event, it first verifies the original native command.
This also applies while Sage is off, because logbook protection is independent of mode.
The hook input must contain only `command`. The callback receives the complete
original arguments in `context.command`, including fields omitted by the hook.
The command decoder validates their complete supported wire shape first, including
nested permission requests. Unknown fields and malformed values refuse evaluation.
Omitted fields remain omitted; the decoder does not infer execution defaults.
While Sage is on, a child must bind to its admitted task before this read.
An off-mode command needs no admission, but still needs authenticated identity.
While on, the child's recorded start supplies the expected parent and task path.
While off, its protected transcript supplies those fields, including for later turns.
Conflicting stored start records refuse the command. This identity read does not
create a Sage admission or authorize a follow-up assignment. Missing or conflicting command
proof refuses the operation before the callback runs. The callback must validate
all recovered arguments and apply the command rules; recovery grants no permission.
A mode change during evaluation refuses the operation. This check does not
revoke native permission after it returns. A successful spawn in
Sage mode must also consume a prepared assignment exactly once. Retries do not
issue another permission. An active-mode follow-up must likewise consume its
pinned preparation after exact pending-call verification. Unprepared follow-ups
refuse even if the callback passes them. A later child turn binds only after
accepted sender dispatch and exact received-task verification. Completion and
reports select that assignment's turn. This does not activate the installed runtime.
The callback cannot change the reserved input by
mutating its copy.

Dispatch results are recorded independently of mode. Child starts are recorded
before instruction assembly. When Sage is on, assembly requires the complete
binding evidence and saved brief. When Sage is off, the start passes without
Sage instructions. Missing evidence causes an error and retains capacity; this
module does not wait for a late dispatch result. A child-start error cannot stop
a native child, so delivery is not enforcement.

The supplied tool policy must enforce command, path, role, and workflow rules,
including follow-up and message permissions. This composition does not invent
those rules or authorize operations the callback rejects. It reconciles the bounded
completion and failure cases described below. Missing initial evidence, compacted
context, cross-session recovery, and required-hook outage protection remain incomplete.

Native stop observations retain capacity until the transcript confirms the assigned turn ended.
Parent list, wait, and report-read operations reconcile that evidence, including when a stop callback was missed.
They can also bind a prepared follow-up through its predecessor's verified transcript path and exact accepted delivery.
Report recording and review acceptance use separate explicit operations.


When Sage is off, an ordinary child with no matching run or pending first-task
reservation can finish without a Sage report. The stop handler verifies the
protected native identity and returns `unmanaged`. It changes no admission or
logbook record. Existing Sage bindings still require completion evidence, and
pending first-task reservations still require binding. An unmatched active-mode
child does not receive this exception.

Run `node scripts/probe-codex-lifecycle.mjs --sage-off` with fake process tools
first on PATH. The isolated native check verifies an ordinary child's completion,
its exact stop receipt, no Sage capacity use, and an unchanged logbook. Responses
are simulated; this does not prove installed operation or recovery of tracked work.

Run `node scripts/probe-codex-lifecycle.mjs --sage-readonly-patch` with fake
process tools first on PATH. The real native lead receives a patch tool, attempts
one fixed harmless patch, and receives the exact role denial. The evaluator
never runs, the file does not exist, and the child completes its report. The
responses are simulated; this is not an installed-session or real-model pilot.

Run `node scripts/probe-codex-lifecycle.mjs --sage-ended-run` with fake process
tools first on PATH. The fixture ends its lead run after native dispatch but
before the child requests a read-only tool. The real hook must deny that call;
no successful tool event may follow. Completion still records the child's end,
and the run remains done. The model responses are simulated.

Run `node scripts/probe-codex-lifecycle.mjs --sage-retargeted-run` to check a
valid branch change after dispatch. The fixture keeps the run active but changes
the task branch. The native child must receive a denial, with no successful tool
event. The original saved target and changed logbook remain intact. Completion
still records. This is isolated native transport with simulated model responses.


A Sage child can send a native message only to `/root` or the authenticated session ID.
This matches Claude's chief-only child messaging rule. The rule also applies after Sage off
when the current session journal identifies that child as a Sage assignment.
Ordinary off-mode children and the chief still use the supplied evaluator.
A valid chief target is not permission by itself: the evaluator and native permissions must also pass.
Unknown fields, empty messages, and malformed message values refuse evaluation for a Sage child.
This rule does not grant follow-up or interruption permission.

Run `node scripts/probe-codex-lifecycle.mjs --sage-child-message` for the native check.
It verifies a peer denial and exact progress-message delivery to the chief through real native agents.
The chief waits for the child's terminal state after the progress message wakes its wait.
The model responses are simulated. Off-mode coverage uses isolated adapter tests.

A child cannot request `require_escalated`, `with_additional_permissions`, or non-null
`additional_permissions` in a native command. This rule applies before the supplied
evaluator, in either Sage mode. Ordinary child commands and chief commands retain
that evaluator and Codex's native permission checks. The recovered request proves
permission intent; it does not prove the effective inherited sandbox.

Run `node scripts/probe-codex-lifecycle.mjs --sage-child-sandbox` with fake process
tools first on PATH. A real native child requests escalation for a fixed harmless
command. It must receive Sage's exact denial, with one pre-tool event and no post-tool
event. The child then completes its report, and the probe verifies cleanup.
The capture stores a fixed-command match flag, not command text. Responses are
simulated. Additional-permission and off-mode cases use adapter tests; this probe
checks `require_escalated` while Sage is on. It does not establish installed activation
or protection when Codex skips a required hook.

## Child messages

A Sage child can send a message only to the root chief, by `/root` or its session ID.
This restriction remains after Sage off for a child bound to the current owner epoch.
A message could otherwise wake another child without a prepared task or a reserved slot.
Chief messages and unassigned off-mode children still use the supplied evaluator.
A permitted target also needs current assignment recovery and the evaluator's permission.
This matches Claude's message rule. It does not enable automatic Sage.

Run `node scripts/probe-codex-lifecycle.mjs --sage-child-message` with fake process tools first on PATH.
The native CLI 0.160.0 probe uses simulated responses and a temporary profile.
It checks peer refusal before evaluation, exact chief delivery, normal completion, and cleanup.
The model catalog explicitly selects native multi-agent V2 for children.
