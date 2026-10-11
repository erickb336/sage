#!/usr/bin/env node
import { spawn } from "node:child_process";
import { closeSync, constants, fstatSync, mkdirSync, lstatSync, statSync, openSync, readSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { randomBytes } from "node:crypto";
import { request } from "node:http";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { boardView } from "../sage-core/index.mjs";
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
  // The owner's password replaces the random secret: a config holds one of them.
  if (config.password !== undefined ? !validPasswordRecord(config.password) || config.secret !== undefined : typeof config.secret !== "string" || !/^[a-zA-Z0-9_-]{43,128}$/.test(config.secret)) throw new TypeError("board config needs a secret of at least 32 random bytes as base64url, or a valid password record instead");
  if (!Array.isArray(config.allowedHosts ?? []) || (config.allowedHosts ?? []).some(host => typeof host !== "string" || host.length > 255)) throw new TypeError("allowedHosts must be a bounded list of exact host names");
  const pagesDir = config.pagesDir ? boundedPath(config.pagesDir) : null;
  if (configPath && !outsideRoots(resolve(configPath), sources) || pagesDir && !outsideRoots(pagesDir, sources)) throw new TypeError("board config and exported pages must stay outside logbook roots");
  return { version: 1, sources, port, allowedHosts: config.allowedHosts ?? [], ...(config.password ? { password: config.password } : { secret: config.secret }), ...(pagesDir ? { pagesDir } : {}) };
}
export function createBoardConfig(path, { sources, port = 43123, allowedHosts = [], pagesDir } = {}) {
  path = boundedPath(path);
  const config = validateBoardConfig({ version: 1, sources, port, allowedHosts, secret: randomBytes(32).toString("base64url"), ...(pagesDir ? { pagesDir } : {}) }, path);
  noLinkedParents(path);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return config;
}
/** The standard logbook roots of the current user, as each provider's state tool computes them. A missing root stays listed: the server attaches when it appears. */
export const standardSources = (env = process.env) => [
  { id: "claude", label: "Claude", provider: "claude", path: resolve(env.CLAUDE_CONFIG_DIR ?? join(env.HOME ?? homedir(), ".claude"), "sage") },
  { id: "codex", label: "Codex", provider: "codex", path: resolve(env.CODEX_HOME ?? join(env.HOME ?? homedir(), ".codex"), "sage") },
];
export const defaultConfigPath = (env = process.env) => join(env.HOME ?? homedir(), ".config", "sage-board", "board.json");

/**
 * Ask for the owner's board password twice, with the echo off on a terminal. It comes only from the input stream, never
 * from an argument, so it is in no shell history or process list. The file keeps only its salted hash, at mode 0600.
 */
async function setPassword(configPath, input, prompt) {
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
  const { secret: _plain, ...kept } = config;
  const next = validateBoardConfig({ ...kept, password: await hashPassword(first) }, configPath);
  const temporary = join(dirname(configPath), `.board-${randomBytes(6).toString("hex")}.json`);
  writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  try { renameSync(temporary, configPath); } catch (error) { rmSync(temporary, { force: true }); throw error; }
  return `Board password set in ${configPath}. A board server that is already running keeps the old sign-in until it starts again.`;
}

/**
 * What answers on the board's port: "board", "none" (nothing listens) or "other". On the Mac the board needs no sign-in,
 * so the request carries no secret, and a program that does not answer with the board's page and headers is "other".
 */
const probe = ({ port }) => new Promise(done => {
  const req = request({ host: "127.0.0.1", port, path: "/", method: "HEAD", agent: false, timeout: 2000, headers: { Host: `127.0.0.1:${port}` } }, response => {
    response.resume();
    const { "content-type": type = "", "content-security-policy": policy = "", "cross-origin-resource-policy": resource } = response.headers;
    done(response.statusCode === 200 && type.startsWith("text/html") && policy.startsWith("default-src 'none'") && resource === "same-origin" ? "board" : "other");
  });
  req.once("timeout", () => req.destroy(new Error("timeout")));
  req.once("error", error => done(error.code === "ECONNREFUSED" ? "none" : "other"));
  req.end();
});

