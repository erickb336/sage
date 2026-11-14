import "./test-env.mjs";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createBoardServer, loadBoardApp } from "../packages/sage-board/server.mjs";
import { HOSTILE_TEXT, writeTasksLogbook } from "./fixtures/board-app.mjs";
import { graphProblems } from "./fixtures/graph-geometry.mjs";
import { measureContrast } from "./fixtures/contrast.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const APP = loadBoardApp(join(ROOT, "plugins/sage/board/app"));
const REPOSITORY = "https://github.com/sample-owner/sample-app";
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

async function open(t, options = {}, path = "/app/") {
  const dir = mkdtempSync(join(tmpdir(), "sage-board-prs-browser-")), port = await freePort(), saved = process.env.SAGE_WORKTREES;
  process.env.SAGE_WORKTREES = join(dir, "worktrees");
  writeTasksLogbook(join(dir, "logbooks"), join(dir, "worktrees"), new Date().toISOString(), { prs: true, ...options });
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
  return { page, base, requests, problems };
}

const KEY = id => `shared/sample-app-abc123/${id}`;
const row = (page, id) => page.locator(`li.prow[data-pr-task="${KEY(id)}"]`);
const groups = page => page.locator("section.group h2").allTextContents();
const ids = (page, group) => page.locator(`section[data-group="${group}"] li.prow .meta .mono`).allTextContents();
const graphFile = url => /\/app\/graph-[A-Z0-9]{8}\.js$/.test(url);

test("T1063: J5 is within two clicks of the Overview, and the graph's file loads only when the graph opens", async t => {
  const { page, base, requests, problems } = await open(t);
  let clicks = 0;
  const click = async locator => { clicks++; await locator.click(); };
  await click(page.getByRole("link", { name: /^Pull requests/ }));
  await page.locator("main h1", { hasText: "Pull requests" }).waitFor();
  assert.deepEqual(await groups(page), ["Needs you", "In review", "Repairing", "Ready to merge", "Waiting for another task", "Merged recently"]);
  assert.equal(requests.filter(graphFile).length, 0, "the list does not load the graph's file");
  await click(page.getByRole("button", { name: "Graph" }));
  await page.locator(".gnode").first().waitFor();
  assert.equal(clicks, 2, "J5: Pull requests, then Graph");
  assert.equal(requests.filter(graphFile).length, 1, "the graph's file loads once, when the graph opens");
  assert.deepEqual(await page.locator(".gnode .g-head b").allTextContents(), ["#14 · T5", "#12 · T3", "#17 · T8", "#15 · T6", "T13 · no PR yet"]);
  assert.equal(await page.locator(".react-flow__edge.waits").count(), 2, "T6 waits for T5, T13 waits for T6");
  assert.equal(await page.locator(".react-flow__edge.conflict").count(), 1, "T3 and T8 may conflict");
  assert.match(await page.locator(".legend").textContent(), /4 other items have no link: the list shows them\./);
  await page.getByRole("button", { name: "List" }).click();
  await page.getByRole("button", { name: "Graph" }).click();
  await page.locator(".gnode").first().waitFor();
  assert.equal(requests.filter(graphFile).length, 1, "a second opening reuses the loaded file");
  assert.deepEqual(requests.filter(url => !url.startsWith(`${base}/`)), [], "no request outside 127.0.0.1");
  assert.deepEqual(problems, [], "no script error and no CSP refusal");
});

