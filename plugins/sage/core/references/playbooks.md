# Playbooks

The chief reads one section of this page when a request or the work is of that kind. The chief's trigger lines name each section. A playbook says how agents and the owner work together on one kind of work, so that sage works the same way on that kind of work in Claude and in Codex.

Each playbook has the same five parts. (A part is not a step: a step is one block of a task's route.)

1. **How the chief knows:** the sign in the request or in the work.
2. **Agents prepare:** the work that makes the owner's answer cheap. Agents do it before the owner sees anything.
3. **The owner's moment:** one small choice, with the recommendation first. It names its message kind: the presentation skill has the shape of each kind. Before the question, the message says what happens if the owner does not answer.
4. **After the answer:** the logbook records it (the gate's answer, or `sage log`). The next brief of the task starts with it, in DECISIONS.
5. **The owner learns:** one idea, with a real example. Put it in the message as one short paragraph, the first time that the owner meets the idea.

The owner took the recommendation in 29 of 33 answers (count of 10 November 2026). So ask less where the work is easy to undo, and let the recommendation go ahead. Architecture is different: there the owner often gives their own design, so show pictures, not long text.

## Design

1. **How the chief knows:** the task changes what a user sees: a screen, a message or a word in the product.
2. **Agents prepare:** the designer, then the PE check.
   - 2 or 3 options behind one switch, each with a label.
   - Every state: empty, loading, error and success.
   - Sample data, labelled as sample.
   - The cost of each option.
   - The cases that the design does not decide (see **Undecided case**).
3. **The owner's moment:** message kind `design`, with a page. The options side by side, one picture each, what changes for the owner, and the cost. The recommendation is first.
   - Answers: pick A, B or C, or pick one and mark the parts of the others to keep.
   - If the owner does not answer: nothing is built. Other tasks go on.
4. **After the answer:** the gate's answer records the pick. The pick and the dropped options stay in the task's pages folder. The task moves to the build, and the UX review compares the build with the pick.
5. **The owner learns:** **sample data.** A prototype uses made-up data, so that the owner judges the experience, not the numbers. Example: the autopilot design used made-up tasks. The owner approved the design only; the build was a separate step.

## Architecture

1. **How the chief knows:** a new part, a new file or record, a new link between parts, or a choice that has no example in the code. Or the PE check says that the plan has no example in the code.
2. **Agents prepare:** the designer or the PE, in the design step. This playbook gives a large task with no screen its design.
   - A picture of the parts today.
   - 2 different shapes, not 2 versions of one shape.
   - For each shape: at most 6 boxes, and the data that each part keeps.
   - A check for warning signs: hidden shared data, many special cases.
   - For each shape: the cost, the risk, and what it ties the project to.
3. **The owner's moment:** message kind `question`, with one `architecture` picture for each shape, side by side on its page. Under each picture: what changes for the owner (speed, what they see, what can break, what it ties the project to).
   - Answers: A, B, or "you decide".
   - If the owner does not answer: a shape that is internal and easy to change goes ahead as recommended. A shape that changes data that the owner keeps, or what the owner sees, waits.
4. **After the answer:** a decision row names the dropped shape and why. The chosen picture is the contract in the build brief. When the build must change the shape twice, stop the build and run this playbook again.
5. **The owner learns:** **coupling.** How much one part must know about another. With less coupling, you can change one part without breaking the others. Example: in the shared logbook, Claude and Codex read one task list, but each task has one owner chief. That rule keeps their work apart.

## Refactor

1. **How the chief knows:** the request or a plan says remove, delete, merge, rename, simplify, clean up or dead code. Or an audit lists items to cut.
2. **Agents prepare:**
   - A test that pins what the code does today.
   - A removal table: the item, who uses it, what changes for the owner, and the risk.
   - Two groups: no change for the owner, and a change that the owner would notice.
3. **The owner's moment:** message kind `question`, with only the second group: one numbered row for each item that the owner would notice (a guard, a command, a part of a page), each with its recommended mark, remove or keep.
   - Answers: accept the marks, or change single rows.
   - If the owner does not answer: the items with no change for the owner go ahead. The items that the owner would notice wait.
4. **After the answer:** a decision row for each group. The pinned test still passes after the change. The change log names what the owner would notice.
5. **The owner learns:** **pin the behaviour.** Write a test of what the code does today before you change its shape. If the test still passes after the change, nothing that the owner relies on changed. Example: when sage removed 19 checks against rare tricks, the plain checks stayed: a plain push to main is still refused.

## Investigation

1. **How the chief knows:** an open question: how does, why, should we, what are we missing, compare, are we sure.
2. **Agents prepare:** the chief fills the brief's fields. GOAL holds the question, ACCEPTANCE the decision and the form of the result, and BUDGET the stop rule.
   - The question in one line, and the decision that it feeds.
   - 2 to 4 guesses, each with the evidence that would prove it wrong.
   - The stop rule: a budget, or "stop when X is known".
   - The form of the result: the decisions first, the detail after, on the research page.
3. **The owner's moment:** message kind `request understood` at the start, with 4 lines: the question, the guesses, the stop rule and what the owner gets. Message kind `progress` at the midpoint of a long run, with 3 lines: found so far, next, go or stop. Message kind `report` at the end, then one `question` for each decision.
   - Answers: at the start, nothing (go) or a correction in the owner's words. At the end, a pick for each decision.
   - If the owner does not answer: the start and midpoint notes do not wait, and the run goes on. The decisions at the end wait.
4. **After the answer:** each correction and pick becomes a decision row. Each chosen option becomes a task with a priority. The research page stays as the detail behind the result.
5. **The owner learns:** **a guess that can be proved wrong.** A good guess comes with the evidence that would kill it, so the research can stop when that evidence is in. Example: the work map guessed that many abandoned tasks meant weak starts. It checked, found that most were closed in bulk, and dropped the claim.

## Milestone

1. **How the chief knows:** one request needs two or more tasks for one goal, and at least one of them waits for another. Or a milestone starts.
2. **Agents prepare:** the chief frames every task first, with its `--waits`, then proposes once: `sage milestone propose --name "<name>" --goal "<goal>" --pilot <T> --tasks <T,T>`. Each task gets its own pull request.
   - Each task, framed with a size, a priority and a cost range.
   - The "waits for" links.
   - The pilot: the task with the riskiest unknown.
   - The done condition: a count of tasks.
   - A PE check of the breakdown.
3. **The owner's moment:** message kind `question` for the breakdown gate, in the task's one batch of questions, with a page. The page has the task picture (about 8 boxes or fewer, the pilot in the double box), a cost table, the done condition, and the first thing that the owner will see after the pilot.
   - Answers: approve, change (in the owner's words) or drop.
   - If the owner does not answer: nothing builds. The design and PE checks of the tasks may go on.
4. **After the answer:**
   - Approve: the milestone is active. The pilot builds and merges first, end to end. After it merges, a `progress` note of 3 lines says what it proved; then the other tasks build.
   - Change: propose again (`sage milestone propose <M>`), and tell the owner what changed.
   - Drop: take each task that has not ended out of the milestone with `milestone=none`.
   - Tell the owner in one line when a task joins or leaves after the approval. When the pilot is abandoned, propose a new pilot.
   - The sage skill has the other milestone rules. The tool refuses a wrong step and names the fix.
5. **The owner learns:** **the pilot.** Run one task end to end before the others. Then a wrong plan costs one task, not ten. Example: before more Codex work, one small real task goes through the Codex desktop app from start to merge.

## Undecided case

1. **How the chief knows:** an agent reports "the task does not say what happens when …". Or a bug whose right result is not written down, or two people expect different results.
2. **Agents prepare:** one table for all the cases of the task, with one row for each case.
   - The situation, in a user's words.
   - Today's result: a screenshot or an output.
   - The result under each option.
   - A recommendation, and why.
   - Engineering details (formats, internal names) are not cases: the chief decides them and logs them.
3. **The owner's moment:** message kind `question`, with the case table as numbered rows and the recommended answer in each row. Ask once, in the task's one batch of questions, before the build.
   - Answers: accept all, or change single rows.
   - If the owner does not answer: the rows that change what a user sees wait. The engineering rows go ahead.
4. **After the answer:** each answer becomes an acceptance line and a test in the build brief, and a decision row. QA checks each case in the real app.
5. **The owner learns:** **special case.** A branch in code for one situation. An undecided case becomes one by accident, and then nobody knows why it is there. Example: if a Codex model cannot show question cards, how does sage ask? The owner chose numbered choices in the chat.

## New rule or guard

1. **How the chief knows:** a mistake comes back twice, an incident, or the owner's correction. Propose to seal the lesson.
2. **Agents prepare:** seal the lesson at the highest level that works: the architecture, a type, a check whose error names the fix, a test, and a written rule (a principle or `sage standing add`) last.
   - The past mistake, with 2 cases.
   - The level, from that order.
   - Proof that each new check fails on the past mistake.
   - How often it would stop normal work (false alarms).
   - The old rules that it replaces.
3. **The owner's moment:** message kind `question`, with the mistake, the check, the proof and the cost. Ask the owner before you change sage itself.
   - Answers: add it, keep it as a note only, or skip.
   - If the owner does not answer: nothing changes in sage.
4. **After the answer:** a task builds the check, and the rules that it replaces are retired. Keep the rule table. A `lesson kept` message tells the owner the lesson once, and where it lives now.
5. **The owner learns:** **seal the lesson.** Give a mistake that comes back a fix that holds by itself, and prove that the fix catches the old mistake. Example: agents twice ran the real process list in tests. Now the hook refuses that command and names the fake one to use.

## Broken behaviour or setup

1. **How the chief knows:** something that worked fails: an error, or a command or check that fails. Or a setup does not work: an install, a hook, a sign-in or a setting. When the right result is not clear, use **Undecided case**.
2. **Agents prepare:** a small task (tiny when the fix is obvious).
   - The failure, reproduced: the command and its output, or a screenshot.
   - The root cause: where the system first did the wrong thing. After a restart or an update, suspect stale state first: settings, caches, trust and lock files.
   - A test that fails because of the bug, before the fix.
   - When only the owner can fix it (an install, a sign-in, a setting on their machine): the steps for them.
3. **The owner's moment:** message kind `report` when the fix merges: what was broken, the cause, and how we know that it works now. Message kind `steps for you` when only the owner can act. Message kind `incident` when an agent did what it must not do, or sage told the owner something wrong. Message kind `question` only when two fixes differ in what the owner sees; recommend the fix at the root cause.
   - Answers: usually none. With `steps for you`, the owner does the steps.
   - If the owner does not answer: the fix goes through its route, and nothing waits. A step that only the owner can do waits for them, and so does the work that needs it.
4. **After the answer:** the failing test passes and stays as a guard. A decision row records each cause that the chief decided. When the same failure comes back, run **New rule or guard**.
5. **The owner learns:** **root cause.** The place where the system first went wrong, not the place where the error showed. A fix there stops the failure; a fix where it showed only hides it. Example: after a sage update, the Codex hooks went silent. The hooks had no bug: the update made Codex treat them as untrusted, and the fix was to trust them again.

## Feature

1. **How the chief knows:** a request to add or change what the product does, which ends in a merged pull request. An open question is an **Investigation**, and a repair is **Broken behaviour or setup**.
2. **Agents prepare:**
   - The request in the chief's own words, the entry point (where a user starts it and what they install), and what done looks like.
   - A quick check that the request is needed: is it there already, or is the cause elsewhere?
   - The frame: size, risk flags, priority and kind, which give the least route.
   - For a large task, its **Design** or **Architecture** and the PE check. The cases that the task does not decide go to **Undecided case**, and two or more tasks with a wait go to **Milestone**.
3. **The owner's moment:** message kind `request understood` at the start, and message kind `report` at the end.
   - Answers: at the start, nothing (go) or a correction in the owner's words. At the end, with autopilot off, the owner merges.
   - If the owner does not answer: at the start, the work goes on with the defaults that the message names. A track of more than one pull request waits for the owner's yes on the entry point. At the end, the pull request waits at verified for the owner's merge (autopilot off), or merges after its clean cycles (autopilot on).
4. **After the answer:** a correction becomes a decision row. The entry point and the decisions go into every brief of the task. The task runs its route to the merge check, and the `report` names each piece of work, how we know that it works, and what we did not check.
5. **The owner learns:** **clean cycle.** One full set of fresh reviews and QA on one head commit. A new commit starts again from cycle 1, so what merges is exactly what was checked. Example: with autopilot on, a small task merges after 1 clean cycle, and a large task or one with a risk flag after 2.
