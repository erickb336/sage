import "./test-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { finished } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { configId, createBoardConfig, readBoardConfig, runBoardCli } from "../packages/sage-board/cli.mjs";
import { createBoardServer } from "../packages/sage-board/server.mjs";
import { boardPort } from "../packages/sage-core/index.mjs";

const CLI = fileURLToPath(new URL("../packages/sage-board/cli.mjs", import.meta.url));
const PLUGIN_CLI = fileURLToPath(new URL("../plugins/sage/board/cli.mjs", import.meta.url));

const TEST_CHILD = fileURLToPath(new URL("./board-test-child.mjs", import.meta.url));
const owned = new Map();
function startBoard(cli, args, env, cwd) {
  const child = spawn(process.execPath, [TEST_CHILD, cli, ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  const exited = new Promise((done, fail) => { child.once("error", fail); child.once("exit", done); });
  const closed = Promise.all([exited, finished(child.stdout), finished(child.stderr)]);
  owned.set(child, { home: env.HOME, closed });
  child.on("message", message => {
    if (message.kind === "stop-request") {
      for (const [root, record] of owned) if (record.home === env.HOME && root.connected) root.send({ kind: "close-pid", pid: message.pid }, () => {});
    }
  });
  return child;
}
async function closeChild(child) {
  if (child.connected) child.send({ kind: "close-tree" }, () => {});
  await owned.get(child).closed;
  owned.delete(child);
}
async function closeHome(home) {
  await Promise.all([...owned].filter(([, record]) => record.home === home).map(([child]) => closeChild(child)));
}
function scratch(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "sage-board-ensure-")));
  t.after(async () => { await closeHome(join(dir, "home")); rmSync(dir, { recursive: true, force: true }); });
  const env = { ...process.env, HOME: join(dir, "home") };
  delete env.CODEX_HOME;
  delete env.SAGE_HOME;
  delete env.SAGE_SHARED_HOME;
  return { dir, env, config: join(dir, "home", ".config", "sage-board", "board.json") };
}

function resultOf(child) {
  return new Promise((resolve, reject) => {
    const failed = status => { cleanup(); reject(new Error(`board wrapper exited before its result (${status})`)); };
    const received = message => { if (message.kind === "result") { cleanup(); resolve(message); } };
    const cleanup = () => { child.off("close", failed); child.off("message", received); child.off("error", failed); };
    child.once("close", failed); child.once("error", failed); child.on("message", received);
  });
}
function board(cli, args, env) {
  const child = startBoard(cli, ["board", ...args], env);
  child.stdout.resume(); child.stderr.resume();
  return resultOf(child);
}

async function freePort() {
  const socket = createServer();
  await new Promise((accept, reject) => { socket.once("error", reject); socket.listen(0, "127.0.0.1", accept); });
  const { port } = socket.address();
  await new Promise((accept) => socket.close(accept));
  return port;
}

const get = (port) => new Promise((done) => {
  const req = request({ host: "127.0.0.1", port, path: "/", agent: false, headers: { Host: `127.0.0.1:${port}` } }, (response) => {
    let body = ""; response.setEncoding("utf8"); response.on("data", (chunk) => { body += chunk; });
    response.on("end", () => done({ status: response.statusCode, body, board: response.headers["x-sage-board"] }));
  });
  req.once("error", (error) => done({ error: error.code }));
  req.end();
});

async function stop(dir, _port) { await closeHome(join(dir, "home")); }

test("T216: setup without --sources lists the standard Claude and Codex roots and the shared root of the current user, also when they are missing", async (t) => {
  const { dir, env, config } = scratch(t);
  const made = await board(CLI, ["--setup"], env);
  assert.equal(made.status, 0, made.stderr);
  assert.equal(made.stdout, `Board config created: ${config}. Start the board with node ${CLI} board --ensure\n`);
  const written = JSON.parse(readFileSync(config, "utf8"));
  assert.deepEqual(written.sources, [
    { id: "claude", label: "Claude", provider: "claude", path: join(dir, "home", ".claude", "sage") },
    { id: "codex", label: "Codex", provider: "codex", path: join(dir, "home", ".codex", "sage") },
    { id: "shared", label: "Shared", path: join(dir, "home", ".sage") },
  ]);
  assert.equal(written.port, 43123);
  assert.deepEqual(Object.keys(written).sort(), ["port", "sources", "version"], "T229, T1053: setup writes no secret, password or allowed hosts");
  assert.equal(statSync(config).mode & 0o777, 0o600);
  const moved = { ...env, CLAUDE_CONFIG_DIR: join(dir, "claude-config"), CODEX_HOME: join(dir, "codex-home") };
  const other = join(dir, "other", "board.json");
  assert.equal((await board(CLI, ["--setup", "--config", other], moved)).status, 0);
  assert.deepEqual(JSON.parse(readFileSync(other, "utf8")).sources.map((source) => source.path), [join(dir, "claude-config", "sage"), join(dir, "codex-home", "sage"), join(dir, "home", ".sage")]);
  const shared = join(dir, "shared", "board.json");
  assert.equal((await board(CLI, ["--setup", "--config", shared], { ...moved, SAGE_HOME: join(dir, "sage-home") })).status, 0);
  assert.deepEqual(JSON.parse(readFileSync(shared, "utf8")).sources, [{ id: "sage", label: "Sage", path: join(dir, "sage-home") }, { id: "shared", label: "Shared", path: join(dir, "sage-home", "shared") }]);
  const explicit = join(dir, "explicit", "board.json");
  assert.equal((await board(CLI, ["--setup", "--config", explicit, "--sources", JSON.stringify([{ id: "one", path: join(dir, "one") }])], env)).status, 0);
  assert.deepEqual(JSON.parse(readFileSync(explicit, "utf8")).sources, [{ id: "one", path: join(dir, "one") }]);
  const again = await board(CLI, ["--setup"], env);
  assert.equal(again.status, 1);
  assert.deepEqual(JSON.parse(readFileSync(config, "utf8")), written);
});