const linksThroughBoxes = page => page.evaluate(() => {
  const boxes = [...document.querySelectorAll(".react-flow__node")].map(node => ({ id: node.dataset.id.split("/").pop(), rect: node.getBoundingClientRect() }));
  return [...document.querySelectorAll(".react-flow__edge")].map(edge => {
    const path = edge.querySelector(".react-flow__edge-path"), length = path.getTotalLength(), through = new Set();
    for (let at = 0; at <= length; at += 2) {
      const point = new DOMPoint(path.getPointAtLength(at).x, path.getPointAtLength(at).y).matrixTransform(path.getScreenCTM());
      for (const { id, rect } of boxes) if (point.x > rect.left + 2 && point.x < rect.right - 2 && point.y > rect.top + 2 && point.y < rect.bottom - 2) through.add(id);
    }
    return { link: edge.getAttribute("aria-label").replace(/shared\/sample-app-abc123\//g, ""), label: edge.querySelector(".react-flow__edge-text")?.textContent ?? "", through: [...through] };
  });
});

test("T1063: no link of the graph passes through a box, and a loop or a task that waits for itself shows its way back with a mark", async t => {
  const cases = [
    ["T3 to T13 skips a column, and T6 is in T3's row there", { waits: { T6: "T5", T7: "T5", T13: "T3,T7" } }, null],
    ["T3 and T8 may conflict, with T50 between them in one column", { hostile: true }, null],
    ["T6 and T13 wait for each other", { waits: { T6: "T13", T13: "T6" } }, ["Edge from T13 to T6", "loop"]],
    ["T6 waits for itself", { waits: { T6: "T6" } }, ["Edge from T6 to T6", "waits for itself"]],
  ];
  for (const [name, options, mark] of cases) {
    const { page, problems } = await open(t, options, "/app/#pull-requests");
    await page.getByRole("button", { name: "Graph" }).click();
    await page.locator(".react-flow__edge-path").first().waitFor({ state: "attached" });
    const links = await linksThroughBoxes(page);
    assert.deepEqual(links.filter(link => link.through.length), [], name);
    if (mark) assert.deepEqual(links.filter(link => link.label === mark[1]).map(link => link.link), [mark[0]], `${name}: the link that goes back carries the mark`);
    assert.deepEqual(problems, [], name);
  }
});

const drawnProblems = async page => graphProblems(await page.evaluate(() => ({
  boxes: [...document.querySelectorAll(".react-flow__node")].map(node => { const [x, y] = node.style.transform.match(/-?[\d.]+/g).map(Number); return { id: node.dataset.id.split("/").pop(), x, y, w: node.offsetWidth, h: node.offsetHeight }; }),
  links: [...document.querySelectorAll(".react-flow__edge")].map(edge => ({ id: edge.dataset.id.replace(/shared\/sample-app-abc123\//g, ""), d: edge.querySelector(".react-flow__edge-path").getAttribute("d") })),
})));

test("T1063: each link of the graph keeps its own line: two links never share a track, and a wait and a conflict of one pair both show", async t => {
  const cases = [
    ["F-T1063-15: T7 waits for T5; T6 for T5, T3 and T7; T13 for T5 and T7", { waits: { T7: "T5", T6: "T5,T3,T7", T13: "T5,T7" } }, "T5>T7 T5>T6 T3>T6 T7>T6 T5>T13 T7>T13 T3|T8"],
    ["F-T1063-17: T6 waits for T5, T13 for T7, T4 for T7 and T6, T2 for T3 and T13", { waits: { T6: "T5", T13: "T7", T4: "T7,T6", T2: "T3,T13" } }, "T5>T6 T7>T13 T7>T4 T6>T4 T3>T2 T13>T2 T3|T8"],
    ["F-T1063-19: T8 waits for T3, and the two may conflict", { waits: { T8: "T3" } }, "T5>T6 T6>T13 T3>T8 T3|T8"],
    ["F-T1063-20: ten tasks in one column all may conflict", { crowd: 10 }, `T5>T6 T6>T13 T3|T8 ${Array.from({ length: 10 }, (_, a) => Array.from({ length: 9 - a }, (_, k) => `T${80 + a}|T${81 + a + k}`)).flat().join(" ")}`],
  ];
  const sorted = text => text.split(" ").map(link => link.includes("|") ? link.split("|").sort().join("|") : link).sort();
  for (const [name, options, expected] of cases) {
    const { page, problems } = await open(t, options, "/app/#pull-requests");
    await page.getByRole("button", { name: "Graph" }).click();
    await page.locator(".react-flow__edge-path").first().waitFor({ state: "attached" });
    const drawn = await page.locator(".react-flow__edge").evaluateAll(edges => edges.map(edge => edge.dataset.id.replace(/^\w+:|shared\/sample-app-abc123\//g, "")));
    assert.deepEqual(sorted(drawn.join(" ")), sorted(expected), `${name}: the graph draws each link of the logbook, and no other`);
    assert.deepEqual(await drawnProblems(page), { through: [], shared: [] }, name);
    assert.deepEqual(problems, [], name);
  }
});

test("T1063: the list groups each PR by its next action and shows its task, chief, state, clean cycles, CI state and may-conflict flag", async t => {
  const { page } = await open(t, {}, "/app/#pull-requests");
  assert.deepEqual(await ids(page, "need"), ["T8"]);
  assert.deepEqual(await ids(page, "review"), ["T3"]);
  assert.deepEqual(await ids(page, "repair"), ["T7"]);
  assert.deepEqual(await ids(page, "ready"), ["T5"]);
  assert.deepEqual((await ids(page, "wait")).sort(), ["T11", "T13", "T4", "T6"]);
  assert.deepEqual(await ids(page, "merged"), ["T9"], "T12 merged 9 days ago, so it is not recent");
  const text = async id => (await row(page, id).innerText()).replace(/\s+/g, " ");
  assert.match(await text("T8"), /^#17 Sample search highlight C1 · Claude T8 may conflict · T3 #12 Checks failed on the recorded PR head\. needs you 0 of 1 clean cycles CI fails/);
  assert.match(await text("T3"), /^#12 Sample shared limits C2 · Codex T3 Milestone 1: Board redesign may conflict · T40 may conflict · T8 #17 in progress 0 of 1 clean cycles CI passes/);
  assert.match(await text("T7"), /^#16 Sample offline banner C2 · Codex T7 .* in progress Clean cycles not known · 1 needed CI not known/);
  assert.match(await text("T5"), /^#14 Sample retry backoff C1 · Claude T5 .* in progress 1 of 1 clean cycles CI passes/);
  assert.match(await text("T6"), /^#15 Sample sync log .* Waits for T5 \(in progress\)\. in progress 0 of 1 clean cycles CI not known/);
  assert.match(await text("T13"), /^no PR Sample sync export .* Waits for T6 \(in progress\)\. waiting – – –$/);
  assert.match(await text("T9"), /^#11 Sample conflict rule .* done 1 of 1 clean cycles CI passes merged 5 h ago$/);
  assert.equal(await page.getByRole("status").filter({ hasText: /open PRs?$/ }).textContent(), "5 open PRs");
  assert.equal(await page.locator(".nav a", { hasText: "Pull requests" }).locator(".count").textContent(), "5");
});

test("T1063: each PR number links to GitHub, each title opens the task's side panel, and the panel closes back to the page", async t => {
  const { page, requests, base } = await open(t, {}, "/app/#pull-requests");
  const pr = row(page, "T5").getByRole("link", { name: "Pull request 14 on GitHub" });
  assert.deepEqual([await pr.getAttribute("href"), await pr.getAttribute("target"), await pr.getAttribute("rel")], [`${REPOSITORY}/pull/14`, "_blank", "noopener noreferrer"]);
  assert.equal(await row(page, "T7").locator(".num a").count(), 0, "no repository known: the number is plain text");
  await row(page, "T5").getByRole("link", { name: "Sample retry backoff" }).click();
  await page.locator("#panel-h", { hasText: "Sample retry backoff" }).waitFor();
  assert.equal(await page.evaluate(() => location.hash), `#pull-requests?task=${encodeURIComponent(KEY("T5"))}`);
  assert.equal(await row(page, "T5").getAttribute("aria-current"), "true");
  await page.keyboard.press("Escape");
  await page.locator(".panel").waitFor({ state: "detached" });
  assert.equal(await page.evaluate(() => location.hash), "#pull-requests");
  await page.waitForFunction(key => document.activeElement?.dataset.task === key, KEY("T5"));
  await page.getByRole("button", { name: "Graph" }).click();
  await page.locator(`.gnode[data-task="${KEY("T6")}"]`).click();
  await page.locator("#panel-h", { hasText: "Sample sync log" }).waitFor();
  assert.equal(await page.locator(".gnode").count(), 5, "the graph stays open under the panel");
  assert.deepEqual(requests.filter(url => !url.startsWith(`${base}/`)), []);
});

test("T1063: the keyboard reaches each link of the list and the graph, and Enter opens the task", async t => {
  const { page } = await open(t, {}, "/app/#pull-requests");
  await page.getByRole("button", { name: "List" }).focus();
  const stops = [];
  for (let i = 0; i < 4; i++) { await page.keyboard.press("Tab"); stops.push(await page.evaluate(() => document.activeElement.textContent)); }
  assert.deepEqual(stops, ["Graph", "#17", "Sample search highlight", "#12"], "the view switch, then each row's number and title");
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Enter");
  await page.locator("#panel-h", { hasText: "Sample search highlight" }).waitFor();
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => document.activeElement?.textContent === "Sample search highlight");
  await page.getByRole("button", { name: "Graph" }).focus();
  await page.keyboard.press("Enter");
  await page.locator(".gnode").first().waitFor();
  assert.equal(await page.getByRole("button", { name: "Graph" }).getAttribute("aria-pressed"), "true");
  let reached = null;
  for (let i = 0; i < 6 && !reached; i++) { await page.keyboard.press("Tab"); reached = await page.evaluate(() => document.activeElement.closest(".gnode") && document.activeElement.dataset.task); }
  assert.equal(reached, KEY("T5"), "Tab reaches the first box of the graph");
  await page.keyboard.press("Enter");
  await page.locator("#panel-h", { hasText: "Sample retry backoff" }).waitFor();
});

test("T1063: markup in a title, a question, a branch name and a path shows as text on the page, in the graph and in the panel", async t => {
  const { page, problems } = await open(t, { hostile: true }, "/app/#pull-requests");
  const hostile = row(page, "T50");
  assert.equal(await hostile.locator(".ttl").textContent(), HOSTILE_TEXT.title);
  assert.equal(await hostile.locator(".why").textContent(), `<img src=x onerror="window.hacked=11">Merge <b>now</b>?`);
  assert.match(await hostile.locator(".meta").textContent(), /may conflict · T8 #17/);
  await hostile.locator(".ttl").click();
  const panel = page.locator(".panel");
  await page.locator("#panel-h", { hasText: HOSTILE_TEXT.title }).waitFor();
  assert.match(await panel.textContent(), /sage\/t50-<b>bold<\/b>/, "the branch name is text");
  assert.ok((await panel.locator(".callout code").allTextContents()).includes("<script>window.hacked=3</script>\\nsrc/evil\\u202egnp\\u009b.js"), "a path shows its newline and invisible characters as escapes");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Graph" }).click();
  await page.locator(`.gnode[data-task="${KEY("T50")}"]`).waitFor();
  assert.equal(await page.locator(`.gnode[data-task="${KEY("T50")}"] .g-title`).textContent(), HOSTILE_TEXT.title);
  const injected = await page.evaluate(() => ({ hacked: window.hacked ?? null, markup: document.querySelectorAll("main img, main script, main b:not(.g-head b), main i, main [onerror]").length, scripted: [...document.querySelectorAll("main a")].filter(a => !/^(?:#|\/|https:)/.test(a.getAttribute("href") ?? "")).length }));
  assert.deepEqual(injected, { hacked: null, markup: 0, scripted: 0 });
  assert.deepEqual(problems, []);
});

test("T1063: text meets AA contrast on the list and the graph, in the dark and the light theme", async t => {
  const { page } = await open(t, {}, "/app/#pull-requests");
  for (const theme of ["dark", "light"]) {
    if (theme === "light") await page.getByRole("button", { name: "Switch to the light theme" }).click();
    await page.getByRole("button", { name: "List" }).click();
    await row(page, "T5").waitFor();
    assert.deepEqual((await page.evaluate(measureContrast)).filter(item => item.ratio < item.need), [], `${theme}, list`);
    await page.getByRole("button", { name: "Graph" }).click();
    await page.locator(".gnode").first().waitFor();
    assert.deepEqual((await page.evaluate(measureContrast)).filter(item => item.ratio < item.need), [], `${theme}, graph`);
  }
});
