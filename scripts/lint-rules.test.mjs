import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { RULE_SET, astGrep, commentScan, ruleTestProblems } from "./lint-rules.mjs";

const SUPPRESSION = ["ast-grep", "ignore"].join("-");

const MUTANTS = [
  { name: "the end anchor of the eslint directive is gone, so free text after it passes", file: "utils/js-directive.yml", from: "(, [\\w@/-]+)*)?$'", to: "(, [\\w@/-]+)*)?'", fails: "no-comments-js" },
  { name: "the end anchor of the SPDX line is gone, so free text after it passes", file: "utils/spdx.yml", from: "( \\*/| -->)?$'", to: "( \\*/| -->)?'", fails: "no-comments-js" },
  { name: "the end anchor of the yamllint directive is gone, so free text after it passes", file: "rules/no-comments-yaml.yml", from: "( rule:[\\w-]+)*)$'", to: "( rule:[\\w-]+)*)'", fails: "no-comments-yaml" },
  { name: "the end anchor of the shellcheck directive is gone, so free text after it passes", file: "rules/no-comments-shell.yml", from: "=[\\w,./$-]+)+$'", to: "=[\\w,./$-]+)+'", fails: "no-comments-shell" },
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

test("F-T1027-1: a scan checks .js, .mjs, .cjs and .jsx files with the JavaScript rule, and in an HTML page its HTML comments, the JavaScript of each script block and the CSS of each style block", () => withCopy((dir) => {
  const files = {
    "page.html": [
      "<!-- why -->",
      "<script>const a = 1; // why</script>",
      "<script type=\"module\">import x from \"./x.js\"; /* why */</script>",
      "<style>a { color: red; } /* why */</style>",
      "<template><a href=\"//example.com\">see https://example.com // and /* this */</a></template>",
      "<script>const u = \"https://example.com//a\"; /* eslint-disable */</script>",
      "<style>a { background: url(//example.com/a.png); }</style>",
    ].join("\n"),
    "page.htm": "<script>f(); // why</script>\n<!-- why -->",
    "page.xhtml": "<script>f(); /* why */</script>\n<!-- why -->",
    "a.js": "f(); // why",
    "a.mjs": "f(); // why",
    "a.cjs": "f(); // why",
    "a.jsx": "const j = <div>{/* why */}</div>;",
    "a.css": "a { color: red; } /* why */",
  };
  for (const [name, code] of Object.entries(files)) writeFileSync(join(dir, name), code);
  const run = astGrep(["scan", "--json=compact"], dir, dir, Object.keys(files));
  assert.equal(run.status, 1, run.stderr);
  const found = JSON.parse(run.stdout).map((m) => `${m.file} ${m.ruleId} ${m.range.start.line + 1}`).sort();
  assert.deepEqual(found, ["a.cjs no-comments-js 1", "a.css no-comments-css 1", "a.js no-comments-js 1", "a.jsx no-comments-js 1", "a.mjs no-comments-js 1", "page.htm no-comments-html 2", "page.htm no-comments-js 1", "page.html no-comments-css 4", "page.html no-comments-html 1", "page.html no-comments-js 2", "page.html no-comments-js 3", "page.xhtml no-comments-html 2", "page.xhtml no-comments-js 1"]);
}));

test("a known limit of the rule set: ast-grep reads a script block of any type as JavaScript, so text in a template script that looks like a comment fails", () => withCopy((dir) => {
  writeFileSync(join(dir, "page.html"), "<script type=\"text/x-template\">Read more at https://example.com/docs</script>\n");
  const run = astGrep(["scan", "--json=compact"], dir, dir, ["page.html"]);
  assert.deepEqual(JSON.parse(run.stdout).map((m) => `${m.ruleId} ${m.text}`), ["no-comments-js //example.com/docs"]);
}));

test("F-T1027-2: a scan checks the shell in the run blocks of a YAML file, and no other block and no shell script", () => withCopy((dir) => {
  const files = {
    "ci.yml": [
      "jobs:",
      "  a:",
      "    steps:",
      "      - run: |",
      "          # why",
      "          echo \"a # b\" ${#x} # why",
      "          # shellcheck disable=SC2086",
      "      - name: n",
      "        run: |-",
      "          npm ci",
      "          # why",
      "      - with:",
      "          script: |",
      "            # data for another tool",
      "      - run: echo hi",
    ].join("\n"),
    "tool.sh": "#!/bin/sh\n# a shell script is not in the rule set\necho hi\n",
  };
  for (const [name, code] of Object.entries(files)) writeFileSync(join(dir, name), code);
  const run = astGrep(["scan", "--json=compact"], dir, dir, Object.keys(files));
  assert.equal(run.status, 1, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout).map((m) => `${m.file} ${m.ruleId} ${m.range.start.line + 1}`).sort(), ["ci.yml no-comments-shell 11", "ci.yml no-comments-shell 5", "ci.yml no-comments-shell 6"]);
}));

test("F-T1027-20: a folded run block (> or >-) gives no shell match, because the shell gets its lines folded into one; a literal block (|, |- or |+) does", () => withCopy((dir) => {
  const steps = ["|", "|-", "|+", ">", ">-", ">+"].flatMap((sign) => [`  - run: ${sign}`, "      npm ci # why", "      npm test"]);
  writeFileSync(join(dir, "ci.yml"), ["steps:", ...steps].join("\n"));
  const run = astGrep(["scan", "--json=compact"], dir, dir, ["ci.yml"]);
  assert.deepEqual(JSON.parse(run.stdout).map((m) => m.range.start.line + 1), [3, 6, 9], run.stderr);
}));

test("F-T1027-23: the root sgconfig.yml gives the same run blocks to the shell rule as the rule set's own sgconfig.yml", () => {
  const injections = (file) => parse(readFileSync(file, "utf8")).languageInjections;
  assert.ok(injections(join(RULE_SET, "sgconfig.yml"))?.length);
  assert.deepEqual(injections(fileURLToPath(new URL("../sgconfig.yml", import.meta.url))), injections(join(RULE_SET, "sgconfig.yml")));
});

const EXPLAINED = {
  "a.js": "f(); // why", "a.html": "<p>x</p><!-- why -->", "a.yml": "a: 1 # why", "a.css": "/* why */", "ci.yml": "run: |\n  npm ci # why\n",
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

test("F-T1027-11: the full scan reads the files that a nested .gitignore or .ignore names, and skips only .git, node_modules and the .gitattributes exclusions", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sage-scan-")));
  try {
    cpSync(RULE_SET, join(root, "lint"), { recursive: true });
    writeFileSync(join(root, "sgconfig.yml"), "ruleDirs: [lint/rules]\nutilDirs: [lint/utils]\n");
    mkdirSync(join(root, "src", "node_modules"), { recursive: true });
    writeFileSync(join(root, "src", ".gitignore"), "hidden-by-git.js\n");
    writeFileSync(join(root, "src", ".ignore"), "hidden-by-ignore.js\n");
    for (const name of ["hidden-by-git.js", "hidden-by-ignore.js", "node_modules/dep.js"]) writeFileSync(join(root, "src", name), "f(); // why\n");
    assert.deepEqual(commentScan(root, ["src"]).map((m) => m.file).sort(), ["src/hidden-by-git.js", "src/hidden-by-ignore.js"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
