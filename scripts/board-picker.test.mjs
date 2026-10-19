// Standalone browser check of the T305 board: the picker's keyboard and states, the filter bar, the state that a live
// update keeps, the theme and the live pill, at desktop and 375 px, in light and dark. SAMPLE DATA from board-sample.mjs.
// Like board-enhancement.test.mjs, it needs Playwright through NODE_PATH and is not in the default test command. It runs
// Playwright's bundled Chromium (PLAYWRIGHT_BROWSERS_PATH), or the headless shell at BOARD_BROWSER_PATH; never an
// installed Chrome. Example: NODE_PATH="$PLAYWRIGHT_MODULES" PLAYWRIGHT_BROWSERS_PATH="$SCRATCH/browsers" node --test scripts/board-picker.test.mjs
import "./test-env.mjs";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { readBoardSources } from "../packages/sage-core/board-reader.mjs";
import { buildBoardModel } from "../packages/sage-core/board-model.mjs";
import { renderBoardHtml } from "../packages/sage-core/board-render.mjs";
import { writeSampleLogbooks } from "./board-sample.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const NOW = "2026-10-18T12:00:00Z";
// The real path: the sample script refuses a path through a link, such as /var on macOS.
const dir = mkdtempSync(join(realpathSync(tmpdir()), "sage-board-picker-"));
const sources = writeSampleLogbooks(join(dir, "sample"), { now: NOW });
let browser;
before(async () => { browser = await chromium.launch({ headless: true, ...(process.env.BOARD_BROWSER_PATH ? { executablePath: process.env.BOARD_BROWSER_PATH } : {}) }); });
after(async () => { try { await browser?.close(); } finally { rmSync(dir, { recursive: true, force: true }); } });

/** The sample board's model; change(read) may edit the read logbooks first, as a later write of an agent would. */
function sample(change = () => {}) {
  const read = readBoardSources(sources, { now: Date.parse(NOW) });
  change(read);
  return buildBoardModel(read, { now: NOW });
}
const rename = (id, title) => read => { for (const project of read.flatMap(source => source.projects)) for (const task of project.tables.tasks ?? []) if (task.id === id && project.key.startsWith("claude/sage-")) task.title = title; };

async function open(t, { width = 1440, height = 1000, colorScheme = "dark", live = false, html = null } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, colorScheme, ...(width < 700 ? { isMobile: true, hasTouch: true } : {}) });
  t.after(() => context.close());
  await context.route("**/*", route => route.abort());
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(String(error)));
  t.after(() => assert.deepEqual(errors, [], "no script error"));
  if (live) await page.addInitScript(() => { window.EventSource = class extends EventTarget { constructor() { super(); window.sampleBoardStream = this; } close() {} }; });
  // A made-up origin, so that the page has its own storage; only the page itself is served, every other request fails.
  page.sampleHtml = html ?? renderBoardHtml(sample(), { snapshot: false, live });
  await context.route("http://board.test/", route => route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: page.sampleHtml }));
  await page.goto("http://board.test/");
  return page;
}
/** Loads the page again with this HTML at the same origin (the hash stays only when it is in the address). */
async function reload(page, html, address = "http://board.test/") { page.sampleHtml = html; await page.goto("about:blank"); await page.goto(address); }
const shown = page => page.locator(".card[data-key]:not([hidden])").evaluateAll(cards => cards.map(card => `${card.querySelector(".id").textContent} ${card.querySelector(".proj").textContent}`));
const focused = page => page.evaluate(() => document.activeElement?.id ?? document.activeElement?.tagName);
async function push(page, model) {
  await page.evaluate(html => window.sampleBoardStream.dispatchEvent(new MessageEvent("board", { data: JSON.stringify({ html, stale: false }) })), renderBoardHtml(model, { snapshot: false, live: true }));
}

