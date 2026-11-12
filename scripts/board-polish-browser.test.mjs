import "./test-env.mjs";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { after, before, test } from "node:test";
import { buildBoardModel } from "../packages/sage-core/board-model.mjs";
import { renderBoardHtml, renderMilestonesHtml } from "../packages/sage-core/board-render.mjs";
import { NOW, milestonesSource, milestonesTables } from "./fixtures/board-milestones.mjs";
import { expectTheme } from "./fixtures/contrast.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const KEY = id => `claude/sage-ff5ee2/${id}`, key = id => Buffer.from(KEY(id)).toString("base64url");
const model = buildBoardModel([milestonesSource()], { now: NOW });
const other = milestonesSource("codex");
Object.assign(other.projects[0], { key: "codex/other-abc123", name: "other-abc123", checkout: "/sample/other", displayName: "other (sample)" });
const two = buildBoardModel([milestonesSource(), other], { now: NOW });
const unbroken = milestonesTables();
unbroken.milestones.find(row => row.id === "M1").name = "Providerneutralboardcoreforalltoolsandeverylogbookthatsagereads";
const long = buildBoardModel([milestonesSource("claude", unbroken)], { now: NOW });
let browser;
before(async () => { browser = await chromium.launch({ headless: true, ...(process.env.BOARD_BROWSER_PATH ? { executablePath: process.env.BOARD_BROWSER_PATH } : {}) }); });
after(async () => { await browser?.close(); });

const PAGES = {
  "/": () => renderBoardHtml(model, { snapshot: false }),
  "/two": () => renderBoardHtml(two, { snapshot: false }),
  "/long": () => renderBoardHtml(long, { snapshot: false }),
  "/milestones": () => renderMilestonesHtml(model, { live: true }),
  [`/milestone/${key("M1")}`]: () => renderMilestonesHtml(model, { milestoneKey: KEY("M1"), live: true }),
  [`/milestone/${key("M3")}`]: () => renderMilestonesHtml(model, { milestoneKey: KEY("M3") }),
  "/milestone/long": () => renderMilestonesHtml(model, { milestoneKey: `claude/sage-ff5ee2/M${"1".repeat(400)}` }),
  [`/task/${key("T13")}`]: () => renderBoardHtml(model, { snapshot: false, taskKey: KEY("T13") }),
  [`/task/${key("T22")}`]: () => renderBoardHtml(model, { snapshot: false, taskKey: KEY("T22") }),
  [`/task/${key("T41")}`]: () => renderBoardHtml(model, { snapshot: false, taskKey: KEY("T41") }),
  "/snapshot": () => renderBoardHtml(model),
};
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

test("T374-7: a project change clears a Milestone filter whose milestone is in another project, and keeps one of the new project", async t => {
  const page = await open(t, `/two#p=sage-ff5ee2&pg=${key("M1")}`);
  assert.equal(await page.locator("#f-milestone").inputValue(), key("M1"));
  await page.click("#pick-trig");
  await page.click('#pick-list [role=option][data-key="sage-ff5ee2"]');
  assert.equal(await page.locator("#f-milestone").inputValue(), key("M1"), "the same project keeps the filter");
  await page.click("#pick-trig");
  await page.click('#pick-list [role=option][data-key="other-abc123"]');
  assert.equal(await page.locator("#f-milestone").inputValue(), "", "the filter of the other project ends");
  assert.equal(await page.evaluate(() => location.hash), "#p=other-abc123");
  assert.ok((await page.locator(".card[data-key]:not([hidden])").count()) > 0, "the new project's cards show");
});

test("R1371-2: an address with a Milestone filter of another project drops the filter: the chosen project's cards show", async t => {
  const page = await open(t, `/two#p=other-abc123&pg=${key("M1")}`);
  assert.equal(await page.locator("#f-milestone").inputValue(), "");
  assert.equal(await page.evaluate(() => location.hash), "#p=other-abc123");
  assert.ok((await page.locator(".card[data-key]:not([hidden])").count()) > 0, "the project's cards show");
});

test("R1371-2 (reopened): with needs=1 also in the address, in any order, the Milestone filter of another project goes and the address keeps only the project", async t => {
  for (const hash of [`p=other-abc123&pg=${key("M1")}&needs=1`, `needs=1&pg=${key("M1")}&p=other-abc123`]) {
    const page = await open(t, `/two#${hash}`);
    assert.equal(await page.locator("#f-milestone").inputValue(), "", hash);
    assert.equal(await page.evaluate(() => location.hash), "#p=other-abc123", hash);
    assert.equal(await page.locator("[data-filter=needs]").getAttribute("aria-pressed"), "true", hash);
  }
});

test("R1371-1: at 375 px the not-found page of a very long milestone id has no sideways scroll", async t => {
  const page = await open(t, "/milestone/long", { width: 375, height: 812 });
  assert.ok(await noSideways(page), `${await page.evaluate(() => document.documentElement.scrollWidth)} px wide`);
});

test("T374-5: a live refresh updates the Needs you count on /milestones and /milestone/KEY", async t => {
  const tables = milestonesTables();
  tables.gates.find(gate => gate.id === "G12").answer = "approve";
  const later = buildBoardModel([milestonesSource("claude", tables)], { now: NOW });
  for (const [path, next] of [["/milestones", renderMilestonesHtml(later, { live: true })], [`/milestone/${key("M1")}`, renderMilestonesHtml(later, { milestoneKey: KEY("M1"), live: true })]]) {
    const page = await open(t, path);
    assert.equal(await page.locator("#needs-count").textContent(), "4");
    await page.evaluate(html => window.sampleBoardStream.dispatchEvent(new MessageEvent("board", { data: JSON.stringify({ html, stale: false }) })), next);
    assert.equal(await page.locator("#needs-count").textContent(), String(later.counts.needsOwner), path);
    assert.notEqual(later.counts.needsOwner, 4);
  }
});

