// T216: the board phrase starts the local board server. These tests run the board command as the chief does, with a
// scratch HOME and a random free port; each server that a test starts stops in its finally block.
import "./test-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable, Writable } from "node:stream";
import { finished } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { configId, createBoardConfig, readBoardConfig, runBoardCli } from "../packages/sage-board/cli.mjs";
import { createBoardServer } from "../packages/sage-board/server.mjs";

const CLI = fileURLToPath(new URL("../packages/sage-board/cli.mjs", import.meta.url));
const PLUGIN_CLI = fileURLToPath(new URL("../plugins/sage/board/cli.mjs", import.meta.url));

const TEST_CHILD = fileURLToPath(new URL("./board-test-child.mjs", import.meta.url));
const owned = new Map();
function startBoard(cli, args, env, cwd) {
  const child = spawn(process.execPath, [TEST_CHILD, cli, ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  // Explicit parent disconnect can suppress ChildProcess.close in Node. Observe exit and both pipes directly.
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
// A child can disconnect between connected and send. Actual close, not delivery, proves teardown.
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
/** Return the CLI result while the supervisor retains every detached server handle. */
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

/** Close every owned server attempt and await actual exit before removing its files. */
async function stop(dir, _port) { await closeHome(join(dir, "home")); }

test("T216: setup without --sources lists the standard Claude and Codex roots of the current user, also when they are missing", async (t) => {
  const { dir, env, config } = scratch(t);
  const made = await board(CLI, ["--setup"], env);
  assert.equal(made.status, 0, made.stderr);
  assert.equal(made.stdout, `Board config created: ${config}. Access from outside this Mac stays off until you set a board password: run in a terminal node ${CLI} board --set-password\n`);
  const written = JSON.parse(readFileSync(config, "utf8"));
  assert.deepEqual(written.sources, [
    { id: "claude", label: "Claude", provider: "claude", path: join(dir, "home", ".claude", "sage") },
    { id: "codex", label: "Codex", provider: "codex", path: join(dir, "home", ".codex", "sage") },
  ]);
  assert.equal(written.port, 43123);
  assert.equal(written.secret, undefined, "T229: setup writes no random secret");
  assert.equal(written.password, undefined, "and no password: only the owner sets it, in a terminal");
  assert.equal(statSync(config).mode & 0o777, 0o600);
  // The provider variables move the roots, as they move each provider's state tool.
  const moved = { ...env, CLAUDE_CONFIG_DIR: join(dir, "claude-config"), CODEX_HOME: join(dir, "codex-home") };
  const other = join(dir, "other", "board.json");
  assert.equal((await board(CLI, ["--setup", "--config", other], moved)).status, 0);
  assert.deepEqual(JSON.parse(readFileSync(other, "utf8")).sources.map((source) => source.path), [join(dir, "claude-config", "sage"), join(dir, "codex-home", "sage")]);
  // F-T216-4: SAGE_HOME is the one root of every provider's state tool, so it is the one standard root too.
  const shared = join(dir, "shared", "board.json");
  assert.equal((await board(CLI, ["--setup", "--config", shared], { ...moved, SAGE_HOME: join(dir, "sage-home") })).status, 0);
  assert.deepEqual(JSON.parse(readFileSync(shared, "utf8")).sources, [{ id: "sage", label: "Sage", path: join(dir, "sage-home") }]);
  // --sources still works, and a second setup never replaces a config.
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
    // F-T216-5: with no allowedHosts the line gives no phone steps.
    assert.equal(first.stdout, `Sage board started: http://127.0.0.1:${port}/ · no sign-in needed on this Mac. Phone access is off: no allowedHosts in ${config}. To turn it on, add the host name of your private HTTPS tunnel to allowedHosts in that file.\n`);
    const { secret, password, sources } = JSON.parse(readFileSync(config, "utf8"));
    assert.deepEqual([secret, password], [undefined, undefined], "T229: ensure writes no random secret");
    assert.deepEqual(sources.map((source) => source.id), ["claude", "codex"]);
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
    assert.equal(second.stdout, `Sage board is running: http://127.0.0.1:${port}/ · no sign-in needed on this Mac. Phone access is off: no allowedHosts in ${config}. To turn it on, add the host name of your private HTTPS tunnel to allowedHosts in that file.\n`);
    assert.equal(readFileSync(pidFile, "utf8"), pid, "no second server started");
    // The config exists, so a setup setting is refused rather than ignored.
    const settings = await board(CLI, ["--ensure", "--port", String(port)], env);
    assert.equal(settings.status, 1);
    assert.equal(settings.stderr, `sage board: the board config ${config} exists, and setup does not change it. To change its "port" or another setting, first run node ${CLI} board --stop --config ${config} while the file still names the port of the running board, then edit that file, then ask for the board again. To set the board up again, remove the file first.\n`);
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
    assert.equal(busy.stderr, `sage board: the board server is not running: another program answers on 127.0.0.1:${port}. Stop it, or set another "port" in ${config}.\n`);
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
    // A config written after the start, as --set-password writes it.
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
    // The order of the existing-config line: stop first, while the file still names the port that the board holds.
    const stopped = await board(CLI, ["--stop", "--config", config], env);
    assert.equal(stopped.stdout, `Board server stopped: 127.0.0.1:${oldPort} is free. Ask for the board again to start it.\n`, stopped.stderr);
    writeFileSync(config, JSON.stringify({ ...JSON.parse(readFileSync(config, "utf8")), port: newPort }));
    const again = await board(CLI, ["--ensure"], env);
    assert.equal(again.stdout.startsWith(`Sage board started: http://127.0.0.1:${newPort}/`), true, again.stderr);
    assert.equal((await get(oldPort)).error, "ECONNREFUSED", "the old board does not run on beside the new one");
    // board.pid names the one server that answers, so a later --stop finds it.
    const pid = readFileSync(join(dirname(config), "board.pid"), "utf8").trim();
    assert.match((await get(newPort)).board, new RegExp(`^id=${configId(config)}; pid=${pid}; started=\\d+$`));
  } finally { await stop(dir, oldPort); }
});

const listen = async (server) => { await new Promise((accept) => server.listen(0, "127.0.0.1", accept)); return server.address().port; };
const shut = async (server) => { server.closeAllConnections?.(); await new Promise((accept) => server.close(accept)); };
/** A board server from before this repair: it asks for a sign-in and does not name its config. */
const olderBoard = () => createHttpServer((request, response) => {
  response.writeHead(401, { "Content-Security-Policy": "default-src 'none'", "Cross-Origin-Resource-Policy": "same-origin", "WWW-Authenticate": 'Basic realm="Sage board", charset="UTF-8"' });
  response.end("Sign in to the Sage board.\n");
});

test("F-T229-32: after an upgrade, ensure asks for a restart of a board that started before the new code, not that phone access is off", async (t) => {
  const { dir, env, config } = scratch(t);
  const code = Math.max(...["cli.mjs", "server.mjs"].map((name) => statSync(join(dirname(CLI), name)).mtimeMs));
  // A board server of the older code: it names this config and started after the config, but before the code that runs ensure.
  let started = Math.floor(code - 10_000);
  const older = createHttpServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "default-src 'none'", "Cross-Origin-Resource-Policy": "same-origin", "X-Sage-Board": `id=${configId(config)}; pid=424242; started=${started}` });
    response.end();
  });
  const port = await listen(older);
  try {
    // An old-style config: a random secret and a phone host, as setup wrote it before T229. Sample values only.
    mkdirSync(dirname(config), { recursive: true });
    writeFileSync(config, JSON.stringify({ version: 1, sources: [{ id: "sample", path: join(dir, "logbooks") }], port, allowedHosts: ["sample.tailnet.ts.net"], secret: "sample-old-secret-sample-old-secret-sample-old" }));
    const written = new Date(code - 20_000); utimesSync(config, written, written);
    const found = await board(CLI, ["--ensure"], env);
    assert.equal(found.status, 0, found.stderr);
    assert.equal(found.stdout, `Sage board is running: http://127.0.0.1:${port}/, but the board command was updated after it started. Restart needed: run node ${CLI} board --stop then ask for the board again.\n`);
    // After the restart, a server of this code ignores the old secret: the line says that phone access is off, and asks no restart again.
    started = Date.now();
    const restarted = await board(CLI, ["--ensure"], env);
    assert.equal(restarted.stdout, `Sage board is running: http://127.0.0.1:${port}/ · no sign-in needed on this Mac. Phone access is off until you set a board password: run in a terminal on this Mac: node ${CLI} board --set-password\n`);
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
    // A board.pid may name any process: an older board does not name its own, so nothing proves that pid is the board.
    writeFileSync(join(dirname(config), "board.pid"), "424242\n");
    const signals = [], lines = [];
    await assert.rejects(runBoardCli(["board", "--stop"], { env, output: (line) => lines.push(line), kill: (...args) => signals.push(args) }), { message: olderLine(port) });
    assert.deepEqual(signals, [], "no signal to a process that the board does not name");
    assert.deepEqual(lines, []);
    assert.equal(await signIn(port, `127.0.0.1:${port}`), 401, "the older board still runs");
  } finally { await shut(older); }
  // A board server from 859df8d answers on the Mac without the X-Sage-Board header: it is older too.
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
    assert.equal(found.stderr, `sage board: the board does not answer: a program holds 127.0.0.1:${port} and gives no answer within 2 s. Stop it, or set another "port" in ${config}.\n`);
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
    assert.equal(found.stderr, `sage board: another board config holds 127.0.0.1:${port}. Stop it, or set another "port" in ${config}.\n`);
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
  // A folder at board.pid, with a file in it, makes the write fail after the listener opened.
  mkdirSync(join(dirname(config), "board.pid", "inside"), { recursive: true });
  const child = startBoard(CLI, ["board", "--serve"], env);
  let stderr = ""; child.stderr.on("data", (chunk) => { stderr += chunk; });
  try {
    // A generous deadlock guard, not a speed check: before the fix, the command kept listening and never exited.
    const status = await Promise.race([new Promise((done) => child.once("close", done)), new Promise((done) => setTimeout(done, 15_000, "still running").unref())]);
    assert.equal(status, 1, stderr);
    assert.match(stderr, /^sage board: /);
    assert.equal((await get(port)).error, "ECONNREFUSED");
  } finally { await closeChild(child); }
});