test("T305: the picker opens with /, moves with the arrows, chooses with Enter, closes with Esc, and gives focus back", async t => {
  const page = await open(t);
  const trigger = page.locator("#pick-trig"), input = page.locator("#pick-q");
  assert.equal(await trigger.getAttribute("aria-expanded"), "false");
  await page.keyboard.press("/");
  assert.equal(await trigger.getAttribute("aria-expanded"), "true");
  assert.equal(await focused(page), "pick-q");
  assert.equal(await input.getAttribute("role"), "combobox");
  // The list: All projects, then needs you (most first), active, idle; archived folded behind one button.
  const visibleOptions = () => page.locator("#pick-list [role=option]:not([hidden])").evaluateAll(options => options.map(option => option.dataset.name));
  assert.deepEqual(await visibleOptions(), ["All projects", "sage", "Council Record (sample)", "order-chaser", "review-queue", "trip-planner", "trip-planner", "home-lab", "recipes"]);
  assert.deepEqual(await page.locator("#pick-list .grp:not([hidden]) > span:first-child").allTextContents(), ["Needs you", "Active · last 14 days", "Idle"]);
  assert.equal(await page.getByRole("button", { name: "Show 1 archived project" }).isVisible(), true);
  assert.equal(await input.getAttribute("aria-activedescendant"), "pick-o-all");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  const active = await input.getAttribute("aria-activedescendant");
  assert.equal(await page.locator(`#${active}`).getAttribute("data-name"), "Council Record (sample)");
  assert.equal(await page.locator(`#${active}`).evaluate(option => option.classList.contains("active")), true);
  await page.keyboard.press("Enter");
  assert.equal(await trigger.getAttribute("aria-expanded"), "false");
  assert.equal(await focused(page), "pick-trig", "focus goes back to the button");
  assert.equal(await page.locator("#pick-name").textContent(), "Council Record (sample)");
  assert.deepEqual(await shown(page), ["T3 Council Record (sample)", "T41 Council Record (sample)"], "the Claude and the Codex task of one repository");
  assert.match(await page.evaluate(() => location.hash), /^#p=product-demos-[0-9a-f]{6}$/);
  assert.match(await page.evaluate(() => localStorage.getItem("board-project")), /^product-demos-[0-9a-f]{6}$/);
  // Esc closes and gives focus back; the choice stays.
  await page.keyboard.press("/");
  await page.keyboard.press("Escape");
  assert.equal(await trigger.getAttribute("aria-expanded"), "false");
  assert.equal(await focused(page), "pick-trig");
  assert.equal(await page.locator("#pick-name").textContent(), "Council Record (sample)");
  // A chip for each other project that needs you takes you there in one click.
  await page.locator('#pick-chips [data-pick^="sage-"]').click();
  assert.equal(await page.locator("#pick-name").textContent(), "sage");
  assert.equal(await page.locator("#pick-all").isVisible(), true);
  await page.locator("#pick-all").click();
  assert.equal(await page.locator("#pick-name").textContent(), "All projects");
});

test("T305: search matches other names and says why; no match, archived and a remembered choice", async t => {
  const page = await open(t);
  await page.locator("#pick-trig").click();
  await page.locator("#pick-q").fill("product-demos");
  const option = page.locator('#pick-list [role=option]:not([hidden])');
  assert.equal(await option.count(), 1);
  assert.equal(await option.getAttribute("data-name"), "Council Record (sample)");
  assert.equal(await option.locator("[data-why]").textContent(), "matches product-demos · ");
  await page.locator("#pick-q").fill("sample-org");
  assert.equal(await option.locator("[data-why]").textContent(), "matches sample-org/council-record · ", "the upstream repository");
  await page.locator("#pick-q").fill("seattle digital");
  assert.equal(await option.count(), 0);
  assert.equal(await page.locator("#pick-none").isVisible(), true);
  assert.equal(await page.locator("#pick-qtext").textContent(), "seattle digital");
  await page.getByRole("button", { name: "Clear the search" }).click();
  assert.equal(await page.locator("#pick-q").inputValue(), "");
  assert.equal(await focused(page), "pick-q");
  // A search finds an archived project; the fold shows it too.
  await page.locator("#pick-q").fill("old-site");
  assert.equal(await option.getAttribute("data-name"), "old-site");
  await page.locator("#pick-q").fill("");
  await page.getByRole("button", { name: "Show 1 archived project" }).click();
  await page.locator('#pick-list [data-name="old-site"]').click();
  assert.deepEqual(await shown(page), ["T2 old-site", "T3 old-site"], "an archived project's tasks show when you choose it");
  // The choice comes back after a reload: from the hash, and from the browser's storage without one.
  const address = await page.evaluate(() => location.href);
  assert.match(address, /#p=old-site-[0-9a-f]{6}$/);
  await reload(page, renderBoardHtml(sample(), { snapshot: false }), address);
  assert.equal(await page.locator("#pick-name").textContent(), "old-site");
  await reload(page, renderBoardHtml(sample(), { snapshot: false }));
  assert.equal(await page.locator("#pick-name").textContent(), "old-site");
  // A choice whose logbook is gone: the board shows all projects and says so.
  await page.evaluate(() => localStorage.setItem("board-project", "gone-abcdef"));
  await reload(page, renderBoardHtml(sample(), { snapshot: false }));
  assert.equal(await page.locator("#pick-name").textContent(), "All projects");
  assert.equal(await page.locator("#gone").isVisible(), true);
});

test("T305: Who, Priority and Kind filter the cards; a project with no logbook of that provider says so", async t => {
  const page = await open(t);
  await page.getByRole("button", { name: "Codex", exact: true }).click();
  assert.deepEqual(await shown(page), ["T3 Council Record (sample)", "T9 review-queue", "T7 sage", "T9 sage"]);
  await page.locator("#f-priority").selectOption("P1");
  assert.deepEqual(await shown(page), ["T9 review-queue", "T7 sage"]);
  await page.locator("#f-kind").selectOption("providers");
  assert.deepEqual(await shown(page), ["T7 sage"]);
  assert.equal(await page.locator("#s-tasks").textContent(), "1");
  await page.getByRole("button", { name: "Clear filters" }).click();
  assert.equal((await shown(page)).length, 25);
  await page.locator("#f-priority").selectOption("none");
  assert.deepEqual((await shown(page)).sort(), ["T13 order-chaser", "T20 trip-planner", "T20 trip-planner", "T205 sage", "T311 sage", "T322 sage", "T8 recipes"].sort());
  await page.locator("#f-priority").selectOption("");
  await page.locator("#pick-trig").click();
  await page.locator('#pick-list [data-name="order-chaser"]').click();
  await page.getByRole("button", { name: "Codex", exact: true }).click();
  assert.equal(await page.locator("#noprov").textContent(), "No Codex logbook in this project. order-chaser has tasks only in Claude. Show all providers");
  assert.equal(await page.locator("#nomatch").isVisible(), false);
  await page.getByRole("button", { name: "Show all providers" }).click();
  assert.deepEqual(await shown(page), ["T13 order-chaser", "T12 order-chaser"], "the backlog task, then the task ready to merge");
});

test("T305 R1023-1 and R1023-2: a live update keeps the open details, the page and column scroll, the focus and the open picker", async t => {
  const page = await open(t, { live: true, width: 1200, height: 700 });
  // A narrow board, so that the columns scroll sideways (a style of the test, not of the page).
  await page.addStyleTag({ content: ".board{grid-auto-flow:column!important;grid-template-columns:none!important;grid-auto-columns:240px!important;overflow-x:auto!important}" });
  await page.locator('details[data-key="fold-backlog"] summary').click();
  await page.locator("[data-scroll=board]").evaluate(board => { board.scrollLeft = 300; });
  await page.evaluate(() => scrollTo(0, 400));
  const t302 = page.locator('.card[data-key$="/T302"]');
  await t302.focus();
  const before = { left: await page.locator("[data-scroll=board]").evaluate(board => board.scrollLeft), y: await page.evaluate(() => scrollY) };
  assert.ok(before.left > 250 && before.y > 350, JSON.stringify(before));
  const nodeBefore = await page.evaluate(() => { window.sampleOldBoard = document.querySelector("main.board"); return true; });
  assert.ok(nodeBefore);
  // An agent changes another task, and then the focused task itself.
  await push(page, sample(rename("T301", "Sample: one password per tunnel, changed")));
  assert.equal(await page.evaluate(() => window.sampleOldBoard === document.querySelector("main.board")), false, "the content was replaced");
  assert.equal(await page.locator('.card[data-key$="/T301"] .title').textContent(), "Sample: one password per tunnel, changed");
  assert.equal(await page.locator('details[data-key="fold-backlog"]').evaluate(details => details.open), true);
  assert.equal(await page.locator("[data-scroll=board]").evaluate(board => board.scrollLeft), before.left);
  assert.equal(await page.evaluate(() => scrollY), before.y);
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.key?.endsWith("/T302")), true, "the focus stays on the same card");
  await push(page, sample(rename("T302", "Sample: the focused task, changed")));
  assert.equal(await page.evaluate(() => document.activeElement?.querySelector(".title")?.textContent), "Sample: the focused task, changed");

  // The open picker keeps its search text and its active row, and its input keeps the focus.
  await page.locator("#pick-trig").click();
  await page.keyboard.type("trip");
  await page.keyboard.press("ArrowDown");
  const active = await page.locator("#pick-q").getAttribute("aria-activedescendant");
  await push(page, sample(rename("T301", "Sample: a third title")));
  assert.equal(await page.locator("#pick-q").inputValue(), "trip");
  assert.equal(await page.locator("#pick-pop").isVisible(), true);
  assert.equal(await page.locator("#pick-q").getAttribute("aria-activedescendant"), active);
  assert.equal(await page.locator(`#${active}`).evaluate(option => option.classList.contains("active")), true);
  assert.equal(await focused(page), "pick-q");
  assert.equal(await page.locator("#pick-list [role=option]:not([hidden])").count(), 2);
});

