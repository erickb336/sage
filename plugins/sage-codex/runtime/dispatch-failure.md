# Recover a rejected initial spawn

An initial spawn reserves capacity before Codex tries to create the child. The runtime releases that slot only when the protected sender transcript proves one of two captured Codex 0.160.0 preflight rejections: an unknown model or the agent thread limit.

The adapter checks the current actor, owner epoch, original request, call, turn, and argument hash. Native metadata must mark both records as server-authored. An unknown-model error must name the dispatched model. The capacity error must equal `collab spawn failed: agent thread limit reached`; it also supports an inherited model. A call or result after native turn completion or interruption refuses. Valid failure evidence recorded before the turn ends remains readable. Other errors retain capacity. A successful dispatch result, child-start record, or saved binding also retains capacity on this path.

Reconciliation runs before a new admitted spawn and after native list or wait callbacks. It can recover preserved work after Sage turns off. A lead, including a reused lead, can reconcile its own rejected child; another actor cannot release that reservation.

Core saves an immutable failure receipt, separately from child completion. Repeating the same receipt changes nothing. Changed identity or evidence, a bound assignment, and a late binding refuse. A failed call never grants another dispatch permission; a retry needs a new preparation and call.

This covers rejected initial spawns, including a specialist started by a reused lead. Other failure kinds, active-child process restart, cross-session transfer, and installed activation remain separate work. Packaged tests cover the accounting and evidence checks. Run `node scripts/probe-codex-lifecycle.mjs --sage-failed-spawn` with fake process tools first on PATH. The isolated CLI 0.160.0 probe rejects one spawn, verifies its failure receipt, and completes a new child at capacity one. It uses simulated responses and removes its temporary profile. This does not prove real-model operation.


Run `node scripts/probe-codex-lifecycle.mjs --sage-followup-failed-child` for the reused-lead check.
The same native lead completes one assignment, starts another, and receives the known rejection for a reviewer spawn.
Its own list callback records the failure. The probe requires one failure, no reviewer child, and two preserved lead bindings and completions.
Responses are simulated. Packaged tests also check off-mode recovery, foreign-parent evidence, another actor, unchanged retries, and capacity release.
Capacity tests use clearly labelled synthetic reservations through the public admission API; they do not launch replacement agents.
The production recovery already exists on main. These checks do not establish real-model behavior or automatic Sage activation.


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
