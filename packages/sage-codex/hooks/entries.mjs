// sage's Codex hook entries (T957): the fixed list that `hooks install` puts in the user's <CODEX_HOME>/hooks.json, one
// group for each event, with no matcher, each running the launcher (launch.mjs) with its event. The matchers are in
// sage's code (dispatch.mjs). Codex hashes each entry's event, matcher, command, timeout, statusMessage, async and
// additionalContextLimit (hooks discovery.rs, hook_hash), so a change of this list needs the user's trust again; an
// update of sage's other files does not.
import { mkdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { activeVersion, LAUNCHER_VERSION, launchCommand, launcherFolder, planHooks, pluginOff, readText, sageGroup, TIMEOUTS, uninstall, versionsFolder, writeAtomic } from "./launch.mjs";

/** Each event's fields: its timeout (the launcher's TIMEOUTS), and the context limits that the roles need. */
export const EVENTS = {
  SessionStart: { timeout: TIMEOUTS.SessionStart, additionalContextLimit: 6000 },
  UserPromptSubmit: { timeout: TIMEOUTS.UserPromptSubmit, additionalContextLimit: 6000 },
  PreToolUse: { timeout: TIMEOUTS.PreToolUse },
  PermissionRequest: { timeout: TIMEOUTS.PermissionRequest },
  PostToolUse: { timeout: TIMEOUTS.PostToolUse },
  SubagentStart: { timeout: TIMEOUTS.SubagentStart, additionalContextLimit: 16000 },
  SubagentStop: { timeout: TIMEOUTS.SubagentStop },
};

/** sage's groups for a Codex home, by event. */
export const entries = (codexHome) => Object.fromEntries(Object.entries(EVENTS).map(([event, fields]) =>
  [event, { hooks: [{ type: "command", command: launchCommand(codexHome, event), ...fields }] }]));

const HERE = dirname(fileURLToPath(import.meta.url));
/** The plugin's state tool, for the install command in each line that asks for it. */
export const INSTALL = `node "${join(HERE, "..", "skills", "sage", "sage.mjs")}" hooks install`;
/**
 * How a line asks for the install (F-T957-19): it writes the user's hooks file, so the owner decides. The user runs the
 * command, or says yes and the chief runs it; the chief never runs it on its own.
 */
export const ASK_INSTALL = `the user runs this command in a terminal, or says yes and then the chief runs it (never without that yes): ${INSTALL}`;
const snake = (event) => event.replace(/(?<!^)([A-Z])/g, "_$1").toLowerCase();

/**
 * The keys that have a trust record in config.toml: [hooks.state."<key>"] tables with a trusted_hash, and not turned off
 * (enabled = false, from /hooks). Codex checks each hash.
 */
function trustRecords(codexHome) {
  const hashed = new Set(), off = new Set();
  let table = null;
  for (const line of (readText(join(codexHome, "config.toml")) ?? "").split("\n")) {
    const header = /^\s*\[hooks\.state\."([^"]+)"\]\s*$/.exec(line);
    if (header) table = header[1];
    else if (/^\s*\[/.test(line)) table = null;
    else if (table && /^\s*trusted_hash\s*=\s*"sha256:/.test(line)) hashed.add(table);
    else if (table && /^\s*enabled\s*=\s*false\s*(?:#.*)?$/.test(line)) off.add(table);
  }
  return new Set([...hashed].filter((key) => !off.has(key)));
}

/**
 * The state of sage's entries in a Codex home (its real path): for each event of the list, "ok", "changed" or "missing",
 * and how many of the present entries are trusted: an entry that matches, with a trust record that is on. A changed entry
 * keeps the record of its old text, which Codex reports as Modified, so it does not count (F-T957-4). Codex keys a user
 * hook as <hooks.json>:<event>:<group>:<handler>, from CODEX_HOME's real path, or from ~/.codex as it is when CODEX_HOME is
 * not set, so both forms count. Only sage's handler counts in its group: the group's other fields are Codex's matcher.
 */
export function hookState(codexHome, env = process.env) {
  const file = join(codexHome, "hooks.json");
  let hooks = {};
  try { hooks = JSON.parse(readText(file) ?? "{}").hooks ?? {}; } catch { /* a broken file: every entry is missing */ }
  const plain = join(env.HOME || homedir(), ".codex");
  let real; try { real = realpathSync(plain); } catch { /* none */ }
  const sources = [...new Set([file, ...(real === codexHome ? [join(plain, "hooks.json")] : [])])];
  const records = trustRecords(codexHome), wanted = entries(codexHome);
  const events = Object.keys(EVENTS).map((event) => {
    const groups = Array.isArray(hooks[event]) ? hooks[event] : [];
    const g = groups.findIndex((group) => sageGroup(group, event, codexHome));
    if (g < 0) return { event, state: "missing" };
    const { hooks: handlers, ...fields } = groups[g];
    const h = handlers.findIndex((x) => x?.command === launchCommand(codexHome, event));
    const ok = !Object.keys(fields).length && JSON.stringify(handlers[h]) === JSON.stringify(wanted[event].hooks[0]);
    const trusted = ok && sources.some((source) => records.has(`${source}:${snake(event)}:${g}:${h}`));
    return { event, state: ok ? "ok" : "changed", trusted };
  });
  return { file, events, present: events.filter((e) => e.state !== "missing").length, trusted: events.filter((e) => e.trusted).length };
}

/** The version of an installed launcher, from its text, or undefined. */
function installedLauncher(codexHome) {
  const found = /LAUNCHER_VERSION = (\d+);/.exec(readText(join(launcherFolder(codexHome), "launch.mjs")) ?? "");
  return found ? Number(found[1]) : undefined;
}

/** Install or update sage's entries and the launcher in a Codex home. It returns the lines to print, and throws on a refusal. */
export function install(codexHome) {
  if (/["$`\\]/.test(codexHome)) throw new Error(`the Codex home ${JSON.stringify(codexHome)} has a " $ \` or \\ character, which the hook command cannot hold. Use a Codex home without them`);
  const file = join(codexHome, "hooks.json"), text = readText(file);
  let planned;
  try { planned = planHooks(text, codexHome, entries(codexHome)); } catch (error) { throw new Error(`${file}: ${error.message}. Fix or move the file, then run this again. Nothing changed`); }
  const lines = [];
  // The launcher first, so that no entry runs a missing launcher.
  const source = join(HERE, "launch.mjs"), target = join(launcherFolder(codexHome), "launch.mjs");
  if (readText(target) !== readFileSync(source, "utf8")) {
    mkdirSync(launcherFolder(codexHome), { recursive: true });
    writeAtomic(target, readFileSync(source, "utf8"), { backup: false });
    lines.push(`Installed the launcher ${target}.`);
  }
  if (planned.changed) {
    writeAtomic(file, JSON.stringify(planned.data, null, 2) + "\n");
    lines.push(text === undefined ? `Wrote sage's ${Object.keys(EVENTS).length} entries in a new ${file}.`
      : `Wrote sage's ${Object.keys(EVENTS).length} entries in ${file}; the other hooks there stay as they were. A copy of the old file is in ${file}.sage-backup.`);
  }
  if (!lines.length) lines.push(`sage's hooks are already installed in ${file}. Nothing changed.`);
  const { present, trusted } = hookState(codexHome);
  const left = present - trusted;
  if (left) lines.push(`Next: in the Codex CLI, type /hooks and trust the ${left} sage ${left === 1 ? "hook that is" : "hooks that are"} not trusted yet (the hooks of ${file}). Codex runs a hook only after this.`);
  if (/^\s*\[{1,2}\s*hooks\s*(?:\.\s*(?!"?state\b)[^\]]*)?\]{1,2}\s*(?:#.*)?$/m.test(readText(join(codexHome, "config.toml")) ?? ""))
    lines.push(`Note: ${join(codexHome, "config.toml")} also has hooks in a [hooks] table. Codex runs those too, and it warns that one layer has two kinds of hook files.`);
  return lines;
}

/** The lines of `hooks status`. */
export function status(codexHome, env = process.env) {
  const { file, events, present, trusted } = hookState(codexHome, env);
  const version = activeVersion(codexHome), launcher = installedLauncher(codexHome);
  const bad = events.filter((e) => e.state !== "ok").map((e) => `${e.event} ${e.state}`);
  return [
    `Entries in ${file}: ${events.length - bad.length} of ${events.length} match this sage version${bad.length ? ` (${bad.join(", ")})` : ""}. ${trusted} of ${present} are trusted (by their trust records).`,
    `Launcher: ${launcher === undefined ? `none in ${launcherFolder(codexHome)}` : `version ${launcher} in ${launcherFolder(codexHome)}`}; this sage version's launcher is version ${LAUNCHER_VERSION}.`,
    `Installed sage: ${version === undefined ? `none in ${versionsFolder(codexHome)}` : join(versionsFolder(codexHome), version)}${pluginOff(codexHome) ? ", turned off in config.toml" : ""}.`,
    ...(bad.length || launcher !== LAUNCHER_VERSION ? [`To fix: ${ASK_INSTALL}`] : []),
  ];
}

/** The Codex home whose plugin cache holds this plugin (<home>/plugins/cache/sage/sage/<version>), or undefined. */
export function pluginHome(root = join(HERE, "..")) {
  let real;
  try { real = realpathSync(root); } catch { return undefined; }
  const home = dirname(dirname(dirname(dirname(dirname(real)))));
  return dirname(real) === versionsFolder(home) ? home : undefined;
}

/**
 * The `hooks` command of the state tool: install, uninstall or status, for the Codex home that holds this plugin, so that
 * the entries run the version that this home's Codex uses (F-T957-25); for a plugin outside a Codex home (a clone), for
 * CODEX_HOME, or ~/.codex. It refuses when CODEX_HOME names another home than the plugin's, because one of the two is a
 * mistake.
 */
export function hooksCommand(args, env = process.env, own = pluginHome()) {
  const [word] = args;
  if (!["install", "uninstall", "status"].includes(word) || args.length !== 1) return { code: 1, text: "usage: sage.mjs hooks install|uninstall|status" };
  const given = env.CODEX_HOME || join(env.HOME || homedir(), ".codex");
  let codexHome = own;
  if (!codexHome) {
    try { codexHome = realpathSync(given); } catch { return { code: 1, text: `sage: the Codex home ${given} does not exist. Run codex once, or set CODEX_HOME, then run this again.` }; }
  } else if (env.CODEX_HOME) {
    let named;
    try { named = realpathSync(env.CODEX_HOME); } catch { named = env.CODEX_HOME; }
    if (named !== codexHome) return { code: 1, text: `sage: this sage plugin is in the Codex home ${codexHome}, but CODEX_HOME is ${env.CODEX_HOME}. Run the command of the plugin in ${env.CODEX_HOME}/plugins/cache/sage/sage, or run this one without CODEX_HOME. Nothing changed.` };
  }
  try {
    const lines = word === "install" ? install(codexHome) : word === "uninstall" ? uninstall(codexHome) : status(codexHome, env);
    return { code: 0, text: lines.join("\n") };
  } catch (error) { return { code: 1, text: `sage: ${error.message}.` }; }
}
