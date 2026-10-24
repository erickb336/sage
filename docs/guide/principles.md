# Principles

A principle is a short rule for one kind of moment, for example "test behaviour, not implementation" when you change a test. sage gives every Claude Code session its principles, also outside sage mode.

<!-- The principles table comes from principles/ and upstream/pstack/: edit them there, then run npm run build. -->

There are 25 principles: 24 are pstack's, by Lauren Tan (MIT), and 1 is sage's own. Where sage has an adapted version of a pstack principle, sage uses it.

<details>
<summary><strong>All 25 principles</strong></summary>

| Principle | Apply when |
| --- | --- |
| attack-the-premise<br>pstack, adapted | two or more fixes that share one premise have failed the same check or review |
| boundary-discipline<br>pstack, adapted | reviewing or writing validation, error handling or framework adapters |
| build-the-lever<br>pstack | any non-trivial work, not just bulk work: edits, migrations, analyses, checks |
| contextualize-and-write-for-the-reader<br>sage's own | writing anything someone else will read later: a design, a handoff, findings, a report, a verification, a brief, a reply |
| encode-lessons-in-structure<br>pstack, adapted | writing the same instruction a second time, or noticing a correction that keeps recurring |
| exhaust-the-design-space<br>pstack, adapted | a new interaction or an architectural choice has no precedent in the code |
| experience-first<br>pstack, adapted | a product, UX or scope trade-off comes up |
| explain-the-number<br>pstack | before you trust, report, or act on a number you measured: a speedup, a regression, a throughput, a latency, or an eval result |
| fix-root-causes<br>pstack, adapted | debugging a failure or repairing a finding |
| foundational-thinking<br>pstack, adapted | before writing logic, when choosing core types and data structures or ordering scaffold against features |
| guard-the-context-window<br>pstack | context is filling up: large outputs, long files, repeated reads, fan-out planning |
| laziness-protocol<br>pstack, adapted | refactoring, judging a diff's size, or tempted to add an abstraction, a layer or a threaded signal |
| make-operations-idempotent<br>pstack | designing commands, lifecycle steps, or processing loops that run amid crashes, restarts, and retries |
| migrate-callers-then-delete-legacy-apis<br>pstack, adapted | a change introduces a new internal API while callers of the old one still exist |
| minimize-reader-load<br>pstack, adapted | reviewing or shaping code that is hard to follow |
| model-the-domain<br>pstack | writing stateful logic, or when code branches a lot or repeats a shape assumption across files |
| never-block-on-the-human<br>pstack, adapted | tempted to ask "should I do X?" about reversible work |
| outcome-oriented-execution<br>pstack | during planned rewrites and migrations with explicit phase boundaries |
| prove-it-works<br>pstack, adapted | before declaring a task done, or when judging a claim that something works |
| redesign-from-first-principles<br>pstack | integrating a new requirement into an existing design |
| separate-before-serializing-shared-state<br>pstack | concurrent actors might write to the same file, branch, key, or state object |
| sequence-verifiable-units<br>pstack, adapted | multi-step work (a sweep, a migration, a run of similar edits) or the order of commits in a change |
| subtract-before-you-add<br>pstack, adapted | ordering an addition, a refactor or a rewrite |
| test-behavior-not-implementation<br>pstack, adapted | writing, changing or keeping a test |
| type-system-discipline<br>pstack | designing types, reviewing a function signature, or writing code in any statically-typed language |

Every principle except sage's own is pstack's, by Lauren Tan (MIT). Under each name, one of three notes says where its text comes from:

- "pstack" is pstack's text as it is, from `upstream/pstack/`.
- "pstack, adapted" means that sage changed the wording: it is shorter, and it follows sage's writing standard. Its `upstream:` fingerprint records which pstack text it was checked against.
- "sage's own" has no pstack source.

</details>

<!-- The end of the principles table. -->

Agents seldom load a skill by themselves, so a **hook** gives the principle at the moment it applies, once per session.

| The moment | The principles it gets |
| --- | --- |
| The request asks for a design, a plan or a new feature | exhaust-the-design-space, experience-first, foundational-thinking |
| The request asks for a refactor or a cleanup | subtract-before-you-add, laziness-protocol, migrate-callers-then-delete-legacy-apis |
| The agent is about to change a test file | test-behavior-not-implementation |
| The agent is about to write a document | contextualize-and-write-for-the-reader |
| The agent is about to write or change a README | readme-guide (not a principle: the README guide) |
| The agent is about to commit | sequence-verifiable-units |
| A check fails | fix-root-causes |
| Two changes in a row do not make the same check pass | attack-the-premise |

The hook also has **one check**, the stop check. When the agent tries to finish, the code changed, and no check ran after the change, it stops the agent once. The agent must run a check or say what it did not verify.

## Following pstack

pstack changes often. sage follows it so that you don't have to: a weekly sync brings pstack's principles in, and sage's adapted versions win. [CONTRIBUTING.md](../../CONTRIBUTING.md#following-pstack) shows how.