test("F-T216-13: the server writes board.pid as a new file, so a hard link at that name does not change the file it points to", async (t) => {
  const { dir, env, config } = scratch(t);
  const port = await freePort();
  createBoardConfig(config, { sources: [{ id: "sample", path: join(dir, "logbooks") }], port });
  const other = join(dir, "other.txt"), pidFile = join(dirname(config), "board.pid");
  writeFileSync(other, "sample text that stays\n");
  linkSync(other, pidFile);
  const server = await runBoardCli(["board", "--serve"], { env, output: () => {} });
  try {
    assert.equal(readFileSync(other, "utf8"), "sample text that stays\n");
    assert.equal(readFileSync(pidFile, "utf8"), `${process.pid}\n`);
    assert.deepEqual(readdirSync(dirname(config)).sort(), ["board.json", "board.pid"], "no temporary file is left");
  } finally { await server.close(); }
  assert.equal(existsSync(pidFile), false);
  assert.equal(readFileSync(other, "utf8"), "sample text that stays\n");
});

test("T216, T229: with allowedHosts and no password, phone access is off until the owner sets a password in a terminal", async (t) => {
  const { dir, env, config } = scratch(t);
  const port = await freePort();
  try {
    assert.equal((await board(CLI, ["--setup", "--port", String(port), "--allowed-hosts", JSON.stringify(["sample.tailnet.ts.net"])], env)).status, 0);
    const first = await board(PLUGIN_CLI, ["--ensure"], env);
    assert.equal(first.status, 0, first.stderr);
    const command = `node ${PLUGIN_CLI} board --set-password`;
    assert.equal(first.stdout, `Sage board started: http://127.0.0.1:${port}/ · no sign-in needed on this Mac. Phone access is off until you set a board password: run in a terminal on this Mac: ${command}\n`);
    // Through a tunnel, the board says that access is off.
    const tunnel = await new Promise((done) => {
      const req = request({ host: "127.0.0.1", port, path: "/", agent: false, headers: { Host: `127.0.0.1:${port}`, "X-Forwarded-For": "203.0.113.9" } }, (response) => {
        let body = ""; response.setEncoding("utf8"); response.on("data", (chunk) => { body += chunk; }); response.on("end", () => done({ status: response.statusCode, body }));
      });
      req.end();
    });
    // The remote text is fixed: no plugin path and no user name (F-T229-7). The exact command stays in the output above.
    assert.deepEqual(tunnel, { status: 403, body: "Access from outside this Mac is off until the owner sets a board password on the Mac.\n" });
    // The printed command as its words (no shell). From a pipe, as an agent would run it, it refuses.
    const [node, ...args] = command.split(" ");
    assert.equal(node, "node");
    const before = readFileSync(config, "utf8");
    const piped = spawn(process.execPath, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    piped.stdin.end("sample board pass 01\nsample board pass 01\n");
    let err = ""; piped.stderr.on("data", (chunk) => { err += chunk; });
    assert.equal(await new Promise((done) => piped.once("close", done)), 1);
    assert.equal(err, "sage board: board --set-password needs a terminal: open Terminal on this Mac and run the command there yourself. It does not read a password from a pipe, a file or an agent.\n");
    assert.equal(readFileSync(config, "utf8"), before, "the config did not change");
    // In a terminal (here an injected terminal check: a test has no terminal) it asks twice and sets the password.
    const lines = [];
    await runBoardCli(["board", "--set-password", "--config", config], { output: (line) => lines.push(line), input: typed(SAMPLE, SAMPLE), terminal: true, prompt: quiet });
    assert.deepEqual(lines, [`Board password set in ${config}. A board server that is already running keeps the old sign-in until it starts again.`]);
    assert.equal(readBoardConfig(config).password.scheme, "scrypt");
    const after = await board(PLUGIN_CLI, ["--ensure"], env);
    assert.match(after.stdout, /changed after it started\. Restart needed: run node \S+plugins\/sage\/board\/cli\.mjs board --stop then ask for the board again\.\n$/);
    await stop(dir, port);
    const again = await board(PLUGIN_CLI, ["--ensure"], env);
    assert.equal(again.stdout, `Sage board started: http://127.0.0.1:${port}/ · no sign-in needed on this Mac. On the phone, open https://sample.tailnet.ts.net/ and sign in as sage with your board password. To set a new password, run in a terminal: ${command}\n`);
  } finally { await stop(dir, port); }
});

test("T216: the board guide says that the Mac needs no sign-in, and gives ensure and the restart (F-T216-9)", () => {
  const guide = readFileSync(fileURLToPath(new URL("../packages/sage-board/README.md", import.meta.url)), "utf8");
  assert.doesNotMatch(guide, /Browser pages require a sign-in/);
  assert.match(guide, /On the Mac itself, browser pages need no sign-in/);
  assert.match(guide, /`board --ensure` does the first and the last step for you/);
  assert.match(guide, /node <path to board\/cli\.mjs> board --stop/);
  // F-T216-18: the login service runs --serve too, so its board writes board.pid.
  assert.doesNotMatch(guide, /login service started has no `board\.pid`/);
  assert.match(guide, /The login service runs the same `--serve` command, so its board writes `board\.pid` too/);
  // F-T216-15, T229: a raw TCP forward has no proxy header, so the guide says plainly that it bypasses the sign-in.
  assert.match(guide, /A raw TCP forward is not supported: it bypasses the sign-in\. Such a forward \(`ssh -L`, `socat`, `tailscale serve --tcp`/);
  assert.match(guide, /An SSH tunnel is a raw TCP forward of this kind\./);
  // T229: a private HTTPS tunnel of any vendor; tailscale serve is one example, and no vendor header is a proxy sign.
  assert.match(guide, /only through a private HTTPS tunnel that forwards to `http:\/\/127\.0\.0\.1:43123` and adds an `X-Forwarded-For` header\. The board does not depend on one tunnel tool\. One example is Tailscale Serve/);
  assert.doesNotMatch(guide, /Tailscale-\*|"secret" value|Until you set one, the password is the `secret`/);
  // F-T229-8: the guide does not claim that the terminal check or the hook stops every agent; it names the sandbox.
  assert.doesNotMatch(guide, /so a pipe, a script or an agent cannot set the password/);
  assert.match(guide, /The terminal check accepts any pseudo-terminal, so it alone does not stop an agent\./);
  assert.match(guide, /An agent runs as your own user, so a script that builds the command or the path while it runs can still pass the hook\. Full protection needs the sandbox \(tasks T97 to T99\)\./);
  // F-T229-7: the remote 403 text names no path.
  assert.match(guide, /The text names no path; the exact command is only in the output of `board --ensure` on the Mac\./);
  // F-T216-16: an older board is stopped where it started, not with --stop.
  assert.match(guide, /`--stop` sends it no signal, whatever `board\.pid` holds/);
});

/** The words of one README command line, as a shell would pass them: quotes, \" inside double quotes, and $HOME. Never run by a shell. */
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
  // The guide uses the default port; the test moves it to a free port, so it never touches a running board.
  const config = join(home, ".config", "sage-board", "board.json"), port = await freePort();
  writeFileSync(config, JSON.stringify({ ...JSON.parse(readFileSync(config, "utf8")), port }));
  const child = startBoard(serve[1], serve.slice(2), env, join(plugin, "board"));
  try {
    let stdout = "";
    // A generous deadlock guard, not a speed check.
    const line = await new Promise((done, fail) => {
      const timer = setTimeout(() => fail(new Error(`no serve line: ${stdout}`)), 15_000);
      child.stdout.on("data", (chunk) => { stdout += chunk; if (stdout.includes("\n")) { clearTimeout(timer); done(stdout); } });
      child.once("close", (status) => { clearTimeout(timer); fail(new Error(`serve exited with ${status}`)); });
    });
    assert.equal(line, `Sage board: http://127.0.0.1:${port}/ · no sign-in needed on this Mac.\n`);
    assert.equal((await get(port)).status, 200);
  } finally {
    await closeChild(child);
  }
});

