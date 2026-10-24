# Sage dry run 1

> **A dated record.** This is the report of the first dry run, on 4 Oct 2026, before the fixes that came from it. sage changed much after it: see the [changelog](../../CHANGELOG.md). It was converted from an HTML page; its words are as they were, except one old word for the merge check, and the tables that replace its chart.

4 Oct 2026 · sage mode in one headless Claude Code session · every agent on Sonnet 5.5 · **sample project and sample data: every trip and email address is made up**

**What this is.** The first full run of the sage loop. The chief of staff got two requests on a demo command-line tool: a bug and a CSV export. It ran them through the team without any human in the loop.

**Result.** The bug fix (T1) is verified, and the merge check allows it. The CSV export (T2) is built and passes its tests, but the session ended during its last review. That's a limit of the headless test mode, not of sage. The gates held without having to block once. The run also showed nine things to fix, listed below.

**What the author needed from the owner.** Nothing. The fixes went into the merge of agent-kit and sage.

| Number | What it counts |
| --- | --- |
| 28 | agent runs in 10 minutes |
| $5.28 | the whole run, at API prices |
| 3 | the most agents at once (the cap was 3) |
| T1 may merge | 2 clean cycles on 4787c81 |
| T2 not done | the session ended in review |

## The loop, as it ran

