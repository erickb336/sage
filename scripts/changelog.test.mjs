// CHANGELOG.md from changes/ (scripts/changelog.mjs, T492): literal fragments in, the literal change log out; two
// branches that each add a fragment for one date merge with no conflict; and `npm run check` in a copy of this
// repository fails on a fragment that the build has not put in, and passes after the build.
import "./test-env.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";
import { ROOT } from "./build.mjs";
import { assemble, changelog } from "./changelog.mjs";

const BUILT = "<!-- Built by scripts/build.mjs from changes/: write your entry in changes/<task>.md, then run npm run build. -->";
const EARLIER = "# Changelog\n\nThe intro.\n\n## 2026-10-25\n\n- **Old.** Text.\n  - A sub item.\n\n## 2026-10-24\n\n- **Older.** Text.\n";
const entry = (date, item) => `---\ndate: ${date}\n---\n${item}\n`;

test("the build puts each fragment under its date, newest date first, and the highest task first in a date", () => {
  const files = { "T9.md": entry("2026-10-25", "- **Nine.**"), "T10.md": entry("2026-10-25", "- **Ten.**"), "T11.md": entry("2026-10-26", "- **Eleven.**") };
  assert.equal(assemble(EARLIER, files), [
    BUILT, "", "# Changelog", "", "The intro.", "",
    "## 2026-10-26", "", "- **Eleven.**", "",
    "## 2026-10-25", "", "- **Ten.**", "- **Nine.**", "- **Old.** Text.", "  - A sub item.", "",
    "## 2026-10-24", "", "- **Older.** Text.", "",
  ].join("\n"));
  assert.equal(assemble(EARLIER, {}), `${BUILT}\n\n${EARLIER}`, "with no fragment, the older text comes back as it was");
});

test("a fragment without its date or its list item stops the build, with the file and the fix", () => {
  assert.throws(() => assemble(EARLIER, { "T1.md": "- **No date.**\n" }), { message: "changes/T1.md: start it with the lines ---, date: YYYY-MM-DD and ---" });
  assert.throws(() => assemble(EARLIER, { "T2.md": entry("25 Oct", "- **Bad date.**") }), { message: "changes/T2.md: start it with the lines ---, date: YYYY-MM-DD and ---" });
  assert.throws(() => assemble(EARLIER, { "T3.md": entry("2026-10-25", "Not a list item.") }), { message: 'changes/T3.md: write one list item that starts with "- ", and no heading' });
  assert.throws(() => assemble(EARLIER, { "T4.md": entry("2026-10-25", "- **Item.**\n\n## 2026-10-26") }), { message: 'changes/T4.md: write one list item that starts with "- ", and no heading' });
});

// Git in a scratch repository, with no shell. test-env.mjs keeps the developer's git config out.
function repo(t) {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "sage-changelog-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "init.defaultBranch=main", ...args], { cwd: dir, encoding: "utf8", env: { ...process.env, HOME: dir } });
  const commit = (branch, files) => {
    assert.equal(git("checkout", "-q", "-B", branch, "main").status, 0);
    for (const [path, text] of Object.entries(files)) { mkdirSync(join(dir, path, ".."), { recursive: true }); writeFileSync(join(dir, path), text); }
    assert.equal(git("add", "-A").status, 0);
    assert.equal(git("commit", "-qm", branch).status, 0);
  };
  git("init", "-q");
  writeFileSync(join(dir, ".keep"), "");
  git("add", "-A");
  git("commit", "-qm", "root");
  return { git, commit };
}
const mergeTree = (git) => git("merge-tree", "--write-tree", "--name-only", "--no-messages", "a", "b");

