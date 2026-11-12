// T1014: sage has no change file per task. A pull request says what changed for users in its description, and each
// release gets notes drafted from the merged pull requests. So `npm run check` fails on a file in a changes/ folder, for
// example from a branch that was made before T1014, and names the rule.
import "./test-env.mjs"; // first: no variable of the developer's shell changes a result
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";
import { ROOT } from "./build.mjs";

test("npm run check fails on a change file with the rule's text, ignores a dot file, and passes once the file is gone", (t) => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "sage-change-files-")); // the real path, so that build.mjs sees that it runs as the script
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(ROOT, dir, { recursive: true, filter: (src) => ![".git", ".claude", "node_modules"].includes(relative(ROOT, src)) });
  symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"), "dir");
  const check = () => spawnSync("node", [join(dir, "scripts/check.mjs")], { encoding: "utf8" });
  assert.equal(existsSync(join(dir, "changes")), false, "the repository has no changes/ folder");

  mkdirSync(join(dir, "changes"));
  writeFileSync(join(dir, "changes/T9999.md"), "---\ndate: 2026-11-12\n---\n- **A change.** What changed for users.\n");
  writeFileSync(join(dir, "changes/.DS_Store"), "\u0000\u0001Bud1");
  const refused = check();
  assert.equal(refused.status, 1);
  const lines = refused.stderr.split("\n").filter((l) => l.includes("changes/"));
  assert.deepEqual(lines, ["✗ changes/T9999.md: sage has no change file per task any more (T1014); delete it, and say what changed for users in the pull request description. Each release gets notes drafted from the merged pull requests (CONTRIBUTING.md)"]);

  rmSync(join(dir, "changes/T9999.md"));
  const passed = check();
  assert.equal(passed.status, 0, passed.stderr);
});
