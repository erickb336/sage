# sage in Codex

This page tells you how to install sage in Codex, what it does there today, and what does not work yet. sage installs as a Codex plugin from its own marketplace, with your normal Codex: the terminal CLI, and the Codex desktop app in the ChatGPT app, which should work the same way but is not checked yet. In Codex, sage mode gives the session the chief's role, its role agents and the logbook tools; hooks hold the merge and edit rules, and autopilot merges verified work.

The design of the two provider plugins is in [Separate provider packages](../design/provider-packages.md).

## What works and what does not

| Part of sage | Claude Code | Codex today |
| --- | --- | --- |
| Install from the sage marketplace | Yes | Yes: `codex plugin marketplace add`, then `codex plugin add sage@sage` |
| A status at the start of each session | No | Yes: the chief gets the sage version, the Codex version, how many sage hooks have a trust record and the on phrase. You see a warning only when a sage hook has no trust record yet or your Codex is outside the tested range |
| Principles and the writing skills | Yes | Yes: the same skills, including the `sage` skill for manual logbook commands |
| A principle at the moment it applies | Yes | Yes, for a design request, a test or document patch, a README and a commit |
| Advice after a failed check | Yes | No: Codex's shell hook output does not give a reliable exit status |
| The logbook and the board | Yes | Yes: the plugin's `sage` MCP tools write the logbook, and the `sage` skill's commands read it and show the board |
| The stop check | Yes | No, until native captures prove it |
| sage mode: the chief's role | Yes | Yes: the `sage mode` phrase gives it, and it comes back after a compaction |
| Role agents | Yes: the lead, the implementer, the reviewers, QA, the PE, the designer and the arena judge | Yes for the implementer, the three reviewers and QA: the chief starts each one itself, with the role text at the top of its spawn message, and does the lead's work. No lead, PE, designer or arena judge yet. Role agents start no agents and record nothing in the logbook. See [start a role agent](../../packages/sage-codex/skills/sage/references/roles.md) |
| The brief check | Yes: the hook refuses a brief without every field | Yes, as a check, not a block: the chief runs the `brief` tool before each spawn. Each role agent starts with the project's standing orders and its checked brief, and a spawn with no checked brief gives the chief a warning ([The brief check](#the-brief-check)) |
| The report check | Yes | Yes, for a role agent whose task name starts with `sage_`: a report without every field gets one more turn, then the agent stops with one plain line. It does not check a review's findings yet |
| sage mode: the push rule in code | Yes | Yes: the same push form as in Claude Code ([The rules in Codex](#the-rules-in-codex)) |
| sage mode: agent caps in code | Yes | No |
| Autopilot | Yes | Yes: autopilot merges verified work. The hook allows only the exact merge command when the merge check passes, with no prompt |
| The merge rule, the no-edit rules and the `.codex` rule | Yes | Yes, in the plugin's hooks ([The rules in Codex](#the-rules-in-codex)) |
| The mode phrases (`sage mode`, `sage mode off`, `autopilot on`, `autopilot off`, `sage help`) | Yes | Yes |
| The board phrases (`show board`, `show status`) | Yes | No: use the manual skill commands |

The Codex logbook is in `~/.codex/sage` (or `CODEX_HOME`), apart from Claude's. The chat board in Codex shows only the Codex logbook. The browser board shows both by default, and each card says which provider's logbook holds it.

## What you need

- Codex 0.160 to 0.164. sage was checked with the Codex CLI 0.160.0 and 0.164.0 on macOS, with a test model. The desktop app carries its own Codex (0.164.0-alpha in ChatGPT 26.1021); sage should work the same way there, but it was not run in the app yet.
- The Codex CLI on your PATH, in that range, also when you use only the desktop app: the install commands below are CLI commands. To get it, run `npm install -g @openai/codex@0.164.0`.
- Node.js 20 or later, on your PATH: the sage hooks are Node scripts.
- `gh`, logged in (`gh auth login`), and a GitHub remote for the project. sage uses them for pull requests and the merge check; without them, work stops at a verified branch and autopilot merges nothing.

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

3. Run `codex` in a project folder. At the "Hooks need review" screen ("10 hooks are new or changed"), choose **Trust all and continue**. Codex runs the sage hooks only after this step.

   > **Note:** `codex exec` skips hooks without your trust, and it gives no warning.

4. Send the on phrase alone (see [Turn on sage mode](#turn-on-sage-mode)). When all is well, you see no sage line: the chief gets the status (the sage version, the Codex version, how many of the 10 sage hooks have a trust record, and how to start sage mode). You see a warning line only for a limit, for example:

   ```text
   sage: 3 of the 10 sage hooks are not trusted yet, so some sage rules do not run. To trust them, type /hooks in the Codex CLI.
   ```

   The other limit is a Codex version outside the tested range, for example:

   ```text
   sage: this is Codex 0.165.0, and sage is tested only with Codex 0.160 to 0.164. Some sage rules may not run.
   ```

   Codex starts a session at your first message, so a warning comes then. The status counts the trust records in your Codex config; Codex itself checks the hash of each hook and of the plugin's files, and it runs a hook only when both match.

   > **Warning:** when no sage hook is trusted, no sage hook runs, so you see no sage line at all, also no warning. If sage mode does not start, type `/hooks` in the Codex CLI and trust the sage hooks.

In the desktop app, do steps 1 and 2 in a terminal, with the Codex CLI (see [What you need](#what-you-need)). The app reads the same Codex home (`~/.codex`), so sage shows under the sage marketplace in its plugins list. An install from the app's own plugin list is not checked yet.

If the app does not ask you to trust the hooks, do step 3 once in the terminal. This desktop path is not checked yet.

The desktop app puts its worktree threads under `~/.codex/worktrees`. sage's `.codex` rule reads only the part of a path from the project folder down, so edits in those worktrees work as usual.

## Update and remove

- To update, run `codex plugin marketplace upgrade sage`, then `codex plugin add sage@sage` again. For a local clone, run `git pull` in the clone instead of the upgrade command.
- A new sage version needs your trust again: Codex 0.164 asks for it again for every sage hook when any file of the plugin changes. At the next start, choose **Trust all and continue** again.
- To remove sage, run `codex plugin remove sage@sage`, then `codex plugin marketplace remove sage`. The Codex logbook in `~/.codex/sage` stays; delete that folder yourself to remove it.
- Codex keeps the trust records of the sage hooks in your Codex config (`~/.codex/config.toml`, the `[hooks.state."sage@sage:..."]` tables), where they do nothing. To remove them too, delete those tables from the file.

## Turn on sage mode

Send each phrase alone, as the whole message, in any letter case.

| Say | What happens in Codex |
| --- | --- |
| `sage mode` | The session becomes your chief of staff: the hook adds the chief's role to that turn. Send your request next. |
| `sage mode off` | A normal session again. Autopilot goes off too. The hook adds the role no more, also after a compaction. |
| `autopilot on` / `autopilot off` | Autopilot turns on, while sage mode is on, or off. With autopilot on, autopilot merges verified work: the hook allows only the exact merge command when the merge check passes, with no prompt. |
| `sage help` | Every phrase, and whether sage mode and autopilot are on. |

- Send a phrase when Codex is idle. To stop merges at once, press Esc to stop Codex's turn, then send the off phrase for autopilot alone.
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

The plugin starts a local MCP server, `sage`, in the desktop app and in the CLI. Its tools write the logbook: one tool for each command of the state tool that the chief uses.

| Tool | Command of the state tool |
| --- | --- |
| `init`, `status` | `init`, `status` |
| `task_add`, `task_set` | `task add`, `task <T> set` |
| `run_add`, `run_done` | `run add`, `run done` |
| `finding_add`, `finding_triage`, `finding_close`, `finding_move` | `finding add`, `triage`, `close`, `move` |
| `verdict`, `round`, `merge_check`, `log` | `verdict`, `round`, `merge-check`, `log` |
| `standing`, `standing_add`, `pages` | `standing`, `standing add`, `pages` |
| `gate_add`, `gate_answer` | `gate add`, `gate answer` |
| `brief` | None: the brief check ([next section](#the-brief-check)) |

- Each tool takes `project`, the absolute path of the project's checkout, and the command's options by their names.
- The tools run the same checks as the commands. A refusal comes back as a tool error with the reason of the command.
- Only the chief records the logbook. Codex blocks a role agent's call of a tool that writes (for example `verdict`, `gate_answer` or `brief`), and the agent gets one line that says to put it in its report. Codex's own review thread (`/review`, the app's review button) and its approval check count as role agents here.
- A role agent may call `status`, `standing`, `merge_check`, and `pages` without `record`.
- Codex starts the server outside the shell sandbox. Under `workspace-write`, the logbook is not a writable folder of an agent's shell, so only the server writes it.
- Under full access (`danger-full-access`), an agent's shell can write any file, also the logbook, the mode files and Codex's record of your messages. So sage mode gives no guarantee there.
- The plugin approves its own tools, so the logbook writes do not ask you each time. To be asked, set `default_tools_approval_mode = "prompt"` under `[plugins."sage@sage".mcp_servers.sage]` in your Codex config.

## The brief check

In Codex, a hook cannot read a spawn message: with a real model, Codex sends it encrypted. So the chief checks each brief with a tool before the spawn, and the hooks read what the tool keeps.

1. Before each spawn, the chief calls `brief` with the task name (for example `sage_implementer_t12_r40`: the role, the task and the run id) and the whole brief. The tool names each missing field of `GOAL` to `STANDING`, by the same field list as Claude Code. It keeps the brief in the logbook (`briefs/<task name>.json`).
2. The chief fixes the missing fields and calls `brief` again, until the tool says `checked: all 10 fields`. Then it spawns the agent.
3. When the agent starts (`SubagentStart`), the hook gives it a note: the project's standing orders, the `FORBIDDEN` field of its checked brief, and the brief. With no checked brief on record, the note says `sage: no checked brief for this task.`
4. After the spawn (`PostToolUse`), when no checked brief is on record for that task name, the chief gets one warning that names the missing fields and says to run the brief check.

The check does not block a spawn, and no hook changes the spawn message. The hooks find the record by the folder that Codex runs in, so start Codex in the project folder.

## The rules in Codex

The hook `hooks/gate-hook.mjs` holds these rules. Codex runs it before each shell command, each `apply_patch` edit, each `spawn_agent` and each call of a sage logbook tool (`PreToolUse`), and before it shows an approval prompt for a shell command (`PermissionRequest`).

| Rule | When | What you see |
| --- | --- | --- |
| A merge runs only with autopilot on and a passing merge check for that head commit, in the one form `gh pr merge <n> --squash --delete-branch --match-head-commit <sha>`, from the main thread | sage mode | Codex blocks any other merge, and the chief gets one line with the reason. A verified merge runs with no approval prompt: the hook allows its network approval itself |
| A push takes the one push form of Claude Code: `git push [-u] origin <branch>`, with the literal name of the task's branch, never main, never a force-push | sage mode, every thread | Codex blocks any other push, with one line that gives the form |
| The chief changes no files | sage mode, the main thread | Codex blocks the chief's `apply_patch` edit. The chief briefs an implementer, and agents edit as before |
| A reviewer or QA changes no files | sage mode, a role agent whose task name names that role, and every agent under it; also Codex's own review thread and approval check | Codex blocks its `apply_patch` edit and its shell commands that write a file (also Codex's own `apply_patch` program), with one line: the agent reports a finding instead. It still reads files and runs the checks. The same rule holds the PE and the lead when they come to Codex |
| A name that starts with `sage_` but is not a sage task name counts as a read-only role | sage mode | Codex blocks its edits and shell writes, with one line that names the task name form |
| Only the chief records the logbook | Every mode, every agent that is not the chief, also Codex's own review thread and approval check | Codex blocks the agent's call of a logbook tool that writes, also `gate_answer` and `brief`, and its shell run of the state tool's write commands or of the `sage` MCP server, with one line: the agent puts it in its report. The read commands (`status`, `standing`, `merge-check`, `logbook`, and `pages` without `record`) run. The hook tells the chief from the other threads by Codex's record of the thread: Codex's review thread runs in the chief's session and has no agent id, but its record names a review source |
| A role agent starts no agents | Every mode, a role agent whose task name starts with `sage_`, every agent under it, and Codex's own review thread and approval check | Codex blocks its `spawn_agent`, with one line. An agent whose record the hook cannot read is blocked too |
| A role agent starts no Codex from the shell | Every mode, a role agent whose task name starts with `sage_`, and Codex's own review thread and approval check | Codex blocks `codex exec`, `codex` and every other run of a Codex executable, by its name or by its real file (also through a link or as `node <codex.js>`), with one line: a new Codex session would run outside the hooks of this session. `codex --version`, `codex --help` and the other programs of Codex's package (for example the `rg` that Codex puts first on the shell's PATH) run. In sage mode, a command that names codex and runs a program from a variable or a substitution, pipes text into a shell or `node`, or runs a link or a copy that the same command makes, is blocked too |
| No agent sends input to another thread | Every mode, every agent that is not the chief | Codex blocks its `send_input` (multi-agent v1, with `agent_max_depth` 2 or more), with one line: a message to the chief's thread would start a turn as if you typed it |
| No one changes files under a `.codex` folder of the project | Every mode, every thread | Codex blocks the `apply_patch` edit, or the shell write that names the folder. Codex reads project settings from that folder, so you make such changes yourself. Only the path from the project folder down counts, so a project under `~/.codex/worktrees` edits as usual |
| No shell command names the Codex sage folder or the Codex sessions folder, and none resumes or forks a Codex session | Every mode, every thread | Codex blocks the command, with one line. The sage folder holds the logbook and the mode files, and the sessions folder holds Codex's record of your typed messages; the logbook tools change the logbook |

For every other approval, the hook does not decide, so Codex shows its own prompt. When the hook cannot read a tool call, it blocks the call and says so in one line. When it cannot read an approval request, Codex shows its own prompt.

If an agent says that the hook could not read Codex's record of its thread, start a new session in the project folder. If it happens again, report it with your Codex version.

The hook reads sage mode from the mode file of the session (in `SAGE_HOME`, or `CODEX_HOME/sage`, under `.hooks/codex/`), with the same reader as the mode hook: a damaged file is off. Autopilot counts only when the mode file and your own typed messages in Codex's record of the thread both turn it on, so an agent that writes a mode file unlocks no merge. The merge check needs `gh`, logged in, and the logbook's verdicts for the head commit, as in Claude Code.

Limits:

- The hook reads a shell command's text and its words as the shell reads them, so quotes inside a name, `~`, `$HOME`, `$CODEX_HOME`, `$SAGE_HOME` and a path from the command's folder count. A command that hides a folder name in a variable of its own, a link or a script is not blocked. Codex's own sandbox keeps `.codex` and the Codex home read-only in the workspace-write mode.
- A role agent can still start Codex through a copy of the Codex binary or a script that it made in an earlier command, and any `node` script that loads sage's core can write the logbook. The workspace-write sandbox is the stop for both: its network block keeps a new Codex session from its model, and the logbook is outside the folders that it lets an agent write.
- In `codex exec --ephemeral`, Codex's review thread has no record, and its hook events carry no field that tells it from the main thread, so the hook reads it as the chief.
- Codex sends the hook no working folder of a shell command, so the merge rule checks the session's project. The merge form pins the head commit, and the merge check reads the verdicts of that commit.
- A reviewer's or QA's shell write is blocked only in the plain write forms that the hook reads: a redirection, `tee`, `cp`, `mv`, `rm`, `sed -i` and a short `node -e` or `bash -c` text. A write through `git apply`, `git commit`, a script file that `node` or `python` runs, or `make` is not blocked. The reviewer's brief and role text tell it to change no files, and the review checks the branch.
- A reviewer's commit through these forms can also be pushed to the task's branch. Read the branch's commits before a merge, or keep autopilot off for such a task.
- A shell write by the chief is not blocked either: the chief's edit rule covers `apply_patch`.
- Codex 0.164.0 runs no hook for text that an agent types into a shell that still runs (`write_stdin`, for example after `zsh -i`). That text passes every sage rule, also a push or a merge. Autopilot off does not stop such a merge.
- In workspace-write, the sandbox keeps this text off the network and keeps the logbook and the sessions folder closed. Keep network access off for the session (`[sandbox_workspace_write] network_access = false`, the default). When Codex asks to run an interactive shell (for example `zsh -i`) outside the sandbox, refuse.
- Under full access (`danger-full-access`), sage mode gives no guarantee: an agent can write any file, also the mode files, the logbook and Codex's record of your messages.

## What comes next

The lead role, agent caps and the board phrases come later in the same plugin. Codex draws its own approval prompts in both front ends, so sage adds none. The runtime notes of the parked Codex fork, for example the [Claude parity audit](../../packages/sage-codex/runtime/claude-parity-audit.md), stay as evidence.
