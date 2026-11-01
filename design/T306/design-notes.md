# T306 shared project logbook: design contract for owner approval

This page is the contract for one logbook per project, shared by Claude and Codex. It closes each finding of the first PE review (R2023), applies each change of the second PE review (R2047), and adds the move of existing projects.

## For the owner

**What you approve**

- Each project has one logbook that Claude and Codex both use. Each task has one chief that can change it.
- A new project keeps working as today until the move ships. An existing project moves only when you say so, in one gate.
- Open tasks move with new numbers. Finished tasks stay read-only in the old logbooks, with a label on the board.
- If a write stopped half way, the next writer finishes it, or undoes it when no receipt shows that it was committed.
- Four choices stand, and they come with this approval:
  1. Open findings move with new keys.
  2. A moved task starts unclaimed.
  3. A fork with the same first commit refuses and offers link or separate.
  4. In the move gate you may confirm that a provider is unused.

**What it costs**

| Item | Estimate |
| --- | --- |
| Tokens | About 20 to 45 M |
| Agent time | About 21 to 42 h |
| Your time | About 30 to 60 min |

These figures are estimates for seven PRs. They have no measured basis.

**What stays limited**

- The ownership check prevents mistakes. It does not stop a hostile agent.
- Sage cannot see that a chief ended. You use a Replace gate for a chief that stopped. Each open task needs one if a Claude resume changes its session id; PR 3 tests this first.
- A project with no commits, or an existing project that you move on disk before T74, starts a new logbook in silence, as it does today.
- There is no sync between machines.

**What I need from you:** approval of this contract and the sample. No other decision is open. This page itself grants no build approval.

## About this page

- **Main point:** each project has one logbook in a new shared root. Each task has one owning chief. Any writer settles a saved change first. Existing projects move by an explicit command: open tasks get new numbers, and finished tasks stay read-only in the old logbooks.
- **Where it fits:** the Codex design task T73 made the first sample and the owner decided its three gates. The first PE review found eleven gaps, and the second PE review asked for ten contract changes. This revision applies them. The next step is the owner's final approval, then PR 1 of the plan in "Build plan".
- **Sample:** open `index.html` from this folder. It has no backend. Reload resets it. Every value is sample data. Its buttons simulate the chief's commands and the owner's answers; the real board stays read-only.

**Entry point (standing order 36):** the owner updates the sage plugin in Claude and in Codex. After T74, a new project starts shared with no action when both providers are known. For an existing project, the owner tells either chief to move it, and answers one gate.

**A note on task numbers.** "T74" in this page is the number in the Codex logbook. T74 in the Claude logbook is an unrelated docs task. This is the clash that F5 removes.

## The findings and where each one closes

