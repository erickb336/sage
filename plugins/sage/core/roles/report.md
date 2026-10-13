# The sage report

End your work with this report, and nothing after it. The chief of staff reads many reports, so keep it short: about 2,000 tokens or fewer, with long material in files that you name. {{REPORT_GATE}} Write "none" in a field that has nothing.

```
STATUS        done, blocked or question
RESULT        the outcome, in the words your brief asks for (for example PASS or FAIL, CLEAN or FINDINGS)
EVIDENCE      each command you ran and its result; the paths of screenshots or output files
FINDINGS      none, or one line for each problem: - <key> <severity> <summary>, where the severity is high, medium or low and the summary gives the location and the steps that show it
QUESTIONS     each product question, its options and your recommendation
NOT VERIFIED  what you did not check, and why
BRANCH        the branch, its head SHA and the pull request link
```

Give each field once, at the start of a line that is not in a list or a code block. Under FINDINGS, write `none` alone, or one line for each finding in that form: a dash, the key, the severity, then the summary, for example `- F1 medium src/app.js:12 an empty name saves a blank row`. The key has a digit (F1, K2). Put any detail of a finding, such as the attack or the steps, on indented lines under its line; a detail line does not start with a severity word. If a line names a severity above the finding's, write that problem as its own finding line. A role that finds no problems, such as an implementer, writes `none` and lists what it fixed in EVIDENCE.

The hook reads the report of a review or QA with one reader. It never reads a lower severity than you wrote, and it never reads a finding as none: a line that it cannot read makes the report unreadable. Start its RESULT with CLEAN, PASS, FINDINGS or FAIL; FINDINGS and FAIL need at least one finding. A finding is a line with a list mark, then the key, then the severity, with only marks around the severity (a colon, brackets, bold or a dash). The report is unreadable when a field is given twice (also FINDINGS as an indented line or a list item), when RESULT starts with another word, or when a line under FINDINGS is not `none` alone, a finding or indented detail under a finding. A line whose first or second word is a severity word, or that has a severity word with a colon after it (`high:`), is never detail. One global rule covers the rest: when any line under FINDINGS, a finding, detail or prose, has a severity word above the highest finding that the hook read, the report is unreadable. The hook reads the words `high`, `medium` and `low`, and `critical`, `severe` and `blocker` as `high`, as whole words in any case, also in look-alike letters, full-width letters or with zero-width characters. So `- K1 low a log, K2 high a crash` is unreadable, and so is detail such as `steps: load a high row count` under a low finding. The hook stops you once to fix an unreadable report, and a lead records no verdict from it: the sage reads it.

Every claim has its evidence in the same report: the command and what it printed, or a screenshot. "It works" without a command or a screenshot is not evidence.
