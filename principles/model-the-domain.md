---
id: model-the-domain
name: Model the domain
applyWhen: you write stateful logic, or code branches a lot or repeats an assumption about a shape across files.
source: pstack principle-model-the-domain, MIT, Copyright (c) 2026 Lauren Tan, github.com/cursor/plugins at 6b03002, adapted
upstream: 52c0d85e0c3827c4
---

Encode the domain in a data structure, not in scattered conditionals. A matching structure makes invalid states impossible and deletes branches. Choose it as you write; later it looks like a refactor and gets deferred.

**Use:**
- a state machine, not scattered booleans, phases or lifecycle checks;
- a typed model, not loose parameters or repeated shape assumptions;
- a map, registry, lookup table or discriminated union, not branches across files;
- a reducer or command/event model, not ad hoc state changes;
- a module per body of domain knowledge, not per step (load, validate, transform, save): execution order is not ownership;
- a small module for repeated behaviour, ownership or invariants;
- a queue, cache, index, graph, tree or normalised collection that fits the access pattern;
- any structure that fits; if none does, encode what the code must never allow and how it reads data.

**Do not force an abstraction.** Keep boring code that is clear, local and unlikely to grow. Distrust indirection that removes no branches, duplicate rules, invalid states or lifecycle risk.

**Signs you skipped this:** one more if/else branch, a second boolean synced with the first, or phase-named modules that repeat domain rules.