test("two branches that each add a fragment for the same date merge with no conflict, and the build puts both in", (t) => {
  const { git, commit } = repo(t);
  const T1 = entry("2026-10-25", "- **First change.** From branch a."), T2 = entry("2026-10-25", "- **Second change.** From branch b.");
  commit("main", { "changes/earlier.md": EARLIER, "CHANGELOG.md": assemble(EARLIER, {}) });
  commit("a", { "changes/T1.md": T1 });
  commit("b", { "changes/T2.md": T2 });
  const merged = mergeTree(git);
  assert.equal(merged.status, 0, merged.stdout);
  const tree = merged.stdout.trim();
  assert.deepEqual(git("ls-tree", "--name-only", `${tree}:changes`).stdout.split("\n").filter(Boolean), ["T1.md", "T2.md", "earlier.md"]);
  const read = (path) => git("show", `${tree}:${path}`).stdout;
  assert.match(assemble(read("changes/earlier.md"), { "T1.md": read("changes/T1.md"), "T2.md": read("changes/T2.md") }),
    /\n## 2026-10-25\n\n- \*\*Second change\.\*\* From branch b\.\n- \*\*First change\.\*\* From branch a\.\n- \*\*Old\.\*\* Text\.\n/);

  // Before T492, each branch wrote its entry at the top of the date in CHANGELOG.md, and the two conflicted there.
  const byHand = (item) => assemble(EARLIER, {}).replace("## 2026-10-25\n\n", `## 2026-10-25\n\n${item}\n`);
  commit("a", { "CHANGELOG.md": byHand("- **First change.** From branch a.") });
  commit("b", { "CHANGELOG.md": byHand("- **Second change.** From branch b.") });
  assert.deepEqual([mergeTree(git).status, mergeTree(git).stdout.trim().split("\n").slice(1)], [1, ["CHANGELOG.md"]]);

  // A branch also commits its built CHANGELOG.md, so the two conflict in that built file only; the build ends it.
  commit("a", { "changes/T1.md": T1, "CHANGELOG.md": assemble(EARLIER, { "T1.md": T1 }) });
  commit("b", { "changes/T2.md": T2, "CHANGELOG.md": assemble(EARLIER, { "T2.md": T2 }) });
  assert.deepEqual([mergeTree(git).status, mergeTree(git).stdout.trim().split("\n").slice(1)], [1, ["CHANGELOG.md"]]);
});

test("npm run check fails on a fragment that the build has not put in CHANGELOG.md, and passes after npm run build", (t) => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "sage-changelog-check-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(ROOT, dir, { recursive: true, filter: (src) => ![".git", ".claude", "node_modules"].includes(relative(ROOT, src)) });
  symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"), "dir");
  writeFileSync(join(dir, "changes/T99999.md"), entry("2099-01-01", "- **A later change.** Text."));
  const check = () => spawnSync("node", [join(dir, "scripts/check.mjs")], { encoding: "utf8" });
  const stale = check();
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /^✗ CHANGELOG\.md: out of date; run npm run build$/m);
  assert.equal(spawnSync("node", [join(dir, "scripts/build.mjs")], { encoding: "utf8" }).status, 0);
  const built = check();
  assert.equal(built.status, 0, built.stderr);
  assert.match(readFileSync(join(dir, "CHANGELOG.md"), "utf8"), /\n## 2099-01-01\n\n- \*\*A later change\.\*\* Text\.\n\n## \d{4}-\d{2}-\d{2}\n/); // the repository's newest date comes next
});

// R1771: nothing drops without a line that says so. A small checkout with changes/ and CHANGELOG.md.
function checkout(t, changelogText) {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "sage-changelog-root-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "changes"));
  writeFileSync(join(dir, "changes/earlier.md"), EARLIER);
  writeFileSync(join(dir, "CHANGELOG.md"), changelogText);
  return dir;
}
const HAND = "- **By hand.** An entry that a pull request wrote in CHANGELOG.md before T492.";
const withHand = (item) => assemble(EARLIER, {}).replace("## 2026-10-25\n\n", `## 2026-10-25\n\n${item}\n`);

