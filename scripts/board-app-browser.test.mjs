import "./test-env.mjs";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createBoardServer, loadBoardApp } from "../packages/sage-board/server.mjs";
import { writeAppLogbook } from "./fixtures/board-app.mjs";
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

async function open(t, { viewport = { width: 1440, height: 1000 }, clock = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "sage-board-app-browser-")), root = join(dir, "logbooks"), port = await freePort();
  const project = writeAppLogbook(root, new Date().toISOString());
  const server = createBoardServer({ sources: [{ id: "sample", path: root, label: "Sample" }], port, app: APP, settleReads: [] });
  await server.start();
  const base = `http://127.0.0.1:${port}`;
  const context = await browser.newContext({ viewport, colorScheme: "dark" });
  t.after(async () => { await context.close(); await server.close(); rmSync(dir, { recursive: true, force: true }); });
  const requests = [], problems = [];
  await context.route("**/*", route => { requests.push(route.request().url()); return route.request().url().startsWith(`${base}/`) ? route.continue() : route.abort(); });
  const page = await context.newPage();
  page.on("pageerror", error => problems.push(String(error)));
  page.on("console", message => { if (message.type() === "error" || /Content Security Policy|Refused to/.test(message.text())) problems.push(message.text()); });
  if (clock) await page.clock.install();
  await page.goto(`${base}/app/`);
  await page.getByRole("heading", { name: "Needs you" }).waitFor();
  return { page, base, project, server, requests, problems };
}

const texts = locator => locator.allTextContents();

test("T1054: the Overview answers J1 and J2 with no click, from the logbook, and makes no request outside the board", async t => {
  const { page, base, requests, problems } = await open(t);
  assert.deepEqual(await texts(page.locator(".needs .q")), ["Can a viewer copy a shared list into their own lists?", "Crash reports: send them on their own, or ask each time?"], "J1: what needs the owner, oldest first");
  assert.match(await page.locator(".needs li").first().textContent(), /Recommended: A: yes, as a new private list.*G4.*T10 · Sample sync design.*asked 3 h ago/);
  assert.deepEqual(await texts(page.locator(".ms .name")), ["Milestone 2: Offline syncP0in progress", "Milestone 1: Board redesignP1in progress", "Milestone 3: Sign-in reworkdone"], "J2: milestones by priority");
  assert.deepEqual(await texts(page.locator(".ms .of")), ["0 of 2 merged", "1 of 4 merged", "2 of 2 merged"]);
  assert.deepEqual(await texts(page.locator(".kpi .n")), ["1", "1", "–"]);
  assert.equal(await page.locator(".counts h2").textContent(), "In the last 24 hours");
  await page.getByRole("link", { name: "Agents" }).click();
  await page.getByText("This page comes next").waitFor();
  assert.equal(await page.locator(".needs").count(), 0, "a page that comes next shows no data");
  assert.equal(await page.getByRole("link", { name: "classic board" }).getAttribute("href"), "/agents");
  await page.getByRole("link", { name: /^Overview/ }).click();
  await page.getByRole("heading", { name: "Milestones" }).waitFor();
  assert.ok(requests.length >= 4);
  assert.deepEqual(requests.filter(url => !url.startsWith(`${base}/`)), [], "no request outside 127.0.0.1");
  assert.deepEqual(problems, [], "no script error and no CSP refusal");
});

test("T1054: the Overview updates live, keeps its data when the link breaks, and says how old it is", async t => {
  const { page, project, server, problems } = await open(t);
  const gates = join(project, "gates.tsv");
  writeFileSync(gates, readFileSync(gates, "utf8").replace("Crash reports: send them on their own, or ask each time?", "Crash reports: <b>send</b> them?"));
  await page.getByText("Crash reports: <b>send</b> them?", { exact: true }).waitFor();
  assert.match(await page.getByRole("status").textContent(), /^Live · read \d\d:\d\d/);
  await server.close();
  await page.getByText("The board lost its link to the server on this Mac.").waitFor();
  assert.match(await page.getByRole("status").textContent(), /^Not updated since .*\d\d:\d\d, just now · trying again$/);
  assert.equal(await page.locator(".needs li").count(), 2, "the last data stays");
  assert.ok(problems.every(text => /Failed to load resource|ERR_CONNECTION_REFUSED|EventSource/.test(text)), problems.join("\n"));
});

test("T1054: a logbook that the board cannot read shows the last data with a warning, not an empty board", async t => {
  const { page, project } = await open(t);
  writeFileSync(join(project, "tasks.tsv"), "not\ta\ttasks\ttable\n");
  await page.getByText("The board cannot read the logbook.").waitFor();
  assert.match(await page.getByRole("status").textContent(), /^Not updated since/);
  assert.equal(await page.locator(".ms > li").count(), 3);
});

