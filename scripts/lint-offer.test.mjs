import "./test-env.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { AST_GREP, RULE_SET } from "./lint-rules.mjs";
import { AST_GREP_VERSION, astGrepScan } from "../packages/sage-core/lint.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const LANGUAGES = JSON.parse(readFileSync(join(RULE_SET, "languages.json"), "utf8"));

test("each extension of languages.json is the language that ast-grep 0.51.1 gives it, and JSON, Markdown and a dotfile with no extension are not in it", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "sage-lint-languages-")));
  try {
    mkdirSync(join(dir, "rules"));
    writeFileSync(join(dir, "sgconfig.yml"), "ruleDirs: [rules]\n");
    const want = Object.entries(LANGUAGES).flatMap(([name, { extensions }]) => extensions.map((e) => [`f.${e}`, name]));
    const odd = ["f.json", "f.md", ".env", "f.PY"];
    for (const name of [...want.map(([file]) => file), ...odd]) writeFileSync(join(dir, name), "x\n");
    const { files } = astGrepScan(AST_GREP, { config: join(dir, "sgconfig.yml"), cwd: dir, paths: ["."] });
    const seen = Object.fromEntries([...files].map(([file, f]) => [file.replace(/^\.\//, ""), f.languages[0]]));
    assert.deepEqual(Object.fromEntries(want), Object.fromEntries(want.map(([file]) => [file, seen[file]])));
    assert.deepEqual([seen["f.json"], seen["f.md"], seen[".env"], seen["f.PY"]], ["Json", "Markdown", undefined, undefined]);
    assert.equal(new Set(want.map(([file]) => file)).size, want.length, "each extension names one language");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the tools lockfile pins @ast-grep/cli at the version that lint needs, with the same packages and integrity as the repository's lockfile", () => {
  const pair = JSON.parse(readFileSync(join(RULE_SET, "tools", "package.json"), "utf8"));
  assert.deepEqual(pair.dependencies, { "@ast-grep/cli": AST_GREP_VERSION });
  const lock = JSON.parse(readFileSync(join(RULE_SET, "tools", "package-lock.json"), "utf8")).packages;
  const root = JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8")).packages;
  const names = Object.keys(lock).filter(Boolean);
  assert.deepEqual(Object.keys(lock["node_modules/@ast-grep/cli"].optionalDependencies).map((n) => names.includes(`node_modules/${n}`)), Object.keys(lock["node_modules/@ast-grep/cli"].optionalDependencies).map(() => true), "each platform's binary is in the lockfile");
  for (const name of names) {
    const { dev, ...own } = root[name] ?? {};
    assert.match(lock[name].integrity, /^sha512-/, name);
    assert.deepEqual(lock[name], own, name);
  }
  assert.equal(lock["node_modules/@ast-grep/cli"].version, AST_GREP_VERSION);
});
