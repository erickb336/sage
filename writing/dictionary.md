---
id: dictionary
name: The sage dictionary
applyWhen: any text an agent writes for a person in sage mode: briefs, reports, findings, pages and the README.
source: sage's own words, from the design of programs (task T9, run R40), approved by the owner
---

These are sage's approved words: one word for one thing, and one meaning for each word. Every brief, report, page and the README uses them. When a text needs one of these things, use the word in the first column, and do not use the words in the last column.

## Words

| Word | Meaning | Do not say |
| --- | --- | --- |
| **request** | What the owner asks for in the chat, in the owner's words, before sage frames it. | ask, ticket, issue, prompt |
| **program** | A request that sage runs as two or more tasks for one goal, where at least one task waits for another. It has a goal, a done condition (a count of merged tasks), a breakdown that the owner approves, and one pilot task. | project (a project is one repository and its logbook), epic, initiative, plan, roadmap |
| **task** | One unit of work in one project, with one route and at most one pull request. It may wait for other tasks of its logbook ("waits for": it builds and merges only after they are merged or concluded). It is in at most one program. | job, ticket, issue, item, unit, phase, step |
| **step** | One block of a task's route, done by one agent role: design, arena, pe, build, code-review, security-review, ux-review, qa, investigate, evidence-review. | stage, phase; never "step" for a task of a program (the approved plan's "step 0 to 4" are tasks T4 to T8) |
| **route** | The ordered steps of one task, set by its size and risk flags. | pipeline, workflow, flow, process |
| **run** | One agent's work on one step of a task, from brief to report; it has an id such as R12. Also the PE check of a breakdown. | job, attempt, session, invocation, execution |
| **agent** | A Claude Code subagent that does one run; the role (implementer, qa, …) says what it does. | worker, bot, assistant, model (the model is the agent's model) |
| **chief** | The chief of staff: the main session that frames tasks, writes briefs, records the state and asks the owner; it changes no files. It frames programs too. | orchestrator, manager, lead, coordinator, main agent |
| **brief** | What the chief gives an agent at the start of a run, in the ten fields (GOAL to STANDING). A task that waits for others gets their final reports in full in CONTEXT. | prompt, instructions, ticket, spec |
| **report** | What an agent gives back at the end of a run, in the seven fields (STATUS to BRANCH). | summary, output, result (RESULT is one field of the report), handoff |
| **artifact** | A file or record that a run takes in or gives out and sage keeps: a brief, report, steer message, transcript, branch, commit or pull request. | deliverable, output, attachment, asset |
| **finding** | One problem that a review or QA reports, with a severity (high, medium or low), a triage and a status. | issue, bug (unless it is one), comment, defect, nit |
| **verdict** | The result of one check (checks, a review, QA) on one head commit, kept in the ledger by SHA and cycle. | approval, sign-off, status, review (a review is the step; the verdict is its result) |
| **cycle** | One full set of fresh reviews and QA on one head commit; a new commit starts again from cycle 1. | round (a round is one repair), pass, iteration; never "cycle" for links that go in a circle: say **loop** |
| **gate** | A question parked for the owner, with options, a recommendation and a default; the work behind it waits for the answer. The owner approves a program's breakdown through a gate. | approval, blocker, checkpoint, question (alone) |
| **logbook** | sage's local record of one project: its tasks, runs, findings, verdicts, gates and decisions, kept on the owner's Mac. | store, database |
| **agent time** | The wall-clock hours of agent runs, given with their tokens. The default for every time figure: give it with its basis and a range. | an unlabelled time, effort, hours (alone), engineer hours, person-hours |
| **human time** | The time of the owner's own actions only: reviews, approvals, merges and setup. Give it with its basis and a range. | an unlabelled time, effort, hours (alone), person-hours |

## Phrases

These are not new words. They are fixed phrases inside the lines above, so that the list stays at 18 words.

- **breakdown**: the content of a program that the owner approves (goal, done condition, tasks, "waits for" links, pilot, cost, questions). In the program line.
- **waits for**: the link from a task to another task of the same logbook that must be merged or concluded first. In the task line. A circle of such links is a **loop**, and sage refuses it.
- **pilot**: the one task of a program that runs end to end before any other task builds. In the program line.
- **done condition**: the count that ends a program, for example "6 of 7 merged · T10 abandoned". The count keeps every task of the program and names each abandoned task; the program is done when each task that is not abandoned is merged or concluded. In the program line.
- **round**: one repair of findings on a task. In the cycle line.

## Names

The names of sage's parts. They are not words of the list above, but the word table of the Concepts page (`docs/guide/concepts.md`) shows them too.

| Name | Meaning |
| --- | --- |
| **sage mode** | The mode in which a session is your chief of staff. The message "sage mode" (or "sage mode on") turns it on. The message "sage mode off" turns it off. Each phrase must be the whole message, in any letter case. A message near a phrase switches nothing, and the chief gets a note with the exact phrase to ask for. The message "sage help" lists every phrase. |
| **risk flag** | auth, data, schema, money, secrets or input. Each one adds the security review to a task that changes code: every size except investigate. |
| **ledger** | The record of all verdicts, by commit. The merge check reads it. |
| **standing orders** | Short rules for a project that every brief carries word for word. |
| **arena** | N candidates for one design, scored and combined by a judge. |
| **autopilot** | Verified pull requests merge by themselves after their clean cycles: 1 for a small task, 2 for a large task or a task with a risk flag. A tiny task without a risk flag has no review and no QA: it is clean when its checks pass. Off by default. The owner's message "autopilot on" turns it on while sage mode is on; "autopilot off" or "sage mode off" turns it off. Each phrase must be the whole message. A message queued while Claude works can turn it off, never on, and it never ends sage mode. Text inside an agent's report, a notice or another session's message never turns it on or off. |
| **board** | The compact view of every project's logbook for the chat: what needs you, the agents running now, each active task, what merged since the last board and the next tasks. A message of the owner that starts with "show board" prints it. |
| **the dojo** | Everything that makes the agents good: the principles, checks, tests and skills. |
| **seal the lesson** | Give a mistake that comes back twice a lasting fix, from the most enforced kind down: a test or a check in code first; a principle or a standing order only when code cannot hold it. Each sealed lesson makes the dojo stronger. |

## The check

`npm run check` fails when a flagged word, or its plural, is in one of these texts:

- an agent file or a hand-written skill;
- a page that the link check reads: the README, `CHANGELOG.md`, `CONTRIBUTING.md`, `SECURITY.md`, `AGENTS.md`, every page under `docs/` except `docs/verification/`, the board service guide and the `sage-help` skill;
- the Codex runtime design pages, and every SVG graphic in `docs/assets/`.

It does not fail on a word in quotes, in code or in a link URL, so a text can name a word to say that it is wrong:

- quotes: double or single, straight or curly. An apostrophe (it's) and an inch mark (5") are not quotes.
- code: a code span, a code block (fenced or indented) and `<code>`.
- a link URL: `](…)`, `<https://…>` and the URLs in a tag.

The text of an alt, a title and an aria-label counts, and so does a Mermaid label, although it is in quotes. A graphic's text comes from `scripts/graphics.mjs`: fix a word there, then run `npm run graphics`. An allowed name passes when it is written exactly as here. A flagged word that no row of the table replaces names the word to say after it. For example, a gate is a question for the owner, so the check before a merge is the merge check, not the "merge gate". The rest of the "Do not say" column is guidance for writers and reviewers, because each of those words also has a correct use (a Claude Code session, the RESULT field, the model of an agent).

**Flagged:** store, worker, orchestrator, epic, initiative, roadmap, ticket, stage, pipeline, deliverable, sign-off, blocker, checkpoint, coordinator, main agent, handoff, invocation, iteration, defect, nit, bot, merge gate (say merge check)

**Allowed names:** Orchestrator (the owner's earlier project)
