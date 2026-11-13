import "./test-env.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { AST_GREP, RULE_SET } from "./lint-rules.mjs";
import { leadProblem, leadRequest } from "../packages/sage-core/lead-policy.mjs";
import { AST_GREP_VERSION } from "../packages/sage-core/lint.mjs";

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
  const base = commit({ ...BASE, ".gitattributes": "gen/** linguist-generated=true\n", ...(config && { "sgconfig.yml": "ruleDirs: [lint/rules]\nutilDirs: [lint/utils]\n" }) });
  git("update-ref", "refs/remotes/origin/main", base);
  git("checkout", "-q", "-b", "sage/t1-change");
  const sage = (...args) => spawnSync("node", [TOOL, ...args, "--project", folder], { encoding: "utf8", env });
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
  return { folder, base, git, commit, sage, ok, lints, place, tools, env };
}

const lint = (p, sha) => p.ok("lint", "T1", "--sha", sha);
const problems = (out) => out.split("\n").slice(1).filter((line) => !line.startsWith("  not checked:")).map((line) => line.trim());
const notChecked = (out) => /^ {2}not checked: (.*)$/m.exec(out)?.[1] ?? "";

test("lint writes lint-pass on a clean change, and lint-fail with file:line and the rule's message on a change that adds a comment", () => {
  const p = project();
  const clean = p.commit({ "a.js": "const a = 1; // an old comment\nconst b = 3;\n", "new.js": "export const d = 4;\n" });
  const out = lint(p, clean);
  assert.match(out, new RegExp(`^T1 lint-pass · ${clean.slice(0, 7)} · base ${p.base.slice(0, 7)} · 2 files checked$`), "an edit next to an old comment does not flag the old comment");
  const dirty = p.commit({ "new.js": "export const d = 4;\nexport const e = 5; // why\n" });
  const fail = lint(p, dirty);
  assert.match(fail, /^T1 lint-fail · \S+ · base \S+ · 2 files checked · 1 problem$/m, "the change is the whole pull request since its base");
  assert.deepEqual(problems(fail), [`new.js:2: ${MESSAGE} (no-comments-js, error)`]);
  assert.deepEqual(p.lints(), [`T1  ${clean} lint-pass`, `T1  ${dirty} lint-fail`]);
});

test("an old trailing comment on an edited line fails, and so does a comment block that moved to another file", () => {
  const p = project();
  const sha = p.commit({ "a.js": "const a = 10; // an old comment\nconst b = 2;\n// a block that moves\n", "old.js": "const c = 3;\n" });
  assert.deepEqual(problems(lint(p, sha)), [`a.js:1: ${MESSAGE} (no-comments-js, error)`, `a.js:3: ${MESSAGE} (no-comments-js, error)`]);
});

test("a renamed file with its old comment, and a comment on an unchanged line, pass", () => {
  const p = project();
  const sha = p.commit({ "old.js": null, "lib/old.js": BASE["old.js"], "a.js": "const a = 1; // an old comment\nconst b = 2;\nconst n = 5;\n" });
  assert.match(lint(p, sha), /^T1 lint-pass · \S+ · base \S+ · 1 file checked$/);
});

test("a pull request that edits sgconfig.yml or a rule at its head is still checked by the base's rules", () => {
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
  assert.deepEqual(problems(out), ["bad.js: ast-grep skipped this file (invalidUtf8), so no rule checked it. Save it as UTF-8, or mark it linguist-generated or linguist-vendored in the base's .gitattributes."]);
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
  assert.equal(notChecked(out), "--off (no language of ast-grep), doc.md (no rule of sgconfig.yml for Markdown), gen/out.js (linguist-generated in the base's .gitattributes), link.js (a symbolic link: it holds a path, not code), tool (no language of ast-grep)");
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

test("a repository whose base has no sgconfig.yml gets a note and no lint verdict, and its merge check needs none", () => {
  const p = project({ config: false });
  const sha = p.commit({ "c.js": "f(); // why\n" });
  assert.match(lint(p, sha), /^T1 · \S+ · base \S+: the base has no sgconfig\.yml at its root, so there is nothing to lint, and the merge check needs no lint verdict\. Nothing changed\.$/);
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
  assert.match(before.stderr, new RegExp(`T1: no lint-pass on this SHA, and its base ${p.base.slice(0, 7)} has a root sgconfig\\.yml\\. Run sage lint T1 --sha <sha> on it\\.`));
  lint(p, clean);
  assert.match(p.ok("merge-check", "--sha", clean), /^T1 may merge/);
  const dirty = p.commit({ "c.js": "f(); // why\n" });
  p.ok("verdict", "T1", "--sha", dirty, "--kind", "checks-pass");
  lint(p, dirty);
  const after = p.sage("merge-check", "--sha", dirty);
  assert.equal(after.status, 1);
  assert.match(after.stderr, /T1: lint-fail on this SHA, and its base \S+ has a root sgconfig\.yml\. Fix the lines that lint named in a new commit/);
});

test("the merge check refuses when it cannot read the SHA to find its base", () => {
  const p = project();
  const sha = p.commit({ "c.js": "f();\n" });
  p.ok("verdict", "T1", "--sha", sha, "--kind", "checks-pass");
  p.git("checkout", "-q", "main");
  p.git("branch", "-D", "sage/t1-change");
  p.git("reflog", "expire", "--expire=now", "--all");
  p.git("gc", "-q", "--prune=now");
  const r = p.sage("merge-check", "--sha", sha);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /T1: the merge check cannot find the base of this SHA \(.+\), so it cannot tell if the base has a root sgconfig\.yml/);
});

test("a lead may run lint on its own task only", () => {
  const view = { task: (id) => ({ id, state: "reviewing", keys: "" }), findings: () => [] };
  const ask = (task) => leadProblem(leadRequest("lint", [task], { sha: "a".repeat(40) }), { lead: { task: "T1" }, view });
  assert.equal(ask("T1"), undefined);
  assert.match(ask("T2"), /^T2 is not of T1, and a lead records only its own task\./);
});