// Sample passwords only: none is a real password.
const SAMPLE = "sample board pass 01", OTHER = "sample board pass 02";
const quiet = new Writable({ write(_chunk, _encoding, done) { done(); } });
const typed = (...lines) => Readable.from([lines.map((line) => `${line}\n`).join("")]);
const signIn = (port, host, user, password) => new Promise((done) => {
  const headers = { Host: host, ...(password === undefined ? {} : { Authorization: `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}` }) };
  const req = request({ host: "127.0.0.1", port, path: "/", method: "HEAD", agent: false, headers }, (response) => { response.resume(); done(response.statusCode); });
  req.once("error", (error) => done(error.code));
  req.end();
});

test("T216, T229: --set-password keeps only a salted scrypt hash and drops an old secret; the old secret never signs in", async (t) => {
  const { dir, config } = scratch(t);
  const tailnet = "sample.tailnet.ts.net", port = await freePort();
  // A config from before T229, with its random secret: it still loads.
  const secret = "sampleOldSecretSampleOldSecretSampleOldSecr";
  mkdirSync(dirname(config), { recursive: true });
  writeFileSync(config, `${JSON.stringify({ version: 1, sources: [{ id: "sample", path: join(dir, "logbooks") }], port, allowedHosts: [tailnet], secret })}\n`, { mode: 0o600 });
  let server = createBoardServer(readBoardConfig(config));
  try {
    await server.start();
    assert.equal(await signIn(port, tailnet, "sage", secret), 403, "the old secret no longer signs in: there is no password yet");
    assert.equal(await signIn(port, tailnet, "sage", SAMPLE), 403);
    assert.equal(await signIn(port, `127.0.0.1:${port}`, "sage", undefined), 200, "the Mac needs no sign-in");
  } finally { await server.close(); }
  const lines = [];
  await runBoardCli(["board", "--set-password", "--config", config], { output: (line) => lines.push(line), input: typed(SAMPLE, SAMPLE), terminal: true, prompt: quiet });
  assert.deepEqual(lines, [`Board password set in ${config}. A board server that is already running keeps the old sign-in until it starts again.`]);
  const text = readFileSync(config, "utf8"), saved = JSON.parse(text);
  assert.ok(!text.includes(SAMPLE), "the password itself is not in the file");
  assert.equal(saved.secret, undefined, "the plain secret is gone");
  assert.deepEqual(Object.keys(saved.password).sort(), ["N", "hash", "p", "r", "salt", "scheme"]);
  assert.equal(saved.password.scheme, "scrypt");
  assert.equal(Buffer.from(saved.password.hash, "base64url").length, 32);
  assert.equal(statSync(config).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(dirname(config)), ["board.json"], "no temporary file is left");
  server = createBoardServer(readBoardConfig(config));
  try {
    await server.start();
    assert.equal(await signIn(port, tailnet, "sage", SAMPLE), 200, "the right password gets in");
    assert.equal(await signIn(port, tailnet, "sage", SAMPLE), 200, "and again");
    assert.equal(await signIn(port, tailnet, "sage", OTHER), 401, "a wrong password does not");
    assert.equal(await signIn(port, tailnet, "other", SAMPLE), 401, "nor another user");
    assert.equal(await signIn(port, tailnet, "sage", secret), 401, "nor the old secret");
    assert.equal(await signIn(port, tailnet, "sage", undefined), 401);
    assert.equal(await signIn(port, `127.0.0.1:${port}`, "sage", undefined), 200, "on the Mac no sign-in is needed");
  } finally { await server.close(); }
  // A second password replaces the first.
  await runBoardCli(["board", "--set-password", "--config", config], { output: () => {}, input: typed(OTHER, OTHER), terminal: true, prompt: quiet });
  assert.notEqual(JSON.parse(readFileSync(config, "utf8")).password.salt, saved.password.salt);
});