test("T216: ensure sets the board up, starts one detached server, and leaves a running server as it is", async (t) => {
  const { dir, env, config } = scratch(t);
  const port = await freePort();
  try {
    const first = await board(CLI, ["--ensure", "--port", String(port)], env);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(first.stdout, `Sage board started: http://127.0.0.1:${port}/ · only on this Mac.\n`);
    const { secret, password, allowedHosts, sources } = JSON.parse(readFileSync(config, "utf8"));
    assert.deepEqual([secret, password, allowedHosts], [undefined, undefined, undefined], "T229, T1053: ensure writes no secret, password or allowed hosts");
    assert.deepEqual(sources.map((source) => source.id), ["claude", "codex", "shared"]);
    const page = await get(port);
    assert.equal(page.status, 200);
    assert.match(page.body, /<html/);
    const pidFile = join(dir, "home", ".config", "sage-board", "board.pid"), log = join(dir, "home", ".config", "sage-board", "board.log");
    const pid = readFileSync(pidFile, "utf8");
    assert.match(pid, /^[1-9]\d*\n$/);
    assert.match(page.board, new RegExp(`^id=${configId(config)}; pid=${pid.trim()}; started=\\d+$`), "the server names this config and its own pid");
    assert.equal(statSync(log).mode & 0o777, 0o600);
    const second = await board(CLI, ["--ensure"], env);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(second.stdout, `Sage board is running: http://127.0.0.1:${port}/ · only on this Mac.\n`);
    assert.equal(readFileSync(pidFile, "utf8"), pid, "no second server started");
    const settings = await board(CLI, ["--ensure", "--port", String(port)], env);
    assert.equal(settings.status, 1);
    assert.equal(settings.stderr, `sage board: the board config ${config} exists, and setup does not change it. To move the board to another port, run node ${CLI} board --port <port> --config ${config}. To change another setting, first run node ${CLI} board --stop --config ${config}, then edit that file, then ask for the board again. To set the board up again, remove the file first.\n`);
  } finally { await stop(dir, port); }
});

test("T216: ensure gives one line when another program holds the port, and starts nothing", async (t) => {
  const { dir, env, config } = scratch(t);
  const other = createHttpServer((request, response) => response.end("another program\n"));
  await new Promise((accept) => other.listen(0, "127.0.0.1", accept));
  const { port } = other.address();
  try {
    assert.equal((await board(CLI, ["--setup", "--port", String(port)], env)).status, 0);
    const busy = await board(CLI, ["--ensure"], env);
    assert.equal(busy.status, 1);
    assert.equal(busy.stdout, "");
    assert.equal(busy.stderr, `sage board: the board server is not running: another program answers on 127.0.0.1:${port}. Stop that program, or move the board to a free port: run node ${CLI} board --port ${port + 1} (any free port from 1024 to 65535 works).\n`);
    assert.equal(existsSync(join(dir, "home", ".config", "sage-board", "board.pid")), false);
    assert.equal(existsSync(join(dir, "home", ".config", "sage-board", "board.log")), false);
  } finally {
    other.closeAllConnections();
    await new Promise((accept) => other.close(accept));
    await stop(dir, port);
  }
});

test("T216: two ensures at once start one board, and board.pid names the process that answers (F-T216-6)", async (t) => {
  const { dir, env, config } = scratch(t);
  const port = await freePort();
  try {
    assert.equal((await board(CLI, ["--setup", "--port", String(port)], env)).status, 0);
    const both = await Promise.all([board(CLI, ["--ensure"], env), board(CLI, ["--ensure"], env)]);
    for (const run of both) assert.equal(run.status, 0, run.stderr);
    for (const run of both) assert.match(run.stdout, /^Sage board (?:started|is running): /);
    const answering = (await get(port)).board.match(/pid=(\d+)/)[1];
    assert.equal(readFileSync(join(dirname(config), "board.pid"), "utf8"), `${answering}\n`);
  } finally { await stop(dir, port); }
});

