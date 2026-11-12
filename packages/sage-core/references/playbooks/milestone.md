# Milestone

The chief reads this playbook at the moment that its line in the chief's text names, and follows its five parts. In the owner's moment, the recommendation comes first, and the message says what happens with no answer before it asks; the presentation skill has the shape of each message kind. The logbook records the answer (the gate's answer, or `sage log`), and the task's next brief starts with it, in DECISIONS. Teach the idea of the last part in one short paragraph, the first time that the owner meets it.

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
