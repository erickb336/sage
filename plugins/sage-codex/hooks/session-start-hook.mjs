import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { agentCaps, PHRASES, readModeFile, startsInSageMode } from "../core/index.mjs";
import { privateDirectory, readState, saveState, stateKey } from "./hook-state.mjs";
import { sessionMeta } from "./report-gate.mjs";
import { RECORD_RANGE } from "./owner-record.mjs";
import { modeDirectory, TESTED_CODEX } from "./sage-codex-hook.mjs";
import { saveStartMark } from "./start-mark.mjs";
import { ASK_INSTALL, hookState, pinWarning } from "./entries.mjs";
import { LAUNCHER_VERSION, launcherFolder } from "./launch.mjs";
import { tool } from "../skills/sage/sage.mjs";

const ON_PHRASE = Object.keys(PHRASES).find((phrase) => PHRASES[phrase].sage === true);
const RESET_UNAVAILABLE = 'sage: the hook could not turn autopilot off in the saved mode of this session. Autopilot still merges nothing until the owner sends "autopilot on" again in this session.';

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const minor = (version) => /^(\d+)\.(\d+)/.exec(version)?.slice(1).map(Number);

function codexVersion(transcriptPath) {
  try {
    const version = sessionMeta(transcriptPath).cli_version;
    return typeof version === "string" && minor(version) ? version : null;
  } catch { return null; }
}

const scalar = (value) => (/^\+?(?:0|[1-9](?:_?\d)*)$/.test(value) ? Number(value.replace(/[+_]/g, "")) : { true: true, false: false }[value]);

function tomlValues(text) {
  const path = (key) => key.split(".").map((part) => part.trim().replace(/^"(.*)"$|^'(.*)'$/, "$1$2"));
  const pair = (text) => /^([^=]+?)\s*=\s*(.+)$/.exec(text.trim());
  const values = new Map();
  const read = (key, value) => {
    const inline = /^\{(.*)\}$/.exec(value.trim()), one = scalar(value.trim());
    if (!inline) return void (one !== undefined && values.set(key.join("."), one));
    let depth = 0, start = 0;
    for (let i = 0; i <= inline[1].length; i++) {
      const c = inline[1][i];
      if (c === "{" || c === "[") depth++;
      else if (c === "}" || c === "]") depth--;
      else if (i === inline[1].length || (c === "," && !depth)) {
        const p = pair(inline[1].slice(start, i));
        if (p) read([...key, ...path(p[1])], p[2]);
        start = i + 1;
      }
    }
  };
  let table = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)#.*$/, "").trim();
    const header = /^\[\s*([^[\]]+?)\s*\]$/.exec(line), p = pair(line);
    if (header) table = path(header[1]);
    else if (line.startsWith("[")) table = null;
    else if (table && p) read([...table, ...path(p[1])], p[2]);
  }
  return values;
}

function configFiles(codexHome, cwd) {
  const user = join(codexHome, "config.toml"), up = [];
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    up.push(dir);
    if (existsSync(join(dir, ".git"))) break;
    if (dir === dirname(dir)) { up.length = 1; break; }
  }
  return [user, ...up.reverse().map((dir) => join(dir, ".codex", "config.toml")).filter((file) => file !== user)];
}

function agentLimit(values, need, user) {
  const V2 = "features.multi_agent_v2.max_concurrent_threads_per_session", get = (key) => values.get(key)?.value;
  const agentsKey = ["agents.max_concurrent_threads_per_session", "agents.max_threads"].find((key) => get(key) !== undefined);
  const agentsFix = `max_concurrent_threads_per_session = ${need} under [agents]`;
  const agents = agentsKey && { allowed: get(agentsKey), from: `agents.max_concurrent_threads_per_session = ${get(agentsKey)}`, fix: agentsFix, file: values.get(agentsKey).file };
  const v2 = get(V2) !== undefined ? { allowed: Math.max(get(V2) - 1, 0), from: `${V2} = ${get(V2)}, which counts the chief's own thread`, fix: `max_concurrent_threads_per_session = ${need + 1} under [features.multi_agent_v2]`, file: values.get(V2).file }
    : agents ?? { allowed: 3, from: "Codex's default of 4 threads, the chief's own included", fix: agentsFix, file: user };
  if (get("features.multi_agent_v2") === true || get("features.multi_agent_v2.enabled") === true) return v2;
  const v1 = agents ?? { allowed: 6, from: "Codex's default of 6 agents in multi-agent v1, which the model may run while features.multi_agent_v2 is not turned on", fix: agentsFix, file: user };
  return v1.allowed < v2.allowed ? v1 : v2;
}

function threadWarning(input, codexHome, env) {
  const cwd = input.cwd ?? process.cwd(), [user, ...project] = configFiles(codexHome, cwd);
  const layer = (file) => { try { return [...tomlValues(readFileSync(file, "utf8"))].map(([key, value]) => [key, { value, file }]); } catch { return []; } };
  const own = layer(user), need = agentCaps(tool.config(env)).cap(tool.projectName(cwd));
  const [all, alone] = [new Map([...own, ...project.flatMap(layer)]), new Map(own)].map((values) => agentLimit(values, need, user));
  const { allowed, from, fix, file } = alone.allowed < all.allowed ? alone : all;
  if (allowed >= need) return undefined;
  return `sage: Codex runs at most ${allowed} agents at once in this session (${from}), and this project's agent cap is ${need} (max_agents, or cap.<project>). An agent over Codex's limit fails to start with "agent thread limit reached". To raise it, set ${fix} in ${file}, then start a new session. sage reads only ${user} and the project's .codex/config.toml (it counts that file only where it lowers the limit, because Codex skips it in a project that Codex does not trust), not a -c override, a profile or a managed config.`;
}

