---
name: sage
description: "The state tool of sage mode: records tasks, routes, agent runs, findings, verdicts by head SHA and the user's gates in ~/.claude/sage/<project>/. Use in sage mode for every change of a task's state, and before any merge. Claude Code only."
license: MIT
---

# The sage state tool

The chief of staff keeps the work in the project's logbook, not in the conversation. Then a session on the phone or the desktop can continue it. Each command prints one line. A refused command prints the reason and exits with 1: do what the reason says, and do not work around it.

Run it as `node ${CLAUDE_SKILL_DIR}/sage.mjs <command> --project <path to the project>`: node and the absolute path, without quotes. In the sandbox, only this form runs outside it; a quoted path, a variable, a `cd … &&` or a pipe stays inside, and the logbook write fails.

Each option takes a value: `--name value`, or `--name=value` for a value that starts with `--`. A command refuses an option that it does not take, and names the options that it takes. It refuses an option given twice.

In a shared logbook, each write names its actor: the chief adds `--chief C<n>`, and a lead adds `--lead R<n>`, its own lead run. The hook names the id at the first write and refuses another chief's id, also when a value is in quotes. It reads a write that is one command of its own: after `cd` or in a pipe, it names no id.

A reference path in this skill, such as `skills/sage/references/<name>.md` or `core/references/<name>.md`, is a file in the sage plugin's folder: your start text names that folder, and it is also two folders above this skill's own folder. Read a reference only when its trigger holds.

Read `skills/sage/references/hook-rules.md` when the sage hook refuses a command or a file change, and before you tell an agent in a brief which commands it may run.

## Commands

Each line gives a command and the start of its rules. The reference of its group has the full row.

### The common commands

Read `skills/sage/references/commands.md` for the full row of a command before you use an option or a value that its line here does not explain, for the priority scale and the kind list of `task add`, before you end an investigation, and when a command refuses and its reason is not clear.

| Command | Does |
| --- | --- |
| `init` | Makes the project's logbook and its standing orders. |
| `standing` · `standing add "<order>"` | Prints the standing orders as written, or adds one. |
| `task add --title "<t>" --size tiny\|small\|large\|investigate [--risk auth,data,schema,money,secrets,input] [--add <blocks> --why "<reason>"] --priority P0\|P1\|P2\|P3 [--kind <kind>] [--waits <T,T>] [--milestone <M>]` | Frames a task and its route. |
| `task <T> set priority=P0\|P1\|P2\|P3` · `task <T> set kind=<kind>\|none` | Sets the task's priority, or sets or clears (`none`) its kind, from the lists of `task add`. |
| `task <T> set waits=<T,T>` · `waits=` (or `waits=none`) | Sets or clears the tasks that this task waits for. |
| `config name="<name>"` · `config archived=yes\|no` · `config start=sage-mode\|normal` | Sets a key of the project's own logbook, in `config.json` of its logbook folder (not the config for all projects). |
| `task <T> set state=<state> [branch=<b>] [pr=<n>]` | Moves the task. |
| `round <T> [--why "<reason>"]` | Starts a repair round on the open findings marked fix, also on low findings only, and names the roles to re-run on the repair's diff. |
| `run add <T> --role <role> [--branch <b>] [--candidate <k>]` · `run done <R> --status done\|blocked\|question\|failed [--tokens <n>] [--report <path>]` | Records an agent run. |
| `finding add <T> --source <role> --severity high\|medium\|low --summary "<s>" [--key <K>] [--run <R>] [--class <class>]` | Records a finding. |
| `finding triage <T> <K> fix\|dismiss\|ask [--reason "<r>"] [--proof <R>]` · `finding close <T> <K>` | Triage every finding; `--proof` names the proof check that reran it. |
| `finding move <T> <K> --to "<title>" [--size tiny\|small\|large]` | Moves an open medium or low finding to a new follow-up task (small by default), which it frames. |
| `verdict <T> --sha <sha> --kind <kind> [--cycle <n>] [--pr <n>] [--run <R>]` | Records a verdict on a head SHA. |
| `lint <T> --sha <sha>` | Scans the lines that the head adds, with the rules of its base's root `sgconfig.yml`, and records lint-pass or lint-fail. |
| `gate add <T> --question "<q>" --options "<a\|b>" --recommend <a> [--default <a>]` · `gate answer <G> --option <n> --project <folder>` · `gate answer <G> --other-hex <hex> --project <folder>` | Parks a question for the user, with your recommendation and the default. |
| `log <T\|-> "<decision>" --why "<reason>"` | Adds a line to the decision trail. |
| `pages <T>` · `pages <T> record <file>` · `pages <T> record --run <R> --text <report>` | Makes (mode 700) and prints the folder where agents save the task's pages (research, designs, findings pages). |
| `board [this\|all\|<project>\|<T>] [--view chat\|task\|status\|html]` · `board --name-hex <hex>` | Prints the board: the chat board by default. |
| `stats [--task <T>]` | Prints the 50 tasks with the most review tokens, largest first. |
| `worktrees` · `worktrees prune --yes` | Lists the git worktrees of the project's repository, one line each. |
| `status` | Prints the status lines. |

