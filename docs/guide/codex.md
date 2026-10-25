# sage in Codex

This page tells you how to install sage in Codex, what it does there today, and what does not work yet. sage installs as a Codex plugin from its own marketplace, with your normal Codex: the terminal CLI or the Codex desktop app in the ChatGPT app. In Codex, sage mode gives the session the chief's role, its role agents and the logbook tools; hooks hold the merge and edit rules, and autopilot merges verified work.

The design of the two provider plugins is in [Separate provider packages](../design/provider-packages.md).

## What works and what does not

| Part of sage | Claude Code | Codex today |
| --- | --- | --- |
| Install from the sage marketplace | Yes | Yes: `codex plugin marketplace add`, then `codex plugin add sage@sage` |
| A status at the start of each session | No | Yes: the sage version, the Codex version, the trust of the sage hooks and the on phrase |
| Principles and the writing skills | Yes | Yes: the same skills, including the `sage` skill for manual logbook commands |
| A principle at the moment it applies | Yes | Yes, for a design request, a test or document patch, a README and a commit |
| Advice after a failed check | Yes | No: Codex's shell hook output does not give a reliable exit status |
| The logbook and the board | Yes | Yes: the plugin's `sage` MCP tools write the logbook, and the `sage` skill's commands read it and show the board |
| The stop check | Yes | No, until native captures prove it |
| sage mode: the chief's role | Yes | Yes: the `sage mode` phrase gives it, and it comes back after a compaction |
| Role agents (lead, implementer, reviewers, QA) | Yes | Yes: the chief puts the role text at the top of each spawn message, and starts every role agent itself (no lead yet: the chief does the lead's work). See [start a role agent](../../packages/sage-codex/skills/sage/references/roles.md) |
| The report check | Yes | Yes, for a role agent whose task name starts with `sage_`: a report without every field gets one more turn, then the agent stops with one plain line. It does not check a review's findings yet |
| sage mode: agent caps and the push rules in code | Yes | No |
| Autopilot | Yes | Yes: autopilot merges verified work. The hook allows only the exact merge command when the merge check passes, with no prompt |
| The merge rule, the no-edit rules and the `.codex` rule | Yes | Yes, in the plugin's hooks ([The rules in Codex](#the-rules-in-codex)) |
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

3. Run `codex` in a project folder. At the "Hooks need review" screen ("8 hooks are new or changed"), choose **Trust all and continue**. Codex runs the sage hooks only after this step.

   > **Note:** `codex exec` skips hooks without your trust, and it gives no warning.

4. Send a message. Above the reply, you see one status, for example:

   ```text
   ↳ Hook · sage 0.1.0 is installed. Codex 0.160.0. sage hooks: all 8 trusted. To start sage mode, send this message alone: sage mode
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
| `autopilot on` / `autopilot off` | Autopilot turns on, while sage mode is on, or off. With autopilot on, autopilot merges verified work: the hook allows only the exact merge command when the merge check passes, with no prompt. |
| `sage help` | Every phrase, and whether sage mode and autopilot are on. |

- Send a phrase when Codex is idle.
- Only your own typed message switches a mode: Codex gives the hook no agent text. A Codex review or approval check sends its own prompt, and that prompt switches nothing.
- A message near a phrase switches nothing. The chief asks you for the exact phrase, unless your message was a question.
- For a normal switch, the chief confirms the switch in one line of its reply.
- For a limit or a fault, the hook gives Codex a warning line; the terminal UI and the app show it; `codex exec` does not. The faults: an event that the hook cannot read (it switches nothing and turns autopilot off), and a mode folder that it cannot use (the line names the folder).
- A damaged mode file turns sage mode and autopilot off. The hook replaces the file with a clean one and gives one warning line. Send `sage mode` to turn sage mode on again.
- A forked thread starts with sage mode and autopilot off, because Codex does not tell the hook which thread it came from. If the fork shows the chief's role, the chief tells you this in one line. Send `sage mode` in the fork to turn it on there.
- With `SAGE_HOOKS=off`, a phrase switches nothing, and the hook gives one warning line that says so.
- The hook keeps the mode of each session in `~/.codex/sage/.hooks/codex/` (or under `SAGE_HOME`).

The hooks run only after you trust them (step 3). In `codex exec`, Codex skips hooks that you have not trusted, with no warning.

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

## The rules in Codex

The hook `hooks/gate-hook.mjs` holds these rules. Codex runs it before each shell command and each `apply_patch` edit (`PreToolUse`), and before it shows an approval prompt for a shell command (`PermissionRequest`).

| Rule | When | What you see |
| --- | --- | --- |
| A merge runs only with autopilot on and a passing merge check for that head commit, in the one form `gh pr merge <n> --squash --delete-branch --match-head-commit <sha>`, from the main thread | sage mode | Codex blocks any other merge, and the chief gets one line with the reason. A verified merge runs with no approval prompt: the hook allows its network approval itself |
| The chief changes no files | sage mode, the main thread | Codex blocks the chief's `apply_patch` edit. The chief briefs an implementer, and agents edit as before |
| A reviewer, QA or the PE changes no files | sage mode, a role agent whose task name names that role | Codex blocks its `apply_patch` edit, with one line: the agent reports a finding instead |
| No one changes files under a `.codex` folder | Every mode, every thread | Codex blocks the `apply_patch` edit, or the shell write that names the folder. Codex reads project settings from that folder, so you make such changes yourself |
| No shell command names the Codex sage folder, and none resumes or forks a Codex session | Every mode, every thread | Codex blocks the command, with one line. The sage folder holds the logbook and the mode files; the logbook tools change them |

For every other approval, the hook does not decide, so Codex shows its own prompt. When the hook cannot read a tool call, it blocks the call and says so in one line. When it cannot read an approval request, Codex shows its own prompt.

The hook reads sage mode from the mode file of the session (in `SAGE_HOME`, or `CODEX_HOME/sage`, under `.hooks/codex/`), with the same reader as the mode hook: a damaged file is off. Autopilot counts only when the mode file and your own typed messages in Codex's record of the thread both turn it on, so an agent that writes a mode file unlocks no merge. The merge check needs `gh`, logged in, and the logbook's verdicts for the head commit, as in Claude Code.

Limits: the hook reads a shell command's text, so a command that hides a folder name (for example in a variable) is not blocked; Codex's own sandbox keeps `.codex` and the Codex home read-only in the workspace-write mode. A shell write by the chief or a reviewer is not blocked either: the edit rules cover `apply_patch`.

## What comes next

The lead role, agent caps, the push rules and the board phrases come later in the same plugin. Codex draws its own approval prompts in both front ends, so sage adds none. The runtime notes of the parked Codex fork, for example the [Claude parity audit](../../packages/sage-codex/runtime/claude-parity-audit.md), stay as evidence.
