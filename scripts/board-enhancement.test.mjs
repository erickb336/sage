// Standalone browser check. Provide Playwright through NODE_PATH; do not add it to the default test command.
// It runs Playwright's bundled Chromium (PLAYWRIGHT_BROWSERS_PATH), or the headless shell at BOARD_BROWSER_PATH; never an installed Chrome.
// Example: NODE_PATH="$PLAYWRIGHT_MODULES" PLAYWRIGHT_BROWSERS_PATH="$SCRATCH/browsers" node --test scripts/board-enhancement.test.mjs
import "./test-env.mjs";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer as createPortServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { buildBoardModel } from "../packages/sage-core/board-model.mjs";
import { renderBoardHtml } from "../packages/sage-core/board-render.mjs";
import { createBoardServer } from "../packages/sage-board/server.mjs";
import { contrastPages, measureContrast, shownTheme, themeToken } from "./fixtures/contrast.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const NOW = "2026-10-08T20:00:00Z";
let browser;
before(async () => { browser = await chromium.launch({ headless: true, ...(process.env.BOARD_BROWSER_PATH ? { executablePath: process.env.BOARD_BROWSER_PATH } : {}) }); });
after(async () => { await browser?.close(); });

function model({ gamma = null, delta = false, current = false, rich = false } = {}) {
  const task = (id, title, state) => ({ id, title, state, size: "small", risk: "", route: "build,code-review,qa", branch: "", pr: "", round: "0", keys: "" });
  const project = (name, tasks, gates = []) => ({ key: `sample/${name}-abcdef`, name: `${name}-abcdef`, diagnostics: [], tables: { tasks, gates } });
  const projects = [
    project("alpha", [task("T1", "Sample alpha queued", "framed"), task("T2", "Sample alpha review", "reviewing")], [{ id: "G1", task: "T2", question: "Sample: accept the result?", options: "yes|no", recommendation: "yes", answer: "" }]),
    project("beta", [task("T3", "Sample beta held", "held"), task("T4", "Sample beta work", "building")], [{ id: "G2", task: "T3", question: "Sample: go on?", answer: "" }]),
  ];
  if (current) {
    const head = "a".repeat(40);
    projects[0].tables.tasks[1].pr = "7";
    projects[0].tables.runs = [{ id: "R1", task: "T2", role: "code-reviewer", status: "running", started: NOW, tokens: "1200" }];
    // T2 has an open gate, so its step needs you; T4's build runs now (R1077: running now only with a live run).
    projects[1].tables.runs = [{ id: "R3", task: "T4", role: "implementer", status: "running", started: NOW }];
    projects[0].observations = { records: [
      { id: "O1", task: "T2", kind: "pr", source: "Sample recorder", observedAt: NOW, data: { number: 7, state: "open", head, repository: "https://example.test/sample/sage" } },
      { id: "O2", task: "T2", kind: "run", source: "Sample recorder", observedAt: NOW, data: { run: "R1", provider: "Codex", head, cycle: 1 } },
    ] };
  }
  if (rich) {
    // A full backlog (its fold), a PR with no recorded head, and a decision: each shows faint text.
    projects[0].tables.tasks.push(...Array.from({ length: 7 }, (_, i) => task(`T${10 + i}`, `Sample alpha queued ${10 + i}`, "framed")));
    projects[1].tables.tasks[1].pr = "9";
    projects[0].tables.decisions = [{ at: NOW, task: "T2", decision: "Sample decision", why: "sample" }];
    // An earlier head in the evidence, and a second source, whose agents get the alternate pill colour.
    projects[0].tables.ledger = [{ task: "T2", pr: "7", sha: "b".repeat(40), kind: "checks-fail", cycle: "1", at: NOW }, { task: "T2", pr: "7", sha: "a".repeat(40), kind: "checks-pass", cycle: "1", at: NOW }];
  }
  if (gamma) projects.push(project("gamma", [task("T5", "Sample gamma work", gamma)], gamma === "held" ? [{ id: "G3", task: "T5", question: "Sample: go on?", answer: "" }] : []));
  if (delta) projects.push(project("delta", [task("T6", "Sample delta queued", "framed")]));
  const epsilon = project("epsilon", [task("T7", "Sample second-source work", "building")]);
  epsilon.tables.runs = [{ id: "R2", task: "T7", role: "implementer", status: "running", started: NOW }];
  const second = rich ? [{ id: "codex", label: "codex", diagnostics: [], projects: [epsilon] }] : [];
  return buildBoardModel([{ id: "sample", label: "Sample source", diagnostics: [], projects }, ...second], { now: NOW });
}

