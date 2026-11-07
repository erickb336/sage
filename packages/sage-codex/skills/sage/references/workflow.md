# The team workflow

Keep report text exact when the chief or lead saves it with `pages`. Preserve Markdown and every newline; reuse the returned digest for `report_compare`. A known mismatch refuses before the first page save. Missing capture remains a limitation and grants no verdict.

Stop only the denied action after an incidental refusal. Continue independent work that the brief and active policy allow. A refused progress message is not a failed check. Follow [sandbox refusals](sandbox-refusal.md); do not retry through another route.

The parent is the chief. It writes the logbook, and a lead writes only the records of its own task. The chief frames work, asks product questions and shows results. One lead coordinates each build task and its PR. Specialists implement or review. This is a procedure followed by agents; it is not strict runtime admission.

1. Resolve the project and inspect current tasks, standing orders, worktrees and known active ownership. Preserve other sessions' work.
2. Frame a task through the CLI. Follow its route and risks. Resolve product decisions before dependent implementation.
3. Confirm the host supports the required hierarchy and roles. Use its actual agent tools and capacity, not tool names from another provider.
4. Keep one active build team per task. Give each writer exclusive paths or a separate worktree. Known checks do not provide atomic exclusion across sessions.
5. The chief starts one lead for each task with a build, and starts designers, PE, arena judges and investigators itself. The lead starts the implementers, code reviewers, security reviewers, UX reviewers and QA of its task, as [start a role agent](roles.md) says. Other role agents start no agents and record nothing in the logbook; the plugin's hook refuses both. Keep at most `max_leads` leads for one project (default 5; `sage config max_leads=<n>` sets it) and nine helpers for one lead, within the lower host, project and owner limit.
6. The chief or the lead records each run before its work starts and sends the complete brief. Other role agents never write logbook tables or invoke state mutations.
7. The implementer makes the scoped change and runs appropriate checks. An independent reviewer examines the change; the implementer cannot certify its own review.
8. Record findings before verdicts. Repair on the same task branch. Use the CLI's repair/held/replan rules, not a new task to hide unresolved findings.
9. Run every required clean cycle on the final commit. A new commit restarts cycles. Use configured counts: default one for tiny/small, two for large or risk-flagged tasks, or more when required.
10. QA checks acceptance against the final head. Show the user the artifact, evidence, limitations and any needed decision. Stop at verified unless separately authorized publication is available.

Tiny work still needs an independent code review under this workflow; add that block with a reason if the framed route lacks it. Run security review for applicable risks and UX review when the experience changes. PE and designer use the public helper after installed acceptance. A lead uses it too, and its real run in an installed Codex is a pilot that remains to do. An arena follows [run an arena](arena.md), and its real run in an installed Codex is the pilot that remains to do. Do not silently skip required review or rename a missing role. Stop the dependent phase and explain the gap.

## Capacity, failures and recovery