test("T216: board --stop stops this config's board, and ensure says when the config changed after the start (F-T216-7)", async (t) => {
  const { dir, env, config } = scratch(t);
  const port = await freePort(), pidFile = join(dirname(config), "board.pid");
  try {
    assert.equal((await board(CLI, ["--ensure", "--port", String(port)], env)).status, 0);
    assert.equal((await get(port)).status, 200);
    const later = new Date(Date.now() + 5000); utimesSync(config, later, later);
    const changed = await board(CLI, ["--ensure"], env);
    assert.equal(changed.status, 0, changed.stderr);
    assert.equal(changed.stdout, `Sage board is running: http://127.0.0.1:${port}/, but ${config} changed after it started. Restart needed: run node ${CLI} board --stop then ask for the board again.\n`);
    const stopped = await board(CLI, ["--stop"], env);
    assert.equal(stopped.status, 0, stopped.stderr);
    assert.equal(stopped.stdout, `Board server stopped: 127.0.0.1:${port} is free. Ask for the board again to start it.\n`);
    assert.equal((await get(port)).error, "ECONNREFUSED");
    assert.equal(existsSync(pidFile), false, "the server removes its board.pid when it stops");
    assert.equal((await board(CLI, ["--stop"], env)).stdout, `No board server runs on 127.0.0.1:${port}.\n`);
    const again = await board(CLI, ["--ensure"], env);
    assert.match(again.stdout, /^Sage board started: /);
  } finally { await stop(dir, port); }
});

test("T395: the documented port change (stop, edit the port, ask again) leaves one board, on the new port (R1478-1)", async (t) => {
  const { dir, env, config } = scratch(t);
  const [oldPort, newPort] = [await freePort(), await freePort()];
  try {
    assert.equal((await board(CLI, ["--ensure", "--port", String(oldPort)], env)).status, 0);
    const stopped = await board(CLI, ["--stop", "--config", config], env);
    assert.equal(stopped.stdout, `Board server stopped: 127.0.0.1:${oldPort} is free. Ask for the board again to start it.\n`, stopped.stderr);
    writeFileSync(config, JSON.stringify({ ...JSON.parse(readFileSync(config, "utf8")), port: newPort }));
    const again = await board(CLI, ["--ensure"], env);
    assert.equal(again.stdout.startsWith(`Sage board started: http://127.0.0.1:${newPort}/`), true, again.stderr);
    assert.equal((await get(oldPort)).error, "ECONNREFUSED", "the old board does not run on beside the new one");
    const pid = readFileSync(join(dirname(config), "board.pid"), "utf8").trim();
    assert.match((await get(newPort)).board, new RegExp(`^id=${configId(config)}; pid=${pid}; started=\\d+$`));
  } finally { await stop(dir, oldPort); }
});

const listen = async (server) => { await new Promise((accept) => server.listen(0, "127.0.0.1", accept)); return server.address().port; };
const shut = async (server) => { server.closeAllConnections?.(); await new Promise((accept) => server.close(accept)); };
const olderBoard = () => createHttpServer((request, response) => {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "default-src 'none'", "Cross-Origin-Resource-Policy": "same-origin" });
  response.end("<!doctype html><title>Sage board</title>\n");
});

const portFile = (config) => join(dirname(config), "board.port");
const snapshot = (config) => ({ text: readFileSync(config, "utf8"), mode: statSync(config).mode & 0o777 });

test("T1079: another program holds the port; the error names board --port, and that one command gives a working board on the new port and keeps every other setting", async (t) => {
  const { dir, env, config } = scratch(t);
  const other = createHttpServer((request, response) => response.end("another program\n"));
  const busyPort = await listen(other), newPort = await freePort();
  try {
    createBoardConfig(config, { sources: [{ id: "sample", path: join(dir, "logbooks") }], port: busyPort, pagesDir: join(dir, "exports") });
    writeFileSync(config, `${JSON.stringify({ ...JSON.parse(readFileSync(config, "utf8")), secret: "old-secret-value" }, null, 2)}\n`);
    chmodSync(config, 0o640);
    const before = JSON.parse(readFileSync(config, "utf8"));
    const busy = await board(CLI, ["--ensure"], env);
    assert.equal(busy.status, 1);
    assert.match(busy.stderr, new RegExp(`another program answers on 127\\.0\\.0\\.1:${busyPort}\\. Stop that program, or move the board to a free port: run node ${CLI.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} board --port ${busyPort + 1} \\(any free port from 1024 to 65535 works\\)\\.\\n$`));
    const moved = await board(CLI, ["--port", String(newPort)], env);
    assert.equal(moved.status, 0, moved.stderr);
    assert.equal(moved.stdout, `Board moved to port ${newPort}: ${config} names it now.\nSage board started: http://127.0.0.1:${newPort}/ · only on this Mac.\nA Page link in a message from before still names port ${busyPort}: change the port in that link.\n`);
    assert.doesNotMatch(moved.stdout + moved.stderr + busy.stderr, /old-secret-value/, "no secret in the output");
    assert.deepEqual(JSON.parse(readFileSync(config, "utf8")), { ...before, port: newPort }, "only the port changed; the pages folder and the old secret key stay");
    assert.equal(statSync(config).mode & 0o777, 0o640, "the file keeps its mode");
    const page = await get(newPort);
    assert.equal(page.status, 200);
    assert.match(page.board, new RegExp(`^id=${configId(config)}; pid=\\d+; started=\\d+$`), "this config's board answers on the new port");
    assert.equal(readFileSync(portFile(config), "utf8"), `${newPort}\n`, "the board writes its port for the Page links");
    assert.equal(boardPort(env), newPort, "core reads that port for the Page links");
    assert.equal((await get(busyPort)).body, "another program\n", "the other program runs on");
  } finally { await shut(other); await stop(dir); }
});

