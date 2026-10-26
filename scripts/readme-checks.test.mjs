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
import { anchors, linkProblems, paragraphProblems, readmeProblems, slug } from "./readme-checks.mjs";

const README = (lines = {}) => [
  "<p>", "  <img alt=\"a graphic\" src=\"x.svg\">", "</p>", "",
  lines.pitch ?? "**sage is a plugin for Claude Code that turns a session into your chief of staff.**",
  "**Status:** early. Start with the [Quick start](#quick-start).", "",
  "## Quick start", "", "Install it.", "",
  "## Learn more", "", "- [What's new](CHANGELOG.md): every change.", "", ...(lines.more ?? []),
].join("\n");

test("a README within its budget, with a changelog link and a first screen that answers, has no problem", () => {
  assert.deepEqual(readmeProblems(README()), []);
});

test("a missing changelog link and a first screen without the pitch, the status or the quick start link are problems", () => {
  assert.deepEqual(readmeProblems(README().replace("](CHANGELOG.md)", "](docs/)")), ["README.md: no link to CHANGELOG.md; the changelog holds the list of changes"]);
  assert.deepEqual(readmeProblems(README({ pitch: "sage helps you." })), ['README.md: the first screen (the first 10 lines with text) needs one bold sentence that starts "**sage is a"']);
  // Ten lines of text before the status line push it and its link off the first screen.
  const late = README().replace("**Status:**", `${Array.from({ length: 10 }, (_, i) => `Line ${i}.`).join("\n")}\n**Status:**`);
  assert.deepEqual(readmeProblems(late), ['README.md: the first screen (the first 10 lines with text) needs a status line that starts "**Status:**"', "README.md: the first screen (the first 10 lines with text) needs a link to #quick-start"]);
});

test("a paragraph of 4 sentences is a problem at its first line; 3 sentences, code, short items and cells, and quotes are not", () => {
  const page = [
    "# Page", "",
    "One. Two? Three!", "",
    "First `a. b. c.` and [a link](x.md#a.b) and v1.2 and README.md.", "Second line. Third. Fourth \"quoted.\"", "",
    "```", "One. Two. Three. Four.", "```", "",
    "- One. Two.", "  Three.", "",
    "| A | B |", "| --- | --- |", "| One. Two. | Three. Four. Five. |", "",
    "> One. Two. Three. Four.", "",
    "    One. Two. Three. Four.", "",
  ].join("\n");
  assert.deepEqual(paragraphProblems("docs/guide/x.md", page), ["docs/guide/x.md:5: a paragraph of 4 sentences; keep it at 3 or fewer. Split it, or make it a list or a table"]);
  assert.deepEqual(paragraphProblems("README.md", "One. Two. Three.\nFour.\n\nFive.\n"), ["README.md:1: a paragraph of 4 sentences; keep it at 3 or fewer. Split it, or make it a list or a table"]);
});

test("a list item or a table cell of 4 sentences is a problem at its line (R1406-5)", () => {
  const page = [
    "- One. Two.", "  Three. Four.", "- Five.", "1. One. Two. Three. Four.", "",
    "| A | B |", "| --- | --- |", "| One. Two. Three. Four. | Five. |", "| `a|b` One. | Two \\| Three. Four. Five. Six. |", "",
  ].join("\n");
  assert.deepEqual(paragraphProblems("x.md", page), [
    "x.md:1: a list item of 4 sentences; keep it at 3 or fewer. Shorten it, or split it",
    "x.md:4: a list item of 4 sentences; keep it at 3 or fewer. Shorten it, or split it",
    "x.md:8: a table cell of 4 sentences; keep it at 3 or fewer. Shorten it, or split it",
    "x.md:9: a table cell of 4 sentences; keep it at 3 or fewer. Shorten it, or split it",
  ]);
});