test("T305 R1023-5: the live pill is no live region; only a failure goes to the status line", async t => {
  const page = await open(t, { live: true });
  assert.equal(await page.locator("#live-state").getAttribute("role"), null);
  await push(page, sample());
  assert.equal(await page.locator("#live-state").textContent(), "Live · updated 12:00");
  assert.equal(await page.locator("#live-alert").textContent(), "");
  await page.evaluate(() => window.sampleBoardStream.onerror());
  assert.equal(await page.locator("#live-alert").textContent(), "Reconnecting · board from 12:00");
  await push(page, sample());
  assert.equal(await page.locator("#live-alert").textContent(), "");
});

test("T305 R1023-4: the theme follows the system, a choice applies before the first paint, and the switch names the other theme", async t => {
  for (const colorScheme of ["light", "dark"]) {
    const page = await open(t, { colorScheme });
    const background = () => page.locator("body").evaluate(body => getComputedStyle(body).backgroundColor);
    assert.equal(await background(), colorScheme === "light" ? "rgb(247, 247, 245)" : "rgb(18, 18, 18)");
    assert.equal(await page.locator("label[for=flip]").innerText(), colorScheme === "light" ? "Dark theme" : "Light theme");
    await page.locator("label[for=flip]").click();
    const other = colorScheme === "light" ? "dark" : "light";
    assert.equal(await page.locator("html").getAttribute("data-theme"), other);
    assert.equal(await page.evaluate(() => localStorage.getItem("board-theme")), other);
    assert.equal(await page.locator("label[for=flip]").innerText(), colorScheme === "light" ? "Light theme" : "Dark theme");
    // A new load: the head script sets the saved theme before the body exists, so no frame shows the system theme.
    await page.addInitScript(() => {
      window.sampleThemeAtBody = "body not seen";
      new MutationObserver((_, observer) => { if (document.body) { window.sampleThemeAtBody = document.documentElement.dataset.theme ?? "none"; observer.disconnect(); } }).observe(document, { childList: true, subtree: true });
    });
    await reload(page, renderBoardHtml(sample(), { snapshot: false }));
    assert.equal(await page.evaluate(() => window.sampleThemeAtBody), other);
    assert.equal(await background(), other === "light" ? "rgb(247, 247, 245)" : "rgb(18, 18, 18)");
  }
});