async function pageFor(t, { live = false, snapshot = !live, scripts = true, phone = false, current = false } = {}) {
  const context = await browser.newContext({ javaScriptEnabled: scripts, colorScheme: "dark", reducedMotion: "reduce", viewport: phone ? { width: 390, height: 844 } : { width: 1280, height: 900 } });
  t.after(() => context.close());
  await context.route("**/*", route => route.abort());
  const page = await context.newPage();
  if (live) {
    // Only the transport is a fixture. The renderer's actual script handles the event and changes the real DOM.
    await page.evaluate(() => {
      window.EventSource = class extends EventTarget {
        constructor() { super(); window.sampleBoardStream = this; }
        close() {}
      };
    });
  }
  await page.setContent(renderBoardHtml(model({ current }), { live, snapshot }));
  return page;
}

const visibleCards = async page => (await page.locator(".card:not([hidden])").evaluateAll(cards => cards.map(card => `${card.querySelector(".id").textContent} · ${card.querySelector(".title").textContent}`))).sort();
const card = (page, text) => page.locator("a.card", { hasText: text });
const summary = page => page.locator("#board-summary").evaluate(element => element.innerText.replace(/\s+/g, " ").replace(/ built .*$/, ""));
const needsButton = page => page.getByRole("button", { name: /^Needs you / });
async function update(page, data) {
  await page.evaluate(html => window.sampleBoardStream.dispatchEvent(new MessageEvent("board", { data: JSON.stringify({ html, stale: false }) })), renderBoardHtml(data, { snapshot: false, live: true }));
  assert.equal(await page.locator("#live-state").textContent(), "Live · updated 20:00");
}

/** Chooses a project in the picker by its shown name (T305: the picker replaces the row of project chips). */
async function pick(page, name) {
  await page.locator("#pick-trig").click();
  await page.locator(`#pick-list [role=option][data-name="${name}"]`).click();
}
const picked = page => page.locator("#pick-name").textContent();

test("T205, T305: real DOM keeps the chosen project, the needs filter and the theme across live project and count changes", async t => {
  const page = await pageFor(t, { live: true });
  assert.deepEqual(await visibleCards(page), ["T1 · Sample alpha queued", "T2 · Sample alpha review", "T3 · Sample beta held", "T4 · Sample beta work"]);
  assert.equal(await page.locator("body").evaluate(body => getComputedStyle(body).getPropertyValue("--bg").trim()), themeToken("dark", "--bg"), "no choice: the dark theme");
  await page.locator("label[for=flip]").click();
  await pick(page, "alpha");
  await needsButton(page).click();
  assert.deepEqual(await visibleCards(page), ["T2 · Sample alpha review"]);

  await update(page, model({ gamma: "held" }));
  assert.equal(await picked(page), "alpha");
  assert.equal(await needsButton(page).getAttribute("aria-pressed"), "true");
  assert.equal(await needsButton(page).textContent(), "Needs you 1"); // T217: the count follows the chosen project (alpha)
  assert.equal(await summary(page), "1 needs you 0 agents at work 1 in review 1 tasks");
  assert.deepEqual(await visibleCards(page), ["T2 · Sample alpha review"]);
  assert.equal(await page.locator("html").getAttribute("data-theme"), "light");
  assert.equal(await page.locator("body").evaluate(body => getComputedStyle(body).getPropertyValue("--bg").trim()), themeToken("light", "--bg"));

  // This option did not exist when the script first ran; a direct listener on the old options cannot handle it.
  await pick(page, "gamma");
  assert.deepEqual(await visibleCards(page), ["T5 · Sample gamma work"]);
  await update(page, model({ gamma: "building" }));
  assert.equal(await needsButton(page).textContent(), "Needs you 0"); // gamma has no task that needs you now
  assert.deepEqual(await visibleCards(page), []);
  await needsButton(page).click();
  assert.deepEqual(await visibleCards(page), ["T5 · Sample gamma work"]);

  // T305 "project gone": the chosen project has no logbook now. The board shows all projects and says so.
  await update(page, model({ delta: true }));
  assert.equal(await page.locator('#pick-list [data-name="gamma"]').count(), 0);
  assert.equal(await picked(page), "All projects");
  assert.equal(await page.locator("#gone").isVisible(), true);
  assert.equal(await needsButton(page).getAttribute("aria-pressed"), "false");
  assert.deepEqual(await visibleCards(page), ["T1 · Sample alpha queued", "T2 · Sample alpha review", "T3 · Sample beta held", "T4 · Sample beta work", "T6 · Sample delta queued"]);
  await page.getByRole("button", { name: "Dismiss" }).click();
  assert.equal(await page.locator("#gone").isVisible(), false);
  assert.equal(await page.locator("html").getAttribute("data-theme"), "light");
  await pick(page, "delta");
  assert.deepEqual(await visibleCards(page), ["T6 · Sample delta queued"]);
});

