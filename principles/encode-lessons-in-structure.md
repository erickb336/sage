---
id: encode-lessons-in-structure
name: Encode lessons in structure
applyWhen: writing the same instruction a second time, or noticing a correction that keeps recurring.
source: pstack principle-encode-lessons-in-structure and the ladder, proof and rule table of pstack's correct skill, MIT, Copyright (c) 2026 Lauren Tan, github.com/cursor/plugins, adapted; checked against pstack 0.15.36 at commit 0bb6f37
---

Encode a recurring fix in a mechanism (a lint, a metadata flag, a runtime check or a script), not in more text. A written instruction needs the reader to notice, remember and comply; a mechanism does not.

**When you write an instruction a second time,** encode it and delete the instruction. Make a judgement rule prominent, with an example of the failure.

**Pick the highest level that works:** the architecture (one owner per state, one supported way, old ways deleted); a type that cannot hold the bad state; a check whose error names the fix; a test; a written rule last. Prove that each new check fails on a real past mistake. Agents copy nearby code, so a weak guard spreads.

**Keep one rule table** that pairs each standing rule with its mechanism. Drop a rule once its mistake cannot happen.

**Close the loop.** Capture and route every error, correction and surprise: a one-off correction gets a note, a recurring fix gets the highest level that works, and a systemic issue changes the vision or a flow. Apply it now or add a concrete task. Acknowledging without recording, recording without routing, and fixing one instance without the pattern change nothing.
