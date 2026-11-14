import "./test-env.mjs";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createBoardServer, loadBoardApp } from "../packages/sage-board/server.mjs";
import { HOSTILE_TEXT, writeTasksLogbook } from "./fixtures/board-app.mjs";
import { measureContrast } from "./fixtures/contrast.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const APP = loadBoardApp(join(ROOT, "plugins/sage/board/app"));
const SHOTS = process.env.BOARD_SHOTS_DIR ?? null;
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

async function open(t, options = {}, { path = "/app/", theme = "dark", width = 1440 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "sage-board-agents-page-")), port = await freePort(), saved = process.env.SAGE_WORKTREES;
  process.env.SAGE_WORKTREES = join(dir, "worktrees");
  writeTasksLogbook(join(dir, "logbooks"), join(dir, "worktrees"), new Date().toISOString(), { agents: true, chiefCases: true, ...options });
  const server = createBoardServer({ sources: [{ id: "shared", path: join(dir, "logbooks"), label: "Shared" }], port, app: APP, settleReads: [] });
  await server.start();
  const base = `http://127.0.0.1:${port}`;
  const context = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme: theme, reducedMotion: "reduce" });
  t.after(async () => { await context.close(); await server.close(); if (saved === undefined) delete process.env.SAGE_WORKTREES; else process.env.SAGE_WORKTREES = saved; rmSync(dir, { recursive: true, force: true }); });
  const requests = [], problems = [];
  await context.route("**/*", route => { requests.push(route.request().url()); return route.request().url().startsWith(`${base}/`) ? route.continue() : route.abort(); });
  const page = await context.newPage();
  page.on("pageerror", error => problems.push(String(error)));
  page.on("console", message => { if (message.type() === "error" || /Content Security Policy|Refused to/.test(message.text())) problems.push(message.text()); });
  if (theme === "light") await page.addInitScript(() => localStorage.setItem("board-theme", "light"));
  await page.goto(`${base}${path}`);
  await page.locator("main h1").waitFor();
  return { page, base, requests, problems };
}

const KEY = id => `shared/sample-app-abc123/${id}`;
const shoot = async (page, name) => { if (!SHOTS) return; mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: join(SHOTS, name), fullPage: true }); };
const box = (page, chief) => page.locator(`section.chief-box[data-chief="${KEY(chief)}"]`);

test("T1062: J4 is one click from the Overview: the top bar counts open the Agents page, with each chief, its leads and helpers, and the queue", async t => {
  const { page, base, requests, problems } = await open(t);
  const counts = page.locator("header.top a.limit");
  assert.deepEqual(await counts.allTextContents(), ["Agents 7 of 20 · C1 4 · C2 3 · 3 queued", "Leads 4 of 5"], "running agents of both chiefs against the logbook's limit");
  let clicks = 0;
  await counts.first().click(); clicks++;
  await page.locator("main h1", { hasText: "Agents" }).waitFor();
  assert.equal(clicks, 1, "J4: one click from the Overview");
  assert.deepEqual(await page.locator(".agents-kpis .kpi").allTextContents(), ["7 of 20agents running", "4 of 5leads", "3queued", "0need a look"]);
  assert.deepEqual(await page.locator("section.chief-box h2").allTextContents(), ["C1 · Claude", "C2 · Codex", "C3 · Claude"], "every chief, Claude and Codex alike");
  assert.deepEqual(await box(page, "C1").locator(".acard-h .lead-id b").allTextContents(), ["lead · R25", "lead · R20"], "the oldest lead first");
  const r20 = box(page, "C1").locator("section.acard", { has: page.locator('[data-run="R20"]') });
  assert.deepEqual(await r20.locator(".arow .who").allTextContents(), ["code-reviewerR22", "security-reviewerR23"], "a lead's running helpers; the ended one is collapsed");
  assert.match(await r20.locator(".acard-f").textContent(), /^2 helpers running · 1 queuedShow 1 ended helper$/);
  assert.match(await r20.locator(".acard-h").textContent(), /^lead · R20 running1 h 1\d minT2 · Sample chief recordsopus$/);
  await r20.getByRole("button", { name: "Show 1 ended helper" }).click();
  assert.match(await r20.locator(".arow.ended").textContent(), /^implementerR21Donesonnet38 min210 k$/);
  assert.deepEqual(await box(page, "C2").locator(".acard.own .arow .who").allTextContents(), ["designerR31"], "a chief's own run with no lead");
  assert.deepEqual(await box(page, "C1").locator(".queue .arow").evaluateAll(rows => rows.map(row => row.dataset.run + " " + row.querySelector(".num:last-child").textContent)), ["R24 1st in line", "R33 3rd in line"]);
  assert.match(await box(page, "C2").locator(".queue .arow").textContent(), /^leadR32Queued · 2ndT30 · Sample crash reportsqueued \d\d:\d\dwaits 1 min2nd in line$/);
  assert.match(await box(page, "C3").textContent(), /Stopped0 leads · 0 runningNo agent runs\. Last event \d\d:\d\d: the heartbeat stopped\. Nothing moves on its own\.It owns T70 · Sample stopped chief\./, "a stopped chief shows as stopped, with its tasks");
  assert.equal(await box(page, "C3").getByRole("button").count(), 0, "the page only reads: no write action");
  assert.equal(await page.locator(".timeline .lane-group").count(), 2, "a lane group for each chief with agents");
  assert.deepEqual(await page.locator(".timeline .lane-group").first().locator(".lane-l").evaluateAll(lanes => lanes.map(lane => lane.textContent)),
    ["lead R25", "implementer R26", "ux-reviewer R27", "lead R20", "implementer R21", "code-reviewer R22", "security-reviewer R23", "qa R24", "implementer R33"]);
  assert.equal(await page.locator(".timeline .lbar.queued").count() - 1, 3, "a dashed bar for each queued run, and one in the legend");
  await shoot(page, "agents-dark.png");
  assert.deepEqual(requests.filter(url => !url.startsWith(`${base}/`)), [], "no request outside 127.0.0.1");
  assert.deepEqual(problems, [], "no script error and no CSP refusal");
});