test("T205: phone filtering puts visible owner work first and removes empty columns", async t => {
  const page = await pageFor(t, { live: true, phone: true });
  await pick(page, "alpha");
  const columnOrder = () => page.locator("[data-col]").evaluateAll(columns => columns
    .filter(column => getComputedStyle(column).display !== "none")
    .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)
    .map(column => column.getAttribute("aria-label")));
  assert.deepEqual(await columnOrder(), ["In review", "Backlog"]);
  assert.deepEqual(await visibleCards(page), ["T1 · Sample alpha queued", "T2 · Sample alpha review"]);
  await needsButton(page).click();
  assert.deepEqual(await columnOrder(), ["In review"]);
  assert.deepEqual(await visibleCards(page), ["T2 · Sample alpha review"]);
  await update(page, model({ gamma: "held" }));
  assert.deepEqual(await columnOrder(), ["In review"]);
  await pick(page, "gamma");
  assert.deepEqual(await columnOrder(), ["Building"]);
  assert.deepEqual(await visibleCards(page), ["T5 · Sample gamma work"]);
  await update(page, model({ gamma: "building" }));
  assert.deepEqual(await columnOrder(), []);
  await needsButton(page).click();
  assert.deepEqual(await columnOrder(), ["Building"]);
  assert.equal(await page.locator(".col.needs-col:not(.empty-col)").count(), 0);
});

