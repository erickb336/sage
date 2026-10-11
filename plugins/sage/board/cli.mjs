#!/usr/bin/env node
import { spawn } from "node:child_process";
import { closeSync, constants, fstatSync, mkdirSync, lstatSync, statSync, openSync, readSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { createHash, randomBytes } from "node:crypto";
import { request } from "node:http";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { boardView } from "../core/index.mjs";
import { installBoard, writeLoginFile } from "./install.mjs";
import { createBoardServer, hashPassword, validPasswordRecord } from "./server.mjs";

const parseJson = text => { try { return JSON.parse(text); } catch { throw new TypeError("board JSON is invalid"); } };
const boundedPath = path => { if (typeof path !== "string" || !isAbsolute(path) || path.length > 4096 || /[\p{Cc}\p{Cf}]/u.test(path)) throw new TypeError("use a bounded absolute path without control characters"); return resolve(path); };
function noLinkedParents(path) {
  const parts = resolve(path).split(sep).filter(Boolean); let current = sep;
  for (const part of parts.slice(0, -1)) {
    current = resolve(current, part);
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new TypeError("board output parent must be an ordinary directory");
  }
}
function outsideRoots(file, sources) {
  for (const source of sources) {
    if (within(file, source.path) || process.platform === "darwin" && within(file.toLowerCase(), source.path.toLowerCase())) return false;
    const root = statSync(source.path, { throwIfNoEntry: false });
    if (!root) continue;
    let parent = dirname(file);
    while (true) {
      const stat = statSync(parent, { throwIfNoEntry: false });
      if (stat && stat.dev === root.dev && stat.ino === root.ino) return false;
      const next = dirname(parent); if (next === parent) break; parent = next;
    }
  }
  return true;
}
const within = (file, root) => { const part = relative(root, file); return part === "" || part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part); };
export function readBoardConfig(path) {
  path = boundedPath(path);
  noLinkedParents(path);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd); if (!stat.isFile() || stat.size > 65536) throw new TypeError("board config must be a regular file of at most 64 KiB");
    const buffer = Buffer.alloc(65537), count = readSync(fd, buffer, 0, buffer.length, 0);
    if (count !== stat.size || count > 65536) throw new TypeError("board config changed during the read");
    return validateBoardConfig(parseJson(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, count))), path);
  } finally { closeSync(fd); }
}
export function validateBoardConfig(config, configPath = null) {
  const allowed = ["version", "sources", "port", "allowedHosts", "secret", "password", "pagesDir"];
  if (!config || config.version !== 1 || Object.keys(config).some(key => !allowed.includes(key)) || !Array.isArray(config.sources) || !config.sources.length) throw new TypeError("board config needs version 1 and explicit sources");
  const ids = new Set();
  const sources = config.sources.map(source => {
    if (!source || !/^[a-zA-Z0-9_-]{1,80}$/.test(source.id ?? "") || ids.has(source.id) || Object.keys(source).some(key => !["id", "label", "path", "provider"].includes(key))) throw new TypeError("board sources need distinct ids and known fields");
    ids.add(source.id); return { ...source, path: boundedPath(source.path) };
  });
  const port = config.port ?? 43123;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new TypeError("board port must be from 1024 to 65535");
  // T229: the board has no random secret. A "secret" of an older config still loads, but nothing reads it, so it signs no one in.
  if (config.password !== undefined && !validPasswordRecord(config.password)) throw new TypeError("the board password in the config is not a valid record: set it again with board --set-password");
  if (!Array.isArray(config.allowedHosts ?? []) || (config.allowedHosts ?? []).some(host => typeof host !== "string" || host.length > 255)) throw new TypeError("allowedHosts must be a bounded list of exact host names");
  const pagesDir = config.pagesDir ? boundedPath(config.pagesDir) : null;
  if (configPath && !outsideRoots(resolve(configPath), sources) || pagesDir && !outsideRoots(pagesDir, sources)) throw new TypeError("board config and exported pages must stay outside logbook roots");
  return { version: 1, sources, port, allowedHosts: config.allowedHosts ?? [], ...(config.password ? { password: config.password } : {}), ...(pagesDir ? { pagesDir } : {}) };
}
export function createBoardConfig(path, { sources, port = 43123, allowedHosts = [], pagesDir } = {}) {
  path = boundedPath(path);
  const config = validateBoardConfig({ version: 1, sources, port, allowedHosts, ...(pagesDir ? { pagesDir } : {}) }, path);
  noLinkedParents(path);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return config;
}
/**
 * The standard logbook roots of the current user, as each provider's state tool computes them: SAGE_HOME, when it is
 * set, is the one root of every provider. A missing root stays listed: the server attaches when it appears. The board
 * reads every provider's logbook, so it names their settings, as a cross-provider reader may (AGENTS.md).
 */
