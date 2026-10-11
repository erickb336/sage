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
permissions. A callback cannot override a read-only role. Shell writes and other
write-capable tools require their own rules.
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
issue another permission. The callback cannot change the reserved input by
mutating its copy.

Dispatch results are recorded independently of mode. Child starts are recorded
before instruction assembly. When Sage is on, assembly requires the complete
binding evidence and saved brief. When Sage is off, the start passes without
Sage instructions. Missing evidence causes an error and retains capacity; this
module does not wait for a late dispatch result. A child-start error cannot stop
a native child, so delivery is not enforcement.

The supplied tool policy must enforce command, path, role, and workflow rules,
including follow-up and message permissions. This composition does not invent
those rules or authorize operations the callback rejects. It does not detect
missing callbacks, restore compacted context,
or provide lifecycle recovery. Those remain required before activation.

Native stop observations retain capacity until the transcript confirms the assigned turn ended.
Parent list, wait, and report-read operations reconcile that evidence.
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