test("T218: offline task pages, the backlog fold and the theme work with scripts off", async t => {
  for (const scripts of [true, false]) {
    const page = await pageFor(t, { scripts });
    const link = card(page, "Sample alpha review");
    const href = await link.getAttribute("href");
    assert.match(href, /^#task-/);
    const detail = page.locator(href);
    assert.equal(await detail.isVisible(), false);
    await link.click();
    assert.equal(await detail.isVisible(), true);
    assert.equal(await page.locator(".boardview").isVisible(), false);
    assert.equal(await detail.getByRole("heading", { name: /^Agent runs \d+$/ }).isVisible(), true);
    assert.equal(await detail.getByText("No runs recorded.", { exact: true }).isVisible(), true);
    await detail.getByRole("link", { name: "← Board" }).click();
    assert.equal(await page.locator(".boardview").isVisible(), true);
  }
  const plain = await pageFor(t, { scripts: false });
  assert.deepEqual(await visibleCards(plain), ["T1 · Sample alpha queued", "T2 · Sample alpha review", "T3 · Sample beta held", "T4 · Sample beta work"]);
  const many = await browser.newContext({ javaScriptEnabled: false, colorScheme: "dark" });
  t.after(() => many.close());
  const folded = await many.newPage();
  await folded.setContent(renderBoardHtml(buildBoardModel([{ id: "sample", label: "Sample source", diagnostics: [], projects: [{ key: "sample/many-abcdef", name: "many-abcdef", diagnostics: [], tables: { tasks: Array.from({ length: 9 }, (_, i) => ({ id: `T${i + 1}`, title: `Sample queued ${i + 1}`, state: "framed", size: "small", risk: "", route: "build", branch: "", pr: "", round: "0", keys: "" })) } }] }], { now: NOW })));
  assert.equal(await folded.locator("a.card:visible").count(), 6);
  await folded.getByText("Show 3 more tasks").click();
  assert.equal(await folded.locator("a.card:visible").count(), 9);
  await plain.locator("label[for=flip]").click();
  assert.equal(await plain.locator("body").evaluate(body => getComputedStyle(body).getPropertyValue("--bg").trim()), themeToken("light", "--bg"));
});

const contrast = (page, list) => page.evaluate(measureContrast, list);

test("T218 F-T218-8 and F-T218-10: faint text and skipped loop steps meet 4.5 contrast on the page, column and card in both themes", async t => {
  const data = model({ current: true, rich: true }), task = data.tasks.find(item => item.id === "T2");
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: "dark", reducedMotion: "reduce" });
  t.after(() => context.close());
  await context.route("**/*", route => route.abort());
  const results = [];
  for (const [view, html, list] of [
    ["board", renderBoardHtml(data, { snapshot: false }), [["Next line on a card", ".card .nextline"], ["step not started", ".card .s-wait"], ["step separator", ".card .sep"], ["fold in a column", ".rest summary"], ["provider on a pill", ".card .agent:not(.alt) .prov"], ["alternate pill", ".card .agent.alt"], ["provider on an alternate pill", ".card .agent.alt .prov"], ["legend pill", ".legend .agent:not(.alt) .prov"], ["legend alternate pill", ".legend .agent.alt .prov"]]],
    ["task", renderBoardHtml(data, { snapshot: false, taskKey: task.key }), [["faint on the page", ".ptop .faint"], ["faint in a section", ".log .faint"], ["step detail", ".vlist .faint"], ["review role", ".parts .part"], ["earlier head", ".head .faint"], ["head", ".head"]]],
  ]) {
    const page = await context.newPage();
    await page.setContent(html);
    for (const theme of ["dark", "light"]) {
      if (theme === "light") await page.locator("label[for=flip]").click();
      for (const item of (await contrast(page, list)).flat()) {
        results.push(`${view} ${theme} ${item.kind}`);
        assert.ok(item.ratio >= 4.5, `${view} ${theme} ${item.kind} "${item.text}": ${item.ratio.toFixed(2)}`);
      }
    }
  }
  assert.ok(results.includes("task light review role") && results.includes("board dark step not started") && results.includes("board light fold in a column"));
  assert.ok(["board light provider on a pill", "board light provider on an alternate pill", "board dark legend alternate pill", "task light earlier head", "task dark earlier head"].every(kind => results.includes(kind)));
});

test("T349: every text on the board, a task page, the programs list, a program page and the Agents page meets AA contrast, dark and light, at 375 and 1280 px", async t => {
  const { pages } = contrastPages(), low = [], seen = new Set();
  for (const width of [375, 1280]) {
    // A dark system: the measure does not depend on the default theme, which other tests check.
    const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: "dark", reducedMotion: "reduce" });
    t.after(() => context.close());
    await context.route("**/*", route => route.abort());
    for (const [name, html] of Object.entries(pages)) {
      const page = await context.newPage();
      await page.setContent(html);
      for (const theme of ["dark", "light"]) {
        if (theme === "light") await page.locator("label[for=flip]").click();
        assert.equal((await shownTheme(page))[0], theme);
        for (const item of await page.evaluate(measureContrast)) {
          seen.add(`${name} ${item.kind}`);
          if (item.ratio < item.need) low.push(`${name} ${width} px ${theme}: ${item.kind} "${item.text}" ${item.ratio} < ${item.need}`);
        }
      }
    }
  }
  assert.deepEqual(low, []);
  // The texts of the two contrast bugs that T349 fixed are among the measured ones.
  assert.ok(["agents span.ptag.ptag-claude", "agents span.ptag.ptag-codex", "agents span.faint", "board span.n", "program div.band"].every(kind => seen.has(kind)), [...seen].filter(kind => kind.startsWith("agents")).join(", "));
});

