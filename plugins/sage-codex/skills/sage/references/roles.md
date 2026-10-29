# Start a role agent

The chief starts each supported role agent (implementer, pe, designer, code-reviewer, security-reviewer, ux-reviewer, qa, investigate, evidence-review) as a Codex child agent. Lead and arena routes remain unavailable. Codex plugins cannot ship agent roles, so the role text goes at the top of the spawn message. The plugin writes no role files into your Codex home.

**The shape is flat for now.** The chief starts every role agent and does the lead's work (the briefs, the review cycles and the repair rounds). Leads come later. Role agents start no agents and record nothing in the logbook: the plugin's hook refuses their `spawn_agent` and the sage tools that write, so the chief records what their reports say. Record each run with the `run_add` tool of the sage MCP server before the spawn.

## Steps

1. Print the role text. Run the `role.mjs` script beside this skill with the role name, for example `node <this skill folder>/role.mjs implementer`.
2. Write the message: the whole output of step 1, without a change, then a blank line, then the brief (see [briefs and reports](briefs.md)).
3. Call `spawn_agent` in the `collaboration` namespace with:
   - `task_name`: `sage_`, the role with `_` for `-`, the task, then the run id that `run_add` printed, for example `sage_implementer_t12_r40` or `sage_code_reviewer_t12_r41`. Codex refuses a task name that an open agent of the session already has, so the run id makes each name new, also for a second run of a role on the same task. The form without the run (`sage_implementer_t12`) still works. The report check knows a sage role agent by the `sage_` start. A name that starts with `sage_` in another form counts as a read-only role: it changes no files.
   - `message`: the message of step 2.
   - `fork_turns: "none"`. The default, `all`, gives the agent the chief's history in place of a clean start.
   - Leave out `agent_type`: sage has no Codex role of that name.
4. Wait for the agent with `wait_agent`, and read its report.

When your tool list has `spawn_agent` only in the `multi_agent_v1` namespace (an older model), give `message` alone. That spawn form has no task name, so the report check does not check the agent: read its report yourself.

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

Give each child its real task and run in the task name. The trusted start and stop hooks can retain its exact report only for the matching direct child, task, run and role. A no-build task can retain a report without a SHA. A missing or conflicting identity does not become a retained report. Incomplete reports continue once; a second stop preserves their limitations.

This support concerns the public skill-led helper. Protected native role support and installed execution remain unverified. A protected API refusal is not permission to switch paths.

## PE and designer

Use `role.mjs pe` and `role.mjs designer`. Both print the existing shared role text and every report field. PE checks the design and changes nothing. The designer makes a clickable prototype with labelled sample data and screenshots. Give the designer its own branch, worktree and explicit artifact paths. Give PE those actual artifacts and the complete designer report.

Both roles keep the existing assigned-project reads. PE edits refuse. The designer keeps its existing edit authority; the brief scopes its prototype files. This adds no path confinement. Configuration, logbook writes, child spawning, messaging and foreign-project read refusals still apply to both roles. Keep the native sandbox restrictions.

Use a direct child with its task, run and role in the name, such as `sage_designer_t12_r40` or `sage_pe_t12_r41`. The trusted start hook binds that identity to the running run. The stop hook retains its exact report, with a SHA when available. A missing SHA is allowed. Missing, conflicting, nested or ended-run identities cannot retain a report. An exact repeat preserves the first report; different text cannot replace it.

Incomplete reports continue once, then remain incomplete if the child stops again. Retain `blocked`, `question` and PE `CHANGE` outcomes as given. Retention grants no verdict or design approval. The chief follows the [design procedure](workflow.md#design-before-build).

Generated-package tests establish source support only. Before installed acceptance, verify the package version, both public role texts, actual child runs, permission refusals, exact retention and the saved prototype. Synthetic hook events do not prove installed execution or protected native completion. Stop at a protected denial; do not try another path.
