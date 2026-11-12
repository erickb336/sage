import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RULE_SET, astGrep, ruleTestProblems } from "./lint-rules.mjs";

const MUTANTS = [
  { name: "the end anchor of the eslint directive is gone, so free text after it passes", file: "utils/js-directive.yml", from: "(, [\\w@/-]+)*)?$'", to: "(, [\\w@/-]+)*)?'", fails: "no-comments-js" },
  { name: "the end anchor of the SPDX line is gone, so free text after it passes", file: "utils/spdx.yml", from: "( \\*/| -->)?\\r?$'", to: "( \\*/| -->)?'", fails: "no-comments-js" },
  { name: "a line that ends in CR LF fails the end anchor, so the SPDX line of a Windows file is flagged", file: "utils/spdx.yml", from: "\\r?$'", to: "$'", fails: "no-comments-rust" },
  { name: "every //go: directive takes free text after it", file: "rules/no-comments-go.yml", from: "'^//go:\\w+\\r?$'", to: "'^//go:\\w+( .*)?$'", fails: "no-comments-go" },
  { name: "Rust block comments are lost", file: "rules/no-comments-rust.yml", from: "any: [{ kind: line_comment }, { kind: block_comment }]", to: "kind: line_comment", fails: "no-comments-rust" },
  { name: "Java block comments are lost", file: "rules/no-comments-java.yml", from: "any: [{ kind: line_comment }, { kind: block_comment }]", to: "kind: line_comment", fails: "no-comments-java" },
  { name: "Kotlin block comments are lost", file: "rules/no-comments-kotlin.yml", from: "any: [{ kind: line_comment }, { kind: multiline_comment }]", to: "kind: line_comment", fails: "no-comments-kotlin" },
  { name: "the docstring rule flags every string", file: "rules/no-docstrings-python.yml", from: "\n  inside: { kind: expression_statement }", to: "", fails: "no-docstrings-python" },
  { name: "a Python shebang passes on any line", file: "rules/no-comments-python.yml", from: "{ nthChild: 1 }, { inside", to: "{ regex: '.' }, { inside", fails: "no-comments-python" },
  { name: "a Python shebang passes as the first comment of any block, not only on line 1 of the file", file: "rules/no-comments-python.yml", from: ", { inside: { kind: module } }", to: "", fails: "no-comments-python" },
  { name: "a shell shebang passes on any line", file: "rules/no-comments-shell.yml", from: "{ nthChild: 1 }, { inside", to: "{ regex: '.' }, { inside", fails: "no-comments-shell" },
  { name: "any comment before a later import \"C\" passes as a cgo preamble", file: "rules/no-comments-go.yml", from: "stopBy: { not: { kind: comment } }", to: "stopBy: end", fails: "no-comments-go" },
  { name: "a comment inside an HTML attribute value is flagged", file: "rules/no-comments-html.yml", from: "\n      - inside: { kind: quoted_attribute_value }", to: "", fails: "no-comments-html" },
  { name: "the text ## before an interpolation in a Ruby heredoc is flagged", file: "rules/no-comments-ruby.yml", from: "\n      - inside: { kind: heredoc_body }", to: "", fails: "no-comments-ruby" },
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
    writeFileSync(file, text.replace(mutant.from, () => mutant.to));
    const run = astGrep(["test", "--skip-snapshot-tests"], dir);
    assert.notEqual(run.status, 0, `ast-grep test passed with the mutant:\n${run.stdout}${run.stderr}`);
    assert.match(run.stdout, new RegExp(`^FAIL ${mutant.fails} `, "m"));
  }));
}

