import "./test-env.mjs";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createBoardServer, loadBoardApp } from "../packages/sage-board/server.mjs";
import { readerUrl } from "../packages/sage-board/reader.mjs";
import { HOSTILE_TEXT, writeTasksLogbook } from "./fixtures/board-app.mjs";
import { measureContrast } from "./fixtures/contrast.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const APP = loadBoardApp(join(ROOT, "plugins/sage/board/app"));
let browser;
before(async () => { browser = await chromium.launch({ headless: true, ...(process.env.BOARD_BROWSER_PATH ? { executablePath: process.env.BOARD_BROWSER_PATH } : {}) }); });
after(async () => { await browser?.close(); });

async function freePort() {
  const socket = createServer();
  await new Promise((accept, reject) => { socket.once("error", reject); socket.listen(0, "127.0.0.1", accept); });
  const { port } = socket.address();
  await new Promise(accept => socket.close(accept));
  return port;
}

async function openBoard(t, options = {}, path = "/app/") {
  const dir = mkdtempSync(join(tmpdir(), "sage-board-tasks-browser-")), port = await freePort(), saved = process.env.SAGE_WORKTREES;
  process.env.SAGE_WORKTREES = join(dir, "worktrees");
  writeTasksLogbook(join(dir, "logbooks"), join(dir, "worktrees"), new Date().toISOString(), options);
  const server = createBoardServer({ sources: [{ id: "shared", path: join(dir, "logbooks"), label: "Shared" }], port, app: APP, settleReads: [] });
  await server.start();
  const base = `http://127.0.0.1:${port}`;
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: "dark" });
  t.after(async () => { await context.close(); await server.close(); if (saved === undefined) delete process.env.SAGE_WORKTREES; else process.env.SAGE_WORKTREES = saved; rmSync(dir, { recursive: true, force: true }); });
  const requests = [], problems = [];
  await context.route("**/*", route => { requests.push(route.request().url()); return route.request().url().startsWith(`${base}/`) ? route.continue() : route.abort(); });
  const page = await context.newPage();
  page.on("pageerror", error => problems.push(String(error)));
  page.on("console", message => { if (message.type() === "error" || /Content Security Policy|Refused to/.test(message.text())) problems.push(message.text()); });
  await page.goto(`${base}${path}`);
  await page.locator("main h1").waitFor();
  return { page, base, requests, problems, logbook: join(dir, "logbooks", "sample-app-abc123") };
}

const KEY = id => `shared/sample-app-abc123/${id}`;
const row = (page, id) => page.locator(`a.row[data-task="${KEY(id)}"]`);
const panelTitle = page => page.locator("#panel-h");
const groupTitles = page => page.locator(".group h2").allTextContents();

