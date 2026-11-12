#!/usr/bin/env node
import { copyFileSync, existsSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const LAUNCHER_VERSION = 2;
export const TIMEOUTS = { SessionStart: 10, UserPromptSubmit: 10, PreToolUse: 30, PermissionRequest: 30, PostToolUse: 10, SubagentStart: 10, SubagentStop: 10, Stop: 10 };
const deadline = (event) => (TIMEOUTS[event] ?? 10) * 800;
export const launcherFolder = (codexHome) => join(codexHome, "sage-hooks");
export const launchCommand = (codexHome, event) => `node "${join(launcherFolder(codexHome), "launch.mjs")}" ${event}`;

const sageHandler = (handler, event, codexHome) => handler?.command === launchCommand(codexHome, event);
export const sageGroup = (group, event, codexHome) => Array.isArray(group?.hooks) && group.hooks.some((h) => sageHandler(h, event, codexHome));
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const fields = ({ hooks, ...rest }) => JSON.stringify(rest);

export function planHooks(text, codexHome, wanted) {
  let data;
  try { data = text === undefined || !text.trim() ? {} : JSON.parse(text); } catch (error) { throw new Error(`it does not parse as JSON (${error.message})`); }
  if (!record(data) || (data.hooks !== undefined && !record(data.hooks))) throw new Error('it is not an object with a "hooks" object');
  const before = JSON.stringify(data);
  const hooks = data.hooks ?? {};
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) throw new Error(`its "${event}" entry is not a list`);
    const kept = [];
    let placed = !(event in wanted);
    for (const group of groups) {
      if (!sageGroup(group, event, codexHome)) { kept.push(group); continue; }
      const others = group.hooks.filter((h) => !sageHandler(h, event, codexHome));
      if (!placed && (!others.length || fields(group) === fields(wanted[event]))) {
        const at = group.hooks.findIndex((h) => sageHandler(h, event, codexHome));
        kept.push(others.length ? { ...group, hooks: group.hooks.flatMap((h, i) => (i === at ? wanted[event].hooks : sageHandler(h, event, codexHome) ? [] : [h])) } : wanted[event]);
        placed = true;
      } else if (others.length) kept.push({ ...group, hooks: others });
    }
    if (kept.length) hooks[event] = kept;
    else delete hooks[event];
  }
  for (const [event, group] of Object.entries(wanted)) {
    if (!(hooks[event] ?? []).some((g) => sageGroup(g, event, codexHome))) hooks[event] = [...(hooks[event] ?? []), group];
  }
  if (Object.keys(hooks).length || data.hooks !== undefined) data.hooks = hooks;
  return { data, changed: JSON.stringify(data) !== before };
}