function sageOn(input, env) {
  try { return readModeFile(readState, join(modeDirectory(env), `${stateKey(input)}.json`)).state.sage === true; } catch { return false; }
}

function startMode(input, env) {
  if (!["startup", "clear"].includes(input.source) || typeof input.session_id !== "string" || !input.session_id || "agent_id" in input) return {};
  let on;
  try { on = startsInSageMode(tool.storeDir(input.cwd ?? process.cwd(), env)); } catch { on = false; }
  if (!on) return {};
  try {
    const dir = modeDirectory(env);
    privateDirectory(dir);
    const file = join(dir, `${stateKey(input)}.json`);
    const { state, damaged } = readModeFile(readState, file);
    if (damaged || state.sage === false) return {};
    if (state.sage === undefined) saveState(file, { ...state, sage: true, given: false });
    return { on: true };
  } catch {
    return { warning: `sage: this project starts each session in sage mode, but the hook could not save the mode of this session, so sage mode is off. To start sage mode, send this message alone: ${ON_PHRASE}` };
  }
}

function resetAutopilot(input, env) {
  if (input.source !== "startup" && input.source !== "resume") return undefined;
  if (typeof input.session_id !== "string" || !input.session_id || "agent_id" in input) return RESET_UNAVAILABLE;
  try {
    const dir = modeDirectory(env);
    privateDirectory(dir);
    const file = join(dir, `${stateKey(input)}.json`);
    const { state, damaged } = readModeFile(readState, file);
    if (damaged) return RESET_UNAVAILABLE;
    if (state.autopilot === true) saveState(file, { ...state, autopilot: false });
  } catch { return RESET_UNAVAILABLE; }
  return undefined;
}

export function sessionStatus(input, { pluginRoot, codexHome, launcherVersion, env = process.env }) {
  if (input?.hook_event_name !== "SessionStart") return undefined;
  const resetWarning = resetAutopilot(input, env);
  const start = startMode(input, env);
  const markWarning = ["startup", "resume", "clear"].includes(input.source) ? saveStartMark(modeDirectory(env), input, start.on === true) : undefined;
  const plugin = readJson(join(pluginRoot, ".codex-plugin/plugin.json")).version;
  const version = codexVersion(input.transcript_path);
  const hooks = hookState(codexHome, env), total = hooks.events.length;
  const [low, high] = TESTED_CODEX.map(minor);
  const at = version && minor(version);
  const inRange = at && (at[0] - low[0] || at[1] - low[1]) >= 0 && (at[0] - high[0] || at[1] - high[1]) <= 0;
  const limits = [resetWarning, start.warning, markWarning].filter(Boolean);
  const stale = hooks.events.filter((e) => e.state !== "ok").length, untrusted = hooks.present - hooks.trusted;
  if (stale) limits.push(`sage: ${stale} of the ${total} sage hook entries in ${hooks.file} ${stale === 1 ? "is" : "are"} missing or changed, so some sage rules do not run. To fix them, ${ASK_INSTALL}`);
  const [is, they, them] = untrusted === 1 ? ["is", "it does", "it"] : ["are", "they do", "them"];
  if (untrusted) limits.push(`sage: ${untrusted} of the ${total} sage hooks ${is} not trusted or turned off, so ${they} not run. To trust ${them} or turn ${them} on, type /hooks in the Codex CLI.`);
  if (!(launcherVersion >= LAUNCHER_VERSION)) limits.push(`sage: the sage hook launcher in ${launcherFolder(codexHome)} is older than this sage version. To update it, ${ASK_INSTALL}`);
  const pin = pinWarning(codexHome);
  if (pin) limits.push(pin);
  if (!inRange) limits.push(`sage: ${version ? `sage was not tested with Codex ${version}` : "the hook could not read the Codex version"}, so some sage rules may not run. Autopilot merges in Codex ${RECORD_RANGE}.`);
  const threads = threadWarning(input, codexHome, env);
  if (threads) limits.push(threads);
  const status = [
    `sage ${plugin} is installed. Codex ${version ?? "version unknown"}. sage hooks: ${hooks.trusted} of ${total} are trusted (by their trust records; Codex checks each hash).`,
    sageOn(input, env) ? `sage mode is on in this session${start.on ? ", because this project starts each session in sage mode" : ""}.` : `To start sage mode, the user sends this message alone: ${ON_PHRASE}`,
    'Autopilot is off at each start of a session. To turn it on, the user sends "autopilot on" alone, while sage mode is on.',
    ...limits,
  ].join("\n");
  return { ...(limits.length ? { systemMessage: limits.join("\n") } : {}), hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: status } };
}

export function startStatus(input, { codexHome, launcherVersion }) {
  try { return sessionStatus(input, { pluginRoot: join(dirname(fileURLToPath(import.meta.url)), ".."), codexHome, launcherVersion }); } catch { return undefined; }
}
