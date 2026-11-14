import "./test-env.mjs";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { hostname, tmpdir, uptime } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as claude from "../plugins/sage/skills/sage/sage.mjs";
import { runBoardCli } from "../plugins/sage/board/cli.mjs";
import { createBoardServer, loadBoardApp } from "../plugins/sage/board/server.mjs";

const APP = loadBoardApp(new URL("../plugins/sage/board/app/", import.meta.url).pathname);
const CLI = new URL("../plugins/sage/board/cli.mjs", import.meta.url).pathname, TEST_CHILD = new URL("./board-test-child.mjs", import.meta.url).pathname;
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };

async function freePort() {
  const socket = createServer();
  await new Promise((accept, reject) => { socket.once("error", reject); socket.listen(0, "127.0.0.1", accept); });
  const { port } = socket.address();
  await new Promise(accept => socket.close(accept));
  return port;
}

function call(port, path, { method = "POST", headers = {}, body } = {}) {
  return new Promise((accept, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, agent: false, headers: { Host: `127.0.0.1:${port}`, ...headers } }, response => {
      const parts = [];
      response.on("data", part => parts.push(part));
      response.on("end", () => {
        const text = Buffer.concat(parts).toString("utf8");
        let json = null;
        try { json = JSON.parse(text); } catch {}
        accept({ status: response.statusCode, headers: response.headers, text, json });
      });
    });
    req.once("error", reject);
    if (body !== undefined) req.write(typeof body === "string" ? body : JSON.stringify(body));
    req.end();
  });
}

