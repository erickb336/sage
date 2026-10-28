# Briefs and reports

The chief gives the lead the full task; the lead gives each specialist its scoped part. Every brief uses these fields at the start of a line:

```text
GOAL        one outcome a stranger can act on
SCOPE       project, task ID, run ID, role, worktree, branch, base/head and exclusive allowed paths
CONTEXT     file pointers and complete earlier reports needed for this work
DECISIONS   the owner's decisions and current mode; known capacity and ownership limits
ACCEPTANCE  observable pass conditions and required independent review cycles
VERIFY      exact checks, app commands and evidence to retain
BUDGET      agreed time/turn limits; stop and report when exhausted
FORBIDDEN   no out-of-scope edits, logbook writes, merge, force-push or publication
REPORT      the report below; define RESULT for this assignment
STANDING    the complete output of the CLI standing command
```

Include the available skill names relevant to the assignment and their actual paths. The child reads each needed skill itself unless its content is demonstrably inherited. Do not claim a missing skill or role exists. Include this report contract in every brief; it does not require Claude's report skill.

```text
STATUS        done, blocked or question
RESULT        outcome requested by the brief, such as PASS/FAIL or CLEAN/FINDINGS
EVIDENCE      commands and results; retained artifact paths; task/run IDs and role
FINDINGS      stable key, high/medium/low, location and reproduction for each finding
QUESTIONS     product choices and recommendation
NOT VERIFIED  unchecked behavior, limitations and unresolved owned agents
BRANCH        branch, exact final SHA and PR link when one exists
```

Use `none` for an empty field. End with this report, with nothing after it. Keep it near 2,000 tokens or fewer; put long evidence in named files. Distinguish simulated data, reported success and independently verified results. Do not invent token usage. The chief records actual results and proposed transitions through the CLI.

For `investigate` and `evidence-review`, identify the actual task, run, role and assigned project in the brief and report. A task without a build needs no SHA; use `BRANCH none` when no branch was checked. Preserve `blocked` and `question` outcomes. The chief saves complete reports and records actual outcomes; a saved report alone does not grant `evidence-clean`.
