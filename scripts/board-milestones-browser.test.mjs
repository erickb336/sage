// Standalone browser check of the T233 milestone views (T368): the Milestone filter, the Needs you strip and its counts, the
// address that keeps the milestone, and no sideways scroll on the board, the milestones list, a milestone page and a task page
// at 375 and 1280 px, light and dark. SAMPLE DATA from scripts/fixtures/board-milestones.mjs. It runs in
// `npm run test:browser`, not in `npm test`, with Playwright's bundled Chromium, or the headless shell at
// BOARD_BROWSER_PATH; never an installed Chrome.
import "./test-env.mjs";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { after, before, test } from "node:test";
import { buildBoardModel } from "../packages/sage-core/board-model.mjs";
import { renderBoardHtml, renderMilestonesHtml, renderReleasesHtml } from "../packages/sage-core/board-render.mjs";
import { NOW, milestonesSource, milestonesTables } from "./fixtures/board-milestones.mjs";
import { NOW as RELEASES_NOW, releasesSource } from "./fixtures/board-releases.mjs";
import { expectTheme } from "./fixtures/contrast.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const model = buildBoardModel([milestonesSource()], { now: NOW });
const key = id => Buffer.from(`claude/sage-ff5ee2/${id}`).toString("base64url");
let browser;
before(async () => { browser = await chromium.launch({ headless: true, ...(process.env.BOARD_BROWSER_PATH ? { executablePath: process.env.BOARD_BROWSER_PATH } : {}) }); });
after(async () => { await browser?.close(); });

/** The served pages at a made-up origin; every other request fails. */
const PAGES = {
  "/": () => renderBoardHtml(model, { snapshot: false }),
  "/milestones": () => renderMilestonesHtml(model),
  [`/milestone/${key("M1")}`]: () => renderMilestonesHtml(model, { milestoneKey: `claude/sage-ff5ee2/M1` }),
  [`/task/${key("T13")}`]: () => renderBoardHtml(model, { snapshot: false, taskKey: `claude/sage-ff5ee2/T13` }),
  "/snapshot": () => renderBoardHtml(model),
};
// The offline snapshot holds its task, milestones and milestone pages; an address hash opens each (R1347-1).
const SNAPSHOT_PAGES = [`#task-${key("T13")}`, "#milestones", `#milestone-${key("M1")}`];
// Two projects, each with the sample milestones: the picker and the address have a project to choose (R1322-1, R1324-5).
const other = milestonesSource("codex");
Object.assign(other.projects[0], { key: "codex/other-abc123", name: "other-abc123", checkout: "/sample/other", displayName: "other (sample)" });
const two = buildBoardModel([milestonesSource(), other], { now: NOW });
const TWO = {
  "/": () => renderBoardHtml(two, { snapshot: false }),
  "/milestones": () => renderMilestonesHtml(two),
  [`/milestone/${key("M1")}`]: () => renderMilestonesHtml(two, { milestoneKey: `claude/sage-ff5ee2/M1` }),
};
/** A page at the made-up origin. The theme is dark; theme "light" flips the switch, as a person does. */
async function open(t, path = "/", { width = 1280, height = 900, theme = "dark", hash = "", pages = PAGES, project = null } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, colorScheme: "light", reducedMotion: "reduce", ...(width < 700 ? { isMobile: true, hasTouch: true } : {}) });
  t.after(() => context.close());
  await context.route("**/*", route => route.abort());
  for (const [at, html] of Object.entries(pages)) await context.route(`http://board.test${at}`, route => route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html() }));
  // A project that the viewer chose before, kept in localStorage.
  if (project) await context.addInitScript(value => localStorage.setItem("board-project", value), project);
  const page = await context.newPage(), errors = [];
  page.on("pageerror", error => errors.push(String(error)));
  t.after(() => assert.deepEqual(errors, [], "no script error"));
  await page.goto(`http://board.test${path}${hash}`);
  if (theme === "light") await page.locator("label[for=flip]").click();
  return page;
}
const shownIds = page => page.locator(".card[data-key]:not([hidden]) .id").allTextContents();
const visible = (page, selector) => page.locator(selector).isVisible();