test("T305 F-T305-8: at 375 px a tap on Close closes the sheet and gives focus back; the button says Close, not Esc", async t => {
  const phone = await open(t, { width: 375, height: 812, colorScheme: "light" });
  await phone.locator("#pick-trig").tap();
  const close = phone.getByRole("button", { name: "Close the project list" });
  assert.equal(await close.innerText(), "Close");
  const box = await close.boundingBox();
  assert.ok(box.width >= 44 && box.height >= 44, JSON.stringify(box));
  await close.tap();
  assert.equal(await phone.locator("#pick-pop").isVisible(), false);
  assert.equal(await focused(phone), "pick-trig");
  const desk = await open(t);
  await desk.locator("#pick-trig").click();
  assert.equal(await desk.getByRole("button", { name: "Close the project list" }).innerText(), "Esc", "a mouse and keyboard screen keeps the Esc hint, and a click on it closes too");
  await desk.getByRole("button", { name: "Close the project list" }).click();
  assert.equal(await desk.locator("#pick-pop").isVisible(), false);
});

test("T305 F-T305-9 and F-T305-6: under each filter the project chips add up to Needs you, and each chip's count is what Needs you says there; a long name ends in an ellipsis", async t => {
  const long = "Council Record, the sample project with a much longer display name";
  const page = await open(t, { html: renderBoardHtml(sample(read => { for (const project of read.flatMap(source => source.projects)) if (project.displayName) project.displayName = long; }), { snapshot: false }) });
  const chips = () => page.locator("#pick-chips .chip:not([hidden])").evaluateAll(list => list.map(chip => [chip.dataset.pick.replace(/-[0-9a-f]{6}$/, ""), Number(chip.querySelector("[data-n]").textContent)]));
  const seen = {};
  for (const priority of ["", "P0", "P1", "P3"]) {
    await page.locator("#f-priority").selectOption(priority);
    const list = await chips(), total = Number(await page.locator("#needs-count").textContent());
    seen[priority || "any"] = [total, list];
    assert.equal(list.reduce((n, [, count]) => n + count, 0), total, `${priority}: ${JSON.stringify(list)}`);
    for (const [key, count] of list) {
      await page.locator(`#pick-chips .chip[data-pick^="${key}-"]`).click();
      assert.equal(Number(await page.locator("#needs-count").textContent()), count, `${priority} ${key}`);
      await page.locator("#pick-all").click();
    }
  }
  assert.deepEqual(seen, { any: [6, [["sage", 3], ["product-demos", 1], ["order-chaser", 1], ["review-queue", 1]]], P0: [3, [["sage", 2], ["product-demos", 1]]], P1: [3, [["sage", 1], ["order-chaser", 1], ["review-queue", 1]]], P3: [0, []] }, "a chip with nothing under the filter hides");
  const name = page.locator('.card .proj[title^="Council Record"]').first();
  assert.equal(await name.getAttribute("title"), long);
  assert.deepEqual(await name.locator(".pn").evaluate(span => [getComputedStyle(span).textOverflow, span.scrollWidth > span.clientWidth]), ["ellipsis", true]);
});

