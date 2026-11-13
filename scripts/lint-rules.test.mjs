import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RULE_SET, astGrep, commentScan, ruleTestProblems } from "./lint-rules.mjs";

const SUPPRESSION = ["ast-grep", "ignore"].join("-");

const MUTANTS = [
  { name: "the end anchor of the eslint directive is gone, so free text after it passes", file: "utils/js-directive.yml", from: "(, [\\w@/-]+)*)?$'", to: "(, [\\w@/-]+)*)?'", fails: "no-comments-js" },
  { name: "the end anchor of the SPDX line is gone, so free text after it passes", file: "utils/spdx.yml", from: "( \\*/| -->)?$'", to: "( \\*/| -->)?'", fails: "no-comments-js" },
  { name: "the end anchor of the yamllint directive is gone, so free text after it passes", file: "rules/no-comments-yaml.yml", from: "( rule:[\\w-]+)*)$'", to: "( rule:[\\w-]+)*)'", fails: "no-comments-yaml" },
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
    writeFileSync(file, text.replace(mutant.from, () => mutant.to));
    const run = astGrep(["test", "--skip-snapshot-tests"], dir);
    assert.notEqual(run.status, 0, `ast-grep test passed with the mutant:\n${run.stdout}${run.stderr}`);
    assert.match(run.stdout, new RegExp(`^FAIL ${mutant.fails} `, "m"));
  }));
}

test("a scan checks .js, .mjs, .cjs and .jsx files with the JavaScript rule, and in an HTML page only its HTML comments, not its script blocks of any type", () => withCopy((dir) => {
  const files = {
    "page.html": [
      "<!-- why -->",
      "<script type=\"text/x-handlebars-template\">Read more at https://example.com/docs</script>",
      "<script type=\"text/x-template\"><a href=\"//example.com\">x</a></script>",
      "<script type=\"text/plain\">see https://example.com // and /* this */</script>",
      "<script>const a = 1; // a gap that the README names</script>",
    ].join("\n"),
    "page.htm": "<script>f(); // why</script>\n<!-- why -->",
    "page.xhtml": "<script>f(); /* why */</script>\n<!-- why -->",
    "a.js": "f(); // why",
    "a.mjs": "f(); // why",
    "a.cjs": "f(); // why",
    "a.jsx": "const j = <div>{/* why */}</div>;",
  };
  for (const [name, code] of Object.entries(files)) writeFileSync(join(dir, name), code);
  const run = astGrep(["scan", "--json=compact"], dir, dir, Object.keys(files));
  assert.equal(run.status, 1, run.stderr);
  const found = JSON.parse(run.stdout).map((m) => `${m.file} ${m.ruleId} ${m.range.start.line + 1}`).sort();
  assert.deepEqual(found, ["a.cjs no-comments-js 1", "a.js no-comments-js 1", "a.jsx no-comments-js 1", "a.mjs no-comments-js 1", "page.htm no-comments-html 2", "page.html no-comments-html 1", "page.xhtml no-comments-html 2"]);
}));

const EXPLAINED = {
  "a.js": "f(); // why", "a.html": "<p>x</p><!-- why -->", "a.yml": "a: 1 # why",
};

test("each rule reports an explanatory comment as an error, and its message says what to do and where the list is", () => withCopy((dir) => {
  for (const [name, code] of Object.entries(EXPLAINED)) writeFileSync(join(dir, name), code);
  const run = astGrep(["scan", "--json=compact"], dir, dir, Object.keys(EXPLAINED));
  assert.equal(run.status, 1, run.stderr);
  const found = new Map(JSON.parse(run.stdout).map((m) => [m.ruleId, m]));
  const rules = readdirSync(join(dir, "rules")).map((file) => file.replace(/\.yml$/, "")).sort();
  assert.deepEqual([...found.keys()].sort(), rules);
  for (const [id, m] of found) {
    assert.equal(m.severity, "error", `${id} has no severity: error, so a scan that finds only its comments exits 0`);
    assert.match(m.message, /^Remove this comment\b.*README\.md/, `${id}: the message must say to remove the text and point to the rule set's README.md`);
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

test("a known limit of the rule set, which the lint command refuses as a whole file (scripts/lint-command.test.mjs): ast-grep's suppression comment hides comments from the scan", () => withCopy((dir) => {
  const files = {
    "plain.js": "const a = 1; // why\n",
    "line.js": `const a = 1; // ${SUPPRESSION} because why\n`,
    "own-line.js": `// ${SUPPRESSION}: no-comments-js\n// why\nconst e = 5;\n`,
    "line-named.yml": `a: 1 # ${SUPPRESSION}: no-comments-yaml because why\n`,
    "file.js": `// ${SUPPRESSION}\n\n// why\n/** Doc. */\nfunction f() {}\n`,
    "file-named.yml": `# ${SUPPRESSION}: no-comments-yaml\n\n# why\na: 1\n`,
  };
  for (const [name, code] of Object.entries(files)) writeFileSync(join(dir, name), code);
  const run = astGrep(["scan", "--json=compact"], dir, dir, Object.keys(files));
  assert.deepEqual(JSON.parse(run.stdout).map((m) => `${m.file} ${m.range.start.line + 1}`).sort(), ["own-line.js 1", "plain.js 1"]);
}));

test("F-T1019-3: the scan takes its paths only after --, so a file named --off is a path, not an option that turns the rules off", () => withCopy((dir) => {
  writeFileSync(join(dir, "--off"), "text\n");
  writeFileSync(join(dir, "a.js"), "f(); // why\n");
  const run = astGrep(["scan", "--json=compact"], dir, dir, ["--off", "a.js"]);
  assert.equal(run.status, 1, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout).map((m) => `${m.file} ${m.ruleId}`), ["a.js no-comments-js"]);
}));

test("F-T1019-1: the full scan fails and names a file that ast-grep skips, such as one that is not UTF-8, and skips the folders that .gitattributes marks generated or vendored", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sage-scan-")));
  try {
    cpSync(RULE_SET, join(root, "lint"), { recursive: true });
    writeFileSync(join(root, "sgconfig.yml"), "ruleDirs: [lint/rules]\nutilDirs: [lint/utils]\n");
    writeFileSync(join(root, ".gitattributes"), "src/vendor/** linguist-vendored=true\n");
    mkdirSync(join(root, "src", "vendor"), { recursive: true });
    writeFileSync(join(root, "src", "vendor", "v.js"), "f(); // vendored\n");
    writeFileSync(join(root, "src", "a.js"), "f(); // why\n");
    assert.deepEqual(commentScan(root, ["src"]).map((m) => m.file), ["src/a.js"]);
    writeFileSync(join(root, "src", "bad.js"), Buffer.from([0xff, 0xfe, 0x0a]));
    assert.throws(() => commentScan(root, ["src"]), /^Error: src\/bad\.js: ast-grep skipped this file \(invalidUtf8\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