test("T1079: board --port stops this config's running board and starts it on the new port, and a second run changes nothing", async (t) => {
  const { dir, env, config } = scratch(t);
  const [oldPort, newPort] = [await freePort(), await freePort()];
  try {
    assert.equal((await board(CLI, ["--ensure", "--port", String(oldPort)], env)).status, 0);
    assert.equal(readFileSync(portFile(config), "utf8"), `${oldPort}\n`);
    const moved = await board(CLI, ["--port", String(newPort), "--config", config], env);
    assert.equal(moved.status, 0, moved.stderr);
    assert.match(moved.stdout, new RegExp(`^Board moved to port ${newPort}: .* names it now\\. The board on 127\\.0\\.0\\.1:${oldPort} stopped\\.\\nSage board started: http://127\\.0\\.0\\.1:${newPort}/`));
    assert.equal((await get(oldPort)).error, "ECONNREFUSED", "the old board does not run on beside the new one");
    const pid = readFileSync(join(dirname(config), "board.pid"), "utf8").trim();
    assert.match((await get(newPort)).board, new RegExp(`^id=${configId(config)}; pid=${pid}; started=\\d+$`));
    const kept = snapshot(config);
    const again = await board(CLI, ["--port", String(newPort)], env);
    assert.equal(again.stdout, `Sage board is running: http://127.0.0.1:${newPort}/ · only on this Mac.\n`, again.stderr);
    assert.deepEqual(snapshot(config), kept);
  } finally { await stop(dir); }
});

test("T1079: board --port refuses a bad number, a busy port, a missing config and a file or folder that it cannot write, and then changes nothing and leaves the board running", async (t) => {
  const { dir, env, config } = scratch(t);
  const other = createHttpServer((request, response) => response.end("another program\n"));
  const [port, busyPort, newPort] = [await freePort(), await listen(other), await freePort()];
  try {
    const missing = await board(CLI, ["--port", String(newPort)], env);
    assert.equal(missing.stderr, `sage board: there is no board config at ${config} yet. Run node ${CLI} board --ensure --port ${newPort} to set the board up on port ${newPort} and start it.\n`);
    assert.equal(existsSync(config), false);
    assert.equal((await board(CLI, ["--ensure", "--port", String(port)], env)).status, 0);
    const kept = snapshot(config), pid = readFileSync(join(dirname(config), "board.pid"), "utf8");
    const unchanged = async (label) => {
      assert.deepEqual(snapshot(config), kept, `${label}: the config is as before`);
      assert.equal(readFileSync(join(dirname(config), "board.pid"), "utf8"), pid, `${label}: the same board runs`);
      assert.equal((await get(port)).status, 200, `${label}: the board still answers on its port`);
      assert.equal((await get(newPort)).error, "ECONNREFUSED", `${label}: nothing started on the new port`);
    };
    for (const value of ["80", "1023", "65536", "abc", "4312a", "-5", "043124"]) {
      const bad = await board(CLI, ["--port", value], env);
      assert.equal(bad.status, 1, value);
      assert.equal(bad.stderr, `sage board: board --port needs a whole number from 1024 to 65535, not ${JSON.stringify(value)}. Nothing changed.\n`);
      await unchanged(value);
    }
    const busy = await board(CLI, ["--port", String(busyPort)], env);
    assert.equal(busy.stderr, `sage board: port ${busyPort} is not free (EADDRINUSE): another program on this Mac uses it. Choose another port from 1024 to 65535. Nothing changed.\n`);
    await unchanged("a busy port");
    chmodSync(config, 0o400);
    try {
      const file = await board(CLI, ["--port", String(newPort)], env);
      assert.equal(file.stderr, `sage board: this command cannot write ${config} (EACCES), so it cannot change the board config. Nothing changed.\n`);
    } finally { chmodSync(config, kept.mode); }
    await unchanged("a file that it cannot write");
    chmodSync(dirname(config), 0o500);
    try {
      const folder = await board(CLI, ["--port", String(newPort)], env);
      assert.equal(folder.stderr, `sage board: this command cannot write ${dirname(config)} (EACCES), so it cannot change the board config. Nothing changed.\n`);
    } finally { chmodSync(dirname(config), 0o700); }
    await unchanged("a folder that it cannot write");
  } finally { await shut(other); await stop(dir); }
});

