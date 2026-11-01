// T573: the proposed new set of sage principles. This is a proposal for the owner, not a source of the plugin.
// build-page.mjs reads this file and the current principles, checks each new text, and writes index.html.
// A row has: the old id, its group, the action, a one-line reason, a fit note (the check against how sage works today).
// A "rewrite" or "keep" row has the new principle (id, name, applyWhen, text).
// A "merge" row names its target. A "split" row lists where each part goes.

export const GROUPS = [
  "Decide what to build",
  "Keep the code simple",
  "Make it reliable",
  "Prove the result",
  "Repair and learn",
  "Work with the owner and with context",
];

export const QUESTIONS = [
  {
    id: "Q1",
    text: "Do the new names also replace the skill names and ids?",
    why: "The ids are in about 15 source files: the agent files, the hook moments, the Codex guidance and two test files. One later task can change all of them.",
    options: [
      { key: "A", label: "Rename everything", detail: "The skill becomes sage:principle-keep-it-small. Version 1 is the cheapest moment to do it.", recommended: true },
      { key: "B", label: "Keep the old ids", detail: "Only the display names change. Less work, but pstack's names stay in sage." },
    ],
  },
  {
    id: "Q2",
    text: "After the rewrite, does sage keep the file with pstack's MIT licence?",
    why: "No pstack text stays, so MIT may not require the file. The ideas still come from pstack, and each principle keeps its credit line.",
    options: [
      { key: "A", label: "Keep the licence file and the credit lines", detail: "It costs nothing, and it needs no legal judgement.", recommended: true },
      { key: "B", label: "Keep the credit lines only", detail: "One file fewer." },
    ],
  },
  {
    id: "Q3",
    text: "Four new principles have no hook moment and no role. Do they get a role?",
    why: "Script the work, Safe to run twice, One writer for each thing and Guard the context stay on the skill listing only. An agent must choose to load them. Each role that loads one pays up to about 300 tokens for each spawn (basis: 200 words).",
    options: [
      { key: "A", label: "Add them to roles", detail: "Script the work to the implementer. Safe to run twice and One writer to the PE. Guard the context to the chief and the lead. No new hook moment.", recommended: true },
      { key: "B", label: "Leave them on the skill listing", detail: "No extra context cost, but agents will often miss them." },
    ],
  },
];

