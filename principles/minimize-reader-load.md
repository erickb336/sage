---
id: minimize-reader-load
name: Minimise reader load
applyWhen: reviewing or shaping code that is hard to follow.
source: pstack principle-minimize-reader-load, MIT, Copyright (c) 2026 Lauren Tan, github.com/cursor/plugins, adapted; checked against pstack 0.15.36 at commit 0bb6f37
---

Maintainability is the work a reader does to understand the code. Track two axes: **layers to trace** (indirections between the question and the answer) and **state to hold** (hidden or mutable context). Line counts, complexity scores and "clean architecture" are proxies. The axes are independent: a flat file with fifty globals can be as hard as a six-layer adapter stack. Guard both.

- **Collapse layers** that cost more than they save: one-caller wrappers, adapters with no second implementation, unneeded indirection.
- **Make each layer change the abstraction.** A pass-through layer adds load without compression.
- **Demand interface compression.** A boundary hides real decisions; a broad interface that hides little makes the reader learn both sides.
- **Shrink state scope:** pure functions over mutation, locals over fields, fields over module state, module state over globals. Derive instead of synchronising.
- **Name the invariant at the boundary,** not in every consumer.
- Add a layer or state only when it saves at least as much reader load elsewhere.

**The test.** Can a new reader answer "where does X come from?" and "what can change X?" in thirty seconds? If not, cut layers or state. A reviewer reports it in a finding.
