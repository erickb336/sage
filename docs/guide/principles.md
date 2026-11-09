# Principles

A principle is a short rule for one kind of moment, for example "test behaviour, not implementation" when you change a test. sage gives every Claude Code session its principles, also outside sage mode.

<!-- The principles table comes from principles/: edit them there, then run npm run build. -->

There are 25 principles: 24 come from pstack, by Lauren Tan (MIT), and 1 is sage's own. sage keeps its own text of each one. The baseline below compares each text with pstack's latest text.

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

- "pstack, adapted" is sage's text of a pstack principle: it is shorter, and it follows sage's writing standard. Its `source` line names the pstack version and commit that its text was checked against.
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
| sage keeps fuller text | pstack cut its text to little more than its description. sage keeps the rules that pstack dropped, and takes any rule that moved to another pstack skill. |
| sage only | pstack has no such principle. |

| Principle | pstack version checked | Status | What differs |
| --- | --- | --- | --- |
| attack-the-premise | 0.15.36 (`0bb6f37`) | adapted from pstack | Says "check or review" for pstack's "gate", because a gate in sage is a question for the owner. sage adds: report the premise that you questioned. |
| boundary-discipline | 0.15.36 (`0bb6f37`) | adapted from pstack | sage adds files as a boundary, and a line for reviewers: report input that reaches logic unvalidated. |
| build-the-lever | 0.15.36 (`0bb6f37`) | matches pstack | Shorter. |
| contextualize-and-write-for-the-reader | none | sage only | This kit's own principle. |
| encode-lessons-in-structure | 0.15.36 (`0bb6f37`) | sage keeps fuller text | pstack cut its text to two lines. The order of mechanisms moved to pstack's `correct` skill, and sage takes that order: architecture, a type, a lint or check whose error names the fix, a test, a written rule last. sage keeps the feedback loop, which pstack dropped. |
| exhaust-the-design-space | 0.15.36 (`0bb6f37`) | sage keeps fuller text | pstack cut its text to one line; the rule stays in its description. sage keeps when it applies and when it does not, and adds a Stop rule. |
| experience-first | 0.15.36 (`0bb6f37`) | adapted from pstack | sage adds a Stop rule: cut a feature that the user's side cannot justify. |
| explain-the-number | 0.15.36 (`0bb6f37`) | matches pstack | Shorter. No link to pstack's `benchmark-checklist` skill. |
| fix-root-causes | 0.15.36 (`0bb6f37`) | adapted from pstack | sage adds a Stop rule: stop when the reproduction no longer fails for the reason you found. |
| foundational-thinking | 0.15.36 (`0bb6f37`) | matches pstack | Shorter. The scaffold examples name checks in place of CI and linting. |
| guard-the-context-window | 0.15.36 (`0bb6f37`) | sage keeps fuller text | pstack cut its text to the reason and one rule. sage keeps two rules that pstack dropped: send large payloads to subagents, and keep content that you use often inline. |
| laziness-protocol | 0.15.36 (`0bb6f37`) | sage keeps fuller text | pstack cut its text to two rules. sage keeps the four rules and the test that pstack dropped: prefer deletion, a flat call hierarchy, question the threading, and remove small leaks. |
| make-operations-idempotent | 0.15.36 (`0bb6f37`) | matches pstack | Shorter. |
| migrate-callers-then-delete-legacy-apis | 0.15.36 (`0bb6f37`) | sage keeps fuller text | pstack cut its text to the line about tests and when the rule applies. sage keeps the rule and the reason, and adds where it applies in a task (external callers, repairs) and a Stop rule. |
| minimize-reader-load | 0.15.36 (`0bb6f37`) | matches pstack | Takes pstack's new wording (T935). Shorter. |
| model-the-domain | 0.15.36 (`0bb6f37`) | matches pstack | Shorter. |
| never-block-on-the-human | 0.15.36 (`0bb6f37`) | adapted from pstack | Takes pstack's new wording (T935). sage adds spending money as an irreversible action, and a last paragraph on how the user steers. |
| outcome-oriented-execution | 0.15.36 (`0bb6f37`) | matches pstack | Shorter. |
| prove-it-works | 0.15.36 (`0bb6f37`) | adapted from pstack | sage adds a Stop rule: say what you ran, what you saw and what you did not verify. No link to pstack's `show-me-your-work` skill. |
| redesign-from-first-principles | 0.15.36 (`0bb6f37`) | matches pstack | Same rules. |
| separate-before-serializing-shared-state | 0.15.36 (`0bb6f37`) | matches pstack | Same rules. |
| sequence-verifiable-units | 0.15.36 (`0bb6f37`) | matches pstack | Shorter. Says "a script" for pstack's "a lever". |
| subtract-before-you-add | 0.15.36 (`0bb6f37`) | adapted from pstack | Takes pstack's new wording (T935). sage adds a Stop rule: stop when the next removal would change behaviour that the specification asks for. |
| test-behavior-not-implementation | 0.15.36 (`0bb6f37`) | matches pstack | Shorter. |
| type-system-discipline | 0.15.36 (`0bb6f37`) | matches pstack | Shorter. No link to pstack's `typescript-best-practices` skill. |
