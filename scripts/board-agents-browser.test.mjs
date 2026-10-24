// Standalone browser check of the T308 Agents page: 375 and 1440 px, light and dark, the keyboard (the page tabs and the
// task links) and a live refresh that keeps the scroll and the focus. SAMPLE DATA from board-sample.mjs. It runs in
// `npm run test:browser`, not in `npm test`, with Playwright's bundled Chromium, or the headless shell at
// BOARD_BROWSER_PATH; never an installed Chrome.
import "./test-env.mjs";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { readBoardSources } from "../packages/sage-core/board-reader.mjs";
import { buildBoardModel } from "../packages/sage-core/board-model.mjs";
import { renderAgentsHtml } from "../packages/sage-core/board-render.mjs";
import { writeSampleLogbooks } from "./board-sample.mjs";
import { expectTheme } from "./fixtures/contrast.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const NOW = "2026-10-18T12:00:00Z";
const dir = mkdtempSync(join(realpathSync(tmpdir()), "sage-board-agents-"));
const sources = writeSampleLogbooks(join(dir, "sample"), { now: NOW });
let browser;
before(async () => { browser = await chromium.launch({ headless: true, ...(process.env.BOARD_BROWSER_PATH ? { executablePath: process.env.BOARD_BROWSER_PATH } : {}) }); });
after(async () => { try { await browser?.close(); } finally { rmSync(dir, { recursive: true, force: true }); } });

/** The sample's model; change(read) may edit the read sources first, as a later event of the hook would. */
function sample(change = () => {}, now = NOW) {
  const read = readBoardSources(sources, { now: Date.parse(now) });
  change(read);
  return buildBoardModel(read, { now });
}

/** The Agents page. The theme is dark; theme "light" flips the switch, as a person does. */
async function open(t, { width = 1440, height = 900, theme = "dark" } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, colorScheme: "light", reducedMotion: "reduce", ...(width < 700 ? { isMobile: true, hasTouch: true } : {}) });
  t.after(() => context.close());
  // A made-up origin; only the two pages are served, every other request fails.
  await context.route("**/*", route => route.abort());
  await context.route("http://board.test/agents", route => route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: renderAgentsHtml(sample(), { live: true }) }));
  await context.route(/^http:\/\/board\.test\/task\/[\w-]+$/, route => route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: "<!doctype html><title>task</title><p>sample task page</p>" }));
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(String(error)));
  t.after(() => assert.deepEqual(errors, [], "no script error"));
  await page.addInitScript(() => { window.EventSource = class extends EventTarget { constructor() { super(); window.sampleBoardStream = this; } close() {} }; });
  await page.goto("http://board.test/agents");
  if (theme === "light") await page.locator("label[for=flip]").click();
  return page;
}
const focused = page => page.evaluate(() => document.activeElement?.id || document.activeElement?.textContent?.trim().slice(0, 40));
async function push(page, model) {
  await page.evaluate(html => window.sampleBoardStream.dispatchEvent(new MessageEvent("board", { data: JSON.stringify({ html, stale: false }) })), renderAgentsHtml(model, { live: true }));
}

for (const width of [375, 1440]) for (const theme of ["light", "dark"]) {
  test(`T308: the Agents page at ${width} px, ${theme}: no sideways scroll, each state with its mark and word, the theme`, async t => {
    const page = await open(t, { width, theme });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width, "no sideways scroll");
    await expectTheme(page, theme);
    assert.deepEqual(await page.locator(".group h2").allTextContents(), ["order-chaser", "sage", "Council Record (sample)", "recipes"], "the projects with a problem first");
    assert.deepEqual([...new Set(await page.locator(".st").allTextContents())].sort(), ["!may be stuck", "●working", "○running", "■helper stopped, run still open", "▲running long", "◷waiting for its helpers"].sort());
    for (const word of await page.locator(".st").all()) assert.equal(await word.isVisible(), true);
    assert.equal(await page.locator(".boardtabs a[aria-current=page]").textContent(), "Agents (13)");
    // Each row stays inside its box: no text runs out of the page.
    const outside = await page.locator(".arow").evaluateAll((rows, w) => rows.filter(row => row.getBoundingClientRect().right > w).length, width);
    assert.equal(outside, 0);
  });
}

test("T308: the keyboard reaches the page tabs and every task link in order, and Enter opens the task", async t => {
  const page = await open(t);
  const order = [];
  for (let i = 0; i < 30; i++) {
    await page.keyboard.press("Tab");
    order.push(await page.evaluate(() => document.activeElement.tagName === "A" ? `${document.activeElement.getAttribute("href")}|${document.activeElement.textContent.trim()}` : document.activeElement.id || document.activeElement.tagName));
  }
  assert.deepEqual(order.slice(0, 4), ["/|Task board", "/programs|Programs", "/agents|Agents (13)", "flip"], "the tabs come first, then the theme switch");
  const links = await page.locator("a.t").evaluateAll(links => links.map(link => `${link.getAttribute("href")}|${link.textContent.trim()}`));
  assert.equal(links.length, 12, "each agent with a task has a link; the slot with no run has none");
  assert.deepEqual(order.slice(4, 4 + links.length), links, "the task links follow in the page's order");
  assert.ok(links[0].startsWith("/task/") && links[0].endsWith("T13 Sample: an email digest"));
  await page.locator("a.t").first().focus();
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/task\/[\w-]+$/);
  assert.equal(await page.locator("p").textContent(), "sample task page");
});

test("T308: a live refresh replaces the page and keeps the scroll and the focus", async t => {
  const page = await open(t, { width: 375, height: 700 });
  const link = page.locator("a.t").nth(8), id = await link.getAttribute("id");
  await link.scrollIntoViewIfNeeded();
  await page.evaluate(() => scrollBy(0, 37));
  await link.focus({ preventScroll: true });
  const before = await page.evaluate(() => scrollY);
  assert.ok(before > 500, "the page scrolled");
  // Ten minutes later: the reviewers are quiet, and a new run of the hook's sample took a slot.
  const later = sample(read => { for (const project of read.flatMap(source => source.projects)) for (const run of project.tables.runs ?? []) if (run.id === "R50") run.model = "sample-changed-model"; }, "2026-10-18T12:10:00Z");
  await push(page, later);
  assert.match(await page.locator("#board-content").textContent(), /model sample-changed-model/, "the new page is in");
  assert.equal(await page.evaluate(() => scrollY), before, "the scroll stays");
  assert.equal(await focused(page), id, "the focus stays on the same task link");
  assert.equal(await page.locator("#live-state .lt").textContent(), "Live · updated 12:10");
  assert.equal(await page.locator(".boardtabs a[aria-current=page]").textContent(), "Agents (13)");
});
