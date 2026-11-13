import "./test-env.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { AST_GREP, RULE_SET } from "./lint-rules.mjs";
import { leadProblem, leadRequest } from "../packages/sage-core/lead-policy.mjs";
import { AST_GREP_VERSION, LINT_MAX_BYTES } from "../packages/sage-core/lint.mjs";

const TOOL = fileURLToPath(new URL("../plugins/sage/skills/sage/sage.mjs", import.meta.url));
const SUPPRESSION = ["ast-grep", "ignore"].join("-");
const STALE = "0.50.0";
const MESSAGE = "Remove this comment, or write a directive from the list in the rule set's README.md with no text after it.";
const BASE = {
  ".gitignore": "node_modules/\n",
  "a.js": "const a = 1; // an old comment\nconst b = 2;\n",
  "old.js": "// a block that moves\nconst c = 3;\n",
  "doc.md": "# Doc\n",
};
const CONFIG = "ruleDirs: [lint/rules]\nutilDirs: [lint/utils]\n";
const RULE_FILES = Object.fromEntries(["rules", "utils"].flatMap((part) => readdirSync(join(RULE_SET, part)).map((name) => [`lint/${part}/${name}`, readFileSync(join(RULE_SET, part, name), "utf8")])));
const rule = (id, severity, kind = "comment") => `id: ${id}\nlanguage: JavaScript\nseverity: ${severity}\nmessage: ${id}\nrule: { kind: ${kind} }\n`;

