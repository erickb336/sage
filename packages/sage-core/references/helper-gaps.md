# A helper with no report, or a report that the hook cannot read

A lead reads this page when a helper ends with no report, or when the hook cannot read a review or QA report.

## A report that the hook cannot read

- A review or QA report that the hook cannot read backs no verdict, and only the sage can end its run.
- Do not end that run, and do not stop for it. Name the run in FINDINGS of your report as a gap, and go on with your other helpers.
- The wait does not return for that run, because only the sage ends it. The wait names the run once, in the first output that has it. It lists each such run again when no helper of yours runs.
- End blocked only when no helper of yours runs. The sage reads the report and ends the run.

## A helper with no report

- A helper that ends with no report (the sage stopped it, or it died) ends as `sage run done <R> --status failed`.
- When the hook says that the helper's slot still holds its lease, wait, or ask the sage to end the run. The sage's `run done` frees the helper's slot at once. Then add a new run.
- Never stop a helper yourself: the hook refuses your TaskStop.
- Never end or use a run that you did not add: ask the sage.
