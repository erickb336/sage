---
id: fix-root-causes
name: Fix root causes
applyWhen: debugging a failure or repairing a finding.
source: pstack principle-fix-root-causes, MIT, Copyright (c) 2026 Lauren Tan, github.com/cursor/plugins, adapted; checked against pstack 0.15.36 at commit 0bb6f37
---

Fix the fault where it started, not where it surfaced. The root cause is where the system first did something wrong, or missed a state that it should handle.

**Why.** A symptom fix hides the evidence, and the fault surfaces again elsewhere.

**What to do.**
- Reproduce first.
- Ask "why" until the answer is a wrong decision in the code, not a consequence of an earlier one.
- **Ask whether the state is legitimate.** If it may occur, handle it in the code that broke on it. If not, a guard, retry, swallowed error, clamped value or discarded state there hides the bug: find what made the state.
- A workaround that needs a paragraph to justify it means the code is wrong.
- Fix every instance of the same shape.
- When stuck, measure: add logging, read the actual error and state.
- If the deciding fact was hard to find, propose a cheap, always-on signal that would have shown it at once.

**After a restart,** suspect stale persistent state before code: configuration files, caches, lock files, serialised state.

**Stop** when the reproduction no longer fails for the reason you found, not when the symptom is hidden.