test("T368: the Milestone filter keeps its milestone's cards and its Needs you item, keeps the choice in the address, and Clear filters ends it", async t => {
  const page = await open(t);
  assert.equal(await page.locator("#needstrip-n").textContent(), "2");
  await page.selectOption("#f-milestone", key("M1"));
  assert.deepEqual((await shownIds(page)).sort(), ["T11", "T12", "T13"], "the M1 cards on the board (its merged tasks have no time in the last 7 days)");
  assert.equal(await visible(page, "#needstrip"), false, "M1 has no item of its own");
  assert.match(await page.evaluate(() => location.hash), new RegExp(`^#pg=${key("M1")}$`));
  await page.selectOption("#f-milestone", key("M2"));
  assert.deepEqual((await shownIds(page)).sort(), ["T22", "T23"]);
  assert.equal(await page.locator("#needstrip-n").textContent(), "1");
  assert.equal(await page.locator("#needstrip li:not([hidden]) .what").textContent(), "Milestone M2, Lead build: the pilot T21 was abandoned. Choose a new pilot, or drop the milestone. · sage (sample) · Claude logbook");
  assert.equal(await page.locator("#s-needs").textContent(), "1", "the summary counts the item that shows");
  await page.selectOption("#f-milestone", "none");
  assert.deepEqual((await shownIds(page)).sort(), ["T70"]);
  await page.click("#f-clear");
  assert.equal(await page.locator("#f-milestone").inputValue(), "");
  assert.equal(await page.locator("#needstrip-n").textContent(), "2");
  assert.equal(await page.evaluate(() => location.hash), "");
});

test("T368 QD: a done milestone with no card on the board says why, links to its page, and shows no plain no-match note", async t => {
  const page = await open(t);
  await page.selectOption("#f-milestone", key("M5"));
  assert.deepEqual(await shownIds(page), []);
  assert.equal(await visible(page, "#noprog"), true);
  assert.equal(await visible(page, "#nomatch"), false);
  assert.equal(await page.locator("#noprog-name").textContent(), "M5 Old pilot (done)");
  assert.equal(await page.locator("#noprog-why").textContent(), "Its tasks ended more than 7 days ago, and the board shows the last 7 days of Done.");
  assert.equal(await page.locator("#noprog-link").getAttribute("href"), `/milestone/${key("M5")}`);
});

test("T368: a milestone page's link to its tasks opens the board with the Milestone filter on", async t => {
  const page = await open(t, `/milestone/${key("M1")}`);
  await page.click("text=Its tasks on the board");
  await page.waitForURL(/pg=/);
  assert.equal(await page.locator("#f-milestone").inputValue(), key("M1"));
  assert.deepEqual((await shownIds(page)).sort(), ["T11", "T12", "T13"]);
});

test("R1322-1: the link to a milestone's tasks names its project, so a project chosen before does not hide its cards", async t => {
  const page = await open(t, `/milestone/${key("M1")}`, { pages: TWO, project: "other-abc123" });
  await page.click("text=Its tasks on the board");
  await page.waitForURL(/pg=/);
  assert.equal(await page.locator("#pick-name").textContent(), "sage (sample)");
  assert.deepEqual((await shownIds(page)).sort(), ["T11", "T12", "T13"]);
  assert.equal(await visible(page, "#noprog"), false);
});

test("R1324-5: the milestones list's picker keeps one project's milestones with their counts; its Needs you chip opens the board with Needs you on", async t => {
  const page = await open(t, "/milestones", { pages: TWO });
  const rows = () => page.locator("li[data-project]:visible").evaluateAll(list => list.map(li => li.dataset.project));
  assert.equal((await rows()).length, 16, "both projects' milestones (the dropped one is folded)");
  await page.click("#pick-trig");
  await page.click('#pick-list [role=option][data-key="other-abc123"]');
  assert.equal(await page.locator("#pick-name").textContent(), "other (sample)");
  assert.deepEqual([...new Set(await rows())], ["other-abc123"]);
  assert.deepEqual(await page.locator("h2.grp").allTextContents(), ["Needs you 3", "Active 4", "Done 1"]);
  assert.equal(await page.locator("#sum-dropped").textContent(), "Dropped (1)");
  assert.equal(await page.locator("#needs-count").textContent(), "8", "the count is the server's: a milestones page has no cards to count");
  await page.click("a.chip.need");
  // The board takes needs=1 out of the address as it loads (T374), so wait for the board itself, not for needs=1.
  await page.waitForURL(url => url.pathname === "/");
  assert.equal(await page.locator("[data-filter=needs]").getAttribute("aria-pressed"), "true");
  assert.ok((await shownIds(page)).length > 0 && (await page.locator(".card[data-key]:not([hidden])").evaluateAll(cards => cards.every(card => card.dataset.needs === "true"))));
});

