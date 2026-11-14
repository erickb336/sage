#!/usr/bin/env node
import { spawn } from "node:child_process";
import { closeSync, constants, fstatSync, mkdirSync, lstatSync, statSync, openSync, readSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { request } from "node:http";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { BOARD_PORT, boardView, sharedRoot } from "../sage-core/index.mjs";
import { installBoard, stableNodePath, writeLoginFile } from "./install.mjs";
import { createBoardServer } from "./server.mjs";
import { startPairing, stateFolder } from "./access.mjs";

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
const RETIRED_KEYS = ["allowedHosts", "secret", "password"];
export function validateBoardConfig(config, configPath = null) {
  const allowed = ["version", "sources", "port", "pagesDir", ...RETIRED_KEYS];
  if (!config || config.version !== 1 || Object.keys(config).some(key => !allowed.includes(key)) || !Array.isArray(config.sources) || !config.sources.length) throw new TypeError("board config needs version 1 and explicit sources");
  const ids = new Set();
  const sources = config.sources.map(source => {
    if (!source || !/^[a-zA-Z0-9_-]{1,80}$/.test(source.id ?? "") || ids.has(source.id) || Object.keys(source).some(key => !["id", "label", "path", "provider"].includes(key))) throw new TypeError("board sources need distinct ids and known fields");
    ids.add(source.id); return { ...source, path: boundedPath(source.path) };
  });
  const port = config.port ?? BOARD_PORT;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new TypeError("board port must be from 1024 to 65535");
  const pagesDir = config.pagesDir ? boundedPath(config.pagesDir) : null;
  if (configPath && !outsideRoots(resolve(configPath), sources) || pagesDir && !outsideRoots(pagesDir, sources)) throw new TypeError("board config and exported pages must stay outside logbook roots");
  return { version: 1, sources, port, ...(pagesDir ? { pagesDir } : {}) };
}
export function createBoardConfig(path, { sources, port = BOARD_PORT, pagesDir } = {}) {
  path = boundedPath(path);
  const config = validateBoardConfig({ version: 1, sources, port, ...(pagesDir ? { pagesDir } : {}) }, path);
  noLinkedParents(path);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try { writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { flag: "wx", mode: 0o600 }); }
  catch (error) { throw error.code === "EEXIST" ? new TypeError(existingConfig(path)) : error; }
  return config;
}
const existingConfig = path => `the board config ${path} exists, and setup does not change it. To change its "port" or another setting, first run ${boardCommand("--stop", path, {}, true)} while the file still names the port of the running board, then edit that file, then ask for the board again. To set the board up again, remove the file first.`;
export const standardSources = (env = process.env) => [...(env.SAGE_HOME ? [{ id: "sage", label: "Sage", path: resolve(env.SAGE_HOME) }] : [
  { id: "claude", label: "Claude", provider: "claude", path: resolve(env.CLAUDE_CONFIG_DIR ?? join(env.HOME ?? homedir(), ".claude"), "sage") },
  { id: "codex", label: "Codex", provider: "codex", path: resolve(env.CODEX_HOME ?? join(env.HOME ?? homedir(), ".codex"), "sage") },
]), SHARED_SOURCE(env)];
export const providerRoots = (env = process.env) => standardSources(env).filter(source => source.id !== "shared").map(source => ({ path: source.path, provider: source.provider ?? null }));
const SHARED_SOURCE = env => ({ id: "shared", label: "Shared", path: sharedRoot(env) });
export const readSources = (sources, env = process.env) => {
  if (sources.some(source => source.id === "shared")) return sources;
  const at = sources.findIndex(source => resolve(source.path) === sharedRoot(env));
  return at < 0 ? [...sources, SHARED_SOURCE(env)] : sources.map((source, i) => i === at ? { ...source, id: "shared" } : source);
};
export const defaultConfigPath = (env = process.env) => join(env.HOME ?? homedir(), ".config", "sage-board", "board.json");

