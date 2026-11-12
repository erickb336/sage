import { mkdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { activeVersion, LAUNCHER_VERSION, launchCommand, launcherFolder, planHooks, pluginOff, readText, sageGroup, TIMEOUTS, tomlValue, uninstall, versionsFolder, writeAtomic } from "./launch.mjs";

export const EVENTS = {
  SessionStart: { timeout: TIMEOUTS.SessionStart, additionalContextLimit: 6000 },
  UserPromptSubmit: { timeout: TIMEOUTS.UserPromptSubmit, additionalContextLimit: 6000 },
  PreToolUse: { timeout: TIMEOUTS.PreToolUse },
  PermissionRequest: { timeout: TIMEOUTS.PermissionRequest },
  PostToolUse: { timeout: TIMEOUTS.PostToolUse },
  SubagentStart: { timeout: TIMEOUTS.SubagentStart, additionalContextLimit: 16000 },
  SubagentStop: { timeout: TIMEOUTS.SubagentStop },
  Stop: { timeout: TIMEOUTS.Stop },
};

export const entries = (codexHome) => Object.fromEntries(Object.entries(EVENTS).map(([event, fields]) =>
  [event, { hooks: [{ type: "command", command: launchCommand(codexHome, event), ...fields }] }]));

const HERE = dirname(fileURLToPath(import.meta.url));
export const INSTALL = `node "${join(HERE, "..", "skills", "sage", "sage.mjs")}" hooks install`;
export const ASK_INSTALL = `the user runs this command in a terminal, or says yes and then the chief runs it (never without that yes): ${INSTALL}`;
export const UNPIN = "codex plugin marketplace remove sage, then codex plugin marketplace add https://github.com/erickb336/sage-stack.git, then codex plugin add sage@sage";

export function pinWarning(codexHome) {
  const sha = /^"([0-9a-f]{7,40})"$|^'([0-9a-f]{7,40})'$/i.exec(tomlValue(codexHome, ["marketplaces", "sage", "ref"]) ?? "");
  if (!sha) return undefined;
  return `sage: ${join(codexHome, "config.toml")} pins the sage marketplace to the commit ${sha[1] ?? sha[2]}, so an upgrade gets no newer sage. To get updates, the user runs in a terminal: ${UNPIN}. Then start a new session.`;
}
const snake = (event) => event.replace(/(?<!^)([A-Z])/g, "_$1").toLowerCase();

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

export function hookState(codexHome, env = process.env) {
  const file = join(codexHome, "hooks.json");
  let hooks = {};
  try { hooks = JSON.parse(readText(file) ?? "{}").hooks ?? {}; } catch {}
  const plain = join(env.HOME || homedir(), ".codex");
  let real; try { real = realpathSync(plain); } catch {}
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

function installedLauncher(codexHome) {
  const found = /LAUNCHER_VERSION = (\d+);/.exec(readText(join(launcherFolder(codexHome), "launch.mjs")) ?? "");
  return found ? Number(found[1]) : undefined;
}

export function install(codexHome) {
  if (/["$`\\]/.test(codexHome)) throw new Error(`the Codex home ${JSON.stringify(codexHome)} has a " $ \` or \\ character, which the hook command cannot hold. Use a Codex home without them`);
  const file = join(codexHome, "hooks.json"), text = readText(file);
  let planned;
  try { planned = planHooks(text, codexHome, entries(codexHome)); } catch (error) { throw new Error(`${file}: ${error.message}. Fix or move the file, then run this again. Nothing changed`); }
  const lines = [];
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

export function status(codexHome, env = process.env) {
  const { file, events, present, trusted } = hookState(codexHome, env);
  const version = activeVersion(codexHome), launcher = installedLauncher(codexHome);
  const bad = events.filter((e) => e.state !== "ok").map((e) => `${e.event} ${e.state}`);
  return [
    `Entries in ${file}: ${events.length - bad.length} of ${events.length} match this sage version${bad.length ? ` (${bad.join(", ")})` : ""}. ${trusted} of ${present} are trusted (by their trust records).`,
    `Launcher: ${launcher === undefined ? `none in ${launcherFolder(codexHome)}` : `version ${launcher} in ${launcherFolder(codexHome)}`}; this sage version's launcher is version ${LAUNCHER_VERSION}.`,
    `Installed sage: ${version === undefined ? `none in ${versionsFolder(codexHome)}` : join(versionsFolder(codexHome), version)}${pluginOff(codexHome) ? ", turned off in config.toml" : ""}.`,
    ...(bad.length || launcher !== LAUNCHER_VERSION ? [`To fix: ${ASK_INSTALL}`] : []),
    ...[pinWarning(codexHome)].filter(Boolean),
  ];
}

export function pluginHome(root = join(HERE, "..")) {
  let real;
  try { real = realpathSync(root); } catch { return undefined; }
  const home = dirname(dirname(dirname(dirname(dirname(real)))));
  return dirname(real) === versionsFolder(home) ? home : undefined;
}

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
