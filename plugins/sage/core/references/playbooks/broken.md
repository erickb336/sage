# Broken behaviour or setup

The chief reads this playbook at the moment that its line in the chief's text names, and follows its five parts. In the owner's moment, the recommendation comes first, and the message says what happens with no answer before it asks; the presentation skill has the shape of each message kind. The logbook records the answer (the gate's answer, or `sage log`), and the task's next brief starts with it, in DECISIONS. Teach the idea of the last part in one short paragraph, the first time that the owner meets it.

1. **How the chief knows:** something that worked fails: an error, or a command or check that fails. Or a setup does not work: an install, a hook, a sign-in or a setting. When the right result is not clear, use **Undecided case** (`undecided-case.md`).
2. **Agents prepare:** a small task (tiny when the fix is obvious).
   - The failure, reproduced: the command and its output, or a screenshot.
   - The root cause: where the system first did the wrong thing. After a restart or an update, suspect stale state first: settings, caches, trust and lock files.
   - A test that fails because of the bug, before the fix.
   - When only the owner can fix it (an install, a sign-in, a setting on their machine): the steps for them.
3. **The owner's moment:** message kind `report` when the fix merges: what was broken, the cause, and how we know that it works now. Message kind `steps for you` when only the owner can act. Message kind `incident` when an agent did what it must not do, or sage told the owner something wrong. Message kind `question` only when two fixes differ in what the owner sees; recommend the fix at the root cause.
   - Answers: usually none. With `steps for you`, the owner does the steps.
   - If the owner does not answer: the fix goes through its route, and nothing waits. A step that only the owner can do waits for them, and so does the work that needs it.
4. **After the answer:** the failing test passes and stays as a guard. A decision row records each cause that the chief decided. When the same failure comes back, run **New rule or guard** (`new-rule.md`).
5. **The owner learns:** **root cause.** The place where the system first went wrong, not the place where the error showed. A fix there stops the failure; a fix where it showed only hides it. Example: after a sage update, the Codex hooks went silent. The hooks had no bug: the update made Codex treat them as untrusted, and the fix was to trust them again.
