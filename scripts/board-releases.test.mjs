// The releases on the board (T996, the T995 design B that the owner approved in gate G141): the "Where we are" frame above
// the columns and in the chat board, the level that each card names, and the Releases tab. SAMPLE DATA from
// scripts/fixtures/board-releases.mjs; the logbooks on disk are made-up rows in a temporary folder.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readBoardSources } from "../packages/sage-core/board-reader.mjs";
import { buildBoardModel } from "../packages/sage-core/board-model.mjs";
import { renderBoardHtml, renderBoardText, renderReleasesHtml } from "../packages/sage-core/board-render.mjs";
import { columns } from "../packages/sage-core/picture.mjs";
import { NOW, releasesSource, releasesTables } from "./fixtures/board-releases.mjs";

const model = (tables = releasesTables()) => buildBoardModel([releasesSource(tables)], { now: NOW });
const cardOf = (html, id) => html.match(new RegExp(`<a class="card[^"]*" id="card-[^"]*" href="[^"]*" data-key="claude/sage-ff5ee2/${id}"[\\s\\S]*?</a>`))?.[0] ?? "";
const frameOf = text => text.split("### ◫ Where we are · sage \\(sample\\)\n```\n")[1]?.split("\n```")[0] ?? null;

test("T996: the chat board shows the frame of the releases that are not done, with each level and its word, after Needs you", () => {
  // T992 first in its column, so that the chat's first 5 cards of Backlog show it.
  const tables = releasesTables();
  tables.tasks.find(task => task.id === "T992").priority = "P0";
  const text = renderBoardText(model(tables));
  assert.equal(frameOf(text), [
    "╭─ Release 1.0 ──────────────────────────────╮",
    "│ In progress · 1 of 10 tasks done           │",
    "│ ╭─ Milestone 5: Sage feel ───────────────╮ │",
    "│ │ In progress · 0 of 8 tasks done        │ │",
    "│ │ ╭─ Task: Presentation skill ─────────╮ │ │",
    "│ │ │ In progress · the pilot            │ │ │",
    "│ │ ╰────────────────────────────────────╯ │ │",
    "│ │ ╭─ 7 tasks ──────────────────────────╮ │ │",
    "│ │ │ Waiting                            │ │ │",
    "│ │ ╰────────────────────────────────────╯ │ │",
    "│ ╰────────────────────────────────────────╯ │",
    "│ ╭─ 2 single tasks ───────────────────────╮ │",
    "│ │ 1 needs you · 1 done                   │ │",
    "│ ╰────────────────────────────────────────╯ │",
    "╰────────────────────────────────────────────╯",
    "╭─ Release 1.1 ──────────────────────────────╮",
    "│ In progress · 0 of 3 tasks done            │",
    "│ ╔═ Milestone 6: Faster reviews ══════════╗ │",
    "│ ║ Needs you · 0 of 2 tasks done          ║ │",
    "│ ║ Its breakdown waits for your answer.   ║ │",
    "│ ║ ╔═ Task: Review lanes ═══════════════╗ ║ │",
    "│ ║ ║ Needs you · the pilot              ║ ║ │",
    "│ ║ ╚════════════════════════════════════╝ ║ │",
    "│ ║ ╭─ 1 task ───────────────────────────╮ ║ │",
    "│ ║ │ Waiting                            │ ║ │",
    "│ ║ ╰────────────────────────────────────╯ ║ │",
    "│ ╚════════════════════════════════════════╝ │",
    "│ ╭─ 1 single task ────────────────────────╮ │",
    "│ │ 1 not started                          │ │",
    "│ ╰────────────────────────────────────────╯ │",
    "╰────────────────────────────────────────────╯",
    "╭─ Not in a release: 1 task ─────────────────╮",
    "│ 1 not started                              │",
    "╰────────────────────────────────────────────╯",
  ].join("\n"), text);
  assert.ok(text.indexOf("### 🔴 Needs you") < text.indexOf("### ◫ Where we are") && text.indexOf("### ◫ Where we are") < text.indexOf("### 📋 Backlog"));
  // The frame holds the milestones of a logbook with releases, so its Milestones section does not repeat them.
  assert.ok(!text.includes("### ◫ Milestones"), text);
  // Each chat card names its nearest level: its milestone, else its release, else no release.
  assert.ok(text.includes("**T985 Playbook\\: a new feature** · waiting · claude · sage \\(sample\\) · P2 · ◫ Milestone 5\\: Sage feel\\\n"), text);
  assert.ok(text.includes("**T996 Board footer links** · needs you · claude · sage \\(sample\\) · P2 · ◎ Release 1\\.0\\\n"), text);
  assert.ok(text.includes("**T992 Fix a typo in the guide** · not started · claude · sage \\(sample\\) · P0 · no release\\\n"), text);
});