test("T1079: board --port leaves a board of another config on the old port running, and moves this config", async (t) => {
  const { dir, env, config } = scratch(t);
  const [port, newPort] = [await freePort(), await freePort()];
  createBoardConfig(config, { sources: [{ id: "sample", path: join(dir, "logbooks") }], port });
  const otherConfig = join(dir, "other", "board.json");
  createBoardConfig(otherConfig, { sources: [{ id: "sample", path: join(dir, "logbooks") }], port });
  const other = createBoardServer({ ...readBoardConfig(otherConfig), id: configId(otherConfig) });
  try {
    await other.start();
    const moved = await board(CLI, ["--port", String(newPort)], env);
    assert.equal(moved.status, 0, moved.stderr);
    assert.doesNotMatch(moved.stdout, /stopped/);
    assert.match((await get(port)).board, new RegExp(`^id=${configId(otherConfig)};`), "the other config's board runs on");
    assert.match((await get(newPort)).board, new RegExp(`^id=${configId(config)};`));
  } finally { await other.close(); await stop(dir); }
});

test("F-T229-32: after an upgrade, ensure asks for a restart of a board that started before the new code", async (t) => {
  const { dir, env, config } = scratch(t);
  const code = Math.max(...["cli.mjs", "server.mjs"].map((name) => statSync(join(dirname(CLI), name)).mtimeMs));
  let started = Math.floor(code - 10_000);
  const older = createHttpServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "default-src 'none'", "Cross-Origin-Resource-Policy": "same-origin", "X-Sage-Board": `id=${configId(config)}; pid=424242; started=${started}` });
    response.end();
  });
  const port = await listen(older);
  try {
    mkdirSync(dirname(config), { recursive: true });
    writeFileSync(config, JSON.stringify({ version: 1, sources: [{ id: "sample", path: join(dir, "logbooks") }], port, allowedHosts: ["sample.tailnet.ts.net"], secret: "sample-old-secret-sample-old-secret-sample-old" }));
    const written = new Date(code - 20_000); utimesSync(config, written, written);
    const found = await board(CLI, ["--ensure"], env);
    assert.equal(found.status, 0, found.stderr);
    assert.equal(found.stdout, `Sage board is running: http://127.0.0.1:${port}/, but the board command was updated after it started. Restart needed: run node ${CLI} board --stop then ask for the board again.\n`);
    started = Date.now();
    const restarted = await board(CLI, ["--ensure"], env);
    assert.equal(restarted.stdout, `Sage board is running: http://127.0.0.1:${port}/ · only on this Mac.\n`);
  } finally { await shut(older); }
});

const olderLine = (port) => `an older board server runs on 127.0.0.1:${port}. Stop it where it started: press Ctrl+C in its terminal, or for the login service run launchctl bootout gui/$(id -u)/dev.sage.board. Then ask for the board again.`;

test("T216: ensure names an older board server and how to stop it; stop sends it no signal, whatever board.pid holds (F-T216-3, 11, 16)", async (t) => {
  const { dir, env, config } = scratch(t);
  const older = olderBoard(), port = await listen(older);
  try {
    assert.equal((await board(CLI, ["--setup", "--port", String(port)], env)).status, 0);
    const found = await board(CLI, ["--ensure"], env);
    assert.equal(found.status, 1);
    assert.equal(found.stderr, `sage board: ${olderLine(port)}\n`);
    writeFileSync(join(dirname(config), "board.pid"), "424242\n");
    const signals = [], lines = [];
    await assert.rejects(runBoardCli(["board", "--stop"], { env, output: (line) => lines.push(line), kill: (...args) => signals.push(args) }), { message: olderLine(port) });
    assert.deepEqual(signals, [], "no signal to a process that the board does not name");
    assert.deepEqual(lines, []);
    assert.equal((await get(port)).status, 200, "the older board still runs");
  } finally { await shut(older); }
  const unnamed = createBoardServer({ ...readBoardConfig(config), port: await freePort() });
  try {
    await unnamed.start();
    const at = unnamed.address().port, path = join(dir, "unnamed", "board.json");
    createBoardConfig(path, { sources: [{ id: "sample", path: join(dir, "logbooks") }], port: at });
    const found = await board(CLI, ["--ensure", "--config", path], env);
    assert.equal(found.stderr, `sage board: ${olderLine(at)}\n`);
  } finally { await unnamed.close(); }
});

