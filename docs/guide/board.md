# The board

The board is a view of every project's logbook: what needs you, the agents that run now, each active task, and what merged. This page is the user guide to the board.

The [README](../../README.md#the-board) has a screenshot, and [Every phrase](using-sage.md#every-phrase) lists the board phrases with all the others. The [board service guide](../../packages/sage-board/README.md) gives the server's setup by hand, the login service and private phone access.

The board only reads. To change a task, a priority or a kind, ask the chief.

## Ask for the board

The chat view shows the tasks in the logbook of the tool that you use (Claude or Codex), and it needs no server. The browser view shows the logbooks in its config: by default, both the Claude and the Codex logbook. It also has filters and task pages.

| Say | You see |
| --- | --- |
| `show board`, `sage board`, or `show board for this project` | Tasks for the current checkout, with each source kept separate. |
| `show board for all` or `sage board for all projects` | Tasks from all configured sources. |
| `show board for sage-bot` or `sage board for sage-bot` | One named project: the name that the board shows (its display name, or its repository's name) or its folder's name, in any letter case. The Claude and the Codex logbook of one checkout are one project, so the name shows both. An ambiguous name (two clones) gives qualified project choices. |
| `show board T197`, `sage board T197`, or `board T197` | Full task detail for the current project. An unknown task gives nearby IDs and opens no other task. |
| `show status` or `sage status` | Task states, recorded agents, what needs you, and the budget evidence that the logbook has. |

Claude recognizes these phrases only at the start of your own message, outside quoted text:

- Bold around the phrase works, for example `**show board**`.
- A question mark works right after the phrase, also inside the bold (`**show board?**`). After the closing stars (`**show board**?`), it does not work.
- Text after a question mark on the same line does not trigger the phrase.

In Codex, these phrases do not work by themselves yet. Use the board commands of the `sage` skill instead, as [sage in Codex](codex.md) tells.

The six columns are Backlog, Design, Building, In review, Ready to merge, and Done. Done includes merged and concluded tasks from the last seven days, when their completion date is recorded. Abandoned tasks remain available by exact lookup.

Each card shows its task, project, the provider whose logbook holds it (Claude or Codex), PR, priority, kind, size, risk, and recorded agent roles and providers. Under the title, the step line shows only the steps of the task's route, each with a mark and a word, then a "Now" or "Needs you" line and a "Next" line.

- A backlog card has no "Now" and "Next" lines; it shows its "Needs you" line when it needs you.
- A long project name ends in an ellipsis, and its tooltip gives the full name.
- A project shows by its display name (set by the chief), else by its GitHub repository (the `upstream` remote, then `origin`), else by its folder.
- The Claude and Codex logbooks with the same key and the same checkout are one project.
- In each column, the tasks that need you come first, then P0 to P3, then the tasks with no priority.
- An archived project's tasks leave the columns: the Archived group under the board lists the project, with its task count and what needs you there, and the picker shows its tasks when you choose it.
- Review evidence applies only to the recorded PR head. Missing facts stay unknown.
- Inferred work from a Codex PR stays separate from recorded running agents.

The browser board has a project picker (the button with the current project; "/" opens it), a chip for each project that needs you, and a filter bar: Who, Priority, Kind and Program. These need the page script.

- Under a filter, the Needs you chip and each project's chip count only the tasks that the filter keeps.
- A live update changes only the parts of the page that changed, and keeps your scroll, focus, open folds and the open picker.
- At widths from 701 to 1180 px, the six columns show as two rows of three, so no column is cut off; above 1180 px the six columns fit also with a classic scroll bar.
- At phone width each chip, filter and button is at least 44 px high.
- On a task page, a dotted stand-in value shows its reason when you tap it or move the focus to it.
- The browser board is dark until you choose the light theme with the switch at the top; it works with scripts off too, and with scripts the board keeps your choice in this browser.

## Needs you and task pages

Needs you lists open questions with their options and recommendation, designs that wait for your answer, failed checks or QA, and PRs that need your review. A held task is on it only with an open question.

Gate IDs include the source and project. The chief must resolve that exact logbook before recording an answer.

Needs you also has items that no card holds:

- a stuck program (its pilot was abandoned or is not in the logbook, also before you approve the breakdown);
- a breakdown gate that the logbook lost;
- a program that tasks name but the logbook does not have;
- a programs table that the board cannot read;
- a logbook that it cannot read;
- a provider's logbook folder that it cannot read ("The Codex logbooks cannot be read").

Each item says why and what to do, and counts in "needs you".

- In the chat, the count of "needs you" equals the numbered items.
- In the chat, a program's breakdown gate is under its own heading, "Program approval", and every other item is under "Other".
- On the board page, the items with no card are in the box "Needs you, not on a card" above the columns.

A task page shows the step line, one row for each step with its detail and each review role's state, the brief, runs, verdict evidence, findings, artifacts, and latest decisions. A task of a program also shows its program, with a link and the progress, each task that it waits for with its state (met, not met or never met), and the tasks that wait for it.

The offline HTML file contains the selected tasks and their full details. Text from agents is escaped in both views.

## The Agents page

The board server has a page **Agents** (`/agents`). The header of the pages has three tabs: "Task board | Programs | Agents (n)", where n is the count of agents that run now. The page has the same sign-in as the task board, and it updates live in the same way.

The page shows every agent that runs now, in all projects, for Claude and Codex. It has one box for each project, with the project's Claude agent cap. A lead's helpers sit under it, indented.

The projects and the rows that need a look come first. Each row gives the provider, role, run, task (with a link to its task page), model, time running, last activity and a state.

| State | Shown when |
| --- | --- |
| ● working | The hook saw the agent in the last 30 min. |
| ◷ waiting for its helpers | A lead has at least one helper that still runs. |
| ! may be stuck | No hook activity for 30 min or more, and no running helper. Or the logbook says that the run runs, and no agent slot holds it (the hook frees a slot after 60 min with no activity). |
| ▲ running long | The time running is more than 2 times the median of the same role's ended runs in this project. It needs 5 ended runs. |
| ■ helper stopped, run still open | The hook saw the helper stop, but the logbook still says that the run runs. The chief must end the run. |
| ○ running | A Codex run: the logbook says that it runs. Codex sends no activity notes yet, so the row has no last activity, no helpers and no cap. |

The page reads files only: the logbooks, the hook's agent slots and helper notes (by name and time, not their content) and the caps in `config.json`. It runs no command and reads no process list.

To join a slot to its run, the hook marks each agent slot with the run id from the first line of the agent's brief ("Run R12 · task T3"). An agent whose brief has no such line shows with "No run recorded".


## Programs on the board

A program is a request that sage runs as two or more tasks for one goal, with one pilot task and a breakdown that you approve (see [Programs](using-sage.md#programs)).

| Where | What you see |
| --- | --- |
| A card | The program's name (◫), "pilot" on the pilot, and a wait line in place of the Now line: what the task waits for (⧗), or ⊘ when a wait is never met, so the task cannot start. A wait in a loop of waits (a hand edit) says "in a loop" and is never met. |
| The pilot's card, while the breakdown waits for you | A "Program approval" band on top and a frame, then the breakdown gate's question as the chief stored it, line by line, and how to answer: approve, change (say what to change) or drop the program. Only the gate that the program's row names, on its pilot, with the options approve, change and drop, gets the band: a gate that only copies its words is a plain gate. |
| The Program filter | The cards of one program, or of no program. A program with no card on the board (its tasks ended more than 7 days ago) says why, with a link to its page. The board keeps the choice in the address (`#pg=`). |
| The Programs tab (`/programs`) | Each program in a group (Needs you, Active, Done; Dropped is folded) with its state, goal, progress bar and progress, for example "3 of 7 merged · T10 abandoned", and what moves next: only a task that waits for nothing, then how many tasks wait and which cannot start. A program whose breakdown you asked to change is a line here: the chief revises it. |
| A program's page (`/program/<key>`) | Its goal and progress, the pilot, what moves next, its tasks in order (the pilot first, then each task after the tasks that it waits for), and its latest decisions, as short lines with short dates (for example "17 Oct T2 merged: PR 66"). While the breakdown waits for you, the page shows the breakdown gate in the frame. An unknown program gives the page "Program not found", with status 404. |
| The chat | A Programs section with one line for each program that is not done. Done programs, and dropped programs with no task left in them, are counts, with ": open the board's Programs tab". A dropped program with tasks still in it keeps its line, which asks the chief to take each task out. |

The offline HTML file holds the programs list and each program's page too, as parts of the one file. Each of its pages has its own theme switch.

## The board server

The board server only reads your logbooks. It does not make or change a logbook, change the chat board's list of what merged since the last board, fetch from GitHub, or decide whether a pull request may merge. The state tool still records each change and applies the merge rules.

In Claude, `show board` also starts the local board server on the Mac when it is not running (the first time, it sets it up from the standard Claude and Codex roots), and the chief shows its address, or why it is not running, next to the chat board. On the Mac the board needs no sign-in.

On the phone, through a private HTTPS tunnel, you sign in as `sage` with your own password. Set it once in Terminal on the Mac with the `board --set-password` command that the line gives; until then, access from outside the Mac is off.

The command needs a terminal, and the sage hook refuses the ordinary command shapes by which an agent sets the password or reads the board config. It does not stop a script that builds them while it runs; full protection needs the sandbox.

After you change the config or the password, or update sage, the line says that a restart is needed: run the `board --stop` command that it gives, then ask for the board again.

The [board service guide](../../packages/sage-board/README.md) gives local startup, stable installation, offline export, and private phone access through a private HTTPS tunnel, such as Tailscale Serve. The server runs independently of a chat.

It listens on loopback and asks for a sign-in for every request that is not from the Mac itself. A task page or a program page that is too large to show (over 8 MB) shows its parent page (the board, or the programs list) with a note, and the rest of the board stays live.

`board --install --login-file` refuses when no upgrade-stable `node` command is on PATH, for example with asdf, Volta, fnm or a keg-only Homebrew Node. To fix it, put a `node` link to the Node that you run the install with in a folder that you own and that is on PATH (for example `~/.local/bin/node`), then run the install again.
