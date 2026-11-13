import "./test-env.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { Lang, parse } from "@ast-grep/napi";
import { buildBoardModel } from "../packages/sage-core/board-model.mjs";
import { renderAgentsHtml, renderBoardHtml, renderMilestonesHtml, renderReleasesHtml } from "../packages/sage-core/board-render.mjs";
import { prepareMessage } from "../packages/sage-core/message.mjs";
import { messagePage } from "../packages/sage-core/message-page.mjs";
import { mapHtml } from "../packages/sage-core/move-text.mjs";
import { ROOT } from "./build.mjs";
import { prove } from "./comment-proof.mjs";
import { RULE_SET } from "./lint-rules.mjs";
import { stripComments } from "./strip-comments.mjs";

const PROJECT = {
  "sgconfig.yml": `ruleDirs: [${JSON.stringify(join(RULE_SET, "rules"))}]\nutilDirs: [${JSON.stringify(join(RULE_SET, "utils"))}]\n`,
  ".gitattributes": readFileSync(join(ROOT, ".gitattributes"), "utf8"),
};

function folder(files) {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "sage-strip-"));
  for (const [name, text] of Object.entries({ ...PROJECT, ...files })) {
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

test("a comment before a template literal leaves the spaces at the end of the template's first line", () => {
  for (const before of ["const t = /* c */ `abc   \ndef`;\n", "/* c */ `abc   \ndef`;\n"]) {
    const after = stripped("a.mjs", before);
    assert.equal(after, before.replace("/* c */ ", ""));
    assert.deepEqual(prove("a.mjs", before, after), BOTH_PASS);
  }
});

test("a YAML comment line and the blank lines after it go together, so a keep block (|+) keeps its value", () => {
  for (const blanks of ["\n", "\n\n"]) {
    const before = `a: |+\n  text\n# c\n${blanks}b: 1\n`;
    const after = stripped("a.yml", before);
    assert.equal(after, "a: |+\n  text\nb: 1\n");
    assert.deepEqual(prove("a.yml", before, after), BOTH_PASS);
  }
  const grown = prove("a.yml", "a: |+\n  text\nb: 1\n", "a: |+\n  text\n\nb: 1\n");
  assert.notEqual(grown.tokens, true);
  assert.notEqual(grown.canonical, true);
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

test("both scripts print their usage on --help, and one line with no stack trace for an unknown option or a ref that is not there", () => {
  const run = (script, args) => spawnSync("node", [join(ROOT, "scripts", script), ...args], { cwd: ROOT, encoding: "utf8" });
  for (const script of ["strip-comments.mjs", "comment-proof.mjs"]) {
    const help = run(script, ["--help"]);
    assert.equal(help.status, 0);
    assert.match(help.stdout, new RegExp(`^usage: node scripts/${script} `));
    assert.equal(help.stderr, "");
    const unknown = run(script, ["--nope"]);
    assert.equal(unknown.status, 2);
    assert.equal(unknown.stderr.split("\n")[0], `${script.replace(".mjs", "")}: unknown option --nope`);
    assert.doesNotMatch(unknown.stderr, /\n\s+at /);
  }
  const missing = run("comment-proof.mjs", ["no-such-ref"]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /^comment-proof: .*no-such-ref.*\n$/);
});

test("npm run check fails on one comment in the sources, and names the file and line", () => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "sage-comment-check-"));
  try {
    cpSync(ROOT, dir, { recursive: true, filter: (src) => ![".git", ".claude", "node_modules"].includes(relative(ROOT, src)) });
    symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"), "dir");
    const check = () => spawnSync("node", [join(dir, "scripts/check.mjs")], { encoding: "utf8" });
    const clean = check();
    assert.equal(clean.status, 0, clean.stderr);
    writeFileSync(join(dir, "scripts/sample.mjs"), "export const why = 1; // a reason\n");
    const r = check();
    assert.equal(r.status, 1, r.stdout);
    assert.deepEqual(r.stderr.split("\n").filter((line) => line.startsWith("✗")).map((line) => line.split(", ")[0]), ["✗ scripts/sample.mjs:1: a comment (no-comments-js)"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

function servedComments(html) {
  const found = [];
  const walk = (node) => {
    if (/comment/.test(node.kind())) return found.push(node.text());
    if (node.kind() === "raw_text") return walk(parse(node.parent().kind() === "style_element" ? Lang.Css : Lang.JavaScript, node.text()).root());
    node.children().forEach(walk);
  };
  walk(parse(Lang.Html, html).root());
  return found;
}

test("control: the page reader finds a comment in a page's HTML, its style and its script, and none in a URL", () => {
  assert.deepEqual(servedComments("<p>a</p><!-- h --><style>a{color:red}/* s */</style><script>f('https://x.test'); // j\n</script>"), ["<!-- h -->", "/* s */", "// j"]);
});

test("every page that the board, a message and a move serve has no comment in its HTML, its scripts or its styles, which the source scan reads as string text", () => {
  const model = buildBoardModel([], { now: "2026-10-20T12:00:00Z" });
  const message = prepareMessage(JSON.parse(readFileSync(join(ROOT, "scripts/fixtures/messages/02-question.json"), "utf8"))).msg;
  const plan = { folder: "sample-abcdef.shared", digest: "0123456789abcdef", map: { tasks: [], gates: [], milestones: [], findings: [] } };
  const pages = {
    board: renderBoardHtml(model, { live: true }),
    agents: renderAgentsHtml(model, { live: true }),
    releases: renderReleasesHtml(model, { live: true }),
    milestones: renderMilestonesHtml(model, { live: true }),
    message: messagePage(message, ""),
    "move map": mapHtml(plan, { at: "2026-10-20T12:00:00Z", backups: [], shown: (name) => name }),
  };
  for (const [name, html] of Object.entries(pages)) {
    assert.match(html, /<script>[^<]/, `${name}: the page has a script`);
    assert.deepEqual(servedComments(html), [], name);
  }
});