test("T305: at 375 px the list is a bottom sheet and the chips wrap; at 1024 px no column is cut off; in both themes", async t => {
  for (const colorScheme of ["light", "dark"]) {
    const phone = await open(t, { width: 375, height: 812, colorScheme });
    assert.equal(await phone.evaluate(() => document.documentElement.scrollWidth), 375, "no sideways page scroll");
    const chips = await phone.locator("#pick-chips .chip").evaluateAll(list => list.map(chip => chip.getBoundingClientRect()).map(box => [Math.round(box.left), Math.round(box.right)]));
    assert.ok(chips.length >= 3 && chips.every(([left, right]) => left >= 0 && right <= 375), JSON.stringify(chips));
    await phone.locator("#pick-trig").click();
    const sheet = await phone.locator("#pick-pop").boundingBox();
    assert.deepEqual([Math.round(sheet.x), Math.round(sheet.width), Math.round(sheet.y + sheet.height)], [0, 375, 812], "a sheet at the bottom, as wide as the screen");
    const laptop = await open(t, { width: 1024, height: 768, colorScheme });
    const columns = await laptop.locator("[data-col]").evaluateAll(list => list.map(column => column.getBoundingClientRect().right));
    assert.equal(columns.length, 6);
    assert.ok(columns.every(right => right <= 1024), JSON.stringify(columns));
    assert.equal(await laptop.locator("[data-scroll=board]").evaluate(board => board.scrollWidth <= board.clientWidth), true, "no hidden column to scroll to");
  }
});

