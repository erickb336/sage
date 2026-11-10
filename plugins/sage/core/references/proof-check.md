# The proof check

This page tells a lead (or a chief that runs a cycle itself) how to run the proof check of a cycle. One QA run reruns the proof of each medium or high finding on a fresh copy of the head, before any verdict and any `round` of that cycle. So a finding that a review cannot show again does not start a repair round.

## The proof of a finding

A review or QA agent gives each medium or high finding its proof, on indented lines under the finding's line:

- `proof: <one command, run from the repository root of the head>` and `saw: <the one output line that shows the problem>`;
- for a screen: `proof: screenshot <path>` and `steps: <the url and the actions>`.

The command runs from the repository root of a fresh copy of the head, after the project's dependency install (for example `npm ci --ignore-scripts`). It only reads, or writes only into the agent's scratch folder.

The stop gate stops the agent once when a medium or high finding has no proof, or when the command runs a process program, a git stash, inline code (`node -e`, `sh -c`), a write outside the scratch folder, or git other than status, log, show, diff, rev-parse, ls-files, grep, cat-file or blame (also any `git -C`, `-c`, `--git-dir`, `--work-tree` or `--output`). The second stop goes through. A low finding needs no proof.

## When

Run one proof check for each cycle that has a medium or high finding:

1. Wait for every review and QA run of the cycle. Record each finding (`finding add`) and end each run (`run done`).
2. Add one `qa` run, and give it the brief below. Wait for its report, then end its run. Its report backs no verdict.
3. Read its EVIDENCE: one line for each finding, `- <key> reproduced`, `- <key> not reproduced` or `- <key> could not run`.
4. Drop each medium finding that did not reproduce: `finding triage <T> <K> dismiss --proof R<n>`, where `R<n>` is the proof check. Its reason becomes "not reproduced in R<n>". List each dropped finding in your report.
5. Record the verdicts of the cycle. A run whose medium and high findings are all dropped gives its clean verdict.
6. Triage each finding that reproduced, or that could not run, `fix --proof R<n>`. Then run `round`.

A high finding that did not reproduce, or that has no proof, is the chief's: do not dismiss it, and name it in FINDINGS of your report. A lead's fix triage of a medium or high finding in reviewing or verifying needs `--proof`.

The state tool checks each `--proof`: a done `qa` run of the same task, whose kept report lists the key, on the head that the kept report of the finding's own run names. `not reproduced` backs only a dismissal; `reproduced` and `could not run` back only a fix. The decision trail keeps the proof check, its outcome and the head.

## The brief of the proof check

Use the ten fields. Put these in them:

- GOAL: rerun the proof of each finding below on a fresh copy of the head, and give each one an outcome.
- SCOPE: the head SHA, and for each finding its key (`F-T<n>-<k>`) with its proof lines, copied word for word from the review's report. A finding with no proof line gets the line `no proof`.
- ACCEPTANCE: one EVIDENCE line for each key; RESULT PASS; FINDINGS none.
- FORBIDDEN: no fix, no change of a proof, no command but the proofs.

The QA agent's own text gives it the steps. In short:

1. Make a detached worktree of the head in your scratch folder: `git -C <project> worktree add --detach <scratch>/<run>/head <sha>`.
2. Run the project's dependency install there, if its proofs need it (for example `npm ci --ignore-scripts`). Set `HOME`, `SAGE_HOME` and the home setting of each agent tool to folders in your scratch folder, and `DO_NOT_TRACK=1`, for the install and for each proof.
3. Read each proof first. Refuse a proof that writes outside your scratch folder, or runs a git command that the stop gate refuses (above): do not run it, and give it could not run.
4. Run each other proof there as written. Run nothing but the install and the proofs.
5. Compare the output with the `saw` line, or the screen with the screenshot:
   - reproduced: the problem shows again;
   - not reproduced: the command ran, and the problem does not show; also a finding with no proof;
   - could not run: the command did not run (a refusal, yours or a hook's, a missing tool, a setup step that the proof does not give).
6. Remove the worktree.

## Limits

- The scratch homes are a rule of the text only: the hook does not check the environment of a proof (standing order 70).
- The stop gate reads the command as written. A disguised form, such as a variable or text piped into a shell, is a documented limit (standing order 70): the proof check reads each proof before it runs it.
- A real problem that no command can show yet, such as a gap in a design, can be dropped. The drop is in the decision trail and in your report, and the chief can open the finding again.
