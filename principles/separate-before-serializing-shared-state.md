---
id: separate-before-serializing-shared-state
name: Separate before serializing shared state
applyWhen: concurrent actors might write to the same file, branch, key or state object.
source: pstack principle-separate-before-serializing-shared-state, MIT, Copyright (c) 2026 Lauren Tan, github.com/cursor/plugins, adapted; checked against pstack 0.15.36 at commit 0bb6f37
---

When concurrent actors might share state that changes, first ask whether they need the same object. If not, remove the sharing. When the sharing is real, enforce one writer at a time by structure: lock files, sequential phases or exclusive ownership. Instructions and conventions are not concurrency control.

**Why.** Concurrent writes to shared state cause race conditions. They are intermittent, hard to reproduce and expensive to debug.

**What to do.**
1. **Find the shared state that changes:** files that both read and write, branches that both push to, APIs that both define and consume.
2. **By default, remove the shared write target.** Ask: do these actors need one canonical object, or do they publish independent facts? Give each actor its own file, key, branch or state folder. Merge the results only where they are read or reported. Two actors that each write their own `lastX` field into one `state.json` still share it; `indexer-state.json` and `metrics-state.json` do not.
3. **Only when one shared write target is a real invariant, serialise access by structure:** lock files, sequential phases, a single writer or an atomic compare-and-swap. Treat "we need a lock" as a design smell to check, not as the default answer.
