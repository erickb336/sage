# Recover a rejected initial spawn

An initial spawn reserves capacity before Codex tries to create the child. The runtime releases that slot only when the protected sender transcript proves the captured Codex 0.160.0 unknown-model rejection.

The adapter checks the current actor, owner epoch, original request, call, turn, and argument hash. Native metadata must mark both records as server-authored. The error must name the dispatched model. A call or result after native turn completion or interruption refuses. Valid failure evidence recorded before the turn ends remains readable. Other errors retain capacity. A successful dispatch result, child-start record, or saved binding also retains capacity on this path.

Reconciliation runs before a new admitted spawn and after native list or wait callbacks. It can recover preserved work after Sage turns off. A lead, including a reused lead, can reconcile its own rejected child; another actor cannot release that reservation.

Core saves an immutable failure receipt, separately from child completion. Repeating the same receipt changes nothing. Changed identity or evidence, a bound assignment, and a late binding refuse. A failed call never grants another dispatch permission; a retry needs a new preparation and call.

This covers rejected initial spawns, including a specialist started by a reused lead. Other failure kinds, active-child process restart, cross-session transfer, and installed activation remain separate work. Packaged tests cover the accounting and evidence checks. Run `node scripts/probe-codex-lifecycle.mjs --sage-failed-spawn` with fake process tools first on PATH. The isolated CLI 0.160.0 probe rejects one spawn, verifies its failure receipt, and completes a new child at capacity one. It uses simulated responses and removes its temporary profile. This does not prove real-model operation.


Run `node scripts/probe-codex-lifecycle.mjs --sage-followup-failed-child` for the reused-lead check.
The same native lead completes one assignment, starts another, and receives the known rejection for a reviewer spawn.
Its own list callback records the failure. The probe requires one failure, no reviewer child, and two preserved lead bindings and completions.
Responses are simulated. Packaged tests also check off-mode recovery, foreign-parent evidence, another actor, unchanged retries, and capacity release.
Capacity tests use clearly labelled synthetic reservations through the public admission API; they do not launch replacement agents.
The production recovery already exists on main. These checks do not establish real-model behavior or automatic Sage activation.
