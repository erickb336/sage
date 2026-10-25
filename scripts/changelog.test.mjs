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
import { assemble } from "./changelog.mjs";

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
  assert.match(readFileSync(join(dir, "CHANGELOG.md"), "utf8"), /\n## 2099-01-01\n\n- \*\*A later change\.\*\* Text\.\n\n## 2026-10-25\n/);
});