/** Start the server as a detached process when nothing answers: its output goes to board.log and its pid to board.pid, next to the config. */
async function ensureBoard(configPath, config) {
  const phone = config.password ? "sign in as sage with your board password" : `sign in as sage with the "secret" value in ${configPath}, or set your own password in a terminal with board --set-password`;
  const ready = how => `Sage board ${how}: http://127.0.0.1:${config.port}/ · no sign-in needed on this Mac. On the phone, ${phone}.`;
  const busy = `the board server is not running: another program answers on 127.0.0.1:${config.port}. Stop it, or set another "port" in ${configPath}.`;
  const found = await probe(config);
  if (found === "board") return ready("is running");
  if (found === "other") throw new Error(busy);
  const log = join(dirname(configPath), "board.log"), write = constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW;
  const out = openSync(log, write | constants.O_APPEND, 0o600);
  let exited = false, child;
  try { child = spawn(process.execPath, [fileURLToPath(import.meta.url), "board", "--serve", "--config", configPath], { cwd: dirname(configPath), detached: true, stdio: ["ignore", out, out] }); }
  finally { closeSync(out); }
  child.once("exit", () => { exited = true; }).once("error", () => { exited = true; }).unref();
  if (child.pid) {
    const fd = openSync(join(dirname(configPath), "board.pid"), write | constants.O_TRUNC, 0o600);
    try { writeFileSync(fd, `${child.pid}\n`); } finally { closeSync(fd); }
  }
  // 10 s: the server reads every logbook before it listens. That takes well under a second on a large logbook today.
  for (const end = Date.now() + 10_000; !exited && Date.now() < end;) {
    const now = await probe(config);
    if (now === "board") return ready("started");
    if (now === "other") throw new Error(busy);
    await new Promise(wake => setTimeout(wake, 100));
  }
  throw new Error(`the board server ${exited ? "did not start" : "did not answer within 10 s"}. See its log: ${log}`);
}

function parse(argv) {
  if (argv[0] !== "board") throw new TypeError("use: sage board [this|all|project|Tn] --config <absolute path> [--serve|--html --out <absolute path>|--status]");
  const options = {}, values = [];
  for (let i = 1; i < argv.length; i++) {
    const value = argv[i];
    if (!value.startsWith("--")) { values.push(value); continue; }
    const key = value.slice(2);
    if (!["config", "out", "project", "scope", "serve", "html", "status", "setup", "ensure", "set-password", "sources", "pages", "port", "allowed-hosts", "install", "install-dir", "login-file"].includes(key) || Object.hasOwn(options, key)) throw new TypeError("unknown or repeated board option");
    if (["serve", "html", "status", "setup", "ensure", "set-password", "install"].includes(key)) options[key] = true;
    else { if (!argv[i + 1] || argv[i + 1].startsWith("--")) throw new TypeError(`--${key} needs a value`); options[key] = argv[++i]; }
  }
  if (values.length > 1 || [options.serve, options.html, options.status, options.setup, options.ensure, options["set-password"], options.install].filter(Boolean).length > 1) throw new TypeError("board needs one scope and one format");
  return { options, value: values[0] ?? "all" };
}
export async function runBoardCli(argv, { output = line => process.stdout.write(`${line}\n`), env = process.env, input = process.stdin, prompt = process.stderr } = {}) {
  const { options, value } = parse(argv);
  options.config ??= defaultConfigPath(env);
  if (options.scope && (options.serve || options.setup || options.ensure || options["set-password"] || options.install)) throw new TypeError("--scope is only for a task lookup");
  // --ensure first sets the board up when its config is missing, with the settings that --setup takes.
  const missing = options.ensure && !lstatSync(boundedPath(options.config), { throwIfNoEntry: false });
  if (options.setup || missing) {
    if (value !== "all" || options.sources?.length > 65536 || options.project || options.out || options["install-dir"] || options["login-file"]) throw new TypeError("setup takes --config, with optional sources, port, pages and allowed-hosts");
    if (options.port && !/^[1-9]\d*$/.test(options.port)) throw new TypeError("port must be a positive integer");
    createBoardConfig(options.config, { sources: options.sources ? parseJson(options.sources) : standardSources(env), port: options.port ? Number(options.port) : 43123, pagesDir: options.pages, allowedHosts: options["allowed-hosts"] ? parseJson(options["allowed-hosts"]) : [] });
    if (options.setup) { output(`Board config created: ${boundedPath(options.config)}. The phone sign-in password stays in this private file; set your own with board --set-password.`); return null; }
  } else if (options.sources || options.pages || options.port || options["allowed-hosts"]) throw new TypeError(options.ensure ? "the board config exists: change its settings in the file" : "source and service settings require --setup");
  if (options.ensure) {
    if (value !== "all" || options.project || options.out || options["install-dir"] || options["login-file"]) throw new TypeError("ensure takes --config, and the setup settings for a new config");
    output(await ensureBoard(boundedPath(options.config), readBoardConfig(options.config))); return null;
  }
  if (options["set-password"]) {
    if (value !== "all" || options.project || options.out || options["install-dir"] || options["login-file"]) throw new TypeError("set-password takes only --config; it asks for the password");
    output(await setPassword(boundedPath(options.config), input, prompt)); return null;
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
    const server = createBoardServer(config); await server.start();
    output(`Sage board: http://127.0.0.1:${config.port}/ · no sign-in needed on this Mac.`);
    return server;
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