export const standardSources = (env = process.env) => env.SAGE_HOME ? [{ id: "sage", label: "Sage", path: resolve(env.SAGE_HOME) }] : [
  { id: "claude", label: "Claude", provider: "claude", path: resolve(env.CLAUDE_CONFIG_DIR ?? join(env.HOME ?? homedir(), ".claude"), "sage") },
  { id: "codex", label: "Codex", provider: "codex", path: resolve(env.CODEX_HOME ?? join(env.HOME ?? homedir(), ".codex"), "sage") },
];
export const defaultConfigPath = (env = process.env) => join(env.HOME ?? homedir(), ".config", "sage-board", "board.json");

/**
 * Ask for the owner's board password twice, with the echo off. It comes only from a terminal, never from an argument
 * or a pipe, so it is in no shell history or process list, and an agent (which has no terminal) cannot set it (T229).
 * The file keeps only its salted hash, at mode 0600.
 */
async function setPassword(configPath, input, prompt, terminal) {
  if (!terminal) throw new TypeError("board --set-password needs a terminal: open Terminal on this Mac and run the command there yourself. It does not read a password from a pipe, a file or an agent.");
  const config = readBoardConfig(configPath);
  let muted = false;
  const echo = new Writable({ write(chunk, _encoding, done) { if (!muted) prompt.write(chunk); done(); } });
  const lines = createInterface({ input, output: echo, terminal: Boolean(input.isTTY) });
  lines.on("SIGINT", () => lines.close());
  const entries = lines[Symbol.asyncIterator]();
  const ask = async question => {
    prompt.write(question); muted = true;
    try { const { value, done } = await entries.next(); return done ? null : value; }
    finally { muted = false; if (input.isTTY) prompt.write("\n"); }
  };
  let first, second;
  try { first = await ask("New board password (12 characters or more): "); second = first ? await ask("The same password again: ") : null; }
  finally { lines.close(); }
  if (!first) throw new TypeError("no password entered; the board password did not change");
  if ([...first].length < 12) throw new TypeError("the password needs 12 characters or more; the board password did not change");
  if (Buffer.byteLength(first) > 1024) throw new TypeError("the password is longer than 1024 bytes; the board password did not change");
  if (first !== second) throw new TypeError("the two entries differ; the board password did not change");
  const next = validateBoardConfig({ ...config, password: await hashPassword(first) }, configPath);
  const temporary = join(dirname(configPath), `.board-${randomBytes(6).toString("hex")}.json`);
  writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  try { renameSync(temporary, configPath); } catch (error) { rmSync(temporary, { force: true }); throw error; }
  return `Board password set in ${configPath}. A board server that is already running keeps the old sign-in until it starts again.`;
}

/** A non-secret name of one board config, from its real path: the server sends it, and ensure and stop compare it. */
export const configId = configPath => createHash("sha256").update(`sage-board-config:${realpathSync(configPath)}`).digest("hex").slice(0, 16);
/** A command that a shell runs as pasted: this file's full path, and --config when it is not the default one. */
function boardCommand(option, configPath, env) {
  const quote = text => /[^\w@%+=:,./-]/.test(text) ? `"${text.replace(/(["\\$`])/g, "\\$1")}"` : text;
  return ["node", quote(fileURLToPath(import.meta.url)), "board", option, ...(configPath === defaultConfigPath(env) ? [] : ["--config", quote(configPath)])].join(" ");
}

/**
 * What answers on the board's port, on the Mac and with no sign-in: { kind: "none" } (nothing listens), "timeout",
 * "other", "older" (a board server from before T216's repair, which does not name its config) or "board" with the
 * id, pid and start time of its X-Sage-Board header.
 */
const probe = ({ port }) => new Promise(done => {
  const req = request({ host: "127.0.0.1", port, path: "/", method: "HEAD", agent: false, timeout: 2000, headers: { Host: `127.0.0.1:${port}` } }, response => {
    response.resume();
    const { "content-type": type = "", "content-security-policy": policy = "", "cross-origin-resource-policy": resource, "www-authenticate": realm = "", "x-sage-board": named = "" } = response.headers;
    const boardHeaders = policy.startsWith("default-src 'none'") && resource === "same-origin";
    const own = /^id=([a-f0-9]{16,64}); pid=([1-9]\d{0,9}); started=(\d{1,16})$/.exec(named);
    if (boardHeaders && response.statusCode === 200 && type.startsWith("text/html")) done(own ? { kind: "board", id: own[1], pid: Number(own[2]), started: Number(own[3]) } : { kind: "older" });
    else done({ kind: boardHeaders && response.statusCode === 401 && realm.startsWith('Basic realm="Sage board"') ? "older" : "other" });
  });
  req.once("timeout", () => req.destroy(Object.assign(new Error("timeout"), { code: "TIMEOUT" })));
  req.once("error", error => done({ kind: error.code === "ECONNREFUSED" ? "none" : error.code === "TIMEOUT" ? "timeout" : "other" }));
  req.end();
});

