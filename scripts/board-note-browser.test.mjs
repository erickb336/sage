// Standalone browser check of R1509-2: a task page over the page limit (8 MB) shows the board with a note, and the note
// stays on screen with scripts on, also after the board's stream would send its first update. It starts the real board
// server on a free loopback port (never 4173 or 43123) over a SAMPLE logbook in a temporary folder. Like
// board-polish-browser.test.mjs, it needs Playwright through NODE_PATH and is not in the default test command. It runs
// Playwright's bundled Chromium (PLAYWRIGHT_BROWSERS_PATH), or the headless shell at BOARD_BROWSER_PATH; never an installed Chrome.
// Example: NODE_PATH="$PLAYWRIGHT_MODULES" PLAYWRIGHT_BROWSERS_PATH="$SCRATCH/browsers" node --test scripts/board-note-browser.test.mjs
import "./test-env.mjs";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createBoardServer } from "../packages/sage-board/server.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const HEADERS = {
  tasks: "id title size risk route state branch pr round keys",
  runs: "id task role round candidate branch status tokens report started ended",
  findings: "task key round source severity summary triage reason status",
  ledger: "task pr sha kind cycle run at",
  gates: "id task question options recommendation default answer at",
  decisions: "at task decision why",
};
const tsv = (name, ...rows) => [HEADERS[name].replaceAll(" ", "\t"), ...rows].join("\n") + "\n";
const NOTE = "The page that you opened is too large to show (over 8 MB), so the board shows this page instead.";

/** A free loopback port that is not one of the owner's own (4173, 43123). */
async function freePort() {
  for (;;) {
    const socket = createServer();
    await new Promise((accept, reject) => { socket.once("error", reject); socket.listen(0, "127.0.0.1", accept); });
    const { port } = socket.address();
    await new Promise((accept, reject) => socket.close(error => error ? reject(error) : accept()));
    if (![4173, 43123].includes(port)) return port;
  }
}

const dir = mkdtempSync(join(realpathSync(tmpdir()), "sage-board-note-")), project = join(dir, "source", "project-abcdef");
let browser, server, port;
before(async () => {
  mkdirSync(project, { recursive: true });
  for (const name of Object.keys(HEADERS)) writeFileSync(join(project, `${name}.tsv`), tsv(name));
  writeFileSync(join(project, "tasks.tsv"), tsv("tasks", "T1\tSample first task\tsmall\t\tbuild\tframed\tcodex/sample\t\t0\t"));
  // Each "<" of a finding's summary is 4 bytes of HTML: the task page passes 8 MB, the board does not (a card shows no summary).
  writeFileSync(join(project, "findings.tsv"), tsv("findings", `T1\tF-1\t1\tcode-review\tlow\t${"<".repeat(3.9 * 1024 * 1024)}\t\t\topen`));
  port = await freePort();
  server = createBoardServer({ sources: [{ id: "sample", path: join(dir, "source"), label: "Sample source" }], port });
  await server.start();
  browser = await chromium.launch({ headless: true, ...(process.env.BOARD_BROWSER_PATH ? { executablePath: process.env.BOARD_BROWSER_PATH } : {}) });
});
after(async () => { try { await browser?.close(); } finally { try { await server?.close(); } finally { rmSync(dir, { recursive: true, force: true }); } } });

test("R1509-2: with scripts on, the note of a too-large task page stays on screen after the first stream update", async t => {
  const context = await browser.newContext({ javaScriptEnabled: true });
  t.after(() => context.close());
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(String(error)));
  // Each stream that the page opens resolves window.sampleUpdate at its first update, so the check waits for it.
  await page.addInitScript(() => {
    const Real = window.EventSource;
    window.sampleStreams = 0;
    window.sampleUpdate = new Promise(done => { window.EventSource = class extends Real { constructor(...args) { super(...args); window.sampleStreams++; this.addEventListener("board", () => setTimeout(done, 100)); } }; });
  });
  const key = Buffer.from("sample/project-abcdef/T1").toString("base64url");
  const response = await page.goto(`http://127.0.0.1:${port}/task/${key}`);
  assert.equal(response.status(), 200);
  assert.ok((await response.text()).includes(NOTE), "the server's page has the note");
  if (await page.evaluate(() => window.sampleStreams)) await page.evaluate(() => window.sampleUpdate);
  const shown = await page.locator("#board-content").innerText();
  assert.ok(shown.includes(NOTE), `the note is on screen: ${shown.slice(0, 400)}`);
  assert.ok(shown.includes("Sample first task"), "the board is under the note");
  assert.deepEqual(errors, [], "no script error");
});
