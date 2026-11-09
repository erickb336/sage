---
id: test-behavior-not-implementation
name: Test behaviour, not implementation
applyWhen: writing, changing or keeping a test.
source: pstack principle-test-behavior-not-implementation, MIT, Copyright (c) 2026 Lauren Tan, github.com/cursor/plugins at 6b03002, adapted
upstream: f7223698623b6a26
---

A test checks what the code's users observe: return values, errors, readable state, and outside effects such as a request sent or a row written. Internal helpers and call order are not behaviour.

**Two imagined edits:**
- **Break the behaviour:** return a wrong value, skip an effect or do it twice. If the test still passes, it proves nothing.
- **Change the internals** and keep every observable result. If the test then fails, it is pinned to the implementation.

Keep a test that catches the first edit and survives the second; rewrite or delete the rest.

**Usual causes:** an assertion looser than the contract, an expected value from the code under test, a restated constant or prompt string, a fixture asserting itself, an exact error message.

**The fix.** Drive the code through its users' interface with a concrete input. Derive the expected value from the requirement, and assert exactly what the contract promises. Pair an absence (no call, an empty list) with a case where the presence shows. A payload sent to an external service is behaviour; an internal helper call is not.

**Keep** tests of an invariant: a key in two tables, or a compile-time type check.