| Finding | Decision | Section |
| --- | --- | --- |
| F1 (high) | A pending write is per project. Any writer settles it as its first step under the lock, from the marker alone. One project's pending write does not stop other projects' merges. | [Saved changes](#saved-changes-and-lost-replies-f1-f10) |
| F2 (high) | One resolution order. Cut-over is an explicit command after both plugins update. It writes a moved marker that both providers obey, and it needs zero running runs. | [Find the logbook](#find-the-logbook-f2-f3), [The move](#the-move-t74-f2-f5-f7) |
| F3 | Bindings live in a protected table in the shared root, keyed by the validated project root path. A move, a copy and a clone follow one rule: no row, refuse, explicit link. The folder name stays `<slug>-<6 hex>`. | [Find the logbook](#find-the-logbook-f2-f3) |
| F4 | Four writer classes, one guard point. The check prevents mistakes; it does not stop a hostile agent. | [Writer classes](#writer-classes-and-the-guard-f4) |
| F5 | Never import an old number. The new sequence starts above the highest number in both old logbooks, for T, R, G and PG. A migrated task keeps its old branch through its adoption record. | [The move](#the-move-t74-f2-f5-f7) |
| F6 | One checkout for each binding. A branch resolves through the checkout that dispatched the run. | [Runs and reports](#runs-checkouts-and-reports-f6-f7) |
| F7 | Keep a late report for a run that ended as blocked or failed. It backs no verdict. The move copies no verdict or kept report, and a moved open task gets fresh reviews. | [Runs and reports](#runs-checkouts-and-reports-f6-f7), [The move](#the-move-t74-f2-f5-f7) |
| F8 | Provider model keys stay per provider. Cycle counts live in the shared root. Both hooks protect the new root. `.hooks` stay per provider. | [Config and hooks](#config-and-hooks-f8) |
| F9 | The board compares the folder before and after a read, retries, then shows a "changing" note. It reads hook notes from the provider roots and tables from the shared root. Runs get a provider column. | [The board](#the-board-f9) |
| F10 | Keep T and R numbers inside a logbook. Use the taskVersion hash as the expected revision. Drop durable refused receipts. | [Data](#data-f3-f8-f10), [Saved changes](#saved-changes-and-lost-replies-f1-f10) |
| F11 | A run ending does not advance a waiting transfer. This page says "owning chief" for a chief and "owner" only for the person. | [Commands](#commands-f11) |
| Dead chief | Neither provider has an end signal wired. A dead chief is "unknown" and uses Replace. V1 designs no reclaim evidence. | [Commands](#commands-f11) |

## The second PE review and where each change applies

In this table, P1 to P10 are the changes of review R2047. They are not task priorities.

| Change | Decision | Section |
| --- | --- | --- |
| P1 (high) | Drop the decision record. A receipt means roll forward. No receipt means restore "before" and remove the marker. Codex adds one `void` journal event and one settle step. A rejected decision writes no receipt. | [A coordinated write needs a change](#a-coordinated-write-needs-a-change) |
| P2 (high) | Production Codex also sets `SAGE_HOME`. So the launcher passes the shared root as a fixed option, and one helper builds that env. `<SAGE_HOME>/shared` is only the last fallback before the default. | [Data](#data-f3-f8-f10) |
| P3 (high) | Rule 3 stays off until T74. Then it makes a shared logbook only when `plugins.tsv` shows both providers, or the owner recorded a provider as unused. | [Find the logbook](#find-the-logbook-f2-f3), [Build plan](#build-plan) |
| P4 | A lead acts for the chief of its lead run. The table lists every command. | [Writer classes](#writer-classes-and-the-guard-f4) |
| P5 | Step 3 needs a dispatcher by schema across the six consumers. The settle step also covers interrupted writes. | [Saved changes](#saved-changes-and-lost-replies-f1-f10) |
| P6 | Each adapter passes `legacyRoots(env)`, with a small `AGENTS.md` exception. `.mcp.json` gets two more variables. Link and move are MCP tools too. | [Find the logbook](#find-the-logbook-f2-f3), [Config and hooks](#config-and-hooks-f8) |
| P7 | T74 starts with one probe of a Codex MCP write under `~/.claude/sage`. | [The move](#the-move-t74-f2-f5-f7) |
| P8 | The guard runs only at the write that creates a row, with a timeout that refuses. It never runs at a read. | [Why the guard](#why-the-guard) |
| P9 | The program prefix is PG. The move maps waits, program and approvals, and clears a finding's run. The shared root has its own `projects.tsv`. | [Data](#data-f3-f8-f10), [The move](#the-move-t74-f2-f5-f7) |
| P10 | `checkout.txt` stays for legacy logbooks. A scan that reads `shared` is harmless. `cycles.*` writes have one home, `arena` has a row, and the hook scratch rules name the new root. | [Runs and reports](#runs-checkouts-and-reports-f6-f7), [Config and hooks](#config-and-hooks-f8) |

## Owner decisions (not reopened)

- Reclaim happens only after the exact owning chief conclusively ends and its runs and pending changes resolve. Silence, a finished turn or an ended child does not establish an end. Unknown activity retains ownership.
- A transfer waits for active runs to finish and for the recipient's acceptance. The owning chief stays while it waits.
- Linked worktrees share one project identity. Other clones explicitly join the same local logbook.
- There is no cross-machine sync.
- The move (T74) is part of v1. It moves open tasks only, with new numbers. Finished tasks stay read-only in the old logbooks, labelled on the board.

V1 effect of the first rule: the rule stays, but no signal can satisfy it yet. The Claude manifest wires `Stop` and `SubagentStop`, and the Codex manifest wires `SubagentStop`. Neither wires a session end. So normal reclaim never fires in v1, and the sample has no "chief ended" state. A later task may add it by wiring a verified end signal; this contract then needs one new row in the command table.

## Data (F3, F8, F10)

```mermaid
flowchart LR
  subgraph S["Shared root"]
    B["bindings.tsv: one row per checkout"]
    PL["plugins.tsv: one row per provider"]
    PT["projects.tsv: known projects of this root"]
    SC["config.json: cycle counts"]
    L["&lt;slug&gt;-&lt;6 hex&gt;: one logbook per project"]
  end
  subgraph C["Claude root"]
    CH[".hooks, config.json: models, caps"]
    CO["old logbooks, read-only after the move"]
  end
  subgraph X["Codex root"]
    XH[".hooks, config.json: models, caps"]
    XO["old logbooks, read-only after the move"]
  end
  W["Worktree, clone or moved checkout"] --> B --> L
  CO -. "open tasks move once" .-> L
  XO -. "open tasks move once" .-> L
```

**The shared root.** One function picks the root. It takes the first of these that exists:

1. The fixed option from the launcher.
2. `SAGE_SHARED_HOME`.
3. `<SAGE_HOME>/shared`, when `SAGE_HOME` is set.
4. The default, `~/.sage`.

`SAGE_HOME` alone does not mean a test (P2). The Codex runtime sets it to `logbookRoot` in production (`logbook-owner.mjs:14`, `task-authority.mjs:8`, `run-assignment.mjs:11` and `:37`, `run-report.mjs:46`, `preparation.mjs:54`, `interrupted-run.mjs:35`). So the launcher passes the shared root as a fixed option, and each of those places gets its env from one helper. Without this, a real Codex run would use a shared root under the Codex root. Item 3 still keeps a scratch run away from the real root.

A folder scan of a provider root can reach `<SAGE_HOME>/shared`. This is harmless, because that folder has no ledger.

| Record | Fields | Rules |
| --- | --- | --- |
| `bindings.tsv` | `root`, `folder`, `commits`, `at` | One row for each checkout. `root` is the key: the validated project root path (today's `projectRoot`, then `realpath`). `folder` is the logbook. `commits` lists the first commits of the checkout. It is empty for a row made before the first commit, and the next write fills it. Only the state tool writes it, under the root lock. |
| `plugins.tsv` | `provider`, `contract`, `at` | Each provider's state tool writes its own row at its first command. The owner's "unused" answer in the move gate writes a row with `contract` set to `unused`. The move and rule 3 read it. |
| `projects.tsv` | As today | The known project list of the shared root (P9). Each provider root keeps its own. The merge check reads the list of the logbook's root. |
| Logbook folder | `<slug>-<6 hex>` | Today's name rule, computed once at creation and saved in the row. A checkout move never computes it again. A new folder name that is already in use refuses. |
| `chiefs.tsv` (in the logbook) | `id`, `provider`, `native`, `at` | `id` is `C<n>`, a number inside the logbook. `native` is the provider's session identity. A restart or resume with the same identity is the same chief. |
| `tasks.tsv` | adds `chief`, `offer` | `chief` is a `C<n>` or empty. `offer` is empty or holds `{id, from, to}`. |
| `runs.tsv` | adds `chief`, `provider`, `checkout` | The chief that dispatched the run, its provider, and its binding row. |
| `gates.tsv` | adds `kind` | Empty, `replace` or `move`. Only the state tool writes a kind. |
| `sequence.json` (in the logbook) | `T`, `R`, `G`, `PG` | The floors from the move. `nextId` takes the larger of this floor and the highest number in the tables. A new project has no file. |
| `sources.tsv` (in the logbook) | `provider`, `path`, `at` | The old logbooks of this project. The board reads it. |
| `moved.json` (in an old logbook) | `folder`, `at` | The moved marker. |
| `adoption` cell | version 2 | Today's record, with `pr` and `branch` optional. It holds the old provider, task, logbook, branch and PR. |

**Removed by F10.** The T73 draft had project, task and run UUIDs, a monotonic record revision and durable refused receipts. All are gone:

- A task is `T<n>` and a run is `R<n>`, inside one logbook. The logbook is the scope, so no second identity is needed.
- The expected revision is today's `taskVersion`: a hash of the task row. The row now holds `chief` and `offer`, so a claim, offer, cancel or accept changes the hash.
- An ownership generation is also gone, because the hash covers it. If a row returns to exactly the same text, a write that expected that text is safe.
- The offer keeps its short `id`, so that each new offer differs even for the same recipient.

## Find the logbook (F2, F3)

Every command resolves again; no command saves the answer. The order is one list, and the same code runs in both providers.

```mermaid
flowchart TD
  A["Validate the project root"] --> R{"Row in bindings.tsv?"}
  R -- "yes" --> S["Shared logbook"]
  R -- "no" --> M{"Old logbook, either provider?"}
  M -- "yes, with moved marker" --> X["Refuse: run the move again"]
  M -- "yes" --> L["Legacy: use this provider's old logbook"]
  M -- "no" --> I{"Is this init?"}
  I -- "no" --> E["Refuse: no logbook, as today"]
  I -- "yes" --> O{"Rule 3 on, and both providers known?"}
  O -- "no" --> K["New legacy logbook, as today. It can move later."]
  O -- "yes" --> F{"First commit matches a row?"}
  F -- "yes" --> Q["Refuse: link or start separate"]
  F -- "no" --> N["New shared logbook and row"]
```

1. **A binding means shared.**
2. **No binding plus a legacy logbook means legacy.** "Legacy" checks both provider roots, because the folder name is the same under each. Without this, a Claude chief in a Codex-only project would make a new shared logbook and hide the Codex tasks.
3. **Neither means new shared,** with two conditions (P3):
   - Rule 3 stays off until T74. Until then, `init` makes a legacy logbook, as today.
   - After T74, `init` makes a shared logbook only when `plugins.tsv` shows both providers, or the owner has recorded a provider as unused. This is the move gate's answer. Otherwise the project starts legacy and can move later.

**How the core knows both provider roots (P6).** The core must not name a provider's settings. So each adapter passes `legacyRoots(env)` to the core, and the same list goes to every command. `AGENTS.md` gets a small exception, as it has for the board: an adapter may name each provider's logbook settings in that one function.

### Why the guard

F2 says "neither means new shared", and F3 says a moved checkout with no row must refuse. A moved checkout has no row and no legacy logbook, so the two rules collide. The guard separates them: the checkout's first commit (`git rev-list --max-parents=0 HEAD`) is compared with `commits` in every row. A match refuses and offers the link. No match is a new project.

- **When it runs (P8).** Only at the write that creates a row, and never at a read. So it costs nothing on a normal command.
- **Timeout.** The Git call has a timeout. A timeout refuses and creates no row.
- **No commit yet.** A row made before the first commit has empty `commits`. The next write fills them.
- **Same rule for all.** It makes no change in the project, and it treats a move, a copy, a clone and a fork the same way.
- **Limit.** A legacy project moved on disk before T74 has no row. It starts new in silence, as it does today.

The first commit never joins two logbooks. It only stops a silent new logbook. The join needs an explicit link. This keeps the earlier rule that a matching remote, path or number never establishes identity.

**Linked worktrees** resolve to their main checkout through `projectRoot`, so they use its row and need no row of their own.

**The explicit link.** `sage link --to <folder>` adds a row for this checkout. `sage link --separate` adds a row with a new folder. The chief runs either one only after the owner's answer in the chat. A Codex chief uses the MCP tool of the same name (P6). Each command checks the folder under the root lock. A row whose path no longer exists stays until the owner removes it, and it does no harm.

| Situation | Result |
| --- | --- |
| Row names a folder that is missing, or a folder of another project | Refuse reads that claim to be current, and all writes. Offer the link. |
| Two rows for one path | The key is unique; the state tool refuses a damaged table. |
| Repository with no commits, or a folder that is not a Git repository | No first commit, so no guard. A moved folder of this kind starts a new logbook. This is a documented limit. |
| Binding table is unreadable | Refuse. Never fall through to rule 2 or rule 3. |

## Every writer uses one operation

`withLogbook(project, actor, class, fn)` is the one entry for every writer: the CLI, the Codex MCP tools, report acceptance, readiness changes and stop hooks.

1. Resolve the logbook.
2. Take its lock.
3. Settle a saved change, if one exists.
4. Run today's integrity check.
5. Run the guard for the writer class.
6. Run the command.

## Writer classes and the guard (F4)

This table lists every command of the state tool (P4).

| Class | Commands | Who may write |
| --- | --- | --- |
| Task writes | `task set`, `round`, `run add`, `run done`, `finding add`, `finding triage`, `finding close`, `finding move`, `verdict`, `task-adopt`, `gate add` on a task, `program propose`, offer, cancel, release, `log` on a task | The owning chief of the task, or a lead that acts for it. `program propose` needs this for its pilot and for each task it names. |
| New tasks | `task add`, the follow-up task of `finding move`, `claim` | `task add` and `finding move` give the new task to the chief that adds it. An unclaimed task takes `claim`. |
| Any chief | `gate add` for a `replace` or `move` gate, `init`, `link`, `logbook move`, `logbook repair`, `projects rebuild`, `standing add`, `config`, `log` with no task, `pages record`, `observe`, `run usage` | Any chief of the project. `logbook repair`, `projects rebuild`, `link` and `logbook move` still need the owner's answer. `pages record`, `observe` and `run usage` add evidence and change no task, so a transfer cannot lose them. |
| Gate answers | `gate answer` | The owner's own words, from either provider, by today's rule. The hook of the session that holds the owner's message checks them. |
| Stop hooks | Keep a report, end a run | The hook writes only the run of its own slot. It needs no owning chief, so a transfer or Replace cannot lose a report. |
| Reads | `status`, `stats`, `board`, `merge-check`, `task <T>` with no change, `logbook` with no subcommand, `standing` with no subcommand, `pages <T>`, `config` with no value | No guard. A read that takes the lock settles a saved change only. |

The guard is one function in core, called from step 5. No command has its own ownership check.

**How the tool knows the actor.** The Codex MCP tools already read the native root identity. The Claude CLI has no such input, so each chief command carries `--chief C<n>`. The Claude hook knows the session and refuses a value that does not match this session's row.

**A lead acts for the chief of its lead run (P4).** The lead run's row names its `chief`, so the guard treats the lead as that chief, on the task of that run only. A transfer waits for the lead run to end. Replace ends the lead run as failed, so the lead can write nothing after it. Other children never run chief commands, as today.

**Limit.** The check prevents mistakes by normal agents. It does not stop a hostile agent, which can give another chief's id. This follows standing order 49.

## Commands (F11)

| Command | Conditions | Change |
| --- | --- | --- |
| Claim | Unclaimed; expected version is current | Set `chief`. |
| Offer | Owning chief; no open offer | Set `offer` to one other chief. The owning chief stays. Active runs may continue. |
| Cancel | Owning chief; exact open offer | Clear `offer`. Active runs do not stop it. |
| Accept | Named recipient; exact open offer; expected version is current; no active or unknown run of the task | Set `chief` to the recipient and clear `offer` in one write. |
| Release | Owning chief; no open offer; no active or unknown run | Clear `chief`. Work and reports stay. |
| Replace | A `replace` gate that names the owning chief and the new chief; the owner's answer | One write: set `chief`, clear `offer`, end each active or unknown run of the task as failed. |
| Task change | Task write guard; expected version is current | Change the permitted fields. Existing checks stay. |

- **A run ending does not advance a waiting transfer.** The run's row changes, but the task row does not, so the task version stays. The recipient still must accept. The board shows that the transfer is ready.
- **A cancelled offer never becomes valid.** Example: `OFFER-1`, cancel, then `OFFER-2` to the same chief. Acceptance of `OFFER-1` refuses and changes nothing. Acceptance of `OFFER-2` succeeds.
- **A dead chief is "unknown".** Any chief opens a Replace gate; the owner answers. The gate names each run that will end as failed. An ordinary restart or resume keeps the same chief, with no gate.
- **A replaced chief** gets a refusal that names the new owning chief.

## Saved changes and lost replies (F1, F10)

The saved change is today's marker, `review-pending.json`. There is one marker for each logbook, so the marker is already per project. Two things made it behave as a wider block, and this contract changes both.

**1. Recovery needs the caller's own request.** Today `recover` refuses unless the caller gives the same reference, and a task update refuses a different `owner` field (`old-owner`). A different writer can only stop. New rule: step 3 reads the saved intent and settles it from the `reference` saved in it, with its `owner` field. Then the writer continues with its own command. Settling gives the writer no authority on the task.

**A dispatcher by schema (P5).** Step 3 starts from the marker alone, so it must find the right consumer from the marker's `schema`. There are six consumers (`state.mjs:608`, `:669`, `:752`, `:857`, `:877`, `:1127`):

| Schema | Consumer | Folder | Step 3 |
| --- | --- | --- | --- |
| 8, and 6 for an old marker | `taskUpdates` | `task-updates` | See "A coordinated write needs a change" |
| 2 | `taskWrites` | `task-requests` | Roll forward |
| 3 | `runWrites` | `run-requests` | Roll forward |
| 7 | `usageWrites` | `usage-requests` | Roll forward |
| 4 | `reviewWrites` | `reviews` | Roll forward |
| 5 | `interruptedWrites` | `interrupted-runs` | Roll forward, then Codex settles its row |

A recorded write (schemas 2, 3, 4, 5 and 7) holds its whole receipt in the marker, so any writer can publish it. An unknown schema is "cannot finish".

**2. The merge check scans every folder.** `assessMerge` runs `check` on each logbook in the root, and `check` throws on any marker. So one project's marker refuses all merges. New rule: the merge check settles its own project's marker, and it skips another folder that holds a marker, with a note.

| Case | Result |
| --- | --- |
| Saved change, its chief is gone | The next writer of the project settles it. No claim or gate is needed. |
| Saved change cannot finish (damaged, or a table has neither its before nor its after text) | Writes and merges of this project stop, with the request named. The owner repairs it. Sage never drops it. Other projects continue. |
| A read-only board check | Shows the marker. It never settles it. |

### A coordinated write needs a change

A Codex task update (`coordinatedWrites`) decides through a callback into the Codex admission journal, so a Claude writer cannot finish it today. PR 1 replaces this with a rule that needs no provider and no new decision record (P1).

| In the logbook | Meaning | What any writer does |
| --- | --- | --- |
| Marker and receipt | The write is committed. | Roll forward: set the "after" tables and remove the marker. |
| Marker, no receipt | The write is not committed. | Restore the "before" tables and remove the marker. The request reads as "not found", and a retry is safe. |
| No marker, receipt | The write is committed. | Nothing. Codex settles its row. |
| No marker, no receipt | The write did not happen. | Nothing. Codex settles its row. |

The writer that holds the logbook lock is the only one that can work on the marker, so a marker that another writer sees belongs to a writer that stopped.

**The Codex side.** Codex adds two things to its journal:

- **One event, `void`.** `taskFence`, `taskGeneration` and the prior lookup skip a row that has this event.
- **One settle step.** It runs before decide, prepare and assign. For each row with an open fence:
  - Receipt present: acknowledge and release.
  - No receipt and no marker: void.
  - Marker present: run step 3 first.

**A rejected decision writes no receipt.** Its row is void, so the retry gets a fresh answer. This matches the rule for a refused command in "Reading a request after a lost reply". The reader for existing receipts of schemas 6 and 8 stays, so an old rejected receipt still reads as rejected. If a marker has such a receipt, step 3 restores "before".

**Interrupted writes use the same settle step (P5).** `begin` runs before the marker, so step 3 needs no callback for a marker of schema 5. `interruptedFinishes` keeps its fence until `end`. So a Claude writer can publish the receipt while the fence stays open in the Codex journal. The settle step closes it: a receipt present means `end`, and no receipt and no marker means void.

**Reading a request after a lost reply.** The read takes the lock, so it settles a saved change first. Three results remain:

| Result | Meaning | Next action |
| --- | --- | --- |
| committed | A receipt holds the result. | Return it. Do not repeat the command. |
| not found | No receipt and no saved change. The command did not happen, sage refused it, or step 3 rolled it back. | Retry the same request with the same payload. It checks the task again. |
| cannot finish | The saved change is damaged. | The project stops; see the table above. |

A refused command writes nothing, so a lost refusal reads as "not found", and the retry gets a fresh answer. A retry with a different payload refuses. A read failure is never "not found".

## Runs, checkouts and reports (F6, F7)

- **One checkout for each binding.** `checkout.txt` holds one path for a logbook. Two linked clones need more, so `bindings.tsv` replaces it for a shared logbook. The move writes the rows from each old `checkout.txt`.
- **`checkout.txt` stays for legacy logbooks (P10).** Today's readers (`state.mjs:988` and `:2496`, `board.mjs:181-211`) keep working on them.
- **A branch resolves through the checkout that dispatched the run.** A run saves its binding in `checkout`. `reviewHead` and the merge check use that checkout, because a branch of one clone may not exist in another. If that path is gone, the check refuses and names the run. The merge check does not try another clone.
- **A late report stays.** Today `keepReport` refuses a run that already ended. New rule: a run that ended as blocked or failed keeps its late report, once, with its arrival time. The verdict rule (a run that ended done, on the commit of the verdict) stays, so a late report backs no verdict. The owning chief can read it.
- **A transfer changes no run.** The run keeps the chief that dispatched it.

## Config and hooks (F8)

| Item | Home | Reason |
| --- | --- | --- |
| `model.*`, `arena_models` | Provider root | Model names differ by provider. |
| `arena` | Provider root | It counts the candidates of `arena_models`, so the two keys stay together. |
| `max_agents`, `cap_total`, `cap.<project>` | Provider root | Each hook counts its own agents. |
| `.hooks` (slots, helpers, session notes) | Provider root | Hook state belongs to one running provider. |
| `cycles.small`, `cycles.large`, `cycles.risk`, `max_rounds` | Shared root | One project must need the same clean cycles from either chief. |
| Project `name`, `archived` | The logbook's `config.json` | As today. |

`config()` reads each key from its home for a shared project. A legacy project keeps reading the provider root. An invalid cycle count still refuses every merge. At the first shared write the shared root takes the larger of the two provider values for each count, so a project never needs fewer cycles than the owner wrote. The owner's floors stay.

**`cycles.*` writes have one home (P10).** A `config` command with a `cycles.*` or `max_rounds` key resolves the project first. For a shared project it writes the shared root only. For a legacy project it writes the provider root, as today. After the first shared write, a shared project never reads those keys from a provider root.

**Both hooks protect the new root.** The Claude hook adds it to the protected paths and adds `SAGE_SHARED_HOME` to `ROOT_VAR`. The Codex hook adds the same to its own check. `protected-paths.mjs` already takes a list of roots. Both protect `bindings.tsv`, `plugins.tsv`, `projects.tsv` and each logbook's new files, through `LOGBOOK_FILES`.

**The hook scratch rules name the new root (P10).** `SCRATCH_HOMES`, `SCRATCH_FORMS` and `scratchCode` in the Claude hook add `SAGE_SHARED_HOME`. The overlap check of a run's scratch folder also compares the shared root.

**Codex settings (P6).** `.mcp.json` adds `SAGE_SHARED_HOME` and `CLAUDE_CONFIG_DIR` to `env_vars`, so that the Codex server can find both roots. `link` and `move` become MCP tools, because a Codex chief writes through those tools.

## The board (F9)

- **Consistent reads.** Readers take no lock. The board records the folder's receipts and each table's size and change time before a read, and compares them after. On a difference it retries twice. Then it shows the last read with the note "The logbook is changing".
- **Where it reads.** Tables come from the shared root. Hook notes come from each provider root (`readHookNotes`). `standardSources` adds the shared root. A logbook's hash for its lead slots uses the shared folder path.
- **Provider column.** Each run row shows its provider, from the new `provider` column.
- **Old logbooks.** `sources.tsv` joins each old logbook to the project view. Finished tasks show with the label "Old · Claude · read-only" or "Old · Codex · read-only". A legacy project that has not moved shows as it does today.
- **Ownership.** Each task row shows its owning chief, an open offer, or "Unclaimed". "Needs you" marks a task with an unknown chief or an open Replace gate.

## The move (T74) (F2, F5, F7)

The move is the cut-over: one explicit command, `sage logbook move`, with one owner gate. A Codex chief uses the MCP tool of the same name. It is PR 7, and that PR also turns rule 3 on.

**First, one probe (P7).** T74 starts with one probe: a Codex MCP write under `~/.claude/sage`, in a scratch test. The move writes to both old roots, so a sandbox refusal here changes the design of the move. If the probe fails, T74 stops and asks the chief before it builds.

**Preconditions.** Any failure refuses, and the old logbooks stay as they are:

1. `plugins.tsv` shows both providers at the shared contract, or the owner confirms in the move gate that a provider is unused.
2. Zero running runs in both old logbooks.
3. No saved change in either old logbook, after recovery.
4. Every open task's waits resolve. A wait on an abandoned task refuses, and the preview names it.

**Steps.** Each step is safe to run again:

1. The chief runs the preview and opens a `move` gate with the plan.
2. The owner answers. The owner's answer starts the command.
3. Take the root lock, then both old logbook locks in path order.
4. Save the plan in `moves/<folder>.json`.
5. Make the logbook, `sequence.json`, `sources.tsv`, its row in `projects.tsv` and the new rows of tasks.
6. Write `moved.json` in each old logbook, and add the `moved` column to its `tasks.tsv` header.
7. Write the `bindings.tsv` rows last.
8. Remove the plan.

If the command stops after step 6, the old logbooks refuse writes and name the fix: run the move again. A project is never writable in two places.

**The moved marker holds both ways.** A new plugin obeys `moved.json` through the resolution order. An old plugin obeys the column: today's `ready` refuses a table with an unknown column and tells the user to update. Reads, status and the merge check still work.

**What moves and what stays.**

| Item | Result |
| --- | --- |
| Open task (not merged, concluded or abandoned) | Moves with a new number and starts unclaimed. Priority, kind, size, risk, route and round stay. A `verifying`, `verified` or `pr-ready` task returns to `reviewing`. |
| Branch and PR | Stay on the old names, through the adoption record. `mayName` already reads it. Its `cycles` keeps the source minimum. |
| Finished task | Stays in its old logbook, read-only, labelled on the board. |
| Verdict, ledger row, kept report | Never move. The moved task gets fresh reviews and QA. |
| Run | Never moves. No run is active at the move. The moved task's history links to the old logbook. |
| Open finding of an open task | Moves with a new key. Its summary names the old key. Its `run` is cleared, as `finding move` does, because a run never moves. |
| Unanswered gate of an open task | Moves with a new G number. |
| Program with an open task | Moves with a new PG number. Its breakdown gate moves with its answer. |
| `waits`, `program` and `approvals` cells of a moved task | Each cell maps to the new numbers (P9). A wait on a finished task counts as met, and a decision row records it. |
| Task that another task adopted | Only the adopting task moves. The adoption record is the explicit link. |
| Two open tasks with one branch and no adoption | Both move as separate tasks. The preview warns. No guess joins them. |

**Numbers (F5).** `nextId` runs on each old logbook. Each floor is the highest number of the two logbooks, for T, R, G and PG separately. The moved tasks take the first new numbers, Claude's first, each group in old-number order. An old number is never used in the new logbook, so a report that says "T74" can point to only one record in that logbook.

**Not in scope.** No finished task moves. No cross-machine sync. No automatic move. The old logbooks stay on disk; deleting them is the owner's own choice.

## Build plan

Recovery comes first, because it works on today's logbooks and every later PR needs it. Each PR leaves existing projects working.

| PR | Scope | Closes |
| --- | --- | --- |
| 1 | Recovery: provider-neutral settling, dispatcher by schema, roll-back rule, journal settling (`void` and the settle step), merge check per project. It works on today's logbooks. | F1, F10 (receipts), P1, P5 |
| 2 | Shared root: root function and launcher helper, `bindings.tsv`, resolver, `legacyRoots`, link commands and MCP tool, config split, hook protection, Codex settings. Rule 3 stays off. | F2 (order), F3, F8, P2, P3, P6, P8, P10 |
| 3 | Chiefs and the guard, with leads: `chiefs.tsv`, `chief` column, writer classes, `task add` claims | F4, F10 (fields), P4 |
| 4 | Offer, cancel, accept, release, Replace gate, late reports | F7 (reports), F11, dead chief |
| 5 | Board: shared reads, "changing" note, provider column, old labels, run `checkout` | F6, F9 |
| 6 | Clone link: linked clones in the board and the branch rule | F3 (clones), F6 |
| 7 (T74) | One probe first, then `sage logbook move` and its MCP tool, moved marker, sequence floors, adoption version 2, shared `projects.tsv` rows. Rule 3 turns on. | F2 (cut-over), F5, F7 (move), P3, P7, P9 |

**PR 3 starts with one test.** It tests whether a Claude resume keeps one session id. If it does not, each resume reads as a new chief, and every open task needs Replace. PR 3 then reports this to the chief before it builds further.

## Sample states

Each state is one entry in the "Sample state" menu, at phone and desktop width.

| Group | States |
| --- | --- |
| Ownership | Ready, success, competing claim, transfer offered, transfer with a run active, owning chief unknown (Replace), late report kept |
| Saved changes | Next writer finishes it, next writer rolls it back, cannot finish, reply lost |
| Project link | Moved, copied or cloned checkout (link or separate); link conflicts |
| Move | Preview, must wait, stopped part way, done |
| Reading | Empty, loading, read failure, logbook is changing, correction |

Changes from the T73 sample:

- "Quiet" and "exact chief ended" are gone. V1 has one state: unknown.
- Replace is now two steps: any chief opens a gate, then the owner answers.
- The saved change no longer blocks. The next writer finishes it.
- The request has three results, not four.
- Record revision, generation and UUID aliases are gone. The sample shows the task version.
- Runs show a provider column.

Changes after the second PE review:

- A saved change with no receipt now rolls back, and the sample has this state.
- The move shows PG numbers.
- "Must wait" lets the owner record a provider as unused.
- The rules in the sample show that rule 3 waits for T74 and both providers.

The sample cannot prove races, durable writes, provider lifecycle or crash recovery.

## Alternatives rejected

| Alternative | Why not |
| --- | --- |
| Lease expiry for a chief | Silence does not establish an end, and the owner chose explicit recovery. |
| Immediate reassignment | The owner chose recipient acceptance and finished runs. |
| One writable copy for each clone | It makes several task records. |
| Import old numbers with a prefix (`C-T12`) | F5 forbids it. Two number forms would touch every id rule. |
| Move finished tasks too | The owner chose open tasks only. It would also move years of verdicts that the merge check no longer needs. |
| Checkout evidence: a stamp file in `.git` | It works without a remote, but it adds a file in the owner's repository, and a clone does not carry it. |
| Checkout evidence: match the remote URL | It fails for a repository with no remote and for a changed remote. The first commit needs neither. |
| Checkout evidence: none | A moved checkout then starts a new empty logbook in silence. |
| A new recovery screen | Contextual actions on the task add no steps. |
| Moved marker only in the shared root | An old plugin never reads it. The header column uses a refusal that old plugins already have. |
| A decision record beside the marker | The PE review found that the receipt already holds the answer. A second record adds a rule and a file. |
| Rule 3 on from PR 2 | One provider could start a shared logbook that the other provider's old plugin cannot read. |
| `<SAGE_HOME>/shared` as the only test rule | Codex sets `SAGE_HOME` in production, so a real run would use a wrong root. |

## The four choices

The owner's approval of this contract covers these four choices.

1. **Open findings at the move.** They move with new keys. A known problem must not disappear because a task changed number.
2. **Owning chief of a moved task.** Unclaimed. The chief that runs the move may have no context on another provider's task.
3. **A fork with the same first commit.** Refuse and offer link or separate. A fork is rare, and a silent new logbook for a moved checkout costs more.
4. **A provider that the owner does not use.** The owner may confirm this in the move gate, and sage records it in `plugins.tsv`. The refusal for a later old plugin still holds.

## Not verified

- No backend exists. Nothing in this page was run against a real logbook.
- `git rev-list --max-parents=0 HEAD` speed on a large repository, and the fork case. The guard's timeout limits the cost; its value is not set yet.
- A Claude resume keeping one session identity. PR 3 tests this first.
- A Codex MCP write under `~/.claude/sage` in the Codex sandbox. The T74 probe tests this first.
- The cost of this work. The estimate on the top of this page has no measured basis.

Skills applied: experience-first, exhaust-the-design-space, contextualize-and-write-for-the-reader, writing-standard, dictionary.
