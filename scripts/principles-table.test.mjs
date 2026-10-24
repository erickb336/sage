// The principles page's table (scripts/principles-table.mjs): its rows and attribution words, then `npm run build`
// and `npm run check` as people run them, in a copy of this repository.
import "./test-env.mjs"; // first: no variable of the developer's shell changes a result
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { ROOT } from "./build.mjs";
import { principleRows } from "./principles-table.mjs";

test("each principle gets its attribution: pstack, adapted; pstack; or sage's own", () => {
  const rows = principleRows(
    [
      { id: "fix-root-causes", applyWhen: "debugging a failure.", source: "pstack principle-fix-root-causes, MIT, Copyright (c) 2026 Lauren Tan, adapted" },
      { id: "contextualize", applyWhen: "writing for a reader.", source: "this kit's own" },
    ],
    [{ id: "build-the-lever", description: "Apply to any non-trivial work: edits, checks. Build the tool that does it." }],
  );
  assert.deepEqual(rows, [
    { id: "build-the-lever", applyWhen: "any non-trivial work: edits, checks", text: "pstack" },
    { id: "contextualize", applyWhen: "writing for a reader", text: "sage's own" },
    { id: "fix-root-causes", applyWhen: "debugging a failure", text: "pstack, adapted" },
  ]);
});

/** A copy of this repository, where a test can change files and run the npm scripts. */
function copy(t) {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "sage-principles-")); // the real path, so that build.mjs sees that it runs as the script
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(ROOT, dir, { recursive: true, filter: (src) => ![".git", ".claude", "node_modules"].includes(relative(ROOT, src)) });
  symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"), "dir");
  const run = (script) => spawnSync("node", [join(dir, "scripts", `${script}.mjs`)], { encoding: "utf8" });
  const read = (rel) => readFileSync(join(dir, rel), "utf8");
  const write = (rel, text) => (mkdirSync(dirname(join(dir, rel)), { recursive: true }), writeFileSync(join(dir, rel), text));
  return { run, read, write };
}

test("npm run check fails when a principle's applyWhen changes and the principles page does not; the build fixes it", (t) => {
  const c = copy(t);
  c.write("principles/fix-root-causes.md", c.read("principles/fix-root-causes.md").replace("applyWhen: debugging a failure or repairing a finding.", "applyWhen: a test fails for a reason nobody knows."));
  const r = c.run("check");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /✗ docs\/guide\/principles\.md: out of date; run npm run build/);
  assert.equal(c.run("build").status, 0);
  assert.match(c.read("docs/guide/principles.md"), /\n\| fix-root-causes \| a test fails for a reason nobody knows \| pstack, adapted \|\n/);
  const after = c.run("check");
  assert.equal(after.status, 0, after.stderr);
});

test("a sync: a new pstack principle gets its row from the build, and a changed pstack text of an adapted one is flagged", (t) => {
  const c = copy(t);
  c.write("upstream/pstack/skills/principle-name-the-thing/SKILL.md", '---\nname: principle-name-the-thing\ndescription: "Apply when a value has no name. Give it one."\n---\n\n# Name the thing\n\nGive each value a name.\n');
  c.write("upstream/pstack/skills/principle-fix-root-causes/SKILL.md", `${c.read("upstream/pstack/skills/principle-fix-root-causes/SKILL.md")}\nA new pstack line.\n`);
  assert.doesNotMatch(c.read("docs/guide/principles.md"), /name-the-thing/);
  assert.equal(c.run("check").status, 1);
  assert.equal(c.run("build").status, 0);
  const readme = c.read("docs/guide/principles.md");
  assert.match(readme, /\n\| name-the-thing \| a value has no name \| pstack \|\n/);
  assert.match(readme, /There are 26 principles: 25 are pstack's, by Lauren Tan \(MIT\), and 1 is sage's own\./);
  assert.match(readme, /<summary><strong>All 26 principles<\/strong><\/summary>/);
  const after = c.run("check");
  assert.equal(after.status, 0, after.stderr); // a changed pstack text is a warning: the sync's pull request waits for a person
  assert.match(after.stderr, /! principles\/fix-root-causes\.md: pstack changed skills\/principle-fix-root-causes\/SKILL\.md since this override's review/);
});

test("npm run check fails when the principles page's table is edited by hand", (t) => {
  const c = copy(t);
  c.write("docs/guide/principles.md", c.read("docs/guide/principles.md").replace("| fix-root-causes | debugging a failure or repairing a finding | pstack, adapted |", "| fix-root-causes | debugging a failure or repairing a finding | mine |"));
  const r = c.run("check");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /✗ docs\/guide\/principles\.md: out of date; run npm run build/);
});
