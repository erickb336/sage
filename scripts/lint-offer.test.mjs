import "./test-env.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { AST_GREP, RULE_SET } from "./lint-rules.mjs";
import { missingBriefFields } from "../packages/sage-core/brief.mjs";
import { AST_GREP_VERSION, astGrepScan } from "../packages/sage-core/lint.mjs";

const TOOL = fileURLToPath(new URL("../plugins/sage/skills/sage/sage.mjs", import.meta.url));
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const LANGUAGES = JSON.parse(readFileSync(join(RULE_SET, "languages.json"), "utf8"));
const JS = { "src/a.js": "export const a = 1;\n", "src/b.mjs": "export const b = 2;\n" };
const PY = { "app/main.py": "print(1)\n" };
const DOCS = { "README.md": "# A\n", "data.json": "{}\n", ".env": "A=1\n", "vendor/lib.rb": "x = 1\n", ".gitattributes": "vendor/** linguist-vendored\n" };

function project(files, { binary = "none" } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "sage-lint-offer-")));
  const folder = join(dir, "project");
  mkdirSync(folder);
  const env = { ...process.env, HOME: join(dir, "home"), SAGE_HOME: join(dir, "sage") };
  const git = (...args) => {
    const r = spawnSync("git", ["-C", folder, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8", env });
    assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const commit = (more) => {
    for (const [path, text] of Object.entries(more)) {
      mkdirSync(dirname(join(folder, path)), { recursive: true });
      writeFileSync(join(folder, path), text);
    }
    git("add", "-A");
    git("commit", "-q", "--allow-empty", "-m", "change");
    return git("rev-parse", "HEAD");
  };
  git("init", "-q", "-b", "main");
  const base = commit({ ".gitignore": "node_modules/\n", ...files });
  git("update-ref", "refs/remotes/origin/main", base);
  const sage = (...args) => spawnSync("node", [TOOL, ...args, "--project", folder], { encoding: "utf8", env });
  const ok = (...args) => {
    const r = sage(...args);
    assert.equal(r.status, 0, `sage ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  ok("init");
  ok("task", "add", "--priority", "P2", "--title", "a change", "--size", "tiny");
  const logbook = ok("logbook");
  const tools = join(dirname(logbook), "tools");
  if (binary === "project") {
    mkdirSync(join(folder, "node_modules", ".bin"), { recursive: true });
    symlinkSync(AST_GREP, join(folder, "node_modules", ".bin", "ast-grep"));
  }
  const sha = commit({ "src/c.js": "f();\n" });
  const lint = () => ok("lint", "T1", "--sha", sha);
  const table = (name) => {
    const [head, ...rows] = readFileSync(join(logbook, `${name}.tsv`), "utf8").split("\n").filter(Boolean).map((row) => row.split("\t"));
    return rows.map((row) => Object.fromEntries(head.map((key, i) => [key, row[i] ?? ""])));
  };
  const offers = () => table("gates").filter((g) => g.kind === "lint");
  const backdate = (id) => {
    const file = join(logbook, "gates.tsv"), lines = readFileSync(file, "utf8").split("\n"), at = lines[0].split("\t").indexOf("at");
    writeFileSync(file, lines.map((line) => (line.startsWith(`${id}\t`) ? line.split("\t").map((cell, i) => (i === at ? "2020-01-01T00:00:00Z" : cell)).join("\t") : line)).join("\n"));
  };
  return { folder, base, sha, ok, sage, lint, offers, table, backdate, tools, logbook, env };
}

const NOTE = /^T1 · \S+: origin\/main \S+ has no sgconfig\.yml at its root, so there is nothing to lint, and the merge check needs no lint verdict\./;
const answer = (p, id, option) => p.ok("gate", "answer", id, "--option", String(option));

test("lint on a project with no sgconfig.yml gives the note and opens one lint offer gate; a second lint names the open gate and opens no other", () => {
  const p = project(JS);
  const out = p.lint();
  assert.match(out, NOTE);
  assert.match(out, /\nG1 open · Add sage's no-comments lint rules to this project, for JavaScript\? A yes frames one small task that adds them through a pull request, and then the merge check needs lint-pass\. The same yes installs ast-grep 0\.51\.1 in sage's tools folder, from the lockfile that sage pins\.\nAsk the owner to answer G1: add the rules, not now, never for this project\.$/);
  assert.deepEqual(p.offers().map((g) => [g.id, g.options, g.recommendation, g.default, g.answer]), [["G1", "add the rules|not now|never for this project", "add the rules", "not now", ""]]);
  assert.match(p.lint(), /lint verdict\. Nothing changed\. The offer of sage's lint rules waits in G1 for the owner\.$/);
  assert.equal(p.offers().length, 1);
  assert.equal(p.table("ledger").length, 0, "the offer writes no lint verdict");
});

test("with ast-grep at the pin in the project, the offer does not name an install", () => {
  const p = project(JS, { binary: "project" });
  assert.doesNotMatch(p.lint(), /installs ast-grep/);
  assert.equal(p.offers().length, 1);
});

test("never stops the offer, the config shows it, and lint_offer=ask brings the offer back", () => {
  const p = project(JS);
  p.lint();
  assert.equal(answer(p, "G1", 3), "G1 answered · never for this project");
  assert.match(p.lint(), new RegExp(`${NOTE.source} Nothing changed\\.$`));
  p.backdate("G1");
  assert.match(p.lint(), / Nothing changed\.$/, "never holds after 30 days too");
  assert.equal(p.offers().length, 1);
  assert.equal(p.ok("config", "name=x"), "name=x archived=no start=normal lint_offer=never");
  assert.equal(p.ok("config", "lint_offer=ask"), "name=x archived=no start=normal");
  assert.match(p.lint(), /\nG2 open · Add sage's no-comments lint rules/);
  assert.equal(p.sage("config", "lint_offer=later").status, 1);
});

test("not now keeps the offer quiet for 30 days, then the offer comes back; an offer answers once", () => {
  const p = project(JS);
  p.lint();
  assert.equal(answer(p, "G1", 2), "G1 answered · not now");
  assert.match(p.lint(), / Nothing changed\.$/);
  assert.equal(p.offers().length, 1);
  assert.match(p.sage("gate", "answer", "G1", "--option", "1").stderr, /G1 has the answer "not now" already, from the chat at \S+: the first answer wins, so this answer is not recorded\. Nothing changed\./);
  assert.equal(p.table("tasks").length, 1, "a refused second answer frames no task");
  p.backdate("G1");
  assert.match(p.lint(), /\nG2 open · /);
});

test("add the rules frames one small task, writes its brief with the detected languages, and gives the install command with the pinned lockfile", () => {
  const p = project({ ...JS, ...PY, ...DOCS });
  assert.match(p.lint(), /for JavaScript and Python\?/);
  const out = answer(p, "G1", 1);
  const lines = out.split("\n");
  assert.equal(lines[0], "G1 answered · add the rules");
  assert.match(lines[1], /^T2 framed · small · route build,code-review,qa · P2 · its brief: (\S+\/T2\/brief\.md)$/);
  assert.equal(lines[2], `The owner's yes covers the install of ast-grep ${AST_GREP_VERSION} in sage's tools folder, from the lockfile that sage pins. Run it before the build: npm ci --ignore-scripts --prefix ${p.tools}`);
  assert.deepEqual(p.table("tasks").find((t) => t.id === "T2")?.title, "Add the no-comments lint rules for JavaScript and Python");
  for (const name of ["package.json", "package-lock.json"]) assert.equal(readFileSync(join(p.tools, name), "utf8"), readFileSync(join(RULE_SET, "tools", name), "utf8"), name);
  const brief = readFileSync(/its brief: (\S+)$/.exec(lines[1])[1], "utf8");
  assert.deepEqual(missingBriefFields(brief), []);
  assert.match(brief, /^GOAL {8}Add sage's no-comments lint rules to this project for its languages, JavaScript and Python, and open a pull request against main\.$/m);
  assert.match(brief, /^ {14}- JavaScript \(2 files\): copy rules\/no-comments-js\.yml and rule-tests\/no-comments-js-test\.yml\.$/m);
  assert.match(brief, /^ {14}- Python \(1 file\): sage has no rule for it yet: write rules\/no-comments-python\.yml and rule-tests\/no-comments-python-test\.yml, as the README says\.$/m);
  assert.match(brief, /Linter settings that require comments, to look for: JavaScript: ESLint: jsdoc\/require-jsdoc .*; Python: Ruff: the D1 rules \(D100 to D107\)\./);
  assert.match(brief, new RegExp(`ast-grep ${AST_GREP_VERSION.replaceAll(".", "\\.")}: ${p.tools}/node_modules/\\.bin/ast-grep\\.`));
  assert.doesNotMatch(brief, /Ruby|Bash|Json|Markdown/, "a vendored file, a dotfile with no extension, JSON and Markdown add no language");
});

test("the offer detects each project's own languages: a JavaScript project, a Python project and a project with both", () => {
  const ask = (files) => /for (.*)\? A yes/.exec(project(files).lint())?.[1];
  assert.equal(ask({ ...JS, ...DOCS }), "JavaScript");
  assert.equal(ask({ ...PY, "tools/build.bzl": "x = 1\n", ...DOCS }), "Python");
  assert.equal(ask({ ...JS, ...PY, "ci.yml": "a: 1\n" }), "JavaScript, Python and Yaml");
  const none = project(DOCS);
  assert.match(none.lint(), new RegExp(`${NOTE.source} Nothing changed\\.$`), "a project with no language of a rule gets no offer");
  assert.equal(none.offers().length, 0);
});

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

test("each rule that languages.json names has its rule and rule test, and the README's adopt table lists each language with a rule or a setting", () => {
  for (const { rules = [] } of Object.values(LANGUAGES)) for (const id of rules) {
    assert.match(readFileSync(join(RULE_SET, "rules", `${id}.yml`), "utf8"), new RegExp(`^id: ${id}$`, "m"));
    assert.match(readFileSync(join(RULE_SET, "rule-tests", `${id}-test.yml`), "utf8"), new RegExp(`^id: ${id}$`, "m"));
  }
  const readme = readFileSync(join(RULE_SET, "README.md"), "utf8");
  const section = readme.slice(readme.indexOf("## Adopt the rules"), readme.indexOf("\n## ", readme.indexOf("## Adopt the rules") + 1));
  const rows = section.split("\n").filter((line) => /^\| [A-Z]/.test(line) && !line.startsWith("| Language")).map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()));
  const want = Object.entries(LANGUAGES).filter(([, l]) => l.rules || l.settings).map(([name, l]) => [name, (l.rules ?? []).map((r) => `\`${r}\``).join(", ") || "none yet", (l.settings ?? []).join("; ") || "none"]);
  assert.deepEqual(rows, want);
});
