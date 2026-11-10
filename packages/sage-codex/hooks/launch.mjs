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
// It does nothing, with no output, when sage is not installed, when the installed version has no dispatch.mjs (a version
// before T957 runs its own plugin hooks), or when config.toml turns the plugin off ([plugins."sage@sage"] enabled = false).
// Fail closed: when dispatch.mjs fails to load or to answer, it refuses a Bash call that names a merge or a push, so that
// no broken install lets a merge skip the merge check. Every other call passes, so that a new install can repair it.
// It imports Node's built-ins only: `hooks install` and `--uninstall` use the same planner (planHooks) and writer.
import { copyFileSync, existsSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** The launcher's version: the start status asks for `hooks install` when the installed launcher is older than its plugin's. */
export const LAUNCHER_VERSION = 1;
/** The folder of the launcher in a Codex home. */
export const launcherFolder = (codexHome) => join(codexHome, "sage-hooks");
/** The command of sage's entry for one event: the text by which the planner finds sage's groups. */
export const launchCommand = (codexHome, event) => `node "${join(launcherFolder(codexHome), "launch.mjs")}" ${event}`;

/** Whether a group of hooks.json is sage's for this event: one of its handlers runs the launcher's command. */
const sageGroup = (group, event, codexHome) => Array.isArray(group?.hooks) && group.hooks.some((h) => h?.command === launchCommand(codexHome, event));
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * The new hooks.json data for the text of the user's file (undefined when there is none) and sage's wanted groups by event
 * ({} removes them all). It keeps every other key and group in its place, so the user's hooks keep their trust keys
 * (<file>:<event>:<group index>:<handler index>): a missing sage group goes at the end of its event, a changed one is
 * replaced in place, and a sage group of an event that is not wanted goes. It returns { data, changed }, and throws on a
 * file that is not a hooks.json object.
 */
export function planHooks(text, codexHome, wanted) {
  let data;
  try { data = text === undefined ? {} : JSON.parse(text); } catch (error) { throw new Error(`it does not parse as JSON (${error.message})`); }
  if (!record(data) || (data.hooks !== undefined && !record(data.hooks))) throw new Error('it is not an object with a "hooks" object');
  const before = JSON.stringify(data);
  const hooks = data.hooks ?? {};
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) throw new Error(`its "${event}" entry is not a list`);
    const kept = [];
    for (const group of groups) {
      if (!sageGroup(group, event, codexHome)) kept.push(group);
      else if (event in wanted && !kept.some((g) => sageGroup(g, event, codexHome))) kept.push(wanted[event]); // a second one would run twice
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
    const { data, changed } = planHooks(text, codexHome, {});
    if (changed) { writeAtomic(file, JSON.stringify(data, null, 2) + "\n"); lines.push(`Removed sage's entries from ${file}. The other hooks there stay as they were.`); }
    else lines.push(`${file} has no sage entries.`);
  }
  if (existsSync(launcherFolder(codexHome))) { rmSync(launcherFolder(codexHome), { recursive: true, force: true }); lines.push(`Removed ${launcherFolder(codexHome)}.`); }
  return lines.length ? lines : ["sage's hooks are not installed in this Codex home."];
}