test("the paragraph rule counts sentences as a reader does, and paragraphs as GitHub does (R1404-2)", () => {
  // "e.g.", "i.e." and "etc." before a word in lower case end no sentence; "etc." before a capital does.
  assert.deepEqual(paragraphProblems("x.md", "One, e.g. two. Three, i.e. four. Five, etc. and six, etc.\n"), []);
  assert.deepEqual(paragraphProblems("x.md", "One, etc. Two. Three. Four.\n"), ["x.md:1: a paragraph of 4 sentences; keep it at 3 or fewer. Split it, or make it a list or a table"]);
  // A multi-line HTML comment, and the text of a setext heading, are not prose.
  assert.deepEqual(paragraphProblems("x.md", "<!--\nOne. Two. Three. Four.\n-->\n\nTitle one. Two. Three. Four.\n===\n\nTitle. Two. Three. Four.\n---\n"), []);
  // A line that starts with an inline tag is prose; a block tag starts an HTML block, which runs to a blank line.
  assert.deepEqual(paragraphProblems("x.md", "<kbd>Ctrl</kbd> one. Two. Three. Four.\n\n<div>\nOne. Two. Three. Four.\n</div>\n"), ["x.md:1: a paragraph of 4 sentences; keep it at 3 or fewer. Split it, or make it a list or a table"]);
  // A wrapped line that starts with a year and a dot continues the paragraph: only "1." starts a list there.
  assert.deepEqual(paragraphProblems("x.md", "It started in\n2026. Two. Three. Four.\n"), ["x.md:1: a paragraph of 4 sentences; keep it at 3 or fewer. Split it, or make it a list or a table"]);
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
  // An "_" without its pair is text, and GitHub keeps it (R1404-1).
  assert.equal(slug("The _private field"), "the-_private-field");
  assert.equal(slug("The foo_ variable"), "the-foo_-variable");
  assert.equal(slug("File_.md"), "file_md");
  assert.equal(slug("_a_ and _b"), "a-and-_b");
});

test("a heading's anchor keeps the text of its code spans (R1420-1)", () => {
  assert.deepEqual([...anchors("# The `sage` skill\n\n## The `max_agents` cap\n\n## The _private field\n\n```\n# Not a heading\n```\n")], ["the-sage-skill", "the-max_agents-cap", "the-_private-field"]);
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

test("a link to the repository root, a query and a link to a folder on GitHub pass as on GitHub; reference links are checked (R1430-2, R1430-3)", (t) => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "sage-links-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "docs"));
  writeFileSync(join(dir, "docs/guide.md"), "# Guide\n\n[root](../) [root](..) [plain](guide.md?plain=1) [line](guide.md?plain=1#L3) [query](guide.md?x=1#guide)\n");
  writeFileSync(join(dir, "README.md"), [
    "[tree](https://github.com/erickb336/sage/tree/main/docs) [tree root](https://github.com/erickb336/sage/tree/main) [tree, no folder](https://github.com/erickb336/sage/tree/main/gone)",
    "[ok][g] [no file][x] [no anchor][y] [^1]",
    "",
    "[g]: docs/guide.md#guide",
    "[x]: <docs/missing.md>",
    "  [y]: docs/guide.md#nothing \"A title\"",
    "[^1]: A footnote, not a link.",
  ].join("\n"));
  assert.deepEqual(linkProblems(dir, ["README.md", "docs/guide.md"]), [
    "README.md:1: https://github.com/erickb336/sage/tree/main/gone does not exist",
    "README.md:5: docs/missing.md does not exist",
    "README.md:6: docs/guide.md#nothing names #nothing, which docs/guide.md does not have",
  ]);
});

test("npm run check fails on a README with no changelog link, a missing screenshot and a stale screenshot record", (t) => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "sage-readme-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(ROOT, dir, { recursive: true, filter: (src) => ![".git", ".claude", "node_modules"].includes(relative(ROOT, src)) });
  symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"), "dir");
  const readme = readFileSync(join(dir, "README.md"), "utf8");
  // The real README with each changelog link pointed elsewhere.
  writeFileSync(join(dir, "README.md"), readme.replaceAll("](CHANGELOG.md)", "](docs/README.md)"));
  rmSync(join(dir, "docs/assets/board-dark.png"));
  writeFileSync(join(dir, "docs/assets/board-shots.json"), JSON.stringify({ sample: "0".repeat(64) }));
  const faq = readFileSync(join(dir, "docs/guide/faq.md"), "utf8");
  writeFileSync(join(dir, "docs/guide/faq.md"), `${faq.trimEnd()}\n\nOne. Two. Three. Four.\n`);
  const r = spawnSync("node", [join(dir, "scripts/check.mjs")], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, new RegExp(`^✗ docs/guide/faq\\.md:${faq.trimEnd().split("\n").length + 2}: a paragraph of 4 sentences; keep it at 3 or fewer`, "m"));
  assert.match(r.stderr, /^✗ README\.md: no link to CHANGELOG\.md; the changelog holds the list of changes$/m);
  assert.match(r.stderr, /^✗ docs\/assets\/board-dark\.png: missing; run node scripts\/board-shots\.mjs \(see CONTRIBUTING\.md\)$/m);
  assert.match(r.stderr, /^✗ docs\/assets\/board-shots\.json: the sample logbook changed after the board screenshots; run node scripts\/board-shots\.mjs/m);
});

