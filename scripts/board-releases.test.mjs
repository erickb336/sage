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
  assert.ok(!text.includes("### ◫ Milestones"), text);
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
  assert.deepEqual(data.releases, []);
  assert.ok(!text.includes("Where we are") && !text.includes("Release 1") && !text.includes("no release"), text);
  assert.ok(!needs.includes("logbook cannot be read"), needs);
});

test("F-T996-2: a dropped milestone with tasks still in it, in a done release that the frame does not show, keeps its line in the chat's Milestones section", () => {
  const tables = releasesTables();
  tables.tasks.push({ ...tables.tasks[0], id: "T950", title: "Old plan pilot", state: "framed", release: "", milestone: "M4" });
  tables.gates.push({ id: "G4", task: "T950", question: "Approve milestone M4? No task builds before you approve. Name: Old plan", options: "approve|change|drop", recommendation: "approve", default: "", answer: "drop", at: tables.gates[0].at });
  tables.milestones.push({ id: "M4", name: "Old plan", goal: "Sample goal.", pilot: "T950", gate: "G4", at: tables.milestones[0].at, release: "0.9" });
  const data = model(tables), text = renderBoardText(data);
  assert.equal(data.releases[0].releases[0].word, "done", "0.9 holds a done task and a stopped milestone: done");
  assert.ok(!frameOf(text).includes("Old plan"), "the frame does not show release 0.9");
  assert.ok(text.includes("### ◫ Milestones\n- Milestone 4\\: Old plan · stopped · dropped · 1 task still in it: ask the chief to take each task out of the milestone\n"), text.split("```").at(-1).slice(0, 400));
  assert.ok(!text.includes("- Milestone 5\\: Sage feel") && !text.includes("- Milestone 6\\: Faster reviews"));
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
  assert.ok(frame.includes(`<div class="hb task here now"><div class="hbt"><span class="hbk"><a href="${task("T984")}">Task: Presentation skill</a> <span class="faint">T984</span></span><span class="pstate stw-run"><span aria-hidden="true">▶</span> in progress</span></div><div class="hbl">You are here</div></div>`), frame);
  assert.ok(frame.includes('<span class="hbk">7 tasks</span><span class="pstate stw-wait"><span aria-hidden="true">⧗</span> waiting</span></div><div class="hbl">Waiting for Presentation skill</div>'), frame);
  assert.ok(frame.includes('<span class="hbk">1 task</span><span class="pstate stw-wait"><span aria-hidden="true">⧗</span> waiting</span></div><div class="hbl">Waiting for your approval</div>'), frame);
  assert.ok(frame.includes(`<a href="${task("T996")}">Board footer links</a> <span class="faint">T996</span>`), frame);
  assert.ok(!/Task T\d+:/.test(frame) && !/>T\d+ [A-Z]/.test(frame), "no task box or list line leads with its id");
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

const damagedReleases = t => logbookOnDisk(t, { releases: [["name", "goal", "at"], ["1.0", "Sample goal."]] });
function logbookOnDisk(t, sheets) {
  const root = mkdtempSync(join(tmpdir(), "sage-board-releases-")), project = join(root, "sample-abcdef");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(project);
  const sheet = (name, rows) => writeFileSync(join(project, `${name}.tsv`), rows.map(row => row.join("\t")).join("\n") + "\n");
  sheet("tasks", [["id", "title", "size", "risk", "route", "state", "branch", "pr", "round", "keys", "milestone", "release"], ["T1", "Sample first", "small", "", "build", "framed", "", "", "0", "", "", ""], ["T2", "Sample single", "small", "", "build", "framed", "", "", "0", "", "", "1.0"]]);
  for (const [name, header] of Object.entries({ runs: "id task role round candidate branch status tokens report started ended", findings: "task key round source severity summary triage reason status", ledger: "task pr sha kind cycle run at", gates: "id task question options recommendation default answer at", decisions: "at task decision why", milestones: "id name goal pilot gate at" })) sheet(name, [header.split(" ")]);
  sheet("releases", [["name", "goal", "at"], ["1.0", "Sample goal.", ""]]);
  for (const [name, rows] of Object.entries(sheets)) if (rows) sheet(name, rows); else rmSync(join(project, `${name}.tsv`));
  return readBoardSources([{ id: "sample", path: root, label: "Sample source" }])[0];
}

const TASKS_HEADER = ["id", "title", "size", "risk", "route", "state", "branch", "pr", "round", "keys", "milestone", "release"];
function noReleaseFrom(source, need, reason, name = "sample") {
  const data = buildBoardModel([source], { now: NOW }), text = renderBoardText(data), html = renderBoardHtml(data, { snapshot: false });
  const tab = renderReleasesHtml(data), releases = tab.slice(tab.indexOf('<main class="page open" aria-label="Releases">'));
  assert.deepEqual(data.releases, [], need);
  for (const view of [text, html]) assert.ok(!view.includes("Where we are") && !view.includes("Release 1.0"), view);
  const needs = text.split("### 🔴 Needs you\n")[1].split("\n### ")[0];
  assert.ok(needs.includes(`**1 · ${need}**`) && needs.includes(reason.replaceAll(".", "\\.")), needs);
  assert.ok(releases.includes(`<b>The releases of ${name} cannot be read.</b> ${reason}`), releases);
  assert.ok(!releases.includes("No releases yet") && !releases.includes("Release 1.0"), releases);
}
test("F-T996-28: a milestones table that cannot be read gives no release, so release 1.0 with open milestone work never reads done", t => {
  noReleaseFrom(logbookOnDisk(t, {
    tasks: [TASKS_HEADER, ["T1", "Sample first", "small", "", "build", "framed", "", "", "0", "", "M1", ""], ["T2", "Sample single", "small", "", "build", "merged", "", "", "0", "", "", "1.0"]],
    milestones: [["id", "name", "goal", "pilot", "gate", "at", "release"], ["M1", "Sample milestone"]] }),
  "The milestones table cannot be read", "milestones.tsv line 2 has 2 cells, and its header has 7.");
});
test("F-T996-29: a tasks table that cannot be read gives no release, so release 1.0 never reads \"not started, 0 of 0\"", t => {
  noReleaseFrom(logbookOnDisk(t, { tasks: [TASKS_HEADER, ["T1", "Sample first"]] }), "The Sample source logbook cannot be read", "tasks.tsv line 2 has 2 cells, and its header has 12.", "sample-abcdef");
});

test("F-T996-11: the Releases tab says that a releases table cannot be read, per project, and never \"No releases yet\" for it", t => {
  const damaged = damagedReleases(t);
  const main = data => { const html = renderReleasesHtml(data); return html.slice(html.indexOf('<main class="page open" aria-label="Releases">')); };
  const banner = '<b>The releases of sample cannot be read.</b> releases.tsv line 2 has 2 cells, and its header has 3. The board shows the tasks without their releases. Ask the chief to repair the logbook.';
  const alone = main(buildBoardModel([damaged], { now: NOW }));
  assert.ok(alone.includes(banner), alone);
  assert.ok(!alone.includes("No releases yet") && !alone.includes("To add one, ask the chief"), alone);
  const both = main(buildBoardModel([damaged, releasesSource()], { now: NOW }));
  assert.ok(both.includes(banner) && both.includes("Release 1.0") && !both.includes("No releases yet"), both);
  assert.match(both, /<div class="banner warn" data-rproject="sample-abcdef">/);
});

const releasesViews = data => {
  const tab = renderReleasesHtml(data), web = renderBoardHtml(data, { snapshot: false }), snapshot = renderBoardHtml(data);
  return { main: tab.slice(tab.indexOf('<main class="page open" aria-label="Releases">')), webLink: web.includes('<a href="/releases">Releases</a>'), snapshotLink: snapshot.includes('<a href="#releases">Releases</a>'), snapshotPage: snapshot.includes('<section class="page" id="releases"') };
};
const NO_RELEASE_TASKS = [TASKS_HEADER, ["T1", "Sample first", "small", "", "build", "framed", "", "", "0", "", "M1", ""], ["T2", "Sample single", "small", "", "build", "merged", "", "", "0", "", "", ""]];
const DAMAGED_MILESTONES = [["id", "name", "goal", "pilot", "gate", "at", "release"], ["M1", "Sample milestone"]];

test("F-T996-37: a project with no releases says \"No releases yet\" when its milestones table cannot be read, never that its releases cannot be read", t => {
  const data = buildBoardModel([logbookOnDisk(t, { releases: [["name", "goal", "at"]], tasks: NO_RELEASE_TASKS, milestones: DAMAGED_MILESTONES })], { now: NOW });
  const { main, webLink } = releasesViews(data);
  assert.ok(main.includes("<b>No releases yet.</b>") && !main.includes("cannot be read"), main);
  assert.ok(!webLink, "no release to show, and none hidden: no Releases tab");
  assert.ok(renderBoardText(data).includes("**1 · The milestones table cannot be read**"));
});

test("F-T996-40: when a damaged table hides the releases, the board links to the Releases tab, which says why", t => {
  const tasks = [TASKS_HEADER, ["T1", "Sample first", "small", "", "build", "framed", "", "", "0", "", "M1", ""], ["T2", "Sample single", "small", "", "build", "merged", "", "", "0", "", "", "1.0"]];
  const data = buildBoardModel([logbookOnDisk(t, { tasks, milestones: DAMAGED_MILESTONES })], { now: NOW });
  assert.deepEqual(data.releases, [], "no release shows");
  const { main, webLink, snapshotLink, snapshotPage } = releasesViews(data);
  assert.ok(webLink && snapshotLink && snapshotPage, "the web board, the snapshot's tabs and its pages reach the Releases tab");
  assert.ok(snapshotLink && main.includes("<b>The releases of sample cannot be read.</b> milestones.tsv line 2 has 2 cells, and its header has 7."), main);
});

test("F-T996-42: the Releases tab says nothing cannot be read above the releases that it shows, when an old logbook of the project is damaged", () => {
  const live = releasesSource(), old = releasesSource({ milestones: [], releases: [], gates: [], decisions: [] }, "codex");
  Object.assign(old.projects[0], { key: "codex/sage-old111", name: "sage-old111", checkout: null, displayName: null, old: { provider: "codex", of: live.projects[0].key }, diagnostics: ["tasks: line 2 has 2 cells, and its header has 12"] });
  const data = buildBoardModel([live, old], { now: NOW }), { main } = releasesViews(data);
  assert.ok(data.milestoneNeeds.some(need => need.kind === "logbook"), "Needs you still says that the old logbook cannot be read");
  assert.ok(main.includes("Release 1.0") && !main.includes("cannot be read"), main);
});

test("F-T996-36: an older logbook with programs.tsv (before the rename, T995) and a damaged milestones or tasks table gives no release", t => {
  const programs = [["id", "name", "goal", "pilot", "gate", "at", "release"]];
  const tasks = [TASKS_HEADER, ["T1", "Sample first", "small", "", "build", "framed", "", "", "0", "", "M1", ""], ["T2", "Sample single", "small", "", "build", "merged", "", "", "0", "", "", "1.0"]];
  noReleaseFrom(logbookOnDisk(t, { programs, tasks, milestones: DAMAGED_MILESTONES }), "The milestones table cannot be read", "milestones.tsv line 2 has 2 cells, and its header has 7.");
  noReleaseFrom(logbookOnDisk(t, { programs, tasks: [TASKS_HEADER, ["T1", "Sample first"]] }), "The Sample source logbook cannot be read", "tasks.tsv line 2 has 2 cells, and its header has 12.", "sample-abcdef");
});

test("F-T1012-1, F-T1012-2: a damaged programs.tsv is the milestones table's problem: Needs you and one Releases banner name programs.tsv", t => {
  const programs = [["id", "name", "goal", "pilot", "gate", "at", "release"], ["P1"]];
  const reason = "programs.tsv line 2 has 1 cell, and its header has 7.";
  noReleaseFrom(logbookOnDisk(t, { programs, milestones: null }), "The milestones table cannot be read", reason);
  const tasks = [TASKS_HEADER, ["T1", "Sample first", "small", "", "build", "framed", "", "", "0", "", "M1", ""], ["T2", "Sample single", "small", "", "build", "framed", "", "", "0", "", "", "1.0"]];
  const data = buildBoardModel([logbookOnDisk(t, { programs, tasks, milestones: null })], { now: NOW });
  assert.deepEqual(data.milestoneNeeds.map(need => [need.kind, need.text]), [["milestones", `milestones.tsv is missing. ${reason} The board shows the tasks without their milestones. Ask the chief to repair the logbook.`]]);
  const { main } = releasesViews(data);
  assert.equal(main.match(/<div class="banner warn" data-rproject=/g)?.length, 1, main);
  assert.ok(main.includes(`<b>The releases of sample cannot be read.</b> milestones.tsv is missing. ${reason}`), main);
});

test("F-T996-41: a damaged tasks or gates table makes no milestone advice that guesses: Needs you names the table and asks for a repair", () => {
  for (const [table, header] of [["tasks", 18], ["gates", 8]]) {
    const tables = releasesTables(), source = releasesSource(tables);
    delete tables[table];
    source.projects[0].diagnostics.push(`${table}: line 2 has 2 cells, and its header has ${header}`);
    const data = buildBoardModel([source], { now: NOW }), text = renderBoardText(data);
    const needs = text.split("### 🔴 Needs you\n")[1].split("\n### ")[0], strip = renderBoardHtml(data, { snapshot: false }).split('id="needstrip"')[1].split("</section>")[0];
    for (const view of [needs, strip]) assert.ok(!view.includes("Choose a new pilot") && !view.includes("propose M5 again") && !view.includes("drop the milestone"), view);
    const m5 = data.milestoneNeeds.find(need => need.milestone === "M5");
    assert.ok(m5 && m5.text.includes(`${table}.tsv`) && m5.text.endsWith("Ask the chief to repair the logbook."), JSON.stringify(m5));
    assert.ok(!strip.includes("Answer in the chat."), strip);
  }
});

test("F-T996-12, F-T996-15, F-T996-16: owner text names a milestone by its level, never by its raw id", () => {
  const data = model(), text = renderBoardText(data), html = renderBoardHtml(data, { snapshot: false });
  assert.ok(cardOf(html, "T1010").includes("<b>Needs you:</b> the breakdown of milestone 6."), cardOf(html, "T1010"));
  assert.ok(text.includes("⧗ Waits for your approval of milestone 6 \\(gate G3\\)\\."), text);
  assert.ok(cardOf(html, "T1011").includes("Waits for your approval of milestone 6 (gate G3)."), cardOf(html, "T1011"));
  const taskPage = renderBoardHtml(data, { taskKey: "claude/sage-ff5ee2/T1011", snapshot: false });
  assert.ok(taskPage.includes('<span aria-hidden="true">◫</span> Milestone 6: Faster reviews</a>'), "the task page's milestone link");
  assert.ok(taskPage.includes("The breakdown of milestone 6 (gate G3)"), "the task page's wait");
  const stuck = releasesTables();
  stuck.tasks.find(task => task.id === "T1010").state = "abandoned";
  const strip = renderBoardHtml(model(stuck), { snapshot: false }).split('id="needstrip"')[1].split("</section>")[0];
  assert.ok(strip.includes("Milestone 6: Faster reviews is stuck: the pilot T1010 was abandoned."), strip);
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