test("T216: a program that takes the port and never answers gives one line that the board does not answer (F-T216-3)", async (t) => {
  const { env, config } = scratch(t);
  const sockets = new Set(), silent = createServer((socket) => { sockets.add(socket); socket.on("error", () => {}); });
  const port = await listen(silent);
  try {
    assert.equal((await board(CLI, ["--setup", "--port", String(port)], env)).status, 0);
    const found = await board(CLI, ["--ensure"], env);
    assert.equal(found.status, 1);
    assert.equal(found.stderr, `sage board: the board does not answer: a program holds 127.0.0.1:${port} and gives no answer within 2 s. Stop that program, or move the board to a free port: run node ${CLI} board --port ${port + 1} (any free port from 1024 to 65535 works).\n`);
  } finally { for (const socket of sockets) socket.destroy(); await new Promise((accept) => silent.close(accept)); }
});

test("T216: a board of another config on the port is not reported as this one, and stop leaves it running (F-T216-10)", async (t) => {
  const { dir, env, config } = scratch(t);
  const port = await freePort();
  createBoardConfig(config, { sources: [{ id: "sample", path: join(dir, "logbooks") }], port });
  const otherConfig = join(dir, "other", "board.json");
  createBoardConfig(otherConfig, { sources: [{ id: "sample", path: join(dir, "logbooks") }], port });
  const other = createBoardServer({ ...readBoardConfig(otherConfig), id: configId(otherConfig) });
  try {
    await other.start();
    const found = await board(CLI, ["--ensure"], env);
    assert.equal(found.status, 1);
    assert.equal(found.stderr, `sage board: another board config holds 127.0.0.1:${port}. Stop that program, or move the board to a free port: run node ${CLI} board --port ${port + 1} (any free port from 1024 to 65535 works).\n`);
    writeFileSync(join(dirname(config), "board.pid"), `${process.pid}\n`);
    const signals = [];
    await assert.rejects(runBoardCli(["board", "--stop"], { env, output: () => {}, kill: (...args) => signals.push(args) }), /another board config holds/);
    assert.deepEqual(signals, [], "no signal to another config's board");
    assert.equal((await get(port)).status, 200);
  } finally { await other.close(); }
});

test("T216: stop sends no signal when board.pid does not name the process that answers, or is missing (F-T216-7)", async (t) => {
  const { dir, env, config } = scratch(t);
  const port = await freePort();
  createBoardConfig(config, { sources: [{ id: "sample", path: join(dir, "logbooks") }], port });
  const server = createBoardServer({ ...readBoardConfig(config), id: configId(config) });
  const signals = [], kill = (...args) => signals.push(args);
  try {
    await server.start();
    await assert.rejects(runBoardCli(["board", "--stop"], { env, output: () => {}, kill }), /has no board\.pid next to/);
    writeFileSync(join(dirname(config), "board.pid"), "999999\n");
    await assert.rejects(runBoardCli(["board", "--stop"], { env, output: () => {}, kill }), new RegExp(`is process ${process.pid}, but board\\.pid says 999999`));
    assert.deepEqual(signals, []);
  } finally { await server.close(); }
});

test("F-T216-12: when board.pid cannot be written, the server closes and the command fails, so no listener stays without it", async (t) => {
  const { dir, env, config } = scratch(t);
  const port = await freePort();
  createBoardConfig(config, { sources: [{ id: "sample", path: join(dir, "logbooks") }], port });
  mkdirSync(join(dirname(config), "board.pid", "inside"), { recursive: true });
  const child = startBoard(CLI, ["board", "--serve"], env);
  let stderr = ""; child.stderr.on("data", (chunk) => { stderr += chunk; });
  try {
    const status = await Promise.race([new Promise((done) => child.once("close", done)), new Promise((done) => setTimeout(done, 15_000, "still running").unref())]);
    assert.equal(status, 1, stderr);
    assert.match(stderr, /^sage board: /);
    assert.equal((await get(port)).error, "ECONNREFUSED");
  } finally { await closeChild(child); }
});

test("F-T216-13, T1079: the server writes board.pid and board.port as new files, so a hard link at those names does not change the file it points to", async (t) => {
  const { dir, env, config } = scratch(t);
  const port = await freePort();
  createBoardConfig(config, { sources: [{ id: "sample", path: join(dir, "logbooks") }], port });
  const other = join(dir, "other.txt"), pidFile = join(dirname(config), "board.pid");
  writeFileSync(other, "sample text that stays\n");
  linkSync(other, pidFile);
  const second = join(dir, "second.txt"), portPath = portFile(config);
  writeFileSync(second, "more sample text\n");
  linkSync(second, portPath);
  const server = await runBoardCli(["board", "--serve"], { env, output: () => {} });
  try {
    assert.equal(readFileSync(other, "utf8"), "sample text that stays\n");
    assert.equal(readFileSync(pidFile, "utf8"), `${process.pid}\n`);
    assert.equal(readFileSync(second, "utf8"), "more sample text\n");
    assert.equal(readFileSync(portPath, "utf8"), `${port}\n`);
    assert.deepEqual(readdirSync(dirname(config)).sort(), ["board.json", "board.pid", "board.port"], "no temporary file is left");
  } finally { await server.close(); }
  assert.equal(existsSync(pidFile), false);
  assert.equal(readFileSync(portPath, "utf8"), `${port}\n`, "the port stays for the Page links when the board stops");
  assert.equal(readFileSync(other, "utf8"), "sample text that stays\n");
});