test("T374-11: at 375 px the task page bar shows the milestone id; a wide screen keeps the name", async t => {
  const page = await open(t, `/task/${key("T13")}`, { width: 375, height: 812 });
  assert.deepEqual([await page.locator(".plink .pid").isVisible(), await page.locator(".plink .cn").isVisible(), await page.locator(".plink .pid").textContent()], [true, false, "M1"]);
  const wide = await open(t, `/task/${key("T13")}`);
  assert.deepEqual([await wide.locator(".plink .pid").isVisible(), await wide.locator(".plink .cn").textContent()], [false, "Codex support"], "a wide screen keeps the name");
});

test("T374-12: at 375 px a milestone name with no space wraps on its card: no sideways scroll", async t => {
  const board = await open(t, "/long", { width: 375, height: 812 });
  assert.ok(await noSideways(board), "no sideways scroll");
  const out = await board.locator(".tag.prog").evaluateAll(tags => tags.filter(tag => tag.getBoundingClientRect().right > tag.closest(".card").getBoundingClientRect().right).length);
  assert.equal(out, 0, "each milestone tag stays in its card");
});

test("T378-16: an open board tab follows a theme change made in another tab", async t => {
  const ctx = await context(t), one = await open(t, "/", { ctx }), two = await open(t, "/milestones", { ctx });
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

test("T378-20: in forced colours a milestone page's task rows keep an edge", async t => {
  const page = await forced(t);
  await page.goto(`http://board.test/milestone/${key("M1")}`);
  assert.deepEqual(await page.locator(".trow").first().evaluate(row => [getComputedStyle(row).borderTopStyle, getComputedStyle(row).borderTopWidth]), ["solid", "1px"]);
});

test("T378-18: the offline snapshot's task, milestones and milestone pages each flip the theme with their own switch", async t => {
  for (const id of [`task-${key("T13")}`, "milestones", `milestone-${key("M1")}`]) {
    const page = await open(t, `/snapshot#${id}`);
    await expectTheme(page, "dark", id);
    await page.locator(`label[for="flip-${id}"]`).click();
    await expectTheme(page, "light", id);
    assert.equal(await page.evaluate(() => localStorage.getItem("board-theme")), "light", id);
  }
});

test("R1384-2: with scripts off, the offline snapshot's switches flip the theme together: a second page's switch flips it back", async t => {
  const ctx = await browser.newContext({ javaScriptEnabled: false, colorScheme: "light", reducedMotion: "reduce" });
  t.after(() => ctx.close());
  await ctx.route("**/*", route => route.abort());
  await ctx.route("http://board.test/snapshot", route => route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: PAGES["/snapshot"]() }));
  const page = await ctx.newPage(), switchOf = id => page.locator(`${id} .theme:visible`);
  await page.goto("http://board.test/snapshot#milestones");
  await expectTheme(page, "dark", "milestones");
  await switchOf("#milestones").click();
  await expectTheme(page, "light", "flipped on the milestones page");
  for (const [id, now, words] of [[`#milestone-${key("M1")}`, "dark", "Light theme"], [`#task-${key("T13")}`, "light", "Dark theme"], ["header", "dark", "Light theme"]]) {
    await page.evaluate(hash => { location.hash = hash; }, id === "header" ? "" : id);
    await switchOf(id).click();
    await expectTheme(page, now, id);
    assert.equal(await switchOf(id).innerText(), words, `${id}: the switch names the other theme`);
  }
});

test("R1481-1: with scripts off, the snapshot's theme switch and its reset work by keyboard and keep focus on a shown control", async t => {
  const ctx = await browser.newContext({ javaScriptEnabled: false, colorScheme: "light", reducedMotion: "reduce" });
  t.after(() => ctx.close());
  await ctx.route("**/*", route => route.abort());
  await ctx.route("http://board.test/snapshot", route => route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: PAGES["/snapshot"]() }));
  const page = await ctx.newPage(), pg1 = `#milestone-${key("M1")}`;
  const focused = () => page.evaluate(() => { const at = document.activeElement, shown = at.matches(".flip") ? at.labels[0] : at; return [at.id || at.className, shown.checkVisibility()]; });
  await page.goto("http://board.test/snapshot#milestones");
  await page.focus("#flip-milestones");
  for (const now of ["light", "dark", "light"]) {
    await page.keyboard.press("Space");
    await expectTheme(page, now, `milestones page: Space flips to ${now}`);
    assert.deepEqual(await focused(), ["flip-milestones", true], `milestones page, ${now}: focus stays on the switch`);
  }
  await page.evaluate(hash => { location.hash = hash; }, pg1);
  await page.focus(`${pg1} a.back`);
  for (let tabs = 0; tabs < 4 && !(await focused())[0].includes("unflip"); tabs++) await page.keyboard.press("Tab");
  assert.deepEqual(await focused(), ["chip theme unflip", true], "the reset is the next stop");
  await page.keyboard.press("Space");
  await expectTheme(page, "dark", "the reset flips it back");
  assert.deepEqual(await focused(), ["chip theme unflip", true], "focus stays on the reset");
  assert.equal(await page.locator(`${pg1} .theme:visible`).count(), 1, "one switch shows");
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Space");
  await expectTheme(page, "light", "this page's switch flips it");
  assert.deepEqual(await focused(), [`flip-milestone-${key("M1")}`, true], "focus stays on this page's switch");
});

test("T378-19: the milestone approval band spans its section edge to edge", async t => {
  const page = await open(t, `/milestone/${key("M3")}`);
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
