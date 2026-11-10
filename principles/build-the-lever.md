---
id: build-the-lever
name: Build the lever
applyWhen: the work is not trivial: edits, migrations, analyses or checks.
source: pstack principle-build-the-lever, MIT, Copyright (c) 2026 Lauren Tan, github.com/cursor/plugins, adapted; checked against pstack 0.15.36 at commit 0bb6f37
---

When the work is not trivial, build a tool that does it or proves it: a script, codemod, generator or skill.

**Why.** A tool works the same way each time and reruns for free. A reviewer reruns it instead of redoing the work.

**What to do.**
- Skip the tool only for a few obvious edits. The bar is triviality, not repetition: a one-off task earns a tool when the tool makes it checkable.
- Do the first unit by hand. Then build the tool, rerun it on that unit and compare. Make it safe to rerun.
- Edits get a codemod or script, repeated files a generator, analysis a query, and verification a check that reruns.
- When one pass covers every unit, run the tool yourself instead of sending subagents to do the work by hand.
- For subagents, write the tool as one skill: the recipe, the check and the files not to touch, outside their write scope.
- Keep the tool small, never a framework. Commit it when the work outlives the session.

**The test.** If you cite this principle and the diff has no script, codemod, generator or skill, you did not apply it.