async function board(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "sage-board-writes-")));
  const saved = { ...process.env };
  t.after(async () => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    rmSync(base, { recursive: true, force: true });
  });
  const fakes = join(base, "fakes");
  mkdirSync(fakes);
  for (const name of ["gh", "ps", "kill"]) { writeFileSync(join(fakes, name), `#!/bin/sh\necho fake-${name} >&2\nexit 1\n`); chmodSync(join(fakes, name), 0o755); }
  const env = { PATH: `${fakes}:/usr/bin:/bin`, HOME: join(base, "home"), CLAUDE_CONFIG_DIR: join(base, "claude"), CODEX_HOME: join(base, "codex"), SAGE_SHARED_HOME: join(base, "shared"),
    SAGE_HOOKS_STATE: join(base, "hook-state"), SAGE_WORKTREES: join(base, "worktrees"), SAGE_TEST_PIDS: "{}", SAGE_TEST_MACHINE_ID: "test-machine", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  Object.assign(process.env, env);
  const project = join(base, "project");
  mkdirSync(project);
  execFileSync("git", ["init", "-q", "-b", "main", project]);
  execFileSync("git", ["-C", project, "commit", "-q", "--allow-empty", "-m", "first"], { env: gitEnv });
  claude.sage(["link", "--separate", "--project", project], env);
  const dir = claude.storeDir(project, env);
  writeFileSync(join(dir, "chiefs.tsv"), `id\tprovider\tnative\tat\nC1\tclaude\tclaude-1\t${new Date().toISOString()}\nC2\tcodex\tcodex-1\t${new Date().toISOString()}\n`);
  const as = (...args) => claude.sage([...args, "--project", project, "--chief", "C1"], env);
  as("task", "add", "--title", "Sample share sheet", "--size", "small", "--priority", "P1");
  as("gate", "add", "T1", "--question", "Can a viewer copy a shared list?", "--options", "yes|no", "--recommend", "yes");
  const config = join(base, "home", ".config", "sage-board", "board.json");
  const port = await freePort();
  await runBoardCli(["board", "--setup", "--config", config, "--port", String(port), "--sources", JSON.stringify([{ id: "shared", path: env.SAGE_SHARED_HOME }])], { output: () => {}, env });
  const stateDir = join(base, "home", ".config", "sage-board", "state");
  const server = createBoardServer({ sources: [{ id: "shared", label: "Shared", path: env.SAGE_SHARED_HOME }], port, app: APP, settleReads: [], stateDir });
  await server.start();
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${port}`;
  const own = { Origin: origin, "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json" };
  const logbook = `shared/${dir.split("/").at(-1)}`;
  const gates = () => readFileSync(join(dir, "gates.tsv"), "utf8");
  const gate = id => claude.read(dir, "gates").find(row => row.id === id);
  return { base, env, project, dir, config, stateDir, port, origin, own, logbook, gates, gate, as, server };
}

async function pair(w) {
  const lines = [];
  await runBoardCli(["board", "--pair", "--config", w.config], { output: line => lines.push(line), env: w.env, input: { isTTY: true } });
  const code = /Pairing code: ([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(lines.join("\n"))[1];
  const paired = await call(w.port, "/api/pair", { headers: w.own, body: { code } });
  assert.equal(paired.status, 200, paired.text);
  const cookie = paired.headers["set-cookie"][0].split(";")[0];
  return { code, cookie, token: paired.json.token, headers: { ...w.own, Cookie: cookie, "X-Sage-Token": paired.json.token } };
}

async function waitFor(check, what) {
  for (const end = Date.now() + 10_000; Date.now() < end; await new Promise(wake => setTimeout(wake, 50))) if (await check()) return;
  assert.fail(`timed out: ${what}`);
}
async function needs(w) {
  const shell = await call(w.port, "/app/", { method: "GET" });
  assert.equal(shell.status, 200);
  return new Promise((accept, reject) => {
    const req = request({ host: "127.0.0.1", port: w.port, path: "/app/events", agent: false, headers: { Host: `127.0.0.1:${w.port}` } }, response => {
      let text = "";
      response.on("data", part => {
        text += part;
        const data = /event: model\ndata: (.*)\n\n/.exec(text);
        if (data) { req.destroy(); accept(JSON.parse(data[1])); }
      });
    });
    req.once("error", reject);
    req.end();
  });
}

test("board --pair refuses input that is not a terminal, prints a one-time code in a terminal, and keeps only hashes in the board's state folder", async t => {
  const w = await board(t);
  await assert.rejects(runBoardCli(["board", "--pair", "--config", w.config], { output: () => {}, env: w.env, input: { isTTY: false } }), /board --pair runs only in Terminal/);
  assert.equal(existsSync(join(w.stateDir, "pair-code.json")), false, "a refused pairing writes nothing");
  const lines = [];
  await runBoardCli(["board", "--pair", "--config", w.config], { output: line => lines.push(line), env: w.env, input: { isTTY: true } });
  const code = /Pairing code: ([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(lines.join("\n"))?.[1];
  assert.ok(code, lines.join("\n"));
  const kept = () => readdirSync(w.stateDir).map(name => readFileSync(join(w.stateDir, name), "utf8")).join("\n");
  assert.ok(!kept().includes(code) && !kept().includes(code.replace("-", "")), "the code itself is not kept");

  for (let i = 0; i < 4; i++) assert.equal((await call(w.port, "/api/pair", { headers: w.own, body: { code: "AAAA-AAAA" } })).status, 403);
  const right = await call(w.port, "/api/pair", { headers: w.own, body: { code } });
  assert.equal(right.status, 200, "four wrong tries leave the code working");
  const cookie = right.headers["set-cookie"]?.[0] ?? "";
  assert.match(cookie, /^sage_board=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=\/; Max-Age=31536000$/);
  const value = cookie.split(";")[0].slice("sage_board=".length);
  assert.ok(!kept().includes(value), "only the cookie's hash is kept");
  assert.equal((await call(w.port, "/api/pair", { headers: w.own, body: { code } })).status, 403, "a code works once");

  assert.match(right.json.token, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(!kept().includes(right.json.token), "only the token's hash is kept");
  const shell = await call(w.port, "/app/", { method: "GET", headers: { Cookie: `sage_board=${value}` } });
  assert.equal(shell.status, 200);
  assert.ok(!shell.text.includes(right.json.token), "F-T1059-13: the page that the cookie opens does not carry the token");

  await runBoardCli(["board", "--pair", "--config", w.config], { output: () => {}, env: w.env, input: { isTTY: true } });
  for (let i = 0; i < 5; i++) await call(w.port, "/api/pair", { headers: w.own, body: { code: "AAAA-AAAA" } });
  assert.equal(existsSync(join(w.stateDir, "pair-code.json")) ? JSON.parse(readFileSync(join(w.stateDir, "pair-code.json"), "utf8")).tries : 5, 5, "five wrong tries spend a code");
});

test("F-T1059-13: the pairing cookie alone writes nothing: a server on another port that got it reads /app/ and forges the headers from node http", async t => {
  const w = await board(t), p = await pair(w), before = w.gates();
  const open = await needs(w), need = open.needs.find(item => item.gate === "G1");
  const page = await call(w.port, "/app/", { method: "GET", headers: { Cookie: p.cookie } });
  const token = /name="sage-token" content="([^"]*)"/.exec(page.text)?.[1] ?? "";
  const forged = await call(w.port, "/api/answer", { headers: { ...w.own, Cookie: p.cookie, "X-Sage-Token": token }, body: { logbook: w.logbook, gate: "G1", option: 1, digest: need.digest } });
  assert.equal(forged.status, 403, forged.text);
  assert.match(forged.json.problem, /pair/i, "the refusal says to pair again");
  assert.equal(w.gates(), before, "the forged write changed nothing");
  const own = await call(w.port, "/api/answer", { headers: p.headers, body: { logbook: w.logbook, gate: "G1", option: 1, digest: need.digest } });
  assert.equal(own.status, 200, `the paired browser, with its token, still writes: ${own.text}`);
  const other = await pair(w);
  assert.equal((await call(w.port, "/api/seen", { headers: { ...other.headers, "X-Sage-Token": p.token }, body: {} })).status, 403, "a token works only with the cookie of the same browser");
});

test("every forged write is refused before it reaches the logbook: a plain curl, another port, a sandboxed /pages page, a cross-site form, no cookie, no token", async t => {
  const w = await board(t), p = await pair(w), before = w.gates();
  const body = { logbook: w.logbook, gate: "G1", option: 1, digest: "0".repeat(16) };
  const cases = [
    ["a plain curl: no Origin", { "Content-Type": "application/json", Cookie: p.cookie, "X-Sage-Token": p.token }, 403],
    ["a page on another port", { ...p.headers, Origin: `http://127.0.0.1:${w.port + 1}`, "Sec-Fetch-Site": "same-site" }, 403],
    ["another port that claims same-origin", { ...p.headers, Origin: `http://127.0.0.1:${w.port + 1}` }, 403],
    ["a /pages page that runs scripts: Origin null", { ...p.headers, Origin: "null" }, 403],
    ["a cross-site fetch", { ...p.headers, "Sec-Fetch-Site": "cross-site" }, 403],
    ["no fetch metadata", { ...p.headers, "Sec-Fetch-Site": undefined }, 403],
    ["a form post", { ...p.headers, "Content-Type": "application/x-www-form-urlencoded" }, 415],
    ["text/plain", { ...p.headers, "Content-Type": "text/plain" }, 415],
    ["no cookie", { ...w.own, "X-Sage-Token": p.token }, 401],
    ["a cookie that was never paired", { ...p.headers, Cookie: `sage_board=${"A".repeat(43)}` }, 401],
    ["no token", { ...p.headers, "X-Sage-Token": undefined }, 403],
    ["a wrong token", { ...p.headers, "X-Sage-Token": "x".repeat(43) }, 403],
  ];
  for (const [what, headers, status] of cases) {
    const clean = Object.fromEntries(Object.entries(headers).filter(([, value]) => value !== undefined));
    const got = await call(w.port, "/api/answer", { headers: clean, body });
    assert.equal(got.status, status, `${what}: ${got.text}`);
    assert.equal(got.headers["access-control-allow-origin"], undefined, what);
  }
  const preflight = await call(w.port, "/api/answer", { method: "OPTIONS", headers: { Origin: `http://127.0.0.1:${w.port + 1}`, "Access-Control-Request-Method": "POST" } });
  assert.equal(preflight.status, 403, "the server answers no CORS preflight");
  assert.equal(preflight.headers["access-control-allow-origin"], undefined);
  const get = await call(w.port, "/api/answer", { method: "GET", headers: p.headers });
  assert.equal(get.status, 405);
  assert.equal(w.gates(), before, "no forged write changed the logbook");
});

