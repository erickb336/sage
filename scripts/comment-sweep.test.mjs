import "./test-env.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { Lang, parse } from "@ast-grep/napi";
import { buildBoardModel } from "../packages/sage-core/board-model.mjs";
import { renderAgentsHtml, renderBoardHtml, renderMilestonesHtml, renderReleasesHtml } from "../packages/sage-core/board-render.mjs";
import { servePages } from "../packages/sage-board/pages.mjs";
import { prepareMessage } from "../packages/sage-core/message.mjs";
import { messagePage } from "../packages/sage-core/message-page.mjs";
import { mapHtml } from "../packages/sage-core/move-text.mjs";
import { ROOT } from "./build.mjs";
import { NOW, milestonesSource } from "./fixtures/board-milestones.mjs";
import { NOW as WALK_NOW, STAGES, walkthroughSource } from "./fixtures/board-walkthrough.mjs";
import { prove } from "./comment-proof.mjs";
import { RULE_SET } from "./lint-rules.mjs";
import { stripComments } from "./strip-comments.mjs";

const PROJECT = { ".gitattributes": readFileSync(join(ROOT, ".gitattributes"), "utf8") };

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
    assert.deepEqual(stripComments(f.dir, ["."]), { files: 2, comments: 4, skipped: [] });
    const first = [f.read("a.mjs"), f.read(".github/w.yml")];
    assert.deepEqual(first, ["const a = 1;\n\nexport { a };\n", "on: push\n"]);
    assert.deepEqual(stripComments(f.dir, ["."]), { files: 0, comments: 0, skipped: [] });
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

function pagesIndex() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "sage-pages-")), logbook = "sample-abcdef", saved = process.env.SAGE_WORKTREES;
  mkdirSync(join(root, logbook, "pages", "T1"), { recursive: true });
  writeFileSync(join(root, logbook, "pages", "T1", "scripted.html"), "<!DOCTYPE html><p>SAMPLE</p><script>f()</script>");
  writeFileSync(join(root, logbook, "pages", "T1", "notes.txt"), "SAMPLE");
  process.env.SAGE_WORKTREES = root;
  try {
    let status = 0, body = "";
    const response = { setHeader() {}, writeHead(code) { status = code; }, end(text) { body = String(text); } };
    servePages({ url: `/pages/${logbook}/T1/`, method: "GET", headersDistinct: { host: ["127.0.0.1:1"] } }, response, { onMac: () => true, model: { projects: [{ books: [`claude/${logbook}`] }] } });
    assert.equal(status, 200, body);
    assert.match(body, /scripted\.html\?scripts=1/);
    return body;
  } finally {
    if (saved === undefined) delete process.env.SAGE_WORKTREES;
    else process.env.SAGE_WORKTREES = saved;
    rmSync(root, { recursive: true, force: true });
  }
}

test("F-T1027-6, F-T1027-8: every page that the board, a message, a move and a pages folder serve has no comment in its HTML, its scripts or its styles, which the source scan reads as string text, also with sample logbooks", () => {
  const models = {
    empty: buildBoardModel([], { now: "2026-10-20T12:00:00Z" }),
    milestones: buildBoardModel([milestonesSource()], { now: NOW }),
    ...Object.fromEntries(Object.keys(STAGES).map((stage) => [stage, buildBoardModel([walkthroughSource(stage)], { now: WALK_NOW })])),
  };
  const message = prepareMessage(JSON.parse(readFileSync(join(ROOT, "scripts/fixtures/messages/02-question.json"), "utf8"))).msg;
  const plan = { folder: "sample-abcdef.shared", digest: "0123456789abcdef", map: { tasks: [], gates: [], milestones: [], findings: [] } };
  const pages = {
    message: messagePage(message, ""),
    "move map": mapHtml(plan, { at: "2026-10-20T12:00:00Z", backups: [], shown: (name) => name }),
  };
  for (const [name, model] of Object.entries(models)) {
    Object.assign(pages, {
      [`${name} board`]: renderBoardHtml(model, { live: true }),
      [`${name} agents`]: renderAgentsHtml(model, { live: true }),
      [`${name} releases`]: renderReleasesHtml(model, { live: true }),
      [`${name} milestones`]: renderMilestonesHtml(model, { live: true }),
    });
    for (const task of model.tasks) pages[`${name} ${task.key}`] = renderBoardHtml(model, { taskKey: task.key, live: true });
    for (const milestone of model.milestones) pages[`${name} ${milestone.key}`] = renderMilestonesHtml(model, { milestoneKey: milestone.key, live: true });
  }
  assert.ok(models.milestones.tasks.length && models.milestones.milestones.length && models.building.agents.count, "the sample logbooks hold tasks, milestones and running agents");
  for (const [name, html] of Object.entries(pages)) {
    assert.match(html, /<script>[^<]/, `${name}: the page has a script`);
    assert.deepEqual(servedComments(html), [], name);
  }
  const index = pagesIndex();
  assert.match(index, /<style>[^<]/, "the pages index has a style");
  assert.deepEqual(servedComments(index), [], "pages index");
});

