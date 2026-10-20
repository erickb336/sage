// Standalone browser check of the T233 program views (T368): the Program filter, the Needs you strip and its counts, the
// address that keeps the program, and no sideways scroll on the board, the programs list, a program page and a task page
// at 375 and 1280 px, light and dark. SAMPLE DATA from scripts/fixtures/board-programs.mjs. Like board-picker.test.mjs, it
// needs Playwright through NODE_PATH and is not in the default test command. It runs Playwright's bundled Chromium
// (PLAYWRIGHT_BROWSERS_PATH), or the headless shell at BOARD_BROWSER_PATH; never an installed Chrome.
// Example: NODE_PATH="$PLAYWRIGHT_MODULES" PLAYWRIGHT_BROWSERS_PATH="$SCRATCH/browsers" node --test scripts/board-programs-browser.test.mjs
import "./test-env.mjs";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { after, before, test } from "node:test";
import { buildBoardModel } from "../packages/sage-core/board-model.mjs";
import { renderBoardHtml, renderProgramsHtml } from "../packages/sage-core/board-render.mjs";
import { NOW, programsSource } from "./fixtures/board-programs.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const model = buildBoardModel([programsSource()], { now: NOW });
const key = id => Buffer.from(`claude/sage-ff5ee2/${id}`).toString("base64url");
let browser;
before(async () => { browser = await chromium.launch({ headless: true, ...(process.env.BOARD_BROWSER_PATH ? { executablePath: process.env.BOARD_BROWSER_PATH } : {}) }); });
after(async () => { await browser?.close(); });

/** The served pages at a made-up origin; every other request fails. */
const PAGES = {
  "/": () => renderBoardHtml(model, { snapshot: false }),
  "/programs": () => renderProgramsHtml(model),
  [`/program/${key("PG1")}`]: () => renderProgramsHtml(model, { programKey: `claude/sage-ff5ee2/PG1` }),
  [`/task/${key("T13")}`]: () => renderBoardHtml(model, { snapshot: false, taskKey: `claude/sage-ff5ee2/T13` }),
};
async function open(t, path = "/", { width = 1280, height = 900, colorScheme = "light", hash = "" } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, colorScheme, ...(width < 700 ? { isMobile: true, hasTouch: true } : {}) });
  t.after(() => context.close());
  await context.route("**/*", route => route.abort());
  for (const [at, html] of Object.entries(PAGES)) await context.route(`http://board.test${at}`, route => route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html() }));
  const page = await context.newPage(), errors = [];
  page.on("pageerror", error => errors.push(String(error)));
  t.after(() => assert.deepEqual(errors, [], "no script error"));
  await page.goto(`http://board.test${path}${hash}`);
  return page;
}
const shownIds = page => page.locator(".card[data-key]:not([hidden]) .id").allTextContents();
const visible = (page, selector) => page.locator(selector).isVisible();

test("T368: the Program filter keeps its program's cards and its Needs you item, keeps the choice in the address, and Clear filters ends it", async t => {
  const page = await open(t);
  assert.equal(await page.locator("#needstrip-n").textContent(), "2");
  await page.selectOption("#f-program", key("PG1"));
  assert.deepEqual((await shownIds(page)).sort(), ["T11", "T12", "T13"], "the PG1 cards on the board (its merged tasks have no time in the last 7 days)");
  assert.equal(await visible(page, "#needstrip"), false, "PG1 has no item of its own");
  assert.match(await page.evaluate(() => location.hash), new RegExp(`^#pg=${key("PG1")}$`));
  await page.selectOption("#f-program", key("PG2"));
  assert.deepEqual((await shownIds(page)).sort(), ["T22", "T23"]);
  assert.equal(await page.locator("#needstrip-n").textContent(), "1");
  assert.equal(await page.locator("#needstrip li:not([hidden]) .what").textContent(), "PG2 Lead build is stuck · sage (sample) · Claude logbook");
  assert.equal(await page.locator("#s-needs").textContent(), "1", "the summary counts the item that shows");
  await page.selectOption("#f-program", "none");
  assert.deepEqual((await shownIds(page)).sort(), ["T70"]);
  await page.click("#f-clear");
  assert.equal(await page.locator("#f-program").inputValue(), "");
  assert.equal(await page.locator("#needstrip-n").textContent(), "2");
  assert.equal(await page.evaluate(() => location.hash), "");
});

test("T368 QD: a done program with no card on the board says why, links to its page, and shows no plain no-match note", async t => {
  const page = await open(t);
  await page.selectOption("#f-program", key("PG5"));
  assert.deepEqual(await shownIds(page), []);
  assert.equal(await visible(page, "#noprog"), true);
  assert.equal(await visible(page, "#nomatch"), false);
  assert.equal(await page.locator("#noprog-name").textContent(), "PG5 Old pilot (done)");
  assert.equal(await page.locator("#noprog-why").textContent(), "Its tasks ended more than 7 days ago, and the board shows the last 7 days of Done.");
  assert.equal(await page.locator("#noprog-link").getAttribute("href"), `/program/${key("PG5")}`);
});

test("T368: a program page's link to its tasks opens the board with the Program filter on", async t => {
  const page = await open(t, `/program/${key("PG1")}`);
  await page.click("text=Its tasks on the board");
  await page.waitForURL(/#pg=/);
  assert.equal(await page.locator("#f-program").inputValue(), key("PG1"));
  assert.deepEqual((await shownIds(page)).sort(), ["T11", "T12", "T13"]);
});

for (const [width, height] of [[375, 812], [1280, 900]]) for (const colorScheme of ["light", "dark"]) {
  test(`T368: no sideways scroll at ${width} px, ${colorScheme}: the board, the programs list, a program page and a task page`, async t => {
    for (const path of Object.keys(PAGES)) {
      const page = await open(t, path, { width, height, colorScheme });
      const { scroll, client } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
      assert.ok(scroll <= client, `${path}: ${scroll} > ${client}`);
    }
  });
}
