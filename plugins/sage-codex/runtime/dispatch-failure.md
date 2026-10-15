# Native failed dispatch recovery

Codex 0.160.0 records two captured preflight rejections in the parent's protected transcript: an unknown model or the agent thread limit.
The isolated probe observed a pre-tool callback, no post-tool callback, no child, and an occupied Sage reservation.
A configured `PostToolUseFailure` event did not appear in the native hook list or run.

The adapter now reconciles this verified preflight rejection before a new spawn and after native list or wait tools.
It requires the current transport actor, owner epoch, original request, exact call and turn, and matching argument hash.
The transcript must identify that actor and session. The call must name native `collaboration.spawn_agent`.
Native metadata must mark both records as not client-authored. An unknown-model error must name the dispatched model.
The capacity error must equal `collab spawn failed: agent thread limit reached`; it also supports an inherited model.
Linked files, conflicting calls, changed arguments, and forged metadata refuse. A call or result after native turn completion or interruption refuses. Valid failure evidence recorded before termination remains readable. Other errors retain capacity.
Any successful dispatch result, child-start evidence, or saved binding also retains capacity on this path.

The adapter saves a failure receipt, not a child completion. The journal rejects a late binding and duplicate release.
A reused lead keeps its original native identity across separate assignment bindings.
Recovery verifies that original binding and each binding's parent, rather than requiring one historical assignment.
It can record a failed child dispatch after the lead completes or Sage turns off, without reviving either assignment.
The caller can then prepare a new named child. The failed call and preparation remain in history.
This does not infer failure from elapsed time, absent hooks, a model's claim, or a list result alone.

Run `node scripts/probe-codex-lifecycle.mjs --sage-failed-spawn` with fake process tools first on PATH.
The isolated native check sets the total cap to one, rejects an unknown model, then completes a new child in the freed slot.
The journal must contain two reservations, one failure, one binding, and one completion.
Responses are simulated. Unrecognized failure kinds, active-child process restart, cross-session transfer, and installed automatic operation remain separate work.

Run `node scripts/probe-codex-lifecycle.mjs --sage-followup-failed-child` for a reused lead.
Its second assignment prepares a reviewer, receives the native unknown-model rejection, and reconciles through its own list call.
The probe checks one failure receipt, no extra child, and two preserved lead bindings and completions.
The chief reads both lead reports and records the second. Responses are simulated.
This route verifies failed-dispatch recovery, not a successful retry or review quality.

Packaged tests also check off-mode recovery, foreign-parent evidence, another actor, unchanged retries, and capacity release.
Capacity tests use labelled synthetic reservations through the public admission API; they do not launch replacement agents.
Production recovery already exists on main. These checks do not establish real-model behavior or automatic Sage activation.

The pinned [native capacity check](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/core/src/agent/control/spawn.rs) runs before child creation.
The [error adapter](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/core/src/tools/handlers/multi_agents_common.rs) supplies the observed error prefix.
Only the exact captured result releases capacity; extra text, another error, or conflicting evidence cannot do so.
Run `node scripts/probe-codex-lifecycle.mjs --sage-capacity-rejection` for native capacity rejection and retry.
It uses native capacity one and Sage capacity two, holds one child, rejects another, then completes a fresh retry.
Model responses are simulated; the check does not enable installed Sage or prove real-model behavior.

## Recover a rejected follow-up

A follow-up can fail when Codex restores an evicted child while another child occupies its native capacity.
The captured result is exactly `collab tool failed: agent thread limit reached`.
The runtime checks the protected sender call and result, saved predecessor, recipient, message hash, argument hash, owner epoch, and turn.
It also checks the recipient's previously verified transcript. A delivered message, successful callback, or binding retains the reservation.
Missing or ambiguous evidence never proves failure.

Core records this failure separately from an initial spawn failure. Its atomic journal prevents failure and binding from both winning.
The failed attempt keeps its preparation and reservation history. A fresh preparation and call can use the original completed predecessor.
An active competing continuation still blocks that retry. Failed attempts cannot become later delivery candidates.
List and wait callbacks can reconcile the exact failure after Sage turns off; they do not finish a task or run.

The pinned native [message handler](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/core/src/tools/handlers/multi_agents_v2/message_tool.rs)
uses the tool error prefix. Its [control API](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/core/src/agent/control/api.rs)
loads the recipient before it submits the message. This covers the captured restoration preflight rejection, not arbitrary follow-up errors.

The child can request its first tool before the parent's successful follow-up result reaches the transcript.
For an exact live parent call and verified recipient delivery, the policy waits for that result before binding or evaluating the tool.
It retries this pending evidence at most 40 times, with a 25 ms delay between reads.
A mode change, interrupted child, malformed evidence, conflicting result, or exhausted wait refuses the tool.
The wait grants no permission and does not replace either proof.