test("T1054: text and controls meet AA contrast in the dark and the light theme, and the theme switch keeps the choice", async t => {
  const { page } = await open(t);
  for (const theme of ["dark", "light"]) {
    if (theme === "light") await page.getByRole("button", { name: "Switch to the light theme" }).click();
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), theme);
    const low = (await page.evaluate(measureContrast)).filter(item => item.ratio < item.need);
    assert.deepEqual(low, [], `${theme}: every text meets AA`);
  }
  await page.reload();
  await page.getByRole("heading", { name: "Needs you" }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "light");
});

test("T1054: the keyboard reaches each page link and the theme switch in order, with a visible focus ring", async t => {
  const { page } = await open(t);
  const reached = [];
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press("Tab");
    reached.push(await page.evaluate(() => {
      const element = document.activeElement, style = getComputedStyle(element);
      return { name: element.getAttribute("aria-label") ?? element.textContent.trim(), ring: `${style.outlineStyle} ${style.outlineWidth}` };
    }));
  }
  assert.deepEqual(reached.map(item => item.name), ["Overview2", "Tasks6", "Agents", "Pull requests1", "Switch to the light theme"]);
  for (const item of reached) assert.equal(item.ring, "solid 2px", item.name);
  await page.keyboard.press("Enter");
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "light", "Enter on the theme switch flips it");
});

test("F-T1065-5, -8, -11: ages count from the time now, not from the last logbook read, and a lost link says how old its data is", async t => {
  const { page, server } = await open(t, { clock: true });
  const first = page.locator(".needs li").first();
  assert.match(await first.textContent(), /asked 3 h ago/);
  await page.clock.fastForward("02:00:00");
  await page.getByText("asked 5 h ago").waitFor();
  await server.close();
  await page.getByText("The board lost its link to the server on this Mac.").waitFor();
  await page.clock.fastForward("10:00");
  await page.getByText(/^Not updated since .*\d\d:\d\d, 10 min ago · trying again$/).waitFor();
  assert.match(await page.locator(".banner").textContent(), /The data below is from .*\d\d:\d\d, 10 min ago\./);
});

test("F-T1065-6, -7, -1, -9: Needs you comes first and names each chief; a milestone names its abandoned tasks and keeps its badges on its name line", async t => {
  const { page, project } = await open(t);
  const top = async id => (await page.locator(`#${id}`).boundingBox()).y;
  assert.ok(await top("needs-h") < await top("counts-h"), "Needs you is above the counts");
  assert.match(await page.locator(".needs li").first().locator(".meta").textContent(), /^chief Sample/);
  for (const name of await page.locator(".ms .name").all()) {
    const [link, badge] = [await name.locator("a").boundingBox(), await name.locator(".badge").last().boundingBox()];
    assert.ok(Math.abs(link.y - badge.y) < 6, "the badges sit on the first line of the name");
  }
  const tasks = join(project, "tasks.tsv");
  writeFileSync(tasks, readFileSync(tasks, "utf8").replace(/^(T3\t.*?\t)reviewing\t/m, "$1abandoned\t"));
  await page.getByText("T3 abandoned", { exact: true }).waitFor();
});

test("F-T1065-10, -18: a long word wraps inside its card, and the Milestones card shows 6 milestones until the owner asks for all", async t => {
  const { page, project } = await open(t);
  const gates = join(project, "gates.tsv"), milestones = join(project, "milestones.tsv");
  writeFileSync(gates, readFileSync(gates, "utf8").replace("Crash reports: send them on their own, or ask each time?", `https://example.test/${"x".repeat(400)}`));
  const extra = Array.from({ length: 7 }, (_, i) => [`M${i + 4}`, `Sample extra ${i + 4}`, "Sample goal", `T${i + 90}`, `G${i + 90}`, new Date().toISOString()].join("\t"));
  writeFileSync(milestones, `${readFileSync(milestones, "utf8")}${extra.join("\n")}\n`);
  await page.getByRole("button", { name: "Show 4 more milestones" }).waitFor();
  assert.equal(await page.locator(".ms > li").count(), 6);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 1440, "the page does not get wider");
  assert.ok(await page.locator(".needs").evaluate(list => list.scrollWidth <= list.clientWidth), "the long word stays in the Needs you card");
  await page.getByRole("button", { name: "Show 4 more milestones" }).click();
  assert.equal(await page.locator(".ms > li").count(), 10);
  await page.getByRole("button", { name: "Show the first 6 only" }).click();
  assert.equal(await page.locator(".ms > li").count(), 6);
});

test("F-T1065-19: at 200% zoom of a 1280 px window, the pages bar goes above the content, which gets the whole width", async t => {
  const { page } = await open(t, { viewport: { width: 640, height: 900 } });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 640);
  const [side, main] = [await page.locator(".side").boundingBox(), await page.locator(".main").boundingBox()];
  assert.equal(side.width, 640);
  assert.ok(main.y >= side.y + side.height && main.width === 640, JSON.stringify({ side, main }));
  assert.equal(await page.getByRole("link", { name: /^Tasks/ }).isVisible(), true, "the page links keep their names");
});