function project({ config = true, binary = "project" } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "sage-lint-command-")));
  const folder = join(dir, "project");
  mkdirSync(folder);
  const env = { ...process.env, HOME: join(dir, "home"), SAGE_HOME: join(dir, "sage") };
  const git = (...args) => {
    const r = spawnSync("git", ["-C", folder, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8", env });
    assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const commit = (files) => {
    for (const [path, text] of Object.entries(files)) {
      const full = join(folder, path);
      rmSync(full, { force: true });
      if (text === null) continue;
      mkdirSync(dirname(full), { recursive: true });
      if (typeof text === "object" && !Buffer.isBuffer(text)) symlinkSync(text.link, full);
      else writeFileSync(full, text);
    }
    git("add", "-A");
    git("commit", "-q", "--allow-empty", "-m", "change");
    return git("rev-parse", "HEAD");
  };
  git("init", "-q", "-b", "main");
  if (config) for (const part of ["rules", "utils"]) cpSync(join(RULE_SET, part), join(folder, "lint", part), { recursive: true });
  const base = commit({ ...BASE, ".gitattributes": "gen/** linguist-generated=true\n", ...(config && { "sgconfig.yml": CONFIG }) });
  git("update-ref", "refs/remotes/origin/main", base);
  git("checkout", "-q", "-b", "sage/t1-change");
  const sageAt = (at, ...args) => spawnSync("node", [TOOL, ...args, "--project", at], { encoding: "utf8", env });
  const sage = (...args) => sageAt(folder, ...args);
  const onMain = (files) => {
    git("checkout", "-q", "main");
    const sha = commit(files);
    git("update-ref", "refs/remotes/origin/main", sha);
    git("checkout", "-q", "-B", "sage/t1-change", "main");
    return sha;
  };
  const ok = (...args) => {
    const r = sage(...args);
    assert.equal(r.status, 0, `sage ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  ok("init");
  ok("task", "add", "--priority", "P2", "--title", "a change", "--size", "tiny");
  const logbook = ok("logbook");
  const tools = join(dirname(logbook), "tools", "node_modules", ".bin");
  const place = (where, path) => {
    mkdirSync(where, { recursive: true });
    symlinkSync(path, join(where, "ast-grep"));
  };
  if (binary === "project") place(join(folder, "node_modules", ".bin"), AST_GREP);
  if (binary === "tools") place(tools, AST_GREP);
  const lints = () => readFileSync(join(logbook, "ledger.tsv"), "utf8").split("\n").filter((row) => /\tlint-(pass|fail)\t/.test(row)).map((row) => row.split("\t").slice(0, 4).join(" "));
  return { folder, base, git, commit, sage, sageAt, ok, onMain, lints, place, tools, env };
}

const lint = (p, sha) => p.ok("lint", "T1", "--sha", sha);
const problems = (out) => out.split("\n").slice(1).filter((line) => !line.startsWith("  not checked:")).map((line) => line.trim());
const notChecked = (out) => /^ {2}not checked: (.*)$/m.exec(out)?.[1] ?? "";

test("lint writes lint-pass on a clean change, and lint-fail with file:line and the rule's message on a change that adds a comment", () => {
  const p = project();
  const clean = p.commit({ "a.js": "const a = 1; // an old comment\nconst b = 3;\n", "new.js": "export const d = 4;\n" });
  const out = lint(p, clean);
  assert.match(out, new RegExp(`^T1 lint-pass · ${clean.slice(0, 7)} · rules ${p.base.slice(0, 7)} · diff from ${p.base.slice(0, 7)} · 2 files checked$`), "an edit next to an old comment does not flag the old comment");
  const dirty = p.commit({ "new.js": "export const d = 4;\nexport const e = 5; // why\n" });
  const fail = lint(p, dirty);
  assert.match(fail, /^T1 lint-fail · \S+ · rules \S+ · diff from \S+ · 2 files checked · 1 problem$/m, "the change is the whole pull request since its base");
  assert.deepEqual(problems(fail), [`new.js:2: ${MESSAGE} (no-comments-js, error)`]);
  assert.deepEqual(p.lints(), [`T1  ${clean} lint-pass`, `T1  ${dirty} lint-fail`]);
});

test("an old trailing comment on an edited line fails, and so does a comment block that moved to another file", () => {
  const p = project();
  const sha = p.commit({ "a.js": "const a = 10; // an old comment\nconst b = 2;\n// a block that moves\n", "old.js": "const c = 3;\n" });
  assert.deepEqual(problems(lint(p, sha)), [`a.js:1: ${MESSAGE} (no-comments-js, error)`, `a.js:3: ${MESSAGE} (no-comments-js, error)`]);
});

test("a renamed file has every line checked under the rules of its new path: a pure rename with no match passes, an old comment in it fails, and a comment on an unchanged line passes", () => {
  const p = project();
  p.onMain({ "plain.js": "export const p = 1;\n" });
  const clean = p.commit({ "plain.js": null, "lib/plain.js": "export const p = 1;\n", "a.js": "const a = 1; // an old comment\nconst b = 2;\nconst n = 5;\n" });
  assert.match(lint(p, clean), /^T1 lint-pass · \S+ · rules \S+ · diff from \S+ · 2 files checked$/);
  const moved = p.commit({ "old.js": null, "lib/old.js": BASE["old.js"] });
  assert.deepEqual(problems(lint(p, moved)), [`lib/old.js:1: ${MESSAGE} (no-comments-js, error)`]);
});

test("F-T1019-16: a file renamed into another language has its old lines checked by the rules of the new language", () => {
  const p = project();
  p.onMain({ "lint/rules/ts-comment.yml": "id: ts-comment\nlanguage: TypeScript\nseverity: error\nmessage: ts-comment\nrule: { kind: comment }\n" });
  const sha = p.commit({ "old.js": null, "old.ts": BASE["old.js"] });
  assert.deepEqual(problems(lint(p, sha)), ["old.ts:1: ts-comment (ts-comment, error)"]);
});

test("F-T1019-17: a file renamed into the files of a stricter rule has its old lines checked by that rule", () => {
  const p = project();
  const text = "export function f() {\n  debugger;\n}\n";
  p.onMain({ "lint/rules/src-debugger.yml": "id: src-debugger\nlanguage: JavaScript\nseverity: error\nmessage: src-debugger\nfiles: [\"src/**\"]\nrule: { kind: debugger_statement }\n", "scripts/tool.js": text });
  const sha = p.commit({ "scripts/tool.js": null, "src/tool.js": text });
  assert.deepEqual(problems(lint(p, sha)), ["src/tool.js:2: src-debugger (src-debugger, error)"]);
});

test("a pull request that edits sgconfig.yml or a rule at its head is still checked by the rules of origin/main", () => {
  const p = project();
  const sha = p.commit({
    "sgconfig.yml": "ruleDirs: [empty]\n",
    "empty/none.yml": "id: none\nlanguage: JavaScript\nseverity: off\nmessage: none\nrule: { kind: comment }\n",
    "lint/rules/no-comments-js.yml": "id: no-comments-js\nlanguage: JavaScript\nseverity: off\nmessage: off\nrule: { kind: comment }\n",
    ".gitattributes": "*.js linguist-generated=true\n",
    "b.js": "f(); // why\n",
  });
  const out = lint(p, sha);
  assert.match(out, /^T1 lint-fail /);
  assert.ok(problems(out).includes(`b.js:1: ${MESSAGE} (no-comments-js, error)`), out);
});

test("a changed file that holds ast-grep's suppression comment fails as a whole file, also when the suppression is on a line that the change does not touch", () => {
  const p = project({});
  p.git("checkout", "-q", "main");
  const base = p.commit({ "s.js": `// ${SUPPRESSION}\n\nconst s = 1;\n` });
  p.git("update-ref", "refs/remotes/origin/main", base);
  p.git("checkout", "-q", "-B", "sage/t1-change");
  const sha = p.commit({ "s.js": `// ${SUPPRESSION}\n\nconst s = 1;\nconst t = 2; // why\n` });
  assert.deepEqual(problems(lint(p, sha)), [`s.js: it holds ${SUPPRESSION}, which hides lines from the rules, so the whole file fails. Remove it.`]);
  const line = p.commit({ "u.js": `const u = 1; // ${SUPPRESSION}\n` });
  assert.ok(problems(lint(p, line)).some((l) => l.startsWith(`u.js: it holds ${SUPPRESSION}`)), "a trailing suppression hides its own line from the scan, so the text check catches it");
});

test("F-T1019-1: a file that ast-grep skips (not UTF-8) fails and is named", () => {
  const p = project();
  const sha = p.commit({ "bad.js": Buffer.from([0xff, 0xfe, 0x0a, 0x2f, 0x2f, 0x20, 0x78, 0x0a]) });
  const out = lint(p, sha);
  assert.match(out, /^T1 lint-fail /);
  assert.deepEqual(problems(out), ["bad.js: ast-grep skipped this file (invalidUtf8), so no rule checked it. Save it as UTF-8, or mark it linguist-generated or linguist-vendored in the .gitattributes of origin/main."]);
});

test("F-T1019-2: a hidden folder and a path that starts with - are checked; a file with no language, a symlink, and a file generated in the base are listed as not checked", () => {
  const p = project();
  const sha = p.commit({
    ".github/workflows/x.yml": "on: push # why\n",
    "-x.js": "f(); // why\n",
    "--off": "f(); // why\n",
    "tool": "#!/usr/bin/env node\n// why\n",
    "link.js": { link: "a.js" },
    "gen/out.js": "f(); // generated\n",
    "doc.md": "# Doc\n<!-- why -->\n",
  });
  const out = lint(p, sha);
  assert.deepEqual(problems(out), [`-x.js:1: ${MESSAGE} (no-comments-js, error)`, `.github/workflows/x.yml:1: ${MESSAGE} (no-comments-yaml, error)`]);
  assert.equal(notChecked(out), "--off (no language of ast-grep), doc.md (no rule of sgconfig.yml for Markdown), gen/out.js (linguist-generated in the .gitattributes of origin/main), link.js (a symbolic link: it holds a path, not code), tool (no language of ast-grep)");
});

test("a .ignore file at the head hides no changed file from the scan", () => {
  const p = project();
  const sha = p.commit({ ".ignore": "*\n", "c.js": "f(); // why\n" });
  assert.deepEqual(problems(lint(p, sha)), [`c.js:1: ${MESSAGE} (no-comments-js, error)`]);
});

test("lint finds ast-grep in the project's node_modules only at the pinned version, then in sage's tools folder; with neither, it refuses with the install command and writes no verdict", () => {
  const p = project({ binary: "none" });
  const sha = p.commit({ "c.js": "f();\n" });
  const fake = join(dirname(p.folder), "old-ast-grep");
  writeFileSync(fake, `#!/bin/sh\necho 'ast-grep ${STALE}'\n`, { mode: 0o755 });
  p.place(join(p.folder, "node_modules", ".bin"), fake);
  const r = p.sage("lint", "T1", "--sha", sha);
  assert.equal(r.status, 1);
  assert.match(r.stderr.trim(), new RegExp(`ast-grep ${AST_GREP_VERSION.replaceAll(".", "\\.")} is not in .* or in sage's tools folder .*, so lint cannot run, and it writes no verdict\\. Install it in the tools folder: npm install --prefix \\S+ @ast-grep/cli@${AST_GREP_VERSION.replaceAll(".", "\\.")}$`));
  assert.deepEqual(p.lints(), []);
  p.place(p.tools, AST_GREP);
  assert.match(lint(p, sha), /^T1 lint-pass /, "the tools folder's ast-grep runs");
});

test("a repository whose origin/main has no sgconfig.yml gets a note and no lint verdict, and its merge check needs none", () => {
  const p = project({ config: false });
  const sha = p.commit({ "c.js": "f(); // why\n" });
  assert.match(lint(p, sha), /^T1 · \S+: origin\/main \S+ has no sgconfig\.yml at its root, so there is nothing to lint, and the merge check needs no lint verdict\. Nothing changed\.$/);
  assert.deepEqual(p.lints(), []);
  p.ok("verdict", "T1", "--sha", sha, "--kind", "checks-pass");
  assert.match(p.ok("merge-check", "--sha", sha), /^T1 may merge/);
});

test("verdict refuses lint-pass and lint-fail; the merge check refuses a SHA without lint-pass when the base has sgconfig.yml, and after lint-fail", () => {
  const p = project();
  const clean = p.commit({ "c.js": "f();\n" });
  for (const kind of ["lint-pass", "lint-fail"]) {
    const r = p.sage("verdict", "T1", "--sha", clean, "--kind", kind);
    assert.equal(r.status, 1);
    assert.match(r.stderr, new RegExp(`${kind} comes only from the lint command`));
  }
  p.ok("verdict", "T1", "--sha", clean, "--kind", "checks-pass");
  const before = p.sage("merge-check", "--sha", clean);
  assert.equal(before.status, 1);
  assert.match(before.stderr, new RegExp(`T1: no lint-pass on this SHA, and origin/main ${p.base.slice(0, 7)} has a root sgconfig\\.yml\\. Run sage lint T1 --sha <sha> on it\\.`));
  lint(p, clean);
  assert.match(p.ok("merge-check", "--sha", clean), /^T1 may merge/);
  const dirty = p.commit({ "c.js": "f(); // why\n" });
  p.ok("verdict", "T1", "--sha", dirty, "--kind", "checks-pass");
  lint(p, dirty);
  const after = p.sage("merge-check", "--sha", dirty);
  assert.equal(after.status, 1);
  assert.match(after.stderr, /T1: lint-fail on this SHA, and origin\/main \S+ has a root sgconfig\.yml\. Fix the lines that lint named in a new commit/);
});

test("F-T1019-6: the merge check reads no head commit when origin/main has no sgconfig.yml, and a folder that is no git checkout but holds sgconfig.yml refuses", () => {
  const p = project({ config: false });
  const sha = p.commit({ "c.js": "f();\n" });
  p.ok("verdict", "T1", "--sha", sha, "--kind", "checks-pass");
  p.git("checkout", "-q", "main");
  p.git("branch", "-D", "sage/t1-change");
  p.git("reflog", "expire", "--expire=now", "--all");
  p.git("gc", "-q", "--prune=now");
  assert.match(p.ok("merge-check", "--sha", sha), /^T1 may merge/);
  const q = project();
  const head = q.commit({ "c.js": "f();\n" });
  q.ok("verdict", "T1", "--sha", head, "--kind", "checks-pass");
  renameSync(join(q.folder, ".git"), join(dirname(q.folder), "git-aside"));
  const r = q.sage("merge-check", "--sha", head);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /T1: \S+ has a root sgconfig\.yml but no origin\/main/);
});

test("F-T1019-5: a file that becomes a symbolic link is not checked, and a symbolic link or a submodule that becomes a file has every line checked", () => {
  const p = project();
  p.onMain({ "l.js": { link: "a.js" } });
  p.git("checkout", "-q", "main");
  p.git("update-index", "--add", "--cacheinfo", `160000,${p.base},m.js`);
  p.git("commit", "-q", "-m", "a submodule");
  p.git("update-ref", "refs/remotes/origin/main", "main");
  p.git("checkout", "-q", "-B", "sage/t1-change", "main");
  p.git("rm", "-q", "--cached", "m.js");
  const sha = p.commit({ "old.js": { link: "a.js" }, "l.js": "f();\n// why\n", "m.js": "g();\n// why\n" });
  const out = lint(p, sha);
  assert.match(out, /^T1 lint-fail /);
  assert.deepEqual(problems(out), [`l.js:2: ${MESSAGE} (no-comments-js, error)`, `m.js:2: ${MESSAGE} (no-comments-js, error)`]);
  assert.equal(notChecked(out), "old.js (a symbolic link: it holds a path, not code)");
});

test("F-T1019-10: lint and the merge check run from a subfolder of the checkout read the root sgconfig.yml", () => {
  const p = project();
  const sha = p.commit({ "sub/keep.txt": "x\n", "b.js": "f(); // why\n" });
  const sub = join(p.folder, "sub");
  const out = p.sageAt(sub, "lint", "T1", "--sha", sha);
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(problems(out.stdout.trim()), [`b.js:1: ${MESSAGE} (no-comments-js, error)`]);
  assert.equal(p.sageAt(sub, "verdict", "T1", "--sha", sha, "--kind", "checks-pass").status, 0);
  const check = p.sageAt(sub, "merge-check", "--sha", sha);
  assert.equal(check.status, 1);
  assert.match(check.stderr, /T1: lint-fail on this SHA, and origin\/main \S+ has a root sgconfig\.yml/);
});

test("F-T1019-11: the rules come from the tip of origin/main, also when the branch started before main had them, and the added lines from the merge base", () => {
  const p = project({ config: false });
  const sha = p.commit({ "b.js": "f(); // why\n" });
  p.git("checkout", "-q", "main");
  const main = p.commit({ ...RULE_FILES, "sgconfig.yml": CONFIG, "m.js": "g(); // on main\n" });
  p.git("update-ref", "refs/remotes/origin/main", main);
  p.ok("verdict", "T1", "--sha", sha, "--kind", "checks-pass");
  const before = p.sage("merge-check", "--sha", sha);
  assert.equal(before.status, 1);
  assert.match(before.stderr, new RegExp(`T1: no lint-pass on this SHA, and origin/main ${main.slice(0, 7)} has a root sgconfig\\.yml`));
  const out = lint(p, sha);
  assert.match(out, new RegExp(`^T1 lint-fail · ${sha.slice(0, 7)} · rules ${main.slice(0, 7)} · diff from ${p.base.slice(0, 7)} · 1 file checked · 1 problem$`, "m"));
  assert.deepEqual(problems(out), [`b.js:1: ${MESSAGE} (no-comments-js, error)`]);
});

test("F-T1019-12: a file renamed from a path that no rule checked has every line checked", () => {
  const p = project();
  const text = "// a comment that no rule checked\nexport const v = 1;\n";
  p.onMain({ "notes.txt": text, "vendor/lib.js": text, "types.ts": text, ".gitattributes": "gen/** linguist-generated=true\nvendor/** linguist-vendored=true\n" });
  const sha = p.commit({ "notes.txt": null, "src/notes.js": text, "vendor/lib.js": null, "src/lib.js": text, "types.ts": null, "src/types.js": text });
  assert.deepEqual(problems(lint(p, sha)), ["src/lib.js", "src/notes.js", "src/types.js"].map((file) => `${file}:1: ${MESSAGE} (no-comments-js, error)`));
});

test("F-T1019-14: a large asset with no rule is listed and not read, and a file too large to scan fails by name", () => {
  const p = project();
  p.onMain({ "model.bin": randomBytes(17 * 1024 * 1024) });
  const sha = p.commit({ "model.bin": randomBytes(17 * 1024 * 1024), "c.js": "f();\n" });
  const out = lint(p, sha);
  assert.match(out, /^T1 lint-pass · .* · 1 file checked$/m);
  assert.equal(notChecked(out), "model.bin (no language of ast-grep)");
  const big = p.commit({ "big.js": "f();\n".repeat(Math.ceil((LINT_MAX_BYTES * 1.2) / 5)) });
  const fail = lint(p, big);
  assert.match(fail, /^T1 lint-fail /);
  assert.deepEqual(problems(fail), ["big.js: it is 12 MiB, more than the 10 MiB that lint scans, so no rule checked it. Split it into smaller files, or mark it linguist-generated or linguist-vendored in the .gitattributes of origin/main."]);
});

test("F-T1019-7: a missing head, a broken rule and a broken sgconfig.yml each name their own next step", () => {
  const p = project();
  const refused = (sha) => {
    const r = p.sage("lint", "T1", "--sha", sha);
    assert.equal(r.status, 1);
    return r.stderr.trim();
  };
  assert.match(refused("1".repeat(40)), /Fetch the head/);
  p.onMain({ "lint/rules/broken.yml": rule("broken", "error", "no_such_kind") });
  const rules = refused(p.commit({ "c.js": "f();\n" }));
  assert.match(rules, /Fix the rule or sgconfig\.yml on origin\/main that the message names, then lint again\. Nothing changed\.$/);
  assert.doesNotMatch(rules, /fetch/i);
  p.onMain({ "lint/rules/broken.yml": null, "sgconfig.yml": { link: "lint/sg.yml" }, "lint/sg.yml": CONFIG });
  const config = refused(p.commit({ "c.js": "g();\n" }));
  assert.match(config, /sgconfig\.yml at the root of origin\/main \S+ is not a regular file\. Fix sgconfig\.yml and the rules on origin\/main, then lint again\. Nothing changed\.$/);
  assert.deepEqual(p.lints(), []);
});

test("F-T1019-8: a match of a rule at warning, info or hint severity fails, and a rule with severity off does not run", () => {
  const p = project();
  p.onMain({ "sgconfig.yml": "ruleDirs: [sev]\n", "sev/w.yml": rule("c-warning", "warning"), "sev/i.yml": rule("c-info", "info"), "sev/h.yml": rule("c-hint", "hint"), "sev/o.yml": rule("c-off", "off", "call_expression") });
  const out = lint(p, p.commit({ "c.js": "f(); // why\n" }));
  assert.match(out, /^T1 lint-fail /);
  assert.deepEqual(problems(out).sort(), ["c.js:1: c-hint (c-hint, hint)", "c.js:1: c-info (c-info, info)", "c.js:1: c-warning (c-warning, warning)"]);
});

test("F-T1019-15: with no origin/main, a checkout with a root sgconfig.yml makes lint and the merge check refuse and name what is missing; one without it needs no lint", () => {
  const p = project();
  const sha = p.commit({ "c.js": "f();\n" });
  p.git("update-ref", "-d", "refs/remotes/origin/main");
  p.git("update-ref", "refs/remotes/origin/master", p.base);
  const r = p.sage("lint", "T1", "--sha", sha);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /has a root sgconfig\.yml but no origin\/main, and lint reads its rules only from the tip of origin\/main/);
  assert.doesNotMatch(r.stderr, /git fetch/);
  p.ok("verdict", "T1", "--sha", sha, "--kind", "checks-pass");
  const check = p.sage("merge-check", "--sha", sha);
  assert.equal(check.status, 1);
  assert.match(check.stderr, /T1: \S+ has a root sgconfig\.yml but no origin\/main/);
  const q = project({ config: false });
  const head = q.commit({ "c.js": "f(); // why\n" });
  q.git("update-ref", "-d", "refs/remotes/origin/main");
  assert.match(lint(q, head), /^T1 · \S+: \S+ has no origin\/main and no sgconfig\.yml at its root, so there is nothing to lint/);
  q.ok("verdict", "T1", "--sha", head, "--kind", "checks-pass");
  assert.match(q.ok("merge-check", "--sha", head), /^T1 may merge/);
});

test("a lead may run lint on its own task only", () => {
  const view = { task: (id) => ({ id, state: "reviewing", keys: "" }), findings: () => [] };
  const ask = (task) => leadProblem(leadRequest("lint", [task], { sha: "a".repeat(40) }), { lead: { task: "T1" }, view });
  assert.equal(ask("T1"), undefined);
  assert.match(ask("T2"), /^T2 is not of T1, and a lead records only its own task\./);
});