test("T349: the contrast helper takes the worst stop of a gradient, and refuses an image", async t => {
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await context.newPage();
  await page.setContent('<p id="even">Sample</p><p id="half">Sample</p><p id="image">Sample</p>');
  await page.addStyleTag({ content: "p{color:#000}#even{background:linear-gradient(#fff,#eee)}#half{background:linear-gradient(90deg,#fff,#555)}#image{background:url(data:image/gif;base64,R0lGODlhAQABAAAAACw=)}" });
  const [[even], [half]] = await page.evaluate(measureContrast, [["even", "#even"], ["half", "#half"]]);
  assert.ok(even.ratio >= 17, `black on a light gradient: ${even.ratio}`);
  assert.ok(half.ratio < 4.5, `black on a gradient that ends dark grey fails: ${half.ratio}`);
  await assert.rejects(page.evaluate(measureContrast, [["image", "#image"]]), /An image needs a separate contrast check/);
});

test("T218 F-T218-9, F-T218-7 and F-T218-13: chips only with scripts, the stand-in legend on both views, and a 24 px way back", async t => {
  const data = model({ current: true, rich: true }), task = data.tasks.find(item => item.id === "T2");
  for (const scripts of [false, true]) {
    const context = await browser.newContext({ javaScriptEnabled: scripts, viewport: { width: 1280, height: 900 }, colorScheme: "dark" });
    t.after(() => context.close());
    await context.route("**/*", route => route.abort());
    const page = await context.newPage();
    await page.setContent(renderBoardHtml(data, { snapshot: false }));
    assert.equal(await needsButton(page).isVisible(), scripts, `Needs-you chip, scripts ${scripts ? "on" : "off"}`);
    assert.equal(await page.locator("#pick-trig").isVisible(), scripts, "the picker needs the script");
    assert.equal(await page.locator("label[for=flip]").isVisible(), true, "the theme switch needs no script");
    const sentence = "a stand-in value: the logbook does not record the real one.";
    assert.equal(await page.locator(".legend").getByText(sentence, { exact: false }).isVisible(), true);
    // F-T218-16: one legend pill for each pill colour, named by its source.
    assert.deepEqual(await page.locator(".legend .agent").evaluateAll(pills => pills.map(pill => `${pill.className}: ${pill.parentElement.textContent}`)), ["agent: Sample source · role an agent at work now", "agent alt: Codex · role the same for Codex"]);
    assert.equal(await page.locator(".card .agent.alt").textContent(), "Codex (Stand-in: the logbook's source. The run does not record its provider.) · implementer", "the reason is in the text for screen readers (R1075-7)");
    await page.setContent(renderBoardHtml(data, { snapshot: false, taskKey: task.key }));
    assert.equal(await page.locator(".legend").getByText(sentence, { exact: false }).isVisible(), true);
    assert.equal(await page.locator(".legend .step").count(), 0, "the step line needs no legend: each mark has its word (T305)");
    const box = await page.getByRole("link", { name: "← Board" }).boundingBox();
    assert.ok(box.width >= 24 && box.height >= 24, JSON.stringify(box));
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => document.activeElement.textContent), "← Board", "the way back is the first stop");
    assert.equal(await page.locator("main h1").count(), 1);
    assert.equal(await page.locator("h1").textContent(), "Sample alpha review");
  }
});