test("the owner answers, undoes and answers again from the board; a changed question and an earlier chat answer are refused, and each refusal names why", async t => {
  const w = await board(t), p = await pair(w);
  const open = await needs(w);
  assert.match(open.tasks.find(task => task.id === "T1").addedAt, /^\d{4}-\d\d-\d\dT/, "task add keeps the time when the task was added");
  assert.equal(open.counts.added, 1, "New tasks has a basis");
  const need = open.needs.find(item => item.gate === "G1");
  assert.deepEqual([need.logbook, need.options, need.owner, typeof need.digest], [w.logbook, ["yes", "no"], "C1", "string"]);

  const stale = await call(w.port, "/api/answer", { headers: p.headers, body: { logbook: w.logbook, gate: "G1", option: 2, digest: "f".repeat(16) } });
  assert.equal(stale.status, 409);
  assert.match(stale.json.text, /^G1 changed after the owner read it/);
  assert.equal(w.gate("G1").answered ?? "", "", "a refused answer writes nothing");

  const sent = await call(w.port, "/api/answer", { headers: p.headers, body: { logbook: w.logbook, gate: "G1", option: 2, digest: need.digest } });
  assert.equal(sent.status, 200, sent.text);
  assert.match(sent.json.text, /^G1 recorded · no · from the board, at .*sage gate undo G1 takes it back\.$/);
  assert.equal(JSON.parse(w.gate("G1").answered).via, "board");
  assert.equal(w.gate("G1").answer, "", "a board answer only records: the chief applies it at pickup");
  await waitFor(async () => (await needs(w)).answered.some(item => item.gateId === "G1"), "the model lists the pending answer");
  const after = await needs(w);
  assert.equal(after.needs.some(item => item.gate === "G1"), false, "F-T1059-9: a pending board answer is not a question that needs you");
  assert.equal(after.answered.find(item => item.gateId === "G1").answer, "no");
  assert.match(claude.sage(["status", "--project", w.project], w.env), /gates {3}0 open · 1 answered on the board, not picked up yet · G1 .* \(board answer: no\)/);

  const undo = await call(w.port, "/api/undo", { headers: p.headers, body: { logbook: w.logbook, gate: "G1" } });
  assert.equal(undo.status, 200, undo.text);
  assert.match(undo.json.text, /^G1 undone/);
  assert.equal(w.gate("G1").answered ?? "", "");

  claude.sage(["gate", "answer", "G1", "--option", "1", "--via", "chat", "--project", w.project], w.env);
  const late = await call(w.port, "/api/answer", { headers: p.headers, body: { logbook: w.logbook, gate: "G1", option: 2, digest: need.digest } });
  assert.equal(late.status, 409);
  assert.match(late.json.text, /^G1 has the answer "yes" already, from the chat at .*: the first answer wins, so this answer is not recorded\./);
  const detail = await call(w.port, `/app/gate/${Buffer.from(`${w.logbook}/G1`).toString("base64url")}`, { method: "GET" });
  await waitFor(async () => (await call(w.port, `/app/gate/${Buffer.from(`${w.logbook}/G1`).toString("base64url")}`, { method: "GET" })).json?.answer === "yes", "the gate detail shows the chat answer");
  assert.equal(detail.status, 200);
});

