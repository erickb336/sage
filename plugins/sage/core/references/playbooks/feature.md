# Feature

The chief reads this playbook at the moment that its line in the chief's text names, and follows its five parts. In the owner's moment, the recommendation comes first, and the message says what happens with no answer before it asks; the presentation skill has the shape of each message kind. The logbook records the answer (the gate's answer, or `sage log`), and the task's next brief starts with it, in DECISIONS. Teach the idea of the last part in one short paragraph, the first time that the owner meets it.

1. **How the chief knows:** a request to add or change what the product does, which ends in a merged pull request. An open question is an **Investigation** (`investigation.md`), and a repair is **Broken behaviour or setup** (`broken.md`).
2. **Agents prepare:**
   - The request in the chief's own words, the entry point (where a user starts it and what they install), and what done looks like.
   - A quick check that the request is needed: is it there already, or is the cause elsewhere?
   - The frame: size, risk flags, priority and kind, which give the least route.
   - For a large task, its **Design** (`design.md`) or **Architecture** (`architecture.md`) and the PE check. The cases that the task does not decide go to **Undecided case** (`undecided-case.md`), and two or more tasks with a wait go to **Milestone** (`milestone.md`).
3. **The owner's moment:** message kind `request understood` at the start, and message kind `report` at the end.
   - Answers: at the start, nothing (go) or a correction in the owner's words. At the end, with autopilot off, the owner merges.
   - If the owner does not answer: at the start, the work goes on with the defaults that the message names. A track of more than one pull request waits for the owner's yes on the entry point. At the end, the pull request waits at verified for the owner's merge (autopilot off), or merges after its clean cycles (autopilot on).
4. **After the answer:** a correction becomes a decision row. The entry point and the decisions go into every brief of the task. The task runs its route to the merge check, and the `report` names each piece of work, how we know that it works, and what we did not check.
5. **The owner learns:** **clean cycle.** One full set of fresh reviews and QA on one head commit. A new commit starts again from cycle 1, so what merges is exactly what was checked. Example: with autopilot on, a small task merges after 1 clean cycle, and a large task or one with a risk flag after 2.
