import "../../test-env.mjs"; // first: no variable of the developer's shell changes a result
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// The change entry of the Codex autopilot's inactive parts (T663, F-T663-8), for a reader who arrives cold: a short
// lead, then one item for each new part, each sentence at 80% of Simplified Technical English (25 words or fewer).
const ENTRY = readFileSync(fileURLToPath(new URL("../../../changes/T663.md", import.meta.url)), "utf8");

test("the change entry is a short lead and a list of the three new parts, and says what refuses each merge until T677", () => {
  const body = ENTRY.replace(/^---\n[\s\S]*?\n---\n/, "").trimEnd().split("\n");
  assert.equal(body.length, 4, "one entry line and three items");
  assert.match(body[0], /^- \*\*Codex autopilot, inactive parts\.\*\* /);
  assert.match(body[0], /The owner sees no change until T677/);
  // F-T663-15: what refuses, in sage's words. A gate is a question parked for the owner, so the entry does not use it.
  assert.match(body[0], /the Codex merge command still refuses every merge, and the sage hook still blocks every merge by an agent\./);
  assert.doesNotMatch(ENTRY, /\bgates?\b/i);
  const items = body.slice(1);
  for (const item of items) assert.match(item, /^ {2}- \*\*/, item);
  assert.deepEqual(items.map((item) => item.match(/^ {2}- \*\*(.+?)\*\*/)[1]), ["The owner record reader", "The start marks:", "The merge command"]);
  const sentences = body.flatMap((line) => line.replace(/\*\*|`/g, "").replace(/^\s*- /, "").split(/(?<=[.:])\s+(?=[A-Z])/));
  assert.ok(sentences.length >= 7, `${sentences.length} sentences`);
  for (const sentence of sentences) assert.ok(sentence.split(/\s+/).length <= 25, `${sentence.split(/\s+/).length} words: ${sentence}`);
});
