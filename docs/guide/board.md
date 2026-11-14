# The board

The board is a view of every project's logbook: what needs you, the agents that run now, each active task, and what merged. This page is the user guide to the board.

The [README](../../README.md#the-board) has a screenshot, and [Every phrase](using-sage.md#every-phrase) lists the board phrases with all the others. The [board service guide](../../packages/sage-board/README.md) gives the server's setup by hand and the login service.

The board only reads. To change a task, a priority or a kind, ask the chief.

## Ask for the board

The chat view shows the tasks in the project's logbook: its shared logbook, or else the logbook of the tool that you use (Claude or Codex), and it needs no server. The browser view shows the logbooks in its config: by default, the Claude and the Codex logbooks and the [shared logbooks](#a-shared-project-on-the-board), with filters and task pages.

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

Codex recognizes the same phrases by the same rules. There, the board page starts after you approve one prompt, as [The board in Codex](codex.md#the-board-in-codex) tells.

The six columns are Backlog, Design, Building, In review, Ready to merge, and Done. Done includes merged and concluded tasks from the last seven days, when their completion date is recorded. Abandoned tasks remain available by exact lookup.

A verified pull request is in Ready to merge only when sage's merge check passes on its last commit. When the check refuses, or the board does not know the last commit, the card stays in In review and says why. The board does not check the pull request's head branch on GitHub.

Each card shows its task, project, the provider whose logbook holds it (Claude or Codex), PR, priority, kind, size, risk, and recorded agent roles and providers. Every task has a priority (P0 to P3); the card of an older open task with none shows a "no priority" tag, so that you can ask the chief to set one. Under the title, the step line shows only the steps of the task's route, each with a mark and a word, then a "Now" or "Needs you" line and a "Next" line.

- At the top right, a card shows the task's [state word](#the-state-words).
- A backlog card has no "Now" and "Next" lines; it shows its "Needs you" line when it needs you.
- A long project name ends in an ellipsis, and its tooltip gives the full name.
- A project shows by its display name (set by the chief), else by its GitHub repository (the `upstream` remote, then `origin`), else by its folder.
- The Claude and Codex logbooks with the same key and the same checkout are one project.
- In each column, the tasks that need you come first, then P0 to P3, then the tasks with no priority.
- An archived project's tasks leave the columns: the Archived group under the board lists the project, with its task count and what needs you there, and the picker shows its tasks when you choose it.
- Review evidence applies only to the recorded PR head. Missing facts stay unknown.
- Inferred work from a Codex PR stays separate from recorded running agents.

The browser board has a project picker (the button with the current project; "/" opens it), a chip for each project that needs you, and a filter bar: Who, Priority, Kind and Milestone. These need the page script.

- Under a filter, the Needs you chip and each project's chip count only the tasks that the filter keeps.
- A live update changes only the parts of the page that changed, and keeps your scroll, focus, open folds and the open picker.
- At widths from 701 to 1180 px, the six columns show as two rows of three, so no column is cut off; above 1180 px the six columns fit also with a classic scroll bar.
- On a task page, a dotted stand-in value shows its reason when you move the focus to it.
- The browser board is dark until you choose the light theme with the switch at the top; it works with scripts off too, and with scripts the board keeps your choice in this browser.

### The state words

Each card, each task line of the chat board, each milestone and each task page shows one of six state words. Each word has a mark, so it reads without colour too.

| Word | Mark | It means |
| --- | --- | --- |
| not started | ○ | The task exists, and no agent works on it yet. |
| waiting | ⧗ | It cannot start before another task, or before you approve its milestone. |
| needs you | ! | It waits for your answer to a question, or for your merge. |
| in progress | ▶ | Agents or the chief work on it. |
| done | ✓ | It merged, or it was a study that ended. |
| stopped | ■ | Its work stopped for good. |

- A wait names the word of the task that it waits for, for example "Waits for T12 (in progress)".
- A milestone's word comes from its breakdown: "needs you" while the breakdown waits for you, or when its pilot stopped; "stopped" when you dropped it. Else it comes from its tasks.
- The status lines that the chief shows you (the `status` command) give the word of each release and each milestone. Their tasks line keeps the tool's own states.
- The task page keeps the tool's own state of the task (for example `reviewing`) under its steps, as "Recorded state".
- The columns stay as they are. Done holds the done tasks. A card in another column shows not started, waiting, needs you or in progress.

## Needs you and task pages

Needs you lists open questions with their options and recommendation, designs that wait for your answer, failed checks or QA, and PRs that need your review. A held task is on it only with an open question.

Gate IDs include the source and project. The chief must resolve that exact logbook before recording an answer.

Needs you also has items that no card holds:

- a stuck milestone (its pilot was abandoned or is not in the logbook, also before you approve the breakdown);
- a breakdown gate that the logbook lost;
- a milestone that tasks name but the logbook does not have;
- a milestones table that the board cannot read;
- a logbook that it cannot read;
- a provider's logbook folder that it cannot read ("The Codex logbooks cannot be read");
- an open move gate ("The move gate G104 waits for your answer"): [the move](using-sage.md#move-an-existing-project) of the project waits for your answer to its gate.

Each item says why and what to do, and counts in "needs you".

- In the chat, the count of "needs you" equals the numbered items.
- In the chat, a milestone's breakdown gate is under its own heading, "Milestone approval", and every other item is under "Other".
- On the board page, the items with no card are in the box "Needs you, not on a card" above the columns.

A task page shows the step line, one row for each step with its detail and each review role's state, the brief, runs, verdict evidence, findings, artifacts, and latest decisions. Under the findings, the polish list shows the task's open low findings, which never block a merge; the task's card shows their count ("polish 2"). A task of a milestone also shows its milestone, with a link and the progress, each task that it waits for with its state (met, not met or never met), and the tasks that wait for it.

The offline HTML file contains the selected tasks and their full details. Text from agents is escaped in both views.

## A shared project on the board

A project with a [shared logbook](using-sage.md#shared-logbooks) shows as one project, in the chat and on the board page, from Claude and from Codex. The board reads the shared root (`~/.sage`, or the root that `SAGE_SHARED_HOME` names) beside the Claude and Codex roots, and it writes nothing there. A project that is not shared looks and works as before.

| Line | Where | What it says |
| --- | --- | --- |
| `Claude · C1` on the card's top line | Each card of a shared task, in place of the logbook's name | The owning chief and its provider. |
| `Unclaimed`, with a dashed outline | A shared task with no owning chief | The chief that unclaimed it can claim it back; another chief needs your takeover gate. |
| `Offered to Codex · C2. It waits for R407 to end, then Codex · C2 accepts.` | Under the step line, and on the task page | An open offer, while a run of the task runs. |
| `Offered to Claude · C1. Ready: Claude · C1 can accept.` | The same | An open offer with no running run. |
| `Hand T320 from Claude · C1 to Codex · C2? R410 and R411 end as failed.` | Needs you | An open takeover gate, with its options and recommendation: `approve, when you know that Claude · C1 stopped`, or after an accept `approve, because Claude · C1 offered T320 to Codex · C2`. Then the offer line says `Codex · C2 asks to take this. Needs you: G7.` |
| `The owning chief, Codex · C2, may have stopped: R412 shows no change for over 24 h.` | Needs you | A running run of the owning chief has no change in the task's rows for over 24 h. Ask any chief to open a takeover gate. |
| A Provider column | The runs of a shared task's page | The provider of each run, from the run's chief in `chiefs.tsv`. A run with no chief shows the dotted stand-in `Unknown`. A finished task of an old logbook stands in with that logbook's provider. |
| `checkout lantern`, under the role | The runs of a shared task's page | The folder of the checkout that the run started from: its name only, never its path. A run from before this line has none. |
| `checkout lantern · gone` | The same | That folder is not on this Mac now, or it is a file or a folder with no Git checkout. A review reads the branch in the folder of the branch's newest implementer, designer or arena judge run: while the task is active and that folder is gone, its mark has the warning colour, and one note under the runs names the folder and the run. Its next review step stops until the folder is back, and any other gone folder is faint. |
| `checkout lantern · not checked` | The same | The board checks at most 64 checkout folders of a logbook, so it did not check this one. |
| `checkout lantern #2` | The same | Two linked checkouts have the folder name lantern. The number is the link order, and it never moves to another folder, also when the other folder is gone. The link prompt and the message after the link (`The board shows this folder as lantern #2`) say which number a folder gets. |
| `sample-owner/lantern · 2 checkouts: lantern, lantern-b` | The second line of a shared project in the project picker | Two or more linked checkouts of the project are on this Mac, in link order. A gone checkout does not count, by the same rule as `· gone` on a run, and one checkout shows `folder lantern`, as before. A folder name shows without control or bidi characters. |
| `A checkout named harbor-new is linked to this logbook, but it has no first commit in common with it.` | Logbook notes, over the board | A row of `bindings.tsv` links that folder to the logbook of another project. The board does not count it as a checkout. Commands in that folder stop: ask the chief there. |
| `was Claude T640` | Under the top line of a card, beside the id on the task page, and in the chat | A task that [the move](using-sage.md#move-an-existing-project) took to the shared logbook, with its old provider and number. It stays for the life of the task. |
| `sage moved to one shared logbook on 2026-11-03 15:44 UTC.` | A banner over the board, and a line at the top of the chat board | The project moved in the last 7 days. The banner names the map page of old and new numbers, `move-map.html`, and the logbook folder that holds it on your Mac. It shows no path, and it says when a finished task of a moved milestone has a new number too. |
| (no banner) | The board | A stopped move waits to finish: the banner shows only after the move ends. The map page gives its time in UTC beside your Mac's time, as the banner does. |
| `Old · Claude · read-only` or `Old · Codex · read-only` | A card in Done, and its task page | A finished task that stayed in its old logbook when the project moved. Its number belongs to the old logbook, and an open gate of it is not in Needs you. On a card in another column, it is an open task that a move did not finish: its hover text and its page say so. |
| `The logbook is changing.` | A note over the board | The board read the logbook 3 times, and it changed during each read. When a part of the last read changed while the board read it, the note names that part, because it does not show. |
| `The owning chief is not in chiefs.tsv.` | The task page | The task names a chief id that `chiefs.tsv` does not list, so the board does not know its provider. The card shows the id. |

- **Who filter:** a shared task shows under its owning chief's provider. An unclaimed task shows only under All, and no button names the shared root.
- **Names and links:** the board takes a shared project's checkout from its row in `bindings.tsv`, because a shared logbook has no `checkout.txt`. So the name and the PR links come from that checkout's GitHub remote.
- **A damaged `bindings.tsv`:** it is a line under the board. The project then shows with its folder name and no PR links.
- **Old logbooks:** the move (a later sage) lists them in `sources.tsv`. The board reads a folder of that list only when it is a logbook folder directly under a Claude or Codex root, not a link, with the move's mark `moved.json`, and its row names that root's provider (one root for both providers, set by `SAGE_HOME`, takes either), in the chat as on the board page. Only the provider words `claude` and `codex` read.
- **A row that the board does not read:** any other row, or a folder that the board cannot read, is one line under Logbook notes. The board stays live, and a live logbook stays on its own.
- **Each old logbook shows once,** in its shared project. A task row that moved shows only in the shared logbook, and Done still shows the last 7 days.
- **Milestones of an old logbook:** a milestone with an open task moved with it, with a new number, so it shows only in the shared logbook. An old logbook shows only its finished milestones, and none of them is in Needs you. Its milestones say `Old Claude` or `Old Codex` where a shared milestone says `Shared`.
- **The changing note:** the board reads a logbook again when it changed during the read, at most 3 times. After the third change, the board page keeps its last good read under the note, and the next read with no change removes it.
- **The changing note in the chat:** the chat board has no earlier read, so it shows its third read with the note. Ask for the board again.
- **Agents:** a run of a shared logbook joins its agent slot in its provider's root. So a Claude run with a slot shows as at work, not as "may be stuck".
- **"Show board" in a session:** the chat board finds a shared project from its checkout, a worktree, a subfolder or another linked clone. A clone with no row does not find a shared project by its folder's name: link it first. A task view (`board T<n> --view task`) shows the task of the shared logbook, also when an old logbook has a task of the same id, and an old finished task when only the old logbook has that id.
- **A shared root that is a link or a file:** sage keeps no shared logbook there, so the board shows one line under Logbook notes and stays live.

## The Agents page

The board server has a page **Agents** (`/agents`). The header of the pages has the tabs "Task board | Releases | Milestones | Agents (n)", where n is the count of agents that run now. The page has the same access check as the task board, and it updates live in the same way.

The Releases tab shows only when a logbook has releases.

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

<!-- The old anchor stays, so that older links to it still work. -->
<a id="programs-on-the-board"></a>

## Milestones on the board

A milestone is a request that sage runs as two or more tasks for one goal, with one pilot task and a breakdown that you approve (see [Milestones](using-sage.md#milestones)).

| Where | What you see |
| --- | --- |
| A card | The milestone with its level and number, for example "◫ Milestone 5: Sage feel", "pilot" on the pilot, and a wait line in place of the Now line: what the task waits for (⧗), or ⊘ when a wait is never met, so the task cannot start. A wait in a loop of waits (a hand edit) says "in a loop" and is never met. |
| The pilot's card, while the breakdown waits for you | A "Milestone approval" band on top and a frame, then the breakdown gate's question as the chief stored it, line by line, and how to answer: approve, change (say what to change) or drop the milestone. Only the gate that the milestone's row names, on its pilot, with the options approve, change and drop, gets the band: a gate that only copies its words is a plain gate. |
| The Milestone filter | The cards of one milestone, or of no milestone. A milestone with no card on the board (its tasks ended more than 7 days ago) says why, with a link to its page. The board keeps the choice in the address (`#pg=`). |
| The Milestones tab (`/milestones`) | Each milestone in a group (Needs you, Active, Done; Dropped is folded) with its state word, goal, progress bar and progress, for example "3 of 7 merged · T10 abandoned", and what moves next: only a task that waits for nothing, then how many tasks wait and which cannot start. A milestone whose breakdown you asked to change is a line here: the chief revises it. |
| A milestone's page (`/milestone/<key>`) | Its goal and progress, the pilot, what moves next, its tasks in order (the pilot first, then each task after the tasks that it waits for), and its latest decisions, as short lines with short dates (for example "17 Oct T2 merged: PR 66"). While the breakdown waits for you, the page shows the breakdown gate in the frame. An unknown milestone gives the page "Milestone not found", with status 404. |
| The chat | A Milestones section with one line for each milestone that is not done. Done milestones, and dropped milestones with no task left in them, are counts, with ": open the board's Milestones tab". A dropped milestone with tasks still in it keeps its line, which asks the chief to take each task out. |

A project with releases shows its milestones in the chat's "Where we are" frame, not in the Milestones section (see [Releases on the board](#releases-on-the-board)). The section keeps a milestone of that project only when the frame does not show it: for example, a dropped milestone with tasks still in it, in a done release. Its line still asks the chief to take each task out.

The offline HTML file holds the milestones list and each milestone's page too, as parts of the one file. Each of its pages has its own theme switch.

## Releases on the board

A release is a version that you ship, such as 1.0. It holds milestones and single tasks (tasks outside a milestone), and it is optional (see [Releases](using-sage.md#releases)). A logbook with no release shows the board as before: no frame, no Releases tab and no release tag.

| Where | What you see |
| --- | --- |
| Above the columns | A "Where we are" frame for each project with releases: boxes inside boxes, release › milestone › task, each with its level, its name and its state word. The project picker shows the chosen project's frame. |
| A card | Its nearest level: its milestone ("◫ Milestone 5: Sage feel"), else its release ("◎ Release 1.0"), else "no release" when its project has releases. |
| The Releases tab (`/releases`) | Each release that is not done, in the order that the chief added them, with its word, its count of done tasks, its goal, and a row for each milestone and single task in it, with its word and what happens next. Then "Not in a release": the open milestones and tasks in no release. Then "Done releases". |
| The chat | A "Where we are" section after Needs you, with the same frame as text in a code block, 46 columns wide. Each task line ends with its nearest level, as on the card. |

The frame follows these rules:

- It shows each release that is not done or stopped, or the last release when all are. Then it shows the open milestones and tasks that are in no release.
- A release box shows how many of its tasks are done. Its single tasks are one box.
- A box names a task by its title, for example "Task: Presentation skill". On the page, the task's id follows in grey.
- A milestone box holds its tasks that need you or are in progress (at most 3). Then it has a box for each other word, with its count.
- A box of waiting tasks says what they wait for, when they all wait for the same thing: for example "Waiting for Presentation skill", or "Waiting for your approval". Else it shows the word alone.
- A box that needs you has a double border. So has a task in progress, which says "you are here".
- A milestone that you dropped, with tasks still in it, says how many and what to do: "2 tasks still in it: ask the chief to take each task out of the milestone."

A release's word comes from its milestones and single tasks: see the rules of the state words above. A release that a milestone or a task names, but that the logbook does not have, says so in its box: ask the chief to add it.

A releases table that the board cannot read is an item in Needs you, with the file and the line; the board then shows the tasks without their releases. The Releases tab says the same for that project ("The releases of sage cannot be read"), and never "No releases yet".

Every line that the owner reads names a milestone by its level: "Milestone 6: Faster reviews", or "milestone 6" inside a sentence ("Waits for your approval of milestone 6"). Two places keep the id: the Milestone filter list, and the text of a gate, which comes from the gate's row.

## The pages of a task

Agents save each task's pages (research, designs, the pages of the chief's messages) in the task's pages folder. The board server also shows these pages, read-only, on the Mac only:

- `http://127.0.0.1:43123/pages/<logbook>/<task>/` is the task's index: a list of its pages, with the size of each.
- `http://127.0.0.1:43123/pages/<logbook>/<task>/<file>` opens one page. For example: `http://127.0.0.1:43123/pages/sage-43265b/T1000/research.html`.

A task page links its index: its top line has the link **Pages** when the task has a pages folder.

The Page block of a message gives this link between its title and its file path ([sage's messages](using-sage.md#sages-messages)). So one link opens the page in the same way in each app: in the Browser pane of the Claude desktop app, in the built-in browser of the Codex app, and in your default browser from a terminal.

The board shows web pages, PDFs, pictures (PNG, JPEG, GIF, WebP and SVG), and Markdown and text files as plain text. It shows no other file: no logbook file, JSON, log, hidden file or link.

A page can be at most 3 parts deep in the task's folder (for example `designs/final/index.html`) and at most 16 MiB. The index lists at most 200 pages.

Each page opens in a sandbox. A page cannot read the board or your files, load a picture, a style or a frame from the board or from another site, or send a form.

A script from another site does not run, but if its `integrity` hash matches the switch, your browser still asks that site for it before it checks the hash. A frame to another site stays blocked, but your browser still opens a connection to that site, and the connection sends its host name.

Only sage's own script runs: the Today switch of a message's page. A page that holds this switch and also an `http-equiv` (for example a refresh) or a `srcdoc` outside sage's own policy tag gets no script, so that a refresh cannot move it: it shows without its switch. When the board cannot judge a page, the page also shows without its switch.

The usual way out of a page is a link that you click in it. Two ways out need no click:

- When a page opens, it can make your browser ask another site for an address, for example with a prerender link. The address can hold any text of the page, so that text can leave the Mac, and the request carries the cookies of that site that `SameSite=Lax` lets through. The board found no header that stops this in Chromium.
- A page that you open with "open with its scripts" (`?scripts=1`) can move itself to another site, by its script or by a meta refresh.

Two warning lines in the index tell you the rest:

- A page may link to sites outside this Mac. When you click such a link, your browser opens that site, and the site gets everything in the link's address.
- The link "open with its scripts" (in the index, for a page with a script of its own) runs the page's own scripts. They cannot read the board or your files, but they can send the page's content to another site. Use it only for a page that you trust.

A link in a page to another page of the board, or to the index, opens when you click it: the board opens a page by a person's click from any site. A page cannot load or fetch anything from the board.

A site that moves you to a page by itself gets "not permitted", and so does a link to "open with its scripts" in a page or on another site: open it from the index. When another site opens the index in a new tab, the index cuts that site's hold on the tab, so the site cannot move the tab or read what a page sends to it.

## Act from the board

The new board page at `/app/` shows the chiefs of each project under the top bar: a green dot for a live chief, a yellow dot for a chief that waits for your answer, a ring for a stopped chief, and the autopilot state. With a paired browser, you act from the Overview:

| Action | Clicks from the Overview | What it writes |
| --- | --- | --- |
| Answer a question in Needs you | 1 to open it with its full context (the question message that the chief kept), then pick and Send | `gate answer --via board`. The chief that owns the question applies the answer at its next step. |
| Undo a board answer | 1: Undo, under "Answered · waits for the chief" | `gate undo`, until the chief picks the answer up. |
| Rename a chief | 2: the chief's menu (▾), then Rename | `chief name`. An empty name clears your name. |
| Show only one chief's work | 1: the chief's chip. "All chiefs" shows all again | Nothing: the filter holds on each page, in this browser tab. |
| Give a task of a stopped chief to another chief | 2: Give to another chief, then Open the takeover question | `gate give`. Nothing moves until you answer the takeover question. |
| See what changed since you looked | 0 | The time of your last visit, in the board's state folder. |

The first answer wins. When you answer in a chat or on a card first, the board shows where and when, for example "Answered first in C2's chat at 14:51", and a later board answer is not recorded.

**Pair a browser once.** Until you pair, the board only reads. Do these steps:

1. In Terminal on the Mac, run `node <board folder>/cli.mjs board --pair` (the board folder of the installed plugin, or the installed copy). It prints a one-time code that works for 10 minutes.
2. Open the board. In the card "Pair this browser to act from the board", type the code in the "Pairing code" field, and choose Pair.

If the page shows no pairing card, the board that runs is older than your sage: run the `board --stop` command that `board --pair` prints, ask for the board again, and reload the page. When a browser loses its site data, it pairs again.

The command refuses to run when its input is not a terminal, and the hooks refuse it from an agent.

**What the board checks.** Each write is a POST to `/api/...`, and the server refuses it unless all of these hold:

1. The `Origin` is the board's own address, `Sec-Fetch-Site` is `same-origin`, and the body is JSON. The server answers no CORS preflight, so a page on another site or port cannot send one. A `/pages` page with scripts has the origin `null`, and the server refuses it.
2. The browser has the pairing cookie (`HttpOnly; SameSite=Strict`). The board keeps only its hash, in the board's state folder (`~/.config/sage-board/state`).
3. The request carries the pairing token of the same browser. The server gives it to the page once, when you pair, and keeps only its hash. The page keeps it in `localStorage`, which belongs to the board's own address and port, and a `/pages` page runs in a sandbox without it.
4. An answer names the digest of the question and the options that you saw. When the question changed, the state tool refuses the answer.
5. The board runs only your commands: `gate answer --via board`, `gate undo`, `gate give` and `chief name`, through the state tool, in its own thread. It never claims, accepts or writes a task.

A browser sends the cookie to every server on `127.0.0.1`, also on another port. That server never gets the token, so the cookie alone writes nothing.

The board writes only a shared logbook. A logbook with no checkout on this Mac refuses, and you answer in the chief's chat.

An agent runs as your user, so a script that builds the state folder's path while it runs can still read the cookie's hash file. The sandbox is the full protection.

## The board server

The board server reads your logbooks. It writes only the owner's actions of a paired browser, through the state tool ([Act from the board](#act-from-the-board)).

It does not fetch from GitHub or decide whether a pull request may merge. The state tool still records each change and applies the merge rules.

In Claude and in Codex, `show board` also starts the local board server on the Mac when it is not running (the first time, it sets it up from the standard Claude and Codex roots and the shared root), and the chief shows its address, or why it is not running, next to the chat board. In Codex, this start runs outside Codex's sandbox, so Codex asks you to approve it ([The board in Codex](codex.md#the-board-in-codex)). The board is for a desktop browser on this Mac only, and it needs no sign-in.

The sage hook refuses the ordinary command shapes by which an agent reads, copies or replaces the board config or a file of the board's state folder, lists, searches, copies or moves the board's folder (`~/.config/sage-board/`), or runs `board --pair`. It does not stop a script that builds them while it runs; full protection needs the sandbox.

After you change a setting of the config, or update sage, the line says that a restart is needed: run the `board --stop` command that it gives, then ask for the board again.

Setup never changes a board config that exists. To move the board to another port (1024 to 65535), do these steps in this order:

1. Run `board --stop --config <file>`, with the path of your board config (by default `~/.config/sage-board/board.json`). Do this first: `--stop` looks for the board on the port that the file names.
2. Edit `"port"` in that file.
3. Ask for the board again.

If you edit the port first, `--stop` finds no board on the new port, and the old server runs on.

The [board service guide](../../packages/sage-board/README.md) gives local startup, stable installation and offline export. The server runs independently of a chat.

It listens on loopback and refuses every request that is not from the Mac itself. A task page or a milestone page that is too large to show (over 8 MB) shows its parent page (the board, or the milestones list) with a note, and the rest of the board stays live.

`board --install --login-file` refuses when no upgrade-stable `node` command is on PATH, for example with asdf, Volta, fnm or a keg-only Homebrew Node. To fix it, put a `node` link to the Node that you run the install with in a folder that you own and that is on PATH (for example `~/.local/bin/node`), then run the install again.
