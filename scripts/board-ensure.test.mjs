// T216: the board phrase starts the local board server. These tests run the board command as the chief does, with a
// scratch HOME and a random free port; each server that a test starts stops in its finally block.
import "./test-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { createServer as createHttpServer, request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { createBoardConfig, readBoardConfig, runBoardCli } from "../packages/sage-board/cli.mjs";
import { createBoardServer } from "../packages/sage-board/server.mjs";

const CLI = fileURLToPath(new URL("../packages/sage-board/cli.mjs", import.meta.url));
const PLUGIN_CLI = fileURLToPath(new URL("../plugins/sage/board/cli.mjs", import.meta.url));

function scratch(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "sage-board-ensure-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env, HOME: join(dir, "home") };
  delete env.CODEX_HOME; // test-env.mjs removes CLAUDE_*; the Codex root must come from HOME too
  return { dir, env, config: join(dir, "home", ".config", "sage-board", "board.json") };
}

/** Run the board command; it resolves when the command exits, also when it left a detached server behind. */
function board(cli, args, env) {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [cli, "board", ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", fail);
    child.once("close", (status) => done({ status, stdout, stderr }));
  });
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
    response.on("end", () => done({ status: response.statusCode, body }));
  });
  req.once("error", (error) => done({ error: error.code }));
  req.end();
});

/** Stop the server that the test started: by the pid that the board command wrote for it, then wait until the port is free. */
async function stop(dir, port) {
  const file = join(dir, "home", ".config", "sage-board", "board.pid");
  if (!existsSync(file)) return;
  const pid = Number(readFileSync(file, "utf8"));
  if (!Number.isInteger(pid) || pid <= 1) return;
  try { process.kill(pid, "SIGTERM"); } catch {}
  // A wide guard for a busy Mac, not a speed check: the server closes in milliseconds.
  for (const end = Date.now() + 15_000; Date.now() < end && !(await get(port)).error;) await new Promise((wake) => setTimeout(wake, 50));
}

