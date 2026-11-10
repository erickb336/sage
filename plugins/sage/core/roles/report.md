# The sage report

End your work with this report, and nothing after it. The chief of staff reads many reports, so keep it short: about 2,000 tokens or fewer, with long material in files that you name. {{REPORT_GATE}} Write "none" in a field that has nothing.

```
STATUS        done, blocked or question
RESULT        the outcome, in the words your brief asks for (for example PASS or FAIL, CLEAN or FINDINGS)
EVIDENCE      each command you ran and its result; the paths of screenshots or output files
FINDINGS      {{REPORT_FINDINGS}}
QUESTIONS     each product question, its options and your recommendation
NOT VERIFIED  what you did not check, and why
BRANCH        the branch, its full 40-character head SHA (the commit you checked, after the word head) and the pull request link
```

{{REPORT_FINDING_RULES}}

In a review or QA, each medium or high finding carries its proof, on indented lines under it: `proof: <one command, run from the repository root of the head>` and `saw: <the one output line that shows the problem>`, or for a screen `proof: screenshot <path>` and `steps: <the url and the actions>`. The command only reads, or writes only into your scratch folder; it runs no inline code, and git only to read. A proof check reruns it on a fresh copy of the head after the project's dependency install (such as `npm ci --ignore-scripts`), and drops a medium finding that does not show again. Put long output in a scratch file, and name its path. In a proof, saw or steps line, put output with a higher severity word in backticks. A low finding needs no proof.

Every claim has its evidence in the same report: the command and what it printed, or a screenshot. "It works" without a command or a screenshot is not evidence.