test("the owner renames a chief, gives a task to another chief, and the last visit comes back from the board's state folder", async t => {
  const w = await board(t), p = await pair(w);
  const named = await call(w.port, "/api/name", { headers: p.headers, body: { logbook: w.logbook, chief: "C2", name: "Codex desk" } });
  assert.equal(named.status, 200, named.text);
  assert.deepEqual(JSON.parse(readFileSync(join(w.dir, "chief-names.json"), "utf8")), { C2: "Codex desk" });
  for (const name of ["--via board", "-dash", " -x"]) {
    const bad = await call(w.port, "/api/name", { headers: p.headers, body: { logbook: w.logbook, chief: "C2", name } });
    assert.equal(bad.status, 400, `a name that reads as an option is refused before the state tool: ${name}`);
    assert.match(bad.json.problem, /cannot start with "-"/, "F-T1059-24: the refusal names the real reason");
  }
  assert.deepEqual(JSON.parse(readFileSync(join(w.dir, "chief-names.json"), "utf8")), { C2: "Codex desk" });

  const given = await call(w.port, "/api/give", { headers: p.headers, body: { logbook: w.logbook, task: "T1", to: "C2" } });
  assert.equal(given.status, 200, given.text);
  assert.match(given.json.text, /^G2 open · Hand T1 from C1 \(claude\) to C2 \(codex\)\?/);
  assert.equal(claude.read(w.dir, "tasks").find(row => row.id === "T1").chief, "C1", "giving only opens the takeover question: nothing moves before the owner's answer");

  const first = await call(w.port, "/api/seen", { headers: p.headers, body: {} });
  assert.deepEqual(first.json, { previous: null });
  const second = await call(w.port, "/api/seen", { headers: p.headers, body: {} });
  assert.match(second.json.previous, /^\d{4}-\d\d-\d\dT/);
  assert.ok(JSON.parse(readFileSync(join(w.stateDir, "seen.json"), "utf8")).at >= second.json.previous, "seen.json keeps the newest visit");

  const elsewhere = await call(w.port, "/api/give", { headers: p.headers, body: { logbook: "shared/other-abcdef", task: "T1", to: "C2" } });
  assert.equal(elsewhere.status, 409, "a logbook with no checkout on this Mac is refused");
});