test("T216: setup without --sources lists the standard Claude and Codex roots of the current user, also when they are missing", async (t) => {
  const { dir, env, config } = scratch(t);
  const made = await board(CLI, ["--setup"], env);
  assert.equal(made.status, 0, made.stderr);
  assert.equal(made.stdout, `Board config created: ${config}. The phone sign-in password stays in this private file; set your own with board --set-password.\n`);
  const written = JSON.parse(readFileSync(config, "utf8"));
  assert.deepEqual(written.sources, [
    { id: "claude", label: "Claude", provider: "claude", path: join(dir, "home", ".claude", "sage") },
    { id: "codex", label: "Codex", provider: "codex", path: join(dir, "home", ".codex", "sage") },
  ]);
  assert.equal(written.port, 43123);
  assert.match(written.secret, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(statSync(config).mode & 0o777, 0o600);
  assert.ok(!made.stdout.includes(written.secret));
  // The provider variables move the roots, as they move each provider's state tool.
  const moved = { ...env, CLAUDE_CONFIG_DIR: join(dir, "claude-config"), CODEX_HOME: join(dir, "codex-home") };
  const other = join(dir, "other", "board.json");
  assert.equal((await board(CLI, ["--setup", "--config", other], moved)).status, 0);
  assert.deepEqual(JSON.parse(readFileSync(other, "utf8")).sources.map((source) => source.path), [join(dir, "claude-config", "sage"), join(dir, "codex-home", "sage")]);
  // --sources still works, and a second setup never replaces a config.
  const explicit = join(dir, "explicit", "board.json");
  assert.equal((await board(CLI, ["--setup", "--config", explicit, "--sources", JSON.stringify([{ id: "one", path: join(dir, "one") }])], env)).status, 0);
  assert.deepEqual(JSON.parse(readFileSync(explicit, "utf8")).sources, [{ id: "one", path: join(dir, "one") }]);
  const again = await board(CLI, ["--setup"], env);
  assert.equal(again.status, 1);
  assert.equal(JSON.parse(readFileSync(config, "utf8")).secret, written.secret);
});

test("T216: ensure sets the board up, starts one detached server, and leaves a running server as it is", async (t) => {
  const { dir, env, config } = scratch(t);
  const port = await freePort();
  try {
    const first = await board(CLI, ["--ensure", "--port", String(port)], env);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(first.stdout, `Sage board started: http://127.0.0.1:${port}/ · no sign-in needed on this Mac. On the phone, sign in as sage with the "secret" value in ${config}, or set your own password in a terminal with board --set-password.\n`);
    const { secret, sources } = JSON.parse(readFileSync(config, "utf8"));
    assert.deepEqual(sources.map((source) => source.id), ["claude", "codex"]);
    const page = await get(port);
    assert.equal(page.status, 200);
    assert.match(page.body, /<html/);
    const pidFile = join(dir, "home", ".config", "sage-board", "board.pid"), log = join(dir, "home", ".config", "sage-board", "board.log");
    const pid = readFileSync(pidFile, "utf8");
    assert.match(pid, /^[1-9]\d*\n$/);
    assert.equal(statSync(log).mode & 0o777, 0o600);
    const second = await board(CLI, ["--ensure"], env);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(second.stdout, `Sage board is running: http://127.0.0.1:${port}/ · no sign-in needed on this Mac. On the phone, sign in as sage with the "secret" value in ${config}, or set your own password in a terminal with board --set-password.\n`);
    assert.equal(readFileSync(pidFile, "utf8"), pid, "no second server started");
    // The config exists, so a setup setting is refused rather than ignored.
    const settings = await board(CLI, ["--ensure", "--port", String(port)], env);
    assert.equal(settings.status, 1);
    assert.match(settings.stderr, /the board config exists/);
    for (const text of [first.stdout, first.stderr, second.stdout, second.stderr, settings.stderr, readFileSync(log, "utf8")]) assert.ok(!text.includes(secret));
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

test("T216: --set-password keeps only a salted scrypt hash, replaces the secret, and the server checks the sign-in against it", async (t) => {
  const { dir, config } = scratch(t);
  const tailnet = "sample.tailnet.ts.net", port = await freePort();
  createBoardConfig(config, { sources: [{ id: "sample", path: join(dir, "logbooks") }], port, allowedHosts: [tailnet] });
  const { secret } = readBoardConfig(config);
  let server = createBoardServer(readBoardConfig(config));
  try {
    await server.start();
    assert.equal(await signIn(port, tailnet, "sage", secret), 200, "a config with the old secret still signs in");
    assert.equal(await signIn(port, tailnet, "sage", SAMPLE), 401);
  } finally { await server.close(); }
  const lines = [];
  await runBoardCli(["board", "--set-password", "--config", config], { output: (line) => lines.push(line), input: typed(SAMPLE, SAMPLE), prompt: quiet });
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
  await runBoardCli(["board", "--set-password", "--config", config], { output: () => {}, input: typed(OTHER, OTHER), prompt: quiet });
  assert.notEqual(JSON.parse(readFileSync(config, "utf8")).password.salt, saved.password.salt);
});

test("T216: --set-password refuses an empty, short or mismatched entry and leaves the config as it was", async (t) => {
  const { dir, config } = scratch(t);
  createBoardConfig(config, { sources: [{ id: "sample", path: join(dir, "logbooks") }] });
  const before = readFileSync(config, "utf8");
  for (const [entries, reason] of [[[], /no password entered/], [[""], /no password entered/], [["short pass1", "short pass1"], /12 characters or more/], [[SAMPLE, OTHER], /the two entries differ/], [[SAMPLE], /the two entries differ/]]) {
    await assert.rejects(runBoardCli(["board", "--set-password", "--config", config], { output: () => {}, input: typed(...entries), prompt: quiet }), reason);
    assert.equal(readFileSync(config, "utf8"), before);
  }
  await assert.rejects(runBoardCli(["board", "--set-password", SAMPLE, "--config", config], { output: () => {}, input: typed(SAMPLE, SAMPLE), prompt: quiet }), /set-password takes only --config/);
  assert.equal(readFileSync(config, "utf8"), before, "a password given as an argument is refused, never saved");
});

test("T216: the plugin carries the board command that the hook's note names, and it runs outside the checkout layout", async (t) => {
  const { env } = scratch(t);
  const made = await board(PLUGIN_CLI, ["--setup"], env);
  assert.equal(made.status, 0, made.stderr);
  const status = await board(PLUGIN_CLI, ["all", "--status"], env);
  assert.equal(status.status, 0, status.stderr);
});
