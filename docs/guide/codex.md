# sage in Codex

This page tells you how to install sage in Codex, what it does there today, and what does not work yet. sage installs as a Codex plugin from its own marketplace, with your normal Codex: the terminal CLI or the Codex desktop app in the ChatGPT app. sage mode itself (the chief and its team) runs only in Claude Code for now.

The design of the two provider plugins is in [Separate provider packages](../design/provider-packages.md).

## What works and what does not

| Part of sage | Claude Code | Codex today |
| --- | --- | --- |
| Install from the sage marketplace | Yes | Yes: `codex plugin marketplace add`, then `codex plugin add sage@sage` |
| A status at the start of each session | No | Yes: the sage version, the Codex version, the trust of the sage hooks and the on phrase |
| Principles and the writing skills | Yes | Yes: the same skills, including the `sage` skill for manual logbook commands |
| A principle at the moment it applies | Yes | Yes, for a design request, a test or document patch, a README and a commit |
| Advice after a failed check | Yes | No: Codex's shell hook output does not give a reliable exit status |
| The logbook and the board | Yes | Yes, through the manual commands of the `sage` skill |
| The stop check | Yes | No, until native captures prove it |
| sage mode: the chief, the team, agent caps, report checks, the push and merge rules | Yes | Not yet: it comes in the next pull requests, as plugin hooks and a local MCP server |
| Autopilot | Yes | No |
| The phrases (`sage mode`, `autopilot on`, `show board`) | Yes | No: use the manual skill commands |

The Codex logbook is in `~/.codex/sage` (or `CODEX_HOME`), apart from Claude's. The chat board in Codex shows only the Codex logbook. The browser board shows both by default, and each card says which provider's logbook holds it.

## What you need

- Codex 0.160 to 0.164. sage was checked with Codex CLI 0.160.0 on macOS. The desktop app carries its own Codex (0.164.0-alpha in ChatGPT 26.1021); sage was not run in it yet.
- Node.js 20 or later, on your PATH: the sage hooks are Node scripts.

## Install

1. Add the sage marketplace, in a terminal:

   ```sh
   codex plugin marketplace add https://github.com/erickb336/sage.git
   ```

   You see ``Added marketplace `sage` ``. To try a local clone instead, give its folder: `codex plugin marketplace add ./sage`.

2. Install the plugin:

   ```sh
   codex plugin add sage@sage
   ```

   You see ``Added plugin `sage` from marketplace `sage`.`` Then `codex plugin list` shows `sage@sage  installed, enabled`.

3. Run `codex` in a project folder. At the "Hooks need review" screen ("3 hooks are new or changed"), choose **Trust all and continue**. Codex runs the sage hooks only after this step.

   > **Note:** `codex exec` skips hooks without your trust, and it gives no warning.

4. Send a message. Above the reply, you see one status, for example:

   ```text
   ↳ Hook · sage 0.1.0 is installed. Codex 0.160.0. sage hooks: all 3 trusted. To start sage mode, send this message alone: sage mode
   ```

   The status says when some sage hooks do not have your trust yet, and it warns when your Codex version is outside the tested range. Codex starts a session at your first message, so the status comes then.

In the desktop app, do steps 1 and 2 in a terminal. The app reads the same Codex home (`~/.codex`), so sage shows under the sage marketplace in its plugins list.

If the app does not ask you to trust the hooks, do step 3 once in the terminal. This desktop path is not checked yet.

## Update and remove

- To update, run `codex plugin marketplace upgrade sage`, then `codex plugin add sage@sage` again. A changed hook needs your trust again: at the next start, choose **Trust all and continue** again.
- To remove sage, run `codex plugin remove sage@sage`, then `codex plugin marketplace remove sage`.

## What comes next

Full sage mode in Codex comes as more parts of the same plugin: a hook for the mode phrases and the chief's role, a local MCP server for the logbook, and hooks for the report fields and the merge rules. Codex draws its own approval prompts in both front ends, so sage adds none. The runtime notes of the parked Codex fork, for example the [Claude parity audit](../../packages/sage-codex/runtime/claude-parity-audit.md), stay as evidence.