Use current host limits. Five subagents in one environment is not a portable limit. If capacity is full, wait or use supported lifecycle controls. A spawn that fails with `collab spawn failed: agent thread limit reached` is this case: see [the thread limit](roles.md#thread-limit). Continue only independent work that fits the available capability.

A failed skill read stops the work that depends on it. An unsupported state transition remains blocked. A child's success report remains reported until supported by evidence; obtain the missing check rather than invent it. Preserve native API refusals and permission boundaries.

On `sage mode off`, stop new dispatch first. Request interruption only for owned active agents through supported host tools. Inspect their results, preserve files and unfinished work, and record only established outcomes. A timeout, lost process or missing status proves no completion or capacity release. Do not launch an overlapping replacement while ownership is unresolved.

For a run created through this manual workflow, confirmed owner interruption is `blocked`, not `done`. Save a stop report with the task/run IDs, native agent identities, terminal evidence, preserved artifacts and remaining work. After the owned team has settled, record each interrupted run through `run done <R> --status blocked --report <stop-report>`. Keep the task unfinished. Read the run records again and disclose any recording failure. If a child or descendant remains active or uncertain, keep the affected ownership unresolved; do not release its run from a timeout or an interruption request alone. Protected native runs still require their protected finish path; these manual commands cannot replace it.

After compaction or restart, read current task/run records, reports, branch/head and host status. A stored run or old mode note does not authenticate a live child. If continuity is uncertain, require explicit owner re-entry and resolve ownership before dispatch. Do not send new child input to manufacture a terminal result.

The manual logbook does not replace protected native preparation, report, review or completion receipts. Never switch to it as a workaround for a protected API denial. Preserve the chosen Codex model. Advice is optional; this workflow changes no hooks, settings or enforcement defaults.

## Edit project files with explicit targets

Use the native `apply_patch` tool for a permitted project edit. Give each target a literal path inside the assigned worktree. Put program text inside the patch body. Do not wrap the patch in a shell command or an interpreter.

The shell guard examines program arguments and stdin as well as redirection targets. A dollar sign, backtick or pattern can make a word's location uncertain. This can refuse a benign program string. A refusal does not prove that the intended filename is protected. The guard does not interpret arbitrary programs to prove their writes safe.

Before a refusal, prefer this form for an authorized implementer:

```diff
*** Begin Patch
*** Add File: scripts/evaluate-sample.mjs
+export const caption = `SAMPLE [${label}`;
*** Add File: tests/sample-guard.test.js
+// SAMPLE DATA: this is a disposable example.
*** End Patch
```

After an edit, read the target files and inspect the diff. Run only the checks authorized by the brief. The patch guard still checks paths, protected folders and the agent's role. Literal patch targets grant no permission to change settings, credentials, logbooks or another task's files.

If a protected action refuses, stop and report the action and refusal. Do not retry it through a shell, interpreter, CLI or another tool. Keep private payloads local. A later authorized task can establish a permitted project edit with explicit targets; it cannot override a protected denial.

Fictional gate inputs check source behavior only. They do not establish which input caused an earlier refusal, or prove installed native behavior. Retain the exact input, normalized event, working folder, writer identity and executing revision when an investigation permits it.

### A managed worktree receives a protected-folder refusal

Successful worktree creation and task lookup do not prove that a later patch is permitted. Stop when the native hook refuses it. Assignment and Git linkage do not override protected targets.

The current source checks `.codex` segments below the detected project root, or the whole target path outside that root. Existing coverage allows ordinary files inside a detected project under `.codex/worktrees`. A linked checkout under `.codex` can still refuse when the event's working folder identifies another project root. This distinction does not establish the cause of a native refusal without its event and executing revision.

The T111 evidence has two separate limits. R24 lacks the original payload and cannot establish its refusal's cause. R27 reports an actual native structured-patch refusal naming `.codex`, after managed worktree creation and task lookup succeeded. The earlier native demonstration outside `.codex` resolves neither case. Synthetic linked-worktree inputs demonstrate source behavior only.

For a later task, the owner can keep the task blocked while investigating the installed behavior, or authorize a separate ordinary linked worktree. Recommend the ordinary worktree outside `.codex`, with a fresh branch and explicit owner/chief assignment. Leave the managed checkout untouched. These are proposed steps, not permission to retry an active denial:

1. The owner/chief confirms the original branch's writer, status and exact head. Resolve any active or uncertain ownership first.
2. Choose a new absolute worktree path outside `.codex`, settings, secrets and logbooks. Check its resolved parent path for symlink escapes.
3. From the repository, run `git worktree list --porcelain` and `git branch --list <new-branch>`. Stop if the path or branch already exists.
4. After separate authorization, run `git worktree add -b <new-branch> <absolute-new-path> <verified-head>`. Use a fresh `codex/` branch; do not force-checkout or move the managed checkout's branch.
5. The owner/chief assigns the new path, branch, writer and allowed files in a new brief before any source edit.
6. In that assigned checkout, verify `pwd -P`, `git status --short`, `git branch --show-current` and `git rev-parse HEAD` against the brief.
7. Use native explicit patches only for the newly authorized scope. Stop and report any protected refusal; do not switch tools or weaken enforcement.

This procedure changes no settings, credentials, logbooks or protected-path policy. It does not authorize edits to an unrelated checkout.

## Review usage without a host measurement

Keep actual token counts when the execution interface supplies them. A retrieval error does not make usage unavailable.

The chief can declare `--usage-interface collaboration-tools` when adding a manual run. This records the provider's fixed capability description. It is a chief declaration, not host attestation. The `app-server` interface exposes usage and cannot select this exception. Native and older runs have no declared interface and cannot select it either.

For the declared unsupported interface, end the run with `--usage unavailable`, `--usage-source`, `--usage-evidence` and `--report`. Give the actual capability evidence. Do not put zero or a word in `--tokens`. The exception changes no report, review, ownership or native completion check.

If a measurement arrives later, use `run usage <R> --tokens <n> --usage-source <source> --usage-evidence <reference>`. This command records an audited enrichment. It preserves the terminal status, timestamp and report. An exact retry adds nothing. A conflicting count or source refuses. Previously blocked runs remain blocked.

Status and stats show measured, unavailable and legacy-unrecorded completed runs. A partial total does not establish that one task costs less than another.

## Investigate and review evidence

For an existing investigation route, the chief records an `investigate` run and dispatches its named role through the public helper. Save the complete returned report with `pages record`, then end that actual run with `run_done`. These manual records are chief-supplied evidence, not proof of native authorship.

Start a different agent with the `evidence-review` role and its own recorded run. Give it the investigation report and evidence locations. Retain its complete report and record its actual outcome. A `blocked` or `question` report stays that outcome; resolve it before acceptance. Record findings before a verdict.

When that independent review supports acceptance, the chief records `evidence-clean` for the task without a SHA, with the real review run reference. Follow the existing state transitions to `concluded`. Retention alone grants no verdict. Core neither requires a run/report for this task-scoped verdict nor authenticates a supplied run reference. A deliberate false reference is a known trust limit, never an allowed practice.

Manual pages and run records, actual hook-retained reports, and evidence-clean acceptance are three different facts. Local generated-package fixtures can check their behavior. They do not verify installed hooks, live dispatch or protected native integration; those checks remain pending.

## Design before build

The chief keeps this order: designer → PE → owner’s design approval → build. This is a procedure; the state transitions do not authenticate design completion or the owner’s answer.

1. Record the designer run with its own branch and worktree. The branch must have no other active writer. Name each allowed artifact path in the brief.
2. Ask `pages` for the task’s pages folder before the brief. The designer saves the prototype and screenshots there when the chief needs to record them. A prototype in the worktree can also have a copy there.
3. Read the designer’s complete report and open the artifacts. Use `pages` with `record` to record each existing file inside that folder. Use `pages` with `run` and `text` to save the complete report, then end the actual run. Supplying report text does not create an arbitrary prototype.
4. Start a distinct PE child with its own run, the saved prototype, screenshots and designer report. Save its complete report and actual outcome. Resolve PE `CHANGE`, `blocked` and `question` outcomes before acceptance.
5. Show the design and PE report to the owner. Record the owner’s actual design approval before starting dependent implementation. A stored report supplies no approval.

An ordinary open design gate is not a general merge refusal. The chief must preserve the design procedure. Existing missing-review and program-wait refusals still apply. Protected native completion remains outside this support. A design arena keeps the same order: candidates and a judge stand for the designer, then PE, owner’s design approval and build.

Label local fixture artifacts and synthetic hook events as sample data. They demonstrate storage and sequencing, not actual designer creation, independent PE work or installed acceptance.
