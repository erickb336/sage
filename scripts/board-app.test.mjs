import "./test-env.mjs";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createBoardServer, loadBoardApp } from "../packages/sage-board/server.mjs";
import { APP_SOURCE, BUDGET, budgetProblems, licencesOf } from "./board-app.mjs";
import { writeAppLogbook } from "./fixtures/board-app.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PLUGINS = ["plugins/sage", "plugins/sage-codex"];

async function freePort() {
  const socket = createServer();
  await new Promise((accept, reject) => { socket.once("error", reject); socket.listen(0, "127.0.0.1", accept); });
  const { port } = socket.address();
  await new Promise(accept => socket.close(accept));
  return port;
}

async function board(t, { app = loadBoardApp(join(ROOT, "plugins/sage/board/app")), now = new Date().toISOString() } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "sage-board-app-")), root = join(dir, "logbooks"), port = await freePort();
  const project = writeAppLogbook(root, now);
  const server = createBoardServer({ sources: [{ id: "sample", path: root, label: "Sample" }], port, app, settleReads: [] });
  t.after(async () => { await server.close(); rmSync(dir, { recursive: true, force: true }); });
  await server.start();
  return { base: `http://127.0.0.1:${port}`, project };
}

async function models(url, count, change = () => {}, wait = 30_000) {
  const controller = new AbortController(), seen = [];
  const response = await fetch(url, { signal: controller.signal });
  assert.equal(response.headers.get("content-type"), "text/event-stream; charset=utf-8");
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = "";
  const guard = setTimeout(() => controller.abort(), wait);
  try {
    while (seen.length < count) {
      const { value, done } = await reader.read().catch(() => ({ done: true }));
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (let end; (end = buffer.indexOf("\n\n")) !== -1;) {
        const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        assert.match(frame, /^id: \d+\nevent: model\ndata: /);
        seen.push(JSON.parse(frame.split("\n")[2].slice("data: ".length)));
        if (seen.length < count) await change(seen.length);
      }
    }
  } finally { clearTimeout(guard); controller.abort(); }
  return seen;
}

test("T1054, T1063: each plugin carries one script, one style, one vendor file and one graph file, each under its own size budget", () => {
  for (const plugin of PLUGINS) {
    const dir = join(ROOT, plugin, "board/app"), manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    assert.deepEqual(readdirSync(dir).sort(), [manifest.script, manifest.style, "manifest.json", manifest.vendor, manifest.graph].sort());
    const sizes = Object.fromEntries(["script", "style", "vendor", "graph"].map(part => [part, statSync(join(dir, manifest[part])).size]));
    assert.ok(sizes.graph > 100_000, "the graph file holds React Flow, so the app script does not");
    assert.deepEqual(budgetProblems(sizes), [], `${plugin}: ${JSON.stringify(sizes)}`);
  }
});

test("T1054, T1063: the size budget refuses a file one byte over it, and names the part", () => {
  for (const part of ["vendor", "graph"]) {
    const problems = budgetProblems({ vendor: BUDGET.vendor, script: BUDGET.script, style: BUDGET.style, graph: BUDGET.graph, [part]: BUDGET[part] + 1 });
    assert.equal(problems.length, 1);
    assert.match(problems[0], new RegExp(`${part} file is ${BUDGET[part] + 1} bytes, over its budget of ${BUDGET[part]} bytes`));
  }
});

test("T1054: the app source never sets raw HTML, so React escapes every agent text", () => {
  const files = readdirSync(join(ROOT, APP_SOURCE)).filter(name => /\.(?:jsx?|mjs)$/.test(name));
  assert.ok(files.length >= 3);
  for (const name of files) assert.doesNotMatch(readFileSync(join(ROOT, APP_SOURCE, name), "utf8"), /dangerouslySetInnerHTML|innerHTML|outerHTML|insertAdjacentHTML|document\.write/, name);
});