export const configId = configPath => createHash("sha256").update(`sage-board-config:${realpathSync(configPath)}`).digest("hex").slice(0, 16);
function boardCommand(option, configPath, env, explicit = false) {
  const quote = text => /[^\w@%+=:,./-]/.test(text) ? `"${text.replace(/(["\\$`])/g, "\\$1")}"` : text;
  return ["node", quote(fileURLToPath(import.meta.url)), "board", option, ...(!explicit && configPath === defaultConfigPath(env) ? [] : ["--config", quote(configPath)])].join(" ");
}

const probe = ({ port }) => new Promise(done => {
  const req = request({ host: "127.0.0.1", port, path: "/", method: "HEAD", agent: false, timeout: 2000, headers: { Host: `127.0.0.1:${port}` } }, response => {
    response.resume();
    const { "content-type": type = "", "content-security-policy": policy = "", "cross-origin-resource-policy": resource, "x-sage-board": named = "" } = response.headers;
    const boardHeaders = policy.startsWith("default-src 'none'") && resource === "same-origin";
    const own = /^id=([a-f0-9]{16,64}); pid=([1-9]\d{0,9}); started=(\d{1,16})$/.exec(named);
    if (boardHeaders && response.statusCode === 200 && type.startsWith("text/html")) done(own ? { kind: "board", id: own[1], pid: Number(own[2]), started: Number(own[3]) } : { kind: "older" });
    else done({ kind: "other" });
  });
  req.once("timeout", () => req.destroy(Object.assign(new Error("timeout"), { code: "TIMEOUT" })));
  req.once("error", error => done({ kind: { ECONNREFUSED: "none", TIMEOUT: "timeout", EPERM: "blocked" }[error.code] ?? "other" }));
  req.end();
});

const ESCALATE = "In Codex, run it escalated (outside the sandbox), or in Terminal on the Mac.";
function notOurs(found, configPath, config, env) {
  const at = `127.0.0.1:${config.port}`, elsewhere = `Stop it, or set another "port" in ${configPath}.`;
  if (found.kind === "none") return null;
  if (found.kind === "blocked") return `this command cannot reach ${at}: a sandbox blocks the local network here (EPERM). ${ESCALATE}`;
  if (found.kind === "board") return found.id === configId(configPath) ? null : `another board config holds ${at}. ${elsewhere}`;
  if (found.kind === "older") return `an older board server runs on ${at}. Stop it where it started: press Ctrl+C in its terminal, or for the login service run launchctl bootout gui/$(id -u)/dev.sage.board. Then ask for the board again.`;
  if (found.kind === "timeout") return `the board does not answer: a program holds ${at} and gives no answer within 2 s. ${elsewhere}`;
  return `the board server is not running: another program answers on ${at}. ${elsewhere}`;
}

