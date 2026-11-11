# sage in Codex

This page tells you how to install sage in Codex, what it does there today, and its [known limits](#known-limits-in-codex). sage installs as a Codex plugin from its own marketplace, with your normal Codex: the terminal CLI, and the Codex desktop app in the ChatGPT app. sage was checked with the CLI and with the desktop app's own Codex (see [What you need](#what-you-need)).

In Codex, sage mode gives the session the chief's role, its role agents and the logbook tools. Hooks hold the bounded merge and edit rules described below, and autopilot merges verified work with sage's merge command.

The design of the two provider plugins is in [Separate provider packages](../design/provider-packages.md).

## What works and what does not

| Part of sage | Claude Code | Codex today |
| --- | --- | --- |
| Install from the sage marketplace | Yes | Yes: `codex plugin marketplace add`, then `codex plugin add sage@sage` |
| A status at the start of each session | No | Yes: the chief gets the sage version, the Codex version, how many sage hooks are trusted and the on phrase. You see a warning only when a sage hook entry is missing or changed, a sage hook is not trusted or turned off, the hook launcher is old, the sage marketplace is pinned to one commit, or your Codex is outside the tested range |
| Principles and the writing skills | Yes | Yes: the same skills, including the `sage` skill for manual logbook commands |
| The principles of each role | Yes: each agent file preloads them | Yes: `role.mjs` puts them in each role's text. A lead gets the path of each one to read, and the mode hook gives the chief the paths of its principles |
| The logbook and the board | Yes | Yes: the plugin's `sage` MCP tools write the logbook, and the board phrases show the board ([The board in Codex](#the-board-in-codex)) |
| Programs (one goal, several tasks, a breakdown gate) | Yes | Yes: the `program_propose` tool opens the breakdown gate, and `task_set` with `program=` puts a task in a program or takes it out ([The logbook tools](#the-logbook-tools)) |
| The settings: cycle counts, `max_leads`, the model keys, the project's board name and archive, and its start in sage mode | Yes | Yes: the `config` tool, when you ask the chief. A model key gives a Codex agent a reasoning effort, not a model ([Model keys in Codex](#model-keys-in-codex)) |
| sage mode: the chief's role | Yes | Yes: the `sage mode` phrase gives it, and it comes back after a compaction |
| Start every session of a project in sage mode | Yes: `config start=sage-mode`, or the `"agent"` line ([Start every session in sage mode](using-sage.md#start-every-session-in-sage-mode)) | Yes: the same `config start=sage-mode` setting turns sage mode on at each new session (one setting for both, with a shared logbook) |
| Role agents | Yes: the lead, the implementer, the reviewers, QA, the PE, the designer, the arena judge and the investigation roles | The public helper supports each of these roles and the investigation roles. The chief starts one lead for each task with a build, and the lead starts its team and records its task; other role agents start no agents and record nothing. A pilot on stock Codex ran a lead and its team with a test model, and each thread needs a multi-agent v2 model (see [start a role agent](../../packages/sage-codex/skills/sage/references/roles.md)). |
| The brief check | Yes: the hook refuses a brief without every field | Yes: the chief runs the `brief` tool before each spawn, and the gate refuses a role agent's spawn with no checked brief. Each role agent starts with the project's standing orders and its checked brief ([The brief check](#the-brief-check)) |
| The report check | Yes | Yes, for a role agent whose task name starts with `sage_`: a report without every field gets one more turn, then the agent stops with one plain line. A review or QA agent's report goes through the same reader as in Claude Code: a report that the reader cannot read gets one more turn too |
| sage mode: the push rule in code | Yes | Yes: the same push form as in Claude Code ([The rules in Codex](#the-rules-in-codex)) |
| sage mode: agent caps in code | Yes | Yes: the state tool refuses a new run when the project already has its cap of running runs (`max_agents`, 10 by default), as in Claude Code. Codex's own thread limit must hold as many agents ([What you need](#what-you-need)) |
| Autopilot | Yes | Yes, in Codex 0.164 and later: autopilot merges verified work with sage's merge command, with no prompt for the merge ([Autopilot in Codex](#autopilot-in-codex)). The hook refuses `gh pr merge` in every mode |
| The merge rule, the no-edit rules and the `.codex` rule | Yes | Yes, in the plugin's hooks ([The rules in Codex](#the-rules-in-codex)) |
| The mode phrases (`sage mode`, `sage mode off`, `autopilot on`, `autopilot off`, `sage help`) | Yes | Yes |
| The board phrases (`show board`, `show status`) | Yes | Yes: the hook gives the chief the same board note as in Claude Code. The board page starts after you approve one prompt ([The board in Codex](#the-board-in-codex)) |

A project can use one [shared logbook](using-sage.md#shared-logbooks) for Claude and Codex, in `~/.sage` (or `SAGE_SHARED_HOME`). A new project gets one when both plugins are updated, and the chief can [move an existing project](using-sage.md#move-an-existing-project) into one. A project that did not move keeps its Codex logbook in `~/.codex/sage` (or `CODEX_HOME`), apart from Claude's.

The browser board shows every logbook by default, and each card says which provider's logbook holds it.

## What you need

- Codex 0.164 or later. sage was checked with the Codex CLI 0.164.0 and 0.166.0 on macOS, with a test model. The desktop app carries its own Codex, which changes with the app: sage was checked with the Codex of desktop 0.166.0-alpha.6 and 0.167.0-alpha.3.2, not with other versions.
- The Codex CLI on your PATH, in that range, also when you use only the desktop app: the install commands below are CLI commands. To get it, run `npm install -g @openai/codex@0.164.0`.
- Node.js 20 or later, on your PATH: the sage hooks are Node scripts.
- `gh`, logged in (`gh auth login`), and a GitHub remote for the project. sage uses them for pull requests and the merge check; without them, work stops at a verified branch.
- A multi-agent v2 model for the chief and each child. In Codex 0.164.0's bundled catalog, the `gpt-6-sol` models are v2, and `gpt-5.6-luna` is not ([limits](#the-rules-in-codex)).
- Codex's thread limit at sage's agent cap (`max_agents`, 10 by default). A sage plugin cannot set it, so add these lines to your Codex config file, `config.toml` in your Codex home (`$CODEX_HOME/config.toml`, by default `~/.codex/config.toml`):

  ```toml
  [agents]
  max_concurrent_threads_per_session = 10
  ```

  - This value counts the agents only: Codex adds one thread for the chief. The default of 4 threads holds the chief and 3 agents, for example a lead and 2 helpers.
  - If your config has `max_concurrent_threads_per_session` under `[features.multi_agent_v2]`, that value wins over the `[agents]` value, and it counts the chief's thread too: set it to 11.
  - When the limit that applies is below the project's agent cap, the sage start status warns you and names the line to change. Start a new session after the change.

## Install

1. Add the sage marketplace, in a terminal:

   ```sh
   codex plugin marketplace add https://github.com/erickb336/sage-stack.git
   ```

   You see ``Added marketplace `sage` ``. To try a local clone instead, give its folder: `codex plugin marketplace add ./sage-stack`.

2. Install the plugin:

   ```sh
   codex plugin add sage@sage
   ```

   You see ``Added plugin `sage` from marketplace `sage`.`` Then `codex plugin list` shows `sage@sage  installed, enabled`.

3. Install sage's hooks and trust them. You do this once on each computer (each Codex home), not after each update:

   > **Note:** the paths in this page use the default Codex home, `~/.codex`. When you set `CODEX_HOME`, use that folder in place of `~/.codex` in each path, for example `ls "$CODEX_HOME/plugins/cache/sage/sage"`.

   1. Find the folder of the installed plugin: `ls ~/.codex/plugins/cache/sage/sage` shows one folder, for example `0.1.0`.
   2. Run the install command of that folder, in a terminal:

      ```sh
      node ~/.codex/plugins/cache/sage/sage/0.1.0/skills/sage/sage.mjs hooks install
      ```

      > **Note:** when the command stops with `unknown command "hooks"`, the installed copy is from before T957, and it has no `hooks` command. This happens when your Codex config pins the sage marketplace to an old commit. Run the 3 commands of [Update and remove](#update-and-remove) (remove the marketplace, add it again, add the plugin), then do this step again.

      It writes the Codex home that holds the plugin, also when `CODEX_HOME` is not set; it refuses when `CODEX_HOME` names another home. It puts 7 sage entries at the end of your Codex hooks file (`~/.codex/hooks.json`), and copies sage's hook launcher to `~/.codex/sage-hooks`. When you have no hooks file yet, it makes one. When you have one, your own hooks in it stay as they were (also a hook that you put in a sage group), and a copy of the old file stays in `~/.codex/hooks.json.sage-backup`. A second run changes nothing. The command refuses a hooks file that it cannot read, and changes nothing then.
   3. Run `codex` in a project folder. At the "Hooks need review" screen, choose **Trust all and continue**. Codex runs the sage hooks only after this step.

   > **Note:** `codex exec` skips hooks without your trust, and it gives no warning.

4. Send the on phrase alone (see [Turn on sage mode](#turn-on-sage-mode)). When all is well, you see no sage line: the chief gets the status (the sage version, the Codex version, how many of the 7 sage hooks are trusted, and how to start sage mode). You see a warning line only for a limit, for example:

   ```text
   sage: 3 of the 7 sage hooks are not trusted or turned off, so they do not run. To trust them or turn them on, type /hooks in the Codex CLI.
   ```

   When a sage entry of your hooks file is missing or changed, or the launcher is older than the installed sage, the warning names the command that fixes it (`hooks install`). Run it yourself in a terminal, or tell the chief yes, and then the chief runs it. The chief does not run it without your yes, because it writes your hooks file. When your Codex config pins the sage marketplace to one commit, the warning gives the 3 commands that end the pin (see [Update and remove](#update-and-remove)). The other limit is a Codex version outside the tested range (0.164 to 0.167), for example:

   ```text
   sage: sage was not tested with Codex 0.168.0, so some sage rules may not run. Autopilot merges in Codex 0.164 and later.
   ```

   Codex starts a session at your first message, so a warning comes then. The status counts the trust records in your Codex config: a changed entry or a hook that you turned off in `/hooks` does not count. Codex itself checks the hash of each entry, and it runs a hook only when they match.

   > **Warning:** when no sage hook is trusted, no sage hook runs, so you see no sage line at all, also no warning. If sage mode does not start, type `/hooks` in the Codex CLI. If the 7 sage hooks are not in the list, do step 3 again; if they are not trusted, trust them there.

In the desktop app, do steps 1 and 2 in a terminal, with the Codex CLI (see [What you need](#what-you-need)). The app reads the same Codex home (`~/.codex`), so sage shows under the sage marketplace in its plugins list. An install from the app's own plugin list is not checked yet.

If the app does not ask you to trust the hooks, do step 3 once in the terminal. The app's own hook review is not checked yet: sage's desktop checks drove the app's Codex as the app drives it, not the app's screens. The package check (`npm run check:codex`, with `SAGE_CODEX_BIN` set to the app's own `codex`) showed that the app's Codex lists the 7 sage entries as your hooks, and that they stay trusted after an update.

Then do the [gate check](#check-that-the-sage-gate-runs).

The desktop app puts its worktree threads under `~/.codex/worktrees`. sage's `.codex` rule reads only the part of a path from the project folder down, so edits in those worktrees work as usual.

## Update and remove

- To update, run `codex plugin marketplace upgrade sage`, then `codex plugin add sage@sage` again. For a local clone, run `git pull` in the clone instead of the upgrade command.
- When your Codex config pins the sage marketplace to one commit, an update gets no newer sage. The pin is a `ref = "<commit>"` line under `[marketplaces.sage]` in `~/.codex/config.toml`, from `codex plugin marketplace add --ref`. The upgrade then fetches the same commit, and `codex plugin add sage@sage` keeps the old copy. To end the pin and install the newest sage, run these 3 commands in a terminal:

  ```sh
  codex plugin marketplace remove sage
  ```
  ```sh
  codex plugin marketplace add https://github.com/erickb336/sage-stack.git
  ```
  ```sh
  codex plugin add sage@sage
  ```

  These commands also move an old marketplace URL (`https://github.com/erickb336/sage.git`) to the new one. Your hooks file, and the trust records in your Codex config, stay as they were. Then start a new session. From T971 on, the start status and `hooks status` tell you when the sage marketplace is pinned to a commit, and give these 3 commands. A `ref` that names a branch, such as `main`, follows that branch, so it gets no warning.
- An update needs no new trust. Codex trusts each sage entry of your hooks file by its text and its place, not by sage's files, and an update does not change the entries. The launcher runs the hooks of the sage version that Codex uses, so a new version runs at once, with no new review of its code, as in Claude Code.
- When an update changes the entries or the launcher, the start status says so and names the `hooks install` command. Run it, then trust the changed entries with `/hooks`.
- The first update to a version with the launcher (T957): sage's hooks move from the plugin to your hooks file. An install from before T957 has no `hooks` command, and its start status does not show a pin. So do these steps once:
  1. Run the 3 commands above (remove the marketplace, add it again, add the plugin). An upgrade of a pinned marketplace keeps the old copy, and then `hooks install` stops with `unknown command "hooks"`.
  2. Check that the new copy is installed: `ls ~/.codex/plugins/cache/sage/sage/*/hooks` shows `launch.mjs` and `dispatch.mjs`. If they are not there, check that the `[marketplaces.sage]` table in `~/.codex/config.toml` has no `ref` line.
  3. Do step 3 of the [install](#install), then do the [gate check](#check-that-the-sage-gate-runs).

  Until then, no sage hook runs, and sage's logbook tools refuse every call with a line that names the install command.
- To turn sage off, turn the plugin off in your Codex config file (`enabled = false` for `plugins."sage@sage"`, in its own table or in any other TOML form). The launcher then does nothing. The launcher reads only that file: a `-c` option, a profile or a managed policy that turns the plugin off does not stop sage's hooks (a documented limit).
- To remove sage (with `CODEX_HOME` set, use that folder in place of `~/.codex`):
  1. Run `node ~/.codex/sage-hooks/launch.mjs --uninstall`. It removes the 7 sage entries from your hooks file and the `~/.codex/sage-hooks` folder. Your own hooks stay.
  2. Run `codex plugin remove sage@sage`, then `codex plugin marketplace remove sage`.

  If you removed the plugin first, the sage entries do nothing, because the launcher finds no sage: run step 1 at any time. The Codex logbook in `~/.codex/sage` stays; delete that folder yourself to remove it.
- Codex keeps the trust records of the sage hooks in your Codex config (`~/.codex/config.toml`): the `[hooks.state."<your Codex home>/hooks.json:..."]` tables, and the `[hooks.state."sage@sage:..."]` tables of the plugin hooks before T957. They do nothing without the entries. To remove them too, delete those tables from the file.

## Check that the sage gate runs

Do this check after you install sage's hooks, after an update that asks you to run `hooks install`, and when a sage rule seems not to run. Codex runs a hook only when you trust it.

1. Trust the hooks:
   1. Open a terminal, and go to the project folder.
   2. Run `codex`, with the same Codex home as the app. When you set `CODEX_HOME` for the app, set the same value in the terminal.
   3. Type `/hooks`. Codex lists each hook and whether you trust it. Each of the 7 sage hooks (it comes from your hooks file, `~/.codex/hooks.json`, and its command runs `sage-hooks/launch.mjs`) must show as trusted.
   4. If a sage hook shows as new, changed or not trusted, trust it there (or choose **Trust all and continue** at the start screen). Then start a new session in the app.
2. Send the phrase `sage mode` alone (see [Turn on sage mode](#turn-on-sage-mode)), then ask the chief to run the sage status tool. When the gate runs, the chief shows the status lines of the logbook. When it does not run, the chief shows a line that starts with "sage's gate is not running" and names the `hooks install` command: do step 1 again.
3. Check the gate on a shell command from code mode.

   > **Warning:** never test the gate with a real push or a merge. If the gate does not run, the command runs.

   Ask the chief to run `rm -f ~/.codex/sage/sage-gate-check.tmp` with `tools.exec_command` from a code-mode `exec` call. No such file exists, so this command changes nothing, and the gate refuses it in every mode. When the gate runs, Codex blocks it with a line that starts with "sage: no agent writes, moves or removes a logbook file from the shell" and names the word. When the command runs with no such line, the gate does not run: stop sage work, and do step 1 again.

   When you set `CODEX_HOME` or `SAGE_HOME`, the gate guards the `sage` folder in that Codex home, or the `SAGE_HOME` folder, in place of `~/.codex/sage`. When you set both, `SAGE_HOME` wins. Then name that folder by its absolute path or by a path from `~`, for example `rm -f ~/codex-home/sage/sage-gate-check.tmp`. Do not name it by a variable such as `$SAGE_HOME`: the gate does not read variables (a documented limit), so that command runs also when the gate runs.
4. If you use the app's browser preview, ask the chief to open a page in it. The preview uses a `js` call, and it runs, because you chose to allow `js` in sage mode. If you do not use the preview, skip this step.

## Turn on sage mode

Send each phrase alone, as the whole message, in any letter case.

| Say | What happens in Codex |
| --- | --- |
| `sage mode` | The session becomes your chief of staff: the hook adds the chief's role to that turn. Send your request next. |
| `sage mode off` | A normal session again. Autopilot goes off too. The hook adds the role no more, also after a compaction. |
| `autopilot on` / `autopilot off` | Autopilot turns on, while sage mode is on, or off. With autopilot on, autopilot merges verified work: the chief runs sage's merge command after the clean cycles and a passing merge check, with no prompt for the merge ([Autopilot in Codex](#autopilot-in-codex)). |
| `sage help` | Every phrase, and whether sage mode and autopilot are on. |

- To turn on autopilot, send `sage mode`, then `autopilot on`, each alone. Merges also need Codex 0.164 or later, and `node` and `gh` outside the folders that Codex's sandbox can write ([Autopilot in Codex](#autopilot-in-codex)).
- Send the on phrase with no image. A phrase counts only as the whole message, and an image is part of the message. Codex gives the hook only the text, so the chief can confirm the switch, but sage's merge rule reads the whole message in Codex's record: with an image, the on counts for nothing, and merges wait for you.
- With autopilot off, the chief prepares a reviewed pull request for you to merge in GitHub. It reports the PR link, exact head commit and evidence.
- Send an on phrase when Codex is idle. An off phrase works at any time: sent with Enter while Codex works, it stops merges from Codex's next step. A phrase that you queue with Tab waits until the turn ends.
- An on phrase sent with Enter while Codex works joins the running turn, and counts for nothing: the chief tells you so. Press Esc first, then send it. In the terminal UI, an on phrase that you queue with Tab counts: it starts the next turn when the current turn ends.
- To stop a merge now, press Esc (see [Stop a merge](#stop-a-merge)).
- Only your own typed message switches a mode: Codex gives the hook no agent text. A Codex review or approval check sends its own prompt, and that prompt switches nothing.
- A message near a phrase switches nothing. The chief asks you for the exact phrase, unless your message was a question.
- For a normal switch, the chief confirms the switch in one line of its reply.
- For a limit or a fault, the hook gives Codex a warning line; the terminal UI and the app show it; `codex exec` does not. The faults: an event that the hook cannot read (it switches nothing and turns autopilot off), and a mode folder that it cannot use (the line names the folder).
- A damaged mode file turns sage mode and autopilot off. The hook replaces the file with a clean one and gives one warning line. Send `sage mode` to turn sage mode on again.
- A forked thread starts with sage mode and autopilot off, because Codex does not tell the hook which thread it came from. If the fork shows the chief's role, the chief tells you this in one line. Send `sage mode` in the fork to turn it on there.
- With `SAGE_HOOKS=off`, a phrase switches nothing, and the hook gives one warning line that says so.
- The hook keeps the mode of each session in `~/.codex/sage/.hooks/codex/` (or under `SAGE_HOME`).
- To start every new session of a project in sage mode, ask the chief to set `start=sage-mode` with the `config` tool. With a shared logbook, Claude reads the same setting ([Start every session in sage mode](using-sage.md#start-every-session-in-sage-mode)).
- With the setting, a new session and `/clear` start in sage mode, and the start status says so. A resumed session keeps its own mode, and `sage mode off` still gives a normal session for the rest of the session.

The hooks run only after you trust them (step 3). In `codex exec`, Codex skips hooks that you have not trusted, with no warning.

### The board in Codex

The board phrases work in Codex as in Claude Code, at the start of your message, also with sage mode off: `show board`, `show status` and the other forms of [Ask for the board](board.md#ask-for-the-board). The sage hook gives the chief the same board note as in Claude Code, from the same code.

1. The chief runs `board --ensure` from the plugin's `board` folder. This command starts the board page: it writes the board config the first time, starts the board server in the background and opens a local port.
2. Codex's sandbox blocks the write in your home folder and the local port. The default `workspace-write` sandbox lets a command write only "inside the active workspace roots and system temp directories", and it "keeps network access turned off" ([Codex: Permissions](https://learn.chatgpt.com/docs/permissions), [Codex: Agent approvals & security](https://learn.chatgpt.com/docs/agent-approvals-security)). In the sandbox of Codex 0.164.0, a local port gives `EPERM`.
3. So the chief runs `board --ensure` escalated, and Codex asks you to approve it: one prompt each time that you ask for the board. Approve it, and the chief shows the board page's address, as in Claude Code.
4. Then the chief runs the chat board in the sandbox, with no prompt: it only reads the logbooks and writes nothing, so it shows the same board as in Claude Code.

- If you decline the prompt, or your approval policy is `never`, the chief still shows the chat board, and gives you the `board --ensure` command to run in Terminal on the Mac.
- If the command runs in the sandbox by mistake, it prints one line that says to run it escalated or in Terminal. While the board config does not exist yet (before the first board start), the line says that the sandbox blocks the write of the board config folder (`~/.config/sage-board`). When the config exists, it says that the sandbox blocks the local network, not that another program holds the port.
- **Yes, and don't ask again** for the prefix of this command saves a rule (see [the approval prompts](#the-approval-prompts-of-each-task)): later board starts then run outside the sandbox with no prompt.
- A restart after an update works in the same way: the chief gives you the `board --stop` command, and runs it escalated only when you ask.

### Autopilot in Codex

With sage mode and autopilot on, the chief lands a verified pull request itself. After the task's clean cycles, CI on the final head and a passing `merge_check`, the chief runs sage's merge command (`skills/sage/merge.mjs` of the plugin). The sage hook admits it only when all of these hold:

- Sage mode and autopilot are on in the mode file of the session.
- The Codex that runs is 0.164 or later.
- Codex's own record of the session has your on phrase since this start of the session. After a restart, a resume or a fork, send it again.
- That on phrase is the one that turned autopilot on in the mode file: the latest on phrase that started its own turn.
- The call comes from the main thread, in the one exact form of the command, and it is in Codex's record.
- `node` and `gh` are outside the folders that Codex's sandbox can write (the project, its folder and the temporary folders).
- The merge check passes for that head commit.

Then the hook saves a one-time permit for that one call, and allows the call's escalation itself, with no prompt.

When Codex's network access is off, Codex can still show one network prompt for GitHub's API (`api.github.com`) while the merge runs: approve it, and the merge continues. The hook cannot allow it, because the merge command has used its permit by then.

Right before `gh pr merge`, the command reads Codex's record and the mode file again. When a check refuses, the chief reports the pull request as ready, with the reason, and you merge it in GitHub.

#### Stop a merge

| You do | What stops |
| --- | --- |
| Press Esc | The merge stops at once, unless its call to GitHub has started: that merge completes. Autopilot stays on: to stop later merges, send the off phrase. |
| Send `autopilot off` with Enter while Codex works | No merge starts from Codex's next step on. A merge that the hook admitted in this step can still complete. |
| Queue `autopilot off` with Tab | It waits until the turn ends. To stop a merge in this turn, press Esc or send the off phrase with Enter. |
| Send `autopilot off` or `sage mode off` when Codex is idle | No merge starts. |

The off phrase always counts, and nothing blocks it: also with an image, and also when the sage hook cannot save it, because the hook and the merge command read it from Codex's own record.

The off phrase works from any thread, also a subagent's thread, a fork or a side conversation (`/side`): there it turns autopilot off in every Codex session, and sage tells you so in that thread. Such a thread cannot always name its main session (a fork of a fork names only the fork), so sage turns off every session.

To turn autopilot on again, send `autopilot on` in the main thread of a session, as a new message while Codex is idle. An on phrase that joins a running turn there does not turn it on again, also when an earlier on phrase is in that thread.

Limits of autopilot in Codex:

- Codex 0.164 or later only. With an older version, merges wait for you: merge the pull request in GitHub. The hook asks the Codex that runs for its version, because a resume by a newer Codex writes no version into its record.
- sage was tested with Codex 0.164 to 0.167, and a newer Codex also merges. When a newer Codex changes the form of its record, sage cannot read it: merges wait for you, and the refusal says so.
- A newer Codex can also change what a record line means with no change of its form. sage cannot see that change (owner decision of 2026-11-10).
- Codex puts a folder of its own on the hook's `PATH`, and the hook finds the Codex that runs there. If the hook cannot find it, the merge refuses with "sage cannot tell which Codex runs this session": merge the pull request in GitHub.
- Codex runs the hook in a login shell. So a login profile (such as `~/.zprofile`) that sets `PATH` without its earlier value drops that folder: keep the earlier value there (`export PATH="<folder>:$PATH"`), then ask for the merge again.
- An on phrase counts only from a message that you type and send to start a turn: in the terminal UI, in the app, or as the prompt of `codex exec`. As in Claude Code, an on phrase that you send while Codex works joins the running turn and counts for nothing. So does an on phrase that joins a turn that a subagent's report started.
- An on phrase from `codex queue`, from a message that the app queued, from a goal or from an automation also counts for nothing. Send it again alone when Codex is idle.
- In the terminal UI, an on phrase that you queue with Tab counts when it starts the next turn. It still turns autopilot on when you send an off phrase before that turn starts. To cancel it, remove it from the queue, or queue the off phrase after it.
- When the sage hook cannot read Codex's record of the session at that moment (for example, while Codex still writes its last line), an on phrase counts for nothing, and the chief tells you so. Send it again alone when Codex is idle.
- Codex records the client that starts each turn (the terminal UI, the app or `codex exec`) as the client names itself. So an agent that runs `codex exec` itself, outside the sage hooks, could send an on phrase. The hook blocks Codex from the shell and the sandbox keeps the sessions folder closed, so an agent must act against its brief to do this.
- After you resume a session in the app, send `autopilot off` if you do not want merges from an earlier on phrase. The app runs all its sessions in one Codex process. If the sage hook fails at the resume, an on phrase from before the resume can count until the app restarts.
- A writable root that you add in your Codex config (`sandbox_workspace_write.writable_roots`) is not checked for `node` and `gh`. Keep them out of such folders.

### The approval prompts of each task

Codex can ask for permission during ordinary Sage work before a merge. The following count describes the default `workspace-write` sandbox used in the pilot. There, "`<writable_root>/.git` is protected as read-only", and network access is off ([Codex: Agent approvals & security](https://learn.chatgpt.com/docs/agent-approvals-security)).

These commands need permission outside that sandbox. The sage hook allows no other approval through `PermissionRequest`: only the merge command that it admitted.

| Prompt | What it is for | Why Codex asks |
| --- | --- | --- |
| Create the task worktree (`git worktree add`) | The implementer's own folder and branch for the task | It writes to `.git` |
| Add the change (`git -C <folder> add <files>`) | The files of the commit | It writes to `.git` |
| Commit on the task branch (`git -C <folder> commit …`) | The change of the task | It writes to `.git` |
| Send the task branch (`git -C <folder> push -u <remote> <branch>`) | The branch of the pull request on GitHub | It writes to `.git` and needs the network |
| Open the pull request (`gh pr create`) | The pull request that the reviews and the merge check read | It needs the network |
| Read the pull request and its checks (`gh pr view`, `gh pr checks`) | The chief's check of a ready task, before the merge | It needs the network |

- The count of 5 is for the first five rows, in one small task with separate commands. A model that joins `git add` and `git commit` in one command gets one prompt for both.
- Each repair adds its own commit and push. A worktree outside the project asks once more, for a file change.
- A sandbox refusal is not a failed task or a failed check. The role texts tell each agent, and the skill tells the chief, to run the command again with escalated permissions, so that the prompt comes to you. So QA and a reviewer can ask you too, for example when a check needs the network.
- After a refusal of `git worktree add -b`, the agent first checks for a branch that the failed step left. When it finds that branch, it runs the command with no `-b`.
- With `approval_policy = "never"`, Codex refuses each escalation, so a build cannot commit. Use an approval policy that asks.
- The sage logbook tools ask nothing, also for a lead.
- With sage mode and autopilot on, the merge needs no prompt for its escalation: the sage hook allows the admitted merge command's approval itself. With network access off, approve the one network prompt for `api.github.com` that can come while the merge runs.
- With autopilot off, the hook refuses the merge command, and you merge the pull request yourself in GitHub.
- The hook refuses `gh pr merge` in every mode, including sage mode off.
- The model writes the reason line of each prompt, so its words can be different. The table uses the words of a check with the Codex CLI 0.164.0 and a test model.

In the CLI, Codex 0.164.0 gives these choices for such a prompt ([the choice text](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/tui/src/bottom_pane/approval_overlay.rs#L852-L938), [which choices it offers](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/protocol/src/approvals.rs#L377-L410)):

| Choice | What it does |
| --- | --- |
| **Yes, proceed** | Runs this command one time. The next task asks again. |
| **Yes, and don't ask again for commands that start with `<prefix>`** | Runs the command, and adds an allow rule for that prefix to `~/.codex/rules/default.rules` (or `$CODEX_HOME/rules/default.rules` when you set `CODEX_HOME`) ([the file](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/core/src/exec_policy.rs#L877-L879), [the write](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/core/src/exec_policy.rs#L469-L490)). The rule holds in every session: a matching command then runs outside the sandbox with no prompt. Codex shows this choice only when it has a prefix to offer. |
| **No, and tell Codex what to do differently** | Does not run the command. Codex stops its turn and waits for your message. |

Codex 0.164.0 offers no choice for "this session" only for these prompts.

Choose **Yes, proceed** to be asked each time. **Yes, and don't ask again** helps only when its prefix fits the next task too, so read the prefix before you choose. In the pilot on Codex 0.164.0, the proposed prefix held the exact folder and branch of the task (for example `git worktree add -b sage/t1-demo …`), so it fits only that command.

> **Trade-off:** the saved rule lets a later command that starts the same way run with no prompt and outside Codex's sandbox, from any Codex thread, and `git commit` runs the project's own git hooks. The sage hook still applies its push rule and refuses recognized shell merges in every mode.

When a network proxy is on, the prompt shows **Yes, just this once** in place of **Yes, proceed**. The same choice exists for a host: **Yes, and allow this host in the future** saves a rule, so later requests to that host run with no prompt, from any thread ([the network choices](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/tui/src/bottom_pane/approval_overlay.rs#L862-L913)).

To remove a saved rule, delete its line from `~/.codex/rules/default.rules` (or `$CODEX_HOME/rules/default.rules` when you set `CODEX_HOME`), then restart Codex: Codex reads its rules at startup ([Codex: Rules](https://learn.chatgpt.com/docs/agent-configuration/rules)).

The desktop app gets the same choices from Codex, but its docs do not name their text, and sage's desktop checks did not use the app's screens. So it is not checked yet that a child's prompt reaches you there.

**`writable_roots` and the network: not proved.** sage keeps Codex's defaults, and it does not recommend this option: `writable_roots` with the project's `.git` folder, and `network_access = true`. With the worktree inside the project, the pilot's git commands asked for no approval, but the push failed on the scratch remote. sage's task folders are outside the project, and there the pilot failed:

1. `git worktree add -b` failed in the sandbox, but it left the branch.
2. The escalated retry stopped with `a branch named 'sage/t1-demo' already exists`, so no worktree came to exist.
3. Each later step failed, and the sage hook refused the push.

The role texts now cover this retry, but no run tried it with this option. The option also lets agents write git's own files and reach the network with no prompt, so the limits under [The rules in Codex](#the-rules-in-codex) that say to keep network access off lose their stop.

**Not proved yet:**

- An escalated push under a strict sandbox. The pilot's push reached a scratch remote only with `/tmp` writable, and with no escalation. With `/tmp` excluded, the push failed, and no run tried it again with escalation.
- A real push and a real `gh pr create`. No run called a real remote.
- The `git worktree add` retry with no `-b` in Codex. It was checked only with git alone, not in a Codex run.

## The logbook tools

The plugin starts a local MCP server, `sage`, in the desktop app and in the CLI. Its tools write the logbook: one tool for each command of the state tool that the chief uses.

| Tool | Command of the state tool |
| --- | --- |
| `init`, `status` | `init`, `status` |
| `link` | `link --to <folder>`, `link --separate`: [shared logbooks](using-sage.md#shared-logbooks), only after your answer |
| `move` | `move --preview`, `move --plan <plan>`, `move --gate <G>`: [move an existing project](using-sage.md#move-an-existing-project), with `gate` only after your answer |
| `claim` | `claim <T>`: take a task with no owning chief in a [shared logbook](using-sage.md#shared-logbooks) |
| `offer`, `cancel`, `accept`, `release` | `offer <T>`, `cancel <T>`, `accept <T>`, `release <T>`: [hand a task to another chief](using-sage.md#shared-logbooks) |
| `task_add`, `task_set` | `task add`, `task <T> set` |
| `program_propose` | `program propose`, `program propose <PG>`: [a program](using-sage.md#waits-and-programs) and its breakdown gate. A task joins or leaves with `task_set` `program=` |
| `config` | `config key=value ...`: the cycle counts, `max_leads`, the other counts and the model keys for all projects, the project's board name and archive (`name=`, `archived=`), and its start in sage mode (`start=sage-mode` or `start=normal`) |
| `task_adopt` | `task-adopt <T>`: adopt another provider's task and PR from a separate logbook, with fresh destination reviews. In a shared logbook it refuses: use the takeover gate |
| `run_add`, `run_done` | `run add`, `run done` |
| `finding_add`, `finding_triage`, `finding_close`, `finding_move` | `finding add`, `triage`, `close`, `move` |
| `verdict`, `round`, `merge_check`, `log` | `verdict`, `round`, `merge-check`, `log` |
| `standing`, `standing_add`, `pages` | `standing`, `standing add`, `pages` |
| `worktrees` | `worktrees`, `worktrees prune --yes`: [clean up worktrees](using-sage.md#clean-up-worktrees). Only the chief calls it |
| `gate_add`, `gate_replace`, `gate_answer` | `gate add`, `gate replace`, `gate answer` |
| `brief` | None: the brief check ([next section](#the-brief-check)) |

- Each tool takes `project`, the absolute path of the project's checkout, and the command's options by their names.
- The tools run the same checks as the commands. A refusal comes back as a tool error with the reason of the command.
- The chief records the logbook, and a lead records its own task. Codex blocks another role agent's call of a tool that writes (for example `verdict`, `gate_answer` or `brief`), and the agent gets one line that says to put it in its report. Codex's own review thread (`/review`, the app's review button) and its approval check count as role agents here.
- A role agent may call `status`, `standing`, `merge_check`, and `pages` without `record`.
- In a [shared logbook](using-sage.md#shared-logbooks), the server finds the chief from the session, and a tool takes no chief field. A lead acts for the chief of its lead run.
- A write on a task of another chief refuses and names the owning chief, as in Claude. A task with no owning chief refuses and prints its version: call `claim` with the task and that version.
- To abandon a task with no owning chief, any chief needs no claim: call `task_set` with `fields` `{"state": "abandoned"}` alone and `why`, the reason. The task keeps no chief.
- A review or QA `verdict` on a task with a build needs `run`: a done run of the task whose child had the run in its task name (`sage_qa_t12_r40`) and ended with its full report. At that stop, the report check keeps the report in the logbook, and `verdict` refuses a verdict that no kept report backs. A report that `pages` saved backs no verdict, because the chief gives its text.
- Token counts: at the stop of a child that has the run in its task name (also a lead, `sage_lead_t12_r40`), the report check reads the child's own token total from its Codex session record. That is `total_tokens` of the last `token_usage_record` line of the child's own thread, not of its children. `run_done` records it as the run's tokens, and the logbook and the board show it, as for a Claude run.
- When the record has no such line, or the check cannot read it, the run's usage is unavailable, with the reason.
- Codex starts the server outside the shell sandbox. Under `workspace-write`, the logbook is not a writable folder of an agent's shell, so only the server writes it.
- Under full access (`danger-full-access`), an agent's shell can write any file, also the logbook, the mode files and Codex's record of your messages. So sage mode gives no guarantee there.
- The plugin approves its own tools, so the logbook writes do not ask you each time. To be asked, set `default_tools_approval_mode = "prompt"` under `[plugins."sage@sage".mcp_servers.sage]` in your Codex config.
- Limit: `logbook repair` has no tool, and the sandbox keeps the logbook closed to the chief's shell. So the Codex chief cannot run either repair.
- When a saved change cannot finish and you have no backup, accept the loss, then run this yourself in a terminal, outside Codex: `node ~/.codex/plugins/cache/sage/sage/<version>/skills/sage/sage.mjs logbook repair --accept-change-loss yes --project <project>`.
- When a table fails the logbook check and you have no copy, accept the loss, then run the line that the refusal prints in the same way: `logbook repair --accept-loss <table> --project <project>`. A repair names no chief, also on a shared logbook.
- To find `<version>`, run `ls ~/.codex/plugins/cache/sage/sage/` and use the current one. When you set `CODEX_HOME`, use that folder in place of `~/.codex`.
- A saved change of a schema that only the deleted Codex native runtime wrote (2 to 6 and 8) cannot finish. It stops the writes of its logbook until this change-loss repair.

### Model keys in Codex

Codex uses the same model keys as Claude Code (`model.<role>`, `model.<role>.<size>` and `model.<role>.risk`), with the same model names and Balanced defaults. `run_add` makes the same choice as in Claude Code, and prints a reasoning effort in place of the model name. Every agent keeps the session's model.

- For example, `run_add` prints `R40 running · qa on T12 · reasoning_effort medium`.
- The chief and the lead give that level to `spawn_agent` as `reasoning_effort`.

| Model name in the key | Reasoning effort in Codex | Balanced defaults that use it |
| --- | --- | --- |
| `opus` | `high` | the PE, the designer, the arena judge, the security review, the implementation and code review of small and large tasks, and the QA of large tasks |
| `sonnet` | `medium` | the UX review, the QA of tiny and small tasks, and the implementation and code review of tiny tasks |
| `haiku` | `low` | none: set a key to `haiku` to give a role a low effort |
| `fable`, `inherit` | none | none |

- A role with no effort gets no `reasoning_effort` field, so it keeps the session's effort. The lead and the investigation roles have no model key, so they get none too.
- The levels follow the strength of the Claude model: the strong model gets a high effort and the light one a medium effort.
- An arena candidate gets the effort of its place in `arena_models`. Codex's default is `inherit,inherit,inherit`, so the candidates get none.
- Codex reads the keys from its own config, in its logbook root (`~/.codex/sage`, or `SAGE_HOME`), also for a shared logbook. To change a key, ask the Codex chief to call `config`, for example `{"model.qa.small": "haiku"}`.
- Codex checks the level against the session's model, and a spawn with a level that the model does not have fails with Codex's own line. In the bundled model catalog of Codex 0.164.0, each v2 model has `low`, `medium` and `high`. A real spawn with a level is not checked yet.
- The run's row in the logbook keeps no model for a Codex run, so the board shows none.

## Design roles and acceptance

The public `role.mjs pe` and `role.mjs designer` helpers use the shared role contracts. PE changes nothing.

The designer writes the scoped prototype and screenshots in its assigned branch, worktree and artifact paths. Both roles keep their existing read access and configuration, logbook, spawn and message restrictions.

The chief follows designer → PE → owner’s design approval → build. It records existing prototype files in the task’s pages folder and saves each complete report. Report text alone creates a report file, not a prototype.

The trusted start and stop hooks retain the matching direct child’s exact report, with an optional SHA. Retention grants no verdict or design approval. Preserve `blocked`, `question` and PE `CHANGE` outcomes.

Ordinary open design gates do not generally prevent merge in code. The chief must obtain the owner’s actual design approval before dependent implementation. Missing-review and program-wait checks remain unchanged.

Generated-package tests use labelled synthetic artifacts and hook events. Installed acceptance still needs the reviewed package, updated hook trust, both role texts, actual child runs, permission refusals, report retention and the saved prototype.

A pilot on stock Codex ran a lead and its team with a test model; a lead's first run on a real task is still to come. An arena runs in Codex from [the arena steps](../../packages/sage-codex/skills/sage/references/arena.md); a synthetic test plays it, and its first real run is the installed pilot. See the [design procedure](../../packages/sage-codex/skills/sage/references/workflow.md#design-before-build).

## Task adoption

Task adoption works only between two separate logbooks. In a [shared logbook](using-sage.md#shared-logbooks), `task_adopt` refuses and changes nothing, because the other provider's tasks are in that logbook already. There, a chief takes a task of another chief only through your answer to a takeover gate: the chief calls `gate_replace`, or `accept` for an offer to it.

With separate logbooks, ask the chief to take over an existing task and its PR when you change providers. Use the normal Codex app or CLI with the Sage plugin. The chief frames a destination task, then calls `task_adopt` before it starts new work.

Example tool arguments, with sample paths and task numbers:

```json
{
  "project": "/path/to/project",
  "task": "T42",
  "source-logbook": "/path/to/source-provider/sage/project-key",
  "source-provider": "claude",
  "source-task": "T536",
  "pr": "362",
  "branch": "sage/t536-existing-work"
}
```

The shared state CLI also accepts this command. Replace each sample path and identity before use:

```sh
node <installed-sage-script> task-adopt T42 --project /path/to/project --source-logbook /path/to/source-provider/sage/project-key --source-provider claude --source-task T536 --pr 362 --branch sage/t536-existing-work
```

| Rule | Result |
| --- | --- |
| The source belongs to the same project, in another provider root | Sage reads it without a lock or a write. A busy or changed source refuses adoption. |
| The PR and branch match the source task | Sage checks the live PR head with the existing read-only PR helper. The branch must name the original task. An empty source branch field is allowed. |
| The destination is framed or briefed, with no findings or verdicts | Sage records the original provider label, task number, logbook path, project, PR, branch, round count and source-task digest. Only ended blocked or failed runs may already exist; they never count as clean proof. |
| Another task claims the PR or branch by a record: its PR history, its recorded branch or a run on that branch | Sage refuses adoption. Shared source work needs an explicit task mapping from the owner first. A branch name that only looks like another task's number is no claim, because provider task numbers overlap. |
| The source spent repair rounds | The destination retains at least that count. Adoption grants no extra repair allowance. Four spent rounds still need the owner's decision before another repair. |
| The source required reviews or had risk flags | The destination keeps those requirements and the source's configured cycle minimum. Merge checks require the larger of that saved minimum and the current destination requirement. |
| The source had clean verdicts | They stay in the source. Fresh destination runs must supply every required verdict on the final SHA. |
| The same adoption is retried | Sage returns the existing record without changing the current task state, round count, saved cycle minimum or proof. A different identity refuses. |

The adopted PR and branch stay bound to the destination task. Normal task state changes, runs, reviews and merge checks then use that branch.

An unrelated destination task with the same number owns an adopted branch only by a record, so the merge check does not ask for it on the PR. Ordinary tasks keep their existing branch-name rules.

The source provider name is a label supplied by the chief; the logbook path and project identify the actual source. This command does not install a plugin, change a PR, merge code, or copy source findings and verdicts.

## The brief check

In Codex, a hook cannot read a spawn message: with a real model, Codex sends it encrypted. So the chief checks each brief with a tool before the spawn, and the hooks read what the tool keeps.

1. Before each spawn, the chief calls `brief` with the task name (for example `sage_implementer_t12_r40`: the role, the task and the run id) and the whole brief. The tool names each missing field of `GOAL` to `STANDING`, by the same field list as Claude Code. It keeps the brief in the logbook (`briefs/<task name>.json`).
2. The chief fixes the missing fields and calls `brief` again, until the tool says `checked: all 10 fields`. Then it spawns the agent.
3. When the agent starts (`SubagentStart`), the hook gives it a note: the project's standing orders, the `FORBIDDEN` field of its checked brief, and the brief. With no checked brief on record, the note says `sage: no checked brief for this task.`
4. After the spawn (`PostToolUse`), when no checked brief is on record for that task name, the chief gets one warning that names the missing fields and says to run the brief check. In sage mode the gate refuses such a spawn first, so the warning comes only outside sage mode.

The gate holds the check before the spawn (T950). The spawn message is encrypted, but its task name is plain text:

- A spawn whose task name starts with `sage_` starts only when `brief` checked that exact task name, with its run id, in the last 30 minutes. This holds for the chief's spawn in sage mode, and for a lead's spawn in every mode. Otherwise the gate refuses it with one line that says to run `brief`, then spawn again.
- The chief's spawn of a lead (`sage_lead_t<n>_r<k>`) starts only while that lead run runs and its task can move. Otherwise the gate refuses it with one line that says to add the lead run with `run_add`.
- A spawn whose task name does not start with `sage_` is not sage's, and the gate does not judge it.

The check counts for 30 minutes, not for one spawn, because Codex can refuse a spawn after the gate (its thread limit), and the steps then spawn again with the same task name. The check is in the brief's record in the logbook. A record that an agent forges, for example from a script, is a documented limit (standing order 70): the gate refuses a plain shell write into the logbook, and the sandbox and the reviews guard the rest.

No hook changes the spawn message. The hooks find the record by the folder that Codex runs in, so start Codex in the project folder.

## The rules in Codex

The hook `hooks/gate-hook.mjs` holds these rules. Codex runs it before each shell command, each `apply_patch` edit, each `spawn_agent` and `resume_agent`, each message to another thread (`send_input`, and `send_message` and `followup_task` in any namespace), and each call of a sage logbook tool (`PreToolUse`), and before it shows an approval prompt for a shell command (`PermissionRequest`).

In code mode, the model writes JavaScript for Codex's `exec` tool, and the code calls the other tools, for example `tools.exec_command({ cmd: "git push origin sage/t1" })`. Codex runs no hook for the `exec` call itself, but it runs the hook for each tool call inside the code, with the same name and input as a direct call: a shell command comes as `Bash` with its command, and an edit as `apply_patch`. So each rule below also holds inside code mode: this comes from Codex's source (0.164.0), and step 3 of the [gate check](#check-that-the-sage-gate-runs) checks it in a real session.

| Rule | When | What you see |
| --- | --- | --- |
| A merge runs only through sage's merge command, in its one exact form, from the main thread, with autopilot on and a passing merge check for that head commit ([Autopilot in Codex](#autopilot-in-codex)) | Every mode, every thread | Codex blocks `gh pr merge` and any other form of the merge command, and the chief gets one line with the reason. An admitted merge runs with no approval prompt for its escalation; Codex can still ask once for network access to `api.github.com`. With autopilot off, the chief prepares the PR link, exact head and evidence for you to merge in GitHub |
| A push takes the one push form of Claude Code: `git push [-u] <remote> <branch>`, to a remote of the checkout with any name, with the literal name of the task's branch, never a force-push, never to the default branch (main, master, or the branch that GitHub names; when that read fails, it refuses), and never from a checkout on the default branch. Each push that the hook reads, also inside another command, takes this form, and other commands beside it run; `git subtree push`, `gh repo sync` and `gh repo edit --default-branch` are refused too. A git setting that redirects a push, a git alias and a GitHub API write are limits below (T909) | sage mode, every thread | Codex blocks any other push, with one line that gives the reason and the form |
| The chief changes no files | sage mode, the main thread | Codex blocks the chief's `apply_patch` edit and its shell commands that write a file (core's write forms, as for a reviewer, also Codex's own `apply_patch` program), with one line, as the Claude hook does. A redirection, or a gh clone or download, into the temp folder, outside the project, runs, and so do git, gh, the sage tools and reads; `tee`, `cp` and the other forms are refused also there. The chief briefs an implementer, and agents edit as before |
| A reviewer or QA changes no files | sage mode, a role agent whose task name names that role, and every agent under it; also Codex's own review thread and approval check | Codex blocks its `apply_patch` edit and its shell commands that write a file (also Codex's own `apply_patch` program) or change the checkout with git (`git checkout`, `reset`, `commit`, `branch -D` and the like), with one line: the agent reports a finding instead. It still reads files and runs the checks. A redirection into the temp folder, outside the project, runs, and so does git in a worktree there (`git worktree add --detach /tmp/<run>/head <sha>`), as in Claude Code (T936). The same rule holds the PE and the lead: a lead starts an implementer of its task to make a change |
| A name that starts with `sage_` but is not a sage task name counts as a read-only role | sage mode | Codex blocks its edits and shell writes, with one line that names the task name form |
| Only a lead has sage agents under it | sage mode, an agent with a sage name above it that is not a lead's (a bad chain of agent names) | Codex blocks its edits and shell writes, with one line that names the agent above it. Under a good chain, the last sage name decides: an implementer under a lead edits, and a reviewer or QA under a lead does not |
| The chief and a lead record the logbook | Every mode, every agent that is not the chief, also Codex's own review thread and approval check. The exception is a lead, which records its own task with the sage tools | Codex blocks the agent's call of a logbook tool that writes, also `gate_answer` and `brief`, and its shell run of the state tool's write commands or of the `sage` MCP server, with one line: the agent puts it in its report. The read commands (`status`, `merge-check`, `standing` without `add`, `logbook` without `repair`, and `pages` without `record`) run, and so does a `node` script that only has the tool's path as data (`node scripts/lint.mjs <tool>`). The hook tells the chief from the other threads by Codex's record of the thread: Codex's review thread runs in the chief's session and has no agent id, but its record names a review source |
| A role agent starts no agents | Every mode, a role agent whose task name starts with `sage_`, every agent under it, and Codex's own review thread and approval check | Codex blocks its `spawn_agent` and its `resume_agent` (multi-agent v1), with one line. An agent whose record the hook cannot read is blocked too. The exception is a lead (`sage_lead_t<n>_r<k>`, with only leads above it): it starts `sage_<role>_t<n>_r<k>` for its own task number, where the role is implementer, code_reviewer, security_reviewer, ux_reviewer or qa. A lead restarts no agent: its refusal of `resume_agent` says to start a new agent on a new run |
| A sage agent starts only with its checked brief, and a lead only on its running lead run (T950) | The chief's spawn in sage mode; a lead's spawn in every mode. Only a task name that starts with `sage_` | Codex blocks the spawn when `brief` did not check that exact task name in the last 30 minutes, and the chief's spawn of a lead whose lead run does not run, with one line that names `brief` or `run_add` ([The brief check](#the-brief-check)) |
| No agent runs Codex from the shell | Every mode, every thread, also the main thread | Codex blocks every run of Codex except `codex --version`, `codex -V`, `codex --help` and `codex -h`, by its name (`codex`, `codex.js` as `node`'s script, or `@openai/codex` from `npx`), with one line: a new session runs outside the hooks of this session, and Codex records the prompt of `codex resume`, `codex fork` or `codex queue` as your typed message, also `autopilot on`. The other programs of Codex's package (for example the `rg` that Codex puts first on the shell's PATH) run. A command that the hook cannot read and that names codex is blocked when it names `resume`, `fork` or `queue` |
| No thread sends a message to the session's main thread | Every mode, every thread, also the chief | Codex blocks `send_message` and `followup_task` when their `target` is the main thread, and `send_input` when its `target` or `id` is: the session's id in any spelling that Codex reads (any letter case, with or without hyphens, braces or `urn:uuid:`), or the path `/root`. A `send_message` or `followup_task` with no text target is blocked too. Codex counts such a message as your own typed message, so `autopilot on` in it would turn autopilot on. Only the target counts, not the message text |
| No thread uses multi-agent v1's `send_input` | sage mode, every thread, also the chief | Codex blocks it, with one line: sage sends with multi-agent v2 |
| In sage mode, an agent runs only the gh commands of an agent, as in Claude Code | sage mode, every agent (not the chief) | An agent runs only `gh pr` (`create`, `view`, `comment`, `edit`, `checks`, `diff`, `list`, `status`), `gh issue` (`view`, `list`), `gh run` (`view`, `list`, `watch`), `gh repo view`, and `gh api` with GET (core's one list, T909). Codex blocks any other gh command of an agent, with one line that names it. The chief's gh meets the merge and push rules only. The rule reads gh's own words: gh from a variable, behind a wrapper that the hook does not know, an alias, an extension and a setting before gh are limits below |
| An agent runs no `git stash` and lists or signals no real process, as in Claude Code | Every mode, a role agent whose task name starts with `sage_`, every agent under it, and Codex's own review thread and approval check; in sage mode, every agent. Never the chief | Codex blocks `git stash` in any form, and `ps`, `pgrep`, `kill`, `pkill`, `killall`, `lsof`, `launchctl` and the other process programs, with one line: every worktree of a repo shares one stash list, and a process program can stop your own programs. A process program runs only as a fake in the temp folder, by its path or first on PATH (core's one rule, T931) |
| No one sets the board password or reads the board config, as in Claude Code | Every mode, every thread, also the chief | Codex blocks `--set-password` and a shell command or a patch that names `~/.config/sage-board` or its `board.json`, or that searches, copies or moves a folder above it (`grep -r`, `cp -R`), with one line. Only the board command names its config, after `--config` (core's one rule, T229, T931) |
| A role agent sends no message to another thread | Every mode, a role agent whose task name starts with `sage_`, every agent under it, and Codex's own review thread and approval check | Codex blocks its `send_input` (multi-agent v1), and its `send_message` and `followup_task` (multi-agent v2, in any namespace: the default `collaboration` or another `features.multi_agent_v2.tool_namespace` in your Codex config), with one line: a message to the chief's thread would start a turn as if you typed it, and a reviewer's message to the implementer could make the change that the reviewer may not make. A lead gets its own line: to steer its team, it starts a new agent on a new run. The chief, and an agent without a `sage_` name, send to other threads as usual, but never to the main thread (the row above) |
| sage works only while its gate runs | Every mode, every thread | For each sage logbook call that it lets through, the hook saves a proof by the call's id. The sage logbook server serves no call without that proof, and the chief gets one line that starts with "sage's gate is not running" and names the `hooks install` command. So when Codex runs no sage hook, for example before you install or trust sage's hooks, sage records nothing |
| No one writes Codex's config file, its hooks file, sage's launcher or the sage plugin's folder from the shell | Every mode, every thread | Codex blocks the shell write that names `config.toml` or `hooks.json` in the Codex home, the `sage-hooks` folder there, or the installed sage plugin's folder, by a literal path, also from `~`, with one line. sage's entries and their trust records are in those files. A read runs |
| A `js` call of the desktop app's REPL (`node_repl`, `cua_repl`) is allowed | Every mode, every thread | No sage rule applies: the call runs, so the chief keeps its browser previews. See the limits below |
| No one changes files under a `.codex` folder of the project | Every mode, every thread | Codex blocks the `apply_patch` edit, or the shell write that names the folder. Codex reads project settings from that folder, so you make such changes yourself. Only the path from the project folder down counts, so a project under `~/.codex/worktrees` edits as usual |
| No shell command or patch writes into the Codex sage folder or the shared root, and no shell command removes or moves a folder that holds one | Every mode, every thread | Codex blocks the command or the patch, with one line that names the word or the path; the logbook tools change the logbook (the sage folder holds the logbook and the mode files, and the shared root the shared logbooks). The hook reads a command as Claude Code does (core's `logbookWrite`, T903, T909): the literal path of a written word as written, not through a link, after a `cd` and from `~`, `rm`, `mv` or `rsync --delete` of a folder above a root (`rm -rf ~/..`), and `chmod`, `chown`, `chgrp` or `chflags` with `-R` that names a root or a path in one (`chmod -R 000 ~/.codex/sage`). A read runs, and so do `rm` of a link to a root, a `find -delete` or `chmod -R` that names no root and no path in one (`chmod -R u+w ~`), and a logbook file's name in another folder (`../tasks.tsv`) |
| One shell command that writes a file and runs tests | Allowed | In the desktop app, Codex refuses a single shell command that both writes a file and runs tests (a documented limit). Agents write with the patch tool and run the tests in a separate command |

The agent's gh list does not authorize a merge: the separate merge rule refuses `gh pr merge` in every mode and thread.

For every other approval, the hook does not decide, so Codex shows its own prompt. When the hook cannot read a tool call, it blocks the call and says so in one line. When it cannot read an approval request, Codex shows its own prompt.

If an agent says that the hook could not read Codex's record of its thread, start a new session in the project folder. If it happens again, report it with your Codex version.

The hook reads sage mode from the mode file of the session (in `SAGE_HOME`, or `CODEX_HOME/sage`, under `.hooks/codex/`), with the same reader as the mode hook: a damaged file is off. Autopilot counts only when the mode file and your own typed messages in Codex's record of the session both turn it on, so an agent that writes a mode file unlocks no merge.

Startup and resume turn autopilot off before the chief starts; a failed reset gives a warning line. A merge does not depend on that reset: after each start, autopilot needs your on phrase again. The merge check needs `gh`, logged in, and the logbook's verdicts for the exact head commit, as in Claude Code.

Limits:

- The hooks guard ordinary commands against honest mistakes (standing order 70, T909): the hook reads a shell command's programs and the literal paths in their words, as the shell reads them, so `~` and a path from the command's folder count (T903, as in Claude Code). A path from a variable (`$HOME`, `$CODEX_HOME`, `$SAGE_HOME`), a pattern after its literal part, a quote inside a name, a path through a link and a script are documented limits. Codex's own sandbox keeps `.codex` and the Codex home read-only in the workspace-write mode.
- An agent's fake process program (`ps`, `kill`, `pgrep`, `launchctl`) passes only from a folder under the temp folder: `/tmp`, or the folder that `TMPDIR` names. A fake in any other folder is refused, as in Claude Code (T931). So a QA harness keeps its fake `gh` outside `/tmp` (standing order 57), because the merge check takes the sandbox's folders off `PATH`, and it keeps its fake process programs in the temp folder.
- In sage mode, an agent's gh from a variable, behind a wrapper that the hook does not know, or by an alias or an extension, and a setting that makes gh run another program (a pager, an editor, a browser) or read another config folder, are not blocked. A merge or a branch write through GitHub's API (`gh api`, `curl`) is not blocked either: GitHub's protection of main is the guard.
- A git setting that redirects a push (`remote.<remote>.push`, `url.<base>.insteadOf`, `push.default` upstream), a git alias, a git hook and a write under a `.git` folder are not blocked. A patch into a `.git` folder still meets the patch's checkout rule.
- An agent can still run Codex in these forms, which the hook does not read:
  - text or a script piped into a shell or an interpreter (`echo codex exec hi | sh`, `| bash -s`, `| node -`);
  - a copy of codex or a link to it by another name (`cp <codex> c && ./c exec hi`), or a program from a variable or a substitution;
  - a script file that names codex inside it, or text that hides the word codex (for example in base64).
- An agent can still run the state tool's write commands from `node -e` code, from standard input (`node -`, or the tool piped into `node`), after a `node` option with a value (`node --stack-size 4000 <tool>`), as a module to load first (`--import`, `-r`), or from a copied script; any `node` script that loads sage's core can write the logbook too. The hook blocks the tool only as `node`'s first plain word, or when it runs as a program.
- For these forms, Codex's sandbox is the stop. In workspace-write, network access is off for the session, so a new Codex session cannot reach its model, and the Codex home and the logbook are read-only. Keep network access off, and keep the workspace-write mode.
- The send rules read the multi-agent v2 tools in any namespace, by the end of their name (`send_message`, `followup_task`). So another tool whose name ends so, other than an MCP tool, gets the same rules: no message to the main thread, and none from a role agent. sage's own dispatch uses `collaboration`, so with another namespace in your Codex config it does not work.
- In `codex exec --ephemeral`, Codex's review thread has no record, and its hook events carry no field that tells it from the main thread, so the hook reads it as the chief.
- The merge command pins the reviewed head commit (`--match-head-commit`), and the merge check reads the verdicts of that commit. When you merge in GitHub, check that the PR head still matches the reviewed head: a new head needs fresh CI and cycles.
- A reviewer's or QA's shell write is blocked only in the plain write forms that the hook reads: a redirection, `tee`, `cp`, `mv`, `rm`, `sed -i`, a short `node -e` or `bash -c` text, and git that changes the checkout (T936). A write through a script file that `node` or `python` runs, or `make`, is not blocked, and the review checks the branch.
- A reviewer's git command in a worktree in the temp folder runs, and that worktree shares the project's branches and settings. The reviewer's brief and role text tell it to change no files.
- A reviewer's commit through these forms can also be pushed to the task's branch. Read the branch's commits before a merge, or keep autopilot off for such a task.
- The chief's shell write is blocked only in the plain write forms, without the git forms of a reviewer: the chief's git runs (T960). A write through a script file, a variable or a wrapper that the hook does not know is not blocked (standing order 70). The chief's text tells it to brief an implementer.
- gh's own words are not programs, so `gh api -X PATCH` writes no file. These gh commands write files, so they count as write forms, for the chief and for a reviewer (F-T948-1, F-T948-5):
  - `gh repo clone` and `gh gist clone` write the folder that they name, or a folder named after the repository, and so do `gh repo fork --clone` and `gh repo create --clone` (T936). `gh run download` and `gh release download` write into the folder of `-D`, the file of `-O`, or the command's folder, also after gh's `-R <repo>`; `gh attestation download` writes into the command's folder.
  - `gh codespace cp` writes a local destination. Into the temp folder, outside the project, these commands run, as a redirection does.
  - `gh extension install`, `upgrade`, `remove` and `create` change gh's extensions or make a folder, so they count in every folder.
  - `gh pr checkout` runs. It changes the work tree as `git checkout` does, and git's commands run for the chief, because it makes worktrees and branches with them.
- In sage mode, a push goes only to a remote whose URL names `github.com` (or `ssh.github.com`), in the https, ssh or `user@host:owner/name` form, because the hook asks GitHub for the default branch. A remote that uses an ssh host alias from `~/.ssh/config` (such as `github-work:owner/name`) is refused: give the remote its github.com URL. A push also needs `gh` logged in.
- Codex 0.164.0 runs no hook for text that an agent types into a shell that still runs (`write_stdin`, for example after `zsh -i`). That text passes every sage rule, also a push or a merge. Autopilot off does not stop such a merge.
- In workspace-write, the sandbox keeps this text off the network and keeps the logbook and the sessions folder closed. Keep network access off for the session (`[sandbox_workspace_write] network_access = false`, the default). When Codex asks to run an interactive shell (for example `zsh -i`) outside the sandbox, refuse.
- Codex runs a sage hook only when your trust record matches its entry. When the record does not match, for example after you edit an entry or `hooks install` changes one, Codex runs the tool call with no hook and no warning; the proof check then refuses every sage logbook tool, so sage does no work until you trust the hooks again. When a hook fails or times out, Codex runs the tool call too, and it shows a Failed line for the hook.
- When sage's hooks do not load, or give no answer in four fifths of their timeout, the launcher refuses a shell merge or push itself, and lets every other call run. When a hook blocks the launcher's process (a call that waits with no timeout of its own), the launcher cannot answer either, and Codex runs the call.
- An update of sage runs with no new review: Codex trusts the entries, and the launcher runs the code of the version that Codex uses. This is the same as in Claude Code, by the owner's choice (T957).
- sage finds its entries in your hooks file by their command text. An entry that you or another tool writes with the same text counts as sage's: `hooks install` replaces it, and `hooks uninstall` removes it. sage does not guard against such an entry.
- When the installed sage cannot load its hooks (a broken install, or a newest version folder with no `hooks/dispatch.mjs`, such as an empty one), the launcher refuses only a shell command whose text names a merge or a push (also a `gh api` merge or ref write), and lets every other call run, so that a new install can repair it. It does not run an older version's hooks in place of the version that Codex uses.
- A `js` call or a command that runs outside the sandbox can still change Codex's config file or the sage plugin's folder, and so turn the gate off. The proof check then finds it at the next sage logbook call. Do the [gate check](#check-that-the-sage-gate-runs) when a sage rule seems not to run.
- In sage mode, every tool other than sage's own runs with no sage rule, by your choice: app tools, MCP tools of other servers, and dynamic tools. For example, the Sites publish tool publishes a page with no sage check. The rules above cover only shell commands, `apply_patch`, agent starts, messages to other threads and the sage logbook tools.
- A `js` call of the desktop app's REPL can run shell commands that no sage hook sees; sage mode allows it so the chief keeps its browser previews. The REPL runs the code in its own Node process, so a push, a merge or a file change in that code passes every sage rule. The `exec` tool of code mode is different: each tool call inside its code reaches the sage hook.
- Under full access (`danger-full-access`), sage mode gives no guarantee: an agent can write any file, also the mode files, the logbook and Codex's record of your messages.
- sage on Codex needs a multi-agent v2 model for the chief and each child. On a v1 model, sage cannot name a child or keep its report, so no review reaches a merge, and a lead cannot start helpers.
  - On a v1 session, the chief starts no agents and tells you to start a new session on a v2 model. Codex's model catalog sets the version at a thread's first turn.
  - In Codex 0.164.0's bundled catalog, the `gpt-6-sol` models are v2, and `gpt-5.6-luna` and `gpt-5.5` are not.
  - Do not switch the model during a run: a child gets the collaboration tools only when its own model is v2. A lead with no spawn tools reports it, and the chief stops and tells you the same fix.
- A child's report starts no turn in Codex. So the chief and a lead do not end their turn while a child runs: they wait with `wait_agent`.
  - If the chief stops all the same, its last line says so. Send any message, and one more if the report has not come.
- Codex v2 allows 4 threads in a session by default: the chief and 3 children. So a lead and 2 helpers fill the default, and a third helper at the same time fails with `collab spawn failed: agent thread limit reached`.
  - A finished or interrupted agent frees its thread, and the agent then tries again with the same name.
  - The state tool holds at most `max_agents` running runs for a project, in both providers, so set Codex's limit to that cap ([What you need](#what-you-need)). The start status warns while it is lower. Codex counts the threads of one session; the state tool counts the runs of the project's logbook, in all sessions.
- The reviewer's limits above hold for a lead too: its shell write is blocked only in the plain forms. A lead sends the branch and opens the pull request from the shell, under the same push and `gh` rules as the chief, and it never merges. It starts no lead, PE, designer or arena judge.
- A lead records every finding of a helper's report. In Claude and in Codex, the state tool refuses the lead's next run of that role, its run done of that run, its state move and its round while a medium or high finding of a kept report has no row with the run (the gap rule), and it refuses a review or QA verdict that such a report backs.
- The chief's own `resume_agent` is not blocked. The chief's text says to start a fresh agent.

## Inactive trigger observation

sage no longer has the inactive turn-trigger observer or its sample command. No hook or manifest ran them, so T732 removed them. The change log keeps their earlier entries, which link here.

## Known limits in Codex

These are the differences from Claude Code that stay in sage 1.0, by the owner's choice. Each row gives the limit, what you see and what to do, and [Why each limit stays](#why-each-limit-stays) gives the reasons. The security limits of the hooks are in [The rules in Codex](#the-rules-in-codex).

| Limit | What you see | What to do |
| --- | --- | --- |
| **One model for all agents** | Every agent runs on the session's model. Only its reasoning effort changes with its role and size ([Model keys in Codex](#model-keys-in-codex)). | Choose a multi-agent v2 model for the session. Do not change it during a run. |

### Why each limit stays

- **One model for all agents:** the model keys hold Claude's model names, and sage never gives a Claude name to Codex. Codex's model list changes with each release, so sage gives no Codex model name either. A spawn that names no model keeps the session's v2 model, so the v2 rule cannot break.
