# The team workflow

The parent is the chief and the sole logbook writer. The chief frames work, asks product questions and shows results. One lead coordinates each build task and its PR. Specialists implement or review. This is a procedure followed by agents; it is not strict runtime admission.

1. Resolve the project and inspect current tasks, standing orders, worktrees and known active ownership. Preserve other sessions' work.
2. Frame a task through the CLI. Follow its route and risks. Resolve product decisions before dependent implementation.
3. Confirm the host supports the required hierarchy and roles. Use its actual agent tools and capacity, not tool names from another provider.
4. Keep one active build team per project. Give each writer exclusive paths or a separate worktree. Known checks do not provide atomic exclusion across sessions.
5. Record the lead run and send the complete brief. Only the chief starts a lead. The lead coordinates but does not edit project files, merge or question the owner directly.
6. The lead starts only implementers, code reviewers, security reviewers, UX reviewers and QA. Specialists do not start another layer. Keep at most three lead children, within the lower host, project and owner limit.
7. The chief records each specialist run before its work starts. The lead requests the ID from the chief and reports evidence back. The lead and specialists never write logbook tables or invoke state mutations.
8. The implementer makes the scoped change and runs appropriate checks. An independent reviewer examines the change; the implementer cannot certify its own review.
9. Record findings before verdicts. Repair on the same task branch. Use the CLI's repair/held/replan rules, not a new task to hide unresolved findings.
10. Run every required clean cycle on the final commit. A new commit restarts cycles. Use configured counts: default one for tiny/small, two for large or risk-flagged tasks, or more when required.
11. QA checks acceptance against the final head. Show the user the artifact, evidence, limitations and any needed decision. Stop at verified unless separately authorized publication is available.

Tiny work still needs an independent code review under this workflow; add that block with a reason if the framed route lacks it. Run security review for applicable risks and UX review when the experience changes. Large design/PE and investigation work stay with the parent until their specific dispatch path is verified. Do not silently skip required review or rename a missing role. Stop the dependent phase and explain the gap.

## Capacity, failures and recovery

Use current host limits. Five subagents in one environment is not a portable limit. If capacity is full, wait or use supported lifecycle controls. Completion does not prove that a slot was released. If nesting is unavailable, explain that the requested hierarchy is unavailable; do not silently flatten the team. Continue only independent work that fits the available capability.

A failed skill read stops the work that depends on it. An unsupported state transition remains blocked. A child's success report remains reported until supported by evidence; obtain the missing check rather than invent it. Preserve native API refusals and permission boundaries.

On `sage mode off`, stop new dispatch first. Request interruption only for owned active agents through supported host tools. Inspect their results, preserve files and unfinished work, and record only established outcomes. A timeout, lost process or missing status proves no completion or capacity release. Do not launch an overlapping replacement while ownership is unresolved.

After compaction or restart, read current task/run records, reports, branch/head and host status. A stored run or old mode note does not authenticate a live child. If continuity is uncertain, require explicit owner re-entry and resolve ownership before dispatch. Do not send new child input to manufacture a terminal result.

The manual logbook does not replace protected native preparation, report, review or completion receipts. Never switch to it as a workaround for a protected API denial. Preserve the chosen Codex model. Advice is optional; this workflow changes no hooks, settings or enforcement defaults.