test("T1061, T1064: J2 and J3 are within two clicks of the Overview, and a Needs you row opens its full question in one", async t => {
  const { page, base, requests, problems } = await open(t);
  let clicks = 0;
  const click = async locator => { clicks++; await locator.click(); };

  await click(page.getByRole("link", { name: "Milestone 1: Board redesign" }));
  await click(row(page, "T3"));
  await panelTitle(page).filter({ hasText: "Sample shared limits" }).waitFor();
  assert.equal(clicks, 2, "J3: a milestone, then its task");
  assert.deepEqual(await page.locator(".steps .lbl").allTextContents(), ["Plandone", "Builddone", "Review 1 of 1running", "Merge"]);
  assert.equal(await page.locator(".steps li[aria-current=step] .lbl").textContent(), "Review 1 of 1running", "the current step");
  assert.equal(await page.locator(".sec-h .hint").textContent(), "Clean cycles: 0 of 1");
  assert.match(await page.locator(".last").textContent(), /R6 · qa started$/);
  const made = await page.locator("#tab-panel .files a").allTextContents();
  assert.deepEqual(made.filter(text => !["Brief", "Report"].includes(text)), ["limits-design.html", "notes.md", "Limits design note", "R5 · code-reviewer · done"], "J3: what its agents made");
  assert.equal(made.filter(text => text === "Brief").length, 3, "a brief and a report link for each of T3's three runs");
  assert.equal(await page.getByRole("link", { name: "limits-design.html" }).getAttribute("href"), "/pages/sample-app-abc123/T3/limits-design.html");
  assert.match(await page.getByRole("link", { name: "notes.md" }).getAttribute("href"), /^\/read\/[\w-]+\/page\/notes\.md$/, "a Markdown page opens in the reader");
  assert.match(await page.locator("#tab-panel").textContent(), /R5 · code-reviewer · done.*CLEAN\. The limits change is correct\..*sage_qa_t3_r6\.json/);

  clicks = 0;
  await page.goto(`${base}/app/`);
  await click(page.getByRole("link", { name: /^Tasks/ }));
  await click(page.getByRole("button", { name: "Priority" }));
  assert.equal(clicks, 2, "J2: tasks by priority");
  assert.deepEqual(await groupTitles(page), ["P0", "P1", "P2"]);

  clicks = 0;
  await page.goto(`${base}/app/`);
  await click(page.getByRole("link", { name: "Can a viewer copy a shared list into their own lists?" }));
  await page.locator("main h1").filter({ hasText: "Can a viewer copy a shared list into their own lists?" }).waitFor();
  assert.equal(clicks, 1, "J1: the full question in one click");
  assert.match(await page.locator("main").textContent(), /The answers.*A: yes, as a new private list.*C1's pick.*B: no/s, "the chief's pick first");
  await page.getByRole("link", { name: /Back to Needs you/ }).click();
  await page.getByRole("heading", { name: "Needs you" }).waitFor();
  await page.goto(`${base}/app/#tasks?task=${encodeURIComponent(KEY("T10"))}`);
  await panelTitle(page).filter({ hasText: "Sample sync design" }).waitFor();
  await page.getByRole("tab", { name: /Decisions/ }).click();
  assert.match(await page.locator("#tab-panel").textContent(), /Can a viewer copy a shared list.*Open: it waits for your answer/);
  assert.deepEqual(requests.filter(url => !url.startsWith(`${base}/`)), [], "no request outside 127.0.0.1");
  assert.deepEqual(problems, [], "no script error and no CSP refusal");
});

async function open(t, options, path) { return openBoard(t, options, path); }

test("T1061: the groups and filters work, and ended tasks stay collapsed until asked", async t => {
  const { page } = await open(t, {}, "/app/#tasks");
  assert.deepEqual(await groupTitles(page), ["Milestone 2: Offline sync", "Milestone 1: Board redesign", "No milestone", "Milestone 3: Sign-in rework"], "by milestone priority; an all-ended group last");
  assert.equal(await row(page, "T1").count(), 0, "T1 merged, so it is collapsed");
  await page.locator('[data-group="shared/sample-app-abc123/M1"] .more-ended').click();
  assert.equal(await row(page, "T1").count(), 1);
  assert.equal(await page.locator('[data-group="shared/sample-app-abc123/M1"] .more-ended').getAttribute("aria-expanded"), "true");
  assert.match(await row(page, "T3").textContent(), /^P2T3Sample shared limitsprovidersmay conflict · T40in progressC2 · CodexReview 1 of 1#12/);
  assert.match(await row(page, "T40").textContent(), /may conflict · T3/);
  assert.match(await row(page, "T3").textContent(), /may conflict · T40/);

  await page.getByRole("button", { name: "Chief" }).click();
  assert.deepEqual(await groupTitles(page), ["C1 · Claude", "C2 · Codex"]);
  await page.getByRole("combobox", { name: "Provider", exact: true }).selectOption("Codex");
  assert.deepEqual(await groupTitles(page), ["C2 · Codex"]);
  await page.getByRole("combobox", { name: "Kind", exact: true }).selectOption("ui");
  assert.deepEqual(await page.locator("a.row .id").allTextContents(), ["T30"]);
  await page.getByRole("combobox", { name: "Kind", exact: true }).selectOption("");
  await page.getByRole("combobox", { name: "State", exact: true }).selectOption("needs you");
  assert.deepEqual(await page.locator("a.row .id").allTextContents(), ["T30"]);
  await page.getByRole("combobox", { name: "Provider", exact: true }).selectOption("");
  await page.getByRole("combobox", { name: "Priority", exact: true }).selectOption("P0");
  assert.deepEqual(await page.locator("a.row .id").allTextContents(), ["T10"]);
  await page.getByRole("combobox", { name: "State", exact: true }).selectOption("");
  await page.getByRole("combobox", { name: "Priority", exact: true }).selectOption("");
  await page.getByRole("combobox", { name: "Chief", exact: true }).selectOption("C1 · Claude");
  await page.getByRole("button", { name: "State" }).click();
  assert.deepEqual(await groupTitles(page), ["needs you", "in progress", "waiting", "done"]);
});

test("T1061: the panel opens and closes from the keyboard, its tabs move with the arrow keys, and the focus returns to the row", async t => {
  const { page } = await open(t, {}, "/app/#tasks");
  await row(page, "T3").focus();
  await page.keyboard.press("Enter");
  await panelTitle(page).filter({ hasText: "Sample shared limits" }).waitFor();
  assert.equal(await page.evaluate(() => document.activeElement.id), "panel-h", "the focus moves into the panel");
  await page.getByRole("tab", { name: /Artifacts/ }).focus();
  await page.keyboard.press("ArrowRight");
  assert.equal(await page.evaluate(() => document.activeElement.textContent), "Log 8");
  assert.equal(await page.getByRole("tab", { name: /Log/ }).getAttribute("aria-selected"), "true");
  assert.match(await page.locator("#tab-panel").textContent(), /qa started/);
  await page.keyboard.press("Escape");
  await page.locator(".panel").waitFor({ state: "detached" });
  await page.waitForFunction(key => document.activeElement?.dataset.task === key, KEY("T3"));
  assert.equal(await page.evaluate(() => location.hash), "#tasks");
  await page.keyboard.press("Enter");
  await panelTitle(page).filter({ hasText: "Sample shared limits" }).waitFor();
  await page.getByRole("button", { name: "Close the task panel" }).click();
  await page.waitForFunction(key => document.activeElement?.dataset.task === key, KEY("T3"));
});

test("T1061 (F-T1061-1): markup, quotes, newlines and javascript: links in agent text, paths and branch names show as text, never as page code", async t => {
  const { page, problems } = await open(t, { hostile: true }, "/app/#tasks");
  assert.equal(await row(page, "T50").locator(".text").textContent(), HOSTILE_TEXT.title);
  await row(page, "T50").click();
  await panelTitle(page).filter({ hasText: HOSTILE_TEXT.title }).waitFor();
  const panel = page.locator(".panel");
  assert.match(await panel.textContent(), /sage\/t50-<b>bold<\/b>/, "the branch name is text");
  assert.deepEqual(await panel.locator(".callout code").allTextContents(), ["<script>window.hacked=3</script>\\nsrc/evil\\u202egnp\\u009b.js", "src/a\\u061cb\\u2060c\\u00add\\u180ee\\u{e0001}f.js", "javascript:window.hacked=4", "src/shared.js"], "a path shows its newline, its right-to-left override, its C1 control and every other invisible or format character, also outside the BMP, as escapes");
  assert.match(await panel.locator("#tab-panel").textContent(), /sage_x_t50_r9 <img src=x onerror=window\.hacked=9>\.json/);
  assert.match(await panel.locator("#tab-panel").textContent(), /<img src=x onerror="window\.hacked=6">label/);
  await page.getByRole("tab", { name: /Log/ }).click();
  assert.match(await panel.locator("#tab-panel").textContent(), /state building <a href="javascript:window\.hacked=5">click<\/a> · <i>why<\/i>/);
  await page.getByRole("tab", { name: /Decisions/ }).click();
  assert.match(await panel.locator("#tab-panel").textContent(), /Ship "it"\? <b>now<\/b>.*You answered: <script>window\.hacked=7<\/script>/);
  const injected = await page.evaluate(() => ({ hacked: window.hacked ?? null, markup: document.querySelectorAll("main img, main script, main b, main i, main [onerror]").length, scripted: [...document.querySelectorAll("main a")].filter(a => !/^(?:#|\/|https:)/.test(a.getAttribute("href") ?? "")).length }));
  assert.deepEqual(injected, { hacked: null, markup: 0, scripted: 0 });
  assert.deepEqual(problems, []);
});

test("T1061: text meets AA contrast on the Tasks page with the panel open, in the dark and the light theme", async t => {
  const { page } = await open(t, {}, `/app/#tasks?task=${encodeURIComponent(KEY("T3"))}`);
  await panelTitle(page).filter({ hasText: "Sample shared limits" }).waitFor();
  for (const theme of ["dark", "light"]) {
    if (theme === "light") await page.getByRole("button", { name: "Switch to the light theme" }).click();
    for (const tab of ["Artifacts", "Log", "Decisions"]) {
      await page.getByRole("tab", { name: new RegExp(tab) }).click();
      const low = (await page.evaluate(measureContrast)).filter(item => item.ratio < item.need);
      assert.deepEqual(low, [], `${theme}, ${tab}: every text meets AA`);
    }
  }
});

test("T1061: with 370 tasks the page shows the open ones and collapses the ended ones, and a group opens on demand", async t => {
  const { page } = await open(t, { many: 370 }, "/app/#tasks");
  assert.equal(await page.locator("a.row").count(), 7, "only the 7 open tasks render");
  assert.match(await page.locator(".toolbar [role=status]").textContent(), /^7 open · 363 ended$/);
  await page.locator('[data-group="none"] .more-ended').click();
  assert.equal(await page.locator('[data-group="none"] a.row').count(), 2 + 360, "T30, T40 and the 360 ended tasks with no milestone");
});

test("T1061: an open panel reads the task again when the logbook changes", async t => {
  const { page, logbook } = await open(t, {}, `/app/#tasks?task=${encodeURIComponent(KEY("T3"))}`);
  await page.locator(".last").filter({ hasText: "qa started" }).waitFor();
  appendFileSync(join(logbook, "decisions.tsv"), `${new Date().toISOString()}\tT3\tsample decision after the panel opened\t\n`);
  await page.locator(".last").filter({ hasText: "chief · sample decision after the panel opened" }).waitFor();
  assert.equal(await page.evaluate(() => document.activeElement.id), "panel-h", "a live update does not move the focus");
});

function editTasks(logbook, edit) {
  const file = join(logbook, "tasks.tsv"), [head, ...lines] = readFileSync(file, "utf8").trimEnd().split("\n"), columns = head.split("\t");
  const rows = lines.map(line => Object.fromEntries(line.split("\t").map((value, i) => [columns[i], value]))).flatMap(edit);
  writeFileSync(`${file}.new`, [head, ...rows.map(task => columns.map(column => task[column]).join("\t"))].join("\n") + "\n");
  renameSync(`${file}.new`, file);
}

function insideItsCellAndLeftOfThePanel(element) {
  const range = document.createRange();
  range.selectNodeContents(element);
  const lines = [...range.getClientRects()].filter(box => box.width > 0), panel = document.querySelector(".panel")?.getBoundingClientRect(), boxes = [];
  for (let node = element; node && !node.matches("a.row"); node = node.parentElement) {
    const style = getComputedStyle(node);
    if (style.overflowX !== "visible" || style.overflowY !== "visible" || node.parentElement.matches("a.row")) boxes.push(node.getBoundingClientRect());
  }
  return lines.length > 0 && lines.every(line => boxes.every(box => line.left >= box.left - 0.5 && line.right <= box.right + 0.5 && line.top >= box.top - 0.5 && line.bottom <= box.bottom + 0.5) && (!panel || line.right <= panel.left));
}

test("T1061 (F-T1061-7, F-T1061-10): the may-conflict flag and the chief tag show in full, with the panel closed and open, at 1440 and 1280 px", async t => {
  const { page, base } = await open(t, { edge: true }, "/app/#tasks");
  const cells = [["T3", ".badge.warn", "may conflict · T40"], ["T40", ".badge.warn", "may conflict · T3"], ["T3", ".chief", "C2 · Codex"], ["T40", ".chief", "C1 · Claude (stopped)"]];
  for (const width of [1440, 1280]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const panel of [false, true]) {
      await page.goto(`${base}/app/#tasks${panel ? `?task=${encodeURIComponent(KEY("T3"))}` : ""}`);
      await row(page, "T3").waitFor();
      if (panel) await panelTitle(page).filter({ hasText: "Sample shared limits" }).waitFor();
      for (const [id, cell, text] of cells) {
        const element = row(page, id).locator(cell);
        assert.equal(await element.textContent(), text);
        assert.equal(await element.evaluate(insideItsCellAndLeftOfThePanel), true, `${width} px, panel ${panel ? "open" : "closed"}: ${id}'s "${text}" shows in full`);
      }
    }
  }
});

test("T1061 (F-T1061-12): a title of 3,000 characters with no space wraps in the panel heading", async t => {
  const { page } = await open(t, { edge: true }, `/app/#tasks?task=${encodeURIComponent(KEY("T60"))}`);
  const heading = panelTitle(page).filter({ hasText: "SampleSample" });
  await heading.waitFor();
  assert.equal((await heading.textContent()).length, 3000);
  const box = await heading.evaluate(element => ({ scroll: element.scrollWidth, client: element.clientWidth, body: element.closest(".panel-body").scrollWidth - element.closest(".panel-body").clientWidth }));
  assert.deepEqual(box, { scroll: box.client, client: box.client, body: 0 }, "the whole title is inside the panel");
});

test("T1061 (F-T1061-3, F-T1061-11): an open panel says so when its task leaves the board, or when it cannot refresh", async t => {
  const { page, logbook } = await open(t, {}, `/app/#tasks?task=${encodeURIComponent(KEY("T30"))}`);
  await panelTitle(page).filter({ hasText: "Sample crash reports" }).waitFor();
  assert.equal(await page.locator(".stale").count(), 0, "no notice while the panel is current");
  editTasks(logbook, task => task.id === "T30" ? [] : [task]);
  await row(page, "T30").waitFor({ state: "detached" });
  await page.locator(".stale").filter({ hasText: "This task is no longer on the board. The panel shows what it read last." }).waitFor();
  assert.equal(await panelTitle(page).textContent(), "Sample crash reports", "the panel keeps what it read, under the notice");

  await page.goto(page.url().replace(/T30$/, "T3"));
  await panelTitle(page).filter({ hasText: "Sample shared limits" }).waitFor();
  await page.route("**/app/task/**", route => route.fulfill({ status: 500, body: "" }));
  appendFileSync(join(logbook, "decisions.tsv"), `${new Date().toISOString()}\tT3\tsample decision after the panel opened\t\n`);
  await page.locator(".stale").filter({ hasText: "The panel could not refresh. It shows what it read last, and tries again when the logbook changes." }).waitFor();
});

test("T1061 (F-T1061-13): a task with no route shows the route as not known and no steps", async t => {
  const { page, logbook } = await open(t, {}, "/app/#tasks");
  editTasks(logbook, task => [task.id === "T40" ? { ...task, route: "" } : task]);
  await page.goto(`${page.url().split("#")[0]}#tasks?task=${encodeURIComponent(KEY("T40"))}`);
  await panelTitle(page).filter({ hasText: "Sample crash fix" }).waitFor();
  await page.locator(".sec-h .hint").filter({ hasText: /^Route not known$/ }).waitFor();
  assert.equal(await page.locator(".steps li").count(), 0);
  assert.equal(await page.locator(".now").textContent(), "The logbook records no route for this task, so the board shows no steps.");
});

test("T1061 (F-T1061-33): a row's chief dot is green only for a live chief; a stopped chief is grey, a chief of unknown liveness has a hollow dot named so, and no chief has no dot", async t => {
  const { page } = await open(t, { chiefCases: true }, "/app/#tasks");
  const colour = name => page.evaluate(name => getComputedStyle(document.documentElement).getPropertyValue(name).trim(), name);
  const rgb = hex => `rgb(${hex.slice(1).match(/../g).map(part => parseInt(part, 16)).join(", ")})`;
  const [live, grey] = [rgb(await colour("--done")), rgb(await colour("--faint"))];
  const dot = id => row(page, id).locator(".chief").evaluate(cell => {
    const element = cell.querySelector(".dot"), style = element && getComputedStyle(element);
    return { text: cell.textContent, fill: style?.backgroundColor ?? null, ring: style ? style.boxShadow !== "none" || style.borderStyle !== "none" : null };
  });
  const unknown = async id => assert.equal(await row(page, id).getByRole("img", { name: "Chief liveness not known" }).count(), 1, `${id}: the hollow dot has a text alternative`);
  assert.deepEqual(await dot("T3"), { text: "C2 · Codex", fill: live, ring: false }, "a live chief (a run is running)");
  assert.deepEqual(await dot("T70"), { text: "C3 · Claude (stopped)", fill: grey, ring: false }, "a stopped chief (no heartbeat for 2 h)");
  assert.deepEqual(await dot("T40"), { text: "C1 · Claude", fill: "rgba(0, 0, 0, 0)", ring: true }, "a listed chief with no heartbeat: liveness not known");
  await unknown("T40");
  assert.deepEqual(await dot("T71"), { text: "C9", fill: "rgba(0, 0, 0, 0)", ring: true }, "a chief that chiefs.tsv does not list");
  await unknown("T71");
  assert.deepEqual(await dot("T72"), { text: "No chief", fill: null, ring: null }, "no chief, so no dot");
});

test("T1061 (F-T1061-26): a milestone problem in Needs you links to the Tasks page at its milestone", async t => {
  const { page } = await open(t, { stuck: true });
  const link = page.getByRole("link", { name: "Milestone 3: Sign-in rework is stuck" });
  assert.equal(await link.getAttribute("href"), `#tasks?milestone=${encodeURIComponent(KEY("M3"))}`);
  await link.click();
  await page.locator(`.group.focus[data-group="${KEY("M3")}"]`).waitFor();
});

test("T1064 (F-T1064-64, F-T1064-65, F-T1064-66): at 390 px each reader page shows one text column at nearly full width and scrolls only up and down; at 1280 px the side column stays", async t => {
  const { page, base, problems, logbook } = await open(t, { documents: true }, readerUrl(KEY("T3"), "brief", "R7"));
  const gate = join(logbook, "gates", "G4.json"), kept = JSON.parse(readFileSync(gate, "utf8"));
  kept.message.blocks.push({ t: "picture", title: "Where the work is", key: "The double box is the task that runs now.", frame: { box: "milestone", name: "Offline sync", state: "active", items: [{ box: "task", name: "T10 Share sheet", state: "building", here: true }] } });
  writeFileSync(gate, JSON.stringify(kept));
  const pages = { brief: [readerUrl(KEY("T3"), "brief", "R7"), "details[open] .body"], report: [readerUrl(KEY("T3"), "report", "R5"), ".result"], markdown: [readerUrl(KEY("T3"), "page", "retry-design.md"), ".doc .md"],
    compare: [readerUrl(KEY("T10"), "design", null, { view: "compare" }), ".pair .version"], question: [readerUrl(KEY("T10"), "question", "G4"), "main pre.md"] };
  const measure = text => page.evaluate(selector => ({ scroll: document.documentElement.scrollWidth, view: innerWidth, pre: document.querySelectorAll("main pre.md").length,
    text: [...document.querySelectorAll(selector)].map(e => { const s = getComputedStyle(e); return Math.round(e.getBoundingClientRect().width - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight)); }) }), text);
  for (const [name, [path, text]] of Object.entries(pages)) {
    await page.setViewportSize({ width: 390, height: 900 });
    await page.goto(`${base}${path}`);
    const narrow = await measure(text);
    assert.ok(narrow.scroll <= narrow.view, `${name} at 390 px scrolls sideways: ${narrow.scroll} px wide`);
    assert.ok(narrow.text.length > 0 && narrow.text.every(width => width >= 300), `${name} at 390 px: each text column is at least 300 px wide, saw ${narrow.text}`);
    if (name === "question") assert.ok(narrow.pre > 0, "the question shows its frame");
    if (name === "compare") assert.ok(await page.evaluate(() => { const [a, b] = document.querySelectorAll(".pair .version"); return b.getBoundingClientRect().top >= a.getBoundingClientRect().bottom; }), "the two versions stack");
    await page.setViewportSize({ width: 1280, height: 900 });
    const wide = await measure(text);
    assert.ok(wide.scroll <= wide.view, `${name} at 1280 px scrolls sideways`);
    if (name === "brief" || name === "report") assert.equal(await page.locator(".cols > .side").evaluate(e => Math.round(e.getBoundingClientRect().width)), 260, `${name}: the side column stays at 1280 px`);
    if (name === "compare") assert.ok(await page.evaluate(() => { const [a, b] = document.querySelectorAll(".pair .version"); return a.getBoundingClientRect().top === b.getBoundingClientRect().top; }), "the two versions stand side by side at 1280 px");
  }
  assert.deepEqual(problems, []);
});
