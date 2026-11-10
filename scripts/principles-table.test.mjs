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

test("each principle gets its attribution from its source: from pstack; or sage's own", () => {
  const rows = principleRows([
    { id: "fix-root-causes", applyWhen: "debugging a failure.", source: "pstack principle-fix-root-causes, MIT, Copyright (c) 2026 Lauren Tan, adapted" },
    { id: "contextualize", applyWhen: "writing for a reader.", source: "this kit's own" },
    { id: "build-the-lever", applyWhen: "the work is not trivial: edits, checks.", source: "pstack principle-build-the-lever, MIT, Copyright (c) 2026 Lauren Tan, adapted" },
  ]);
  assert.deepEqual(rows, [
    { id: "build-the-lever", applyWhen: "the work is not trivial: edits, checks", text: "from pstack" },
    { id: "contextualize", applyWhen: "writing for a reader", text: "sage's own" },
    { id: "fix-root-causes", applyWhen: "debugging a failure", text: "from pstack" },
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
  assert.match(c.read("docs/guide/principles.md"), /\n\| fix-root-causes<br>\*from pstack\* \| a test fails for a reason nobody knows \|\n/);
  const after = c.run("check");
  assert.equal(after.status, 0, after.stderr);
});

test("npm run check fails when the principles page's table is edited by hand", (t) => {
  const c = copy(t);
  c.write("docs/guide/principles.md", c.read("docs/guide/principles.md").replace("| fix-root-causes<br>*from pstack* | debugging a failure or repairing a finding |", "| fix-root-causes<br>*mine* | debugging a failure or repairing a finding |"));
  const r = c.run("check");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /✗ docs\/guide\/principles\.md: out of date; run npm run build/);
});