export function writeAtomic(file, text, { backup = true } = {}) {
  let target = file, mode = 0o644;
  try {
    target = realpathSync(file);
    mode = statSync(target).mode & 0o777;
    if (backup) copyFileSync(target, `${target}.sage-backup`);
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  const temporary = `${target}.sage-${process.pid}.tmp`;
  try {
    writeFileSync(temporary, text, { mode });
    renameSync(temporary, target);
  } finally { rmSync(temporary, { force: true }); }
}

export function readText(file) {
  try { return readFileSync(file, "utf8"); } catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
}

export function uninstall(codexHome) {
  const file = join(codexHome, "hooks.json"), text = readText(file);
  const lines = [];
  if (text !== undefined) {
    let planned;
    try { planned = planHooks(text, codexHome, {}); } catch (error) { throw new Error(`${file}: ${error.message}. Nothing changed`); }
    const { data, changed } = planned;
    if (changed) { writeAtomic(file, JSON.stringify(data, null, 2) + "\n"); lines.push(`Removed sage's entries from ${file}. The other hooks there stay as they were.`); }
    else lines.push(`${file} has no sage entries.`);
  }
  if (existsSync(launcherFolder(codexHome))) { rmSync(launcherFolder(codexHome), { recursive: true, force: true }); lines.push(`Removed ${launcherFolder(codexHome)}.`); }
  return lines.length ? lines : ["sage's hooks are not installed in this Codex home."];
}

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const byNumber = (a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0);
function byIdentifiers(a, b) {
  const p = a.split("."), q = b.split(".");
  for (let i = 0; i < Math.max(p.length, q.length); i++) {
    if (p[i] === undefined || q[i] === undefined) return p[i] === undefined ? -1 : 1;
    const m = /^\d+$/.test(p[i]), n = /^\d+$/.test(q[i]);
    const c = m !== n ? (m ? -1 : 1) : m ? byNumber(p[i], q[i]) || byText(p[i], q[i]) : byText(p[i], q[i]);
    if (c) return c;
  }
  return 0;
}
function compareVersions(a, b) {
  const x = SEMVER.exec(a), y = SEMVER.exec(b);
  if (!x || !y) return byText(a, b);
  for (let i = 1; i <= 3; i++) if (byNumber(x[i], y[i])) return byNumber(x[i], y[i]);
  if (!x[4] !== !y[4]) return x[4] ? -1 : 1;
  if (x[4] && byIdentifiers(x[4], y[4])) return byIdentifiers(x[4], y[4]);
  if (!x[5] !== !y[5]) return x[5] ? 1 : -1;
  return x[5] ? byIdentifiers(x[5], y[5]) : 0;
}

export const versionsFolder = (codexHome) => join(codexHome, "plugins", "cache", "sage", "sage");

export function activeVersion(codexHome) {
  let names;
  try { names = readdirSync(versionsFolder(codexHome), { withFileTypes: true }).filter((e) => e.isDirectory() && /^[A-Za-z0-9._+-]+$/.test(e.name) && e.name !== "." && e.name !== "..").map((e) => e.name); } catch { return undefined; }
  if (!names.length) return undefined;
  return names.includes("local") ? "local" : names.sort(compareVersions).at(-1);
}

function tomlLine(text, table) {
  let i = 0;
  const space = () => { while (text[i] === " " || text[i] === "\t") i++; };
  const fail = () => { throw new Error("not read"); };
  const key = () => {
    const parts = [];
    for (;;) {
      space();
      const part = /^(?:"([^"\\]*)"|'([^']*)'|([A-Za-z0-9_-]+))/.exec(text.slice(i)) ?? fail();
      parts.push(part[1] ?? part[2] ?? part[3]);
      i += part[0].length;
      space();
      if (text[i] !== ".") return parts;
      i++;
    }
  };
  const value = (path, out) => {
    space();
    if (text[i] !== "{") {
      const scalar = /^(?:"(?:[^"\\]|\\.)*"|'[^']*'|[^\s,{}[\]#"']+)/.exec(text.slice(i)) ?? fail();
      i += scalar[0].length;
      return out.push([path, scalar[0]]);
    }
    i++; space();
    if (text[i] === "}") return i++;
    for (;;) {
      const parts = key();
      if (text[i++] !== "=") fail();
      value([...path, ...parts], out);
      space();
      const next = text[i++];
      if (next === "}") return;
      if (next !== ",") fail();
    }
  };
  const end = () => { space(); if (i < text.length && text[i] !== "#") fail(); };
  space();
  if (i === text.length || text[i] === "#") return [];
  if (text[i] === "[") {
    const array = text[i + 1] === "[";
    i += array ? 2 : 1;
    const parts = key();
    if (text.slice(i, i + (array ? 2 : 1)) !== (array ? "]]" : "]")) fail();
    i += array ? 2 : 1;
    end();
    return { table: array ? null : parts };
  }
  const out = [], parts = key();
  if (text[i++] !== "=") fail();
  value([...table, ...parts], out);
  end();
  return out;
}

