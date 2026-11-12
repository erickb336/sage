# Undecided case

The chief reads this playbook at the moment that its line in the chief's text names, and follows its five parts. In the owner's moment, the recommendation comes first, and the message says what happens with no answer before it asks; the presentation skill has the shape of each message kind. The logbook records the answer (the gate's answer, or `sage log`), and the task's next brief starts with it, in DECISIONS. Teach the idea of the last part in one short paragraph, the first time that the owner meets it.

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