test("T1062: a row opens its task's side panel on the Agents page, and Escape closes it back to the row", async t => {
  const { page, problems } = await open(t, {}, { path: "/app/#agents" });
  const row = page.locator('.arow[data-run="R31"]');
  await row.click();
  await page.locator(".panel h2", { hasText: "Sample sync build" }).waitFor();
  assert.match(page.url(), /#agents\?task=shared%2Fsample-app-abc123%2FT11$/);
  assert.equal(await page.locator("main h1").textContent(), "Agents", "the panel opens beside the Agents page");
  await page.keyboard.press("Escape");
  await page.locator(".panel").waitFor({ state: "detached" });
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.task), KEY("T11"), "the focus returns to the row's task");
  assert.deepEqual(problems, []);
});

test("T1062: at the limit the counts turn amber, and the chief filter hides other chiefs' agents but keeps the counts whole", async t => {
  const { page, problems } = await open(t, { atLimit: true }, { path: "/app/#agents" });
  assert.deepEqual(await page.locator("header.top a.limit.full").allTextContents(), ["Agents 7 of 7 · C1 4 · C2 3 · 3 queued", "Leads 4 of 4"]);
  assert.deepEqual(await page.locator(".agents-kpis .kpi.full .l").allTextContents(), ["agents running · at the limit", "leads · at the limit", "queued"]);
  await shoot(page, "agents-at-limit-dark.png");
  await page.locator('button.chip[data-chief="shared/sample-app-abc123/C2"]').click();
  assert.deepEqual(await page.locator("section.chief-box h2").allTextContents(), ["C2 · Codex"]);
  assert.equal(await page.locator(".agents-kpis .kpi").first().textContent(), "7 of 7agents running · at the limit", "the limit is shared, so the counts stay whole");
  assert.deepEqual(problems, []);
});

test("T1062: agent text from the logbook is text, never markup", async t => {
  const { page, problems } = await open(t, { hostile: true }, { path: "/app/#agents" });
  const row = page.locator('.arow[data-run="R40"]');
  assert.equal(await row.locator(".tline").textContent(), `T50 · ${HOSTILE_TEXT.title}`);
  assert.equal(await row.locator(".mdl").textContent(), `<img src=x onerror="window.hacked=12">model`);
  assert.equal(await page.evaluate(() => window.hacked ?? null), null);
  assert.equal(await page.locator("main img").count(), 0);
  assert.deepEqual(problems, []);
});

test("T1062: the Agents page meets AA contrast in both themes, at 1024 px too, and the keyboard reaches each row in order", async t => {
  for (const theme of ["dark", "light"]) {
    const { page, problems } = await open(t, {}, { path: "/app/#agents", theme });
    await page.locator(".chief-box").first().waitFor();
    assert.deepEqual((await page.evaluate(measureContrast)).filter(item => item.ratio < item.need), [], `${theme}: every text meets AA`);
    if (theme === "light") await shoot(page, "agents-light.png");
    assert.deepEqual(problems, []);
  }
  const { page } = await open(t, {}, { path: "/app/#agents", width: 1024 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "no sideways scroll at 1024 px");
  await shoot(page, "agents-1024.png");
  await page.locator("header.top a.limit").first().focus();
  const seen = [];
  for (let i = 0; i < 60 && seen.length < 4; i++) {
    await page.keyboard.press("Tab");
    const run = await page.evaluate(() => document.activeElement?.dataset.run ?? null);
    if (run) seen.push(run);
  }
  assert.deepEqual(seen, ["R25", "R20", "R22", "R23"], "Tab moves through the lead cards and their rows in reading order");
  assert.equal(await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle), "solid", "the focus ring shows");
});