/** The one line for a port where this config's board does not answer; null when nothing listens. */
function notOurs(found, configPath, config, env) {
  const at = `127.0.0.1:${config.port}`, elsewhere = `Stop it, or set another "port" in ${configPath}.`;
  if (found.kind === "none") return null;
  if (found.kind === "board") return found.id === configId(configPath) ? null : `another board config holds ${at}. ${elsewhere}`;
  // An older board does not name its process, so no command of this version stops it (F-T216-11, 16).
  if (found.kind === "older") return `an older board server runs on ${at}. Stop it where it started: press Ctrl+C in its terminal, or for the login service run launchctl bootout gui/$(id -u)/dev.sage.board. Then ask for the board again.`;
  if (found.kind === "timeout") return `the board does not answer: a program holds ${at} and gives no answer within 2 s. ${elsewhere}`;
  return `the board server is not running: another program answers on ${at}. ${elsewhere}`;
}

/** Start the server as a detached process when nothing answers. Its output goes to board.log next to the config; the server writes board.pid itself. */
async function ensureBoard(configPath, config, env) {
  const url = `http://127.0.0.1:${config.port}/`;
  const set = boardCommand("--set-password", configPath, env);
  const phone = !config.allowedHosts.length ? `Phone access is off: no allowedHosts in ${configPath}. To turn it on, add the host name of your private HTTPS tunnel to allowedHosts in that file.`
    : !config.password ? `Phone access is off until you set a board password: run in a terminal on this Mac: ${set}`
    : `On the phone, open https://${config.allowedHosts[0]}/ and sign in as sage with your board password. To set a new password, run in a terminal: ${set}`;
  const ready = how => `Sage board ${how}: ${url} · no sign-in needed on this Mac. ${phone}`;
  const found = await probe(config), refused = notOurs(found, configPath, config, env);
  if (refused) throw new Error(refused);
  if (found.kind === "board") {
    // A server keeps the code and the config that it started with. A server from before an upgrade (F-T229-32) can
    // still take the old random secret, so its phone line is not known: only a restart gives this code's behaviour.
    const code = Math.max(...["cli.mjs", "server.mjs"].map(name => statSync(fileURLToPath(new URL(name, import.meta.url))).mtimeMs));
    const changed = lstatSync(configPath).mtimeMs > found.started ? `${configPath} changed` : code > found.started ? "the board command was updated" : null;
    return changed ? `Sage board is running: ${url}, but ${changed} after it started. Restart needed: run ${boardCommand("--stop", configPath, env)} then ask for the board again.` : ready("is running");
  }
  const log = join(dirname(configPath), "board.log");
  const out = openSync(log, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_APPEND, 0o600);
  let exited = false, child;
  try { child = spawn(process.execPath, [fileURLToPath(import.meta.url), "board", "--serve", "--config", configPath], { cwd: dirname(configPath), detached: true, stdio: ["ignore", out, out] }); }
  finally { closeSync(out); }
  child.once("exit", () => { exited = true; }).once("error", () => { exited = true; }).unref();
  // 10 s: the server reads every logbook before it listens. That takes well under a second on a large logbook today.
  // A child that exits (another ensure won the port) still gives one more probe: the winner may be this config's board.
  for (const end = Date.now() + 10_000; Date.now() < end;) {
    const done = exited, now = await probe(config), problem = notOurs(now, configPath, config, env);
    if (now.kind === "board" && !problem) return ready("started");
    if (problem && now.kind !== "timeout") throw new Error(problem);
    if (done) break;
    await new Promise(wake => setTimeout(wake, 100));
  }
  throw new Error(`the board server ${exited ? "did not start" : "did not answer within 10 s"}. See its log: ${log}`);
}

