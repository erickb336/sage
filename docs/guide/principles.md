# Principles

A principle is a short rule for one kind of moment, for example "test behaviour, not implementation" when you change a test. In sage mode, each role agent starts with the principles of its role.

<!-- The principles table comes from principles/: edit them there, then run npm run build. -->

There are 25 principles: 24 come from pstack, by Lauren Tan (MIT), and 1 is sage's own. sage keeps its own text of each one. The baseline below compares each text with pstack's latest text.

<details>
<summary><strong>All 25 principles</strong></summary>

| Principle | Apply when |
| --- | --- |
| attack-the-premise<br>*from pstack* | two or more fixes that share one premise have failed the same check or review |
| boundary-discipline<br>*from pstack* | reviewing or writing validation, error handling or framework adapters |
| build-the-lever<br>*from pstack* | the work is not trivial: edits, migrations, analyses or checks |
| contextualize-and-write-for-the-reader<br>*sage's own* | writing anything someone else will read later: a design, a handoff, findings, a report, a verification, a brief, a reply |
| encode-lessons-in-structure<br>*from pstack* | writing the same instruction a second time, or noticing a correction that keeps recurring |
| exhaust-the-design-space<br>*from pstack* | a new interaction or an architectural choice has no precedent in the code |
| experience-first<br>*from pstack* | a product, UX or scope trade-off comes up |
| explain-the-number<br>*from pstack* | you plan a measurement, or you trust, report or act on a number that you measured: a speedup, a regression, a throughput, a latency or an eval result |
| fix-root-causes<br>*from pstack* | debugging a failure or repairing a finding |
| foundational-thinking<br>*from pstack* | before writing logic, when choosing core types and data structures or ordering scaffold against features |
| guard-the-context-window<br>*from pstack* | the context fills up: large outputs, long files, repeated reads or planning a fan-out |
| laziness-protocol<br>*from pstack* | refactoring, judging a diff's size, or tempted to add an abstraction, a layer or a threaded signal |
| make-operations-idempotent<br>*from pstack* | you design commands, lifecycle steps or processing loops that run among crashes, restarts and retries |
| migrate-callers-then-delete-legacy-apis<br>*from pstack* | a change introduces a new internal API while callers of the old one still exist |
| minimize-reader-load<br>*from pstack* | reviewing or shaping code that is hard to follow |
| model-the-domain<br>*from pstack* | you write stateful logic, or code branches a lot or repeats an assumption about a shape across files |
| never-block-on-the-human<br>*from pstack* | tempted to ask "should I do X?" about reversible work |
| outcome-oriented-execution<br>*from pstack* | a planned rewrite or migration has explicit phase boundaries |
| prove-it-works<br>*from pstack* | before declaring a task done, or when judging a claim that something works |
| redesign-from-first-principles<br>*from pstack* | you add a new requirement to an existing design |
| separate-before-serializing-shared-state<br>*from pstack* | concurrent actors might write to the same file, branch, key or state object |
| sequence-verifiable-units<br>*from pstack* | multi-step work (a sweep, a migration, a run of similar edits) or the order of commits in a change |
| subtract-before-you-add<br>*from pstack* | ordering an addition, a refactor or a rewrite |
| test-behavior-not-implementation<br>*from pstack* | writing, changing or keeping a test |
| type-system-discipline<br>*from pstack* | you design types, review a function signature or write code in a statically typed language |

Under each name, a note says where its text comes from:

- "from pstack" is sage's text of a pstack principle, in sage's writing standard. Its status against pstack's latest text is in the [baseline](#baseline-against-pstack) below. Its `source` line names the pstack version and commit that its text was checked against.
- "sage's own" has no pstack source.

</details>

<!-- The end of the principles table. -->

Agents seldom load a skill by themselves, so each **role** brings its principles:

- A Claude Code agent loads them from the `skills:` list of its agent file.
- A Codex role agent gets them in its role text, and a lead gets the path of each one to read. The Codex chief gets the paths of its principles from the mode hook.
- One map in core, `ROLE_PRINCIPLES` in `packages/sage-core/roles.mjs`, says which role gets which principle. `npm run check` checks the agent files against it.

Outside sage mode, no hook gives a principle: name one in your request, for example "apply prove it works".

## Baseline against pstack

sage's principles come from pstack, by Lauren Tan (MIT). sage keeps its own text of each one, and nothing syncs it with pstack. Instead, a review compares each text with pstack's latest text by hand, and this table records the result.