function repository(files) {
  const f = folder(files);
  const git = (...args) => {
    const run = spawnSync("git", ["-C", f.dir, "-c", "user.name=Sample", "-c", "user.email=sample@example.com", ...args], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
  };
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", "sample");
  return { ...f, git };
}

const script = (name, args, cwd) => spawnSync("node", [join(ROOT, "scripts", name), ...args], { cwd, encoding: "utf8" });

function strippedAndProved(cases) {
  for (const [name, before, after] of cases) {
    assert.equal(stripped(name, before), after, JSON.stringify(before));
    assert.deepEqual(prove(name, before, after), BOTH_PASS, JSON.stringify(before));
  }
}

test("F-T1027-3: the strip keeps the final newline after a last comment line of a YAML file", () => strippedAndProved([
  ["a.yml", "a: 1\n# c\n", "a: 1\n"],
  ["a.yml", "a: |+\n  text\n# c\n\n", "a: |+\n  text\n"],
]));

test("F-T1027-9: the strip keeps the CR of a CRLF line that ends in a comment", () => strippedAndProved([
  ["a.yml", "a: 1 # c\r\nb: 2\r\n# c\r\n", "a: 1\r\nb: 2\r\n"],
  ["a.mjs", "a(); // c\r\nb();\r\n// c\r\n", "a();\r\nb();\r\n"],
]));

test("F-T1027-13: the strip reads a relative path from the current folder, and takes an absolute path as it is", () => {
  const f = repository({ "a.mjs": "a(); // why\n", "sub/b.mjs": "b(); // why\n" });
  try {
    const absolute = script("strip-comments.mjs", [join(f.dir, "a.mjs")], f.dir);
    assert.equal(absolute.stderr, "");
    assert.equal(absolute.stdout, `removed 1 comments from 1 files in ${f.dir}\n`);
    const relative = script("strip-comments.mjs", ["b.mjs"], join(f.dir, "sub"));
    assert.equal(relative.stderr, "");
    assert.equal(relative.stdout, `removed 1 comments from 1 files in ${f.dir}\n`);
    assert.deepEqual([f.read("a.mjs"), f.read("sub/b.mjs")], ["a();\n", "b();\n"]);
  } finally { f.done(); }
});

test("F-T1027-5: the strip fails by name on a path that is not there or is outside the repository, and changes no file", () => {
  const f = repository({ "a.mjs": "a(); // why\n" });
  const outside = folder({ "c.mjs": "c(); // why\n" });
  try {
    for (const [path, error] of [["no-such-path", "no-such-path: no such file or folder"], [outside.dir, `${outside.dir} is outside the repository ${f.dir}`]]) {
      const failed = script("strip-comments.mjs", [path], f.dir);
      assert.equal(failed.status, 1, failed.stdout);
      assert.equal(failed.stderr, `strip-comments: ${error}\n`);
      assert.equal(failed.stdout, "");
    }
    assert.deepEqual([f.read("a.mjs"), outside.read("c.mjs")], ["a(); // why\n", "c(); // why\n"]);
  } finally { f.done(); outside.done(); }
});

test("F-T1027-10: both scripts run through a linked folder, and the strip works in a repository reached through a link", () => {
  const f = repository({ "a.mjs": "a(); // why\n" });
  const links = folder({});
  try {
    symlinkSync(join(ROOT, "scripts"), join(links.dir, "scripts"), "dir");
    symlinkSync(f.dir, join(links.dir, "repo"), "dir");
    for (const name of ["strip-comments.mjs", "comment-proof.mjs"]) {
      const help = spawnSync("node", [join(links.dir, "scripts", name), "--help"], { encoding: "utf8" });
      assert.match(help.stdout, new RegExp(`^usage: node scripts/${name} `), name);
    }
    const run = spawnSync("node", [join(links.dir, "scripts", "strip-comments.mjs"), "a.mjs"], { cwd: join(links.dir, "repo"), encoding: "utf8" });
    assert.equal(run.stdout, `removed 1 comments from 1 files in ${f.dir}\n`, run.stderr);
    assert.equal(f.read("a.mjs"), "a();\n");
  } finally { f.done(); links.done(); }
});

test("F-T1027-14: both scripts say that they work in the git repository of the current folder, and the proof names that repository", () => {
  for (const name of ["strip-comments.mjs", "comment-proof.mjs"]) assert.match(script(name, ["--help"], ROOT).stdout, /in the git repository of the current folder/, name);
  const f = repository({ "sub/a.mjs": "a(); // why\n" });
  try {
    writeFileSync(join(f.dir, "sub/a.mjs"), "a();\n");
    const run = script("comment-proof.mjs", [], join(f.dir, "sub"));
    assert.equal(run.status, 0, run.stdout);
    assert.match(run.stdout, new RegExp(`^1 changed files from HEAD to the working tree in ${f.dir}, `, "m"));
  } finally { f.done(); }
});

test("F-T1027-15: the proof reports a file type with no proof as not proved, and the run passes", () => {
  const f = repository({ "a.mjs": "a(); // why\n", "data.json": "{}\n" });
  try {
    writeFileSync(join(f.dir, "a.mjs"), "a();\n");
    writeFileSync(join(f.dir, "data.json"), "{\"a\": 1}\n");
    const run = script("comment-proof.mjs", [], f.dir);
    assert.equal(run.status, 0, run.stdout);
    assert.equal(run.stdout.split("\n")[0], "- data.json: not proved, because no proof reads this file type");
    assert.match(run.stdout, /token proof passes for 1, canonical proof passes for 1, 1 not proved, 0 failed\n$/);
  } finally { f.done(); }
});

test("F-T1027-7: the proof fails each deleted, added and renamed file, because a strip only edits files", () => {
  const f = repository({ "a.mjs": "a(); // why\n", "gone.mjs": "g();\n", "old.yml": "a: 1\n" });
  try {
    writeFileSync(join(f.dir, "a.mjs"), "a();\n");
    f.git("rm", "-q", "gone.mjs");
    f.git("mv", "old.yml", "new.yml");
    const run = script("comment-proof.mjs", [], f.dir);
    assert.equal(run.status, 1, run.stdout);
    assert.deepEqual(run.stdout.split("\n").filter((line) => line.startsWith("✗")), ["✗ gone.mjs", "✗ new.yml", "✗ old.yml"]);
    assert.match(run.stdout, /✗ gone\.mjs\n {2}it was deleted, and a strip only removes comments\n/);
    assert.match(run.stdout, /✗ new\.yml\n {2}it was added, and a strip only removes comments\n/);
    assert.match(run.stdout, /, 3 failed\n$/);
  } finally { f.done(); }
});

test("F-T1027-4, F-T1027-12: the steps for a branch from before the sweep strip only the files that the branch changed, and run npm ci after the merge", () => {
  const text = readFileSync(join(ROOT, "CONTRIBUTING.md"), "utf8");
  const section = text.slice(text.indexOf("## A branch from before the sweep"), text.indexOf("\n## ", text.indexOf("## A branch from before the sweep") + 1));
  const commands = [...section.matchAll(/`([^`]+)`/g)].map(([, code]) => code);
  const strips = commands.filter((code) => code.includes("strip-comments.mjs"));
  assert.equal(strips.length, 2);
  for (const strip of strips) assert.match(strip, /strip-comments\.mjs \$\(git diff --name-only --diff-filter=d origin\/main\.\.\.HEAD\)$/);
  const steps = section.split("\n").filter((line) => /^\d+\. .*strip-comments\.mjs/.test(line));
  assert.equal(steps.length, 2);
  for (const step of steps) assert.match(step, /If `git diff --name-only --diff-filter=d origin\/main\.\.\.HEAD` lists no file, skip to step \d+\./, step);
  const merge = commands.indexOf("git merge origin/main"), install = commands.indexOf("npm ci", merge);
  assert.ok(merge >= 0 && install > merge && install < commands.indexOf(strips[1]), commands.join("\n"));
});

test("F-T1027-16: a comment on the header line of a run block goes once, and the shell lines after it stay", () => {
  const before = "a:\n  run: | # head comment\n    echo hi\n    npm test\n";
  const f = repository({ "a.yml": before });
  try {
    const run = script("strip-comments.mjs", ["a.yml"], f.dir);
    assert.equal(run.stdout, `removed 1 comments from 1 files in ${f.dir}\n`, run.stderr);
    assert.equal(f.read("a.yml"), "a:\n  run: |\n    echo hi\n    npm test\n");
    assert.deepEqual(prove("a.yml", before, f.read("a.yml")), BOTH_PASS);
  } finally { f.done(); }
});

test("F-T1027-17: the strip of a repository with no sgconfig.yml uses the rule set beside the script, and a repository's own sgconfig.yml wins", () => {
  const f = repository({ "a.mjs": "a(); // why\n", ".github/w.yml": "on: push # why\njobs:\n  a:\n    steps:\n      - run: |\n          npm test # why\n" });
  try {
    assert.equal(existsSync(join(f.dir, "sgconfig.yml")), false);
    const run = script("strip-comments.mjs", ["."], f.dir);
    assert.equal(run.stderr, "");
    assert.equal(run.stdout, `removed 3 comments from 2 files in ${f.dir}\n`);
    assert.deepEqual([f.read("a.mjs"), f.read(".github/w.yml")], ["a();\n", "on: push\njobs:\n  a:\n    steps:\n      - run: |\n          npm test\n"]);
  } finally { f.done(); }
  const own = repository({ "a.mjs": "a(); // why\n", "a.yml": "a: 1 # why\n", "lint/rules/no-comments-js.yml": readFileSync(join(RULE_SET, "rules", "no-comments-js.yml"), "utf8"), "sgconfig.yml": `ruleDirs: [lint/rules]\nutilDirs: [${JSON.stringify(join(RULE_SET, "utils"))}]\n` });
  try {
    assert.equal(script("strip-comments.mjs", ["a.mjs", "a.yml"], own.dir).stdout, `removed 1 comments from 1 files in ${own.dir}\n`);
    assert.deepEqual([own.read("a.mjs"), own.read("a.yml")], ["a();\n", "a: 1 # why\n"]);
  } finally { own.done(); }
});

test("F-T1027-18: the proof fails a workflow whose run block lost a shell comment, and each step that runs the proof says to check that file by hand", () => {
  const f = repository({ "w.yml": "steps:\n  - run: |\n      npm test # why\n" });
  try {
    script("strip-comments.mjs", ["w.yml"], f.dir);
    assert.equal(f.read("w.yml"), "steps:\n  - run: |\n      npm test\n");
    const proof = script("comment-proof.mjs", [], f.dir);
    assert.equal(proof.status, 1, proof.stdout);
    assert.match(proof.stdout, /^✗ w\.yml$/m);
  } finally { f.done(); }
  const steps = ["CONTRIBUTING.md", "packages/sage-core/lint/README.md"].flatMap((file) => readFileSync(join(ROOT, file), "utf8").split("\n").filter((line) => /^\d+\. .*comment-proof\.mjs/.test(line)));
  assert.equal(steps.length, 3);
  for (const step of steps) assert.match(step, /`run:` block .*by hand/, step);
});

test("F-T1027-22: the strip keeps the CR of a CRLF line that ends in a shell comment of a run block", () => {
  assert.equal(stripped("w.yml", "steps:\r\n  - run: |\r\n      npm ci # why\r\n      npm test\r\n"), "steps:\r\n  - run: |\r\n      npm ci\r\n      npm test\r\n");
});

test("F-T1027-21: the strip skips a named file that .gitattributes marks generated or vendored, as the scan of a folder does, and says which", () => {
  const f = repository({ "plugins/sage/a.mjs": "a(); // built\n", "scripts/fixtures/sage-14c0d0c/b.mjs": "b(); // test data\n", "scripts/c.mjs": "c(); // why\n", "d.mjs": "d(); // why\n" });
  try {
    const run = script("strip-comments.mjs", ["plugins/sage/a.mjs", "scripts/fixtures/sage-14c0d0c/b.mjs", "scripts/c.mjs"], f.dir);
    assert.equal(run.stderr, "");
    assert.equal(run.stdout, [
      "skipped plugins/sage/a.mjs: .gitattributes marks it linguist-generated or linguist-vendored",
      "skipped scripts/fixtures/sage-14c0d0c/b.mjs: .gitattributes marks it linguist-generated or linguist-vendored",
      `removed 1 comments from 1 files in ${f.dir}`,
      "",
    ].join("\n"));
    const only = script("strip-comments.mjs", ["plugins/sage/a.mjs"], f.dir);
    assert.match(only.stdout, new RegExp(`removed 0 comments from 0 files in ${f.dir}\n$`));
    assert.deepEqual(["plugins/sage/a.mjs", "scripts/fixtures/sage-14c0d0c/b.mjs", "scripts/c.mjs", "d.mjs"].map(f.read), ["a(); // built\n", "b(); // test data\n", "c();\n", "d(); // why\n"]);
  } finally { f.done(); }
});

test("F-T1027-26: the strip in a folder that is not in a git repository fails by name and changes no file", () => {
  const f = folder({ "scripts/a.mjs": "a(); // why\n" });
  try {
    const run = script("strip-comments.mjs", [], f.dir);
    assert.equal(run.status, 1, run.stdout);
    assert.equal(run.stderr, `strip-comments: ${f.dir} is not in a git repository; run the strip in your checkout\n`);
    assert.equal(run.stdout, "");
    assert.equal(f.read("scripts/a.mjs"), "a(); // why\n");
  } finally { f.done(); }
});
