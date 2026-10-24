# Active-task workflow and guarded publication

The chief uses `workflow.mjs` beside this skill. It stores mode by canonical project and current Codex session. A new session starts off. This helper runs during an active task; it is not a daemon. The chief alone calls it. Native permissions, sandbox, hooks and protected refusals stay in force.

Send one JSON object through stdin. Use a structured stdin API or a safely written file. Never interpolate owner text into shell code. Every request has `action`, the absolute `project` checkout and the actual current Codex `session` identity. Do not invent or reuse a session identity after uncertain continuity.

| Action | Additional fields | Result |
| --- | --- | --- |
| `status` | none | Mode, publisher verification and publication outcomes. |
| `owner` | `text`, `directOwner: true`, `evidence` | Applies one exact owner mode phrase. Evidence is an absolute local file with the direct instruction. |
| `capability` | `evidence` | Records separate verification evidence for this installed publisher file. |
| `register` | `task`, `repo`, `base`, `manualConfirmed: true`, `noKnownNativeAssignment: true`, `admissionJournals` | Binds a manual task, its recorded branch and PR to this session. |
| `publish` | `task`, `sha` | Checks eligibility and submits one exact-head merge. |
| `reconcile` | `task` | Reads a prior intent's actual PR outcome without another merge submission. |

Example status input:

```json
{"action":"status","project":"/absolute/project","session":"actual-current-codex-session"}
```

Before `capability`, retain evidence of the required build, checks and independent reviews for the installed publisher. This action records the chief's verification; it does not perform or authenticate those reviews. Autopilot requires this record, Sage on and a direct owner instruction. A changed publisher file invalidates the verification. After uncertain continuity, record Sage off and require direct owner re-entry.

Before registration, resolve task ownership. The task must use declared Codex `collaboration-tools` manual runs. `admissionJournals` lists every known native journal relevant to this task. Use an empty list only after the chief confirms that none are known. The helper rejects native preparations and assignments in these journals. It cannot discover a hidden journal. A declaration is not cryptographic identity or global admission enforcement. Never register a task to work around a protected API refusal.

The first version supports same-repository PRs on github.com and uses squash. Registration names the expected `repo` (`owner/repository`) and `base` branch. Publication requires the current checkout's matching origin, branch and full reviewed SHA. The core merge check enforces the task's required cycles, findings and gates. Every specialist must finish. GitHub must report an open, non-draft, mergeable PR and successful checks. Empty or incomplete check results refuse, including more than 100 checks or statuses.

The helper writes a durable intent before the fixed-argument GitHub REST merge request. The request includes the expected head SHA. It never uses admin, queue, auto-merge, force or branch deletion. GitHub's merge endpoint does not support merge queues. Branch protection remains effective.

Any submitted intent prevents a second submission, including a failed or lost response. Use `reconcile` to inspect GitHub. An open PR remains unresolved; no automatic retry occurs. A confirmed merge moves the task through the core state tool. If that local transition fails, the result reports `localState: unresolved`; preserve the intent and resolve the task before reconciliation.

Sage off disables autopilot. Autopilot off preserves Sage mode. Off prevents later submissions after the command acquires the logbook lock. It cannot cancel an external request already in flight. Reconciliation works while off and grants no new authority. The chief still stops owned agents through the host tools and verifies their outcomes.
