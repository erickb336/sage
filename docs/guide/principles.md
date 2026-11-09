# Principles

A principle is a short rule for one kind of moment, for example "test behaviour, not implementation" when you change a test. In sage mode, each role agent starts with the principles of its role.

<!-- The principles table comes from principles/: edit them there, then run npm run build. -->

There are 25 principles: 24 come from pstack, by Lauren Tan (MIT), and 1 is sage's own. sage keeps its own text of each one and does not follow later pstack changes.

<details>
<summary><strong>All 25 principles</strong></summary>

| Principle | Apply when |
| --- | --- |
| attack-the-premise<br>*pstack, adapted* | two or more fixes that share one premise have failed the same check or review |
| boundary-discipline<br>*pstack, adapted* | reviewing or writing validation, error handling or framework adapters |
| build-the-lever<br>*pstack, adapted* | the work is not trivial: edits, migrations, analyses or checks |
| contextualize-and-write-for-the-reader<br>*sage's own* | writing anything someone else will read later: a design, a handoff, findings, a report, a verification, a brief, a reply |
| encode-lessons-in-structure<br>*pstack, adapted* | writing the same instruction a second time, or noticing a correction that keeps recurring |
| exhaust-the-design-space<br>*pstack, adapted* | a new interaction or an architectural choice has no precedent in the code |
| experience-first<br>*pstack, adapted* | a product, UX or scope trade-off comes up |
| explain-the-number<br>*pstack, adapted* | you plan a measurement, or you trust, report or act on a number that you measured: a speedup, a regression, a throughput, a latency or an eval result |
| fix-root-causes<br>*pstack, adapted* | debugging a failure or repairing a finding |
| foundational-thinking<br>*pstack, adapted* | before writing logic, when choosing core types and data structures or ordering scaffold against features |
| guard-the-context-window<br>*pstack, adapted* | the context fills up: large outputs, long files, repeated reads or planning a fan-out |
| laziness-protocol<br>*pstack, adapted* | refactoring, judging a diff's size, or tempted to add an abstraction, a layer or a threaded signal |
| make-operations-idempotent<br>*pstack, adapted* | you design commands, lifecycle steps or processing loops that run among crashes, restarts and retries |
| migrate-callers-then-delete-legacy-apis<br>*pstack, adapted* | a change introduces a new internal API while callers of the old one still exist |
| minimize-reader-load<br>*pstack, adapted* | reviewing or shaping code that is hard to follow |
| model-the-domain<br>*pstack, adapted* | you write stateful logic, or code branches a lot or repeats an assumption about a shape across files |
| never-block-on-the-human<br>*pstack, adapted* | tempted to ask "should I do X?" about reversible work |
| outcome-oriented-execution<br>*pstack, adapted* | a planned rewrite or migration has explicit phase boundaries |
| prove-it-works<br>*pstack, adapted* | before declaring a task done, or when judging a claim that something works |
| redesign-from-first-principles<br>*pstack, adapted* | you add a new requirement to an existing design |
| separate-before-serializing-shared-state<br>*pstack, adapted* | concurrent actors might write to the same file, branch, key or state object |
| sequence-verifiable-units<br>*pstack, adapted* | multi-step work (a sweep, a migration, a run of similar edits) or the order of commits in a change |
| subtract-before-you-add<br>*pstack, adapted* | ordering an addition, a refactor or a rewrite |
| test-behavior-not-implementation<br>*pstack, adapted* | writing, changing or keeping a test |
| type-system-discipline<br>*pstack, adapted* | you design types, review a function signature or write code in a statically typed language |

Under each name, a note says where its text comes from:

- "pstack, adapted" is sage's text of a pstack principle: it is shorter, and it follows sage's writing standard. Its `source` line names the pstack commit that it comes from.
- "sage's own" has no pstack source.

</details>

<!-- The end of the principles table. -->

Agents seldom load a skill by themselves, so each **role** brings its principles:

- A Claude Code agent loads them from the `skills:` list of its agent file.
- A Codex role agent gets them in its role text.
- One map in core, `ROLE_PRINCIPLES` in `packages/sage-core/roles.mjs`, says which role gets which principle. `npm run check` checks the agent files against it.

Outside sage mode, no hook gives a principle: name one in your request, for example "apply prove it works".

## Where the principles come from

sage's principles come from pstack, by Lauren Tan (MIT). sage keeps its own text of each one and does not follow later pstack changes. [CONTRIBUTING.md](../../CONTRIBUTING.md#credit) shows how a principle credits pstack.