test("F-T1059-25: a last visit in the future (a clock set back, a hand-edited file) counts as no earlier visit", async t => {
  const w = await board(t), p = await pair(w);
  mkdirSync(w.stateDir, { recursive: true });
  writeFileSync(join(w.stateDir, "seen.json"), JSON.stringify({ at: new Date(Date.now() + 86_400_000).toISOString() }));
  assert.deepEqual((await call(w.port, "/api/seen", { headers: p.headers, body: {} })).json, { previous: null });
  assert.match((await call(w.port, "/api/seen", { headers: p.headers, body: {} })).json.previous, /^\d{4}-\d\d-\d\dT/, "the visit is recorded, so the next look has an earlier visit");
});

test("the state tool's lock never runs on the server's event thread: a read answers while a write waits for the lock", async t => {
  const w = await board(t), p = await pair(w);
  const open = await needs(w), need = open.needs.find(item => item.gate === "G1");
  const lock = join(w.dir, ".lock");
  mkdirSync(lock);
  writeFileSync(join(lock, "00000000-0000-4000-8000-000000000000.json"), JSON.stringify({ pid: 424242, host: hostname(), machineId: "test-machine", boot: Date.now() - uptime() * 1000, start: 0, at: Date.now() }));
  const started = Date.now();
  let wrote = null;
  const write = call(w.port, "/api/answer", { headers: p.headers, body: { logbook: w.logbook, gate: "G1", option: 1, digest: need.digest } }).then(result => { wrote = Date.now(); return result; });
  await new Promise(wake => setTimeout(wake, 300));
  const read = await call(w.port, "/app/", { method: "GET" });
  const readAt = Date.now();
  assert.equal(read.status, 200);
  const result = await write;
  assert.equal(result.status, 409);
  assert.match(result.json.text, /the logbook is busy/);
  assert.ok(readAt < wrote, `the read (${readAt - started} ms) answered before the write that waited for the lock (${wrote - started} ms)`);
  rmSync(lock, { recursive: true, force: true });
});