test("T216, T1053: the board guide says that the board is for this Mac only, and gives ensure and the restart (F-T216-9)", () => {
  const guide = readFileSync(fileURLToPath(new URL("../packages/sage-board/README.md", import.meta.url)), "utf8");
  assert.match(guide, /It is for a desktop browser on this Mac only: it listens on 127\.0\.0\.1, needs no sign-in, and refuses every request that does not come from the Mac itself\./);
  assert.match(guide, /`board --ensure` does the first and the last step for you/);
  assert.match(guide, /node <path to board\/cli\.mjs> board --stop/);
  assert.match(guide, /The login service runs the same `--serve` command, so its board writes `board\.pid` too/);
  assert.match(guide, /A raw TCP forward connects from loopback and adds no proxy header, so it passes the access check\./);
  assert.match(guide, /A config from an earlier version can still hold the keys `allowedHosts`, `password` or `secret`\. It still loads, and the board ignores those keys\./);
  assert.doesNotMatch(guide, /--set-password|Tailscale|tunnel|on the phone/i);
  assert.match(guide, /`--stop` sends it no signal, whatever `board\.pid` holds/);
});

function words(line, home) {
  const out = []; let word = null, quote = null;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quote) {
      if (char === quote) quote = null;
      else if (quote === '"' && char === "\\" && line[i + 1] === '"') { word += '"'; i++; }
      else if (quote === '"' && line.startsWith("$HOME", i)) { word += home; i += 4; }
      else if (quote === '"' && char === "$") throw new TypeError(`unexpected $ in the README command: ${line}`);
      else word += char;
    } else if (char === " ") { if (word !== null) out.push(word); word = null; }
    else if (char === '"' || char === "'") { quote = char; word ??= ""; }
    else if (/[$`\\;&|<>(){}*?]/.test(char)) throw new TypeError(`unexpected shell character in the README command: ${line}`);
    else word = (word ?? "") + char;
  }
  if (quote) throw new TypeError(`open quote in the README command: ${line}`);
  if (word !== null) out.push(word);
  return out;
}

test("F-T216-17: the board guide's set-up commands run as written in the board folder of an isolated plugin copy", async (t) => {
  const { dir, env } = scratch(t);
  const home = env.HOME, plugin = join(dir, "plugin");
  cpSync(fileURLToPath(new URL("../plugins/sage", import.meta.url)), plugin, { recursive: true });
  const guide = readFileSync(fileURLToPath(new URL("../packages/sage-board/README.md", import.meta.url)), "utf8");
  const block = guide.slice(guide.indexOf("To set it up by hand")).match(/```sh\n([\s\S]*?)```/)[1];
  const [setup, install, serve] = block.trim().split("\n").map((line) => words(line, home));
  assert.deepEqual([setup[0], install[0], serve[0]], ["node", "node", "node"]);
  const run = (args) => new Promise((done, fail) => {
    const child = spawn(process.execPath, args, { cwd: join(plugin, "board"), env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = ""; child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", fail); child.once("close", (status) => done({ status, stdout, stderr }));
  });
  const made = await run(setup.slice(1));
  assert.equal(made.status, 0, made.stderr);
  const installed = await run(install.slice(1));
  assert.equal(installed.status, 0, installed.stderr);
  const cli = join(home, ".local", "share", "sage-board", "service", "packages", "board", "cli.mjs");
  assert.equal(installed.stdout.split("\n")[0], `Installed board command: ${cli}`);
  assert.equal(serve[1], cli, "the serve line names the path that install prints");
  const config = join(home, ".config", "sage-board", "board.json"), port = await freePort();
  writeFileSync(config, JSON.stringify({ ...JSON.parse(readFileSync(config, "utf8")), port }));
  const child = startBoard(serve[1], serve.slice(2), env, join(plugin, "board"));
  try {
    let stdout = "";
    const line = await new Promise((done, fail) => {
      const timer = setTimeout(() => fail(new Error(`no serve line: ${stdout}`)), 15_000);
      child.stdout.on("data", (chunk) => { stdout += chunk; if (stdout.includes("\n")) { clearTimeout(timer); done(stdout); } });
      child.once("close", (status) => { clearTimeout(timer); fail(new Error(`serve exited with ${status}`)); });
    });
    assert.equal(line, `Sage board: http://127.0.0.1:${port}/ · only on this Mac.\n`);
    assert.equal((await get(port)).status, 200);
  } finally {
    await closeChild(child);
  }
});