test("T996: when every release is done, the frame shows the last one; a release that a cell names and the table lacks says so", () => {
  const tables = releasesTables();
  tables.tasks = tables.tasks.filter(task => ["T900", "T993"].includes(task.id));
  tables.milestones = []; tables.gates = [];
  assert.equal(frameOf(renderBoardText(model(tables))), [
    "╭─ Release 1.1 ──────────────────────────────╮",
    "│ Not started · 0 of 0 tasks done            │",
    "╰────────────────────────────────────────────╯",
  ].join("\n"), "1.1 is empty, so not started: it is the release that the frame shows");
  tables.releases = tables.releases.slice(0, 2);
  assert.match(frameOf(renderBoardText(model(tables))), /^╭─ Release 1\.0 ─+╮\n│ Done · 1 of 1 task done +│\n│ ╭─ 1 single task ─+╮ │\n│ │ 1 done +│ │\n│ ╰─+╯ │\n╰─+╯$/);
  tables.releases = [];
  const text = renderBoardText(model(tables));
  assert.ok(frameOf(text).startsWith("╭─ Release 1.0 ") && frameOf(text).includes("│ It is not in the logbook. Ask the chief to"), text);
});

test("T996: the web board shows the frame above the columns, and each card names its nearest level", () => {
  const html = renderBoardHtml(model(), { snapshot: false });
  const where = html.indexOf('<section class="where" data-rproject="sage-ff5ee2"'), board = html.indexOf('<main class="board"');
  assert.ok(where > 0 && where < board, "the frame is above the columns");
  const frame = html.slice(where, board);
  for (const part of ["Release 1.0", "Release 1.1", "Milestone 5: Sage feel", "Milestone 6: Faster reviews", "Task T984: Presentation skill", "2 single tasks", "Not in a release: 1 task"]) assert.ok(frame.includes(part), part);
  assert.ok(!frame.includes("Release 0.9"), "a done release is on the Releases tab, not in the frame");
  assert.ok(frame.includes('<div class="hb milestone here">'), "the milestone that needs you is a double box");
  assert.ok(cardOf(html, "T985").includes('<span class="tag prog" title="Milestone M5: Sage feel"><span class="pm" aria-hidden="true">◫</span>Milestone 5: Sage feel</span>'));
  assert.ok(cardOf(html, "T996").includes('<span class="tag rel"><span class="pm" aria-hidden="true">◎</span>Release 1.0</span>'));
  assert.ok(cardOf(html, "T992").includes('<span class="tag norel"'), cardOf(html, "T992"));
  assert.match(html, /<a href="\/" aria-current="page">Task board<\/a><a href="\/releases">Releases<\/a><a href="\/milestones">Milestones<\/a>/);
});

test("T996: the Releases tab lists the releases that are not done in row order, what is in no release, then the done ones", () => {
  const html = renderReleasesHtml(model());
  const main = html.slice(html.indexOf('<main class="page open" aria-label="Releases">'));
  const order = ["Release 1.0", "Release 1.1", "Not in a release", "Done releases", "Release 0.9"].map(part => main.indexOf(part));
  assert.ok(order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1])), `order ${order}`);
  assert.ok(main.includes('Release 1.0 <span class="pstate stw-run"><span aria-hidden="true">▶</span> in progress</span></h3><div class="rtext">1 of 10 tasks done</div>'), main);
  assert.ok(main.includes('Release 1.1 <span class="pstate stw-run"><span aria-hidden="true">▶</span> in progress</span></h3><div class="rtext">0 of 3 tasks done</div>'), main);
  assert.ok(main.includes('Release 0.9</b><span class="pstate stw-done"><span aria-hidden="true">✓</span> done</span></div><div class="rtext">1 of 1 task done</div>'), main);
  assert.ok(main.includes(`<a href="/milestone/${Buffer.from("claude/sage-ff5ee2/M5").toString("base64url")}"><b>Milestone 5: Sage feel</b></a>`));
  assert.ok(main.includes(`<a href="/task/${Buffer.from("claude/sage-ff5ee2/T996").toString("base64url")}"><b>Task T996: Board footer links</b></a>`));
  assert.ok(main.includes("Task T992: Fix a typo in the guide") && !main.includes("T994"), "a stopped task in no release is not listed");
  assert.match(html, /<a href="\/releases" aria-current="page">Releases<\/a>/);
  // The offline snapshot holds the tab as a section.
  assert.ok(renderBoardHtml(model()).includes('<section class="page" id="releases" aria-label="Releases">'));
});

