---
id: explain-the-number
name: Explain the number
applyWhen: you plan a measurement, or you trust, report or act on a number that you measured: a speedup, a regression, a throughput, a latency or an eval result.
source: pstack principle-explain-the-number, MIT, Copyright (c) 2026 Lauren Tan, github.com/cursor/plugins, adapted; checked against pstack 0.15.36 at commit 0bb6f37
---

Find what limits a measured number, and rule out that it measured other work.

- **Decide before you run.** Name the result that would change a decision, and the noise floor. Stop when the run-to-run spread exceeds the effect.
- **Ask "why not double?"** Name the resource or code path that limits the result (a core, a lock, the disk, the network or the load generator) from a profile or system counters of a run, and map it to the source. A guess is not a limiter. Without that answer, you do not know what you measured.
- **Rule out, with evidence, what else it could measure:** errors, skipped or cached work, code that never ran, an untuned side, noise, or a part too small to matter end to end.
- **Keep the run count, spread and limiter with the number.**
- **For an eval result,** ask: did every run do the task? Does the gap hold across trials and models? Does the scenario matter?

**You skipped this** if no deciding result came before the run, if a number has no run count, spread or limiter, or if the time saved is larger than the time the changed part took.
