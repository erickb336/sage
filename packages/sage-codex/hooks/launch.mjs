#!/usr/bin/env node
// sage's hook launcher for Codex (T957): node launch.mjs <Event>, or node launch.mjs --uninstall. `hooks install` copies
// it to <CODEX_HOME>/sage-hooks/launch.mjs, outside the plugin and outside the logbook root (<CODEX_HOME>/sage), and puts
// one entry for each event in the user's <CODEX_HOME>/hooks.json. Codex trusts such a user hook by its declaration and
// its place only (event, matcher, command, timeout and the other fields, in that file at that index), not by the
// plugin's files, so an update of sage needs no new trust.
// At each event the launcher runs the hooks of the sage version that Codex itself uses: <CODEX_HOME>/plugins/cache/sage/
// sage/local when it exists, else the highest version folder (Codex's active_plugin_version, core-plugin-common
// installed.rs). It imports that version's hooks/dispatch.mjs in this process, after it checks that the file's real path
// is inside that cache folder. CODEX_HOME comes from the launcher's own real path, as in the Claude launcher.
// It does nothing, with no output, when sage is not installed, when the installed version is one before T957 (it runs its
// own plugin hooks), or when config.toml turns the plugin off (plugins."sage@sage".enabled = false).
// Fail closed: when dispatch.mjs is missing or fails to load, or gives no answer before the entry's timeout, it refuses a Bash call that
// names a merge or a push, so that no broken install lets a merge skip the merge check. Every other call passes, so that a
// new install can repair it.
// It imports Node's built-ins only: `hooks install` and `--uninstall` use the same planner (planHooks) and writer.
import { copyFileSync, existsSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** The launcher's version: the start status asks for `hooks install` when the installed launcher is older than its plugin's. */
export const LAUNCHER_VERSION = 2;
/** Each event's timeout in seconds, in sage's entry (entries.mjs): the largest timeout of the hooks before T957. */
export const TIMEOUTS = { SessionStart: 10, UserPromptSubmit: 10, PreToolUse: 30, PermissionRequest: 30, PostToolUse: 10, SubagentStart: 10, SubagentStop: 10 };
/**
 * The milliseconds that the launcher waits for sage's answer: four fifths of the entry's timeout. Codex stops a hook at its
 * timeout and runs the tool call (a Failed hook does not block), so the launcher gives its own answer first.
 */
const deadline = (event) => (TIMEOUTS[event] ?? 10) * 800;
/** The folder of the launcher in a Codex home. */
export const launcherFolder = (codexHome) => join(codexHome, "sage-hooks");
/** The command of sage's entry for one event: the text by which the planner finds sage's groups. */
export const launchCommand = (codexHome, event) => `node "${join(launcherFolder(codexHome), "launch.mjs")}" ${event}`;

/** Whether a handler of hooks.json is sage's for this event: it runs the launcher's command. */
const sageHandler = (handler, event, codexHome) => handler?.command === launchCommand(codexHome, event);
/** Whether a group of hooks.json holds sage's handler for this event. */
export const sageGroup = (group, event, codexHome) => Array.isArray(group?.hooks) && group.hooks.some((h) => sageHandler(h, event, codexHome));
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
/** A group's fields other than its handlers, as text: Codex hashes the matcher with each handler. */
const fields = ({ hooks, ...rest }) => JSON.stringify(rest);

/**
 * The new hooks.json data for the text of the user's file (undefined or blank when there is none) and sage's wanted
 * groups by event ({} removes them all). It keeps every other key, group and handler in its place, so the user's hooks
 * keep their trust keys (<file>:<event>:<group index>:<handler index>): a missing sage group goes at the end of its event,
 * a changed sage handler is replaced in place, and a sage handler of an event that is not wanted goes. A handler that the
 * user put in sage's group stays (F-T957-2, F-T957-10): when the group's own fields are sage's, sage's handler is
 * replaced in it; else sage's handler leaves the group, and sage's group goes at the end. A group with no handler left
 * goes. It returns { data, changed }, and throws on a file that is not a hooks.json object.
 */
export function planHooks(text, codexHome, wanted) {
  let data;
  try { data = text === undefined || !text.trim() ? {} : JSON.parse(text); } catch (error) { throw new Error(`it does not parse as JSON (${error.message})`); }
  if (!record(data) || (data.hooks !== undefined && !record(data.hooks))) throw new Error('it is not an object with a "hooks" object');
  const before = JSON.stringify(data);
  const hooks = data.hooks ?? {};
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) throw new Error(`its "${event}" entry is not a list`);
    const kept = [];
    let placed = !(event in wanted); // a second sage handler would run twice
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

/** Write a file by a temporary file and a rename, through a symbolic link to its target, with its mode; keep one backup. */
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

/** The text of a file, or undefined when there is none. */
export function readText(file) {
  try { return readFileSync(file, "utf8"); } catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
}

/** Remove sage's groups from hooks.json and the launcher's folder. It returns the lines to print. */
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

/**
 * Codex's order of two version folder names: by semver when both parse, else as text (compare_plugin_versions, with the
 * semver crate's order). Dot-separated identifiers of a pre-release or of build metadata compare as numbers when both
 * are digits, a number before a word, and a shorter list first when it is a prefix (F-T957-22).
 */
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
  if (!x[4] !== !y[4]) return x[4] ? -1 : 1; // a pre-release is lower than its release
  if (x[4] && byIdentifiers(x[4], y[4])) return byIdentifiers(x[4], y[4]);
  if (!x[5] !== !y[5]) return x[5] ? 1 : -1; // no build metadata is lower
  return x[5] ? byIdentifiers(x[5], y[5]) : 0;
}

