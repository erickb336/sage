// Standalone browser check of the T382 board polish batch (T374, T378): the address after needs=1, the Program filter
// after a project change, a live refresh of the programs pages' Needs you count, the program id in a phone's page bar, a
// long program name on a card, a theme change in another tab, the forced colours, the approval band and 320 px task
// pages. SAMPLE DATA from scripts/fixtures/board-programs.mjs. Like board-programs-browser.test.mjs, it needs Playwright
// through NODE_PATH and is not in the default test command. It runs Playwright's bundled Chromium
// (PLAYWRIGHT_BROWSERS_PATH), or the headless shell at BOARD_BROWSER_PATH; never an installed Chrome.
// Example: NODE_PATH="$PLAYWRIGHT_MODULES" PLAYWRIGHT_BROWSERS_PATH="$SCRATCH/browsers" node --test scripts/board-polish-browser.test.mjs
import "./test-env.mjs";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { after, before, test } from "node:test";
import { buildBoardModel } from "../packages/sage-core/board-model.mjs";
import { renderBoardHtml, renderProgramsHtml } from "../packages/sage-core/board-render.mjs";
import { NOW, programsSource, programsTables } from "./fixtures/board-programs.mjs";
import { expectTheme } from "./fixtures/contrast.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const KEY = id => `claude/sage-ff5ee2/${id}`, key = id => Buffer.from(KEY(id)).toString("base64url");
const model = buildBoardModel([programsSource()], { now: NOW });
// Two projects, each with the sample programs, so the picker has a project to change to.
const other = programsSource("codex");
Object.assign(other.projects[0], { key: "codex/other-abc123", name: "other-abc123", checkout: "/sample/other", displayName: "other (sample)" });
const two = buildBoardModel([programsSource(), other], { now: NOW });
// A program name with no space: it must wrap, not push the page sideways.
const unbroken = programsTables();
unbroken.programs.find(row => row.id === "PG1").name = "Providerneutralboardcoreforalltoolsandeverylogbookthatsagereads";
const long = buildBoardModel([programsSource("claude", unbroken)], { now: NOW });
let browser;
before(async () => { browser = await chromium.launch({ headless: true, ...(process.env.BOARD_BROWSER_PATH ? { executablePath: process.env.BOARD_BROWSER_PATH } : {}) }); });
after(async () => { await browser?.close(); });

const PAGES = {
  "/": () => renderBoardHtml(model, { snapshot: false }),
  "/two": () => renderBoardHtml(two, { snapshot: false }),
  "/long": () => renderBoardHtml(long, { snapshot: false }),
  "/programs": () => renderProgramsHtml(model, { live: true }),
  [`/program/${key("PG1")}`]: () => renderProgramsHtml(model, { programKey: KEY("PG1"), live: true }),
  [`/program/${key("PG3")}`]: () => renderProgramsHtml(model, { programKey: KEY("PG3") }),
  [`/task/${key("T13")}`]: () => renderBoardHtml(model, { snapshot: false, taskKey: KEY("T13") }),
  [`/task/${key("T22")}`]: () => renderBoardHtml(model, { snapshot: false, taskKey: KEY("T22") }),
  [`/task/${key("T41")}`]: () => renderBoardHtml(model, { snapshot: false, taskKey: KEY("T41") }),
  "/snapshot": () => renderBoardHtml(model),
};
/** A browser context at a made-up origin; every other request fails. A live page gets a fake event stream. */
async function context(t, { width = 1280, height = 900 } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: "light", reducedMotion: "reduce", ...(width < 700 ? { isMobile: true, hasTouch: true } : {}) });
  t.after(() => ctx.close());
  await ctx.route("**/*", route => route.abort());
  for (const [at, html] of Object.entries(PAGES)) await ctx.route(`http://board.test${at}`, route => route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html() }));
  await ctx.addInitScript(() => { window.EventSource = class extends EventTarget { constructor() { super(); window.sampleBoardStream = this; } close() {} }; });
  return ctx;
}
async function open(t, path, options = {}) {
  const ctx = options.ctx ?? await context(t, options), page = await ctx.newPage(), errors = [];
  page.on("pageerror", error => errors.push(String(error)));
  t.after(() => assert.deepEqual(errors, [], "no script error"));
  await page.goto(`http://board.test${path}`);
  return page;
}
const noSideways = page => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

test("T374-1: the board reads needs=1 once, takes it out of the address, and a reload leaves the Needs you filter off", async t => {
  const page = await open(t, "/#needs=1");
  assert.equal(await page.locator("[data-filter=needs]").getAttribute("aria-pressed"), "true");
  assert.equal(await page.evaluate(() => location.hash), "", "needs=1 is gone from the address");
  await page.reload();
  assert.equal(await page.locator("[data-filter=needs]").getAttribute("aria-pressed"), "false");
  const kept = await open(t, `/#p=sage-ff5ee2&needs=1`);
  assert.equal(await kept.evaluate(() => location.hash), "#p=sage-ff5ee2", "the project stays in the address");
});

test("T374-7: a project change clears a Program filter whose program is in another project, and keeps one of the new project", async t => {
  const page = await open(t, `/two#p=sage-ff5ee2&pg=${key("PG1")}`);
  assert.equal(await page.locator("#f-program").inputValue(), key("PG1"));
  await page.click("#pick-trig");
  await page.click('#pick-list [role=option][data-key="sage-ff5ee2"]');
  assert.equal(await page.locator("#f-program").inputValue(), key("PG1"), "the same project keeps the filter");
  await page.click("#pick-trig");
  await page.click('#pick-list [role=option][data-key="other-abc123"]');
  assert.equal(await page.locator("#f-program").inputValue(), "", "the filter of the other project ends");
  assert.equal(await page.evaluate(() => location.hash), "#p=other-abc123");
  assert.ok((await page.locator(".card[data-key]:not([hidden])").count()) > 0, "the new project's cards show");
});

