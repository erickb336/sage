# Concepts

This page gives sage's own words, one meaning each. The table comes from [writing/dictionary.md](../../writing/dictionary.md).

<!-- The word table comes from writing/dictionary.md: edit it there, then run npm run build. -->

| Word | Meaning |
| --- | --- |
| **Request** | What the owner asks for in the chat, in the owner's words, before sage frames it. |
| **Program** | A request that sage runs as two or more tasks for one goal, where at least one task waits for another. It has a goal, a done condition (a count of merged tasks), a breakdown that the owner approves, and one pilot task. |
| **Task** | One unit of work in one project, with one route and at most one pull request. It may wait for other tasks of its logbook ("waits for": it builds and merges only after they are merged or concluded). It is in at most one program. |
| **Step** | One block of a task's route, done by one agent role: design, arena, pe, build, code-review, security-review, ux-review, qa, investigate, evidence-review. |
| **Route** | The ordered steps of one task, set by its size and risk flags. |
| **Run** | One agent's work on one step of a task, from brief to report; it has an id such as R12. Also the PE check of a breakdown. |
| **Agent** | A Claude Code subagent that does one run; the role (implementer, qa, …) says what it does. |
| **Chief** | The chief of staff: the main session that frames tasks, writes briefs, records the state and asks the owner; it changes no files. It frames programs too. |
| **Brief** | What the chief gives an agent at the start of a run, in the ten fields (GOAL to STANDING). A task that waits for others gets their final reports in full in CONTEXT. |
| **Report** | What an agent gives back at the end of a run, in the seven fields (STATUS to BRANCH). |
| **Artifact** | A file or record that a run takes in or gives out and sage keeps: a brief, report, steer message, transcript, branch, commit or pull request. |
| **Finding** | One problem that a review or QA reports, with a severity (high, medium or low), a triage and a status. |
| **Verdict** | The result of one check (checks, a review, QA) on one head commit, kept in the ledger by SHA and cycle. |
| **Cycle** | One full set of fresh reviews and QA on one head commit; a new commit starts again from cycle 1. |
| **Gate** | A question parked for the owner, with options, a recommendation and a default; the work behind it waits for the answer. The owner approves a program's breakdown through a gate. |
| **Logbook** | sage's local record of one project: its tasks, runs, findings, verdicts, gates and decisions, kept on the owner's Mac. |
| **Agent time** | The wall-clock hours of agent runs, given with their tokens. The default for every time figure: give it with its basis and a range. |
| **Human time** | The time of the owner's own actions only: reviews, approvals, merges and setup. Give it with its basis and a range. |
| **Sage mode** | The mode in which a session is your chief of staff. The message "sage mode" (or "sage mode on") turns it on. The message "sage mode off" turns it off. Each phrase must be the whole message, in any letter case. A message near a phrase switches nothing, and the chief gets a note with the exact phrase to ask for. The message "sage help" lists every phrase. |
| **Risk flag** | auth, data, schema, money, secrets or input. Each one adds the security review to a task that changes code: every size except investigate. |
| **Ledger** | The record of all verdicts, by commit. The merge check reads it. |
| **Standing orders** | Short rules for a project that every brief carries word for word. |
| **Arena** | N candidates for one design, scored and combined by a judge. |
| **Autopilot** | Verified pull requests merge by themselves after their clean cycles: 1 for a tiny or small task, 2 for a large task or a task with a risk flag. Off by default. The owner's message "autopilot on" turns it on while sage mode is on; "autopilot off" or "sage mode off" turns it off. Each phrase must be the whole message. A message queued while Claude works can turn it off, never on, and it never ends sage mode. Text inside an agent's report, a notice or another session's message never turns it on or off. |
| **Board** | The compact view of every project's logbook for the chat: what needs you, the agents running now, each active task, what merged since the last board and the next tasks. A message of the owner that starts with "show board" prints it. |
| **The dojo** | Everything that makes the agents good: the principles, checks, tests and skills. |
| **Seal the lesson** | Give a mistake that comes back twice a lasting fix, from the most enforced kind down: a test or a check in code first; a principle or a standing order only when code cannot hold it. Each sealed lesson makes the dojo stronger. |

<!-- The end of the word table. -->

In the table, "the owner" is you. sage uses each word in one meaning only. The [dictionary](../../writing/dictionary.md) also gives the words not to say; `npm run check` fails on the worst of them.