// R1077: the repairs of round 2 (the picker and the board), as a person sees them. SAMPLE DATA.
async function choose(page, query) {
  await page.locator("#pick-trig").click();
  await page.locator("#pick-q").fill(query);
  await page.keyboard.press("Enter");
}
const visibleCards = page => page.locator(".card[data-key]").evaluateAll(cards => cards.filter(card => card.getClientRects().length).map(card => card.querySelector(".id").textContent));

test("R1075-2: a chosen project's only backlog card shows without the fold; the fold counts what it holds after the filters", async t => {
  const page = await open(t);
  const backlog = page.locator("[data-col=backlog]"), fold = backlog.locator(".rest");
  assert.equal(await fold.isVisible(), true);
  const all = await backlog.locator(".card[data-key]:not([hidden])").count();
  assert.equal(await fold.locator("summary").textContent(), `Show ${all - 6} more tasks`);
  await choose(page, "home-lab");
  assert.deepEqual(await visibleCards(page), ["T5"], "the card shows at once, not behind 'Show all 1'");
  assert.equal(await fold.isVisible(), false, "no fold for 6 or fewer cards");
  await choose(page, "sage");
  const sage = await backlog.locator(".card[data-key]:not([hidden])").count();
  assert.ok(sage > 6, `${sage} sage backlog cards`);
  assert.equal(await backlog.locator(":scope > .card[data-key]:not([hidden])").count(), 6, "the first 6 cards of the project show");
  assert.equal(await fold.locator("summary").textContent(), `Show ${sage - 6} more task${sage - 6 === 1 ? "" : "s"}`);
});

test("R1075-3, R1071-5, R1069-1: the project-gone banner is a status that clears on a pick; a chosen archived project says Archived; its card is no button", async t => {
  const page = await open(t);
  await page.evaluate(() => localStorage.setItem("board-project", "gone-abcdef"));
  await reload(page, renderBoardHtml(sample(), { snapshot: false }));
  assert.equal(await page.locator("#gone").isVisible(), true);
  assert.equal(await page.locator("#gone").evaluate(banner => banner.closest("[role=status]") !== null), true, "a screen reader hears it");
  await page.locator('#pick-chips [data-pick^="sage-"]').click();
  assert.equal(await page.locator("#gone").isVisible(), false, "another pick clears it");
  assert.equal(await page.locator("#pick-arch").isVisible(), false);
  await choose(page, "old-site");
  assert.equal(await page.locator("#pick-name").textContent(), "old-site");
  assert.equal(await page.locator("#pick-arch").isVisible(), true);
  assert.equal(await page.locator("#pick-arch").textContent(), "Archived");
  // A click on an archived card opens the task; it is not the Show archived button.
  await page.evaluate(() => window.addEventListener("click", event => { if (event.target.closest("a.card")) event.preventDefault(); }, true));
  await page.locator(".card[data-archived]:not([hidden])").first().click();
  await page.locator("#pick-trig").click();
  await page.locator("#pick-q").fill("");
  assert.equal(await page.getByRole("button", { name: "Show 1 archived project" }).isVisible(), true, "the archived group is still folded");
});

