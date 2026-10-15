# Native failed dispatch recovery

Codex 0.160.0 records an unknown-model spawn rejection in the parent's protected transcript.
The isolated probe observed a pre-tool callback, no post-tool callback, no child, and an occupied Sage reservation.
A configured `PostToolUseFailure` event did not appear in the native hook list or run.

The adapter now reconciles this verified preflight rejection before a new spawn and after native list or wait tools.
It requires the current transport actor, owner epoch, original request, exact call and turn, and matching argument hash.
The transcript must identify that actor and session. The call must name native `collaboration.spawn_agent`.
Native metadata must mark the output as not client-authored. The output must match the unknown-model error for the dispatched model.
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
Responses are simulated. Other failure kinds, interruption, cross-session recovery, and installed automatic operation remain unverified.

Run `node scripts/probe-codex-lifecycle.mjs --sage-followup-failed-child` for a reused lead.
Its second assignment prepares a reviewer, receives the native unknown-model rejection, and reconciles through its own list call.
The probe checks one failure receipt, no extra child, and two preserved lead bindings and completions.
The chief reads both lead reports and records the second. Responses are simulated.
This route verifies failed-dispatch recovery, not a successful retry or review quality.

Packaged tests also check off-mode recovery, foreign-parent evidence, another actor, unchanged retries, and capacity release.
Capacity tests use labelled synthetic reservations through the public admission API; they do not launch replacement agents.
Production recovery already exists on main. These checks do not establish real-model behavior or automatic Sage activation.