### The logbook

Read `core/references/logbook-recovery.md` before any `logbook repair`, and when a command refuses for a table of the logbook or for a saved change that cannot finish.

| Command | Does |
| --- | --- |
| `logbook` · `logbook repair --accept-loss <table>[,<table>...]` · `logbook repair --accept-change-loss yes` | Prints the logbook's folder. |

### Milestones and releases

Read `skills/sage/references/milestones.md` before you propose a milestone, put a task in one or take it out, add a release or put a milestone or a single task in one, and when a milestone or a release refuses a step.

| Command | Does |
| --- | --- |
| `milestone propose --name "<name>" --goal "<goal>" --pilot <T> --tasks <T,T>` · `milestone propose <M> [--name "<name>"] [--goal "<goal>"] [--pilot <T>] [--tasks <T,T>\|none]` | Writes a milestone (`M1`, `M2`, …) for a request of two or more tasks with one goal. |
| `task <T> set milestone=<M>` · `milestone=none` (or `milestone=`) | Puts the task in a milestone, or takes it out, for a task that joins later. |

### The merge check and the config

Read `skills/sage/references/merge-check-and-config.md` before a merge check of a shared pull request, a takeover or a clean merge of main, before you set a config key, and when the merge check refuses.

| Command | Does |
| --- | --- |
| `merge-check --sha <sha> [--pr <n> [--head <branch>]] [--cycles <n>] [--chief C<n>]` | Says if the full SHA may merge. |
| `config [key=n ...]` | Prints or sets max_agents, max_leads, cycles.small, cycles.large, cycles.risk, max_rounds, arena and cap_total for all projects, and `cap.<project>=n` for one project's agent cap. |

### A shared logbook

Read `skills/sage/references/shared-logbook.md` before you run `link`, `move`, `claim`, `offer`, `cancel`, `accept`, `unclaim`, `gate replace` or `projects rebuild`, and when a command refuses for another chief or a legacy logbook.

## References

These rules have no command row of their own. Read a file when its trigger holds:

- Read `core/references/cycles-and-merges.md` when you need a cycle rule that your start text does not give: a verdict that clears or blocks a SHA, a clean merge of main, two tasks on one pull request, or an abandoned task's verdicts.
- Read `core/references/round-hold.md` when `round` says held, and before you give an extra round in autopilot.
- Read `core/references/sessions.md` when a command says that the logbook is busy, refuses for a lock, or refuses for a newer version of sage.
- Read `core/references/hidden-characters.md` when the tool prints `\xNN` or `\u{N}`, or keeps a character out of a cell or the standing orders.
