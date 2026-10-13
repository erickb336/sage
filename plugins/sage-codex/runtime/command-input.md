# Native command argument validation

`decodeNativeCommand` is a pure decoder for recovered `exec_command` arguments.
Policy integration remains separate work. It preserves every supplied field, null value, and
omission. Unknown fields and invalid shapes cause a fixed error. It never prints
an argument, path, or underlying error.

The types come from Codex `rust-v0.160.0`:

- [Command arguments](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/core/src/tools/handlers/unified_exec.rs).
- [Permission profiles](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/protocol/src/models.rs).
- [Filesystem entries](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/protocol/src/permissions.rs).

The decoder includes fields absent from the visible model schema: login, timeout,
selected environment, and additional permissions. Nested filesystem requests use
either legacy read/write lists or canonical entries. Mixed forms are invalid.
Permission modes include `with_additional_permissions`. The API does not silently
reduce that request to the default sandbox.

String limits use JavaScript string length: 1,048,576 units for commands, 4,096
for path-like strings, and 16,384 for justification. Lists have at most 256 entries.
Numeric fields require nonnegative safe integers. Unknown keys are refused, although native Serde types sometimes
ignore them. A native version change requires a review of this contract.

This is structural validation, not authorization. Relative paths, remote paths,
special roots, and unknown special-path tokens retain their original meaning for
later policy checks. The decoder does not select a shell, resolve a directory,
approve a prefix, widen a sandbox, or permit a command. The complete evaluator
must check effective execution context and all requested permission changes.
No installed entry point or automatic workflow is enabled by this component.

## Original native command evidence

The composed native policy now connects the protected command reader to this decoder.
Codex 0.160.0 hooks expose a `Bash` tool with command text only.
The policy recovers the original pending `exec_command` arguments before it calls its evaluator.
It verifies the authenticated actor, session, active turn, call ID, command text, and native metadata.
The evaluator receives a separate copy in `context.command`.

This check applies with Sage on or off. An admitted child uses its recorded native identity.
An unassigned off-mode child uses its verified native transcript without creating an admission record.
Missing, conflicting, completed, interrupted, or malformed evidence refuses before evaluation.
After an asynchronous evaluator permits a command, the policy verifies the pending call again.
Changed arguments or a finished turn cannot retain the earlier permission.

The recovered values describe the requested command. They do not prove the effective shell,
working directory, remote environment, or sandbox defaults. This component does not grant
command permission or activate installed Sage. The native probe uses CLI 0.160.0 with simulated responses in a temporary profile.
It verifies explicit and default arguments, denial before execution, and Sage-off input.
Run `node scripts/probe-codex-command.mjs`; add `--deny-command`, `--default-command`,
or `--extended-command --sage-off` for the other routes. Use fake process tools first on PATH.
The fixed harmless command verifies its real output and working directory. The probe
checks the evaluator receipt against every requested field and removes its temporary profile.

## Child sandbox requests

The policy refuses a child's `require_escalated` or `with_additional_permissions` request.
It also refuses any non-null `additional_permissions`, including with `use_default`.
This rule applies before the supplied evaluator, with Sage on or off.
It covers unassigned native children and matches Claude's child sandbox rule.
A chief request still needs the supplied evaluator and native permission checks.
The guard does not prove the effective sandbox or enable installed Sage.

Run `node scripts/probe-codex-lifecycle.mjs --sage-child-sandbox` with fake process tools first on PATH.
This simulated native probe verifies refusal before the evaluator, no command completion event,
normal child completion, and temporary profile cleanup.
