---
id: outcome-oriented-execution
name: Outcome-oriented execution
applyWhen: a planned rewrite or migration has explicit phase boundaries.
source: pstack principle-outcome-oriented-execution, MIT, Copyright (c) 2026 Lauren Tan, github.com/cursor/plugins, adapted; checked against pstack 0.15.36 at commit 0bb6f37
---

Aim for the end state that you intend and can verify, not for smooth intermediate states.

**Why.** When each intermediate step must stay fully stable, you write temporary compatibility code, and it often becomes lasting debt. Move to the target architecture, and prove it correct at explicit verification boundaries.

**The rule.**
- Put the integrity of the end state before stability during the change.
- Breakage between phases is acceptable when it is planned, scoped and reversible.

**Guardrails.**
- Use this only for planned rewrites and migrations with explicit phase boundaries.
- Say where temporary breakage is acceptable.
- Keep strong checks on the areas that you change during the migration.
- At the end of the plan, run the full static and runtime verification.
