# Native command input

Codex CLI 0.160.0 changes the command input before it calls a hook.
The command adapter must account for this change before Sage can enforce its shared command rules.

Run the native check with `node scripts/probe-codex-command.mjs`.
Add `--deny-command` to verify denial of the same fixed harmless command.
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
The native check confirms that the protected transcript contains the original call before the pre-tool callback.
`readNativeCommand` checks the session, actor, turn, call ID, command text, and native record metadata.
It rejects duplicate calls, completed calls, completed turns, linked paths, and unsupported native versions.
It returns every original argument for the command adapter to validate.
This reader does not authenticate the hook caller or grant command permission.
Then apply the shared rules to the complete input, including shell, working directory, and permission changes.
An instruction that asks the model to omit these fields is not enforcement.

The probe now runs the composed native Sage policy with Sage mode on.
A receipt from its evaluator confirms the exact recovered fields and call identity.
The allow route checks the native exit code and exact command output.
The deny route checks the fixed denial response, no command execution, and no post-tool callback.
This proves denial with a healthy hook connection for this fixed command.
It does not verify full Sage policy, a real model, or an installed automatic workflow.
The separate required-hook outage check still gates activation.
