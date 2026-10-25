# sage in Codex

This page tells you how to install sage in Codex, what it does there today, and what does not work yet. sage installs as a Codex plugin from its own marketplace, with your normal Codex: the terminal CLI or the Codex desktop app in the ChatGPT app. In Codex, sage mode gives the session the chief's role, but the rules that Claude Code's hook holds in code do not apply yet.

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
| sage mode: the chief's role | Yes | Yes: the `sage mode` phrase gives it, and it comes back after a compaction |
| sage mode: the team, agent caps, report checks, the push and merge rules in code | Yes | Not enabled. Parts are built and tested, but they are not switched on in the installed plugin |
| Autopilot | Yes | The phrases record it, but it merges nothing yet: you merge |
| The mode phrases (`sage mode`, `sage mode off`, `autopilot on`, `autopilot off`, `sage help`) | Yes | Yes |
| The board phrases (`show board`, `show status`) | Yes | No: use the manual skill commands |

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

3. Run `codex` in a project folder. At the "Hooks need review" screen ("5 hooks are new or changed"), choose **Trust all and continue**. Codex runs the sage hooks only after this step.

   > **Note:** `codex exec` skips hooks without your trust, and it gives no warning.

4. Send a message. Above the reply, you see one status, for example:

   ```text
   ↳ Hook · sage 0.1.0 is installed. Codex 0.160.0. sage hooks: all 5 trusted. To start sage mode, send this message alone: sage mode
   ```

   The status says when some sage hooks do not have your trust yet, and it warns when your Codex version is outside the tested range. Codex starts a session at your first message, so the status comes then.

In the desktop app, do steps 1 and 2 in a terminal. The app reads the same Codex home (`~/.codex`), so sage shows under the sage marketplace in its plugins list.

If the app does not ask you to trust the hooks, do step 3 once in the terminal. This desktop path is not checked yet.

## Update and remove

- To update, run `codex plugin marketplace upgrade sage`, then `codex plugin add sage@sage` again. A changed hook needs your trust again: at the next start, choose **Trust all and continue** again.
- To remove sage, run `codex plugin remove sage@sage`, then `codex plugin marketplace remove sage`.

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

The hooks run only after you trust them (step 3). In `codex exec`, Codex skips hooks that you have not trusted, with no warning.

## What comes next

Full sage mode in Codex comes as more parts of the same plugin: a hook for the mode phrases and the chief's role, a local MCP server for the logbook, and hooks for the report fields and the merge rules. Codex draws its own approval prompts in both front ends, so sage adds none. The runtime notes of the parked Codex fork, for example the [Claude parity audit](../../packages/sage-codex/runtime/claude-parity-audit.md), stay as evidence.