// T467: three lines a new reader sees must be true. Each claim is read from the real README and compared with its source.
const realReadme = () => readFileSync(join(ROOT, "README.md"), "utf8");

test("the README names the system and Node version that CI runs, and the minimum in package.json (T467-1)", () => {
  const ci = readFileSync(join(ROOT, ".github/workflows/check.yml"), "utf8");
  const ciNode = ci.match(/node-version:\s*(\d+)/)[1];
  const ciOs = ci.match(/runs-on:\s*(ubuntu)-/)[1];
  const minNode = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).engines.node.match(/>=(\d+)/)[1];
  const readme = realReadme();
  assert.match(readme, new RegExp(`^\\*\\*Status:\\*\\*.*in CI on ${ciOs}`, "im"), "the status line says that CI runs Ubuntu");
  assert.doesNotMatch(readme, /Linux is not yet tested/);
  assert.match(readme, new RegExp(`Node\\.js ${minNode} or later \\(the minimum; CI runs the tests on Node ${ciNode}\\)`), "the install steps give the minimum and the CI version");
});

test("the Codex install line names a GitHub remote, as docs/guide/codex.md does (T467-2)", () => {
  assert.match(realReadme(), /`gh` logged in, and a GitHub remote for the project \(see \[What you need\]/);
  assert.match(readFileSync(join(ROOT, "docs/guide/codex.md"), "utf8"), /a GitHub remote for the project/);
});

test("the board image's alt text says its two Needs you items are program items, not questions (T467-3)", () => {
  const alt = realReadme().match(/<img alt="The board page[^"]*"/)[0];
  assert.match(alt, /a Needs you box with two program items,/);
  assert.doesNotMatch(alt, /program questions/);
});

test("the README defines the on phrase and the update warning in words the reader has met (R1661)", () => {
  const readme = realReadme();
  assert.match(readme, /Send the on phrase, the words below, as a message of its own/);
  assert.match(readme, /> \*\*Warning:\*\* before you use programs \(tasks of one goal\) or tasks that wait for other tasks, update sage/);
});

// T521 (the owner, 2026-10-25): How sage works is in the README, the limits table is gone, and Learn more links the
// rules page and SECURITY.md, which hold the limits.
test("the README has How sage works, no Safety and limits section, and links the rules page and SECURITY.md in Learn more (T521)", () => {
  const readme = realReadme();
  assert.deepEqual(readme.match(/^## .*$/gm), ["## Why \"sage\"?", "## Quick start", "## The board", "## What to say", "## How sage works", "## Learn more", "## Credits and licence"]);
  const learnMore = readme.slice(readme.indexOf("## Learn more"), readme.indexOf("## Credits"));
  assert.match(learnMore, /^- \[Rules held in code\]\(docs\/design\/rules-in-code\.md\)/m);
  assert.match(learnMore, /^- \[SECURITY\.md\]\(SECURITY\.md\)/m);
});

test("the README's lead and agent caps are the ones that the hook and the state tool hold (T521)", async () => {
  const { AGENT_CAPS } = await import("../packages/sage-core/logbook-fields.mjs");
  const helpers = readFileSync(join(ROOT, "packages/sage-claude/hooks/sage-hook.mjs"), "utf8").match(/^const LEAD_HELPERS = (\d+);$/m)[1];
  const readme = realReadme().replace(/\s+/g, " ");
  assert.ok(readme.includes(`with up to ${helpers} helpers at once`), "the lead's helpers");
  assert.ok(readme.includes(`at most ${AGENT_CAPS.max_agents} agents at once by default (\`max_agents\`), so one lead and its ${helpers} helpers fit, and all projects ${AGENT_CAPS.cap_total} (\`cap_total\`)`), "the caps");
});
