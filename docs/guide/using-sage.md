# Using sage

This page is the user guide to sage mode in Claude Code. It gives the rules behind the README's [quick start](../../README.md#quick-start) and [What to say](../../README.md#what-to-say): every phrase, when the chief asks you, how to update, stop and uninstall sage, and what to do when something goes wrong.

In sage's words, the **chief** is the main session in sage mode: your chief of staff. The [Concepts](concepts.md) page gives every word.

## Every phrase

Send each phrase as a message of its own. Sage mode and autopilot switch only on the exact phrase as the whole message (the rules are below):

| Send this, alone | What happens |
| --- | --- |
| `sage mode` or `sage mode on` | The session becomes your chief of staff. Send your request in the next message. |
| `sage mode off` | A normal session again, for the rest of the session. Autopilot goes off too. |
| `autopilot on` | While sage mode is on: verified pull requests merge by themselves after their clean cycles. |
| `autopilot off` | Verified pull requests wait for you again. |
| `sage help` | A list of every phrase, and whether sage mode and autopilot are on now. It switches nothing. |

The board and status phrases work at the start of your message. [Ask for the board](board.md#ask-for-the-board) gives their rules:

| Send this | What you see |
| --- | --- |
| `show board` or `sage board` | The board of this project in the chat, and the address of the board page. |
| `show board for all` or `sage board for all projects` | The board of every project. |
| `show board for <project>` or `sage board for <project>` | The board of one project. |
| `show board <task id>`, `sage board <task id>` or `board <task id>` | One task in full, for example `show board T1`. |
| `show status` or `sage status` | The task states, the agents and what needs you, and the open tasks with no priority. |

These words work inside a request. They switch nothing:

| Put this in your request | What happens |
| --- | --- |
| `arena` or `arena <n>`, for example `arena 4` | The chief runs an [arena](how-it-works.md#the-arena) for the design: 3 candidates by default, or the number that you give, and a judge that combines them. |

<a href="../assets/tip-start-light.svg">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../assets/tip-start-dark.svg">
  <img alt="The toad sage's tip: to switch sage mode on, send the words sage mode alone, with no quote marks. To switch it off, send the words sage mode off alone. With any other words, the message switches nothing." src="../assets/tip-start-light.svg" width="100%">
</picture>
</a>

"sage help" also tells you the rules below.

### The exact phrase

A switch needs the exact phrase as the whole message. The hook reads your message in this way:

- It removes the spaces and line breaks at the ends.
- It ignores the letter case.
- It allows one full stop at the end.
- Nothing else counts: no other words, no question mark, no quote mark or bullet, no look-alike letter and no hidden character.

So "sage mode. Fix the crash" switches nothing. Send "sage mode" first, then the request.

Autopilot turns on only while sage mode is on. "sage mode off" also turns autopilot off.

When autopilot turns on, sage reads once per session (with `gh`, read only) whether the default branch of the repository requires a pull request, through a ruleset or a branch protection rule. If not, the confirmation adds one warning line with the steps to turn it on. Autopilot still runs, and a failed read says "could not check".

### A message near a phrase

A message near a phrase switches nothing. Instead, the hook gives the chief a note with the exact phrase to ask you for. The chief tells you only when your message was not a question.

| Your message | The note to the chief |
| --- | --- |
| It starts with sage mode or autopilot, for example "sage mode. Fix the crash". | A firm note. |
| It names sage mode or autopilot with an on or off word (such as on, off, stop or pause) in a sentence. | A softer note. |
| It names sage mode or autopilot without such a word. | No note, so you can talk about the modes freely. |
| It is a phrase that changes nothing, for example "sage mode off" when sage mode is already off. | No note. |

### Only your own text counts

Claude Code does not tell the hook who wrote a prompt. So the hook reads the frames that Claude Code puts around text that you did not type:

- an agent's report;
- a task notification;
- a message from another session;
- a system reminder.

Text inside a frame never turns a mode on, also when it is exactly a phrase. Only a queued message can turn autopilot off (see the next section). When Claude Code joins your message to frames, the hook reads the prompt in this way:

- Your text before the first frame and after the last frame is your message.
- Text between two frames counts as agent text, because an agent can close its frames early and open new ones.
- When the hook cannot read the frames, for example a frame that does not close, nothing in the prompt switches.

### A message that you send while Claude works

A message that you send while Claude works waits in a queue. It counts as a message of its own only when it is a whole system reminder after the last other frame. An agent can write the same shape, and the hook cannot tell the two apart, so such a message can only turn autopilot off:

| The queued message | What happens |
| --- | --- |
| "autopilot off" | Autopilot goes off, as when you send it alone. |
| "sage mode off" | Autopilot goes off, but sage mode stays on, because sage mode off drops the hook's guards. Send it again when Claude is idle. |
| An on phrase | Nothing switches. Send it again when Claude is idle. |

A queued message before another frame switches nothing. When such a message, or a prompt with frames that the hook cannot read, has a phrase, the chief asks you to send the phrase again as a message alone.

## When the chief asks you

The chief interrupts you at most once per task. It puts all the product questions of the task in that one batch, and each part comes with a recommendation and a default. A product question is one whose answer you would notice: what you see, which data is kept, who can do what.

Four exceptions can interrupt you again:

- An irreversible action always gets its own yes.
- A new fact that changes an earlier answer can bring the question back.
- A large task's design gets your approval after the PE check.
- An escalation: the work finds something that the chief cannot decide alone. For example:
  - The task is held or needs a new plan.
  - An agent stops at a new product question.
  - A finding needs a decision.
  - The arena candidates do not converge.

Engineering choices, such as file formats and names, are the chief's. It decides them and logs them.

You answer in your own words, or pick an option. When you do not answer, the work behind the question waits; the rest goes on.

## The lead and the models

Each task with a build gets one lead. The chief records a lead run and starts the lead in the background with the name `lead-T<n>` (in the desktop app, the first word of its description). An investigation has no pull request, so the chief runs it without a lead.

The lead does these things:

- It runs the build, the cycles and the repair rounds, with at most 9 helpers at once. It does not end while a helper runs: the hook blocks its stop, and its wait command waits for the helper with Bash alone.
- It records each finding of its helpers.
- It leaves the task at verifying and gives the chief one report. So the chat shows a few lines for each pull request, not every report.

The lead and each helper take a slot of the project's agent cap (`max_agents`, 10 by default), and all agents together take slots of the total cap (`cap_total`, 20 by default). One lead with its 9 helpers fills the default cap of a project.

At most 5 leads run for a project by default. To change this, ask the chief in the chat, and it runs `sage config max_leads=<n>` with a whole number from 1. A value below the running count ends no lead: it only refuses the next lead.

A lead runs up to 9 helpers, but never more than the project's cap allows: with a lower cap, or a second lead in the project, it runs fewer. The chief starts a second lead only when the cap has room for it and its helpers.

A tiny task has no review and no QA in its route, so its lead runs only the implementer. A task with no review or QA in its route has no cycle: it needs only checks-pass. A risk flag, an arena or an added review puts a review in the route, and then the task needs its clean cycles like any other task.

| A finding of a helper | What the lead does |
| --- | --- |
| Medium or high | It sends the finding to a repair round. |
| Low | It dismisses the finding with a reason, adds it to a round, or gives it to the chief to move to a follow-up task. |

The lead ends blocked when it cannot clear a finding itself:

- a low finding with no round;
- a new finding from a round's re-check;
- a low fix that the re-check does not confirm, with no medium or high finding open.

Another fix that the re-check does not confirm needs no chief: the lead runs `round` from repairing. That gives the next round, a replan when the round fixed none of its keys, or the hold after the last round.

The lead also ends blocked in any state that its file does not name. The chief then reads the logbook and decides. It makes only these two state moves there:

- repairing to reviewing: a fix key that stays open after a blocked report gets the next round, or a replan;
- reviewing to verifying: the checks passed.

The chief may also move a low or new finding to a follow-up task. Then it starts a fresh lead, which goes on from the logbook.

The chief keeps what only it does: your questions, the checks verdict after `gh pr checks`, the move to verified, the follow-up tasks, and the merge.

Every review or QA verdict, of the lead or of the chief, comes from the report that the hook kept when the helper stopped. The state tool refuses a verdict that no kept report backs, in any form of the command. A report with a medium or high finding gives a clean verdict only after the chief recorded each of those findings and dismissed, moved or closed it.

sage uses balanced model defaults:

- Sonnet does the UX review, the implementation of a tiny task, and the QA of a small task.
- Opus does the other configurable roles and sizes.

When the chief adds a code review or QA to a tiny task, Sonnet does it too. An optional `model.<role>.risk` setting overrides the size choice when the task has a risk flag.

## Waits and programs

> **Warning:** before you use waits or programs, update sage (see [To update sage](#to-update-sage)) and restart every session that was already open. An older session still merges a waiting task, or a task of a program that you did not approve.

**A task can wait for other tasks.** Ask the chief, for example "T8 waits for T7".

The task builds and merges only after each task that it waits for is merged or concluded. Its design and PE check can run meanwhile.

A wait on an abandoned task is never met, so the chief asks you to remove or change it.

**Two tasks can share one pull request**, for example a fix that closes both. The chief gives both tasks the same branch and pull request. Autopilot merges it only when each task passes its own reviews and QA on the head commit.

### Programs

A program is one request that sage runs as several tasks for one goal, with one pilot task. You approve its breakdown before any task of it builds.

- The chief frames every task first. Then it asks you one question: the goal, the pilot, and each task with what it waits for.
- You answer approve, change or drop. To say what to change, answer in your own words.
- No task of the program builds before you approve.
- The pilot runs end to end and merges first. Each other task builds and merges only after the pilot.
- After change, the chief proposes again and tells you what changed. After drop, it takes each task out of the program.

The board shows each program on its Programs tab: see [Programs on the board](board.md#programs-on-the-board). The full rules are in [Rules held in code](../design/rules-in-code.md#waits-and-programs).

## Start every session in sage mode

To make every session in a folder start in sage mode, put this in the folder's `.claude/settings.json`:

```json
{ "agent": "sage:chief-of-staff" }
```

In such a session, `sage mode off` gives a normal session for the rest of the session, as in any other session: the file tools work again. A new session, or `/clear`, in that folder starts in sage mode again. To start sessions in that folder without sage mode, remove the line.

## To update sage

Run this command in a terminal:

```sh
claude plugin update sage@sage
```

The update applies to every running session at its next event: each hook event runs the newest installed sage. This holds for sessions that started on this version of sage or a later one.

A new hook event or matcher needs a restart, and so do the instructions that a session already read (its skills and agent texts). When you are not sure, start a new session.

## Stop a running task

- **To stop one task or agent**, tell the chief in your own words, for example "stop the run on T3". There is no fixed phrase. The chief stops the agent, and the agent's slot frees when it ends.
- **To stop merges now**, send `autopilot off` alone. Pull requests then wait for you.
- **To stop the chief's current turn**, press Esc in Claude Code, as in any session.
- **To leave sage mode**, send `sage mode off` alone. Ask the chief to stop the running agents first, if you want them to stop too.

Nothing reaches main without a pull request, so a stopped task leaves at most a branch and an open pull request. Close or delete them on GitHub when you do not want them.

## Uninstall sage

1. If you sent the board phrase (`show board`) on the Mac, or started the board server, a server may still run after the chat. Stop it first, in a terminal, before you delete the plugin cache. To find the installed version, use the "Version:" line under `sage@sage` in the output of this command:

   ```sh
   claude plugin list
   ```

   Replace `<version>` with that value, then run the command:

   ```sh
   v=<version> && node ~/.claude/plugins/cache/sage/sage/$v/board/cli.mjs board --stop
   ```

   When the command fails with "Cannot find module", the version is wrong. List the folders with `ls ~/.claude/plugins/cache/sage/sage/`, and use the one that matches the "Version:" line. If you already uninstalled sage, `claude plugin list` shows no version: use a folder from that list.

   If you already deleted the plugin cache, reinstall sage with both commands of the [Quick start](../../README.md#quick-start) (`claude plugin marketplace add erickb336/sage`, then `claude plugin install sage@sage`), do this step, then uninstall again. Ctrl+C and `launchctl` do not stop a server that the board phrase started, because it runs detached. Only a server that you installed as a login service also needs step 2.

2. If you installed the board's login service, stop it and remove its login file. The login file starts the board at each login until you remove it:

   ```sh
   launchctl bootout "gui/$(id -u)/dev.sage.board"
   ```

   ```sh
   rm ~/Library/LaunchAgents/dev.sage.board.plist
   ```

3. If the folder `~/.local/share/sage-board` exists, remove its installed copy (`service/`) and its pages folder (`pages/`). The board has no command that removes them.

   > **Warning:** this command also deletes the board's offline pages. Copy each page that you want to keep first.

   ```sh
   rm -r ~/.local/share/sage-board
   ```

4. If you set up the Remote Control server, send `/sage:remote-control server off`, then `/sage:remote-control off`.
5. If a folder starts every session in sage mode, remove the `"agent": "sage:chief-of-staff"` line from its `.claude/settings.json` (see [Start every session in sage mode](#start-every-session-in-sage-mode)).
6. Remove the plugin, in a terminal:

   ```sh
   claude plugin uninstall sage@sage
   ```

7. Remove the marketplace:

   ```sh
   claude plugin marketplace remove sage
   ```

8. Start a new session. A session that was open still has sage's instructions.

Claude Code keeps the plugin files in `~/.claude/plugins/cache/sage/` after the uninstall. It removes each version 14 days later, but only while another plugin is still installed ([plugin loading](https://code.claude.com/docs/en/plugins/loading)). To remove them at once, delete that folder, but only after step 1: the stop command is in it.

The uninstall keeps your logbooks, the task pages in each project's pages folder and the board's config; only step 3 deletes the board's offline pages. They are plain files in the folders below. Delete them yourself when you no longer want the record.

## Shared logbooks

A shared logbook is one logbook that Claude and Codex both use for a project. A project uses one when its checkout has a row in `bindings.tsv` in the shared root.

- Sage finds the logbook again at each command.
- A project gets a row by a link, by [the move](#move-an-existing-project) of an existing project, or by `init` of a new project (see the table below). An existing project that did not move has no row, and it works as before.
- Linked worktrees use the row of their main checkout.

`sage init` of a project with no logbook picks its place:

| When | `init` makes |
| --- | --- |
| Both plugins are at contract 2 in `plugins.tsv` (updated and restarted), or the other provider is recorded as unused, and neither provider root has a logbook of this repository | A shared logbook and its row. It says that the project now uses the shared logbook. |
| A plugin is below contract 2 or has no row, or a provider root has a logbook of this repository (also a clone's or a fork's, also through a link) | A legacy logbook, as before. The chief can [move the project](#move-an-existing-project) later. |
| The folder is not a Git repository, the folder is a shallow clone and the shared root has no logbook yet, the shared root cannot be written, or sage cannot read a folder of the other provider's root | A legacy logbook, as before. A shallow clone gets the prompt below when the shared root has a logbook. |
| Sage cannot read a folder of the root of the provider that runs `init` | No logbook: `init` refuses, names the folder and asks the owner to fix its rights. |
| The checkout has the first commit of a shared logbook | No logbook: it refuses with the link prompt below. |

Only the move gate records a provider as unused today. That answer counts for every project of the shared root.

The chief runs a link only after your answer in the chat:

| Command | Does |
| --- | --- |
| `sage link --separate` | Makes a new shared logbook and a row for this checkout. |
| `sage link --to <folder>` | Adds a row for this checkout to a logbook of the shared root. Use it for a second clone, or for a checkout that you moved. |

A Codex chief calls the `link` tool of the same name. A retry changes nothing.

When a command stops in a new clone, or in a folder with a wrong link, the chief asks you one choice in the chat, with its recommendation. The text of the choice comes from the state tool's refusal, so both providers ask it in the same words:

| The command stops because | Your options |
| --- | --- |
| This folder has no row, but it has the first commit of a shared logbook | Link to that project (for a second clone), or start separate (for a fork that is now its own project). The recommendation follows the GitHub remote: the same remote recommends the link, another remote (a fork) recommends separate, and no remote recommends the link. When two shared logbooks have that first commit, the one with the same remote is recommended. |
| This folder's row names another project's logbook | Start separate, or link to another project by its name |
| This folder's row names a logbook that is missing | Restore the folder from a copy, start separate, or link to another project |
| This folder is a shallow clone, and the shared root has a logbook | Fetch its full history (recommended), or start separate. A shallow clone's first commit is its newest one, so sage cannot tell which project it is a clone of. |

When sage cannot read a GitHub remote, the text names the folder that has none. A remote URL with a user name or a token in it counts as its repository; the text never shows the token. The last line of each text starts with "For the chief:": it is the command that the chief runs after your reply.

No sage command can change the answer later. After a link, the board shows one project with each linked checkout, for example `2 checkouts: lantern, lantern-b` (see [the board guide](board.md)). When two linked checkouts have the same folder name, the board numbers them, for example `lantern #2`: the link prompt and the message after the link say the number of this folder.

| Situation | Result |
| --- | --- |
| The project has a logbook in the Claude or Codex root | The link refuses, because the link would hide its tasks. Keep using that logbook, or ask the chief to [move the project](#move-an-existing-project). |
| The checkout is already linked to another logbook | The link refuses. A checkout has one logbook, so keep using that one. No command takes a linked checkout to another logbook. |
| You moved a checkout or cloned it again, so its new path has no row | Each command and `init` refuse with the link prompt: it names the logbook with the same first commit, and the command of each choice (`sage link --to <folder>`, or `sage link --separate` for another project). The old row stays and does no harm. When the first checkout of the logbook is gone, its oldest live clone owns the logbook: a foreign row cannot take it. |
| `--to` names a logbook whose owner has no first commit in common with this checkout | The link refuses. A shallow clone needs its full history first: `git fetch --unshallow`. |
| Git cannot read the first commit of a new clone (a damaged repository, or more than 5 s) | No refusal names the shared logbook, so `init` makes a legacy logbook, and a later link refuses: it would hide that logbook's tasks. Before `init`, repair the repository, then run the command again. |
| The Git call for the first commit takes more than 5 s | The link refuses and makes no row. Run the link again. A later write of a row with no commits tries again. |
| Git cannot read the repository: for example a broken config, an unknown repository extension, or a garbage HEAD or branch ref | The link refuses and makes no row, and a later write of a row with no commits tries again. Repair the repository, then run the link again. Never delete a `.git` folder: it holds the history and any unpushed work. |
| The checkout is a linked worktree whose target is gone: its `.git` is a file that points to a removed worktree | The link refuses and makes no row. Repair the worktree, or delete that `.git` file, then run the link again. |
| The shared root cannot be written, or a provider root cannot be read | The link refuses, names the path and makes no row. |
| A row names a missing logbook | Each read and write of that project refuses and offers the link. The link replaces that row. |
| A logbook has rows with no first commit in common | The owner is the oldest row with commits whose checkout is still on the disk, or the oldest row when all are gone. Each read and write of another row refuses in that checkout. The link replaces that row there. |
| `bindings.tsv` has two rows for one path, or cannot be read | Every command of every project refuses. Sage never falls back to another logbook. Fix the file. |
| `bindings.tsv` is gone, and `bindings.made` shows that sage made it | Every command of every project refuses. Restore the table from a copy. If no project uses the shared root, remove `bindings.made`. |
| `SAGE_SHARED_HOME` is a relative path | Every command refuses. Each folder must find the same root. |
| A project has a marker that its move did not finish | Each command refuses and says to run the move again. |
| A move of the project stopped, and its plan is saved | Each command of the project, in Claude and in Codex, refuses and names the command that finishes the move: `sage move --gate <G>`. A link refuses too, also a `--to` that names the new logbook. |

A moved folder with no Git commits, or that is no Git repository, has no first commit, so sage cannot compare it. This is a limit.

**One chief owns each task.** A task's `chief` column names its owning chief, and `task add` gives the task to the chief that adds it. An existing project shows no change: only a shared logbook has this column and `chiefs.tsv`.

- Each chief has a row in `chiefs.tsv`, with its provider and its session.
- A resume keeps the session, so it is the same chief.
- Claude's `/clear` starts a new session, so it is a new chief. To go on with its tasks, the new chief opens a Replace gate, and you answer it.

| Who | Writes |
| --- | --- |
| The owning chief | Its own task: `task <T> set`, `round`, `run add`, `run done`, `finding add`, `triage`, `close`, `move`, `verdict`, `task-adopt`, `gate add <T>`, `program propose` for its pilot and each of its tasks, `log <T>`, `offer`, `cancel` and `release`. |
| A lead | What the chief of its lead run may write, on the task of that run only, while that run runs. |
| Any chief | `task add`, `claim`, `accept` or `cancel` (a decline) of an offer that names it, `gate add` with no task, `gate replace`, `init`, `standing add`, `config`, `log -`, `pages <T> record`, `observe` and `run usage`. |
| You | `gate answer`, in your own words, from either provider, each form of `logbook repair` (`--accept-loss`, `--accept-change-loss`, or both) and `projects rebuild`: each is your act and names no chief, so the line that sage prints works in your terminal. |
| A stop hook | The report and the end of the run of its own slot, so no report is lost. |
| A helper, or a command with no chief | Nothing. It only reads. |

- A Claude chief adds `--chief C<n>` to each write, and a Claude lead adds `--lead R<n>`.
- The hook names the id at the first write, also when a value is in quotes. The write must be one command of its own: after `cd` or in a pipe, the hook does not read it, and the state tool asks for the id.
- A Codex chief or lead adds nothing, because the server knows its session.
- A checkout has no chief until it has a row, so `link` needs none.

| Situation | Result |
| --- | --- |
| The task belongs to another chief | The write refuses, names the owning chief and changes nothing, on every path. If that chief stopped, a chief opens a Replace gate. |
| The task has no owning chief | The write refuses and prints the claim that works for that chief. A Claude chief runs `sage claim <T> --version <version> --chief C<n>`. A Codex chief calls the `claim` tool with the task and that version. |
| The task changed before the claim, or another chief claimed it first | The claim refuses and changes nothing. |

**Hand a task to another chief.** A Claude chief adds `--chief C<n>` to each command below. A Codex chief calls the tool of the same name: `offer`, `cancel`, `accept`, `release` or `gate_replace`.

| Command | Who and when | Result |
| --- | --- | --- |
| `sage offer <T> --to C<n>` | The owning chief. The task has no open offer. | The offer names one other chief. The owning chief stays, and active runs go on. |
| `sage cancel <T> --offer <id>` | The owning chief, with the exact open offer. The chief that the offer names runs the same command to decline it. Active runs do not stop it. | The offer clears, and it never becomes valid again. After a decline, the line says that the recipient declined, and the owning chief keeps the task. |
| `sage accept <T> --offer <id> --version <version>` | The chief that the offer names, with the exact open offer and the current version. The task has no active or unknown run. | That chief owns the task, and the offer clears. |
| `sage release <T>` | The owning chief. The task has no open offer and no active or unknown run. | The task has no owning chief, so any chief can claim it. Its work and reports stay. |
| `sage gate replace <T> --to C<n>` | Any chief, for an owning chief that stopped. | A gate for you, with the options replace and keep. It names the task's title, both chiefs with their providers and each run that will end as failed, with its role. It says what each answer does. |

- `offer` and `task <T>` print the offer's id and the version that `accept` needs. A Codex chief reads them with `sage_read_task`.
- An accept or a release that waits for a run names the Replace gate too: a run of unknown status may never end, and only a Replace ends it.
- A run that ends does not advance a transfer: the recipient still accepts. A transfer changes no run: each run keeps the chief that dispatched it.
- Sage cannot see that a chief ended, so a stopped chief stays the owning chief until you answer. A Replace is the only way to take a task with no consent from its chief.
- You answer a Replace gate as you answer any gate, and only once. The answer replace does one write: it sets the chief, clears an open offer and ends each named run as failed.
- Keep, or your own words, change nothing, and the line says so: the task keeps its chief, no run ended, and the gate is spent. To replace the chief later, a chief opens a new gate.
- A chief never answers a replace gate by itself: only your answer counts. This rule is an instruction, not a check. No code ties the answer to your message, as for other gates.
- A replace gate refuses your answer replace when the owning chief changed, or when a new run started after it opened. Answer keep, and the chief opens a new gate.
- The replaced chief gets a refusal that names the new owning chief, also for `sage-pr create`, `sage-pr merge` and `gh pr merge`. Its lead writes nothing, because the lead run ended.
- A run that ended as blocked or failed keeps a late report once, with its arrival time, so no report is lost. `task <T>` prints its path. That report backs no verdict.
- Claude's stop hook keeps the late report of any role with a known run. Codex keeps it for a child that has the run in its task name.

This check prevents mistakes. It does not stop an agent that gives another chief's id on purpose. An older sage does not write a shared logbook that has the `chief` column: it refuses and asks you to update the plugin, and its reads go on.

**Cycle counts.**

- A shared project reads `cycles.*` and `max_rounds` from the `config.json` of the shared root, and `sage config` writes them there.
- The first shared write takes the largest value of both provider roots for each count, so a project never needs fewer cycles than you wrote. A later link leaves the shared counts.
- Model keys, `arena`, the agent caps and the hook state stay in each provider root.

**The board.** The board shows a shared project as one project, in Claude and in Codex, in the chat and on the board page. It only reads, and an existing project looks as before ([board guide](board.md#a-shared-project-on-the-board)).

After you update sage in Claude and in Codex, stop a running board server with the `board --stop` command that `board --ensure` prints, then ask for the board again. A board server that started before the update reads with its old code.

### Move an existing project

The move takes the open work of a project's Claude and Codex logbooks into one shared logbook. It runs once, after one gate, and no command undoes it.

1. Update sage in Claude and in Codex, restart both sessions, and trust the Codex hooks again with `/hooks`.
2. Tell either chief to move the project. The chief shows you the preview, which changes nothing.
3. Answer the move gate: move, or keep.
4. The chief moves the project and gives you the end check. Open the board in either provider: you see one project.

| Command | Does |
| --- | --- |
| `sage move --preview` | Reads and changes nothing. It prints what moves by provider with the new numbers, what stays, the next numbers, the checks and the plan: a fingerprint of everything that the move would write. |
| `sage move --plan <plan>` | Opens the move gate, if the logbooks still give that plan. Its first line is `G<n> · move · plan <plan>`. |
| `sage move --gate <G>` | Moves, after your answer. It checks the plan again, then prints each step, the end check by table and by provider, the map page, the backup copies and the restore steps. |

The move gate is your act, so the move names no chief. In Codex, the chief uses the `move` tool of the sage MCP server, with the same three forms.

| What | After the move |
| --- | --- |
| An open task | Moves with a new number, Claude's first, and starts unclaimed. Its priority, size, route, round, branch and PR stay: an adoption record of version 2 keeps the old task, its branch and its PR. A task in verifying, verified or pr-ready returns to reviewing. |
| A task in a repair round | Keeps its round and its round keys. A round key whose finding closed before the move gets a new key with no row, so the next round counts as before the move. |
| Its open findings, its gates (answered ones too), its program, its waits and its PR history | Move with new numbers, also each finding key (through the gate's own task first), task or program number in a moved gate's question. A wait on a merged or concluded task counts as met. Each moved finding's summary names its old key. |
| An open gate with no task | Moves with a new number. The open gates take the first numbers. |
| A task that a task of the other logbook adopted | Moves with the task that adopted it: its open findings, its gates and its program go to that task too. In a chain of adoptions, each task moves with the last task of the chain. |
| A finished task of a program that moves (for example its merged pilot) | Moves with the program, finished, with a new number, so the program keeps its pilot, its breakdown approval and its done count. |
| A finished task, the runs, the verdicts and the kept reports | Stay in the old logbook, read-only. The board shows each finished task with its Old label. A moved task gets fresh reviews and QA. |
| The standing orders | Claude's keep their numbers. Codex's follow under a heading, with new numbers and the old Codex number in brackets, and a Codex line with no number (the rest of an order, or a note) stays where it was. A repeated order stays: ask the chief to remove it. |
| The old logbooks | Each gets `moved.json`, a `moved` column in its task table with each new number, and a backup copy, `tasks.before-move.tsv`. Every write there refuses. Its decisions get the highest new number of the map for each kind of id, and the logbook of the move gate gets a row that the gate moved the project: a restore by hand keeps these rows. |
| Each checkout of the repository with a logbook | Gets a row in `bindings.tsv`. |

The new logbook holds `sources.tsv` (its old logbooks, which the board reads) and `move-map.html`, a page of each old and new number, with a tab for each kind of row (tasks, gates, programs, findings) and a find box. The map page shows paths, so it stays on your Mac.

For 7 days after the move, the board shows a banner that names the map page and the logbook folder that holds it. The move prints times in your Mac's own time zone, with the zone as an offset from UTC (for example `09:33 UTC+05:30`), and the board prints them in UTC.

| Situation | Result |
| --- | --- |
| A run runs in the project | The preview refuses and names each run. The chief starts no new run. Tell the other provider's chief to start none either. |
| A provider's plugin is below contract 2 | The preview refuses and shows each provider's contract. Update sage in that provider, restart it and trust its hooks again. |
| A provider has no row in `plugins.tsv` | The gate offers "move, and record that provider as unused" in place of "move", because a plain move waits for that provider's row. It recommends keep while that provider has a logbook of the repository. |
| The move also links other checkouts of the repository | The preview and the gate name each one by its path and provider. If one of them is another project, answer keep, and tell the chief which one. |
| Another checkout with the same first commit has another GitHub remote than this one (a fork) | The move leaves it out, and the preview and the gate name it. Its logbooks are not moved or marked, it gets no row, and it keeps working as a project of its own. A checkout with no GitHub remote moves, as a clone; a remote that Git cannot read refuses the preview. |
| A folder cannot be written (for example the Claude folder from the Codex sandbox) | The preview refuses and names each folder. Ask the other provider's chief to move the project. |
| A wait names an abandoned task, or a program's pilot is not in the logbook | The preview refuses. Change the waits, or fix the pilot or take the open tasks out of the program, then ask again. |
| A finished task has an open gate | The preview refuses and lists each such gate with its task, state and question, because its old logbook is read-only after the move and no one could answer it there. Answer each gate, then ask again. |
| A logbook changed after the preview | Nothing moves. The refusal says what changed and that the gate is closed, and the chief shows a new preview and opens a new gate. An older move gate refuses and names the newer one, and the same `--plan` again shows the open gate again. |
| The move stopped (the Mac slept) | Every command of the project, in Claude and in Codex, refuses and names the same command. The chief runs it at once, from any checkout of the move, and it goes on from the next step. If an old logbook changed before the move marked it, nothing moves, the new logbook goes aside, and the chief starts again with a new preview. |
| A command waited for an old logbook while the move ran | It refuses while the plan is there, also on a logbook that the move did not mark yet, and names the command that finishes the move. |
| A saved plan names a folder, an old logbook or a checkout that is not this repository's, or no old logbook that holds its answered move gate, or its rows do not match its own fingerprint | The move refuses, and it writes nothing. Check the plan file. |
| The end check finds a count that does not match | The refusal names each missing record and no command: running the move again does not change it. The old logbooks still hold every record, and every command of the project refuses while the plan stays, so start no work there. Compare the new logbook with the old logbooks and the map, then rename the plan file (`moves/<folder>.json` in the shared root) to `<folder>.json.aside` to keep the new logbook as it is, or restore by hand. |
| A plan file in the shared root cannot be read | Every project of the shared root refuses and names that file, because sage cannot tell which project it moves. Check the file. |
| `logbook repair --accept-loss decisions` in the moved logbook | The repair writes the move's id floors again, from the old logbooks, so no old number comes back. |

To restore by hand (no command does this). Warning: work recorded after the move stays only in the new logbook, and these steps do not bring it back.

1. Stop every session of this project in Claude and in Codex.
2. In each old logbook folder, replace `tasks.tsv` with `tasks.before-move.tsv`.
3. In each old logbook folder, delete `moved.json`.
4. In `~/.sage/bindings.tsv`, delete the rows that name the new logbook.
5. In `~/.sage/projects.tsv`, delete the row of the new logbook.
6. Rename the new logbook's folder `~/.sage/<folder>` to `~/.sage/.<folder>.restored-<plan>`, where `<plan>` is the move's plan. The board reads no folder whose name starts with a dot, so no task shows twice, and a later move can use the folder name again. Keep it until you are sure.
7. If the plan `~/.sage/moves/<folder>.json` is there (an end check that did not match keeps it), rename it to `<folder>.json.aside`. While it is there, every command of the project refuses.

After a restore, the old move gate moves nothing: to move again, ask the chief for a new preview, and answer a new gate. A new task, gate or program takes a number above the move's map, from the rows that the move wrote in the old logbooks' decisions.

**Limits.**

- `plugins.tsv` shows the contract of the last command that each provider ran. A session that started before the update still runs the old code, so the gate asks you to check that every session restarted.
- An older plugin refuses a write to an old logbook, because it does not know the `moved` column. In the new logbook it gives new numbers above the move's floors, but its merge check refuses a moved task: it does not know adoption version 2.
- The move also takes the logbooks of each clone with the same first commit. It leaves out a fork only when both checkouts have a GitHub remote and the two differ: a fork with no GitHub remote moves too, so answer keep, and tell the chief which folder is another project.
- The Codex journal and its open fences are the Codex part of the move. The preview in core does not read them, so a preview from the Claude chief does not show them. The move finishes each saved change of the old logbooks first, and a Codex chief runs no separate check of the fences before it opens the gate.
- The move prints its steps at the end, not as each one ends: the chief's chat shows them when the command returns.
- Sage finds each provider's legacy logbook through the roots that its adapter names, from its own environment. A provider that runs with a custom `CLAUDE_CONFIG_DIR` or `CODEX_HOME` that the other provider does not see has a root that the other one cannot read, so `init` there may start a shared logbook while that root holds a logbook of the repository, and the move from the other provider does not take it. Keep both settings the same in Claude and in Codex, or unset.

## Where sage keeps things

- **The logbook** of each project: `~/.claude/sage/<project>-<hash>/`. It holds the tasks, the agent runs, the findings, the verdicts, your answers and the decision trail. So you can leave and come back: a new session on the same Mac continues the work, and Remote Control lets you follow it from a phone.
- **The shared root**: `~/.sage/`, or `SAGE_SHARED_HOME`. It holds the logbooks that Claude and Codex share, `bindings.tsv` (which checkout uses which logbook), `plugins.tsv` (which providers ran) and the cycle counts of the shared logbooks. See [Shared logbooks](#shared-logbooks).
- **The hook's state**: `~/.claude/sage/.hooks/`. It keeps the mode, autopilot and the agent slots.
- **The pages** of each task: `~/sage-worktrees/<project>-<hash>/pages/<task>/`, outside the logbook. Agents save their research pages and designs there. The chief makes the folder and prints its path.
- **The board's config**: `~/.config/sage-board/`, when you use the board server. It holds `board.json` (with your board password's hash), `board.log` and `board.pid`.
- **The board's login service**, when you install it ([Optional login startup](../../packages/sage-board/README.md#optional-login-startup)): the login file `~/Library/LaunchAgents/dev.sage.board.plist`, and the installed copy of the board in `~/.local/share/sage-board/service/`.
- **The board's pages folder**: `~/.local/share/sage-board/pages/`, when the board's setup names it. The board saves its offline HTML pages there.

## Troubleshooting

| You see | What to do |
| --- | --- |
| Sage mode did not switch on | Send `sage mode` alone, with no other words, then the request in a new message. Send `sage help` to see every phrase and whether sage mode is on. |
| The chief says that your message was near a phrase | The hook found a phrase with other words, a question mark or a quote mark. Send the exact phrase alone. |
| A phrase did nothing while Claude worked | A message sent while Claude works can switch only autopilot off. Send the phrase again when Claude is idle. |
| A new version of sage has no effect | Start a new session (see [To update sage](#to-update-sage)). |
| A push or a merge is refused | The hook refuses it: an agent pushes only `git push <remote> <branch>` on its own branch, never to the default branch, and never merges. The refusal names the form that passes; a push also needs a remote URL on `github.com` (not an ssh host alias) and `gh` logged in, because the hook asks GitHub for the default branch. Ask the chief what it needs. |
| A second push to a blank repository is refused | The first push made the task's branch the default branch. The chief creates main, then runs `gh repo edit github.com/<owner>/<repo> --default-branch main`. Both commands ask you, and the hook refuses the move past 20 commits on the default branch, 5 branches or 3 open pull requests. |
| No pull request opens | Check that `gh` is installed and logged in (`gh auth status`), and that the project has a GitHub remote. Without a remote, the work stops at a verified branch. |
| A task waits and nothing moves | Send `show board`. An open question under "Needs you" holds the task until you answer. A task of a program waits for your approval of the breakdown, then for its pilot. |
| A pull request does not merge | A merge needs its clean cycles on the exact head commit. A new commit starts again from cycle 1. |
| The board line says that the server is not running | The line says why: for example a busy port, or an older board server on the port. See the [board service guide](../../packages/sage-board/README.md). |
| `board --install --login-file` refuses | It needs a `node` command on PATH that does not change at an upgrade. Put a `node` link to your Node in a folder that you own and that is on PATH (for example `~/.local/bin/node`), then run the install again. |
| The board asks for a password on the phone | Set it once in Terminal on the Mac, with the `board --set-password` command that the board line gives. |

For a question that this page does not answer, send `/sage:sage-help` and your question, for example `/sage:sage-help how do I see the board?`.
