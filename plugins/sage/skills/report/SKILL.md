---
name: report
description: "The report that every sage agent ends with: STATUS, RESULT, EVIDENCE, FINDINGS, QUESTIONS, NOT VERIFIED, BRANCH. Use at the end of any task that the sage chief of staff gave you. Claude Code only."
license: MIT
---

# The sage report

End your work with this report, and nothing after it. The chief of staff reads many reports, so keep it short: about 2,000 tokens or fewer, with long material in files that you name. The sage hook does not let you finish until each field starts a line. Write "none" in a field that has nothing.

```
STATUS        done, blocked or question
RESULT        the outcome, in the words your brief asks for (for example PASS or FAIL, CLEAN or FINDINGS)
EVIDENCE      each command you ran and its result; the paths of screenshots or output files
FINDINGS      none, or one line for each problem: - <key> <severity> <summary>, where the severity is high, medium or low and the summary gives the location and the steps that show it
QUESTIONS     each product question, its options and your recommendation
NOT VERIFIED  what you did not check, and why
BRANCH        the branch, its full 40-character head SHA (the commit you checked, after the word head) and the pull request link
```

Give each field once, at the start of a line that is not in a list or a code block. Under FINDINGS, write `none` alone, or one line for each finding in that form: a dash, the key, the severity, then the summary, for example `- F1 medium src/app.js:12 an empty name saves a blank row`. The key has a digit (F1, K2). Put any detail of a finding, such as the attack or the steps, on indented lines under its line. If a problem has a severity above the finding's, write that problem as its own finding line. A role that finds no problems, such as an implementer, writes `none` and lists what it fixed in EVIDENCE.

The hook reads the report of a review or QA with one reader. It never reads a lower severity than you wrote, and it never reads a finding as none: a line that it cannot read makes the report unreadable. Start its RESULT with CLEAN, PASS, FINDINGS or FAIL; FINDINGS and FAIL need at least one finding. A finding is a line with a list mark, then the key, then the severity, with only marks around the severity (a colon, brackets, bold or a dash). The report is unreadable when a field is given twice (also FINDINGS as an indented line or a list item), when RESULT starts with another word, or when a line under FINDINGS is not `none` alone, a finding or indented detail under a finding. An indented line in the form of a finding is not detail.

A finding's severity is the word after its key; the rest of its line and its detail lines are text. A line that states a severity above its finding's makes the report unreadable: a severity word next to a key (`K2 high`), with marks or a colon (`(raise to medium)`, `high:`), not in lower case (`HIGH`), at the start of a line, or at the end of a line after an ordinary word (`rated high`). A lower-case severity word after a, an or the, or between two ordinary words, is text: `a high row count`, `not a blocker.`, `not ok 3 a high finding is refused`. The words are `high`, `medium` and `low`, and `critical`, `severe` and `blocker` as `high`, in any case, also in full-width letters or with zero-width characters. The hook stops you once to fix an unreadable report, and names the line; a lead records no verdict from it: the sage reads it.

In a review or QA, each medium or high finding carries its proof, on indented lines under it: `proof: <one command, run from the repository root of the head>` and `saw: <the one output line that shows the problem>`, or for a screen `proof: screenshot <path>` and `steps: <the url and the actions>`. The command only reads, or writes only into your scratch folder; it runs no inline code, and git only to read. A proof check reruns it on a fresh copy of the head after the project's dependency install (such as `npm ci --ignore-scripts`), and drops a medium finding that does not show again. Put long output in a scratch file, and name its path. A proof, saw or steps line states no severity above its finding's (as in `K2 high`). A low finding needs no proof.

Every claim has its evidence in the same report: the command and what it printed, or a screenshot. "It works" without a command or a screenshot is not evidence.
