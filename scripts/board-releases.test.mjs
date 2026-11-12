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
    "│ │ ╔═ Task: Presentation skill ═════════╗ │ │",
    "│ │ ║ In progress · you are here         ║ │ │",
    "│ │ ╚════════════════════════════════════╝ │ │",
    "│ │ ╭─ 7 tasks ──────────────────────────╮ │ │",
    "│ │ │ Waiting for Presentation skill     │ │ │",
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
    "│ ║ │ Waiting for your approval          │ ║ │",
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
  for (const part of ["Release 1.0", "Release 1.1", "Milestone 5: Sage feel", "Milestone 6: Faster reviews", "Task: Presentation skill", "2 single tasks", "Not in a release: 1 task"]) assert.ok(frame.includes(part), part);
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
  assert.ok(main.includes(`<a href="/task/${Buffer.from("claude/sage-ff5ee2/T996").toString("base64url")}"><b>Task: Board footer links</b></a> <span class="faint">T996</span><span class="pstate stw-need">`), "a task row leads with its title; its id is secondary text");
  assert.ok(main.includes("Task: Fix a typo in the guide") && !main.includes("T994"), "a stopped task in no release is not listed");
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
  assert.ok(missing.text.includes("### ◫ Milestones\n- Milestone 1\\: Sample milestone"), "the Milestones section stays");
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

test("F-T996-1: a releases table that cannot be read is a Needs you item, and no release that a cell names shows as not in the logbook", t => {
  const data = buildBoardModel([damagedReleases(t)], { now: NOW });
  const text = renderBoardText(data), html = renderBoardHtml(data, { snapshot: false }) + renderReleasesHtml(data);
  const needs = text.split("### 🔴 Needs you\n")[1].split("\n### ")[0];
  assert.equal(needs, "**1 · The releases table cannot be read** · Sample source · sample\n> releases\\.tsv line 2 has 2 cells, and its header has 3\\. The board shows the tasks without their releases\\. Ask the chief to repair the logbook\\.\n");
  assert.equal(data.counts.needsOwner, 1);
  for (const view of [text, html]) assert.ok(!view.includes("not in the logbook"), "no stand-in release");
  // As for a damaged milestones table, the tasks show without their releases: no frame and no release tag.
  assert.deepEqual(data.releases, []);
  assert.ok(!text.includes("Where we are") && !text.includes("Release 1") && !text.includes("no release"), text);
  // The logbook's other tables still read: the board is not "cannot be read" for the logbook.
  assert.ok(!needs.includes("logbook cannot be read"), needs);
});

test("F-T996-2: a dropped milestone with tasks still in it, in a done release that the frame does not show, keeps its line in the chat's Milestones section", () => {
  const tables = releasesTables();
  // Release 0.9 is done and is not the last release: its milestone M4 is dropped (gate G4: drop), and T950 is still in it.
  tables.tasks.push({ ...tables.tasks[0], id: "T950", title: "Old plan pilot", state: "framed", release: "", milestone: "M4" });
  tables.gates.push({ id: "G4", task: "T950", question: "Approve milestone M4? No task builds before you approve. Name: Old plan", options: "approve|change|drop", recommendation: "approve", default: "", answer: "drop", at: tables.gates[0].at });
  tables.milestones.push({ id: "M4", name: "Old plan", goal: "Sample goal.", pilot: "T950", gate: "G4", at: tables.milestones[0].at, release: "0.9" });
  const data = model(tables), text = renderBoardText(data);
  assert.equal(data.releases[0].releases[0].word, "done", "0.9 holds a done task and a stopped milestone: done");
  assert.ok(!frameOf(text).includes("Old plan"), "the frame does not show release 0.9");
  assert.ok(text.includes("### ◫ Milestones\n- Milestone 4\\: Old plan · stopped · dropped · 1 task still in it: ask the chief to take each task out of the milestone\n"), text.split("```").at(-1).slice(0, 400));
  // The milestones that the frame shows are not repeated there.
  assert.ok(!text.includes("- Milestone 5\\: Sage feel") && !text.includes("- Milestone 6\\: Faster reviews"));
  // With M4 not dropped and no task left, the section goes, as before.
  tables.tasks = tables.tasks.filter(task => task.id !== "T950");
  assert.ok(!renderBoardText(model(tables)).includes("### ◫ Milestones"));
});

