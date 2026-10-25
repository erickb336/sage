# sage in Codex

This page tells you what sage does in Codex today, how to try it, and what does not work yet. Codex support is in progress. sage mode itself (the chief and its team) runs only in Claude Code for now.

The design of the two provider plugins is in [Separate provider packages](../design/provider-packages.md).

## What works and what does not

| Part of sage | Claude Code | Codex today |
| --- | --- | --- |
| Principles and the writing skills | Yes | Yes: the same skills, including the `sage` skill for manual logbook commands |
| A principle at the moment it applies | Yes | Yes, for a design request, a test or document patch, a README and a commit |
| Advice after a failed check | Yes | No: Codex's shell hook output does not give a reliable exit status |
| The logbook and the board | Yes | Yes: the plugin's `sage` MCP tools write the logbook, and the `sage` skill's commands read it and show the board |
| The stop check | Yes | No, until native captures prove it |
| sage mode: the chief, the team, agent caps, report checks, the push and merge rules | Yes | Not enabled. Parts are built and tested, but they are not switched on in the installed plugin |
| Autopilot | Yes | No |
| The phrases (`sage mode`, `autopilot on`, `show board`) | Yes | No: use the manual skill commands |

The Codex logbook is in `~/.codex/sage` (or `CODEX_HOME`), apart from Claude's. The chat board in Codex shows only the Codex logbook. The browser board shows both by default, and each card says which provider's logbook holds it.

## What you need

- Codex CLI: sage's plugin discovery was checked with Codex CLI 0.159.2 on Linux and 0.160.0 on macOS. CI runs the tests on Linux, but no real install or session of sage is tested on Linux yet. A discovery check does not prove that each hook runs in a real session.
- Node.js 20 or later.
- git, and a clone of this repository.

## Try it

Treat this as a preview. Check each step in your own Codex before you rely on it.

1. Clone the repository, and go into its folder:

   ```sh
   git clone https://github.com/erickb336/sage.git
   ```

   ```sh
   cd sage
   ```

   The repository holds the built Codex plugin in `plugins/sage-codex/`, so you do not need to build it.

2. Add the clone as a marketplace:

   ```sh
   codex plugin marketplace add .
   ```

3. Install sage's Codex plugin:

   ```sh
   codex plugin add sage@sage
   ```

4. Start a new Codex session with hooks on:

   ```sh
   codex --enable codex_hooks --enable plugin_hooks
   ```

5. When Codex asks, review and trust sage's hook commands. sage does not bypass Codex's hook trust or change its global configuration.

You see: a design request, or a patch to a test file, adds the principle's text to the session once. The `sage` skill gives the logbook commands.

## The logbook tools

The plugin starts a local MCP server, `sage`, in the desktop app and in the CLI. Its tools write the logbook: one tool for each command of the state tool that the chief and the leads use.

| Tool | Command of the state tool |
| --- | --- |
| `init`, `status` | `init`, `status` |
| `task_add`, `task_set` | `task add`, `task <T> set` |
| `run_add`, `run_done` | `run add`, `run done` |
| `finding_add`, `finding_triage`, `finding_close`, `finding_move` | `finding add`, `triage`, `close`, `move` |
| `verdict`, `round`, `merge_check`, `log` | `verdict`, `round`, `merge-check`, `log` |
| `standing`, `standing_add`, `pages` | `standing`, `standing add`, `pages` |
| `gate_add`, `gate_answer` | `gate add`, `gate answer` |

- Each tool takes `project`, the absolute path of the project's checkout, and the command's options by their names.
- The tools run the same checks as the commands. A refusal comes back as a tool error with the reason of the command.
- Codex starts the server outside the shell sandbox. Under `workspace-write`, the logbook is not a writable folder of an agent's shell, so only the server writes it. Under full access, an agent's shell can still change the logbook.
- The plugin approves its own tools, so the logbook writes do not ask you each time. To be asked, set `default_tools_approval_mode = "prompt"` under `[plugins."sage@sage".mcp_servers.sage]` in your Codex config.

## What comes next

Full sage mode in Codex needs verified answers for each case that Claude Code's hook holds: a failed agent start, an agent's later turns, an interrupted run, who wrote a prompt, and the agent caps. sage keeps it off until each one has evidence. The progress is in the Codex runtime notes, for example the [Claude parity audit](../../packages/sage-codex/runtime/claude-parity-audit.md).
