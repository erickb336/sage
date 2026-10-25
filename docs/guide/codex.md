# sage in Codex

This page tells you what sage does in Codex today, how to try it, and what does not work yet. Codex support is in progress. In Codex, sage mode gives the session the chief's role, but the rules that Claude Code's hook holds in code do not apply yet.

The design of the two provider plugins is in [Separate provider packages](../design/provider-packages.md).

## What works and what does not

| Part of sage | Claude Code | Codex today |
| --- | --- | --- |
| Principles and the writing skills | Yes | Yes: the same skills, including the `sage` skill for manual logbook commands |
| A principle at the moment it applies | Yes | Yes, for a design request, a test or document patch, a README and a commit |
| Advice after a failed check | Yes | No: Codex's shell hook output does not give a reliable exit status |
| The logbook and the board | Yes | Yes, through the manual commands of the `sage` skill |
| The stop check | Yes | No, until native captures prove it |
| sage mode: the chief's role | Yes | Yes: the `sage mode` phrase gives it, and it comes back after a compaction |
| sage mode: the team, agent caps, report checks, the push and merge rules in code | Yes | Not enabled. Parts are built and tested, but they are not switched on in the installed plugin |
| Autopilot | Yes | The phrases record it, but it merges nothing yet: you merge |
| The mode phrases (`sage mode`, `sage mode off`, `autopilot on`, `autopilot off`, `sage help`) | Yes | Yes |
| The board phrases (`show board`, `show status`) | Yes | No: use the manual skill commands |

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

4. Start a new Codex session:

   ```sh
   codex
   ```

   Codex 0.160.0 runs hooks by default, so you need no flags. If sage's hooks do not run in an older Codex, start it with `codex --enable codex_hooks --enable plugin_hooks`.

5. When Codex asks, review and trust sage's hook commands. sage does not bypass Codex's hook trust or change its global configuration.

In the Codex desktop app, install the plugin with the same commands, and then start a new thread. If the app shows no review screen for the hooks, trust them once in the CLI (steps 4 and 5). This app path is not yet checked.

You see: a design request, or a patch to a test file, adds the principle's text to the session once. The `sage` skill gives the logbook commands.

## Turn on sage mode

Send each phrase alone, as the whole message, in any letter case.

| Say | What happens in Codex |
| --- | --- |
| `sage mode` | The session becomes your chief of staff: the hook adds the chief's role to that turn. Send your request next. |
| `sage mode off` | A normal session again. Autopilot goes off too. The hook adds the role no more, also after a compaction. |
| `autopilot on` / `autopilot off` | The hook records autopilot, while sage mode is on. It merges nothing yet: work stops at verified, and you merge. |
| `sage help` | Every phrase, and whether sage mode and autopilot are on. |

- Send a phrase when Codex is idle.
- Only your own typed message switches a mode: Codex gives the hook no agent text. A Codex review or approval check sends its own prompt, and that prompt switches nothing.
- A message near a phrase switches nothing. The chief asks you for the exact phrase, unless your message was a question.
- For a normal switch, the chief confirms the switch in one line of its reply.
- For a limit or a fault, the hook gives Codex a warning line; the terminal UI and the app show it; `codex exec` does not. The limit: `autopilot on` merges nothing yet. The faults: an event that the hook cannot read (it switches nothing and turns autopilot off), and a mode folder that it cannot use (the line names the folder).
- A damaged mode file turns sage mode and autopilot off. The hook replaces the file with a clean one and gives one warning line. Send `sage mode` to turn sage mode on again.
- A forked thread starts with sage mode and autopilot off, because Codex does not tell the hook which thread it came from. If the fork shows the chief's role, the chief tells you this in one line. Send `sage mode` in the fork to turn it on there.
- With `SAGE_HOOKS=off`, a phrase switches nothing, and the hook gives one warning line that says so.
- The hook keeps the mode of each session in `~/.codex/sage/.hooks/codex/` (or under `SAGE_HOME`).

The hooks run only after you trust them (step 5). In `codex exec`, Codex skips hooks that you have not trusted, with no warning.

## What comes next

Full sage mode in Codex needs verified answers for each case that Claude Code's hook holds: a failed agent start, an agent's later turns, an interrupted run, who wrote a prompt, and the agent caps. sage keeps it off until each one has evidence. The progress is in the Codex runtime notes, for example the [Claude parity audit](../../packages/sage-codex/runtime/claude-parity-audit.md).