test("F-T996-5: the chat's Milestone approval entry and the web approval band name the level as the milestone tag does", () => {
  const data = model(), text = renderBoardText(data), html = renderBoardHtml(data, { snapshot: false });
  assert.ok(text.includes("#### ◫ Milestone approval\n**1 · Milestone 6\\: Faster reviews** · needs you · claude · sage \\(sample\\) · pilot T1010 · gate G3\n"), text);
  assert.ok(cardOf(html, "T1010").includes('Milestone approval<span class="bk">· Milestone 6: Faster reviews · gate G3</span>'), cardOf(html, "T1010"));
  assert.ok(!text.split("### ◫ Where we are")[0].includes("M6 Faster reviews") && !cardOf(html, "T1010").includes("M6 Faster reviews"));
});

test("F-T996-7, F-T996-10: the web frame names each task by its title with its id after it, marks the task in progress \"you are here\", and says what a waiting box waits for; each link opens its page", () => {
  const html = renderBoardHtml(model(), { snapshot: false });
  const frame = html.slice(html.indexOf('<section class="where"'), html.indexOf('<main class="board"'));
  const task = id => `/task/${Buffer.from(`claude/sage-ff5ee2/${id}`).toString("base64url")}`;
  // The task in progress is "here": a double box, with "You are here".
  assert.ok(frame.includes(`<div class="hb task here now"><div class="hbt"><span class="hbk"><a href="${task("T984")}">Task: Presentation skill</a> <span class="faint">T984</span></span><span class="pstate stw-run"><span aria-hidden="true">▶</span> in progress</span></div><div class="hbl">You are here</div></div>`), frame);
  assert.ok(frame.includes('<span class="hbk">7 tasks</span><span class="pstate stw-wait"><span aria-hidden="true">⧗</span> waiting</span></div><div class="hbl">Waiting for Presentation skill</div>'), frame);
  assert.ok(frame.includes('<span class="hbk">1 task</span><span class="pstate stw-wait"><span aria-hidden="true">⧗</span> waiting</span></div><div class="hbl">Waiting for your approval</div>'), frame);
  // A task of a list box: its word, its title (a link to its page), then its id.
  assert.ok(frame.includes(`<a href="${task("T996")}">Board footer links</a> <span class="faint">T996</span>`), frame);
  assert.ok(!/Task T\d+:/.test(frame) && !/>T\d+ [A-Z]/.test(frame), "no task box or list line leads with its id");
  // Each link of the frame opens a page: a task's, or a milestone's.
  const links = [...frame.matchAll(/<a href="([^"]*)">([^<]*)<\/a>/g)];
  assert.ok(links.length >= 8, `${links.length} links`);
  for (const [, href, name] of links) assert.match(href, /^\/(task|milestone)\/[A-Za-z0-9_-]+$/, name);
  for (const id of ["T984", "T996", "T993", "T1010", "T1012", "T992"]) assert.ok(frame.includes(`<a href="${task(id)}">`), id);
});

test("F-T996-10: a box of waiting tasks that wait for different tasks keeps its word alone; tasks that can never start say so", () => {
  const tables = releasesTables();
  tables.tasks.find(task => task.id === "T986").waits = "T996";
  const frame = frameOf(renderBoardText(model(tables)));
  assert.ok(frame.includes("│ │ │ Waiting                            │ │ │"), frame);
  const stopped = releasesTables();
  stopped.tasks.find(task => task.id === "T984").state = "abandoned";
  assert.ok(frameOf(renderBoardText(model(stopped))).includes("Waiting · they cannot start"), frameOf(renderBoardText(model(stopped))));
});

/** A logbook on disk whose releases table cannot be read: line 2 has 2 cells, and the header has 3 (SAMPLE DATA). */
function damagedReleases(t) {
  const root = mkdtempSync(join(tmpdir(), "sage-board-releases-")), project = join(root, "sample-abcdef");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(project);
  const sheet = (name, rows) => writeFileSync(join(project, `${name}.tsv`), rows.map(row => row.join("\t")).join("\n") + "\n");
  sheet("tasks", [["id", "title", "size", "risk", "route", "state", "branch", "pr", "round", "keys", "milestone", "release"], ["T1", "Sample first", "small", "", "build", "framed", "", "", "0", "", "", ""], ["T2", "Sample single", "small", "", "build", "framed", "", "", "0", "", "", "1.0"]]);
  for (const [name, header] of Object.entries({ runs: "id task role round candidate branch status tokens report started ended", findings: "task key round source severity summary triage reason status", ledger: "task pr sha kind cycle run at", gates: "id task question options recommendation default answer at", decisions: "at task decision why", milestones: "id name goal pilot gate at" })) sheet(name, [header.split(" ")]);
  sheet("releases", [["name", "goal", "at"], ["1.0", "Sample goal."]]);
  return readBoardSources([{ id: "sample", path: root, label: "Sample source" }])[0];
}

