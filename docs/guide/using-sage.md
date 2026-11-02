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
- a fix that the re-check does not confirm.

It also ends blocked in any state that its file does not name. The chief then reads the logbook and decides. It makes only these two state moves there:

- repairing to reviewing: a fix that the re-check did not confirm gets the next round, or a replan;
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
- Today a project gets a row only by a link. An existing project has no row, and it works as before.
- Linked worktrees use the row of their main checkout.

The chief runs a link only after your answer in the chat:

| Command | Does |
| --- | --- |
| `sage link --separate` | Makes a new shared logbook and a row for this checkout. |
| `sage link --to <folder>` | Adds a row for this checkout to a logbook of the shared root. Use it for a second clone, or for a checkout that you moved. |

A Codex chief calls the `link` tool of the same name. A retry changes nothing.

| Situation | Result |
| --- | --- |
| The project has a logbook in the Claude or Codex root | The link refuses, because the link would hide its tasks. Keep using that logbook. A later command moves existing projects. |
| The checkout is already linked to another logbook | The link refuses. A checkout has one logbook, so keep using that one. Only the move can take a checkout to another logbook, and no command does the move today: a later sage adds it. |
| You moved a checkout or cloned it again, so its new path has no row | Each command and `init` refuse and name the logbook with the same first commit. Run `sage link --to <folder>`, or `sage link --separate` for another project. The old row stays and does no harm. |
| `--to` names a logbook whose owner has no first commit in common with this checkout | The link refuses. A shallow clone needs its full history first: `git fetch --unshallow`. |
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

A moved folder with no Git commits, or that is no Git repository, has no first commit, so sage cannot compare it. This is a limit.

**One chief owns each task.** A task's `chief` column names its owning chief, and `task add` gives the task to the chief that adds it. An existing project shows no change: only a shared logbook has this column and `chiefs.tsv`.

- Each chief has a row in `chiefs.tsv`, with its provider and its session.
- A resume keeps the session, so it is the same chief.
- Claude's `/clear` starts a new session, so it is a new chief.

| Who | Writes |
| --- | --- |
| The owning chief | Its own task: `task <T> set`, `round`, `run add`, `run done`, `finding add`, `triage`, `close`, `move`, `verdict`, `task-adopt`, `gate add <T>`, `program propose` for its pilot and each of its tasks, and `log <T>`. |
| A lead | What the chief of its lead run may write, on the task of that run only, while that run runs. |
| Any chief | `task add`, `claim`, `gate add` with no task, `init`, `standing add`, `config`, `log -`, `pages <T> record`, `observe`, `run usage`, `logbook repair` and `projects rebuild`. |
| You | `gate answer`, in your own words, from either provider. |
| A stop hook | The report and the end of the run of its own slot, so no report is lost. |
| A helper, or a command with no chief | Nothing. It only reads. |

- A Claude chief adds `--chief C<n>` to each write, and a Claude lead adds `--lead R<n>`.
- The hook names the id at the first write, also when a value is in quotes. The write must be one command of its own: after `cd` or in a pipe, the hook does not read it, and the state tool asks for the id.
- A Codex chief or lead adds nothing, because the server knows its session.
- A checkout has no chief until it has a row, so `link` needs none.

| Situation | Result |
| --- | --- |
| The task belongs to another chief | The write refuses, names the owning chief and changes nothing, on every path. If that chief stopped, the chief asks you. A later sage adds the transfer. |
| The task has no owning chief | The write refuses and prints the claim that works: `sage claim <T> --version <version> --chief C<n>`. A Codex chief calls the `claim` tool with the task and that version. |
| The task changed before the claim, or another chief claimed it first | The claim refuses and changes nothing. |

This check prevents mistakes. It does not stop an agent that gives another chief's id on purpose. An older sage does not write a shared logbook that has the `chief` column: it refuses and asks you to update the plugin, and its reads go on.

**Cycle counts.**

- A shared project reads `cycles.*` and `max_rounds` from the `config.json` of the shared root, and `sage config` writes them there.
- The first shared write takes the largest value of both provider roots for each count, so a project never needs fewer cycles than you wrote. A later link leaves the shared counts.
- Model keys, `arena`, the agent caps and the hook state stay in each provider root.

**Limit.** The board does not show a shared logbook yet.

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
| No pull request opens | Check that `gh` is installed and logged in (`gh auth status`), and that the project has a GitHub remote. Without a remote, the work stops at a verified branch. |
| A task waits and nothing moves | Send `show board`. An open question under "Needs you" holds the task until you answer. A task of a program waits for your approval of the breakdown, then for its pilot. |
| A pull request does not merge | A merge needs its clean cycles on the exact head commit. A new commit starts again from cycle 1. |
| The board line says that the server is not running | The line says why: for example a busy port, or an older board server on the port. See the [board service guide](../../packages/sage-board/README.md). |
| `board --install --login-file` refuses | It needs a `node` command on PATH that does not change at an upgrade. Put a `node` link to your Node in a folder that you own and that is on PATH (for example `~/.local/bin/node`), then run the install again. |
| The board asks for a password on the phone | Set it once in Terminal on the Mac, with the `board --set-password` command that the board line gives. |

For a question that this page does not answer, send `/sage:sage-help` and your question, for example `/sage:sage-help how do I see the board?`.