test("T216: --set-password refuses an empty, short or mismatched entry and leaves the config as it was", async (t) => {
  const { dir, config } = scratch(t);
  createBoardConfig(config, { sources: [{ id: "sample", path: join(dir, "logbooks") }] });
  const before = readFileSync(config, "utf8");
  for (const [entries, reason] of [[[], /no password entered/], [[""], /no password entered/], [["short pass1", "short pass1"], /12 characters or more/], [[SAMPLE, OTHER], /the two entries differ/], [[SAMPLE], /the two entries differ/]]) {
    await assert.rejects(runBoardCli(["board", "--set-password", "--config", config], { output: () => {}, input: typed(...entries), terminal: true, prompt: quiet }), reason);
    assert.equal(readFileSync(config, "utf8"), before);
  }
  await assert.rejects(runBoardCli(["board", "--set-password", SAMPLE, "--config", config], { output: () => {}, input: typed(SAMPLE, SAMPLE), terminal: true, prompt: quiet }), /set-password takes only --config/);
  assert.equal(readFileSync(config, "utf8"), before, "a password given as an argument is refused, never saved");
  // T229: an input that is not a terminal (a pipe, a file, an agent's command) is refused before any prompt.
  const asked = [];
  const prompt = new Writable({ write(chunk, _encoding, done) { asked.push(String(chunk)); done(); } });
  await assert.rejects(runBoardCli(["board", "--set-password", "--config", config], { output: () => {}, input: typed(SAMPLE, SAMPLE), prompt }), { message: "board --set-password needs a terminal: open Terminal on this Mac and run the command there yourself. It does not read a password from a pipe, a file or an agent." });
  assert.deepEqual(asked, [], "it asks nothing");
  assert.equal(readFileSync(config, "utf8"), before);
});

test("T216: the plugin carries the board command that the hook's note names, and it runs outside the checkout layout", async (t) => {
  const { env } = scratch(t);
  const made = await board(PLUGIN_CLI, ["--setup"], env);
  assert.equal(made.status, 0, made.stderr);
  const status = await board(PLUGIN_CLI, ["all", "--status"], env);
  assert.equal(status.status, 0, status.stderr);
});

// Deterministic teardown proof: the descendant cannot exit until the test closes its input pipe.
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
    // A deadlock guard, not a speed requirement.
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
