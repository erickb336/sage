import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildBoardModel } from "../packages/sage-core/board-model.mjs";
import { renderBoardHtml } from "../packages/sage-core/board-render.mjs";
import { NOW, milestonesSource } from "./fixtures/board-milestones.mjs";
import { NOW as WALK_NOW, STAGES, walkthroughSource } from "./fixtures/board-walkthrough.mjs";
import { isMain } from "./is-main.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const SHOTS = { light: "docs/assets/board-light.png", dark: "docs/assets/board-dark.png", ...Object.fromEntries(Object.keys(STAGES).map((stage) => [stage, `docs/assets/learn-${stage}.png`])) };
export const SHOTS_RECORD = "docs/assets/board-shots.json";
export const sampleHash = () => createHash("sha256").update(JSON.stringify({ now: NOW, sources: [milestonesSource()], walkthrough: { now: WALK_NOW, sources: Object.keys(STAGES).map(walkthroughSource) } })).digest("hex");

const LABEL = `const b = document.createElement("div"); b.textContent = "SAMPLE DATA: every task and milestone is made up";
b.style.cssText = "width:fit-content;box-sizing:border-box;margin:8px 20px;padding:6px 10px;border-radius:8px;font:600 13px system-ui,sans-serif;background:#b3261e;color:#fff";
document.body.prepend(b);`;

const LAPTOP = { width: 1280, height: 800 };

async function main() {
  const { chromium } = createRequire(import.meta.url)("playwright");
  const landing = () => ({ ok: true, reason: "" });
  const board = renderBoardHtml(buildBoardModel([milestonesSource()], { now: NOW, landing }), { snapshot: false });
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
        if (theme === "light") await page.locator("label[for=flip]").click();
        await page.evaluate(LABEL);
        const height = whole ? await page.evaluate(() => Math.ceil(document.querySelector("#board-content .board").getBoundingClientRect().bottom)) : LAPTOP.height;
        await page.screenshot({ path: join(ROOT, SHOTS[shot]), fullPage: true, clip: { x: 0, y: 0, width: LAPTOP.width, height } });
      } finally { await context.close(); }
    }
  } finally { await browser.close(); }
  writeFileSync(join(ROOT, SHOTS_RECORD), `${JSON.stringify({ sample: sampleHash(), sources: ["scripts/fixtures/board-milestones.mjs", "scripts/fixtures/board-walkthrough.mjs"] }, null, 2)}\n`);
  console.log(`✓ ${Object.values(SHOTS).join(", ")} and ${SHOTS_RECORD}`);
}

if (isMain(import.meta.url)) await main();
