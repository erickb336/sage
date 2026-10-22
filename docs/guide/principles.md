# Principles

A principle is a short rule for one kind of moment, for example "test behaviour, not implementation" when you change a test. sage gives every Claude Code session its principles, also outside sage mode.

<!-- The principles table comes from principles/ and upstream/pstack/: edit them there, then run npm run build. -->

There are 25 principles: 24 are pstack's, by Lauren Tan (MIT), and 1 is sage's own. Where sage has an adapted version of a pstack principle, sage uses it.

<details>
<summary><strong>All 25 principles</strong></summary>

| Principle | Apply when | Text |
| --- | --- | --- |
| attack-the-premise | two or more fixes that share one premise have failed the same check or review | pstack, adapted |
| boundary-discipline | reviewing or writing validation, error handling or framework adapters | pstack, adapted |
| build-the-lever | any non-trivial work, not just bulk work: edits, migrations, analyses, checks | pstack |
| contextualize-and-write-for-the-reader | writing anything someone else will read later: a design, a handoff, findings, a report, a verification, a brief, a reply | sage's own |
| encode-lessons-in-structure | writing the same instruction a second time, or noticing a correction that keeps recurring | pstack, adapted |
| exhaust-the-design-space | a new interaction or an architectural choice has no precedent in the code | pstack, adapted |
| experience-first | a product, UX or scope trade-off comes up | pstack, adapted |
| explain-the-number | before you trust, report, or act on a number you measured: a speedup, a regression, a throughput, a latency, or an eval result | pstack |
| fix-root-causes | debugging a failure or repairing a finding | pstack, adapted |
| foundational-thinking | before writing logic, when choosing core types and data structures or ordering scaffold against features | pstack, adapted |
| guard-the-context-window | context is filling up: large outputs, long files, repeated reads, fan-out planning | pstack |
| laziness-protocol | refactoring, judging a diff's size, or tempted to add an abstraction, a layer or a threaded signal | pstack, adapted |
| make-operations-idempotent | designing commands, lifecycle steps, or processing loops that run amid crashes, restarts, and retries | pstack |
| migrate-callers-then-delete-legacy-apis | a change introduces a new internal API while callers of the old one still exist | pstack, adapted |
| minimize-reader-load | reviewing or shaping code that is hard to follow | pstack, adapted |
| model-the-domain | writing stateful logic, or when code branches a lot or repeats a shape assumption across files | pstack |
| never-block-on-the-human | tempted to ask "should I do X?" about reversible work | pstack, adapted |
| outcome-oriented-execution | during planned rewrites and migrations with explicit phase boundaries | pstack |
| prove-it-works | before declaring a task done, or when judging a claim that something works | pstack, adapted |
| redesign-from-first-principles | integrating a new requirement into an existing design | pstack |
| separate-before-serializing-shared-state | concurrent actors might write to the same file, branch, key, or state object | pstack |
| sequence-verifiable-units | multi-step work (a sweep, a migration, a run of similar edits) or the order of commits in a change | pstack, adapted |
| subtract-before-you-add | ordering an addition, a refactor or a rewrite | pstack, adapted |
| test-behavior-not-implementation | writing, changing or keeping a test | pstack, adapted |
| type-system-discipline | designing types, reviewing a function signature, or writing code in any statically-typed language | pstack |

Every principle except sage's own is pstack's, by Lauren Tan (MIT). "pstack" is pstack's text as it is, from `upstream/pstack/`. "pstack, adapted" means that sage changed the wording: it is shorter, and it follows sage's writing standard. Its `upstream:` fingerprint records which pstack text it was checked against. "sage's own" has no pstack source.

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