/** The folder of sage's installed versions in a Codex home. */
export const versionsFolder = (codexHome) => join(codexHome, "plugins", "cache", "sage", "sage");

/** The version folder that Codex uses: local when it exists, else the highest valid name; undefined when there is none. */
export function activeVersion(codexHome) {
  let names;
  try { names = readdirSync(versionsFolder(codexHome), { withFileTypes: true }).filter((e) => e.isDirectory() && /^[A-Za-z0-9._+-]+$/.test(e.name) && e.name !== "." && e.name !== "..").map((e) => e.name); } catch { return undefined; }
  if (!names.length) return undefined;
  return names.includes("local") ? "local" : names.sort(compareVersions).at(-1);
}

/**
 * The settings of one line of a TOML file, as [key parts, value text] pairs, with an inline table read as its keys: for
 * `[plugins]` and `"sage@sage" = { enabled = false }`, [["plugins", "sage@sage", "enabled"], "false"]. A table header gives
 * { table }. It throws on a form that it does not read (a multi-line value, an escape in a key).
 */
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

/**
 * The value text of one key of config.toml (its last setting), by its key parts, in any form of TOML that sets that key
 * (Codex reads the file with a TOML library: core-plugins loader.rs), or undefined. A line that the reader cannot read
 * sets nothing, and so does each line under an array of tables or a table header that it cannot read. It reads
 * config.toml only, not a -c override, a profile or a managed policy (a documented limit).
 */
export function tomlValue(codexHome, key) {
  let table = [], found, string;
  for (const line of (readText(join(codexHome, "config.toml")) ?? "").split(/\r?\n/)) {
    // A line inside a multi-line string sets nothing (F-T957-13). An odd count of its quotes on a line opens or ends it.
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

/** Whether config.toml turns the plugin off (plugins."sage@sage".enabled = false), so that sage's hooks keep running when the reader is not sure. */
export const pluginOff = (codexHome) => tomlValue(codexHome, ["plugins", "sage@sage", "enabled"]) === "false";

/**
 * The real path of the active version's hooks/dispatch.mjs, null for a version before T957 (its plugin declares its own
 * hooks, in hooks/hooks.json), undefined when sage is not installed or off. A version folder with neither, such as an
 * empty or a broken one, throws, so that the launcher refuses a merge or a push (F-T957-14, F-T957-15): Codex uses that
 * folder, so no sage rule runs from it.
 */
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

/**
 * A command that the backup refusal reads as a merge or a push, by its text: a word with merge in it, also the merges
 * endpoint, mergePullRequest and enablePullRequestAutoMerge of gh api (F-T957-18), and push, a ref write of the git
 * data API (git/refs, updateRef) or createCommitOnBranch. It refuses more than the gate does, because it runs only when
 * sage's hooks cannot.
 */
export const MERGE_OR_PUSH = /merge|push|git\/refs|updateRefs?\b|createCommitOnBranch/i;

/** The answer when sage's hooks cannot run: a refusal of a Bash merge or push, else nothing (a line on stderr). */
function fallback(event, data, error) {
  const reason = `sage: sage's Codex hooks could not load (${error?.message ?? error}). Tell the user.`;
  const command = [].concat(data?.tool_input?.command ?? []).join(" ");
  if (event === "PreToolUse" && data?.tool_name === "Bash" && MERGE_OR_PUSH.test(command))
    return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `${reason} It refuses a merge or a push until sage's hooks load` } };
  process.stderr.write(`${reason}\n`);
  return undefined;
}

/**
 * One event: { output, late }, the output object of sage's hooks for this input text (or undefined), and true when sage's
 * hooks gave no answer in the time (ms) and the output is the fallback's.
 */
export async function launch(event, raw, codexHome, ms = deadline(event)) {
  let data, timer;
  try { data = JSON.parse(raw); } catch { /* the dispatcher answers an unread input */ }
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
try { if (process.argv[1]) entry = realpathSync(process.argv[1]); } catch { /* an import */ }
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
    try { raw = readFileSync(0, "utf8"); } catch { /* an unread input */ }
    const { output, late } = await launch(event, raw, codexHome);
    // A late answer ends the process after its output, because the hooks that did not answer may hold it open.
    const done = () => { if (late) process.exit(); };
    if (output !== undefined) process.stdout.write(JSON.stringify(output), done);
    else done();
  }
}
