import "./test-env.mjs";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildBoardModel } from "../packages/sage-core/board-model.mjs";
import { boardOverview, taskPanel } from "../packages/sage-core/board-overview.mjs";
import { readBoardSources } from "../packages/sage-core/board-reader.mjs";
import { createBoardServer, loadBoardApp } from "../packages/sage-board/server.mjs";
import { appTables, writeTasksLogbook } from "./fixtures/board-app.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const NOW = "2026-11-13T12:00:00.000Z";
const KEY = id => `shared/sample-app-abc123/${id}`;
const b64 = key => Buffer.from(key).toString("base64url");

function world(t, options) {
  const dir = mkdtempSync(join(tmpdir(), "sage-board-tasks-")), before = process.env.SAGE_WORKTREES;
  process.env.SAGE_WORKTREES = join(dir, "worktrees");
  t.after(() => { if (before === undefined) delete process.env.SAGE_WORKTREES; else process.env.SAGE_WORKTREES = before; rmSync(dir, { recursive: true, force: true }); });
  const logbook = writeTasksLogbook(join(dir, "logbooks"), join(dir, "worktrees"), NOW, options);
  return { dir, logbook, sources: [{ id: "shared", path: join(dir, "logbooks"), label: "Shared" }] };
}
const modelOf = sources => buildBoardModel(readBoardSources(sources, { now: Date.parse(NOW) }), { now: NOW });

async function freePort() {
  const socket = createServer();
  await new Promise((accept, reject) => { socket.once("error", reject); socket.listen(0, "127.0.0.1", accept); });
  const { port } = socket.address();
  await new Promise(accept => socket.close(accept));
  return port;
}
async function serve(t, sources) {
  const port = await freePort(), server = createBoardServer({ sources, port, app: loadBoardApp(join(ROOT, "plugins/sage/board/app")), settleReads: [] });
  t.after(() => server.close());
  await server.start();
  return `http://127.0.0.1:${port}`;
}

test("T1061: the stream lists every task with its state word, priority, kind, chief tag and may-conflict flag; ended tasks are marked", t => {
  const { tasks } = boardOverview(modelOf(world(t).sources));
  const row = id => tasks.find(task => task.id === id);
  assert.deepEqual(tasks.map(task => task.id).sort(), ["T1", "T10", "T11", "T2", "T20", "T21", "T3", "T30", "T4", "T40"], "every task, ended ones too");
  assert.deepEqual([row("T3").word, row("T3").priority, row("T3").kind, row("T3").chief, row("T3").pr, row("T3").ended], ["in progress", "P2", "providers", { id: "C2", provider: "Codex", stopped: false, waits: false }, "12", false]);
  assert.deepEqual(row("T3").conflicts, [{ key: KEY("T40"), id: "T40", chief: "Claude · C1" }], "T3 (C2) and T40 (C1) change src/shared.js");
  assert.deepEqual(row("T40").conflicts.map(other => other.id), ["T3"]);
  assert.deepEqual(row("T2").conflicts, [], "a task with no files record has no flag");
  assert.deepEqual([row("T1").word, row("T1").ended], ["done", true]);
  assert.deepEqual([row("T10").word, row("T10").needsYou], ["needs you", true]);
  assert.equal(row("T4").waits, "Waits for T2 (in progress).");
  assert.deepEqual(row("T3").step, { label: "Review 1 of 1", status: "run" });
  assert.equal(row("T3").milestone.title, "Milestone 1: Board redesign");
  assert.equal(row("T40").milestone, null);
  assert.equal(row("T3").log, undefined, "the panel's detail is not in the stream");
});