test("T1054: /app/ serves the shell under a CSP with no inline code, no eval and no outside source, and the bundled files", async t => {
  const { base } = await board(t);
  const shell = await fetch(`${base}/app/`), html = await shell.text(), policy = shell.headers.get("content-security-policy");
  assert.equal(shell.status, 200);
  assert.equal(policy, `default-src 'none'; script-src ${base}/app/; style-src ${base}/app/; connect-src 'self'; img-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'none'`);
  assert.doesNotMatch(html, /<script>|<style>|\son[a-z]+=/i, "no inline script, style or handler");
  const manifest = JSON.parse(readFileSync(join(ROOT, "plugins/sage/board/app/manifest.json"), "utf8"));
  for (const [part, type] of [["script", "text/javascript"], ["style", "text/css"], ["vendor", "text/javascript"], ["graph", "text/javascript"]]) {
    const file = await fetch(`${base}/app/${manifest[part]}`);
    assert.equal(file.status, 200);
    assert.equal(file.headers.get("content-type"), `${type}; charset=utf-8`);
    assert.equal(file.headers.get("x-content-type-options"), "nosniff");
    assert.equal(await file.text(), readFileSync(join(ROOT, "plugins/sage/board/app", manifest[part]), "utf8"));
  }
  for (const path of ["/app/manifest.json", "/app/../server.mjs", "/app/app.jsx", "/app/graph.jsx", "/app/vendor-AAAAAAAA.js", "/app/graph-AAAAAAAA.js"]) assert.equal((await fetch(`${base}${path}`)).status, 404, path);
  const bare = await fetch(`${base}/app`, { redirect: "manual" });
  assert.equal(bare.status, 301);
  assert.equal(bare.headers.get("location"), "/app/");
  assert.equal((await fetch(`${base}/app/`, { method: "POST" })).status, 405);
});

test("T1054: /app/ refuses a request from another site or a forwarded one, as the old board does", async t => {
  const { base } = await board(t);
  const { request } = await import("node:http");
  const status = headers => new Promise((accept, reject) => {
    const req = request(`${base}/app/`, { headers, agent: false }, response => { response.resume(); accept(response.statusCode); });
    req.on("error", reject); req.end();
  });
  const host = new URL(base).host;
  assert.equal(await status({ Host: host }), 200);
  assert.equal(await status({ Host: host, Origin: "http://evil.test" }), 403);
  assert.equal(await status({ Host: host, "Sec-Fetch-Site": "cross-site" }), 403);
  assert.equal(await status({ Host: host, "X-Forwarded-For": "10.0.0.1" }), 403);
  assert.equal(await status({ Host: "evil.test" }), 403);
});

test("T1054: the event stream sends the Overview model as JSON, and again when the logbook changes", async t => {
  const { base, project } = await board(t);
  const file = join(project, "gates.tsv");
  const [first, second] = await models(`${base}/app/events`, 2, () => {
    writeFileSync(file, readFileSync(file, "utf8").replace("Crash reports: send them on their own, or ask each time?", "Crash reports: <b>send</b> them?"));
  });
  assert.deepEqual(first.needs.map(need => need.gate), ["G4", "G5"]);
  assert.deepEqual(first.milestones.map(milestone => milestone.id), ["M2", "M1", "M3"]);
  assert.deepEqual(first.counts, { merged: 1, stuck: 1, stuckNow: 0, added: null });
  assert.equal(first.stale, false);
  assert.equal(second.needs[1].question, "Crash reports: <b>send</b> them?", "the model carries text, never HTML");
});

test("T1054: a copy with no built app says so at /app/, and the old board still works", async t => {
  const { base } = await board(t, { app: null });
  const app = await fetch(`${base}/app/`);
  assert.equal(app.status, 503);
  assert.match(await app.text(), /not built in this copy/);
  const old = await fetch(`${base}/`);
  assert.equal(old.status, 200);
  assert.match(await old.text(), /Sample crash reports/);
});