test("a scan of an HTML page checks only its HTML comments, and skips its script and style blocks of any type", () => withCopy((dir) => {
  const files = {
    "page.html": [
      "<!-- why -->",
      "<script type=\"text/x-handlebars-template\">Read more at https://example.com/docs</script>",
      "<script type=\"text/x-template\"><a href=\"//example.com\">x</a></script>",
      "<script type=\"text/plain\">see https://example.com // and /* this */</script>",
      "<script>const a = 1; // a gap that the README names</script>",
      "<script lang=\"ts\">const a: number = 1; // why</script>",
      "<script lang=\"tsx\">const a = <b />; // why</script>",
      "<style>a { color: red; } /* why */</style>",
    ].join("\n"),
    "page.htm": "<script>f(); // why</script>\n<!-- why -->",
    "page.xhtml": "<style>a { color: red; } /* why */</style>\n<!-- why -->",
    "a.js": "f(); // why",
    "a.css": "a { color: red; } /* why */",
  };
  for (const [name, code] of Object.entries(files)) writeFileSync(join(dir, name), code);
  const run = astGrep(["scan", "--json=compact", ...Object.keys(files)], dir);
  assert.equal(run.status, 1, run.stderr);
  const found = JSON.parse(run.stdout).map((m) => `${m.file} ${m.ruleId} ${m.range.start.line + 1}`).sort();
  assert.deepEqual(found, ["a.css no-comments-css 1", "a.js no-comments-js 1", "page.htm no-comments-html 2", "page.html no-comments-html 1", "page.xhtml no-comments-html 2"]);
}));

const EXPLAINED = {
  "a.js": "f(); // why", "a.ts": "f(); // why", "a.tsx": "f(); // why", "a.py": "\"\"\"Doc.\"\"\"\nx = 1  # why", "a.go": "package a // why",
  "a.rs": "fn f() {} // why", "a.java": "class A {} // why", "a.kt": "class A // why", "a.sh": "echo hi # why", "a.rb": "x = 1 # why",
  "a.css": "a { color: red; } /* why */", "a.html": "<p>x</p><!-- why -->", "a.yml": "a: 1 # why",
};

test("each rule reports an explanatory comment as an error, and its message says what to do and where the list is", () => withCopy((dir) => {
  for (const [name, code] of Object.entries(EXPLAINED)) writeFileSync(join(dir, name), code);
  const run = astGrep(["scan", "--json=compact", ...Object.keys(EXPLAINED)], dir);
  assert.equal(run.status, 1, run.stderr);
  const found = new Map(JSON.parse(run.stdout).map((m) => [m.ruleId, m]));
  const rules = readdirSync(join(dir, "rules")).map((file) => file.replace(/\.yml$/, "")).sort();
  assert.deepEqual([...found.keys()].sort(), rules);
  for (const [id, m] of found) {
    assert.equal(m.severity, "error", `${id} has no severity: error, so a scan that finds only its comments exits 0`);
    assert.match(m.message, /^Remove this (comment|docstring)\b.*README\.md/, `${id}: the message must say to remove the text and point to the rule set's README.md`);
  }
}));

test("the check's failure text names the rule and its test file, and points to the README", () => withCopy((dir) => {
  const file = join(dir, "rule-tests/no-comments-yaml-test.yml");
  writeFileSync(file, `${readFileSync(file, "utf8")}  - '# yamllint disable rule:x'\n`);
  const [problem, ...more] = ruleTestProblems(dir);
  assert.deepEqual(more, []);
  assert.match(problem, /rules\/no-comments-yaml\.yml or rule-tests\/no-comments-yaml-test\.yml/);
  assert.match(problem, /"Change the rule set" in packages\/sage-core\/lint\/README\.md/);
}));

test("a known limit of the rule set, until the lint command (T1019) refuses it: ast-grep's suppression comment hides comments from the scan", () => withCopy((dir) => {
  const files = {
    "plain.js": "const a = 1; // why\n",
    "line.js": "const a = 1; // ast-grep-ignore because why\n",
    "own-line.ts": "// ast-grep-ignore: no-comments-ts\n// why\nconst e = 5;\n",
    "line-named.py": "x = 1  # ast-grep-ignore: no-comments-python because why\n",
    "file.js": "// ast-grep-ignore\n\n// why\n/** Doc. */\nfunction f() {}\n",
    "file-named.py": "# ast-grep-ignore: no-comments-python, no-docstrings-python\n\n\"\"\"Doc.\"\"\"\n# why\nx = 1\n",
  };
  for (const [name, code] of Object.entries(files)) writeFileSync(join(dir, name), code);
  const run = astGrep(["scan", "--json=compact", ...Object.keys(files)], dir);
  assert.deepEqual(JSON.parse(run.stdout).map((m) => `${m.file} ${m.range.start.line + 1}`).sort(), ["own-line.ts 1", "plain.js 1"]);
}));
