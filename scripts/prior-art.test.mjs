import "./test-env.mjs";
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

test("F-T1016-6: a text that loses its asking line is a problem, also when the words \"prior art\" stay elsewhere in it", () => {
  for (const lost of PRIOR_ART_TEXTS) {
    const read = (path) => path === lost
      ? `${real(path).split("\n").filter((line) => !/2 or 3 existing/.test(line)).join("\n")}\nThe report names the prior art.\n`
      : real(path);
    assert.match(read(lost), /\bprior art\b/i, `${lost}: the sample keeps the words`);
    const problems = priorArtProblems(read);
    assert.equal(problems.length, 1, `${lost}: ${problems.join("; ")}`);
    assert.ok(problems[0].startsWith(`${lost}: no "prior art" line`), problems[0]);
  }
});