const pidPath = configPath => join(dirname(configPath), "board.pid");
function readPid(configPath) {
  let fd;
  try { fd = openSync(pidPath(configPath), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  try {
    const buffer = Buffer.alloc(32), text = buffer.subarray(0, fstatSync(fd).isFile() ? readSync(fd, buffer, 0, 32, 0) : 0).toString("ascii");
    return /^[1-9]\d{0,9}\n?$/.test(text) ? Number(text) : null;
  } finally { closeSync(fd); }
}
/** A new file renamed over board.pid: a link at that name, hard or symbolic, is replaced, never followed (F-T216-13). */
function writePid(configPath, pid) {
  const temporary = join(dirname(configPath), `.board-${randomBytes(6).toString("hex")}.pid`);
  writeFileSync(temporary, `${pid}\n`, { flag: "wx", mode: 0o600 });
  try { renameSync(temporary, pidPath(configPath)); } catch (error) { rmSync(temporary, { force: true }); throw error; }
}

/**
 * Stop this config's board server: only the pid in board.pid, and only when the board on the port names this config
 * and that same pid. A board that does not name them (an older one) gets no signal, whatever board.pid holds.
 */
async function stopBoard(configPath, config, env, kill) {
  const at = `127.0.0.1:${config.port}`, found = await probe(config), pid = readPid(configPath);
  if (found.kind === "none") return `No board server runs on ${at}.`;
  const problem = notOurs(found, configPath, config, env);
  if (problem) throw new Error(problem);
  if (!pid) throw new Error(`the board on ${at} has no board.pid next to ${configPath}, so this command cannot tell its process. Stop it where it started (for example launchctl bootout).`);
  if (found.pid !== pid) throw new Error(`the board on ${at} is process ${found.pid}, but board.pid says ${pid}. Stop it where it started (for example launchctl bootout).`);
  kill(pid, "SIGTERM");
  // A wide guard for a busy Mac: the server closes in milliseconds.
  for (const end = Date.now() + 10_000; Date.now() < end; await new Promise(wake => setTimeout(wake, 100))) {
    if ((await probe(config)).kind === "none") return `Board server stopped: ${at} is free. Ask for the board again to start it.`;
  }
  throw new Error(`the board server got the stop signal, but ${at} is still taken after 10 s.`);
}

function parse(argv) {
  if (argv[0] !== "board") throw new TypeError("use: sage board [this|all|project|Tn] --config <absolute path> [--serve|--html --out <absolute path>|--status]");
  const options = {}, values = [];
  for (let i = 1; i < argv.length; i++) {
    const value = argv[i];
    if (!value.startsWith("--")) { values.push(value); continue; }
    const key = value.slice(2);
    if (!["config", "out", "project", "scope", "serve", "html", "status", "setup", "ensure", "stop", "set-password", "sources", "pages", "port", "allowed-hosts", "install", "install-dir", "login-file"].includes(key) || Object.hasOwn(options, key)) throw new TypeError("unknown or repeated board option");
    if (["serve", "html", "status", "setup", "ensure", "stop", "set-password", "install"].includes(key)) options[key] = true;
    else { if (!argv[i + 1] || argv[i + 1].startsWith("--")) throw new TypeError(`--${key} needs a value`); options[key] = argv[++i]; }
  }
  if (values.length > 1 || [options.serve, options.html, options.status, options.setup, options.ensure, options.stop, options["set-password"], options.install].filter(Boolean).length > 1) throw new TypeError("board needs one scope and one format");
  return { options, value: values[0] ?? "all" };
}
export async function runBoardCli(argv, { output = line => process.stdout.write(`${line}\n`), env = process.env, input = process.stdin, terminal = Boolean(input.isTTY), prompt = process.stderr, kill = (pid, signal) => process.kill(pid, signal) } = {}) {
  const { options, value } = parse(argv);
  options.config ??= defaultConfigPath(env);
  if (options.scope && (options.serve || options.setup || options.ensure || options.stop || options["set-password"] || options.install)) throw new TypeError("--scope is only for a task lookup");
  // --ensure first sets the board up when its config is missing, with the settings that --setup takes.
  const missing = options.ensure && !lstatSync(boundedPath(options.config), { throwIfNoEntry: false });
  if (options.setup || missing) {
    if (value !== "all" || options.sources?.length > 65536 || options.project || options.out || options["install-dir"] || options["login-file"]) throw new TypeError("setup takes --config, with optional sources, port, pages and allowed-hosts");
    if (options.port && !/^[1-9]\d*$/.test(options.port)) throw new TypeError("port must be a positive integer");
    createBoardConfig(options.config, { sources: options.sources ? parseJson(options.sources) : standardSources(env), port: options.port ? Number(options.port) : 43123, pagesDir: options.pages, allowedHosts: options["allowed-hosts"] ? parseJson(options["allowed-hosts"]) : [] });
    if (options.setup) { output(`Board config created: ${boundedPath(options.config)}. Access from outside this Mac stays off until you set a board password: run in a terminal ${boardCommand("--set-password", boundedPath(options.config), env)}`); return null; }
  } else if (options.sources || options.pages || options.port || options["allowed-hosts"]) throw new TypeError(options.ensure ? "the board config exists: change its settings in the file" : "source and service settings require --setup");
  if (options.ensure) {
    if (value !== "all" || options.project || options.out || options["install-dir"] || options["login-file"]) throw new TypeError("ensure takes --config, and the setup settings for a new config");
    output(await ensureBoard(boundedPath(options.config), readBoardConfig(options.config), env)); return null;
  }
  if (options.stop) {
    if (value !== "all" || options.project || options.out || options["install-dir"] || options["login-file"]) throw new TypeError("stop takes only --config");
    output(await stopBoard(boundedPath(options.config), readBoardConfig(options.config), env, kill)); return null;
  }
  if (options["set-password"]) {
    if (value !== "all" || options.project || options.out || options["install-dir"] || options["login-file"]) throw new TypeError("set-password takes only --config; it asks for the password");
    output(await setPassword(boundedPath(options.config), input, prompt, terminal)); return null;
  }
  const config = readBoardConfig(options.config);
  if (options.install) {
    if (value !== "all" || !options["install-dir"] || options.project || options.out) throw new TypeError("install needs --install-dir and --config");
    const installDir = boundedPath(options["install-dir"]);
    if (!outsideRoots(installDir, config.sources)) throw new TypeError("installation must stay outside logbook roots");
    const plistPath = options["login-file"] ? boundedPath(options["login-file"]) : null;
    if (plistPath && !outsideRoots(plistPath, config.sources)) throw new TypeError("login file must stay outside logbook roots");
    if (plistPath) noLinkedParents(plistPath);
    const installed = installBoard({ installDir, configPath: boundedPath(options.config), nodePath: process.execPath });
    output(`Installed board command: ${installed.cliPath}`);
    if (plistPath) {
      writeLoginFile({ plistPath, installDir, configPath: boundedPath(options.config), nodePath: process.execPath });
      output(`Login file created: ${plistPath}. Start it with launchctl when ready.`);
    }
    return null;
  }
  if (options["install-dir"] || options["login-file"]) throw new TypeError("installation paths require --install");
  if (options.serve) {
    if (value !== "all" || options.out || options.project) throw new TypeError("server uses all configured sources; no output or project option");
    // The server writes board.pid only once it listens, and removes it when it stops, so a pid there is a running board.
    const configPath = boundedPath(options.config), server = createBoardServer({ ...config, id: configId(configPath) });
    await server.start();
    // No listener stays without board.pid: then no command could tell its process (F-T216-12).
    try { writePid(configPath, process.pid); } catch (error) { await server.close(); throw error; }
    output(`Sage board: http://127.0.0.1:${config.port}/ · no sign-in needed on this Mac.`);
    return { ...server, close: () => server.close().finally(() => { if (readPid(configPath) === process.pid) rmSync(pidPath(configPath), { force: true }); }) };
  }
  const taskId = /^T[1-9]\d*$/.test(value) ? value : null;
  if (options.scope && !taskId) throw new TypeError("--scope selects the exact project of a task lookup");
  const format = options.html ? "html" : options.status ? "status" : taskId ? "task" : "chat";
  const body = boardView({ sources: config.sources, scope: taskId ? options.scope ?? "this" : value, project: options.project ?? process.cwd(), taskId, format });
  if (options.html) {
    const file = boundedPath(options.out ?? (config.pagesDir ? resolve(config.pagesDir, `board-${Date.now()}-${randomBytes(6).toString("hex")}.html`) : ""));
    if (!file.endsWith(".html") || !outsideRoots(file, config.sources)) throw new TypeError("HTML output must be an .html artifact outside logbook roots");
    noLinkedParents(file);
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, body, { flag: "wx", mode: 0o600 }); output(file);
  } else { if (options.out) throw new TypeError("--out needs --html"); output(body); }
  return null;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const server = await runBoardCli(process.argv.slice(2));
    if (server) { const stop = () => { server.close().then(() => { process.exitCode = 0; }).catch(() => { process.exitCode = 1; }); }; process.once("SIGINT", stop); process.once("SIGTERM", stop); }
  } catch (error) { process.stderr.write(`sage board: ${error.message}\n`); process.exitCode = 1; }
}