for (const [width, height] of [[375, 812], [1280, 900]]) for (const theme of ["light", "dark"]) {
  test(`T368, T349, R1347-1: no sideways scroll at ${width} px, ${theme}: the board, the milestones list, a milestone page, a task page and the snapshot's pages; the page shell is edge to edge below 700 px`, async t => {
    for (const [path, hash] of [...Object.keys(PAGES).map(path => [path, ""]), ...SNAPSHOT_PAGES.map(hash => ["/snapshot", hash])]) {
      const at = path + hash, page = await open(t, path, { width, height, theme });
      // The snapshot's page hides the board header and its switch, so the hash comes after the theme.
      if (hash) await page.evaluate(value => { location.hash = value; }, hash);
      await expectTheme(page, theme, at);
      const { scroll, client } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
      assert.ok(scroll <= client, `${at}: ${scroll} > ${client}`);
      // The shell: the rounded panel on the shell colour that holds the page, inset 8 px or more on a wide screen, the whole width on a phone.
      const shells = page.locator(".boardview:visible, body > main.page:visible, #pages > .page:visible");
      assert.equal(await shells.count(), 1, `${at}: one shell shows`);
      const [left, right, radius, back] = await shells.evaluate(element => { const box = element.getBoundingClientRect(), style = getComputedStyle(element); return [Math.round(box.left), Math.round(box.right), style.borderTopLeftRadius, style.backgroundColor]; });
      assert.equal(back, await page.evaluate(() => { const probe = document.body.appendChild(document.createElement("i")); probe.style.color = "var(--shell)"; const color = getComputedStyle(probe).color; probe.remove(); return color; }), `${at}: the shell colour`);
      if (width === 375) assert.deepEqual([left, right, radius], [0, 375, "0px"], at);
      else assert.ok(left >= 8 && right <= client - 8 && radius === "20px", `${at}: ${left} to ${right}, radius ${radius}`);
    }
  });
}

// R1334-1, R1334-2: long milestone names (SAMPLE DATA). M1 (T13's milestone) gets 41 characters, M2 (T22's) gets 108.
const MID = "Provider neutral board core for all tools", LONG = `${"A long milestone. ".repeat(5)}that ends here now`;
const named = milestonesTables();
for (const row of named.milestones) row.name = { M1: MID, M2: LONG }[row.id] ?? row.name;
const long = buildBoardModel([milestonesSource("claude", named)], { now: NOW });
const LONG_PAGES = {
  "/": () => renderBoardHtml(long, { snapshot: false }),
  [`/task/${key("T13")}`]: () => renderBoardHtml(long, { snapshot: false, taskKey: "claude/sage-ff5ee2/T13" }),
  [`/task/${key("T22")}`]: () => renderBoardHtml(long, { snapshot: false, taskKey: "claude/sage-ff5ee2/T22" }),
};
test("R1334-1, R1334-2: at 375 px, a 41- and a 108-character milestone name make no sideways scroll, and the theme switch stays on screen", async t => {
  assert.deepEqual([MID.length, LONG.length], [41, 108]);
  const full = { [`/task/${key("T13")}`]: MID, [`/task/${key("T22")}`]: LONG };
  for (const path of Object.keys(LONG_PAGES)) {
    const page = await open(t, path, { width: 375, height: 812, pages: LONG_PAGES });
    const { scroll, client } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
    assert.ok(scroll <= client, `${path}: ${scroll} > ${client}`);
    const theme = await page.locator("label.theme").boundingBox();
    assert.ok(theme.x >= 0 && theme.x + theme.width <= client, `${path}: the theme switch ends at ${theme.x + theme.width}, past ${client}`);
    if (full[path]) assert.equal(await page.locator(".pagebar a.plink").getAttribute("title"), full[path], `${path}: the title has the full name`);
    else assert.ok((await page.locator("#f-milestone option").allTextContents()).some(text => text.includes(LONG)), "the Milestone filter lists the full name");
  }
});

// T996: two projects with releases (SAMPLE DATA from scripts/fixtures/board-releases.mjs); the picker keeps one project's frame.
const otherReleases = releasesSource(undefined, "codex");
Object.assign(otherReleases.projects[0], { key: "codex/other-abc123", name: "other-abc123", checkout: "/sample/other", displayName: "other (sample)" });
const released = buildBoardModel([releasesSource(), otherReleases], { now: RELEASES_NOW });
const RELEASED = { "/": () => renderBoardHtml(released, { snapshot: false }), "/releases": () => renderReleasesHtml(released) };
test("T996: the project picker keeps the chosen project's frame on the board and its releases on the Releases tab, with no sideways scroll", async t => {
  const shown = page => page.locator("[data-rproject]:not([hidden])").evaluateAll(list => list.map(e => e.dataset.rproject));
  for (const path of Object.keys(RELEASED)) {
    assert.deepEqual(await shown(await open(t, path, { pages: RELEASED })), ["sage-ff5ee2", "other-abc123"], `${path}: all projects`);
    const page = await open(t, path, { pages: RELEASED, project: "other-abc123", width: 375, height: 812 });
    assert.deepEqual(await shown(page), ["other-abc123"], `${path}: one project`);
    const { scroll, client } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
    assert.ok(scroll <= client, `${path}: ${scroll} > ${client}`);
  }
});
