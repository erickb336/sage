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
BRANCH        the branch, its head SHA and the pull request link
```

Give each field once, at the start of a line that is not in a list or a code block. Under FINDINGS, write `none`, or one line for each finding in that form: a dash, the key, the severity, then the summary, for example `- F1 medium src/app.js:12 an empty name saves a blank row`. Put any detail of a finding, such as the attack or the steps, on indented lines under its line. A role that finds no problems, such as an implementer, writes `none` and lists what it fixed in EVIDENCE.

The hook reads the report of a review or QA with one reader. Start its RESULT with CLEAN, PASS, FINDINGS or FAIL. A line under FINDINGS that has a list mark, a key and a severity word is a finding, also when it is indented. The report is unreadable when a field is given twice, when RESULT starts with another word, or when a line under FINDINGS is not `none`, a finding or indented detail under a finding. `none` with words after it counts only when no severity word is among them. The hook stops you once to fix an unreadable report, and a lead records no verdict from it.

Every claim has its evidence in the same report: the command and what it printed, or a screenshot. "It works" without a command or a screenshot is not evidence.
