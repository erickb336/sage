# sage in Codex

This page tells you what sage does in Codex today, how to try it, and what does not work yet. Codex support is in progress. sage mode itself (the chief and its team) runs only in Claude Code for now.

The design of the two provider plugins is in [Separate provider packages](../design/provider-packages.md).

## What works and what does not

| Part of sage | Claude Code | Codex today |
| --- | --- | --- |
| Principles and the writing skills | Yes | Yes: the same skills, including the `sage` skill for manual logbook commands |
| A principle at the moment it applies | Yes | Yes, for a design request, a test or document patch, a README and a commit |
| Advice after a failed check | Yes | No: Codex's shell hook output does not give a reliable exit status |
| The logbook and the board | Yes | Yes, through the manual commands of the `sage` skill |
| The stop check | Yes | No, until native captures prove it |
| sage mode: the chief, the team, agent caps, report checks, the push and merge rules | Yes | Not enabled. Parts are built and tested, but they are not switched on in the installed plugin |
| Autopilot | Yes | No |
| The merge rule, the chief's no-edit rule and the `.codex` rule | Yes | Yes, in the plugin's hooks ([The rules in Codex](#the-rules-in-codex)). The merge rule and the no-edit rule act only when the mode hook records sage mode, which is not in the plugin yet |
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

## The rules in Codex

The hook `hooks/gate-hook.mjs` holds three rules. Codex runs it before each shell command and each `apply_patch` edit (`PreToolUse`), and before it shows an approval prompt for a shell command (`PermissionRequest`).

| Rule | When | What you see |
| --- | --- | --- |
| A merge runs only with autopilot on and a passing merge check for that head commit, in the one form `gh pr merge <n> --squash --delete-branch --match-head-commit <sha>`, from the main thread | sage mode | Codex blocks any other merge, and the chief gets one line with the reason. A verified merge runs with no approval prompt: the hook allows its network approval itself |
| The chief changes no files | sage mode, the main thread | Codex blocks the chief's `apply_patch` edit. The chief briefs an implementer, and agents edit as before |
| No one changes files under a `.codex` folder | Every mode, every thread | Codex blocks the `apply_patch` edit, or the shell write that names the folder. Codex reads project settings from that folder, so you make such changes yourself |

For every other approval, the hook does not decide, so Codex shows its own prompt. When the hook cannot read a tool call, it blocks the call and says so in one line. When it cannot read an approval request, Codex shows its own prompt.

The hook reads sage mode and autopilot from the mode file of the session (in `SAGE_HOME`, or `CODEX_HOME/sage`, under `.hooks/codex/`). The merge check needs `gh`, logged in, and the logbook's verdicts for the head commit, as in Claude Code.

Limits: the hook reads a shell command's text, so a write that hides the folder name (for example in a variable) is not blocked; Codex's own sandbox keeps `.codex` read-only in the workspace-write mode. A shell write by the chief is not blocked either: the rule covers `apply_patch`.

## What comes next

Full sage mode in Codex needs verified answers for each case that Claude Code's hook holds: a failed agent start, an agent's later turns, an interrupted run, who wrote a prompt, and the agent caps. sage keeps it off until each one has evidence. The progress is in the Codex runtime notes, for example the [Claude parity audit](../../packages/sage-codex/runtime/claude-parity-audit.md).
