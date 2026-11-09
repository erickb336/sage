---
id: redesign-from-first-principles
name: Redesign from first principles
applyWhen: you add a new requirement to an existing design.
source: pstack principle-redesign-from-first-principles, MIT, Copyright (c) 2026 Lauren Tan, github.com/cursor/plugins at 6b03002, adapted
---

When you add a change, do not bolt it onto the existing design. Redesign as if the requirement had been a basic assumption from the start.

- Read all the files that the change affects, and understand the current design.
- Ask: "If we wrote this from the start with the new requirement, what would we build?"
- Carry the change through every reference: types, docs, examples and the sections that give the reasons.
- Think through the whole redesign, then deliver it in small steps.

**Why.** This method keeps your options open when a change comes into an existing design.
