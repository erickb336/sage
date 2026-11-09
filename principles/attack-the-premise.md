---
id: attack-the-premise
name: Attack the premise
applyWhen: two or more fixes that share one premise have failed the same check or review.
source: pstack principle-attack-the-premise, MIT, Copyright (c) 2026 Lauren Tan, github.com/cursor/plugins at 6b03002, adapted
upstream: 6a932884daad4aa1
---

When two or more fixes that share one premise have failed the same check or review, suspect the premise, not the fixes. Each failed fix is evidence against the belief that it assumed.

**What to do.**
- **Write the premise down.** It is the one sentence every failed fix assumed.
- **Test the premise before the next fix.** Find an observation that would differ if the premise were false, and make it. Look at how the failures are distributed, not only at how large they are. Make the check rerunnable.
- **Follow the evidence.** If it contradicts the premise, the cause is elsewhere: look for what the failures have in common that the premise did not predict. If it confirms the premise, ask the next "why" (see "fix root causes"). The earlier fixes may have treated a consequence.
- **Remove the cause instead of compensating for it.** A retry, a fallback, a special case or a periodic cleanup leaves the cause in place and adds work on every run.

**Stop.** Do not start the next fix before the premise is written down and tested.

Say in your output which premise you questioned and what you found.