test("F-T1065-4, -12: a manifest that names a missing file leaves only /app/ off, with the way to fix it, and the old board works", async t => {
  const dir = mkdtempSync(join(tmpdir(), "sage-board-app-copy-")), plugin = join(ROOT, "plugins/sage/board/app");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const manifest = JSON.parse(readFileSync(join(plugin, "manifest.json"), "utf8"));
  mkdirSync(join(dir, "app"));
  for (const name of ["manifest.json", manifest.script, manifest.style, manifest.vendor]) copyFileSync(join(plugin, name), join(dir, "app", name));
  assert.equal(loadBoardApp(join(dir, "app")), null, "the graph file is missing");
  const { base } = await board(t, { app: loadBoardApp(join(dir, "app")) });
  const app = await fetch(`${base}/app/`);
  assert.equal(app.status, 503);
  assert.match(await app.text(), /start the board from the sage plugin's board\/cli\.mjs/);
  assert.equal((await fetch(`${base}/`)).status, 200);
});

test("F-T1065-14: the app stream sends a model only when it changed, and refuses a 17th stream as the old board does", async t => {
  const { base, project } = await board(t);
  const file = join(project, "tasks.tsv"), text = readFileSync(file, "utf8"), damaged = "not\ta\ttasks\ttable\n";
  const frames = await models(`${base}/app/events`, 3, async count => {
    writeFileSync(file, damaged);
    if (count === 1) return;
    await new Promise(accept => setTimeout(accept, 500));
    writeFileSync(file, text);
  });
  assert.deepEqual(frames.map(frame => frame.stale), [false, true, false], "a second read of the same damaged table, with the same last good data, sent nothing");
  const controllers = Array.from({ length: 16 }, () => new AbortController());
  t.after(() => controllers.forEach(controller => controller.abort()));
  for (const controller of controllers) assert.equal((await fetch(`${base}/app/events`, { signal: controller.signal })).status, 200);
  const extra = await fetch(`${base}/app/events`);
  assert.equal(extra.status, 503);
  assert.match(await extra.text(), /too many open board streams/);
});

test("F-T1065-14: the server reads again when a merge leaves the 24-hour window, with no change in the logbook", async t => {
  const { base } = await board(t, { now: new Date(Date.now() - 22 * 3_600_000 + 1_500).toISOString() });
  const [first, second] = await models(`${base}/app/events`, 2, () => {}, 20_000);
  assert.equal(first.counts.merged, 1, "T1 merged 24 h minus 1.5 s ago");
  assert.equal(second?.counts.merged, 0, "1.5 s later the merge leaves the window, and the server sends the new count");
});

test("F-T1065-15, -16: a package that npm puts inside another package's folder gets its own pin check and its own licence", t => {
  const root = mkdtempSync(join(tmpdir(), "sage-board-licences-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const add = (path, version, licence) => { mkdirSync(join(root, path), { recursive: true }); writeFileSync(join(root, path, "package.json"), JSON.stringify({ version })); writeFileSync(join(root, path, "LICENSE"), licence); };
  writeFileSync(join(root, "package.json"), JSON.stringify({ devDependencies: { "react-dom": "1.0.0", scheduler: "2.0.0" } }));
  add("node_modules/react-dom", "1.0.0", "react-dom licence");
  add("node_modules/scheduler", "2.0.0", "top scheduler licence");
  add("node_modules/react-dom/node_modules/scheduler", "1.5.0", "nested scheduler licence");
  const inputs = ["node_modules/react-dom/index.js", "node_modules/react-dom/node_modules/scheduler/index.js"];
  assert.throws(() => licencesOf(root, inputs, "the board app"), { message: "scheduler 1.5.0 is in the board app, so package.json must pin it at exactly that version" });
  add("node_modules/react-dom/node_modules/scheduler", "2.0.0", "nested scheduler licence");
  assert.deepEqual([...licencesOf(root, inputs, "the board app")], [["react-dom.txt", "react-dom 1.0.0\n\nreact-dom licence"], ["scheduler.txt", "scheduler 2.0.0\n\nnested scheduler licence"]]);
});