test("T921: in a sandbox with no network, as in Codex, ensure says that the sandbox blocks the port, and starts nothing", { skip: process.platform !== "darwin" && "macOS sandbox-exec only" }, async (t) => {
  const { dir, env, config } = scratch(t);
  const port = await freePort();
  const run = spawnSync("/usr/bin/sandbox-exec", ["-p", "(version 1)(allow default)(deny network*)", process.execPath, fileURLToPath(new URL("../plugins/sage-codex/board/cli.mjs", import.meta.url)), "board", "--ensure", "--port", String(port)], { env, encoding: "utf8" });
  assert.equal(run.stderr, `sage board: this command cannot reach 127.0.0.1:${port}: a sandbox blocks the local network here (EPERM). In Codex, run it escalated (outside the sandbox), or in Terminal on the Mac.\n`);
  assert.equal(run.status, 1);
  assert.equal(run.stdout, "");
  assert.equal(readBoardConfig(config).port, port, "setup made the config before the probe");
  assert.equal(existsSync(join(dir, "home", ".config", "sage-board", "board.log")), false, "no server started");
  assert.equal(existsSync(join(dir, "home", ".config", "sage-board", "board.pid")), false);
});

test("T922: on the first run in a sandbox, as in Codex, ensure gives one plain line about the board config folder, and makes nothing", { skip: process.platform !== "darwin" && "macOS sandbox-exec only" }, async (t) => {
  const { dir, env } = scratch(t), home = join(dir, "home");
  mkdirSync(join(home, ".config"), { recursive: true });
  const port = await freePort(), cli = fileURLToPath(new URL("../plugins/sage-codex/board/cli.mjs", import.meta.url));
  const sandboxed = args => spawnSync("/usr/bin/sandbox-exec", ["-p", `(version 1)(allow default)(deny network*)(deny file-write* (subpath "${home}"))`, process.execPath, ...args], { env, encoding: "utf8" });
  assert.match(sandboxed(["-e", `require("fs").writeFileSync(${JSON.stringify(join(home, "probe"))}, "")`]).stderr, /EPERM/);
  const run = sandboxed([cli, "board", "--ensure", "--port", String(port)]);
  assert.equal(run.stderr, `sage board: this command cannot write ${join(home, ".config", "sage-board")}: a sandbox or the system blocks writes there (EPERM). In Codex, run it escalated (outside the sandbox), or in Terminal on the Mac.\n`);
  assert.equal(run.status, 1);
  assert.equal(run.stdout, "");
  assert.deepEqual(readdirSync(home), [".config"]);
  assert.deepEqual(readdirSync(join(home, ".config")), [], "no config folder, no config and no server");
});

test("T216: the plugin carries the board command that the hook's note names, and it runs outside the checkout layout", async (t) => {
  const { env } = scratch(t);
  const made = await board(PLUGIN_CLI, ["--setup"], env);
  assert.equal(made.status, 0, made.stderr);
  const status = await board(PLUGIN_CLI, ["all", "--status"], env);
  assert.equal(status.status, 0, status.stderr);
});

test("board test teardown waits for an owned descendant after its shutdown handler starts", async (t) => {
  const { dir, env } = scratch(t), fixture = join(dir, "fixture.mjs");
  writeFileSync(fixture, `
    import { spawn } from "node:child_process";
    if (process.argv.includes("--descendant")) {
      process.stdin.resume();
      process.once("SIGTERM", () => console.log("closing"));
      console.log("ready");
    } else {
      const child = spawn(process.execPath, [process.argv[1], "board", "--descendant"], { stdio: ["pipe", "pipe", "pipe"] });
      child.stdout.on("data", chunk => process.stdout.write(chunk));
      process.on("message", message => { if (message.kind === "fixture-release") child.stdin.end(); });
      await new Promise(resolve => child.stdout.once("data", resolve));
    }
  `);
  const child = startBoard(fixture, ["board"], env);
  child.stdout.resume(); child.stderr.resume();
  await resultOf(child);
  let closed = false, timer, output = "";
  const stopping = new Promise((resolve, reject) => {
    child.stdout.on("data", chunk => { output += chunk; if (output.includes("closing\n")) resolve(); });
    timer = setTimeout(() => reject(new Error(`descendant did not receive shutdown: ${output}`)), 30_000);
  });
  const completed = closeChild(child).then(() => { closed = true; });
  try {
    await stopping;
    assert.equal(closed, false, "a shutdown request is not evidence of process exit");
  } finally {
    clearTimeout(timer);
    if (child.connected) child.send({ kind: "fixture-release" }, () => {});
    await completed;
  }
  assert.equal(closed, true);
});

test("board test supervisor closes its server tree when the parent disconnects", async (t) => {
  const { dir, env } = scratch(t), port = await freePort();
  const child = startBoard(CLI, ["board", "--ensure", "--port", String(port)], env);
  child.stdout.resume(); child.stderr.resume();
  const result = await resultOf(child);
  assert.equal(result.status, 0, result.stderr);
  assert.equal((await get(port)).status, 200);
  child.disconnect();
  await owned.get(child).closed;
  assert.equal((await get(port)).error, "ECONNREFUSED");
  assert.equal(existsSync(join(dir, "home", ".config", "sage-board", "board.pid")), false);
});
