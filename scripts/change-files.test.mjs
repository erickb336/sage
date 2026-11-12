// T1014: the repository keeps no history file, because a fresh agent reads old history as current fact. A pull request
// says what changed for users in its description, and each release gets notes on the releases page. So `npm run check`
// fails on a file in a changes/ folder and on a CHANGELOG.md, for example from a branch that was made before T1014, and
// names the rule.
import "./test-env.mjs"; // first: no variable of the developer's shell changes a result
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";
import { ROOT } from "./build.mjs";

test("npm run check fails on a change file and a CHANGELOG.md with the rule's text, ignores a dot file, and passes once they are gone", (t) => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "sage-change-files-")); // the real path, so that build.mjs sees that it runs as the script
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(ROOT, dir, { recursive: true, filter: (src) => ![".git", ".claude", "node_modules"].includes(relative(ROOT, src)) });
  symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"), "dir");
  const check = () => spawnSync("node", [join(dir, "scripts/check.mjs")], { encoding: "utf8" });
  assert.equal(existsSync(join(dir, "changes")), false, "the repository has no changes/ folder");
  assert.equal(existsSync(join(dir, "CHANGELOG.md")), false, "the repository has no CHANGELOG.md");

  mkdirSync(join(dir, "changes"));
  writeFileSync(join(dir, "changes/T9999.md"), "---\ndate: 2026-11-12\n---\n- **A change.** What changed for users.\n");
  writeFileSync(join(dir, "changes/.DS_Store"), "\u0000\u0001Bud1");
  writeFileSync(join(dir, "CHANGELOG.md"), "# Changelog\n\n- **A change.** What changed for users.\n");
  const refused = check();
  assert.equal(refused.status, 1);
  const rule = "the repository keeps no history file (T1014); delete it, and say what changed for users in the pull request description. Each release gets its notes on the releases page, https://github.com/erickb336/sage-stack/releases (CONTRIBUTING.md)";
  const lines = refused.stderr.split("\n").filter((l) => /changes\/|CHANGELOG/.test(l));
  assert.deepEqual(lines, [`✗ CHANGELOG.md: ${rule}`, `✗ changes/T9999.md: ${rule}`]);

  rmSync(join(dir, "changes/T9999.md"));
  rmSync(join(dir, "CHANGELOG.md"));
  const passed = check();
  assert.equal(passed.status, 0, passed.stderr);
});