test("F-T1059-52, F-T1059-28: the real board process answers a clear 500 and stays up when its state folder cannot be written or paired.json is a symlink", async t => {
  const w = await board(t);
  const config = join(w.base, "serve", "board.json"), stateDir = join(w.base, "serve", "state"), port = await freePort();
  await runBoardCli(["board", "--setup", "--config", config, "--port", String(port), "--sources", JSON.stringify([{ id: "shared", path: w.env.SAGE_SHARED_HOME }])], { output: () => {}, env: w.env });
  const child = spawn(process.execPath, [TEST_CHILD, CLI, "board", "--serve", "--config", config], { env: w.env, stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let exited = null;
  const closed = new Promise(done => child.once("exit", code => { exited = { code }; done(); }));
  try {
    await waitFor(async () => (await call(port, "/app/", { method: "GET" }).catch(() => null))?.status === 200, "the board process listens");
    const lines = [];
    await runBoardCli(["board", "--pair", "--config", config], { output: line => lines.push(line), env: w.env, input: { isTTY: true } });
    const own = { ...w.own, Origin: `http://127.0.0.1:${port}` };
    const paired = await call(port, "/api/pair", { headers: own, body: { code: /Pairing code: (\S+)/.exec(lines.join("\n"))[1] } });
    const headers = { ...own, Cookie: paired.headers["set-cookie"][0].split(";")[0], "X-Sage-Token": paired.json.token };
    assert.equal((await call(port, "/api/seen", { headers, body: {} })).status, 200);
    const broken = async (what, code) => {
      const seen = await call(port, "/api/seen", { headers, body: {} });
      assert.equal(seen.status, 500, `${what}: ${seen.text}`);
      assert.match(seen.json.problem, new RegExp(`^The board could not do this on this Mac \\(${code}\\), so nothing changed\\.`), what);
      assert.equal((await call(port, "/app/", { method: "GET" })).status, 200, `${what}: the board still serves pages`);
      assert.equal(exited, null, `${what}: the board process still runs`);
    };
    const rootWritesAnyFolder = process.getuid?.() === 0;
    if (!rootWritesAnyFolder) {
      chmodSync(stateDir, 0o500);
      await broken("a state folder that cannot be written", "EACCES");
      chmodSync(stateDir, 0o700);
    }
    renameSync(join(stateDir, "paired.json"), join(stateDir, "kept.json"));
    symlinkSync("kept.json", join(stateDir, "paired.json"));
    await broken("a paired.json that is a symlink", "ELOOP");
  } finally {
    chmodSync(stateDir, 0o700);
    if (child.connected) child.send({ kind: "close-tree" }, () => {});
    await closed;
  }
});

test("F-T1059-46: a shadow sage_board cookie that comes first does not hide the paired cookie after it", async t => {
  const w = await board(t), p = await pair(w);
  const shadow = `sage_board=${"B".repeat(43)}`;
  const seen = await call(w.port, "/api/seen", { headers: { ...p.headers, Cookie: `${shadow}; ${p.cookie}` }, body: {} });
  assert.equal(seen.status, 200, seen.text);
  assert.equal((await call(w.port, "/api/seen", { headers: { ...p.headers, Cookie: shadow }, body: {} })).status, 401, "the shadow cookie alone is still not paired");
});

test("F-T1059-47: while a takeover question for a task is open, to any chief, a give of that task to another chief is refused; after the answer, it opens", async t => {
  const w = await board(t), p = await pair(w);
  appendFileSync(join(w.dir, "chiefs.tsv"), `C3\tclaude\tclaude-3\t${new Date().toISOString()}\n`);
  const give = to => call(w.port, "/api/give", { headers: p.headers, body: { logbook: w.logbook, task: "T1", to } });
  assert.match((await give("C2")).json.text, /^G2 open · Hand T1 from C1/);
  const before = w.gates();
  const second = await give("C3");
  assert.equal(second.status, 409, second.text);
  assert.equal(second.json.text, "G2 is open already: it asks to hand T1 to C2 (codex). A task has one open takeover question at a time: answer G2 first (or undo your board answer to it), then give T1 again. Nothing changed.");
  assert.equal(w.gates(), before, "no second takeover question");
  assert.match((await give("C2")).json.text, /^G2 is open already · /, "the same give names the same question");
  claude.sage(["gate", "answer", "G2", "--option", "1", "--via", "board", "--project", w.project], w.env);
  assert.equal((await give("C3")).status, 409, "a board answer that waits for pickup still holds the task");
  claude.sage(["gate", "undo", "G2", "--project", w.project], w.env);
  claude.sage(["gate", "answer", "G2", "--option", "2", "--via", "chat", "--project", w.project], w.env);
  assert.match((await give("C3")).json.text, /^G3 open · Hand T1 from C1 \(claude\) to C3 \(claude\)\?/, "after the decline, the task can be given again");
});
