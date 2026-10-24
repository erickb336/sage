// Takes the board screenshots of the README and the worked example: the built board page with fixed SAMPLE logbooks
// (scripts/fixtures/board-programs.mjs and board-walkthrough.mjs, every row made up), as PNGs in docs/assets/: the
// README's board in the light and the dark theme, and one light shot for each moment of the worked example. Every shot is
// at phone width and 2x, so that its text reads on a phone: the README's shot shows the top of the board, from the header
// to the first card, and a shot of the worked example shows only the column with the task.
// It also writes docs/assets/board-shots.json with the hash of the sample data, so that `npm run check` fails when the
// sample changes and the screenshots do not. It serves the page from memory to Playwright's bundled Chromium (or the
// headless shell at BOARD_BROWSER_PATH): no server, no port, and every other request fails. Playwright is not a
// dependency of sage: give it through NODE_PATH.
// Example: NODE_PATH="$PLAYWRIGHT_MODULES" PLAYWRIGHT_BROWSERS_PATH="$BROWSERS" node scripts/board-shots.mjs
import { createHash } from "node:crypto";
import { realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildBoardModel } from "../packages/sage-core/board-model.mjs";
import { renderBoardHtml } from "../packages/sage-core/board-render.mjs";
import { NOW, programsSource } from "./fixtures/board-programs.mjs";
import { NOW as WALK_NOW, STAGES, walkthroughSource } from "./fixtures/board-walkthrough.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const SHOTS = { light: "docs/assets/board-light.png", dark: "docs/assets/board-dark.png", ...Object.fromEntries(Object.keys(STAGES).map((stage) => [stage, `docs/assets/learn-${stage}.png`])) };
export const SHOTS_RECORD = "docs/assets/board-shots.json";
/** The hash of the sample data that the screenshots show: the logbook and the clock of the model. */
export const sampleHash = () => createHash("sha256").update(JSON.stringify({ now: NOW, sources: [programsSource()], walkthrough: { now: WALK_NOW, sources: Object.keys(STAGES).map(walkthroughSource) } })).digest("hex");

/** A visible label on the page, so that a screenshot never passes for real data. It takes its own line above the board
 * (README shots) or above the task's column (worked example shots), so it covers no board text. Its order -2 keeps it
 * above a column that needs you, which the board moves first with order -1. */
const LABEL = `const b = document.createElement("div"); b.textContent = "SAMPLE DATA: every task and program is made up";
b.style.cssText = "order:-2;width:fit-content;max-width:100%;box-sizing:border-box;margin:8px 16px;padding:6px 10px;border-radius:8px;font:600 13px system-ui,sans-serif;background:#b3261e;color:#fff";
const col = [...document.querySelectorAll("#board-content section.col")].find((c) => c.getBoundingClientRect().height);
if (document.body.dataset.shot === "column" && col) { b.style.margin = "8px 0"; col.before(b); } else document.body.prepend(b);`;

/** Every shot is at phone width: the README's shots show the top of the board, a worked example shot the task's column. */
const PHONE = { width: 400, height: 1200 };

async function main() {
  const { chromium } = createRequire(import.meta.url)("playwright");
  const board = renderBoardHtml(buildBoardModel([programsSource()], { now: NOW }), { snapshot: false });
  const shots = [["light", "light", board, false], ["dark", "dark", board, false],
    ...Object.keys(STAGES).map((stage) => [stage, "light", renderBoardHtml(buildBoardModel([walkthroughSource(stage)], { now: WALK_NOW }), { snapshot: false }), true])];
  const browser = await chromium.launch({ headless: true, ...(process.env.BOARD_BROWSER_PATH ? { executablePath: process.env.BOARD_BROWSER_PATH } : {}) });
  try {
    for (const [shot, theme, html, column] of shots) {
      const context = await browser.newContext({ viewport: PHONE, deviceScaleFactor: 2, colorScheme: "light", reducedMotion: "reduce" });
      try {
        await context.route("**/*", (route) => route.abort());
        await context.route("http://board.test/", (route) => route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html }));
        const page = await context.newPage();
        await page.goto("http://board.test/");
        // The page opens dark; a person flips the switch for light.
        if (theme === "light") await page.locator("label[for=flip]").click();
        if (column) await page.evaluate(() => { document.body.dataset.shot = "column"; });
        await page.evaluate(LABEL);
        // A column shot: from the label to the end of the task's column. A README shot: from the label at the top to the end
        // of the first card. Each keeps the page's own margin at each side.
        const clip = await page.evaluate((column) => {
          const col = [...document.querySelectorAll("#board-content section.col")].find((c) => c.getBoundingClientRect().height);
          const top = column ? col.previousElementSibling.getBoundingClientRect().top - 8 : 0;
          const bottom = column ? col.getBoundingClientRect().bottom + 16 : col.querySelector(".card").getBoundingClientRect().bottom + 6;
          return { x: 0, y: top, width: document.documentElement.clientWidth, height: bottom - top };
        }, column);
        await page.screenshot({ path: join(ROOT, SHOTS[shot]), clip });
      } finally { await context.close(); }
    }
  } finally { await browser.close(); }
  writeFileSync(join(ROOT, SHOTS_RECORD), `${JSON.stringify({ sample: sampleHash(), sources: ["scripts/fixtures/board-programs.mjs", "scripts/fixtures/board-walkthrough.mjs"] }, null, 2)}\n`);
  console.log(`✓ ${Object.values(SHOTS).join(", ")} and ${SHOTS_RECORD}`);
}

// Real paths, so that a run through a link (/tmp on macOS) takes the shots too.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) await main();