test("T996: a logbook with no releases table, or an empty one, shows the board as before: no frame, no Releases tab, no release tag", t => {
  const root = mkdtempSync(join(tmpdir(), "sage-board-releases-")), project = join(root, "sample-abcdef");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(project);
  const sheet = (name, rows) => writeFileSync(join(project, `${name}.tsv`), rows.map(row => row.join("\t")).join("\n") + "\n");
  sheet("tasks", [["id", "title", "size", "risk", "route", "state", "branch", "pr", "round", "keys", "milestone"], ["T1", "Sample pilot", "small", "", "build", "building", "", "", "0", "", "M1"], ["T2", "Sample single", "small", "", "build", "framed", "", "", "0", "", ""]]);
  sheet("gates", [["id", "task", "question", "options", "recommendation", "default", "answer", "at"], ["G1", "T1", "Approve milestone M1? No task builds before you approve.", "approve|change|drop", "approve", "", "approve", ""]]);
  sheet("milestones", [["id", "name", "goal", "pilot", "gate", "at"], ["M1", "Sample milestone", "Sample goal.", "T1", "G1", ""]]);
  const views = () => {
    const sources = readBoardSources([{ id: "sample", path: root, label: "Sample source" }]);
    assert.deepEqual(sources[0].projects[0].diagnostics.filter(message => message.startsWith("releases")), []);
    const data = buildBoardModel(sources, { now: NOW });
    return { data, html: renderBoardHtml(data, { snapshot: false }), snapshot: renderBoardHtml(data), text: renderBoardText(data) };
  };
  const missing = views();
  sheet("releases", [["name", "goal", "at"]]);
  const empty = views();
  assert.deepEqual(missing.data.releases, []);
  for (const view of ["html", "snapshot", "text"]) assert.equal(empty[view], missing[view], view);
  assert.ok(!missing.html.includes('<section class="where"') && !missing.html.includes('href="/releases"') && !missing.html.includes("tag rel") && !missing.html.includes("no release"));
  assert.ok(!missing.snapshot.includes('id="releases"') && !missing.text.includes("Where we are") && !missing.text.includes("no release"));
  assert.ok(missing.text.includes("### ◫ Milestones\n- M1 Sample milestone"), "the Milestones section stays");
  // The same logbook with one release row shows the frame: the table is read from the logbook.
  sheet("releases", [["name", "goal", "at"], ["1.0", "Sample goal.", ""]]);
  const one = views();
  assert.equal(one.data.releases[0].releases[0].name, "1.0");
  assert.ok(one.html.includes('<section class="where"') && one.text.includes("╭─ Release 1.0 "), one.text);
});

test("T996: release names and goals from the logbook are escaped on the page and stay inside the chat's frame", () => {
  const tables = releasesTables(), hostile = "<script>alert(1)</script>\n```\n# x", goal = '<img src=x onerror="alert(2)">';
  tables.releases[1] = { ...tables.releases[1], name: hostile, goal };
  for (const row of [...tables.tasks, ...tables.milestones]) if (row.release === "1.0") row.release = hostile;
  const data = model(tables), html = renderBoardHtml(data, { snapshot: false }) + renderReleasesHtml(data) + renderBoardHtml(data);
  const markup = html.replace(/<script>[\s\S]*?<\/script>/g, "");
  assert.ok(!markup.includes("<script>alert(1)") && !markup.includes("<img src=x"), "no markup from the logbook");
  assert.ok(markup.includes("Release &lt;script&gt;alert(1)&lt;/script&gt;\n```\n# x") && markup.includes("&lt;img src=x onerror=&quot;alert(2)&quot;&gt;"));
  const text = renderBoardText(data), frame = frameOf(text);
  // The name is one line of the frame: its line breaks are spaces, so it can neither end the code block nor start a heading.
  assert.equal(text.split("\n").filter(line => line === "```").length, 2, text);
  assert.ok(frame.startsWith("╭─ Release <script>alert(1)</script> ``` #… ─"), frame);
  assert.ok(text.includes("· ◎ Release \\<script\\>alert\\(1\\)\\</script\\> \\`\\`\\` \\# x\\\n"), "the card's tag is Markdown text");
});

test("T996: a long or wide name is cut to fit, so every line of the chat's frame is 46 columns", () => {
  const tables = releasesTables();
  tables.releases[1].name = "版本".repeat(30);
  tables.milestones[0].name = "M".repeat(200);
  tables.tasks.find(task => task.id === "T984").title = "x".repeat(300);
  const lines = frameOf(renderBoardText(model(tables))).split("\n");
  assert.deepEqual([...new Set(lines.map(columns))], [46]);
  assert.ok(lines[0].startsWith("╭─ Release 版本") && lines[0].includes("…"), lines[0]);
});