export function tomlValue(codexHome, key) {
  let table = [], found, string;
  for (const line of (readText(join(codexHome, "config.toml")) ?? "").split(/\r?\n/)) {
    const quotes = (mark) => line.split(mark).length - 1;
    if (string) { if (quotes(string) % 2) string = undefined; continue; }
    string = ['"""', "'''"].find((mark) => quotes(mark) % 2);
    if (string) continue;
    let read;
    try { read = tomlLine(line, table ?? []); } catch { if (/^\s*\[/.test(line)) table = null; continue; }
    if (!Array.isArray(read)) { table = read.table; continue; }
    if (table === null) continue;
    for (const [path, value] of read) if (path.join("\n") === key.join("\n")) found = value;
  }
  return found;
}

export const pluginOff = (codexHome) => tomlValue(codexHome, ["plugins", "sage@sage", "enabled"]) === "false";

export function dispatchFile(codexHome) {
  const version = activeVersion(codexHome);
  if (version === undefined || pluginOff(codexHome)) return undefined;
  const hooks = join(versionsFolder(codexHome), version, "hooks");
  let file;
  try { file = realpathSync(join(hooks, "dispatch.mjs")); } catch (error) {
    if (error.code !== "ENOENT") throw error;
    if (existsSync(join(hooks, "hooks.json"))) return null;
    throw new Error(`the sage version ${version} has no hooks/dispatch.mjs`);
  }
  const cache = realpathSync(versionsFolder(codexHome)) + sep;
  if (!file.startsWith(cache) || !statSync(file).isFile()) throw new Error(`${file} is not a file inside ${cache}`);
  return file;
}

export const MERGE_OR_PUSH = /merge|push|git\/refs|updateRefs?\b|createCommitOnBranch/i;

function fallback(event, data, error) {
  const reason = `sage: sage's Codex hooks could not load (${error?.message ?? error}). Tell the user.`;
  const command = [].concat(data?.tool_input?.command ?? []).join(" ");
  if (event === "PreToolUse" && data?.tool_name === "Bash" && MERGE_OR_PUSH.test(command))
    return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `${reason} It refuses a merge or a push until sage's hooks load` } };
  process.stderr.write(`${reason}\n`);
  return undefined;
}

export async function launch(event, raw, codexHome, ms = deadline(event)) {
  let data, timer;
  try { data = JSON.parse(raw); } catch {}
  const late = new Promise((resolve) => { timer = setTimeout(() => resolve({ late: true }), ms); });
  try {
    const file = dispatchFile(codexHome);
    if (!file) return { output: undefined };
    const answer = import(pathToFileURL(file).href).then(({ dispatch }) => dispatch(event, data, { codexHome, launcherVersion: LAUNCHER_VERSION }));
    const first = await Promise.race([answer.then((output) => ({ output })), late]);
    return first.late ? { output: fallback(event, data, new Error(`no answer in ${ms / 1000} s`)), late: true } : first;
  } catch (error) { return { output: fallback(event, data, error) }; } finally { clearTimeout(timer); }
}

const self = (() => { try { return realpathSync(fileURLToPath(import.meta.url)); } catch { return undefined; } })();
let entry;
try { if (process.argv[1]) entry = realpathSync(process.argv[1]); } catch {}
if (self && entry === self) {
  const codexHome = dirname(dirname(self));
  const event = process.argv[2] ?? "";
  if (event === "--uninstall") {
    try { console.log(uninstall(codexHome).join("\n")); } catch (error) { console.error(`sage: ${error.message}.`); process.exitCode = 1; }
  } else if (!/^[A-Z][A-Za-z]+$/.test(event)) {
    process.stderr.write("usage: node launch.mjs <Codex hook event>, or node launch.mjs --uninstall\n");
    process.exitCode = 1;
  } else {
    let raw = "";
    try { raw = readFileSync(0, "utf8"); } catch {}
    const { output, late } = await launch(event, raw, codexHome);
    const done = () => { if (late) process.exit(); };
    if (output !== undefined) process.stdout.write(JSON.stringify(output), done);
    else done();
  }
}
