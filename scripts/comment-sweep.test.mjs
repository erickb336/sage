import "./test-env.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { ROOT } from "./build.mjs";
import { prove } from "./comment-proof.mjs";
import { stripComments } from "./strip-comments.mjs";

function folder(files) {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "sage-strip-"));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return { dir, read: (name) => readFileSync(join(dir, name), "utf8"), done: () => rmSync(dir, { recursive: true, force: true }) };
}

function stripped(name, text) {
  const f = folder({ [name]: text });
  try {
    stripComments(f.dir, ["."]);
    return f.read(name);
  } finally { f.done(); }
}

const BOTH_PASS = { tokens: true, canonical: true };

test("the token proof and the minified proof pass when only comments go", () => {
  const before = "#!/usr/bin/env node\nimport x from \"x\";\n/** doc */\nexport function f(a) { return a + x; }\n";
  assert.deepEqual(prove("a.mjs", before, stripped("a.mjs", before)), BOTH_PASS);
});

test("control: an automatic semicolon change after a multi-line comment fails both proofs", () => {
  const result = prove("a.mjs", "function f() { return /* a\nb */ 1; }\nf();\n", "function f() { return  1; }\nf();\n");
  assert.notEqual(result.tokens, true);
  assert.notEqual(result.canonical, true);
});

test("control: a dropped semicolon fails the token proof", () => {
  assert.notEqual(prove("a.mjs", "const a = 1; // x\nconst b = 2;\n", "const a = 1;\nconst b = 2\n").tokens, true);
});

test("control: a whitespace change in a template literal fails both proofs", () => {
  const result = prove("a.mjs", "const t = `a  b`; // x\n", "const t = `a b`;\n");
  assert.notEqual(result.tokens, true);
  assert.notEqual(result.canonical, true);
});

test("control: a YAML indentation change fails both proofs, and a removed comment passes them", () => {
  const before = "on:\n  push: # why\n    branches: [main]\n";
  const indented = prove("a.yml", before, "on:\n  push:\n  branches: [main]\n");
  assert.notEqual(indented.tokens, true);
  assert.notEqual(indented.canonical, true);
  assert.deepEqual(prove("a.yml", before, stripped("a.yml", before)), BOTH_PASS);
});

test("a multi-line comment between two tokens leaves a line break, so the automatic semicolon stays", () => {
  const before = "function f() { return /* a\nb */ 1; }\n";
  const after = stripped("a.mjs", before);
  assert.deepEqual(prove("a.mjs", before, after), BOTH_PASS);
  assert.equal(new Function(`${after}; return f();`)(), undefined);
});

test("the strip keeps the shebang and each directive of the rule set, and removes every other comment", () => {
  const before = "#!/usr/bin/env node\n// why\n\n/* c8 ignore next */\nrun(/* why */ a, b); // why\n/* eslint-disable no-console -- why */\n";
  assert.equal(stripped("a.mjs", before), "#!/usr/bin/env node\n/* c8 ignore next */\nrun(a, b);\n");
});

test("a second strip changes nothing", () => {
  const f = folder({ "a.mjs": "// a\nconst a = 1; /* b */\n\n// c\n\nexport { a };\n", ".github/w.yml": "on: push # d\n" });
  try {
    assert.deepEqual(stripComments(f.dir, ["."]), { files: 2, comments: 4 });
    const first = [f.read("a.mjs"), f.read(".github/w.yml")];
    assert.deepEqual(first, ["const a = 1;\n\nexport { a };\n", "on: push\n"]);
    assert.deepEqual(stripComments(f.dir, ["."]), { files: 0, comments: 0 });
    assert.deepEqual([f.read("a.mjs"), f.read(".github/w.yml")], first);
  } finally { f.done(); }
});

test("the strip leaves the excluded folders alone", () => {
  const f = folder({ "scripts/fixtures/sage-14c0d0c/old.mjs": "old(); // test data\n", "scripts/new.mjs": "run(); // why\n" });
  try {
    stripComments(f.dir, ["scripts"]);
    assert.equal(f.read("scripts/fixtures/sage-14c0d0c/old.mjs"), "old(); // test data\n");
    assert.equal(f.read("scripts/new.mjs"), "run();\n");
  } finally { f.done(); }
});
