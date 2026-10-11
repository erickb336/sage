# Native command input

Codex CLI 0.160.0 changes the command input before it calls a hook.
The command adapter must account for this change before Sage can enforce its shared command rules.

Run the native check with `node scripts/probe-codex-command.mjs`.
Use fake `ps`, `pgrep`, and `kill` first on PATH, as for the other native checks.
The check uses a fresh temporary profile and a local server with fixed simulated responses.
It does not use model credentials or the owner's settings.

## Observed input

The model receives an `exec_command` tool with these fields:

- `cmd`, which is required;
- `shell`, `workdir`, and `tty`;
- `sandbox_permissions`, `justification`, and `prefix_rule`;
- `max_output_tokens` and `yield_time_ms`.

The check sends one fixed harmless command: `printf sage-native-command-ok`.
It sets the shell to `/bin/sh`, the working directory to the temporary workspace, and `tty` to false.
Both `PreToolUse` and `PostToolUse` receive the name `Bash`.
Their `tool_input` contains only `command`, with the exact fixed command text.
The post-tool response is a string.
The check asserts these fields and the command result directly.

## Consequence for Sage

A hook must not treat the name `Bash` as proof of the selected shell.
The native tool accepts a shell field, but the observed hook input omits it.
The same omission applies to the explicit working directory and permission fields.
This check does not prove that all command forms use this shape.

Before activation, the adapter needs a trusted source for the original command envelope and its exact call identity.
Verify whether the protected native transcript supplies that envelope before the pre-tool callback.
Then apply the shared rules to the complete input, including shell, working directory, and permission changes.
An instruction that asks the model to omit these fields is not enforcement.

This evidence does not verify command denial, full Sage policy, a real model, or an installed automatic workflow.
The separate required-hook outage check still gates activation.
