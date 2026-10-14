# Accept a recorded review

The chief calls `sage_accept_review` with `assignment` and `reportHash` after `sage_finish_run`.
Sage derives the task, run, role, report, and review target from authenticated saved evidence.
A caller cannot supply a verdict, path, commit, cycle, or findings.

Fresh acceptance requires the current chief epoch, report recovery proof, a completed run, and an unheld task with a build block.
The saved report must match the run, task branch, round, review cycle, and current branch commit.
Code, security, UX, and QA reports use the structured report format.
Checks evidence may coexist with one review verdict on a run. A second review verdict is refused.
Low findings remain open. Blocking findings move verified or pr-ready tasks back to reviewing and add a decision.
Acceptance does not verify a task, authorize a merge, or enable automatic Sage.

A schema-4 receipt retains the bounded authenticated report text and its exact result.
One pure delta defines both fresh publication and recovery validation for tasks, findings, ledger, and decisions.
The writer validates all saved results, table changes, and receipt destinations before it publishes any table.
Exact historical retries return the first result after later holds or branch changes.
A validated partial write can finish after Git advances, but unrelated table edits refuse recovery.
Receipt versions protect supported snapshot readers from a transaction that completes between table reads.
Older installations without these guards do not share this protection.

`scripts/probe-codex-lifecycle.mjs --sage-accept-review` checks the native tool path with simulated model responses.
It uses a temporary profile and logbook, finishes one review, records one verdict, and checks an unchanged retry.
It does not perform a real code review or activate the installed plugin.