test("T374-5: a live refresh updates the Needs you count on /programs and /program/KEY", async t => {
  // The owner approved PG3: its breakdown no longer needs you.
  const tables = programsTables();
  tables.gates.find(gate => gate.id === "G12").answer = "approve";
  const later = buildBoardModel([programsSource("claude", tables)], { now: NOW });
  for (const [path, next] of [["/programs", renderProgramsHtml(later, { live: true })], [`/program/${key("PG1")}`, renderProgramsHtml(later, { programKey: KEY("PG1"), live: true })]]) {
    const page = await open(t, path);
    assert.equal(await page.locator("#needs-count").textContent(), "4");
    await page.evaluate(html => window.sampleBoardStream.dispatchEvent(new MessageEvent("board", { data: JSON.stringify({ html, stale: false }) })), next);
    assert.equal(await page.locator("#needs-count").textContent(), String(later.counts.needsOwner), path);
    assert.notEqual(later.counts.needsOwner, 4);
  }
});

test("T374-11: at 375 px the task page bar shows the program id; a wide screen keeps the name", async t => {
  const page = await open(t, `/task/${key("T13")}`, { width: 375, height: 812 });
  assert.deepEqual([await page.locator(".plink .pid").isVisible(), await page.locator(".plink .cn").isVisible(), await page.locator(".plink .pid").textContent()], [true, false, "PG1"]);
  const wide = await open(t, `/task/${key("T13")}`);
  assert.deepEqual([await wide.locator(".plink .pid").isVisible(), await wide.locator(".plink .cn").textContent()], [false, "Codex support"], "a wide screen keeps the name");
});

test("T374-12: at 375 px a program name with no space wraps on its card: no sideways scroll", async t => {
  const board = await open(t, "/long", { width: 375, height: 812 });
  assert.ok(await noSideways(board), "no sideways scroll");
  const out = await board.locator(".tag.prog").evaluateAll(tags => tags.filter(tag => tag.getBoundingClientRect().right > tag.closest(".card").getBoundingClientRect().right).length);
  assert.equal(out, 0, "each program tag stays in its card");
});

test("T378-16: an open board tab follows a theme change made in another tab", async t => {
  const ctx = await context(t), one = await open(t, "/", { ctx }), two = await open(t, "/programs", { ctx });
  await expectTheme(two, "dark");
  await one.locator("label[for=flip]").click();
  await expectTheme(one, "light");
  await two.waitForFunction(() => document.documentElement.dataset.theme === "light");
  await expectTheme(two, "light", "the other tab");
});

async function forced(t) {
  const ctx = await context(t), page = await ctx.newPage();
  await page.emulateMedia({ forcedColors: "active" });
  return page;
}
test("T378-17: in forced colours the chosen tab and the chosen Who pill have a Highlight border", async t => {
  const page = await forced(t);
  await page.goto("http://board.test/");
  const highlight = await page.evaluate(() => { const probe = document.body.appendChild(document.createElement("i")); probe.style.color = "Highlight"; const color = getComputedStyle(probe).color; probe.remove(); return color; });
  const border = selector => page.locator(selector).evaluate(element => { const style = getComputedStyle(element); return `${style.borderTopWidth} ${style.borderTopColor}`; });
  assert.equal(await border(".boardtabs a[aria-current=page]"), `2px ${highlight}`);
  assert.equal(await border(".seg button[aria-pressed=true]"), `2px ${highlight}`);
  assert.notEqual(await border(".seg button[aria-pressed=false]"), `2px ${highlight}`, "a pill that is not chosen has no mark");
});

test("T378-20: in forced colours a program page's task rows keep an edge", async t => {
  const page = await forced(t);
  await page.goto(`http://board.test/program/${key("PG1")}`);
  assert.deepEqual(await page.locator(".trow").first().evaluate(row => [getComputedStyle(row).borderTopStyle, getComputedStyle(row).borderTopWidth]), ["solid", "1px"]);
});

test("T378-18: the offline snapshot's task, programs and program pages each flip the theme with their own switch", async t => {
  for (const id of [`task-${key("T13")}`, "programs", `program-${key("PG1")}`]) {
    const page = await open(t, `/snapshot#${id}`);
    await expectTheme(page, "dark", id);
    await page.locator(`label[for="flip-${id}"]`).click();
    await expectTheme(page, "light", id);
    assert.equal(await page.evaluate(() => localStorage.getItem("board-theme")), "light", id);
  }
});

test("T378-19: the program approval band spans its section edge to edge", async t => {
  const page = await open(t, `/program/${key("PG3")}`);
  const [band, section] = await page.locator("section.approval").evaluate(element => [element.querySelector(".band").getBoundingClientRect(), element.getBoundingClientRect()].map(box => [Math.round(box.left), Math.round(box.right)]));
  assert.deepEqual(band, section);
});

test("T378-21: no sideways scroll at 320 px on task pages, and the theme switch stays on screen", async t => {
  for (const id of ["T13", "T22", "T41"]) {
    const page = await open(t, `/task/${key(id)}`, { width: 320, height: 700 });
    assert.ok(await noSideways(page), `${id}: ${await page.evaluate(() => document.documentElement.scrollWidth)} px wide`);
    const box = await page.locator("label.theme").boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= 320, `${id}: the switch ends at ${box.x + box.width}`);
  }
});