test("a file in changes/ that is not a .md fragment stops the build with its name and the fix, and the renamed file is kept", (t) => {
  const dir = checkout(t, assemble(EARLIER, {}));
  for (const name of ["T500.MD", "T500.txt", "T500", "T500.md.bak"]) {
    writeFileSync(join(dir, "changes", name), entry("2026-10-25", "- **Five hundred.** Text."));
    assert.throws(() => changelog(dir), { message: `changes/${name}: the build reads only .md files, so it would drop this file; rename it to changes/<task>.md (for example changes/T500.md)` });
    rmSync(join(dir, "changes", name));
  }
  writeFileSync(join(dir, "changes/T500.md"), entry("2026-10-25", "- **Five hundred.** Text."));
  assert.equal((changelog(dir).match(/Five hundred/g) ?? []).length, 1);
});

test("a list line written by hand in CHANGELOG.md stops the build with the line and the fix, also in a merge conflict, and the fragment keeps it", (t) => {
  const line = `CHANGELOG.md has a line that no file of changes/ makes, so the build would drop it: "${HAND.slice(0, 70)}...". Move it into changes/<task>.md with its date (or into changes/earlier.md if it is an older entry or the intro), then run npm run build.`;
  const dir = checkout(t, withHand(HAND));
  assert.throws(() => changelog(dir), { message: line });
  writeFileSync(join(dir, "CHANGELOG.md"), `<<<<<<< HEAD\n${assemble(EARLIER, {})}=======\n${withHand(HAND)}>>>>>>> origin/main\n`);
  assert.throws(() => changelog(dir), { message: line });
  // The fix that the message names: the entry goes into a fragment, and the build writes it once.
  writeFileSync(join(dir, "changes/T501.md"), entry("2026-10-25", HAND));
  const fixed = changelog(dir);
  assert.equal(fixed.replace(/<!-- Lines of the last build.*\n$/, ""), assemble(EARLIER, { "T501.md": entry("2026-10-25", HAND) }));
  assert.equal(fixed.split("\n").filter((l) => l === HAND).length, 1);
});

test("a fragment that you edit after a build is only out of date, but a built bullet that you edit in CHANGELOG.md stops the build", (t) => {
  const dir = checkout(t, "");
  writeFileSync(join(dir, "changes/T502.md"), entry("2026-10-25", "- **Old title.** Old text."));
  writeFileSync(join(dir, "CHANGELOG.md"), changelog(dir));
  writeFileSync(join(dir, "changes/T502.md"), entry("2026-10-25", "- **New title.** New text."));
  const rebuilt = changelog(dir);
  assert.match(rebuilt, /\n- \*\*New title\.\*\* New text\.\n/);
  assert.doesNotMatch(rebuilt, /Old title/);
  writeFileSync(join(dir, "CHANGELOG.md"), rebuilt.replace("New text.", "New text, edited by hand."));
  assert.throws(() => changelog(dir), { message: /^CHANGELOG\.md has a line that no file of changes\/ makes, so the build would drop it: "- \*\*New title\.\*\* New text, edited by hand\."\. Move it into changes\/<task>\.md/ });
});

// R1787-1: any line of text that the last build did not make stops the build, whatever its form.
const FORMS = [
  ["a * bullet", (b) => b.replace("## 2026-10-25\n\n", "## 2026-10-25\n\n* **Star.** Hand text.\n"), "* **Star.** Hand text."],
  ["a + bullet", (b) => b.replace("## 2026-10-25\n\n", "## 2026-10-25\n\n+ **Plus.** Hand text.\n"), "+ **Plus.** Hand text."],
  ["a numbered item", (b) => b.replace("## 2026-10-25\n\n", "## 2026-10-25\n\n1. **One.** Hand text.\n"), "1. **One.** Hand text."],
  ["an indented second paragraph under a built entry", (b) => b.replace("- **Old.** Text.\n", "- **Old.** Text.\n\n  A hand paragraph.\n"), "A hand paragraph."],
  ["a wrapped continuation line", (b) => b.replace("- **Old.** Text.\n", "- **Old.** Text.\n  and a wrapped hand line\n"), "and a wrapped hand line"],
  ["a paragraph under a date", (b) => b.replace("## 2026-10-24\n\n", "## 2026-10-24\n\nA hand paragraph under a date.\n\n"), "A hand paragraph under a date."],
  ["an edit of the intro", (b) => b.replace("The intro.", "The intro, edited."), "The intro, edited."],
  ["a changed word inside a built entry", (b) => b.replace("**Older.** Text.", "**Older.** Text, changed."), "- **Older.** Text, changed."],
];