test("T1061: the panel gives the route's steps with the current step, the clean-cycle count, the last event, the log, the decisions and the artifacts", t => {
  const panel = taskPanel(modelOf(world(t).sources), KEY("T3"));
  assert.deepEqual(panel.steps.map(step => [step.label, step.status]), [["Plan", "done"], ["Build", "done"], ["Review 1 of 1", "run"], ["Merge", "wait"]]);
  assert.deepEqual(panel.steps[2].parts, [{ name: "checks", status: "done" }, { name: "code review", status: "done" }, { name: "QA", status: "run" }]);
  assert.deepEqual(panel.cycles, { required: 1, clean: 0, reviews: true });
  assert.deepEqual(panel.lastEvent, { at: "2026-11-13T11:30:00.000Z", who: "R6", text: "qa started" });
  assert.deepEqual(panel.log.map(event => event.text), ["qa started", "review-clean · cycle 1 on bbbbbbb", "code-reviewer ended: done", "checks-pass · cycle 1 on bbbbbbb", "code-reviewer started", "implementer ended: done", "implementer started", "state reviewing · the PR is open"], "newest first");
  assert.deepEqual(panel.decisions, [{ id: "G6", question: "Keep one limit for both providers?", answer: "A: yes", pending: null, recommendation: "A: yes", at: "2026-11-13T04:00:00.000Z" }]);
  assert.deepEqual(panel.artifacts.map(item => [item.label, item.run, item.url]), [["Limits design note", "R7", "https://github.com/sample-owner/sample-app/pull/12"]]);
  assert.equal(panel.prUrl, "https://github.com/sample-owner/sample-app/pull/12", "from the PR observation's repository");
  assert.deepEqual(panel.conflicts, [{ key: KEY("T40"), id: "T40", chief: "Claude · C1", paths: ["src/shared.js"] }]);
  assert.equal(taskPanel(modelOf(world(t).sources), KEY("T999")), null);
});

test("T1061: unknown shows as unknown: no clean-cycle count without the PR's last commit, and no last event when nothing is recorded", () => {
  const source = { id: "claude", label: "claude", provider: null, config: {}, diagnostics: [], hooks: { present: false, slots: [], helpers: [], problem: null },
    projects: [{ key: "claude/sample-app-abc123", source: "claude", name: "sample-app-abc123", checkout: "/sample/app", diagnostics: [], warnings: [], tables: appTables(NOW), observations: { version: 1, records: [] } }] };
  const model = buildBoardModel([source], { now: NOW });
  const review = taskPanel(model, "claude/sample-app-abc123/T3");
  assert.deepEqual(review.cycles, { required: 1, clean: null, reviews: true }, "the board does not know PR 12's head");
  assert.equal(taskPanel(model, "claude/sample-app-abc123/T4").lastEvent, null);
  assert.equal(boardOverview(model).tasks.find(task => task.id === "T4").chief.id, null, "a logbook with no chiefs names only the provider");
});

test("T1061 (F-T1061-13): a task with no route has no steps in its row or its panel, and says why", () => {
  const tables = appTables(NOW);
  tables.tasks.find(task => task.id === "T2").route = "";
  const source = { id: "claude", label: "claude", provider: null, config: {}, diagnostics: [], hooks: { present: false, slots: [], helpers: [], problem: null },
    projects: [{ key: "claude/sample-app-abc123", source: "claude", name: "sample-app-abc123", checkout: "/sample/app", diagnostics: [], warnings: [], tables, observations: { version: 1, records: [] } }] };
  const model = buildBoardModel([source], { now: NOW }), panel = taskPanel(model, "claude/sample-app-abc123/T2");
  assert.deepEqual([panel.route, panel.steps, panel.now, panel.next], [[], [], "The logbook records no route for this task, so the board shows no steps.", null]);
  assert.equal(boardOverview(model).tasks.find(task => task.id === "T2").step, null);
  assert.equal(boardOverview(model).tasks.find(task => task.id === "T3").step.label, "Review 1 of 1", "a task with a route keeps its step");
});