test("T205: sample desktop and phone text meets 4.5 contrast in both themes", async t => {
  const artifactDir = process.env.BOARD_BROWSER_ARTIFACT_DIR;
  if (artifactDir) mkdirSync(artifactDir, { recursive: true });
  const evidence = [];
  for (const phone of [false, true]) {
    const page = await pageFor(t, { phone, snapshot: false, current: true });
    if (!phone) await page.setViewportSize({ width: 1600, height: 1000 });
    await page.evaluate(() => {
      const label = document.createElement("aside");
      label.textContent = "SAMPLE DATA · Browser QA fixture · No live task data";
      label.setAttribute("style", "padding:10px 20px;background:#ffec99;color:#171717;font:700 14px system-ui");
      document.body.prepend(label);
    });
    for (const theme of ["dark", "light"]) {
      if (theme === "light") await page.locator("label[for=flip]").click();
      const measurements = (await contrast(page, [
        ["normal", ".card .title"],
        ["muted", ".card .top"],
        ["link", ".seg [aria-pressed=true]"],
        ["needs", ".nowline.need"],
        ["current", ".s-run"],
      ])).map(list => list[0]);
      assert.deepEqual(measurements.map(item => item.kind), ["normal", "muted", "link", "needs", "current"]);
      for (const item of measurements) assert.ok(item.ratio >= 4.5, `${phone ? "phone" : "desktop"} ${theme} ${item.kind}: ${item.ratio}`);
      const viewport = phone ? "phone" : "desktop";
      evidence.push({ viewport, theme, measurements });
      if (artifactDir) await page.screenshot({ path: join(artifactDir, `sample-${viewport}-${theme}.png`), fullPage: true });
    }
  }
  if (artifactDir) writeFileSync(join(artifactDir, "contrast.json"), JSON.stringify({ sampleData: true, node: process.version, playwright: require("playwright/package.json").version, browser: browser.version(), evidence }, null, 2) + "\n");
});

