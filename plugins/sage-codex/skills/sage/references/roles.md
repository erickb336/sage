# Start a role agent

Each role agent (lead, implementer, pe, designer, arena-judge, code-reviewer, security-reviewer, ux-reviewer, qa, investigate, evidence-review) is a Codex child agent. Codex plugins cannot ship agent roles, so the role text goes at the top of the spawn message. The plugin writes no role files into your Codex home.

**The shape.** The chief starts each lead, one for each task with a build, and each pe, designer, arena-judge, investigate and evidence-review agent. A lead starts the implementer, the reviewers and QA of its own task, and records that task: `role.mjs lead` prints its steps. Other role agents start no agents and record nothing in the logbook: the plugin's hook refuses their `spawn_agent` and the sage tools that write, so the chief or the lead records what their reports say. Record each run with the `run_add` tool of the sage MCP server before the spawn.

**Multi-agent v1.** A v1 child gets no spawn tools, so a lead cannot start helpers there. On v1 the chief starts no lead: it starts every role agent and does the lead's work (the briefs, the review cycles and the repair rounds).

## Steps

1. Print the role text. Run the `role.mjs` script beside this skill with the role name, for example `node <this skill folder>/role.mjs implementer`.
2. Write the message: the whole output of step 1, without a change, then a blank line, then the brief (see [briefs and reports](briefs.md)).
3. Call `spawn_agent` in the `collaboration` namespace with:
   - `task_name`: `sage_`, the role with `_` for `-`, the task, then the run id that `run_add` printed, for example `sage_implementer_t12_r40` or `sage_code_reviewer_t12_r41`. Codex refuses a task name that an open agent of the session already has, so the run id makes each name new, also for a second run of a role on the same task. A name without the run (`sage_implementer_t12`) still starts, but sage keeps no report for that run, so always give the run. The report check knows a sage role agent by the `sage_` start. A name that starts with `sage_` in another form counts as a read-only role: it changes no files.
   - `message`: the message of step 2.
   - `fork_turns: "none"`. The default, `all`, gives the agent the chief's history in place of a clean start.
   - Leave out `agent_type`: sage has no Codex role of that name.
4. Wait for the agent with `wait_agent`, and read its report.

When your tool list has `spawn_agent` only in the `multi_agent_v1` namespace (an older model), give `message` alone. That spawn form has no task name, so the report check does not check the agent: read its report yourself.

## Start a lead

The chief's steps are in **Run the route**. The task name is `sage_lead_t<n>_r<k>`, with the run id that `run_add` printed. The CONTEXT of the lead's brief gives:

- the absolute project folder;
- the task's state, its branch and its PR when it has one;
- the pages folder that `pages` prints;
- the count of clean cycles: 1 with autopilot off, else the task's count;
- each upstream report that `run_add` names, in full.

The gate lets a lead start only `sage_<role>_t<n>_r<k>`, with its own task number, for the roles implementer, code_reviewer, security_reviewer, ux_reviewer and qa. Its agent path must have only leads above it. A lead changes no files and sends no message: to steer its team, it starts a new agent on a new run.

The chief records the lead run, the checks verdicts, the move to verified, and its own design, PE, arena and investigation runs. The lead records the runs of its team, their findings, their verdicts, and the task's moves through the cycle. It also sends the branch and opens the pull request, because a Codex implementer does neither.

## The lead's report