/** Codex's order of two version folder names: by semver when both parse, else as text (compare_plugin_versions). */
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
function compareVersions(a, b) {
  const x = SEMVER.exec(a), y = SEMVER.exec(b);
  if (!x || !y) return byText(a, b);
  for (let i = 1; i <= 3; i++) if (BigInt(x[i]) !== BigInt(y[i])) return BigInt(x[i]) < BigInt(y[i]) ? -1 : 1;
  if (!x[4] !== !y[4]) return x[4] ? -1 : 1; // a pre-release is lower than its release
  const p = (x[4] ?? "").split("."), q = (y[4] ?? "").split(".");
  for (let i = 0; i < Math.max(p.length, q.length) && x[4]; i++) {
    if (p[i] === undefined || q[i] === undefined) return p[i] === undefined ? -1 : 1;
    const m = /^\d+$/.test(p[i]), n = /^\d+$/.test(q[i]);
    if (m !== n) return m ? -1 : 1;
    const c = m ? (BigInt(p[i]) < BigInt(q[i]) ? -1 : BigInt(p[i]) > BigInt(q[i]) ? 1 : 0) : byText(p[i], q[i]);
    if (c) return c;
  }
  return byText(x[5] ?? "", y[5] ?? "");
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

/** Whether config.toml turns the plugin off: enabled = false in its [plugins."sage@sage"] table. */
export function pluginOff(codexHome) {
  let table = false;
  for (const raw of (readText(join(codexHome, "config.toml")) ?? "").split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)#.*$/, "").trim();
    if (line.startsWith("[")) table = /^\[\s*plugins\s*\.\s*(?:"sage@sage"|'sage@sage')\s*\]$/.test(line);
    else if (table && /^enabled\s*=\s*false$/.test(line)) return true;
  }
  return false;
}

/** The real path of the active version's hooks/dispatch.mjs, null when it has none, undefined when sage is not installed or off. */
export function dispatchFile(codexHome) {
  const version = activeVersion(codexHome);
  if (version === undefined || pluginOff(codexHome)) return undefined;
  let file;
  try { file = realpathSync(join(versionsFolder(codexHome), version, "hooks", "dispatch.mjs")); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
  const cache = realpathSync(versionsFolder(codexHome)) + sep;
  if (!file.startsWith(cache) || !statSync(file).isFile()) throw new Error(`${file} is not a file inside ${cache}`);
  return file;
}

/** The answer when sage's hooks cannot run: a refusal of a Bash merge or push, else nothing (a line on stderr). */
function fallback(event, data, error) {
  const reason = `sage: sage's Codex hooks could not load (${error?.message ?? error}). Tell the user.`;
  const command = [].concat(data?.tool_input?.command ?? []).join(" ");
  if (event === "PreToolUse" && data?.tool_name === "Bash" && /\b(merge|push)\b/.test(command))
    return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `${reason} It refuses a merge or a push until sage's hooks load` } };
  process.stderr.write(`${reason}\n`);
  return undefined;
}

/** One event: the output object of sage's hooks for this input text, or undefined. */
export async function launch(event, raw, codexHome) {
  let data;
  try { data = JSON.parse(raw); } catch { /* the dispatcher answers an unread input */ }
  try {
    const file = dispatchFile(codexHome);
    if (!file) return undefined;
    const { dispatch } = await import(pathToFileURL(file).href);
    return await dispatch(event, data, { codexHome, launcherVersion: LAUNCHER_VERSION });
  } catch (error) { return fallback(event, data, error); }
}

const self = (() => { try { return realpathSync(fileURLToPath(import.meta.url)); } catch { return undefined; } })();
let entry;
try { if (process.argv[1]) entry = realpathSync(process.argv[1]); } catch { /* an import */ }
if (self && entry === self) {
  const codexHome = dirname(dirname(self));
  const event = process.argv[2] ?? "";
  if (event === "--uninstall") {
    try { console.log(uninstall(codexHome).join("\n")); } catch (error) { console.error(`sage: ${join(codexHome, "hooks.json")}: ${error.message}. Nothing changed.`); process.exitCode = 1; }
  } else if (!/^[A-Z][A-Za-z]+$/.test(event)) {
    process.stderr.write("usage: node launch.mjs <Codex hook event>, or node launch.mjs --uninstall\n");
    process.exitCode = 1;
  } else {
    let raw = "";
    try { raw = readFileSync(0, "utf8"); } catch { /* an unread input */ }
    const output = await launch(event, raw, codexHome);
    if (output !== undefined) process.stdout.write(JSON.stringify(output));
  }
}
