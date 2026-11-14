import "./test-env.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { after, before, test } from "node:test";
import * as claude from "../plugins/sage/skills/sage/sage.mjs";
import { runBoardCli } from "../plugins/sage/board/cli.mjs";
import { createBoardServer, loadBoardApp } from "../plugins/sage/board/server.mjs";
import { writeInWorker } from "../plugins/sage/board/writes.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const APP = loadBoardApp(new URL("../plugins/sage/board/app/", import.meta.url).pathname);
const SHOTS = process.env.BOARD_SHOTS ?? null;
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
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

const MESSAGE = { kind: "question", title: "Can a viewer copy a shared list into their own lists?", blocks: [
  { t: "field", label: "Where this is", text: "The sample task sets what each person may do with a shared list." },
  { t: "field", label: "What you approve", text: "The rule for viewers." },
  { t: "field", label: "The one real choice in it", text: "Does a viewer get a copy action?" },
  { t: "table", head: ["Answer", "What happens next", "Cost"], rows: [["yes", "The chief adds the copy action.", "About 1 to 2 h of agent time."], ["no", "The chief builds view only.", "No extra cost now."]], pick: 0 },
  { t: "field", label: "If you do not answer", text: "The task waits." }, { t: "field", label: "Needed by", text: "Sample: 20:00 today." }, { t: "field", label: "After you answer", text: "The chief builds the task." }] };

