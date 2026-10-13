# Codex shell-path decisions

`shellPathDecision(command, { cwd, roots })` connects the shared shell-path check
to the prepared Codex decision format. Protected paths and unresolved write
paths return `deny`. Invalid execution context throws; the native policy caller
must turn that failure into denial.

The caller supplies the original command, verified execution directory, and
fixed protected roots. This component does not authenticate that context.
A `pass` result grants no permission. Roles, command identity, shell selection,
execution environment, native permissions, and other Sage rules still apply.
Arbitrary programs can construct paths that static analysis cannot discover.
Filesystem changes can invalidate a path snapshot; sandbox protection remains necessary.

The packaged tests send strings directly to the policy. They execute no test
command and change no logbook. This component does not install a hook or enable
automatic Sage. See the shared `shell-path-policy.md` for supported path forms.