test("a line of any form that the last build did not make stops the build with the line and the fix", (t) => {
  const dir = checkout(t, "");
  writeFileSync(join(dir, "changes/T503.md"), entry("2026-10-25", "- **Built.** Text."));
  const base = changelog(dir);
  writeFileSync(join(dir, "CHANGELOG.md"), base);
  assert.equal(changelog(dir), base, "the file as built is not by hand");
  for (const [name, edit, text] of FORMS) {
    const edited = edit(base);
    assert.notEqual(edited, base, name);
    writeFileSync(join(dir, "CHANGELOG.md"), edited);
    assert.throws(() => changelog(dir), { message: `CHANGELOG.md has a line that no file of changes/ makes, so the build would drop it: "${text}". Move it into changes/<task>.md with its date (or into changes/earlier.md if it is an older entry or the intro), then run npm run build.` }, name);
  }
});

test("a dot file in changes/ is ignored, but any other file that is not .md still stops the build", (t) => {
  const dir = checkout(t, assemble(EARLIER, {}));
  writeFileSync(join(dir, "changes/.DS_Store"), "\u0000\u0001Bud1");
  writeFileSync(join(dir, "changes/T900.md"), entry("2026-10-25", "- **Nine hundred.** Text."));
  assert.match(changelog(dir), /\n- \*\*Nine hundred\.\*\* Text\.\n/);
  writeFileSync(join(dir, "changes/T900.txt"), entry("2026-10-25", "- **Lost.** Text."));
  assert.throws(() => changelog(dir), { message: "changes/T900.txt: the build reads only .md files, so it would drop this file; rename it to changes/<task>.md (for example changes/T500.md)" });
});

test("npm run build writes nothing, and npm run check fails, on a hand-written entry or a wrong file name; after the fix both pass", (t) => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "sage-changelog-hand-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(ROOT, dir, { recursive: true, filter: (src) => ![".git", ".claude", "node_modules"].includes(relative(ROOT, src)) });
  symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"), "dir");
  const run = (script) => spawnSync("node", [join(dir, "scripts", script)], { encoding: "utf8" });
  const file = join(dir, "CHANGELOG.md");
  const before = readFileSync(file, "utf8");
  const edited = before.replace("## 2026-10-25\n\n", `## 2026-10-25\n\n${HAND}\n`);
  writeFileSync(file, edited);
  const build = run("build.mjs"), check = run("check.mjs");
  assert.equal(build.status, 1);
  assert.match(build.stderr, /^✗ CHANGELOG\.md has a line that no file of changes\/ makes, so the build would drop it: "- \*\*By hand\.\*\* An entry that a pull request wrote in CHANGELOG\.md befo\.\.\."\. Move it into changes\/<task>\.md with its date .*, then run npm run build\.$/m);
  assert.equal(readFileSync(file, "utf8"), edited, "the build leaves CHANGELOG.md as it was");
  assert.equal(check.status, 1);
  assert.match(check.stderr, /^✗ CHANGELOG\.md has a line that no file of changes\/ makes/m);
  writeFileSync(join(dir, "changes/T99998.md"), entry("2026-10-25", HAND));
  writeFileSync(join(dir, "changes/T99999.txt"), entry("2026-10-25", "- **Lost.** Text."));
  const named = run("build.mjs");
  assert.equal(named.status, 1);
  assert.match(named.stderr, /^✗ changes\/T99999\.txt: the build reads only \.md files, so it would drop this file; rename it to changes\/<task>\.md/m);
  rmSync(join(dir, "changes/T99999.txt"));
  assert.equal(run("build.mjs").status, 0);
  const built = readFileSync(file, "utf8");
  assert.equal(built.split("\n").filter((l) => l === HAND).length, 1);
  assert.equal(run("check.mjs").status, 0);
});
