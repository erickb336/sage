import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT } from "./build.mjs";
import { npxAstGrepProblems, npxPinProblems, pinnedVersion } from "./npx-pin.mjs";

const PIN = pinnedVersion();
const README = "packages/sage-core/lint/README.md";
const OLD = ["   npx ast-grep test --skip-snapshot-tests", "   npx ast-grep scan --config sgconfig.yml --no-ignore hidden --globs '!.git' <folder>", "They need ast-grep 0.51.1 (`npm install --save-dev --save-exact @ast-grep/cli@0.51.1`)."];

test("the pin is an exact version", () => assert.match(PIN, /^\d+\.\d+\.\d+$/));

test("a bare npx ast-grep fails, as the old README lines did", () => {
  for (const line of OLD.slice(0, 2)) assert.equal(npxAstGrepProblems(README, line, PIN).length, 1, line);
  assert.equal(npxAstGrepProblems(README, "run `npx --yes ast-grep test`", PIN).length, 1);
  assert.equal(npxAstGrepProblems(README, "npx --package=@ast-grep/cli@0.1.0 ast-grep test", PIN).length, 2);
});

test("the pinned form passes", () => {
  assert.deepEqual(npxAstGrepProblems(README, `npx --yes --package=@ast-grep/cli@${PIN} ast-grep test`, PIN), []);
});

test("another version of the package or the tool fails", () => {
  assert.equal(npxAstGrepProblems(README, "npm install @ast-grep/cli@0.40.0", PIN).length, 1);
  assert.equal(npxAstGrepProblems(README, "They need ast-grep 0.40.0 here", PIN).length, 1);
});

test("the sources of the repository pass", () => assert.deepEqual(npxPinProblems(), []));

test("a copy with the old README lines fails, and names the file and line", () => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "sage-npx-pin-"));
  try {
    mkdirSync(join(dir, "packages/sage-core/lint"), { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ devDependencies: { "@ast-grep/cli": PIN } }));
    writeFileSync(join(dir, README), `${OLD.join("\n")}\n`);
    const problems = npxPinProblems(dir);
    assert.equal(problems.length, 2);
    assert.match(problems[0], new RegExp(`^${README}:1: npx runs the bare name ast-grep`));
    writeFileSync(join(dir, README), readFileSync(join(ROOT, README), "utf8"));
    assert.deepEqual(npxPinProblems(dir), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
