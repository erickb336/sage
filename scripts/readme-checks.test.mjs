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
import { anchors, linkProblems, readmeProblems, slug } from "./readme-checks.mjs";

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

test("the line budget counts every line of the raw file, blank ones too", () => {
  const at = (n) => README({ more: Array.from({ length: n - README().split("\n").length + 1 }, () => "") });
  assert.equal(at(150).split("\n").length - 1, 150);
  assert.deepEqual(readmeProblems(at(150)), [], "150 lines pass");
  assert.deepEqual(readmeProblems(at(151)), ["README.md: 151 lines; keep it at 150 or fewer. Move reference material to a page under docs/"]);
});

test("GitHub's anchors: lower case, no punctuation, a hyphen for each space", () => {
  assert.equal(slug("What's new"), "whats-new");
  assert.equal(slug("A task's life"), "a-tasks-life");
  assert.equal(slug("1. Where it fits"), "1-where-it-fits");
  assert.equal(slug("Git: pushes, merges and branches"), "git-pushes-merges-and-branches");
  assert.equal(slug("The `sage` skill"), "the-sage-skill");
  // GitHub keeps an underscore (R1393-1).
  assert.equal(slug("The max_agents cap"), "the-max_agents-cap");
  // GitHub makes the anchor from the heading's text, so the "_" and "__" of emphasis go; code keeps them (R1398-1).
  assert.equal(slug("The _max_ cap"), "the-max-cap");
  assert.equal(slug("__Bold__ start and _end_"), "bold-start-and-end");
  assert.equal(slug("The _max_agents_ cap"), "the-max_agents-cap");
  assert.equal(slug("The `__init__` file"), "the-__init__-file");
});

test("a repeated heading gets -1, -2, and a heading that already has that slug gets its own suffix, as on GitHub", () => {
  // GitHub: A → a, A → a-1, A-1 → a-1-1 (a-1 is taken), A → a-2.
  assert.deepEqual([...anchors("# A\n\n## A\n\n## A-1\n\n## A\n")], ["a", "a-1", "a-1-1", "a-2"]);
});

test("a link with a bad % escape is a problem, not a crash", (t) => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "sage-links-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "README.md"), "[ok](README.md) [bad](docs/100%.md) [bad](a%zz.md)\n");
  assert.deepEqual(linkProblems(dir, ["README.md"]), ["README.md:1: docs/100%.md has a bad % escape", "README.md:1: a%zz.md has a bad % escape"]);
});

test("a relative link, or a link to the main branch on GitHub, to a missing file or a missing anchor is a problem; another web link, code and a present anchor are not", (t) => {
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
    "[main](https://github.com/erickb336/sage/blob/main/docs/guide.md#step) [main, no anchor](https://github.com/erickb336/sage/blob/main/docs/guide.md#gone) [main, no file](https://github.com/erickb336/sage/blob/main/gone.md)",
    "",
    "```",
    "[fenced](missing.md)",
    "```",
  ].join("\n"));
  assert.deepEqual(linkProblems(dir, ["README.md"]), [
    "README.md:6: docs/missing.md does not exist",
    "README.md:6: docs/guide.md#nothing names #nothing, which docs/guide.md does not have",
    "README.md:6: #nowhere names #nowhere, which README.md does not have",
    "README.md:6: ../outside.md leaves the repository",
    "README.md:7: https://github.com/erickb336/sage/blob/main/docs/guide.md#gone names #gone, which docs/guide.md does not have",
    "README.md:7: https://github.com/erickb336/sage/blob/main/gone.md does not exist",
  ]);
});

test("npm run check fails on a README with 6 What's new items, a missing screenshot and a stale screenshot record", (t) => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "sage-readme-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(ROOT, dir, { recursive: true, filter: (src) => ![".git", ".claude", "node_modules"].includes(relative(ROOT, src)) });
  symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"), "dir");
  const readme = readFileSync(join(dir, "README.md"), "utf8");
  // Fill the real What's new list up to 6 items, so that the test holds for any count from 1 to 5.
  const news = readme.split("## What's new")[1].split("\n## ")[0].split("\n").filter((l) => l.startsWith("- ")).length;
  const extra = Array.from({ length: 6 - news }, (_, i) => `\n- **Extra change ${i + 1}.** One line.`).join("");
  writeFileSync(join(dir, "README.md"), readme.replace("\n\nAll changes: [CHANGELOG.md]", `${extra}\n\nAll changes: [CHANGELOG.md]`));
  rmSync(join(dir, "docs/assets/board-dark.png"));
  writeFileSync(join(dir, "docs/assets/board-shots.json"), JSON.stringify({ sample: "0".repeat(64) }));
  const r = spawnSync("node", [join(dir, "scripts/check.mjs")], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^✗ README\.md: What's new has 6 items; keep the last 5, and move the others to CHANGELOG\.md$/m);
  assert.match(r.stderr, /^✗ docs\/assets\/board-dark\.png: missing; run node scripts\/board-shots\.mjs \(see CONTRIBUTING\.md\)$/m);
  assert.match(r.stderr, /^✗ docs\/assets\/board-shots\.json: the sample logbook changed after the board screenshots; run node scripts\/board-shots\.mjs/m);
});