export const ROWS = [
  // ---------------------------------------------------------------- Decide what to build
  {
    old: "experience-first", group: 0, action: "rewrite",
    reason: "The rule stays. The new text drops the pointer to Foundational thinking, which this proposal splits.",
    fit: "Fits the owner's rule to prototype the screens first. The state list matches what the designer role already must show.",
    next: {
      id: "experience-first", name: "Experience first",
      applyWhen: "a choice sets the product, the screens or the scope against what is easy to build.",
      text: `Choose what is best for the person who uses the work, also when another choice is easier to build.

**Who the user is.** For a screen, the user is the person at the screen. For an internal API or a library, the user is the next developer or agent that calls it. The person who maintains the code is a user too.

**Do.**
- Make each feature, control and option earn its place.
- Build fewer features, and finish them well.
- Try a design as a quick prototype with sample data before you build it.
- Finish the details: the empty, loading, failure and success states, the spacing and the feedback.
- Describe each effect from the user's side.

**Not when.** The choice has no effect on any user.

**Stop** when you cannot say what a feature gives the user. Remove it. Do not polish it.`,
    },
  },
  {
    old: "exhaust-the-design-space", group: 0, action: "rewrite",
    reason: "The old name says \"exhaust\", but the rule asks for two or three options. The new name says what to do.",
    fit: "Fits the arena and the designer role. Adds one line: a product choice goes to the owner as a comparison.",
    next: {
      id: "compare-designs", name: "Compare two or three designs",
      applyWhen: "a new interaction, an architecture choice or a product choice has no clear answer.",
      text: `When the answer is not clear, make two or three designs and compare them before you choose. A design costs less to change before the build than after it.

**Do.**
- Give each option a different main idea. A small variant of one idea is not a second option.
- Put the options side by side, with what each one gives up.
- Recommend one.
- For a product choice, give the owner the comparison.
- Write down the rejected options and the reason in a few lines, so that a reviewer sees the choice.

**Not when.**
- The work is mechanical, and the project has a known way to do it.
- A repair or a refactor has a clear end state.
- The limits leave one possible design.

**Stop** when you can compare the options and one wins.`,
    },
  },
  {
    old: "foundational-thinking", group: 0, action: "split",
    reason: "It holds four separate rules under one vague name. Each part has a better home, so the mixed principle goes.",
    fit: "The design hook moment and the PE role load it today. Model the domain takes both.",
    parts: [
      { into: "model-the-domain", what: "Get the data right before the logic, and the line that three similar statements beat an early abstraction." },
      { into: "one-writer", what: "Ask what happens when another actor changes shared state." },
      { into: "one-checked-change", what: "Do the setup that helps each later change first, and keep each change to one purpose." },
      { into: "keep-it-small", what: "Remove first, then lay the base." },
    ],
  },
  {
    old: "model-the-domain", group: 0, action: "rewrite",
    reason: "It takes the data part of Foundational thinking and the core of Type system discipline, so one principle covers how to shape data.",
    fit: "No hook and no role load it today. It takes the design moment and the PE role. The type rules are one short section, because sage works in any language.",
    next: {
      id: "model-the-domain", name: "Model the domain",
      applyWhen: "before you write logic, when you choose the core data, or when code repeats a branch or a shape.",
      text: `Get the data right before you write the logic. Put the rules of the domain in one structure, not in conditions across many files. Good data makes the code short.

**Do.**
- List how the code reads and changes the data. Choose the structure that fits the main paths.
- Make a wrong value impossible to build. Use a state machine, a tagged variant or a lookup table, not two flags that must agree.
- Give each fact one source, and derive the rest.
- Organize a module around one body of knowledge, not around the order of execution.

**In a typed language.**
- Give values with different meanings different types, such as two kinds of id.
- Do not use a cast to silence the compiler. Prove the fact, or check it.
- Make the compiler fail when a new variant has no case.
- Derive a type from its schema.

**Not when.** The shape is clear, local and not likely to grow. Three similar lines cost less than an early abstraction.

**Stop** when the next feature adds a row, not a branch.`,
    },
  },
  {
    old: "type-system-discipline", group: 0, action: "merge", target: "model-the-domain",
    reason: "It repeats Model the domain and Check at the boundary. At 727 words it is far over the limit of 200.",
    fit: "On the skill listing only. It names a skill, typescript-best-practices, that sage does not ship.",
    moves: ["Wrong values that cannot be built, branded values, no false casts, exhaustive matches and derived types go to Model the domain.", "Parse outside data at the entry point goes to Check at the boundary."],
    lost: "The sections about total functions, and about types as constructions, leave sage.",
  },
  {
    old: "migrate-callers-then-delete-legacy-apis", group: 0, action: "rewrite",
    reason: "Three principles say one thing: go to the end state and leave no extra path behind. One text replaces them.",
    fit: "It keeps the old limit: a repair stays in its task, and a public interface stays up. The refactor hook moment and two roles load it.",
    next: {
      id: "build-for-the-end-state", name: "Build for the end state",
      applyWhen: "a new requirement, a new internal API or a planned rewrite changes an existing design.",
      text: `Design the change as if the new requirement was there from the start. Then go to that end state. Do not add a side path that you must remove later.

**Do.**
- Read the code that the change touches. Ask what you would build from nothing.
- Replace an old internal API in the same task: list its callers, move them, and delete it.
- Move the tests to the new behaviour. Remove a test that guards only the old code.
- Carry the change into each type, document and example.
- Split a large change into tasks that each merge with passing checks. A break can exist inside one branch, never on main.

**Not when.** Outside callers or a public API depend on the old path. Keep that path working, and report it. A repair stays in its task, so report an old path outside the task.

**Stop** when no caller uses the old path and the old code is gone. An adapter needs a reason and a task that removes it.`,
    },
  },
  {
    old: "outcome-oriented-execution", group: 0, action: "merge", target: "build-for-the-end-state",
    reason: "Its useful part is to aim at the end state. Sage merges only passing commits, so planned breakage stays inside one branch.",
    fit: "Conflict today: it allows breakage between changes, and One checked change forbids it. The merged text ends the conflict, and it fits the clean cycles.",
    moves: ["Aim at the end state, and do not keep a compatibility path only to stay smooth."],
    lost: "The permission for planned breakage on main leaves sage.",
  },
  {
    old: "redesign-from-first-principles", group: 0, action: "merge", target: "build-for-the-end-state",
    reason: "Its one idea, to design as if the requirement was always there, is now the first line of Build for the end state.",
    fit: "On the skill listing only: no hook and no role load it today.",
    moves: ["Design as if the requirement was there from the start.", "Carry the change into each type, document and example."],
    lost: "Nothing.",
  },
  // ---------------------------------------------------------------- Keep the code simple
  {
    old: "laziness-protocol", group: 1, action: "rewrite",
    reason: "The name does not say the rule. It merges with Subtract before you add, and its rules about layers move to Keep code easy to read.",
    fit: "This is the most used principle: the refactor hook moment and four roles. The old text has a word that sage flags, \"pipelines\".",
    next: {
      id: "keep-it-small", name: "Keep it small",
      applyWhen: "you add, refactor or rewrite code, or you judge the size of a change.",
      text: `Get the result with the least code. Remove first, then build. Each removal makes the next design easier to see.

**Do.**
- Look for what you can delete before you add.
- Change as few lines as the problem allows.
- Build for the use that you saw, not for a case that you imagine. Add no extra validator, option or guard.
- Make each decision in one place, and pass on the result.
- Before you carry a new value through many layers, look for a direct path.
- Remove a small pass-through or an empty reference when you see it.
- Treat briefs, skills and instructions the same way: cut each line that adds nothing.

**Not when.** A removal changes a behaviour that the task needs. Report it, and keep the behaviour.

**Stop** when each remaining line does work that the task needs.`,
    },
  },
  {
    old: "subtract-before-you-add", group: 1, action: "merge", target: "keep-it-small",
    reason: "\"Prefer deletion\" and \"remove first\" are the same rule. Two texts at the refactor moment cost context and add nothing.",
    fit: "The refactor hook moment and the implementer role load it. Keep it small takes both, so the moment gives one text fewer.",
    moves: ["Remove first, then build.", "Build for the use that you saw.", "Cut instructions that add nothing.", "Delete an empty reference."],
    lost: "Nothing.",
  },
  {
    old: "minimize-reader-load", group: 1, action: "rewrite",
    reason: "This ends the overlap with the Laziness protocol: this row owns layers and state, and Keep it small owns size.",
    fit: "The old text asks for a finding, but standing order 4 says that reviewers report no style. The new text says a low finding, as order 34 does.",
    next: {
      id: "easy-to-read", name: "Keep code easy to read",
      applyWhen: "you shape or review code that is hard to follow.",
      text: `Code is easy to maintain when a reader needs little effort to understand it. Measure two things: the layers between a question and its answer, and the hidden or changing state that the reader must remember. Either one alone can make code hard.

**Do.**
- Remove a layer that costs more than it gives: a wrapper with one caller, an adapter with one implementation.
- Try to answer a question in three files or fewer.
- Make each layer add a new idea. A layer that repeats the one under it adds only length.
- Make state small: a pure function before mutation, a local before a field, a field before a module variable.
- Derive a value. Do not keep two copies that must agree.
- State a rule about the data once, where the data enters.

**Not when.** A rich interface hides real work. That layer earns its place.

**Stop** when a new reader finds where a value comes from, and what can change it, in thirty seconds. If not, report a low finding.`,
    },
  },
  // ---------------------------------------------------------------- Make it reliable
  {
    old: "boundary-discipline", group: 2, action: "rewrite",
    reason: "\"Discipline\" says nothing. The new name says the action. It takes the rule to parse outside data from Type system discipline.",
    fit: "Fits the input risk flag. The security reviewer and PE roles load it.",
    next: {
      id: "check-at-the-boundary", name: "Check at the boundary",
      applyWhen: "you write or review validation, error handling or an adapter to a framework.",
      text: `Check data where it enters the system. Inside, trust it. Keep the logic in pure functions, and keep the outer shell thin.

**Do.**
- Treat arguments, configuration, files, network input and API replies as unknown. Parse them into your own types at the entry point, and return clear errors.
- Inside, pass typed data and let errors travel up. Do not check the same fact again.
- At an interface, show domain ideas. Do not show the types of your transport, storage or framework.
- Put general mechanism inside, and special policy at the edge.

**Two questions.**
- Does this data cross a boundary now? If not, the check is extra.
- Can the shell call this logic as a pure function? If yes, move it.

**Not when.** A test or a local script reads data that it wrote itself.

**Stop** when each entry point has one parser and no inner code repeats its checks. A reviewer reports each input that gets to the logic unchecked.`,
    },
  },
  {
    old: "make-operations-idempotent", group: 2, action: "rewrite",
    reason: "The new name uses plain words. The advice to find stale locks by process id goes, because agents must not read the process list.",
    fit: "Standing order 14 and the hook refuse process lists. Sage's own slots use a lease. On the skill listing only: see question Q3.",
    next: {
      id: "safe-to-run-twice", name: "Safe to run twice",
      applyWhen: "you design a command, a lifecycle action or a loop that can crash, restart or retry.",
      text: `Make each operation reach the same correct end state, however many times it runs and wherever the last run stopped.

**Ask.**
1. What happens when this runs two times?
2. What happens when the last run stopped at any point?
3. Do all those paths reach the same end state?

If the answer depends on what the last run left, add an action that repairs the state first.

**Do.**
- At the start, read what exists, remove what is stale, and use what is still live.
- Compare by content, not by age or order.
- Write a file whole: write a temporary file, then rename it.
- Let failed work start again from clean input.
- Give a lock a lease, so that it ends when its owner stops.

**Not when.** A command only reads.

**Stop** when a test stops the operation halfway, runs it again and gets the same end state.`,
    },
  },
  {
    old: "separate-before-serializing-shared-state", group: 2, action: "rewrite",
    reason: "The old name is long and abstract. The new name is the rule. It takes the shared-state part of Foundational thinking.",
    fit: "This is sage's own git rule: one writer for each branch. On the skill listing only: see question Q3.",
    next: {
      id: "one-writer", name: "One writer for each thing",
      applyWhen: "two or more agents or programs can write the same file, branch, key or record.",
      text: `When two actors can change the same thing, first remove the sharing. Add a lock only when one shared thing must exist. A written rule does not prevent a race.

**Do.**
- List what each actor writes: files, branches, keys and records.
- Ask what breaks when a second actor writes at that moment. If anything breaks, separate them.
- Give each actor its own file, branch or key. Join their facts only when you read them.
- Count two actors that write different fields of one file as sharing that file.
- When one shared target is a real need, enforce it in structure: a single writer, a lock, an atomic compare-and-swap or tasks in a fixed order.

**Not when.** Only one actor writes.

**Stop** when each target has one writer, or a mechanism that holds the order.`,
    },
  },
  // ---------------------------------------------------------------- Prove the result
  {
    old: "prove-it-works", group: 3, action: "rewrite",
    reason: "The name stays. The process check goes. A short section takes the number check from Explain the number.",
    fit: "The old line about a live process conflicts with the hook that refuses process lists. The stop hook gives this text, so the name and id stay.",
    next: {
      id: "prove-it-works", name: "Prove it works",
      applyWhen: "before you say that a task is done, or when you judge a claim that something works.",
      text: `Look at the real result. A passing build, a log line or an agent's report is not proof.

**Do.**
- Use the feature, read the real value, and look at the change.
- When a check fails, first doubt how you looked. Then doubt the system.
- Prefer a command that repeats the comparison to one look. Keep it, so that a reviewer can run it again.
- Give each claim its evidence in the same text: the command and what it printed, or a screenshot.

**For a number.** Before you trust a measured number, name what limits it: why is it not double? Rule out errors, skipped or cached work, unequal settings and noise. Report the number with its run count, its spread and its limit.

**Not when.** You cannot run a check. Then say so.

**Stop** your claim where the evidence ends. List the commands that you ran, their results, and each thing that you left unchecked.`,
    },
  },
  {
    old: "explain-the-number", group: 3, action: "merge", target: "prove-it-works",
    reason: "It asks the Prove it works question about numbers. A short section keeps what agents use: the limit, the other causes, the run count and the spread.",
    fit: "On the skill listing only. It names a skill, benchmark-checklist, that sage does not ship. It fits the owner's rule to give costs with their basis and a range.",
    moves: ["Why is it not double?", "Rule out errors, skipped or cached work, unequal settings and noise.", "Report the number with its run count, its spread and its limit."],
    lost: "The detail on profiles and system counters, and the eval questions, leave sage.",
  },
  {
    old: "test-behavior-not-implementation", group: 3, action: "rewrite",
    reason: "The name stays. The old text uses JavaScript words, such as undefined and toBeDefined. The new text works in any language.",
    fit: "Fits the owner's rule that sage has no path for each language. The test-edit hook moment and three roles load it.",
    next: {
      id: "test-behaviour", name: "Test behaviour, not implementation",
      applyWhen: "you write, change or keep a test.",
      text: `A good test calls the code like a real user, and compares the visible result with a fixed value. A test of internal calls, or of a constant copied from the code, proves nothing.

**The question.** Would this test still pass if each function that it imports returned nothing? If yes, it cannot catch a fault. Make the assertion stronger, or remove the test.

**Weak tests.**
- The assertion says only that a value exists, or that nothing failed.
- The test looks only at a mock or at an empty result.
- The test takes its expected value from the code that it tests.
- The test repeats a default or a text from the code.
- The fixture checks itself.

**Repair.** Give one real input, and check the exact result or effect. For an empty result, also check a full result on another input. To test a constant, use the code that reads it. To test a mock, check the data that it got.

**Not when.** A test shows that two tables agree on a key, or it is a compile-time type test.

**Stop** when the test fails if the behaviour breaks.`,
    },
  },
  {
    old: "sequence-verifiable-units", group: 3, action: "rewrite",
    reason: "\"Verifiable units\" is abstract. The new name is the rule. It takes \"setup first\" from Foundational thinking.",
    fit: "The commit hook moment gives it. The new text asks for the smallest check, which fits order 31: one full test run for each head.",
    next: {
      id: "one-checked-change", name: "One checked change at a time",
      applyWhen: "the work is a migration or many similar edits, or you choose the order of commits.",
      text: `Split the work into small changes, and check each one before you start the next. A break that you see at once is easy to trace. A break under ten more changes is not.

**Do.**
- Start from a clean base that passes.
- First do the setup that helps each later change: shared types, build and test tools, a check.
- Give each change one purpose and one check. Run the smallest check that covers it.
- Run the check also when a script made the edits.
- Order the commits as an argument: the failing test, then the repair; a removal, then the new shape; the setup, then the feature.

**Not when.** The work is one small edit.

**Stop** at the first failed check. Repair it before you go on.`,
    },
  },
  {
    old: "build-the-lever", group: 3, action: "rewrite",
    reason: "The image of a lever needs an explanation. The new text adds the owner's rule: look for a mature open-source tool first.",
    fit: "On the skill listing only: see question Q3. Distinct from Seal the lesson: this one serves the work in front of you.",
    next: {
      id: "script-the-work", name: "Script the work",
      applyWhen: "the work is more than a few obvious edits: a sweep, a migration, an analysis or a check.",
      text: `When the work is not trivial, use a tool that does it or proves it. Do not do it by hand. A script gives the same result each time, and a reviewer can run it again. Work by hand can only be checked by doing it again.

**Do.**
- First look for a mature, maintained, open-source tool. Pin its version.
- Work one case by hand, and learn the recipe from it. Then write the tool, and compare its result with your case.
- Make the tool safe to run again.
- Let the tool do the whole batch. Never give agents work that fits in a script.
- When agents must share the work, give them one recipe with its limits and its check.
- Commit the tool when the work lasts longer than the session.

**Not when.** A few obvious edits need no tool.

**Stop** at the smallest script that does the work. Never build a framework for it.`,
    },
  },
  // ---------------------------------------------------------------- Repair and learn
  {
    old: "fix-root-causes", group: 4, action: "rewrite",
    reason: "The name stays. The old rule to fix every instance is now limited to the task, as the repair rules are.",
    fit: "The old text can push a repair out of its task, and it has a flagged word, \"defect\". The check-failed hook moment and the implementer load it.",
    next: {
      id: "fix-root-causes", name: "Fix root causes",
      applyWhen: "you debug a failure or repair a finding.",
      text: `Find why a problem happens, and repair it at that place. A repair of the symptom leaves the fault in the system and makes the next problem harder to find.

**Do.**
- Make the failure happen again first.
- Keep asking "why" until you find the cause.
- Measure when you are not sure: add a log, or read the real error.
- Look for the same fault in other places. Repair it inside your task, and report it outside your task.
- After a restart, first suspect old state: configuration, caches, lock files and saved data. When a reset repairs the failure, validate that state at load.
- Do not add a guard that only hides a crash.

**Not when.** Main is broken and a short workaround makes it safe. Then open a task for the real repair.

**Stop** when the failure no longer happens for the cause that you found, not when it only stops showing.`,
    },
  },
  {
    old: "attack-the-premise", group: 4, action: "rewrite",
    reason: "The new name is plainer. It stays apart from Fix root causes, because the hook gives it at its own moment, after failed repairs.",
    fit: "The old text says \"gate\" for a check, but in sage a gate is a question for the owner. The failed-fixes hook moment gives it. No role loads it.",
    next: {
      id: "question-the-assumption", name: "Question the shared assumption",
      applyWhen: "two or more repairs that rest on one assumption failed the same check or review.",
      text: `When two repairs that rest on one assumption fail the same check, stop repairing. The assumption is the likely fault, and each failure is evidence about it.

**Do.**
- Write the assumption in one sentence.
- List each failed repair: what it assumed, and what still failed.
- Find what is in every failure: the same input, path, part or order.
- Find what puts it there. Then apply Fix root causes.
- Take the cause away. Retries, fallbacks, special cases and scheduled cleanups all leave it in place.

**Not when.** Nothing is common to the failures. Then the assumption is not the cause. Look in other places. The list stays as evidence.

**Stop** the next repair until the sentence and the list exist. Say in your report which assumption you tested and what you found.`,
    },
  },
  {
    old: "encode-lessons-in-structure", group: 4, action: "rewrite",
    reason: "Sage already calls this \"seal the lesson\", so the principle takes that name. It adds the owner's limit: keep the rules few.",
    fit: "The old text has no limit. Orders 48 and 49 say that a gap which needs an agent to act against its brief is a documented limit, not a new guard.",
    next: {
      id: "seal-the-lesson", name: "Seal the lesson",
      applyWhen: "a correction comes back a second time, or you write the same instruction again.",
      text: `Give a mistake that comes back twice a lasting fix. A written rule depends on an agent that notices and remembers. A check works without either.

**Do.** Choose the strongest form that fits, in this order:
1. a state that the code cannot represent;
2. a test or a check that stops the build;
3. a shared helper;
4. a hook or a runtime check;
5. a principle or a standing order, with an example of the failure, only when code cannot hold it.

Delete the old instruction when the check holds it. Agents copy nearby code, so a weak guard spreads.

**Not when.**
- The mistake came once. Write a note.
- The gap needs an agent to act against its brief on purpose. Record it as a known limit.

**Stop** when the lesson has one home. Keep the rules few: remove a rule that no longer catches anything.`,
    },
  },
  // ---------------------------------------------------------------- Work with the owner and with context
  {
    old: "never-block-on-the-human", group: 5, action: "rewrite",
    reason: "The old name says \"never\", but gates and actions that cannot be undone do wait. The new text uses owner, gate and default.",
    fit: "The old text names \"the vision and the specs\", which sage does not have now, and \"pipeline\", a flagged word. The lead and chief roles load it.",
    next: {
      id: "ask-only-what-you-must", name: "Ask only what you must",
      applyWhen: "you want to ask \"should I do X?\" about work that you can undo.",
      text: `The owner reviews results, not each action. For work that you can undo: decide, do it, and show what you did and why. A wrong choice that you can undo costs less than a wait.

**Do.**
- Go on with work that you can undo: code, notes and new tasks.
- Record a problem when you see it, and repair it in the next round.
- Give each question in the cheapest form: a choice, with a recommendation and a default.

**Not when.**
- The action cannot be undone: deleted data, a force-push, a message to other people, money spent. Ask first.
- The choice changes what the owner asked for, or the product direction. Open a gate.

**Stop** only the work that a gate holds. All other work goes on.`,
    },
  },
  {
    old: "contextualize-and-write-for-the-reader", group: 5, action: "keep",
    reason: "This is sage's own text, and it already fits. Only the name gets shorter, and \"handoff\", a flagged word, leaves the apply-when line.",
    fit: "It overlaps the preference to write for a reader who arrives cold, which loads in each session. This is the longer form, given at the document moment.",
    next: {
      id: "write-for-the-reader", name: "Write for the reader", sameText: true,
      applyWhen: "you write anything that someone else will read later: a design, findings, a report, a verification, a brief or a reply.",
    },
  },
  {
    old: "guard-the-context-window", group: 5, action: "rewrite",
    reason: "The name gets shorter. The new text uses sage's forms: helper agents, and reports that name files.",
    fit: "Fits the report limit of about 2,000 tokens. The old words \"phases\" and \"invocation\" leave. On the skill listing only: see question Q3.",
    next: {
      id: "guard-the-context", name: "Guard the context",
      applyWhen: "a run reads large files, gets long results, or plans work for many agents.",
      text: `Each agent has limited context, and a full context makes it reason worse. Spend context only on what the work needs.

**Do.**
- Give bulk reads, screenshots and long logs to a helper agent. Take back the conclusion, not the raw data.
- Read only the part of a file that you need, and do not read it twice.
- Put text that each run needs inside the skill. A separate file costs a read each time.
- Put long material in a file, and name the file in your report.
- Size each task and brief so that one run can finish it.

**Not when.** A small lookup costs less to do yourself than to brief.

**Stop** reading when more text will not change the next decision.`,
    },
  },
];
