// Takes the board screenshots of the README and the worked example: the built board page with fixed SAMPLE logbooks
// (scripts/fixtures/board-programs.mjs and board-walkthrough.mjs, every row made up), as PNGs in docs/assets/: the
// README's board in the light and the dark theme, and one light shot for each moment of the worked example. Every shot is
// at laptop width (1280 CSS pixels, above the board's 1180-pixel breakpoint, so the columns stand side by side) and 2x:
// the README's shot is the first screen of a 1280 by 800 laptop, and a shot of the worked example shows the whole board.
// It also writes docs/assets/board-shots.json with the hash of the sample data, so that `npm run check` fails when the
// sample changes and the screenshots do not. It serves the page from memory to Playwright's bundled Chromium (or the
// headless shell at BOARD_BROWSER_PATH): no server, no port, and every other request fails. Playwright is a pinned
// devDependency; install its browser once with `npx playwright install --only-shell chromium`.
// Example: node scripts/board-shots.mjs
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildBoardModel } from "../packages/sage-core/board-model.mjs";
import { renderBoardHtml } from "../packages/sage-core/board-render.mjs";
import { NOW, programsSource } from "./fixtures/board-programs.mjs";
import { NOW as WALK_NOW, STAGES, walkthroughSource } from "./fixtures/board-walkthrough.mjs";
import { isMain } from "./is-main.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const SHOTS = { light: "docs/assets/board-light.png", dark: "docs/assets/board-dark.png", ...Object.fromEntries(Object.keys(STAGES).map((stage) => [stage, `docs/assets/learn-${stage}.png`])) };
export const SHOTS_RECORD = "docs/assets/board-shots.json";
/** The hash of the sample data that the screenshots show: the logbook and the clock of the model. */
export const sampleHash = () => createHash("sha256").update(JSON.stringify({ now: NOW, sources: [programsSource()], walkthrough: { now: WALK_NOW, sources: Object.keys(STAGES).map(walkthroughSource) } })).digest("hex");

/** A visible label on the page, so that a screenshot never passes for real data. It takes its own line above the board,
 * so it covers no board text. */
const LABEL = `const b = document.createElement("div"); b.textContent = "SAMPLE DATA: every task and program is made up";
b.style.cssText = "width:fit-content;box-sizing:border-box;margin:8px 20px;padding:6px 10px;border-radius:8px;font:600 13px system-ui,sans-serif;background:#b3261e;color:#fff";
document.body.prepend(b);`;

/** A laptop screen: wider than the board's 1180-pixel breakpoint, so the board shows its desktop layout. */
const LAPTOP = { width: 1280, height: 800 };

async function main() {
  const { chromium } = createRequire(import.meta.url)("playwright");
  // The sample has no logbook on disk, so a sample merge check passes on every head (T280): the pages show a ready task.
  const landing = () => ({ ok: true, reason: "" });
  const board = renderBoardHtml(buildBoardModel([programsSource()], { now: NOW, landing }), { snapshot: false });
  const shots = [["light", "light", board, false], ["dark", "dark", board, false],
    ...Object.keys(STAGES).map((stage) => [stage, "light", renderBoardHtml(buildBoardModel([walkthroughSource(stage)], { now: WALK_NOW, landing }), { snapshot: false }), true])];
  const browser = await chromium.launch({ headless: true, ...(process.env.BOARD_BROWSER_PATH ? { executablePath: process.env.BOARD_BROWSER_PATH } : {}) });
  try {
    for (const [shot, theme, html, whole] of shots) {
      const context = await browser.newContext({ viewport: LAPTOP, deviceScaleFactor: 2, colorScheme: "light", reducedMotion: "reduce" });
      try {
        await context.route("**/*", (route) => route.abort());
        await context.route("http://board.test/", (route) => route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html }));
        const page = await context.newPage();
        await page.goto("http://board.test/");
        // The page opens dark; a person flips the switch for light.
        if (theme === "light") await page.locator("label[for=flip]").click();
        await page.evaluate(LABEL);
        // The full width, from the label at the top: a README shot is the first screen, as a laptop shows it; a worked example
        // shot goes to the end of the board.
        const height = whole ? await page.evaluate(() => Math.ceil(document.querySelector("#board-content .board").getBoundingClientRect().bottom)) : LAPTOP.height;
        await page.screenshot({ path: join(ROOT, SHOTS[shot]), fullPage: true, clip: { x: 0, y: 0, width: LAPTOP.width, height } });
      } finally { await context.close(); }
    }
  } finally { await browser.close(); }
  writeFileSync(join(ROOT, SHOTS_RECORD), `${JSON.stringify({ sample: sampleHash(), sources: ["scripts/fixtures/board-programs.mjs", "scripts/fixtures/board-walkthrough.mjs"] }, null, 2)}\n`);
  console.log(`✓ ${Object.values(SHOTS).join(", ")} and ${SHOTS_RECORD}`);
}

if (isMain(import.meta.url)) await main();
