# Refactor

The chief reads this playbook at the moment that its line in the chief's text names, and follows its five parts. In the owner's moment, the recommendation comes first, and the message says what happens with no answer before it asks; the presentation skill has the shape of each message kind. The logbook records the answer (the gate's answer, or `sage log`), and the task's next brief starts with it, in DECISIONS. Teach the idea of the last part in one short paragraph, the first time that the owner meets it.

1. **How the chief knows:** the request or a plan says remove, delete, merge, rename, simplify, clean up or dead code. Or an audit lists items to cut.
2. **Agents prepare:**
   - A test that pins what the code does today.
   - A removal table: the item, who uses it, what changes for the owner, and the risk.
   - Two groups: no change for the owner, and a change that the owner would notice.
3. **The owner's moment:** message kind `question`, with only the second group: one numbered row for each item that the owner would notice (a guard, a command, a part of a page), each with its recommended mark, remove or keep.
   - Answers: accept the marks, or change single rows.
   - If the owner does not answer: the items with no change for the owner go ahead. The items that the owner would notice wait.
4. **After the answer:** a decision row for each group. The pinned test still passes after the change. The pull request description names what the owner would notice.
5. **The owner learns:** **pin the behaviour.** Write a test of what the code does today before you change its shape. If the test still passes after the change, nothing that the owner relies on changed. Example: when sage removed 19 checks against rare tricks, the plain checks stayed: a plain push to main is still refused.
