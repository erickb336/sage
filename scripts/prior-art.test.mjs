// The prior-art rule (T1016): npm run check fails when one of the texts that must ask for the prior art loses its line,
// and names that text. The real texts pass.
import "./test-env.mjs"; // first: no variable of the developer's shell changes a result
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ROOT } from "./build.mjs";
import { PRIOR_ART_TEXTS, priorArtProblems } from "./prior-art.mjs";

const real = (path) => readFileSync(join(ROOT, path), "utf8");

test("the designer, PE, investigate and chief texts and the design and architecture playbooks ask for the prior art", () => {
  assert.deepEqual(priorArtProblems(), []);
});

test("a text whose prior-art line is gone is a problem that names it, and only it", () => {
  for (const lost of PRIOR_ART_TEXTS) {
    const read = (path) => path === lost ? real(path).split("\n").filter((line) => !/prior art/i.test(line)).join("\n") : real(path);
    const problems = priorArtProblems(read);
    assert.equal(problems.length, 1, `${lost}: ${problems.join("; ")}`);
    assert.ok(problems[0].startsWith(`${lost}: no "prior art" line`), problems[0]);
  }
});
