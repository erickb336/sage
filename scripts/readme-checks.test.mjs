// The README's limits and the docs' link check (scripts/readme-checks.mjs, T381): literal pages in, problems out; then
// `npm run check` in a copy of this repository, where a README, a screenshot and its record are broken on purpose.
import "./test-env.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";
import { ROOT } from "./build.mjs";
import { countedLines, linkProblems, readmeProblems, slug } from "./readme-checks.mjs";

const NEWS = (n) => ["## What's new", "", ...Array.from({ length: n }, (_, i) => `- **Change ${i + 1}.** One line.`), "", "All changes are in [CHANGELOG.md](CHANGELOG.md).", ""];
const README = (lines = {}) => [
  "<p>", "  <img alt=\"a graphic\" src=\"x.svg\">", "</p>", "",
  lines.pitch ?? "**sage is a plugin for Claude Code that turns a session into your chief of staff.**",
  "**Status:** early. See [Status](#status) and the [Quick start](#quick-start).", "",
  "## Status", "", "Early.", "", "## Quick start", "", "Install it.", "",
  ...NEWS(lines.news ?? 5), ...(lines.more ?? []),
].join("\n");

test("a README within its budget, with 5 What's new items and a first screen that answers, has no problem", () => {
  assert.deepEqual(readmeProblems(README()), []);
});

test("a sixth What's new item, a missing changelog link and a first screen without the pitch or its links are problems", () => {
  assert.deepEqual(readmeProblems(README({ news: 6 })), ["README.md: What's new has 6 items; keep the last 5, and move the others to CHANGELOG.md"]);
  assert.deepEqual(readmeProblems(README().replace("](CHANGELOG.md)", "](docs/)")), ["README.md: What's new must link to CHANGELOG.md"]);
  assert.deepEqual(readmeProblems(README({ pitch: "sage helps you." })), ['README.md: the first screen (the first 10 lines with text) needs one bold sentence that starts "**sage is a"']);
  // Ten lines of text before the status line push its links off the first screen.
  const late = README().replace("**Status:**", `${Array.from({ length: 10 }, (_, i) => `Line ${i}.`).join("\n")}\n**Status:**`);
  assert.deepEqual(readmeProblems(late), ["README.md: the first screen (the first 10 lines with text) needs a link to #status", "README.md: the first screen (the first 10 lines with text) needs a link to #quick-start"]);
});

test("the line budget counts lines with text, and not the two tables that the build writes", () => {
  const table = (start, end) => [start, "", ...Array.from({ length: 300 }, (_, i) => `| row ${i} | text |`), "", end];
  const generated = README({ more: [...table("<!-- The word table comes from writing/dictionary.md: edit it there, then run npm run build. -->", "<!-- The end of the word table. -->"), ...table("<!-- The principles table comes from principles/ and upstream/pstack/: edit them there, then run npm run build. -->", "<!-- The end of the principles table. -->")] });
  assert.equal(countedLines(generated), countedLines(README()), "the generated rows and their markers do not count");
  assert.equal(countedLines("a\n\n  \nb\n"), 2, "blank lines do not count");
  const long = README({ more: Array.from({ length: 250 }, (_, i) => `Line ${i}.`) });
  assert.match(readmeProblems(long).join("\n"), /^README\.md: \d+ lines of text; keep it at 260 or fewer/);
});

test("GitHub's anchors: lower case, no punctuation, a hyphen for each space", () => {
  assert.equal(slug("What's new"), "whats-new");
  assert.equal(slug("A task's life"), "a-tasks-life");
  assert.equal(slug("1. Where it fits"), "1-where-it-fits");
  assert.equal(slug("Git: pushes, merges and branches"), "git-pushes-merges-and-branches");
  assert.equal(slug("The `sage` skill"), "the-sage-skill");
});

test("a relative link to a missing file or a missing anchor is a problem; a web link, code and a present anchor are not", (t) => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "sage-links-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "docs"));
  writeFileSync(join(dir, "docs/guide.md"), "# Guide\n\n## What's new\n\n<a id=\"decide\"></a>\n\n## Step\n\n## Step\n");
  writeFileSync(join(dir, "README.md"), [
    "[ok](docs/guide.md) [ok](docs/guide.md#whats-new) [ok](docs/guide.md#decide) [ok](docs/guide.md#step-1) [ok](#top)",
    "[web](https://example.com/missing) `[code](missing.md)` <img src=\"docs\">",
    "",
    "# Top",
    "",
    "[no file](docs/missing.md) [no anchor](docs/guide.md#nothing) <a href=\"#nowhere\">x</a> [out](../outside.md)",
    "",
    "```",
    "[fenced](missing.md)",
    "```",
  ].join("\n"));
  assert.deepEqual(linkProblems(dir, ["README.md"]), [
    "README.md:6: docs/missing.md does not exist",
    "README.md:6: docs/guide.md#nothing names #nothing, which docs/guide.md does not have",
    "README.md:6: ../outside.md leaves the repository",
    "README.md:6: #nowhere names #nowhere, which README.md does not have",
  ]);
});

test("npm run check fails on a README with 6 What's new items, a missing screenshot and a stale screenshot record", (t) => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "sage-readme-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(ROOT, dir, { recursive: true, filter: (src) => ![".git", ".claude", "node_modules"].includes(relative(ROOT, src)) });
  symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"), "dir");
  const readme = readFileSync(join(dir, "README.md"), "utf8");
  writeFileSync(join(dir, "README.md"), readme.replace("\n\nAll changes, with their dates,", "\n- **A sixth change.** One line.\n\nAll changes, with their dates,"));
  rmSync(join(dir, "docs/assets/board-dark.png"));
  writeFileSync(join(dir, "docs/assets/board-shots.json"), JSON.stringify({ sample: "0".repeat(64) }));
  const r = spawnSync("node", [join(dir, "scripts/check.mjs")], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^✗ README\.md: What's new has 6 items; keep the last 5, and move the others to CHANGELOG\.md$/m);
  assert.match(r.stderr, /^✗ docs\/assets\/board-dark\.png: missing; run node scripts\/board-shots\.mjs \(see CONTRIBUTING\.md\)$/m);
  assert.match(r.stderr, /^✗ docs\/assets\/board-shots\.json: the sample logbook changed after the board screenshots; run node scripts\/board-shots\.mjs/m);
});
