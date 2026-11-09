---
id: make-operations-idempotent
name: Make operations idempotent
applyWhen: you design commands, lifecycle steps or processing loops that run among crashes, restarts and retries.
source: pstack principle-make-operations-idempotent, MIT, Copyright (c) 2026 Lauren Tan, github.com/cursor/plugins at 6b03002, adapted
upstream: 7aa9327cf1f1aa05
---

Design each operation to reach the correct state, however often it runs and wherever the last run stopped.

**Why.** Crashes, restarts and retries are normal. If a partial state changes the next run, each restart becomes debugging.

**What to do.**
- Derive each step from the state that exists, not from what the last run meant to do. Read the current state, compare it with the goal, and apply only the difference. A repeat then finds nothing to do.
- Make each leftover recognisable as stale to the next run: a lock, a temporary file, a half-written record or a claimed job. Judge staleness by evidence that stays true wherever the last run stopped, not only in the common case. A marker that the next run cannot judge turns each crash into manual cleanup.
- For example, write to a temporary path and rename it into place; compare files by content, not creation order.

**The test.**
1. What if it runs twice in a row?
2. What if the last run crashed at any point?
3. Does a new run reach the same end state?

If an answer depends on leftover state, add a step that reconciles it.