Each row is one agent run, from the moment the chief recorded its start to the moment it recorded its report (times in hours, minutes and seconds of the session's clock).

| Run | Task | Role | Round | Start | End |
| --- | --- | --- | --- | --- | --- |
| R1 | T1 | implementer | 0 | 00:58:57 | 00:59:43 |
| R2 | T2 | designer | 0 | 00:58:57 | 01:00:09 |
| R3 | T2 | designer | 0 | 00:58:57 | 01:00:44 |
| R4 | T1 | code-reviewer | 0 | 00:59:44 | 01:00:18 |
| R5 | T1 | security-reviewer | 0 | 01:00:18 | 01:01:07 |
| R6 | T1 | qa | 0 | 01:00:18 | 01:00:57 |
| R7 | T2 | pe | 0 | 01:00:44 | 01:01:30 |
| R8 | T1 | implementer | 1 | 01:01:09 | 01:01:53 |
| R9 | T2 | implementer | 0 | 01:01:30 | 01:02:19 |
| R10 | T1 | code-reviewer | 1 | 01:01:54 | 01:02:32 |
| R11 | T1 | security-reviewer | 1 | 01:01:54 | 01:02:49 |
| R12 | T2 | code-reviewer | 0 | 01:02:19 | 01:03:13 |
| R13 | T1 | qa | 1 | 01:02:32 | 01:03:13 |
| R14 | T1 | implementer | 2 | 01:02:53 | 01:03:49 |
| R15 | T1 | code-reviewer | 2 | 01:03:49 | 01:04:21 |
| R16 | T1 | security-reviewer | 2 | 01:03:49 | 01:04:34 |
| R17 | T1 | qa | 2 | 01:03:49 | 01:04:41 |
| R18 | T2 | implementer | 1 | 01:04:38 | 01:05:39 |
| R19 | T1 | code-reviewer | 2 | 01:04:46 | 01:05:32 |
| R20 | T1 | security-reviewer | 2 | 01:04:46 | 01:06:00 |
| R21 | T2 | code-reviewer | 1 | 01:05:39 | 01:06:20 |
| R22 | T2 | security-reviewer | 1 | 01:05:39 | 01:06:37 |
| R23 | T1 | qa | 2 | 01:06:00 | 01:06:41 |
| R24 | T2 | ux-reviewer | 1 | 01:06:20 | 01:07:01 |
| R25 | T2 | implementer | 2 | 01:07:01 | 01:07:45 |
| R26 | T2 | code-reviewer | 2 | 01:07:45 | 01:08:34 |
| R27 | T2 | security-reviewer | 2 | 01:07:45 | 01:08:52 |
| R28 | T2 | qa | 2 | 01:07:45 | 01:08:37 |
| R29 | T2 | ux-reviewer | 2 | 01:08:34 | still running |

Each verdict in the ledger, in time order for each task:

| Task | Time | Commit | Cycle | Verdict |
| --- | --- | --- | --- | --- |
| T1 | 00:59:43 | `e5739e7` | 1 | checks-pass |
| T1 | 01:00:18 | `e5739e7` | 1 | review-clean |
| T1 | 01:00:57 | `e5739e7` | 1 | qa-pass |
| T1 | 01:01:07 | `e5739e7` | 1 | findings |
| T1 | 01:01:53 | `a4a1387` | 1 | checks-pass |
| T1 | 01:02:32 | `a4a1387` | 1 | review-clean |
| T1 | 01:02:49 | `a4a1387` | 1 | findings |
| T1 | 01:03:49 | `4787c81` | 1 | checks-pass |
| T1 | 01:04:22 | `4787c81` | 1 | review-clean |
| T1 | 01:04:34 | `4787c81` | 1 | security-clean |
| T1 | 01:04:41 | `4787c81` | 1 | qa-pass |
| T1 | 01:05:32 | `4787c81` | 2 | review-clean |
| T1 | 01:06:00 | `4787c81` | 2 | security-clean |
| T1 | 01:06:41 | `4787c81` | 2 | qa-pass |
| T2 | 01:02:19 | `ddfb86b` | 1 | checks-pass |
| T2 | 01:03:13 | `ddfb86b` | 1 | findings |
| T2 | 01:05:39 | `0ece3eb` | 1 | checks-pass |
| T2 | 01:06:20 | `0ece3eb` | 1 | review-clean |
| T2 | 01:06:37 | `0ece3eb` | 1 | findings |
| T2 | 01:07:45 | `fc1f4bf` | 1 | checks-pass |
| T2 | 01:08:34 | `fc1f4bf` | 1 | review-clean |
| T2 | 01:08:38 | `fc1f4bf` | 1 | qa-pass |
| T2 | 01:08:52 | `fc1f4bf` | 1 | security-clean |

## T1: the bug

`trips list --since ""` and `--since 2026-13-40` crashed. Required: a clear error and exit code 2. The chief sized it small and added the security review, because the fix handles user input.

| Step | What happened |
| --- | --- |
| Build | The implementer validated the date and printed an error. The checks passed. |
| Cycle on e5739e7 | Code review clean, QA pass. The security review found that the error message repeated the raw input, so terminal escape codes could reach the screen. |
| Repair round 1 → a4a1387 | A fresh implementer escaped the input. The security review found that some control characters and Unicode direction marks still got through. |
| Repair round 2 → 4787c81 | A fresh implementer allowed only printable characters, with one shared helper for the whole tool. The chief logged why: "A denylist missed C1/bidi. An allowlist closes the whole class." |
| 2 clean cycles on 4787c81 | Code review, security review and QA were clean twice. The merge check says "T1 may merge: 2 clean cycles on this SHA". |

### The author's own check, outside the agents

21 of 21 tests pass. `--since ""` and `--since 2026-13-40` print a clear error and exit with 2. A valid date lists the trips. An escape code in the input is shown as `\u001b`.

## T2: the CSV export

Required: `trips export --format csv`, without deleted trips. The chief sized it large, with risk flags for personal data and input, and ran an arena of 2 for the design.

| Step | What happened |
| --- | --- |
| Arena | Two designers worked side by side. The PE picked candidate 2 as the base and took one test from candidate 1. Its reason: "built, 16 tests pass, one validation point, merges clean with the --since fix". |
| Design approval | Recorded as gate G10, "keep (dry run)", because no user was present. |
| Build and review | The code review found a weak test and a number exported as text. Both were fixed. Three low findings were dismissed, each with a reason. |
| Shared code | The chief held T2's repair until T1 was final, so T2 could reuse T1's safe error helper instead of writing a second one. |
| Round 2 → fc1f4bf | Code review clean, security review clean, QA pass. The UX review was still running when the session ended. Two findings marked "fix" were repaired but never closed, so the merge check correctly refused T2. |
| Self-correction | The chief dismissed a security finding, then saw that its reason was wrong, and logged the correction. |

### The author's own check

43 of 43 tests pass. The export prints 3 trips, without the deleted one, and escapes quote marks correctly. A missing `--format` prints an error with an example and exits with 2.

## What went wrong, and the fix for each

Each fix goes into code or into the instructions, so the next run doesn't repeat it.

| Problem | Evidence | Fix |
| --- | --- | --- |
| The headless session ended while an agent was still running | The last message: "The UX review on fc1f4bf is still running" | For tests: drive the session until no run is open. Interactive sessions on the desktop or phone wait by themselves. |
| Too many questions: 12 gates for 2 tasks | "LF or CRLF?", "UTF-8 BOM?" are engineering defaults, not product questions | The chief decides and logs engineering defaults, and asks at most one batched question per task. |
| Low findings started repair rounds | T1's first repair was for a low finding. 11 of 16 findings were low | The state tool: a repair round needs a medium or high finding. Low ones join a round or get dismissed. |
| 2 cycles ran without autopilot | T1 ran a second full cycle, and autopilot was off | "Verified" needs 1 clean cycle. Only an autopilot merge needs 2. |
| No token counts | status: "about 0k tokens" | The chief records each agent's tokens from its result. |
| A value starting with "--" was lost | 2 findings have the summary "true" | Fix the state tool's argument parser. |
| The chief's first state tool calls failed | "Zsh doesn't split the variable; I'll use a function." | The hook gives a ready shell function line. |
| Repaired findings stayed open | T2: 2 findings open on a clean head | A clean verdict lists the open fix findings, so the chief closes them. |
| status.md was out of date | It still said T1 "repairing" | Write status.md after every change. |

## Cost

$5.28 for the whole run, at API prices. On your subscription, it counts against your usage limits instead. By number of runs, each task took about half: T1 used 15 runs and T2 14. The design's estimates were too low for small tasks: a small task with a risk flag, 2 repair rounds and 2 cycles cost about $2.60, against an estimate of $0.30 to $1.50. The fixes above (no repair rounds for low findings, 1 cycle unless autopilot) cut that most.

Basis: the session's own total. The split by task is an estimate from run counts.
