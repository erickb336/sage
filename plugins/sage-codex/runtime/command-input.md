# Native command argument validation

`decodeNativeCommand` validates the recovered `exec_command` arguments before the
native policy callback runs. It preserves every supplied field, null value, and
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