test("R1075-5, R1071-4, R1075-6: the list closes when the focus leaves it; only options are in the listbox; a status says the count of matches", async t => {
  const page = await open(t);
  assert.equal(await page.locator("#pick-list button, #pick-list .nomatch").count(), 0, "no button or message inside the listbox");
  await page.locator("#pick-trig").click();
  const say = page.locator("#pick-say");
  assert.deepEqual([await say.getAttribute("role"), await say.getAttribute("aria-live")], ["status", "polite"]);
  await page.locator("#pick-q").fill("trip");
  assert.equal(await say.textContent(), "2 projects match");
  await page.locator("#pick-q").fill("zzz sample");
  assert.equal(await say.textContent(), "No project matches “zzz sample”");
  await page.locator("#pick-q").fill("recipes");
  assert.equal(await say.textContent(), "1 project matches");
  // A click on a row still chooses it: the press keeps the focus in the search field.
  await page.locator("#pick-list [role=option]:not([hidden])").filter({ hasText: "recipes" }).click();
  assert.equal(await page.locator("#pick-name").textContent(), "recipes");
  // Tab out of the list: it closes.
  await page.locator("#pick-trig").click();
  assert.equal(await page.locator("#pick-trig").getAttribute("aria-expanded"), "true");
  const inside = () => page.evaluate(() => !!document.activeElement.closest(".pickwrap"));
  for (let i = 0; i < 6 && await inside(); i++) {
    assert.equal(await page.locator("#pick-pop").isVisible(), true, "open while the focus is in the picker");
    await page.keyboard.press("Tab");
  }
  assert.equal(await inside(), false);
  assert.equal(await page.locator("#pick-pop").isVisible(), false);
  assert.equal(await page.locator("#pick-trig").getAttribute("aria-expanded"), "false");
});

test("R1075-7: at 375 px each chip, filter, the picker button and the Archived summary are 44 px high; a stand-in's reason shows on focus", async t => {
  const phone = await open(t, { width: 375, height: 812, colorScheme: "light" });
  const heights = await phone.evaluate(() => [".pick .chip:not([hidden])", "#pick-trig", ".fbar select", ".fbar .seg button", "#sum-archived"].map(selector => [selector, Math.min(...[...document.querySelectorAll(selector)].filter(e => e.getClientRects().length).map(e => e.getBoundingClientRect().height))]));
  for (const [selector, height] of heights) assert.ok(height >= 44, `${selector}: ${height} px`);
  const model = sample(), task = model.tasks.find(item => item.agents.some(agent => !agent.provider));
  assert.ok(task, "the sample has a run with no recorded provider");
  const page = await open(t, { width: 375, height: 812, html: renderBoardHtml(model, { snapshot: false, taskKey: task.key }) });
  const standIn = page.locator(".standin[tabindex]").first();
  await standIn.focus();
  assert.match(await standIn.evaluate(element => getComputedStyle(element, "::after").content), /Stand-in: the logbook's source/);
  await standIn.tap();
  assert.equal(await page.evaluate(() => document.activeElement.classList.contains("standin")), true, "a tap focuses it, so the reason shows");
});

test("R1071-3: with a 15 px scroll bar, the board does not scroll sideways at 1181 to 1195 px", async t => {
  for (const width of [1181, 1185, 1190, 1195]) {
    const page = await open(t, { width, height: 900 });
    // Headless Chromium has overlay scroll bars; a 15 px padding takes the width that a classic scroll bar takes.
    await page.addStyleTag({ content: "html{padding-right:15px}" });
    assert.equal(await page.locator("[data-scroll=board]").evaluate(board => board.scrollWidth - board.clientWidth), 0, `${width} px`);
  }
});