1. Check the report against `status`: each run, finding and verdict that it names is in the logbook.
2. Do what only you do: ask its QUESTIONS with `gate_add`, dismiss each medium or high finding that it names as wrong, when you agree, and end each run that it names as never started.
3. For a ready report (the task at verifying), take the PR number from the logbook, never from the report. Take the head SHA from `gh pr view <n> --json headRefOid`, and compare it with the SHA in the report. When they differ, or a run of the task other than the lead run still runs, record no verdict: start a fresh lead.
4. Run `gh pr checks <n>`. When every check passes on that SHA, record `checks-pass` with `verdict`, then move the task to verified with `task_set`. Then merge (autopilot on), or tell the user that the pull request is ready.
5. When a check fails, record `checks-fail`, add a finding with `finding_add` (`source` qa, `class` the problem's class, `run` the lead run), triage it fix, then start a fresh lead.
6. For a blocked report, take no state from it. Read the task's state, round and findings with `status`, decide from them, and start a fresh lead on a new lead run, with the original brief, the decision and the earlier report. It goes on from the logbook.

## Thread limit

Codex v2 allows 4 threads in a session by default: the chief and 3 children. So a lead and 2 helpers fill the default. When no thread is idle, a spawn fails with `AgentLimitReached`, and the setting is `agents.max_concurrent_threads_per_session`.

When a spawn of the chief fails so, wait for a running agent with `wait_agent`, then call `spawn_agent` again with the same task name. Ask the owner to set the limit to 10 before a task with a full team. An agent never changes that setting.

## The report check

The plugin's report check (a `SubagentStop` hook) reads each agent whose task name starts with `sage_`. When the agent stops and its last message has no field of the report (`STATUS` to `BRANCH`), the check continues the agent once and names the missing fields. At the second stop, the agent stops, and you see one plain line that names the fields that are still missing. Read that report as it is. Other agents pass.

The check runs only after you trust the plugin hooks in Codex.

## Compare a retained report

The chief can call `report_compare` through the sage MCP server for its assigned project. Supply `project`, `task`, `run` and `sha256`. Compute the SHA256 over the exact UTF-8 report text, including every newline and space. The comparison also works after the run ends.

The result contains only `status`: `match`, `mismatch`, `missing` or `damaged`. A match requires valid stored identity fields and an equal recomputed digest. Existing records have no stored digest. Unknown or incomplete storage formats return `damaged`; access and input failures remain errors. No report text or private identifiers leave this operation.

This read changes no logbook, retained report, review decision or approval. It uses the existing one-call gate admission. Role agents cannot call it. A match describes the observed stored text; it does not prove native authenticity or successful review. An incomplete, blocked or question report can match. A manually saved report page does not count as retained text.

## Read-only investigation roles

Use `role.mjs investigate` for the investigator and `role.mjs evidence-review` for a separate evidence reviewer. Each prints its own instructions and the shared report contract. These names are exact; do not relabel another role.

Both roles use the existing assigned-project read approval. In Sage mode, the gate explicitly refuses their file changes. The existing configuration, logbook-write, child-spawn, messaging and foreign-project read refusals still apply. Keep native sandbox restrictions; the hook does not inspect every program's effects.

Give each child its real task and run in the task name. The trusted start and stop hooks can retain its exact report only for the matching direct child, task, run and role. A no-build task can retain a report without a SHA. The hook also retains the exact report of an `implementer` and of an `arena-judge` run; no verdict depends on it. An `implementer`, `arena-judge` or `designer` run gets the head of its own branch at its stop, also when it committed during the run; a missing branch gives no SHA. Any other run reads the branch of its task, and that branch must not move during the run, or the run gets no SHA. A missing or conflicting identity does not become a retained report. Incomplete reports continue once; a second stop preserves their limitations.

This support concerns the public skill-led helper. Protected native role support and installed execution remain unverified. A protected API refusal is not permission to switch paths.

## PE and designer

Use `role.mjs pe` and `role.mjs designer`. Both print the existing shared role text and every report field. PE checks the design and changes nothing. The designer makes a clickable prototype with labelled sample data and screenshots. Give the designer its own branch, worktree and explicit artifact paths. Give PE those actual artifacts and the complete designer report.

Both roles keep the existing assigned-project reads. PE edits refuse. The designer keeps its existing edit authority; the brief scopes its prototype files. This adds no path confinement. Configuration, logbook writes, child spawning, messaging and foreign-project read refusals still apply to both roles. Keep the native sandbox restrictions.

Use a direct child with its task, run and role in the name, such as `sage_designer_t12_r40` or `sage_pe_t12_r41`. The trusted start hook binds that identity to the running run. The stop hook retains its exact report, with a SHA when available. A missing SHA is allowed. Missing, conflicting, nested or ended-run identities cannot retain a report. An exact repeat preserves the first report; different text cannot replace it.

Incomplete reports continue once, then remain incomplete if the child stops again. Retain `blocked`, `question` and PE `CHANGE` outcomes as given. Retention grants no verdict or design approval. The chief follows the [design procedure](workflow.md#design-before-build).

## Arena candidates and the judge

An arena candidate is a designer or an implementer with `candidate` on its `run_add`. Use its usual `role.mjs` text and task name, such as `sage_designer_t12_r40`. The arena judge uses `role.mjs arena-judge` and a name such as `sage_arena_judge_t12_r44`. The steps are in [run an arena](arena.md).

Each candidate and the judge write on their own branch, in their own worktree, so that branch differs from the task's branch. The start and stop hooks bind each one and keep its report, with the head of its own branch. The judge makes its branch and commits on it. It leaves the pull request to the chief, as an implementer leaves it to the chief or the lead. A kept report grants no verdict, and a score replaces no review.

## Before installed acceptance

Generated-package tests establish source support only. Before installed acceptance, verify the package version, the public role texts, actual child and lead runs, permission refusals, exact retention and the saved prototype. Synthetic hook events do not prove installed execution or protected native completion. Stop at a protected denial; do not try another path.
