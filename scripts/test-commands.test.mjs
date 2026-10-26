import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { unrunTestFiles } from "./test-commands.mjs";

test("a test file that no test command names is reported by its path, in any folder (T350)", (t) => {
  const root = mkdtempSync(join(tmpdir(), "sage-test-commands-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (path, text = "") => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); };
  write("package.json", JSON.stringify({ scripts: {
    test: "env -u NODE_TEST_CONTEXT node --test scripts/a.test.mjs pkg/*.test.mjs",
    "test:browser": "node --test scripts/b.test.mjs",
  } }));
  for (const path of [
    "scripts/a.test.mjs", "scripts/b.test.mjs", "pkg/d.test.mjs", "scripts/helper.mjs", // run, or no test file
    "scripts/c.test.mjs", "scripts/fixtures/e.test.mjs", "pkg/sub/f.test.mjs", // left out
    "plugins/p.test.mjs", "node_modules/m.test.mjs", "pkg/node_modules/n.test.mjs", ".claude/w.test.mjs", // skipped folders
  ]) write(path);
  assert.deepEqual(unrunTestFiles(root), ["pkg/sub/f.test.mjs", "scripts/c.test.mjs", "scripts/fixtures/e.test.mjs"]);
});
