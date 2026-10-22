// Takes the README's board screenshots: the built board page with a fixed SAMPLE logbook
// (scripts/fixtures/board-programs.mjs, every row made up), in the light and the dark theme, as PNGs in docs/assets/.
// It also writes docs/assets/board-shots.json with the hash of the sample data, so that `npm run check` fails when the
// sample changes and the screenshots do not. It serves the page from memory to Playwright's bundled Chromium (or the
// headless shell at BOARD_BROWSER_PATH): no server, no port, and every other request fails. Playwright is not a
// dependency of sage: give it through NODE_PATH.
// Example: NODE_PATH="$PLAYWRIGHT_MODULES" PLAYWRIGHT_BROWSERS_PATH="$BROWSERS" node scripts/board-shots.mjs
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildBoardModel } from "../packages/sage-core/board-model.mjs";
import { renderBoardHtml } from "../packages/sage-core/board-render.mjs";
import { NOW, programsSource } from "./fixtures/board-programs.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const SHOTS = { light: "docs/assets/board-light.png", dark: "docs/assets/board-dark.png" };
export const SHOTS_RECORD = "docs/assets/board-shots.json";
/** The hash of the sample data that the screenshots show: the logbook and the clock of the model. */
export const sampleHash = () => createHash("sha256").update(JSON.stringify({ now: NOW, sources: [programsSource()] })).digest("hex");

/** A visible label on the page, so that a screenshot never passes for real data. */
const LABEL = `const b = document.createElement("div"); b.textContent = "SAMPLE DATA: every task and program is made up";
b.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:9999;padding:6px 12px;border-radius:8px;font:600 14px system-ui,sans-serif;background:#b3261e;color:#fff";
document.body.append(b);`;

async function main() {
  const { chromium } = createRequire(import.meta.url)("playwright");
  const html = renderBoardHtml(buildBoardModel([programsSource()], { now: NOW }), { snapshot: false });
  const browser = await chromium.launch({ headless: true, ...(process.env.BOARD_BROWSER_PATH ? { executablePath: process.env.BOARD_BROWSER_PATH } : {}) });
  try {
    for (const theme of ["light", "dark"]) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, colorScheme: "light", reducedMotion: "reduce" });
      try {
        await context.route("**/*", (route) => route.abort());
        await context.route("http://board.test/", (route) => route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html }));
        const page = await context.newPage();
        await page.goto("http://board.test/");
        // The page opens dark; a person flips the switch for light.
        if (theme === "light") await page.locator("label[for=flip]").click();
        await page.evaluate(LABEL);
        await page.screenshot({ path: join(ROOT, SHOTS[theme]) });
      } finally { await context.close(); }
    }
  } finally { await browser.close(); }
  writeFileSync(join(ROOT, SHOTS_RECORD), `${JSON.stringify({ sample: sampleHash(), source: "scripts/fixtures/board-programs.mjs" }, null, 2)}\n`);
  console.log(`✓ ${Object.values(SHOTS).join(", ")} and ${SHOTS_RECORD}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
