<a href="docs/assets/hero-light.svg">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/hero-dark.svg">
  <img alt="sage: your chief of staff for Claude Code. Send “sage mode” as a message. A hooded toad sage, the chief of staff, meditates in a misty mountain world. Around it, its team on a loop: designer, PE, implementer, arena judge, code reviewer, security reviewer, UX reviewer and QA." src="docs/assets/hero-light.svg" width="100%">
</picture>
</a>

**sage is a plugin for Claude Code (Codex support in progress) that turns a session into your chief of staff.**
You say what you want. A team of agents designs, builds, reviews and tests it, and you get a pull request with evidence. You answer only the product questions, and you look at results, not code.

<p align="center">
  <a href="https://github.com/erickb336/sage/actions/workflows/check.yml"><img alt="checks" src="https://github.com/erickb336/sage/actions/workflows/check.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="licence" src="https://img.shields.io/github/license/erickb336/sage"></a>
</p>

**Status:** early. Claude Code: supported. Codex: in progress. Tested on macOS. See [Status](#status). **Start:** install with two commands, then send `sage mode` alone as a message: see the [Quick start](#quick-start).

**Contents:** [Status](#status) · [Requirements](#requirements) · [Quick start](#quick-start) · [Learn sage in 5 minutes](#learn-sage-in-5-minutes) · [The board](#the-board) · [What to say](#what-to-say) · [How it works](#how-it-works) · [Safety and limits](#safety-and-limits) · [What's new](#whats-new) · [FAQ](#faq) · [All docs](docs/README.md)

## Status

| Area | Status |
| --- | --- |
| Maturity | Early: used daily by its author to build sage itself; one recorded dry run. |
| Claude Code | Supported: sage mode, the team of agents, the rules in code, autopilot and the board. |
| Codex | In progress. Works today: the principles, the writing skills, the advice hooks, and the logbook and the board through manual commands. Not yet: sage mode (the chief and its team) and autopilot. See [sage in Codex](docs/guide/codex.md). |
| Systems | macOS: tested. Linux: not yet tested. Windows: not supported. |
| Planned, not built | A sandbox for agents, and a GitHub identity for agents that cannot merge. Until then, the hook stops mistakes, not an agent that acts on purpose (see [Safety and limits](#safety-and-limits)). |

## Requirements

| You need | For Claude Code | For Codex |
| --- | --- | --- |
| The agent tool | Claude Code, with a Claude plan or API credits | Codex CLI 0.159.2 or later |
| Node.js 20 or later | Yes: every hook runs `node` | Yes |
| git | Yes | Yes, and a clone of this repository |
| The `gh` CLI, logged in (`gh auth login`) | Yes: sage opens pull requests and the merge check reads them | Not for today's features |
| A GitHub remote for your project | Recommended: without one, the work stops at a verified branch | Not for today's features |
| macOS | For the board server and the Remote Control server | For the board server |

## Quick start

This is for Claude Code. For Codex, see [sage in Codex](docs/guide/codex.md).

**1. Install sage.** Run these two commands in a terminal:

```sh
claude plugin marketplace add erickb336/sage
```

You see: `Successfully added marketplace: sage`.

```sh
claude plugin install sage@sage
```

You see: `Successfully installed plugin: sage@sage (scope: user)`. In a Claude Code terminal session, `/plugin marketplace add erickb336/sage` and `/plugin install sage@sage` do the same.

**2. Start a new session** (`claude`) in a project folder, or in a folder of projects such as `~/workspace`. A session that was already open does not get sage.

**3. Switch it on.** Send the on phrase as a message of its own, with no other words:

```text
sage mode
```

You see: the chief says that sage mode is on, and waits for your request.

**4. Say what you want** in the next message:

```text
Ramen Finder: add a favourites list, and fix this week's crash.
```

You see: the chief frames a task for each part, asks its product questions in one batch, then comes back with evidence and a pull request.

<a href="docs/assets/tip-start-light.svg">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/tip-start-dark.svg">
  <img alt="The toad sage's tip: send “sage mode” alone to switch it on, and “sage mode off” alone to switch it off. With any other words, it does nothing." src="docs/assets/tip-start-light.svg" width="100%">
</picture>
</a>

**To update sage**, run `claude plugin update sage@sage` in a terminal, then start a new session. To stop a task, uninstall sage or fix a problem, see [Using sage](docs/guide/using-sage.md).

## Learn sage in 5 minutes

This is one session, step by step. It is an illustration with sample data.

<a href="docs/assets/walkthrough-light.svg">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/walkthrough-dark.svg">
  <img alt="Learn sage in 5 minutes: an illustrative sage mode session about a made-up app, Ramen Finder, with sample data. You send “sage mode” alone, then the request: add a favourites list, and fix this week's crash. The chief frames T1, favourites, as large with the data flag, and T2, the crash, as small with the input flag, and starts T2. It asks one question for T1: sync favourites across devices? Recommended, and the default if you don't answer: not now. T2 goes through build, code review, security review and QA; repair round 1 fixes an empty search that still crashed. T2 is verified, and pull request #41 is ready for you." src="docs/assets/walkthrough-light.svg" width="100%">
</picture>
</a>

1. **Switch it on.** Send `sage mode` as a message of its own, then your request in the next message. Sage mode stays on until you send `sage mode off` alone.
2. **The chief frames each task.** It gives each task a size (tiny, small, large or investigate) and risk flags, such as `data` for personal data or `input` for outside input. The size and the flags give the task its [route](#routes): the steps it must go through.
3. **One batch of questions, at most.** The chief interrupts you at most once per task, with all its product questions, each with a recommendation and a default. A product question is one whose answer you would notice: what you see, which data is kept, who can do what. Irreversible actions still get their own yes. The chief decides engineering choices itself and logs them. The [four exceptions](docs/guide/using-sage.md#when-the-chief-asks-you) are in the guide.
4. **The team works.** For each step, the chief starts a fresh agent with a full brief. Reviews and QA report findings. A medium or high finding goes back to an implementer for a repair, at most 3 rounds. Then the task needs its clean cycles on the final commit.
5. **You get results.** You get evidence (the commands that ran, screenshots), what was not checked, and a pull request. You merge it, or autopilot merges it.

**Try it yourself.** Pick one small, real bug in a project that has tests and a GitHub remote. Send `sage mode`, then describe the bug. Then look at the result, not the code. From your phone, it works the same through [Remote Control](docs/guide/remote-control.md).

<a href="docs/assets/tip-try-light.svg">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/tip-try-dark.svg">
  <img alt="The toad sage's tip: try it on one small, real bug, from your phone. Then look at the result, not the code." src="docs/assets/tip-try-light.svg" width="100%">
</picture>
</a>

## The board

The board shows every project's logbook: what needs you, the agents that run now, and each task in its column. In the chat, send `show board`. On the Mac, the same message also starts a local board page in your browser.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/board-dark.png">
  <img alt="The board page with SAMPLE DATA: a project picker, a Needs you strip, a filter bar, and six columns from Backlog to Done, with a card for each made-up task." src="docs/assets/board-light.png" width="100%">
</picture>

*The screenshot shows sample data: every task and program in it is made up.*

| Send | You see |
| --- | --- |
| `show board` | The tasks of the current project, in the chat, and the address of the board page. |
| `show board for all` | The tasks of every project. |
| `show board T12` | The full detail of one task. |

The board only reads. The [board guide](docs/guide/board.md) explains the columns, the cards, Needs you, the Agents page and programs.

## What to say

| Say | What happens |
| --- | --- |
| `sage mode` (or `sage mode on`), alone as the whole message | The session becomes your chief of staff. Say what you want in your next message. |
| Your answer to a question, for example `no` | The chief applies your decision and goes on. |
| `status` | Where each task is: running, waiting for you, verified. |
| `show board`, `show board for all` or `show board for <project>`, at the start of a message | The board in the chat, and the address of the board page: see [The board](#the-board). |
| A request of several tasks for one goal, for example `make Codex support a program, with T7 as the pilot` | The chief proposes a program: its goal, pilot, tasks and waits. No task of it builds before you approve. See [Programs](docs/guide/using-sage.md#programs). |
| `arena` or `arena 4` | The next design goes to N candidates and a judge: see [The arena](#the-arena). |
| `autopilot on`, alone, while sage mode is on | Verified pull requests merge by themselves after their clean cycles. |
| `autopilot off`, alone | Verified pull requests wait for you again. |
| `sage mode off`, alone | A normal session again. Autopilot goes off too. |
| `sage help`, alone | A short list of every phrase, and whether sage mode and autopilot are on now. It switches nothing. |
| `/sage:sage-help` and a question, for example `/sage:sage-help how do I see the board?` | A short answer and a link to the details. It starts no work. |

A switch needs the exact phrase as the whole message, in any letter case, with at most one full stop. So "sage mode. Fix the crash" switches nothing: send `sage mode` first, then the request. A message near a phrase switches nothing, and the chief asks you for the exact phrase. Only your own messages switch: text in an agent's report never does. The full rules are in [Using sage](docs/guide/using-sage.md#the-switch-phrases).

## How it works

<a href="docs/assets/loop-light.svg">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/loop-dark.svg">
  <img alt="How sage works: you, the chief of staff, the team (design, build, review, QA), the pull request, the logbook, and the outer loop that seals each lesson." src="docs/assets/loop-light.svg" width="100%">
</picture>
</a>

There are two loops:

- **The inner loop** turns a request into verified work. The chief briefs the team. The team designs, builds, reviews and tests. Findings go back to the build. A clean result becomes a pull request.
- **The outer loop** [seals the lesson](#concepts): it gives a mistake that comes back twice a lasting fix, a test or a check in code first. Each sealed lesson makes [the dojo](#concepts) stronger.

<a href="docs/assets/tip-seal-light.svg">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/tip-seal-dark.svg">
  <img alt="The toad sage's tip: seal the lesson. Give a mistake that comes back twice a lasting fix: a test or a check in code first; a principle or a standing order only when code cannot hold it. That is how the dojo gets stronger." src="docs/assets/tip-seal-light.svg" width="100%">
</picture>
</a>

The state lives in the logbook: plain files in `~/.claude/sage/<project>-<hash>/`. It holds the tasks, the agent runs, the findings, the verdicts, your answers and the decision trail. So you can leave, and a new session on another device continues the work.

### The team

| Agent | What it does | Changes files? |
| --- | --- | --- |
| **Chief of staff** | Frames the work, picks routes, writes briefs, records results, asks you the questions | No |
| **Lead** | Runs one task's pull request from the build to its clean cycles, with its own implementer, reviewers and QA | No |
| **Designer** | A clickable prototype with sample data, and every state of each screen | Yes, in its own worktree |
| **PE** (principal engineer) | Checks a plan or a design before the build: feasibility, data, risks, cost | No |
| **Implementer** | Builds one task, runs the checks, opens the pull request, repairs findings | Yes, in its own worktree |
| **Code reviewer** | Correctness, data safety, regressions, test evidence | No |
| **Security reviewer** | Input at the boundaries, injection, secrets, access | No |
| **UX reviewer** | The flow, the states, the copy and accessibility | No |
| **QA** | Runs the checks and the real app, and tries to break it | No |
| **Arena judge** | Scores an arena's candidates and grafts the best parts into one | Yes, the final version |

Only one agent writes on a branch at a time. Reviewers start fresh, so they don't share the builder's blind spots. How the lead and the models work: see [Using sage](docs/guide/using-sage.md#the-lead-and-the-models).

### Routes

Each task gets the least route for its size. The chief can add steps, never remove these.

<a href="docs/assets/routes-light.svg">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/routes-dark.svg">
  <img alt="Routes by size. Tiny: build. Small: build, code review, QA. Large: design, PE check, you approve, build, code review, security review, UX review, QA. Investigate: gather evidence, evidence review, a proposal to you. A risk flag adds the security review to every size except investigate, which changes no code." src="docs/assets/routes-light.svg" width="100%">
</picture>
</a>

### A task's life

<a href="docs/assets/lifecycle-light.svg">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/lifecycle-dark.svg">
  <img alt="A task's states: framed, briefed, building, reviewing, verifying, verified, merged. A product question moves a building task to held until your answer. Findings to fix, or a QA fail, move it from verifying to repairing, and the next round goes back to reviewing, at most 3 rounds. Verified needs 1 clean cycle; autopilot merges after 1 for a tiny or small task, 2 for a large or risky one." src="docs/assets/lifecycle-light.svg" width="100%">
</picture>
</a>

A **cycle** is one full set of fresh reviews and QA on one commit. A task is **verified** after 1 clean cycle. With autopilot on, it **merges** after its clean cycles on the same commit: 1 for a tiny or small task, 2 for a large task or any task with a risk flag. A new commit starts again from cycle 1.

### The arena

When a design has no clear answer, the chief can run an **arena**. You can also ask for one: `arena` or `arena 4`.

<a href="docs/assets/arena-light.svg">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/arena-dark.svg">
  <img alt="The arena: one brief and a hidden rubric, three candidates on a mix of Claude models, an arena judge, one final version." src="docs/assets/arena-light.svg" width="100%">
</picture>
</a>

N candidates (3 by default) get the same brief, each with a different angle. A judge scores them against a rubric that they do not see, and grafts the best parts into one final version. That version goes through reviews and QA like any build. The candidates never merge.

## Safety and limits

sage keeps its important rules in code, because a rule written only in a prompt fades over a long session. A hook checks each action, and a state tool refuses a wrong move.

| sage stops | sage does not stop |
| --- | --- |
| An agent that pushes to main, force-pushes or merges. Work reaches main only through a pull request. | An agent that hides a command from the hook on purpose, for example with a script that builds it while it runs. The sandbox for this is planned. |
| A merge of a commit without its clean cycles on that exact commit. | A person or an agent with your GitHub token that removes branch protection or merges. A separate GitHub identity for agents is planned. |
| The chief editing your files: it frames, briefs and records only. | A deploy or a deletion on autopilot: the chief's instructions ask you first, but code does not hold that rule yet. |
| A switch of sage mode or autopilot by an agent's text. Only your own whole message switches. | The cost of many agents: each agent is a separate run on your plan's limits or API credits. |
| An agent that lists or signals your processes, or uses `git stash`. | A mistake in your own merge: you still review the result before you merge. |
| Two writers on one branch, and an unreviewed finding: each finding gets a fix, a dismissal with a reason, or a question to you. | Work on a project without tests: QA can only check by running the app. |

Autopilot is off until you turn it on. Every rule and its reason are in [Rules held in code](docs/design/rules-in-code.md). To report a security problem, see [SECURITY.md](SECURITY.md).

## What's new

> **Warning:** before you use waits or programs, update sage and restart every session that was already open. An older session still merges a waiting task, or a task of a program that you did not approve.

- **The board page has a new look, and it is dark by default.** Cards sit in trays, every text meets AA contrast in both themes, and the switch at the top changes the theme.
- **Programs: the tasks of one goal, with your approval first.** You approve a program's breakdown before any task of it builds, and its pilot merges first. The board has a Programs tab.
- **A task can wait for other tasks.** It builds and merges only after the tasks that it waits for are merged or concluded.
- **The board has an Agents page and a project picker.** See every agent that runs now in every project, and move between projects in one tap.
- **A switch needs the exact phrase, and `sage help` lists every phrase.** Send `sage mode` alone, then your request.

All changes, with their dates, are in [CHANGELOG.md](CHANGELOG.md).

## Concepts

<!-- The word table comes from writing/dictionary.md: edit it there, then run npm run build. -->

| Word | Meaning |
| --- | --- |
| **Request** | What the owner asks for in the chat, in the owner's words, before sage frames it. |
| **Program** | A request that sage runs as two or more tasks for one goal, where at least one task waits for another. It has a goal, a done condition (a count of merged tasks), a breakdown that the owner approves, and one pilot task. |
| **Task** | One unit of work in one project, with one route and at most one pull request. It may wait for other tasks of its logbook ("waits for": it builds and merges only after they are merged or concluded). It is in at most one program. |
| **Step** | One block of a task's route, done by one agent role: design, arena, pe, build, code-review, security-review, ux-review, qa, investigate, evidence-review. |
| **Route** | The ordered steps of one task, set by its size and risk flags. |
| **Run** | One agent's work on one step of a task, from brief to report; it has an id such as R12. Also the PE check of a breakdown. |
| **Agent** | A Claude Code subagent that does one run; the role (implementer, qa, …) says what it does. |
| **Chief** | The chief of staff: the main session that frames tasks, writes briefs, records the state and asks the owner; it changes no files. It frames programs too. |
| **Brief** | What the chief gives an agent at the start of a run, in the ten fields (GOAL to STANDING). A task that waits for others gets their final reports in full in CONTEXT. |
| **Report** | What an agent gives back at the end of a run, in the seven fields (STATUS to BRANCH). |
| **Artifact** | A file or record that a run takes in or gives out and sage keeps: a brief, report, steer message, transcript, branch, commit or pull request. |
| **Finding** | One problem that a review or QA reports, with a severity (high, medium or low), a triage and a status. |
| **Verdict** | The result of one check (checks, a review, QA) on one head commit, kept in the ledger by SHA and cycle. |
| **Cycle** | One full set of fresh reviews and QA on one head commit; a new commit starts again from cycle 1. |
| **Gate** | A question parked for the owner, with options, a recommendation and a default; the work behind it waits for the answer. The owner approves a program's breakdown through a gate. |
| **Logbook** | sage's local record of one project: its tasks, runs, findings, verdicts, gates and decisions, kept on the owner's Mac. |
| **Agent time** | The wall-clock hours of agent runs, given with their tokens. The default for every time figure: give it with its basis and a range. |
| **Human time** | The time of the owner's own actions only: reviews, approvals, merges and setup. Give it with its basis and a range. |
| **Sage mode** | The mode in which a session is your chief of staff. The message "sage mode" (or "sage mode on") turns it on. The message "sage mode off" turns it off. Each phrase must be the whole message, in any letter case. A message near a phrase switches nothing, and the chief gets a note with the exact phrase to ask for. The message "sage help" lists every phrase. |
| **Risk flag** | auth, data, schema, money, secrets or input. Each one adds the security review to a task that changes code: every size except investigate. |
| **Ledger** | The record of all verdicts, by commit. The merge check reads it. |
| **Standing orders** | Short rules for a project that every brief carries word for word. |
| **Arena** | N candidates for one design, scored and combined by a judge. |
| **Autopilot** | Verified pull requests merge by themselves after their clean cycles: 1 for a tiny or small task, 2 for a large task or a task with a risk flag. Off by default. The owner's message "autopilot on" turns it on while sage mode is on; "autopilot off" or "sage mode off" turns it off. Each phrase must be the whole message. A message queued while Claude works can turn it off, never on, and it never ends sage mode. Text inside an agent's report, a notice or another session's message never turns it on or off. |
| **Board** | The compact view of every project's logbook for the chat: what needs you, the agents running now, each active task, what merged since the last board and the next tasks. A message of the owner that starts with "show board" prints it. |
| **The dojo** | Everything that makes the agents good: the principles, checks, tests and skills. |
| **Seal the lesson** | Give a mistake that comes back twice a lasting fix, from the most enforced kind down: a test or a check in code first; a principle or a standing order only when code cannot hold it. Each sealed lesson makes the dojo stronger. |

<!-- The end of the word table. -->

In the table, "the owner" is you. sage uses each word in one meaning only. The [dictionary](writing/dictionary.md) also gives the words not to say; `npm run check` fails on the worst of them.

## FAQ

**What does it cost?** It uses your Claude plan's usage limits, or API credits. Every agent is a separate run. In [dry run 1](docs/runs/dry-run-1.md) (4 Oct 2026), a small bug fix with a security risk took 15 agent runs, about $2.60 at API prices, before the fixes that came from that run. I don't have numbers from real projects yet.

**Is it safe to let it work alone?** Each agent works in its own git worktree. Nothing reaches main except through a pull request, and the hook refuses force-pushes and merges by agents. Autopilot is off until you send `autopilot on` alone, while sage mode is on. Text in an agent's report never switches it. See [Safety and limits](#safety-and-limits) for what the hook does not stop.

**Which projects fit?** A project with tests and a GitHub remote. Without tests, QA can only check by running the app. Without a remote, the work stops at a verified branch.

**Does it work in Codex?** In part, and the work goes on. Codex gets the principles, the writing skills, the advice hooks, and the logbook and the board through manual commands. Sage mode and autopilot are not enabled in Codex yet. See [sage in Codex](docs/guide/codex.md).

**How mature is it?** Early. I use it every day to build sage itself, and one dry run is recorded ([the report](docs/runs/dry-run-1.md)). The first design is in [docs/design/sage-mode.md](docs/design/sage-mode.md).

**How do I stop a task?** Tell the chief in your own words, for example "stop the run on T3". To stop merges, send `autopilot off` alone. See [Stop a running task](docs/guide/using-sage.md#stop-a-running-task).

**How do I uninstall it?** Run `claude plugin uninstall sage@sage`, then `claude plugin marketplace remove sage`. Your logbooks stay: see [Uninstall sage](docs/guide/using-sage.md#uninstall-sage).

## Principles

A principle is a short rule for one kind of moment, for example "test behaviour, not implementation" when you change a test. sage gives every Claude Code session its principles, also outside sage mode.

<!-- The principles table comes from principles/ and upstream/pstack/: edit them there, then run npm run build. -->

There are 25 principles: 24 are pstack's, by Lauren Tan (MIT), and 1 is sage's own. Where sage has an adapted version of a pstack principle, sage uses it.

<details>
<summary><strong>All 25 principles</strong></summary>

| Principle | Apply when | Text |
| --- | --- | --- |
| attack-the-premise | two or more fixes that share one premise have failed the same check or review | pstack, adapted |
| boundary-discipline | reviewing or writing validation, error handling or framework adapters | pstack, adapted |
| build-the-lever | any non-trivial work, not just bulk work: edits, migrations, analyses, checks | pstack |
| contextualize-and-write-for-the-reader | writing anything someone else will read later: a design, a handoff, findings, a report, a verification, a brief, a reply | sage's own |
| encode-lessons-in-structure | writing the same instruction a second time, or noticing a correction that keeps recurring | pstack, adapted |
| exhaust-the-design-space | a new interaction or an architectural choice has no precedent in the code | pstack, adapted |
| experience-first | a product, UX or scope trade-off comes up | pstack, adapted |
| explain-the-number | before you trust, report, or act on a number you measured: a speedup, a regression, a throughput, a latency, or an eval result | pstack |
| fix-root-causes | debugging a failure or repairing a finding | pstack, adapted |
| foundational-thinking | before writing logic, when choosing core types and data structures or ordering scaffold against features | pstack, adapted |
| guard-the-context-window | context is filling up: large outputs, long files, repeated reads, fan-out planning | pstack |
| laziness-protocol | refactoring, judging a diff's size, or tempted to add an abstraction, a layer or a threaded signal | pstack, adapted |
| make-operations-idempotent | designing commands, lifecycle steps, or processing loops that run amid crashes, restarts, and retries | pstack |
| migrate-callers-then-delete-legacy-apis | a change introduces a new internal API while callers of the old one still exist | pstack, adapted |
| minimize-reader-load | reviewing or shaping code that is hard to follow | pstack, adapted |
| model-the-domain | writing stateful logic, or when code branches a lot or repeats a shape assumption across files | pstack |
| never-block-on-the-human | tempted to ask "should I do X?" about reversible work | pstack, adapted |
| outcome-oriented-execution | during planned rewrites and migrations with explicit phase boundaries | pstack |
| prove-it-works | before declaring a task done, or when judging a claim that something works | pstack, adapted |
| redesign-from-first-principles | integrating a new requirement into an existing design | pstack |
| separate-before-serializing-shared-state | concurrent actors might write to the same file, branch, key, or state object | pstack |
| sequence-verifiable-units | multi-step work (a sweep, a migration, a run of similar edits) or the order of commits in a change | pstack, adapted |
| subtract-before-you-add | ordering an addition, a refactor or a rewrite | pstack, adapted |
| test-behavior-not-implementation | writing, changing or keeping a test | pstack, adapted |
| type-system-discipline | designing types, reviewing a function signature, or writing code in any statically-typed language | pstack |

Every principle except sage's own is pstack's, by Lauren Tan (MIT). "pstack" is pstack's text as it is, from `upstream/pstack/`. "pstack, adapted" means that sage changed the wording: it is shorter, and it follows sage's writing standard. Its `upstream:` fingerprint records which pstack text it was checked against. "sage's own" has no pstack source.

</details>

<!-- The end of the principles table. -->

Agents seldom load a skill by themselves, so a **hook** gives the principle at the moment it applies, once per session.

| The moment | The principles it gets |
| --- | --- |
| The request asks for a design, a plan or a new feature | exhaust-the-design-space, experience-first, foundational-thinking |
| The request asks for a refactor or a cleanup | subtract-before-you-add, laziness-protocol, migrate-callers-then-delete-legacy-apis |
| The agent is about to change a test file | test-behavior-not-implementation |
| The agent is about to write a document | contextualize-and-write-for-the-reader |
| The agent is about to write or change a README | readme-guide (not a principle: the README guide) |
| The agent is about to commit | sequence-verifiable-units |
| A check fails | fix-root-causes |
| Two changes in a row do not make the same check pass | attack-the-premise |

The hook also has **one check**, the stop check. When the agent tries to finish, the code changed, and no check ran after the change, it stops the agent once. The agent must run a check or say what it did not verify.

### Following pstack

pstack changes often. sage follows it so that you don't have to: a weekly sync brings pstack's principles in, and sage's adapted versions win. [CONTRIBUTING.md](CONTRIBUTING.md#following-pstack) shows how.

## Under the hood

| Path | What it is |
| --- | --- |
| `packages/` | The sources: shared core, the Claude Code and Codex parts, and the board server. |
| `plugins/sage/`, `plugins/sage-codex/` | The built plugins for Claude Code and Codex. Never edit them by hand. |
| `principles/`, `upstream/pstack/`, `writing/`, `preferences/` | The principles (sage's and pstack's), the writing standard, the dictionary and the author's working preferences. |
| `docs/` | The guides, the design pages, the dry run report and the README's graphics: see the [docs index](docs/README.md). |
| `scripts/` | The build, the checks, the tests, and the scripts that draw the graphics and take the board screenshots. |

To change sage, build it and run its checks, see [CONTRIBUTING.md](CONTRIBUTING.md).

## Credits

- **[pstack](https://github.com/cursor/plugins/tree/main/pstack) and poteto mode, by [Lauren Tan (poteto)](https://github.com/poteto).** sage's principles come from pstack, and sage mode takes its main ideas from poteto mode: the chief that never writes code, the brief, the ledger of verdicts by commit, the arena, and the trust ladder. Thank you, Lauren. I adopted pstack the day I found it.
- **Sage Mode in *Naruto*, by Masashi Kishimoto**, gave the name and the look: a sage stays still and gathers the energy around it, as the chief gathers its team's work. The graphics and the toad sage mascot are original drawings, and no character from the series appears. sage is a fan's nod and is not affiliated with *Naruto* or its owners.
- **My [Orchestrator](https://github.com/erickb336/orchestrator)** taught the lessons that sage keeps in code.
- **[affectUI](https://github.com/flohoeller/affectui), by Florian Höller (adfects)**, MIT licence: some colour, shadow, radius and easing values of the board page come from its free items. The board copies no code, component or font.
- **Anthropic's and Cognition's writing on multi-agent systems** shaped the rules: one writer at a time, fresh reviewers, and evidence before a claim.

## Licence

MIT. pstack's text keeps pstack's MIT licence: see [upstream/pstack/LICENSE](upstream/pstack/LICENSE) and [principles/LICENSE-pstack](principles/LICENSE-pstack).