async function ensureBoard(configPath, config, env) {
  const url = `http://127.0.0.1:${config.port}/`;
  const ready = how => `Sage board ${how}: ${url} · only on this Mac.`;
  const found = await probe(config), refused = notOurs(found, configPath, config, env);
  if (refused) throw new Error(refused);
  if (found.kind === "board") {
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
function writePid(configPath, pid) {
  const temporary = join(dirname(configPath), `.board-${randomBytes(6).toString("hex")}.pid`);
  writeFileSync(temporary, `${pid}\n`, { flag: "wx", mode: 0o600 });
  try { renameSync(temporary, pidPath(configPath)); } catch (error) { rmSync(temporary, { force: true }); throw error; }
}

async function stopBoard(configPath, config, env, kill) {
  const at = `127.0.0.1:${config.port}`, found = await probe(config), pid = readPid(configPath);
  if (found.kind === "none") return `No board server runs on ${at}.`;
  const problem = notOurs(found, configPath, config, env);
  if (problem) throw new Error(problem);
  if (!pid) throw new Error(`the board on ${at} has no board.pid next to ${configPath}, so this command cannot tell its process. Stop it where it started (for example launchctl bootout).`);
  if (found.pid !== pid) throw new Error(`the board on ${at} is process ${found.pid}, but board.pid says ${pid}. Stop it where it started (for example launchctl bootout).`);
  kill(pid, "SIGTERM");
  for (const end = Date.now() + 10_000; Date.now() < end; await new Promise(wake => setTimeout(wake, 100))) {
    if ((await probe(config)).kind === "none") return `Board server stopped: ${at} is free. Ask for the board again to start it.`;
  }
  throw new Error(`the board server got the stop signal, but ${at} is still taken after 10 s.`);
}

function parse(argv) {
  if (argv[0] !== "board") throw new TypeError("use: sage board [this|all|project|Tn] --config <absolute path> [--serve|--pair|--html --out <absolute path>|--status]");
  const options = {}, values = [];
  for (let i = 1; i < argv.length; i++) {
    const value = argv[i];
    if (!value.startsWith("--")) { values.push(value); continue; }
    const key = value.slice(2);
    if (!["config", "out", "project", "scope", "serve", "html", "status", "setup", "ensure", "stop", "pair", "sources", "pages", "port", "install", "install-dir", "login-file"].includes(key) || Object.hasOwn(options, key)) throw new TypeError("unknown or repeated board option");
    if (["serve", "html", "status", "setup", "ensure", "stop", "pair", "install"].includes(key)) options[key] = true;
    else { if (!argv[i + 1] || argv[i + 1].startsWith("--")) throw new TypeError(`--${key} needs a value`); options[key] = argv[++i]; }
  }
  if (values.length > 1 || [options.serve, options.html, options.status, options.setup, options.ensure, options.stop, options.pair, options.install].filter(Boolean).length > 1) throw new TypeError("board needs one scope and one format");
  return { options, value: values[0] ?? "all" };
}
export async function runBoardCli(argv, { output = line => process.stdout.write(`${line}\n`), env = process.env, kill = (pid, signal) => process.kill(pid, signal), input = process.stdin } = {}) {
  const { options, value } = parse(argv), explicit = options.config !== undefined;
  options.config ??= defaultConfigPath(env);
  if (options.scope && (options.serve || options.setup || options.ensure || options.stop || options.pair || options.install)) throw new TypeError("--scope is only for a task lookup");
  if (options.pair) {
    if (value !== "all" || options.project || options.out || options.sources || options.pages || options.port || options["install-dir"] || options["login-file"]) throw new TypeError("pair takes only --config");
    if (!input?.isTTY) throw new TypeError("board --pair runs only in Terminal, with your keyboard as its input, because it prints a one-time code for your eyes only. Open Terminal on this Mac and run it there.");
    const configPath = boundedPath(options.config), config = readBoardConfig(configPath), code = startPairing(stateFolder(configPath));
    output(`Pairing code: ${code}\nOpen http://127.0.0.1:${config.port}/app/ in your browser. In the card "Pair this browser to act from the board", type the code in the "Pairing code" field, then choose Pair. The code works once, within 10 minutes. After that, this browser can answer questions, undo an answer, rename chiefs and give tasks to another chief.\nIf the page shows no pairing card and this browser is not paired yet, the board that runs is older than this one: run ${boardCommand("--stop", configPath, env, explicit)}, ask for the board again, and reload the page.`);
    return null;
  }
  const missing = options.ensure && !lstatSync(boundedPath(options.config), { throwIfNoEntry: false });
  if (options.setup || missing) {
    if (value !== "all" || options.sources?.length > 65536 || options.project || options.out || options["install-dir"] || options["login-file"]) throw new TypeError("setup takes --config, with optional sources, port and pages");
    if (options.port && !/^[1-9]\d*$/.test(options.port)) throw new TypeError("port must be a positive integer");
    createBoardConfig(options.config, { sources: options.sources ? parseJson(options.sources) : standardSources(env), port: options.port ? Number(options.port) : BOARD_PORT, pagesDir: options.pages });
    if (options.setup) { output(`Board config created: ${boundedPath(options.config)}. Start the board with ${boardCommand("--ensure", boundedPath(options.config), env, explicit)}`); return null; }
  } else if (options.sources || options.pages || options.port) throw new TypeError(options.ensure ? existingConfig(boundedPath(options.config)) : "source and service settings require --setup");
  if (options.ensure) {
    if (value !== "all" || options.project || options.out || options["install-dir"] || options["login-file"]) throw new TypeError("ensure takes --config, and the setup settings for a new config");
    output(await ensureBoard(boundedPath(options.config), readBoardConfig(options.config), env)); return null;
  }
  if (options.stop) {
    if (value !== "all" || options.project || options.out || options["install-dir"] || options["login-file"]) throw new TypeError("stop takes only --config");
    output(await stopBoard(boundedPath(options.config), readBoardConfig(options.config), env, kill)); return null;
  }
  const config = readBoardConfig(options.config);
  if (options.install) {
    if (value !== "all" || !options["install-dir"] || options.project || options.out) throw new TypeError("install needs --install-dir and --config");
    const installDir = boundedPath(options["install-dir"]);
    if (!outsideRoots(installDir, config.sources)) throw new TypeError("installation must stay outside logbook roots");
    const plistPath = options["login-file"] ? boundedPath(options["login-file"]) : null;
    if (plistPath && !outsideRoots(plistPath, config.sources)) throw new TypeError("login file must stay outside logbook roots");
    if (plistPath) noLinkedParents(plistPath);
    const nodePath = plistPath ? stableNodePath() : process.execPath;
    const installed = installBoard({ installDir, configPath: boundedPath(options.config), nodePath, allowNodeAlias: Boolean(plistPath) });
    output(`Installed board command: ${installed.cliPath}`);
    if (plistPath) {
      writeLoginFile({ plistPath, installDir, configPath: boundedPath(options.config), nodePath, allowNodeAlias: true });
      output(`Login file created: ${plistPath}. Start it with launchctl when ready.`);
    }
    return null;
  }
  if (options["install-dir"] || options["login-file"]) throw new TypeError("installation paths require --install");
  if (options.serve) {
    if (value !== "all" || options.out || options.project) throw new TypeError("server uses all configured sources; no output or project option");
    const configPath = boundedPath(options.config), server = createBoardServer({ ...config, sources: readSources(config.sources, env), providerRoots: providerRoots(env), id: configId(configPath), stateDir: stateFolder(configPath) });
    await server.start();
    try { writePid(configPath, process.pid); } catch (error) { await server.close(); throw error; }
    output(`Sage board: http://127.0.0.1:${config.port}/ · only on this Mac.`);
    return { ...server, close: () => server.close().finally(() => { if (readPid(configPath) === process.pid) rmSync(pidPath(configPath), { force: true }); }) };
  }
  const taskId = /^T[1-9]\d*$/.test(value) ? value : null;
  if (options.scope && !taskId) throw new TypeError("--scope selects the exact project of a task lookup");
  const format = options.html ? "html" : options.status ? "status" : taskId ? "task" : "chat";
  const sources = readSources(config.sources, env);
  const body = boardView({ sources, scope: taskId ? options.scope ?? "this" : value, project: options.project ?? process.cwd(), providerRoots: providerRoots(env), taskId, format });
  if (options.html) {
    const file = boundedPath(options.out ?? (config.pagesDir ? resolve(config.pagesDir, `board-${Date.now()}-${randomBytes(6).toString("hex")}.html`) : ""));
    if (!file.endsWith(".html") || !outsideRoots(file, sources)) throw new TypeError("HTML output must be an .html artifact outside logbook roots");
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
  } catch (error) {
    const line = error.code === "EPERM" && error.path ? `this command cannot write ${error.path}: a sandbox or the system blocks writes there (EPERM). ${ESCALATE}` : error.message;
    process.stderr.write(`sage board: ${line}\n`); process.exitCode = 1;
  }
}