- **Checked against:** pstack 0.15.36, at commit `0bb6f379f2c3cd07c92a4e0bfa815ffa773bd4f3` of [github.com/cursor/plugins](https://github.com/cursor/plugins), on 2026-11-09 (task T935). pstack's principles are the same there as at commit `6b03002`, which T924 used.
- **Where the commit is:** each principle's `source` line names the version and the commit.
- **To repeat the check:** compare each text with pstack's text, its references and the pstack skills that took over cut content. Then update the texts, this table and each `source` line. [CONTRIBUTING.md](../../CONTRIBUTING.md#credit) shows how a principle credits pstack.

The status says how sage's text compares with pstack's text:

| Status | Meaning |
| --- | --- |
| matches pstack | The same rules as pstack, in sage's format and writing standard. It is shorter, and it has no links to pstack skills that sage does not have. |
| adapted from pstack | pstack's rules, and sage adds or changes a rule on purpose, for example a Stop rule. |
| sage keeps fuller text | pstack cut its text to little more than its description. sage keeps the rules that pstack dropped, and carries the rules that moved to pstack's description or to another pstack skill. |
| sage only | pstack has no such principle. |

| Principle | pstack version checked | Status | What differs |
| --- | --- | --- | --- |
| attack-the-premise | 0.15.36 (`0bb6f37`) | adapted from pstack | Says "check or review" for pstack's "gate", because a gate in sage is a question for the owner. sage adds: report the premise that you questioned. |
| boundary-discipline | 0.15.36 (`0bb6f37`) | adapted from pstack | sage adds files as a boundary, and a line for reviewers: report input that reaches logic unvalidated. |
| build-the-lever | 0.15.36 (`0bb6f37`) | matches pstack | Shorter. |
| contextualize-and-write-for-the-reader | none | sage only | This kit's own principle. |
| encode-lessons-in-structure | 0.15.36 (`0bb6f37`) | sage keeps fuller text | pstack cut its text to two lines; its description still names the mechanisms (a lint, a metadata flag, a runtime check or a script), and so does sage's first line. The order of mechanisms moved to pstack's `correct` skill, and sage takes that order (architecture with the old ways deleted, a type, a check whose error names the fix, a test, a written rule last), its proof that each new check fails on a real past mistake, and its one rule table that pairs each standing rule with its mechanism. pstack dropped the feedback loop of 0.15.9 (parts went to its `correct` and `reflect` skills), and sage keeps all of it (capture, route, apply now or add a concrete task, and the three anti-patterns), with sage's own layers: a note, the highest level of that order that works, and the vision or a flow, for pstack's brain note, skill or lint rule, and principle. |
| exhaust-the-design-space | 0.15.36 (`0bb6f37`) | sage keeps fuller text | pstack cut its text to one line; the rule stays in its description. sage keeps when it applies and when it does not, and adds a Stop rule. |
| experience-first | 0.15.36 (`0bb6f37`) | adapted from pstack | sage adds a Stop rule: cut a feature that the user's side cannot justify. |
| explain-the-number | 0.15.36 (`0bb6f37`) | matches pstack | Shorter. No link to pstack's `benchmark-checklist` skill. |
| fix-root-causes | 0.15.36 (`0bb6f37`) | adapted from pstack | sage adds a Stop rule: stop when the reproduction no longer fails for the reason you found. |
| foundational-thinking | 0.15.36 (`0bb6f37`) | matches pstack | Shorter. The scaffold examples name checks in place of CI and linting. |
| guard-the-context-window | 0.15.36 (`0bb6f37`) | sage keeps fuller text | pstack cut its text to the reason and one rule. The rule to send large payloads to subagents moved to pstack's description, and sage keeps it in the principle. sage also keeps a rule that pstack dropped: keep content that you use often inline. |
| laziness-protocol | 0.15.36 (`0bb6f37`) | sage keeps fuller text | pstack cut its text to two rules. Two rules moved, and sage keeps them in the principle: prefer deletion (to pstack's description) and a flat call hierarchy (to pstack's `architect` skill). sage also keeps the rules that pstack dropped: question the threading, remove small leaks, and the test. |
| make-operations-idempotent | 0.15.36 (`0bb6f37`) | matches pstack | Shorter. |
| migrate-callers-then-delete-legacy-apis | 0.15.36 (`0bb6f37`) | adapted from pstack | pstack cut its text to the line about tests and three conditions: no external users, a project that can take coordinated breaking changes, and a simplification or refactor. The rule moved to pstack's description, its `architect` skill (two ways to do one task) and its refactoring playbook; sage keeps it in the principle, with the reason and the three conditions. sage adds a temporary adapter as a short-lived exception, where pstack allows no compatibility layer, the rule for repairs and a Stop rule. |
| minimize-reader-load | 0.15.36 (`0bb6f37`) | adapted from pstack | Takes pstack's new wording (T935). Shorter. sage adds a line for reviewers: report it in a finding. |
| model-the-domain | 0.15.36 (`0bb6f37`) | matches pstack | Shorter. |
| never-block-on-the-human | 0.15.36 (`0bb6f37`) | adapted from pstack | Takes pstack's new wording (T935). sage widens pstack's "delete production data" to deleting any data, and adds spending money as an irreversible action, as sage's working preferences do. sage adds a last paragraph on how the user steers. |
| outcome-oriented-execution | 0.15.36 (`0bb6f37`) | matches pstack | Shorter. |
| prove-it-works | 0.15.36 (`0bb6f37`) | adapted from pstack | sage adds a Stop rule: say what you ran, what you saw and what you did not verify. No link to pstack's `show-me-your-work` skill. |
| redesign-from-first-principles | 0.15.36 (`0bb6f37`) | matches pstack | Same rules. |
| separate-before-serializing-shared-state | 0.15.36 (`0bb6f37`) | matches pstack | Same rules. |
| sequence-verifiable-units | 0.15.36 (`0bb6f37`) | matches pstack | Shorter. Says "a script" for pstack's "a lever". |
| subtract-before-you-add | 0.15.36 (`0bb6f37`) | adapted from pstack | Takes pstack's new wording (T935). sage adds a Stop rule: stop when the next removal would change behaviour that the specification asks for. |
| test-behavior-not-implementation | 0.15.36 (`0bb6f37`) | matches pstack | Shorter. |
| type-system-discipline | 0.15.36 (`0bb6f37`) | adapted from pstack | pstack cut its text to three rules and moved five rules to its `typescript-best-practices` skill: discriminated unions (no bags of optional fields), constructive modeling, the simplest total type (strengthen a type only where partiality appears), no casts and exhaustiveness. Two of them are also in pstack's description: make illegal states unrepresentable, and exhaust variants. sage carries all five in the principle, in words for any typed language, and has no link to that skill. |