test("T205: real browser authenticates pages and live streams, watches files, and reconnects", async t => {
  const dir = mkdtempSync(join(tmpdir(), "sage-board-browser-server-"));
  const root = join(dir, "sample-source"), project = join(root, "project-abcdef");
  mkdirSync(project, { recursive: true });
  const headers = {
    tasks: "id title size risk route state branch pr round keys",
    runs: "id task role round candidate branch status tokens report started ended",
    findings: "task key round source severity summary triage reason status",
    ledger: "task pr sha kind cycle run at",
    gates: "id task question options recommendation default answer at",
    decisions: "at task decision why",
  };
  for (const [name, header] of Object.entries(headers)) writeFileSync(join(project, `${name}.tsv`), `${header.replaceAll(" ", "\t")}\n`);
  const taskFile = join(project, "tasks.tsv");
  // The held task has an open gate, so it needs you (R1077).
  writeFileSync(join(project, "gates.tsv"), `${headers.gates.replaceAll(" ", "\t")}\nG1\tT2\tSample: go on?\t\t\t\t\t\n`);
  const table = title => `${headers.tasks.replaceAll(" ", "\t")}\nT1\t${title}\tsmall\t\tbuild\tbuilding\tcodex/sample\t\t0\t\nT2\tSample held task\tsmall\t\tbuild\theld\tcodex/sample-held\t\t0\t\n`;
  const replaceTasks = title => {
    const temporary = join(project, "tasks.next");
    writeFileSync(temporary, table(title));
    renameSync(temporary, taskFile);
  };
  replaceTasks("Sample served task");
  const reservation = createPortServer();
  await new Promise((accept, reject) => { reservation.once("error", reject); reservation.listen(0, "127.0.0.1", accept); });
  const port = reservation.address().port;
  await new Promise((accept, reject) => reservation.close(error => error ? reject(error) : accept()));
  const origin = `http://127.0.0.1:${port}`;
  const options = { sources: [{ id: "sample", path: root, label: "Sample source" }], port };
  let server = createBoardServer(options), context;
  t.after(async () => {
    try { await context?.close(); } finally {
      try { await server.close(); } finally { rmSync(dir, { recursive: true, force: true }); }
    }
  });
  await server.start();
  // On the Mac (a loopback Host) the board needs no sign-in, so the browser sends no credentials.
  context = await browser.newContext({ colorScheme: "dark" });
  // Only this isolated server may receive requests.
  await context.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const page = await context.newPage(), responses = [];
  page.on("response", response => {
    if (response.url().startsWith(origin)) responses.push({ path: new URL(response.url()).pathname + new URL(response.url()).search, status: response.status() });
  });
  await page.addInitScript(() => {
    window.samplePolicyViolations = [];
    document.addEventListener("securitypolicyviolation", event => window.samplePolicyViolations.push(event.violatedDirective));
  });
  const initial = await page.goto(origin);
  assert.equal(initial.status(), 200);
  assert.match(initial.headers()["content-security-policy"], /script-src 'sha256-/);
  assert.doesNotMatch(initial.headers()["content-security-policy"], /unsafe-inline/);
  await page.getByText("Live · updated", { exact: false }).waitFor();
  assert.deepEqual(await visibleCards(page), ["T1 · Sample served task", "T2 · Sample held task"]);
  assert.deepEqual(await shownTheme(page), ["dark", themeToken("dark", "--bg")]);
  assert.deepEqual(await page.evaluate(() => window.samplePolicyViolations), []);
  assert.ok(responses.some(response => response.path === "/?events=1" && response.status === 200));
  assert.equal(readFileSync(taskFile, "utf8"), table("Sample served task"));

  await page.evaluate(() => { window.sampleDocumentMarker = "sample-board-document"; });
  replaceTasks("Sample watched replacement");
  await card(page, "Sample watched replacement").waitFor();
  assert.equal(await page.evaluate(() => window.sampleDocumentMarker), "sample-board-document");
  assert.deepEqual(await visibleCards(page), ["T1 · Sample watched replacement", "T2 · Sample held task"]);
  await needsButton(page).click();
  assert.deepEqual(await visibleCards(page), ["T2 · Sample held task"]);
  await needsButton(page).click();

  writeFileSync(taskFile, "Sample invalid table header\nSample incomplete write\n");
  await page.locator("#live-state").getByText("Update failed · board from", { exact: false }).waitFor();
  assert.deepEqual(await visibleCards(page), ["T1 · Sample watched replacement", "T2 · Sample held task"]);
  assert.doesNotMatch(await page.locator("#board-content").textContent(), /Sample incomplete write/);
  replaceTasks("Sample restored task");
  await card(page, "Sample restored task").waitFor();
  await page.getByText("Live · updated", { exact: false }).waitFor();

  const taskPath = `/task/${Buffer.from("sample/project-abcdef/T1").toString("base64url")}`;
  await Promise.all([page.waitForURL(origin + taskPath), card(page, "Sample restored task").click()]);
  await page.getByRole("heading", { name: "Sample restored task", exact: true }).waitFor();
  await page.getByText("Live · updated", { exact: false }).waitFor();
  assert.equal(await page.getByRole("heading", { name: /^Agent runs \d+$/ }).isVisible(), true);
  assert.ok(responses.some(response => response.path === taskPath && response.status === 200));
  assert.ok(responses.some(response => response.path === `/?events=1&task=${taskPath.slice(6)}` && response.status === 200));
  assert.deepEqual(await page.evaluate(() => window.samplePolicyViolations), []);
  await page.evaluate(() => { window.sampleDocumentMarker = "sample-task-document"; });
  replaceTasks("Sample task live change");
  await page.getByRole("heading", { name: "Sample task live change", exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.sampleDocumentMarker), "sample-task-document");

  await server.close();
  await page.locator("#live-state").getByText("Reconnecting · board from", { exact: false }).waitFor();
  assert.equal(await page.getByRole("heading", { name: "Sample task live change", exact: true }).isVisible(), true);
  replaceTasks("Sample reconnected task");
  server = createBoardServer(options);
  await server.start();
  await page.getByRole("heading", { name: "Sample reconnected task", exact: true }).waitFor();
  await page.getByText("Live · updated", { exact: false }).waitFor();
  assert.equal(page.url(), origin + taskPath);
  assert.equal(await page.evaluate(() => window.sampleDocumentMarker), "sample-task-document");
  assert.deepEqual(await page.evaluate(() => window.samplePolicyViolations), []);
  assert.equal(readFileSync(taskFile, "utf8"), table("Sample reconnected task"));
});
