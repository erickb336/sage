import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RULE_SET, astGrep, ruleTestProblems } from "./lint-rules.mjs";

const MUTANTS = [
  { name: "the end anchor of the eslint directive is gone, so free text after it passes", file: "utils/js-directive.yml", from: "( \\*/)?$'", to: "( \\*/)?'", fails: "no-comments-js" },
  { name: "the end anchor of the SPDX line is gone, so free text after it passes", file: "utils/spdx.yml", from: "( \\*/| -->)?$'", to: "( \\*/| -->)?'", fails: "no-comments-js" },
  { name: "Rust block comments are lost", file: "rules/no-comments-rust.yml", from: "any: [{ kind: line_comment }, { kind: block_comment }]", to: "kind: line_comment", fails: "no-comments-rust" },
  { name: "Java block comments are lost", file: "rules/no-comments-java.yml", from: "any: [{ kind: line_comment }, { kind: block_comment }]", to: "kind: line_comment", fails: "no-comments-java" },
  { name: "Kotlin block comments are lost", file: "rules/no-comments-kotlin.yml", from: "any: [{ kind: line_comment }, { kind: multiline_comment }]", to: "kind: line_comment", fails: "no-comments-kotlin" },
  { name: "the docstring rule flags every string", file: "rules/no-docstrings-python.yml", from: "\n  inside: { kind: expression_statement }", to: "", fails: "no-docstrings-python" },
  { name: "a Python shebang passes on any line", file: "rules/no-comments-python.yml", from: "{ nthChild: 1 }]", to: "{ regex: '.' }]", fails: "no-comments-python" },
  { name: "a shell shebang passes on any line", file: "rules/no-comments-shell.yml", from: "{ nthChild: 1 }]", to: "{ regex: '.' }]", fails: "no-comments-shell" },
  { name: "any comment before a later import \"C\" passes as a cgo preamble", file: "rules/no-comments-go.yml", from: "stopBy: { not: { kind: comment } }", to: "stopBy: end", fails: "no-comments-go" },
  { name: "a comment inside an HTML attribute value is flagged", file: "rules/no-comments-html.yml", from: "\n      - inside: { kind: quoted_attribute_value }", to: "", fails: "no-comments-html" },
];

function copyOfRuleSet() {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "sage-lint-"));
  cpSync(RULE_SET, dir, { recursive: true });
  return dir;
}

function withCopy(change) {
  const dir = copyOfRuleSet();
  try { return change(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("the rule set passes its own rule tests", () => {
  assert.deepEqual(withCopy((dir) => ruleTestProblems(dir)), []);
});

for (const mutant of MUTANTS) {
  test(`a mutant fails the rule tests: ${mutant.name}`, () => withCopy((dir) => {
    const file = join(dir, mutant.file), text = readFileSync(file, "utf8");
    assert.equal(text.split(mutant.from).length, 2, `the mutant must change exactly one place of ${mutant.file}; update it to the rule`);
    writeFileSync(file, text.replace(mutant.from, mutant.to));
    const run = astGrep(["test", "--skip-snapshot-tests"], dir);
    assert.notEqual(run.status, 0, `ast-grep test passed with the mutant:\n${run.stdout}${run.stderr}`);
    assert.match(run.stdout, new RegExp(`^FAIL ${mutant.fails} `, "m"));
  }));
}

test("a scan flags the comments of the script and the style inside an HTML page", () => withCopy((dir) => {
  writeFileSync(join(dir, "page.html"), [
    "<!-- SPDX-License-Identifier: MIT -->",
    "<script>",
    "const u = \"https://example.com//x\"; // why",
    "/* eslint-disable */",
    "</script>",
    "<style>",
    "a { color: red; } /* why */",
    "/* stylelint-disable */",
    "</style>",
    "<p title=\"<!-- x -->\">y</p>",
  ].join("\n"));
  const run = astGrep(["scan", "--json=compact", "page.html"], dir);
  assert.equal(run.status, 1, run.stderr);
  const found = JSON.parse(run.stdout).map((m) => `${m.ruleId} ${m.range.start.line + 1} ${m.text}`).sort();
  assert.deepEqual(found, ["no-comments-css 7 /* why */", "no-comments-js 3 // why"]);
}));