test("T1061: /app/task/<key> sends one task's panel with its pages, its own kept reports and briefs, and nothing of another task", async t => {
  const w = world(t), base = await serve(t, w.sources);
  const response = await fetch(`${base}/app/task/${b64(KEY("T3"))}`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  const panel = await response.json();
  assert.equal(panel.id, "T3");
  assert.deepEqual(panel.files.pages.map(page => page.name), ["limits-design.html", "notes.md"]);
  assert.deepEqual(panel.files.kept.map(item => [item.run, item.role, item.status, item.result]), [["R5", "code-reviewer", "done", "CLEAN. The limits change is correct."]], "R7's kept report names T2, so it is left out");
  assert.deepEqual(panel.files.briefs, [{ name: "sage_qa_t3_r6.json", run: "R6" }], "T30's brief is not T3's");
  const other = await (await fetch(`${base}/app/task/${b64(KEY("T40"))}`)).json();
  assert.deepEqual([other.files.pages, other.files.kept, other.files.briefs], [null, [], []], "T40 has no pages folder and no files");
});

test("T1061: the task route refuses a bad key, an unknown task, another site and a write, and follows no link in the logbook", async t => {
  const w = world(t), outside = join(w.dir, "outside.json");
  writeFileSync(outside, JSON.stringify({ task: "T3", run: "R6", role: "qa", sha: "", text: "STATUS done\nRESULT linked in from outside", at: NOW }));
  symlinkSync(outside, join(w.logbook, "kept", "R6.json"));
  const base = await serve(t, w.sources);
  const panel = await (await fetch(`${base}/app/task/${b64(KEY("T3"))}`)).json();
  assert.deepEqual(panel.files.kept.map(item => item.run), ["R5"], "a link is not read");
  for (const path of [`/app/task/${b64(KEY("T999"))}`, "/app/task/not*base64", `/app/task/${b64(KEY("T3"))}=`, "/app/task/"]) assert.equal((await fetch(`${base}${path}`)).status, 404, path);
  assert.equal((await fetch(`${base}/app/task/${b64(KEY("T3"))}`, { method: "POST" })).status, 405);
  const status = headers => new Promise((accept, reject) => {
    const req = request(`${base}/app/task/${b64(KEY("T3"))}`, { headers: { Host: new URL(base).host, ...headers }, agent: false }, response => { response.resume(); accept(response.statusCode); });
    req.on("error", reject); req.end();
  });
  assert.equal(await status({}), 200);
  assert.equal(await status({ Origin: "http://evil.test" }), 403);
  assert.equal(await status({ "Sec-Fetch-Site": "cross-site" }), 403);
  assert.equal(await status({ "X-Forwarded-For": "10.0.0.1" }), 403);
});

test("T1061 (F-T1061-4, F-T1061-5): the kept-report reader reads no run id that leaves kept/, and no kept/ that is a link", async t => {
  const w = world(t), outside = join(w.dir, "outside");
  mkdirSync(outside);
  const report = run => JSON.stringify({ task: "T3", run, role: "qa", sha: "", text: "STATUS done\nRESULT read from outside the logbook", at: NOW });
  writeFileSync(join(outside, "R9.json"), report("../../../outside/R9"));
  const runs = join(w.logbook, "runs.tsv"), columns = readFileSync(runs, "utf8").split("\n")[0].split("\t");
  const values = { id: "../../../outside/R9", task: "T3", role: "qa", round: "0", status: "done", chief: "C2" };
  appendFileSync(runs, `${columns.map(column => values[column] ?? "").join("\t")}\n`);
  const base = await serve(t, w.sources), kept = async () => (await (await fetch(`${base}/app/task/${b64(KEY("T3"))}`)).json()).files.kept.map(item => item.run);
  assert.deepEqual(await kept(), ["R5"], "a run id with a path in it is not read");

  writeFileSync(join(outside, "R5.json"), report("R5"));
  renameSync(join(w.logbook, "kept"), join(w.dir, "kept-real"));
  symlinkSync(outside, join(w.logbook, "kept"));
  assert.deepEqual(await kept(), [], "a kept/ that is a link is not followed");
});

test("T1061 (F-T1061-29): a throw while the task route builds its answer is a 503 with the board's headers, and the board answers the next request", async t => {
  const w = world(t), base = await serve(t, w.sources), url = `${base}/app/task/${b64(KEY("T3"))}`, stringify = JSON.stringify;
  JSON.stringify = (value, ...rest) => { if (value?.files) throw new Error("a fault while the panel is built"); return stringify(value, ...rest); };
  let broken;
  try { broken = await fetch(url); } finally { JSON.stringify = stringify; }
  assert.equal(broken.status, 503);
  assert.equal(broken.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.equal(broken.headers.get("x-content-type-options"), "nosniff");
  assert.equal(await broken.text(), "The board snapshot is unavailable.\n");
  const next = await fetch(url);
  assert.equal(next.status, 200);
  assert.equal((await next.json()).id, "T3");
});
