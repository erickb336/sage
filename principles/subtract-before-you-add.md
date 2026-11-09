---
id: subtract-before-you-add
name: Subtract before you add
applyWhen: ordering an addition, a refactor or a rewrite.
source: pstack principle-subtract-before-you-add, MIT, Copyright (c) 2026 Lauren Tan, github.com/cursor/plugins, adapted; checked against pstack 0.15.36 at commit 0bb6f37
---

When you change a system, remove complexity first, then build. Default to subtraction.

Treat simplification as a continual investment. Leave the design a little simpler, and a little more capable, behind the same or a smaller surface than you found it.

- Remove before you construct.
- Cut before you polish: get to the minimum before you invest in quality.
- Design for observed usage, not speculative edge cases.
- No speculative validators, parsers or guards beyond what the specification demands.
- Simplify instructions and prompts: remove redundant lines and excess templates.
- When a reference has no content of its own, delete it rather than leaving a stub.

**Stop** subtracting when the next removal would change behaviour the specification asks for. Report that instead.