test("F-T996-11: the Releases tab says that a releases table cannot be read, per project, and never \"No releases yet\" for it", t => {
  const damaged = damagedReleases(t);
  const main = data => { const html = renderReleasesHtml(data); return html.slice(html.indexOf('<main class="page open" aria-label="Releases">')); };
  const banner = '<b>The releases of sample cannot be read.</b> releases.tsv line 2 has 2 cells, and its header has 3. The board shows the tasks without their releases. Ask the chief to repair the logbook.';
  // The damaged logbook alone: the tab says why it shows no release, and asks for a repair, not for new releases.
  const alone = main(buildBoardModel([damaged], { now: NOW }));
  assert.ok(alone.includes(banner), alone);
  assert.ok(!alone.includes("No releases yet") && !alone.includes("To add one, ask the chief"), alone);
  // With a second project whose releases read: its releases show, and the damaged project keeps its own line, which the project filter shows for it.
  const both = main(buildBoardModel([damaged, releasesSource()], { now: NOW }));
  assert.ok(both.includes(banner) && both.includes("Release 1.0") && !both.includes("No releases yet"), both);
  assert.match(both, /<div class="banner warn" data-rproject="sample-abcdef">/);
});

test("F-T996-12, F-T996-15, F-T996-16: owner text names a milestone by its level, never by its raw id", () => {
  const data = model(), text = renderBoardText(data), html = renderBoardHtml(data, { snapshot: false });
  // The pilot's card: the breakdown of milestone 6, as the design says it.
  assert.ok(cardOf(html, "T1010").includes("<b>Needs you:</b> the breakdown of milestone 6."), cardOf(html, "T1010"));
  // A task that waits for the breakdown, on the chat's Backlog and on its card.
  assert.ok(text.includes("⧗ Waits for your approval of milestone 6 \\(gate G3\\)\\."), text);
  assert.ok(cardOf(html, "T1011").includes("Waits for your approval of milestone 6 (gate G3)."), cardOf(html, "T1011"));
  // The task page's milestone link and its wait.
  const taskPage = renderBoardHtml(data, { taskKey: "claude/sage-ff5ee2/T1011", snapshot: false });
  assert.ok(taskPage.includes('<span aria-hidden="true">◫</span> Milestone 6: Faster reviews</a>'), "the task page's milestone link");
  assert.ok(taskPage.includes("The breakdown of milestone 6 (gate G3)"), "the task page's wait");
  // A stuck milestone in "Needs you, not on a card".
  const stuck = releasesTables();
  stuck.tasks.find(task => task.id === "T1010").state = "abandoned";
  const strip = renderBoardHtml(model(stuck), { snapshot: false }).split('id="needstrip"')[1].split("</section>")[0];
  assert.ok(strip.includes("Milestone 6: Faster reviews is stuck: the pilot T1010 was abandoned."), strip);
  // The gate's own question keeps the text of its row ("Approve milestone M6?"); the tag's tooltip and the Milestone filter list keep the id.
  const kept = view => view.replace(/title="Milestone M6: Faster reviews"/g, "").replace(/<option[^>]*>[^<]*<\/option>/g, "");
  for (const view of [strip, text, html, taskPage]) for (const old of ["Milestone M6", "of M6", "M6 breakdown", "M6 Faster reviews"]) assert.ok(!kept(view).includes(old), old);
});

test("F-T996-13: a dropped milestone with tasks still in it gives its next step in the frame, on the web and in the chat", () => {
  const tables = releasesTables();
  tables.gates.find(gate => gate.id === "G3").answer = "drop";
  const data = model(tables), frame = frameOf(renderBoardText(data));
  assert.ok(frame.includes("│ ╭─ Milestone 6: Faster reviews ──────────╮ │\n│ │ Stopped · 0 of 2 tasks done            │ │\n│ │ 2 tasks still in it: ask the chief to  │ │\n│ │ take each task out of the milestone.   │ │"), frame);
  const html = renderBoardHtml(data, { snapshot: false }), web = html.slice(html.indexOf('<section class="where"'), html.indexOf('<main class="board"'));
  assert.ok(web.includes('<div class="hbl">2 tasks still in it: ask the chief to take each task out of the milestone.</div>'), web);
});
