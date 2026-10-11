# Native command input

Codex CLI 0.160.0 changes the command input before it calls a hook.
The command adapter must account for this change before Sage can enforce its shared command rules.

Run the native check with `node scripts/probe-codex-command.mjs`.
Add `--deny-command` to verify denial of the same fixed harmless command.
Add `--default-command` to omit the shell, working directory, and terminal fields.
Add `--sage-off` to verify original command recovery with Sage mode off.
Add `--extended-command` to send the supported fields omitted by the visible schema.
It uses explicit shell and directory fields, so it cannot combine with `--default-command`.
The other flags can be combined.
Use fake `ps`, `pgrep`, and `kill` first on PATH, as for the other native checks.
The check uses a fresh temporary profile and a local server with fixed simulated responses.
It does not use model credentials or the owner's settings.

## Observed input

The model receives an `exec_command` tool with these fields:

- `cmd`, which is required;
- `shell`, `workdir`, and `tty`;
- `sandbox_permissions`, `justification`, and `prefix_rule`;
- `max_output_tokens` and `yield_time_ms`.

The check sends one fixed harmless command: `printf sage-native-command-ok; pwd`.
It sets the shell to `/bin/sh`, the working directory to a child folder of the temporary workspace, and `tty` to false.
Both `PreToolUse` and `PostToolUse` receive the name `Bash`.
Their `tool_input` contains only `command`, with the exact fixed command text.
The post-tool response is a string.
The check asserts these fields and the command result directly.
The `pwd` output confirms the actual command directory without publishing its path.
The hook's top-level `cwd` still names the session workspace when the command runs in its child folder.
With no workdir argument, the command runs in the session workspace.
The saved turn context also names the session cwd, but exposes no shell or selected-environment field in this capture.
The native execution event names `/bin/sh` for the explicit route and `/bin/zsh` for the default route on the tested Mac.
The observed default shell depends on the host; it is not a portable default.

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

The probe runs the composed native Sage policy with the requested Sage mode.
The default is on. Off mode still requires exact original command evidence.
A receipt from its evaluator confirms the exact recovered fields and call identity.
The allow route checks the native exit code and exact command output.
The deny route checks the fixed denial response, no command execution, and no post-tool callback.
This proves denial with a healthy hook connection for this fixed command.
It does not verify full Sage policy, a real model, or an installed automatic workflow.
The separate required-hook outage check still gates activation.

## Native defaults and fields beyond the visible schema

The [0.160.0 command implementation](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/core/src/tools/handlers/unified_exec.rs)
also accepts `login`, `timeout_ms`, and `additional_permissions`.
Its environment input accepts `environment_id`.
The [command handler](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/core/src/tools/handlers/unified_exec/exec_command.rs)
resolves workdir against the selected environment, which can be remote.
An empty or omitted workdir uses that environment's current directory.

The [shell resolver](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/shell-command/src/shell_detect.rs)
uses a supplied shell path to select a shell type, then discovers its executable.
It does not promise to execute that exact path.
An omitted shell uses the selected environment's shell or the session shell.
An omitted login field follows the environment's login-shell setting.

The complete adapter must validate these fields even when the model schema omits them.
It needs trusted selected-environment and shell context for default arguments.
Do not substitute the hook's session cwd for an explicit workdir.
Do not infer the effective shell executable from the original shell path alone.
These probes cover one local environment with login shells disabled, not remote execution or shell discovery changes.

## Later release source check

A source check of Codex `rust-v0.162.1` found the same command-only pre-tool
payload. Its hook error handling still allows execution after some invalid or
failed callbacks. These are source findings, not live tests of that release.
The Sage adapter and native probes remain pinned to the verified `0.160.0`
contract. An upgrade alone is not evidence that the activation gates are met.

- [Command payload](https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/core/src/tools/handlers/unified_exec/exec_command.rs#L493-L502).
- [Pre-tool failure handling](https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/hooks/src/events/pre_tool_use.rs#L179-L303).