async function openBoard(t, { write } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "sage-board-writes-browser-")));
  const saved = { ...process.env };
  const fakes = join(base, "fakes");
  mkdirSync(fakes);
  for (const name of ["gh", "ps", "kill"]) { writeFileSync(join(fakes, name), `#!/bin/sh\necho fake-${name} >&2\nexit 1\n`); chmodSync(join(fakes, name), 0o755); }
  const env = { PATH: `${fakes}:/usr/bin:/bin`, HOME: join(base, "home"), CLAUDE_CONFIG_DIR: join(base, "claude"), CODEX_HOME: join(base, "codex"), SAGE_SHARED_HOME: join(base, "shared"),
    SAGE_HOOKS_STATE: join(base, "hook-state"), SAGE_WORKTREES: join(base, "worktrees"), SAGE_TEST_PIDS: "{}", SAGE_TEST_MACHINE_ID: "test-machine", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  Object.assign(process.env, env);
  const project = join(base, "sample-app");
  mkdirSync(project);
  execFileSync("git", ["init", "-q", "-b", "main", project]);
  execFileSync("git", ["-C", project, "commit", "-q", "--allow-empty", "-m", "first"], { env: gitEnv });
  claude.sage(["link", "--separate", "--project", project], env);
  const dir = claude.storeDir(project, env), now = Date.now(), iso = ms => new Date(ms).toISOString();
  writeFileSync(join(dir, "chiefs.tsv"), `id\tprovider\tnative\tat\nC1\tclaude\tclaude-1\t${iso(now - 3 * 3600_000)}\nC2\tcodex\tcodex-1\t${iso(now - 2 * 3600_000)}\nC3\tclaude\tclaude-3\t${iso(now - 5 * 3600_000)}\nC4\tcodex\tcodex-4\t${iso(now - 4 * 3600_000)}\n`);
  mkdirSync(join(dir, "live"));
  for (const [id, ago, autopilot] of [["C1", 0, true], ["C2", 0, false], ["C3", 2 * 3600_000, false]]) writeFileSync(join(dir, "live", `${id}.json`), JSON.stringify({ provider: id === "C2" ? "codex" : "claude", checkout: project, sageMode: true, autopilot, at: iso(now - ago) }));
  const as = (chief, ...args) => claude.sage([...args, "--project", project, "--chief", chief], env);
  as("C1", "task", "add", "--title", "Sample shared list permissions", "--size", "small", "--priority", "P1");
  writeFileSync(join(base, "question.json"), JSON.stringify(MESSAGE));
  as("C1", "gate", "add", "T1", "--question", MESSAGE.title, "--options", "yes|no", "--recommend", "yes", "--message", join(base, "question.json"));
  as("C2", "task", "add", "--title", "Sample crash report screen", "--size", "small", "--priority", "P2");
  as("C2", "gate", "add", "T2", "--question", "Crash reports: send them on their own, or ask each time?", "--options", "ask each time|send them", "--recommend", "ask each time");
  as("C3", "task", "add", "--title", "Sample export a list as CSV", "--size", "small", "--priority", "P2");
  const config = join(base, "home", ".config", "sage-board", "board.json"), port = await freePort();
  await runBoardCli(["board", "--setup", "--config", config, "--port", String(port), "--sources", JSON.stringify([{ id: "shared", path: env.SAGE_SHARED_HOME }])], { output: () => {}, env });
  const stateDir = join(base, "home", ".config", "sage-board", "state");
  const server = createBoardServer({ sources: [{ id: "shared", label: "Shared", path: env.SAGE_SHARED_HOME }], port, app: APP, settleReads: [], stateDir, ...(write && { write }) });
  await server.start();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: "dark", timezoneId: "America/New_York" });
  t.after(async () => {
    await context.close(); await server.close();
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    rmSync(base, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${port}`, requests = [], problems = [];
  await context.route("**/*", route => { requests.push(`${route.request().method()} ${route.request().url()}`); return route.request().url().startsWith(`${origin}/`) ? route.continue() : route.abort(); });
  const page = await context.newPage();
  page.on("pageerror", error => problems.push(String(error)));
  page.on("console", message => { if (message.type() === "error" || /Content Security Policy|Refused to/.test(message.text())) problems.push(message.text()); });
  await page.goto(`${origin}/app/`);
  await page.locator("main h1").waitFor();
  const pairText = async () => {
    const lines = [];
    await runBoardCli(["board", "--pair", "--config", config], { output: line => lines.push(line), env, input: { isTTY: true } });
    return lines.join("\n");
  };
  const pairCode = async () => /Pairing code: (\S+)/.exec(await pairText())[1];
  const pair = async () => {
    await page.getByPlaceholder("ABCD-EFGH").fill(await pairCode());
    await page.getByRole("button", { name: "Pair", exact: true }).click();
    await page.getByRole("heading", { name: "Pair this browser to act from the board" }).waitFor({ state: "detached" });
  };
  const shot = async name => { if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true }); };
  const posts = path => requests.filter(line => line === `POST ${origin}/api/${path}`).length;
  const settled = () => page.evaluate(() => new Promise(done => requestAnimationFrame(() => setTimeout(done, 0))));
  return { page, context, origin, dir, project, env, stateDir, as, pairText, pair, shot, requests, posts, settled, problems, gate: id => claude.read(dir, "gates").find(row => row.id === id) };
}

test("T1059: the owner pairs once, then answers with full context, undoes, renames a chief, filters by chief, gives a task to another chief and sees what changed, each within two clicks of the Overview", async t => {
  const w = await openBoard(t), { page } = w;
  let clicks = 0;
  const click = async locator => { clicks++; await locator.click(); };

  assert.equal(await page.getByRole("button", { name: "Send answer" }).count(), 0);
  await w.shot("t1059-unpaired");
  await w.pair();
  await page.reload();
  await page.getByRole("heading", { name: /^Since you looked|^In the last 24 hours/ }).waitFor();

  clicks = 0;
  await click(page.getByRole("link", { name: MESSAGE.title }));
  await page.getByRole("heading", { name: MESSAGE.title, level: 1 }).waitFor();
  assert.equal(clicks, 1, "J1: one click opens the question with its full context");
  const view = await page.locator(".question").textContent();
  for (const part of ["Where this is", "The rule for viewers.", "If you do not answer", "The chief adds the copy action.", "About 1 to 2 h of agent time.", "C1's pick"]) assert.ok(view.includes(part), `the view shows ${part}`);
  const taskKey = `shared/${basename(w.dir)}/T1`;
  assert.equal(await page.getByRole("link", { name: "Read the full question" }).getAttribute("href"), `/read/${Buffer.from(taskKey).toString("base64url")}/question/G1`, "the link opens the reader's question page of the same gate");
  await w.shot("t1059-question");
  await page.getByRole("radio", { name: /^no/ }).check();
  await page.getByRole("button", { name: "Send answer" }).click();
  await page.getByText(/^You answered G1: no\. Recorded in the logbook\./).waitFor();
  assert.equal(JSON.parse(w.gate("G1").answered).answer, "no");
  await w.shot("t1059-answered");

  await page.goto(`${w.origin}/app/`);
  const waits = page.locator(`[data-answered$="/G1"]`);
  await waits.waitFor();
  clicks = 0;
  await click(waits.getByRole("button", { name: "Undo" }));
  await waits.waitFor({ state: "detached" });
  assert.equal(clicks, 1, "Undo: one click on the Overview");
  assert.equal(w.gate("G1").answered, "", "the undo cleared the board answer before any pickup");
  await page.getByRole("link", { name: MESSAGE.title }).waitFor();

  clicks = 0;
  await click(page.getByRole("button", { name: "More about C2" }));
  await page.getByLabel("Name").fill("Codex desk");
  await click(page.getByRole("button", { name: "Rename" }));
  await page.getByText("C2 is named \"Codex desk\" now.").waitFor();
  assert.equal(clicks, 2, "rename: the chip's menu, then Rename");
  await page.locator(`.chip[data-chief$="/C2"]`).filter({ hasText: "Codex desk" }).waitFor();
  await w.shot("t1059-chief-menu");

  clicks = 0;
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Rename" }).waitFor({ state: "detached" });
  await click(page.locator(`.chip[data-chief$="/C2"]`));
  assert.equal(clicks, 1, "filter: one click on the chief's chip");
  await page.getByRole("link", { name: MESSAGE.title }).waitFor({ state: "detached" });
  assert.deepEqual(await page.locator(".needs > li[data-need] .q").allTextContents(), ["Crash reports: send them on their own, or ask each time?"]);
  await page.getByRole("link", { name: /^Tasks/ }).click();
  await page.locator("a.row").first().waitFor();
  assert.deepEqual(await page.locator("a.row .id").allTextContents(), ["T2"], "the filter holds across pages");
  await page.getByRole("link", { name: /^Overview/ }).click();
  await page.getByRole("button", { name: "All chiefs" }).click();
  await page.getByRole("link", { name: MESSAGE.title }).waitFor();

  clicks = 0;
  const stopped = page.locator(`[data-stopped$="/C3"]`);
  await click(stopped.getByRole("button", { name: "Give to another chief" }));
  assert.equal(await stopped.getByRole("radio", { checked: true }).getAttribute("name"), await stopped.getByRole("radio").first().getAttribute("name"));
  assert.match(await stopped.locator(".pickable").first().textContent(), /^C1 · claude.*Recommended$/, "the live chief of C3's provider comes first");
  await click(stopped.getByRole("button", { name: "Open the takeover question" }));
  await stopped.getByText(/^G3 open · Hand T3 from C3 \(claude\) to C1 \(claude\)\?/).waitFor();
  assert.equal(clicks, 2, "give: Give to another chief, then Open the takeover question");
  await page.locator(".needs > li[data-need] .q").filter({ hasText: /^Hand T3 from/ }).waitFor();
  await w.shot("t1059-give");

  await page.goto(`${w.origin}/app/`);
  await page.getByRole("heading", { name: /^Since you looked/ }).waitFor();
  assert.match(await page.locator("#counts-h").textContent(), /^Since you looked · you last opened the board at /);
  assert.equal(await page.locator('[data-count="added"] .n').textContent(), "0", "no task was added since the last look");
  await w.shot("t1059-overview");

  assert.deepEqual(w.problems, [], "no page error and no CSP refusal");
  assert.deepEqual(w.requests.filter(line => !line.split(" ")[1].startsWith(`${w.origin}/`)), [], "no outside request");
});

test("T1059: a question answered first in the chief's chat shows who answered first, and a later board answer is refused with the first answer", async t => {
  const w = await openBoard(t), { page } = w;
  await w.pair();
  await page.getByRole("link", { name: "Crash reports: send them on their own, or ask each time?" }).click();
  await page.getByRole("radio", { name: /^ask each time/ }).check();
  let holdGateReads = true;
  const held = [];
  await page.route("**/app/gate/**", route => holdGateReads ? held.push(route) : route.fallback().catch(() => {}));
  claude.sage(["gate", "answer", "G2", "--option", "2", "--via", "chat", "--project", w.project], w.env);
  await page.getByRole("button", { name: "Send answer" }).click();
  await page.getByText(/^Not recorded\. G2 has the answer "send them" already, from the chat at \d\d:\d\d: the first answer wins/).waitFor();
  holdGateReads = false;
  for (const route of held) await route.fallback().catch(() => {});
  await page.getByText(/^Answered first in C2's chat at \d\d:\d\d: send them\./).waitFor();
  await w.shot("t1059-answered-elsewhere");
  assert.equal(w.gate("G2").answer, "send them");
});

test("F-T1059-17: board --pair names the card, the field and the button that the page shows, and says how to restart an older board", async t => {
  const w = await openBoard(t), { page } = w;
  const told = await w.pairText(), [, card, field, button] = /In the card "([^"]+)", type the code in the "([^"]+)" field, then choose (\w+)\./.exec(told) ?? [];
  assert.ok(card, `the output names the controls: ${told}`);
  assert.match(told, /If the page shows no pairing card and this browser is not paired yet, the board that runs is older than this one: run node .* board --stop --config .*, ask for the board again, and reload the page\./);
  await page.getByLabel(field).fill(/Pairing code: (\S+)/.exec(told)[1]);
  await page.getByRole("button", { name: button, exact: true }).click();
  await page.getByRole("heading", { name: card }).waitFor({ state: "detached" });
  assert.deepEqual(w.problems, []);
});

test("F-T1059-19: each chief's chip says its state in words: live, waits for you, stopped or liveness not known", async t => {
  const w = await openBoard(t), { page } = w;
  const chip = id => page.locator(`.chip[data-chief$="/${id}"] .state`);
  await chip("C4").waitFor();
  assert.deepEqual(await Promise.all(["C1", "C2", "C3", "C4"].map(id => chip(id).textContent())), ["live · autopilot on", "live · autopilot off", "stopped", "liveness not known"]);
  await w.shot("t1059-chips");
});

test("F-T1059-21: a chief's default name and its menu's Started row show the same local time", async t => {
  const w = await openBoard(t), { page } = w;
  const name = await page.locator('.chip[data-chief$="/C1"] .faint').first().textContent();
  await page.getByRole("button", { name: "More about C1" }).click();
  const started = await page.locator(".menu .facts dt", { hasText: "Started" }).locator("xpath=following-sibling::dd[1]").textContent();
  assert.ok(!name.includes("UTC") && name.endsWith(` · ${started}`), `"${name}" ends with "${started}"`);
  await w.shot("t1059-chief-started");
});

test("F-T1059-23: a double click on Send answer sends one answer and shows no refusal", async t => {
  const w = await openBoard(t), { page } = w;
  await w.pair();
  await page.getByRole("link", { name: MESSAGE.title }).click();
  await page.getByRole("radio", { name: /^no/ }).check();
  await page.getByRole("button", { name: "Send answer" }).dblclick();
  await page.getByText(/^You answered G1: no\. Recorded in the logbook\./).waitFor();
  assert.equal(w.posts("answer"), 1, "one answer was sent");
  await w.settled();
  assert.equal(await page.getByText(/^Not recorded/).count(), 0, "no refusal under the recorded answer");
  assert.equal(JSON.parse(w.gate("G1").answered).answer, "no");
  await w.shot("t1059-double-send");
});

test("F-T1059-11: the board records a visit once for each page load, not for each move inside the app", async t => {
  const w = await openBoard(t), { page } = w;
  await w.pair();
  await page.reload();
  await page.getByRole("heading", { name: /^Since you looked|^In the last 24 hours/ }).waitFor();
  await w.settled();
  const looks = w.posts("seen");
  assert.ok(looks >= 1, "the page load records a visit");
  await page.getByRole("link", { name: MESSAGE.title }).click();
  await page.getByRole("heading", { name: MESSAGE.title, level: 1 }).waitFor();
  await page.getByRole("link", { name: "Back to Needs you" }).click();
  await page.getByRole("link", { name: /^Tasks/ }).click();
  await page.locator("a.row").first().waitFor();
  await page.getByRole("link", { name: /^Overview/ }).click();
  await page.getByRole("heading", { name: /^Since you looked/ }).waitFor();
  await w.settled();
  assert.equal(w.posts("seen"), looks, "a move to a question or the Tasks page and back is not a new visit");
  await page.reload();
  await page.getByRole("heading", { name: /^Since you looked/ }).waitFor();
  await w.settled();
  assert.equal(w.posts("seen"), looks + 1, "a new page load is a new visit");
  await w.shot("t1059-since-you-looked");
});

test("F-T1059-47: after a give, the stopped chief's card shows the open takeover question in place of Give, also after a reload", async t => {
  const w = await openBoard(t), { page } = w;
  await w.pair();
  let stopped = page.locator(`[data-stopped$="/C3"]`);
  await stopped.getByRole("button", { name: "Give to another chief" }).click();
  await stopped.getByRole("button", { name: "Open the takeover question" }).click();
  await stopped.getByText(/^G3 open · Hand T3 from C3/).waitFor();
  await page.reload();
  stopped = page.locator(`[data-stopped$="/C3"]`);
  const open = stopped.getByRole("link", { name: "G3 open" });
  await open.waitFor();
  assert.equal(await stopped.getByRole("button", { name: "Give to another chief" }).count(), 0, "no second Give while G3 is open");
  await w.shot("t1059-give-open");
  await open.click();
  await page.getByRole("heading", { name: /^Hand T3 from Claude · C3 to Claude · C1\?/, level: 1 }).waitFor();
  assert.deepEqual(w.problems, []);
});

test("F-T1059-26: a tab opened before the pairing picks up a pairing made in another tab, and its write keeps that tab's token", async t => {
  const w = await openBoard(t), { page } = w;
  await page.getByRole("heading", { name: "Pair this browser to act from the board" }).waitFor();
  const other = await w.context.newPage();
  await other.goto(`${w.origin}/app/`);
  await other.getByPlaceholder("ABCD-EFGH").fill(/Pairing code: (\S+)/.exec(await w.pairText())[1]);
  await other.getByRole("button", { name: "Pair", exact: true }).click();
  await page.getByRole("heading", { name: "Pair this browser to act from the board" }).waitFor({ state: "detached" });
  const token = await other.evaluate(() => localStorage.getItem("board-token"));
  await page.getByRole("button", { name: "More about C2" }).click();
  await page.getByLabel("Name").fill("Codex desk");
  await page.getByRole("button", { name: "Rename" }).click();
  await page.getByText("C2 is named \"Codex desk\" now.").waitFor();
  assert.equal(await page.evaluate(() => localStorage.getItem("board-token")), token, "the pairing of the other tab stays");
});

test("F-T1059-46: a shadow cookie on /api does not refuse the paired browser, and a 401 does not erase the stored token", async t => {
  const w = await openBoard(t), { page } = w;
  await w.pair();
  const token = await page.evaluate(() => localStorage.getItem("board-token"));
  await w.context.addCookies([{ name: "sage_board", value: "B".repeat(43), domain: "127.0.0.1", path: "/api" }]);
  const rename = async name => {
    await page.getByRole("button", { name: "More about C2" }).click();
    await page.getByLabel("Name").fill(name);
    await page.getByRole("button", { name: "Rename" }).click();
  };
  await rename("Codex desk");
  await page.getByText("C2 is named \"Codex desk\" now.").waitFor();
  await page.keyboard.press("Escape");
  writeFileSync(join(w.stateDir, "paired.json"), JSON.stringify({ browsers: [] }));
  await rename("Codex desk two");
  await page.getByRole("heading", { name: "Pair this browser to act from the board" }).waitFor();
  assert.equal(await page.evaluate(() => localStorage.getItem("board-token")), token, "a 401 asks to pair again, and keeps the stored token");
});

test("F-T1059-36: the Read the full question link follows a theme switch on an open question", async t => {
  const w = await openBoard(t), { page } = w;
  await page.getByRole("link", { name: MESSAGE.title }).click();
  const link = page.getByRole("link", { name: "Read the full question" });
  await link.waitFor();
  assert.doesNotMatch(await link.getAttribute("href"), /theme=/);
  await page.getByRole("button", { name: "Switch to the light theme" }).click();
  assert.match(await link.getAttribute("href"), /\?theme=light$/);
  await page.getByRole("button", { name: "Switch to the dark theme" }).click();
  assert.doesNotMatch(await link.getAttribute("href"), /theme=/);
});

test("F-T1059-44: the rename field of a chief whose name is shown with its id starts with the stored name, so a plain Rename keeps it", async t => {
  const w = await openBoard(t), { page } = w;
  for (const id of ["C1", "C2"]) claude.sage(["chief", "name", id, "Desk", "--project", w.project], w.env);
  await w.pair();
  await page.locator(`.chip[data-chief$="/C2"]`).filter({ hasText: "Desk · C2" }).waitFor();
  await page.getByRole("button", { name: "More about C2" }).click();
  assert.equal(await page.getByLabel("Name").inputValue(), "Desk");
  await page.getByRole("button", { name: "Rename" }).click();
  await page.getByText("C2 is named \"Desk\" now.").waitFor();
  assert.equal(JSON.parse(readFileSync(join(w.dir, "chief-names.json"), "utf8")).C2, "Desk");
});

test("F-T1059-43: a write that the board stops waiting for says one thing: not confirmed yet, and it may still finish", async t => {
  const w = await openBoard(t, { write: job => writeInWorker(job, { timeout: 0 }) }), { page } = w;
  await w.pair();
  await page.getByRole("link", { name: MESSAGE.title }).click();
  await page.getByRole("radio", { name: /^no/ }).check();
  await page.getByRole("button", { name: "Send answer" }).click();
  const said = page.getByRole("alert").filter({ hasText: /^Not confirmed yet: the logbook was busy\. The write may still finish: reload the board to see it before you try again\.$/ });
  await said.waitFor();
  assert.equal(await page.getByText(/Not recorded/).count(), 0, "no \"Not recorded\" before a write that may still finish");
  await w.shot("t1059-write-timeout");
});
