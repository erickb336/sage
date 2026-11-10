#!/usr/bin/env node
// Codex SessionStart hook: one short sage status at the start of a session, for the owner (systemMessage) and the
// model (additionalContext). Startup and resume turn autopilot off in the mode file before status, as a new start does
// in Claude; the owner record reader needs a new on after the start mark anyway. Startup, resume and clear save the
// session's start mark (start-mark.mjs); a failed save is a limit line and never blocks. One script for each event, after
// oh-my-codex (MIT, github.com/Yeachan-Heo/oh-my-codex). Startup and clear also turn sage mode on when the project's
// logbook has start=sage-mode (core's startsInSageMode, T948), as in Claude; the start mark keeps that start, so that the
// owner record reader starts its replay with sage mode on.
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { agentCaps } from "sage-core";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PHRASES, readModeFile, startsInSageMode } from "sage-core";
import { privateDirectory, readState, saveState, stateKey } from "./hook-state.mjs";
import { sessionMeta } from "./report-gate.mjs";
import { RECORD_RANGE } from "./owner-record.mjs";
import { modeDirectory, TESTED_CODEX } from "./sage-codex-hook.mjs";
import { saveStartMark } from "./start-mark.mjs";
import { tool } from "../skills/sage/sage.mjs";

const ON_PHRASE = Object.keys(PHRASES).find((phrase) => PHRASES[phrase].sage === true);
const RESET_UNAVAILABLE = 'sage: the hook could not turn autopilot off in the saved mode of this session. Autopilot still merges nothing until the owner sends "autopilot on" again in this session.';

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const minor = (version) => /^(\d+)\.(\d+)/.exec(version)?.slice(1).map(Number);

/** The Codex version from the session's first transcript line (session_meta, in the file's first MiB), or null. */
function codexVersion(transcriptPath) {
  try {
    const version = sessionMeta(transcriptPath).cli_version;
    return typeof version === "string" && minor(version) ? version : null;
  } catch { return null; }
}

/**
 * The trust keys of this plugin's hooks, in Codex's form <plugin>@<marketplace>:hooks/hooks.json:<event>:<group>:<handler>.
 * The installed root is <CODEX_HOME>/plugins/cache/<marketplace>/<plugin>/<version>.
 */
function hookKeys(pluginRoot) {
  const id = `${basename(dirname(pluginRoot))}@${basename(dirname(dirname(pluginRoot)))}`;
  const snake = (event) => event.replace(/(?<!^)([A-Z])/g, "_$1").toLowerCase();
  return Object.entries(readJson(join(pluginRoot, "hooks/hooks.json")).hooks).flatMap(([event, groups]) =>
    groups.flatMap((group, g) => group.hooks.map((_, h) => `${id}:hooks/hooks.json:${snake(event)}:${g}:${h}`)));
}

/** How many of the keys have a trust record in the owner's config.toml. Codex itself checks each hash. */
function trustedCount(keys, codexHome) {
  let config = "";
  try { config = readFileSync(join(codexHome, "config.toml"), "utf8"); } catch { /* No config yet. */ }
  const trusted = new Set();
  let table = null;
  for (const line of config.split("\n")) {
    const header = /^\s*\[hooks\.state\."([^"]+)"\]\s*$/.exec(line);
    if (header) table = header[1];
    else if (/^\s*\[/.test(line)) table = null;
    else if (table && /^\s*trusted_hash\s*=\s*"sha256:/.test(line)) trusted.add(table);
  }
  return keys.filter((key) => trusted.has(key)).length;
}

/** The numbers of a config.toml by their dotted key: plain key = value lines, under [table] headers, and inline tables, also nested ones. */
function tomlNumbers(text) {
  const path = (key) => key.split(".").map((part) => part.trim().replace(/^"(.*)"$|^'(.*)'$/, "$1$2"));
  const pair = (text) => /^([^=]+?)\s*=\s*(.+)$/.exec(text.trim());
  const numbers = new Map();
  // One value by its key: an inline table gives each of its pairs, split at the commas outside a nested { } or [ ].
  const read = (key, value) => {
    const inline = /^\{(.*)\}$/.exec(value.trim());
    if (!inline) return void (/^\d+$/.test(value.trim()) && numbers.set(key.join("."), Number(value)));
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
    else if (line.startsWith("[")) table = null; // an array of tables: no key of sage's is in one
    else if (table && p) read([...table, ...path(p[1])], p[2]);
  }
  return numbers;
}

/**
 * The warning when Codex runs fewer agents at once than the project's agent cap (T952), or undefined. Codex counts the
 * threads of one session: features.multi_agent_v2.max_concurrent_threads_per_session wins and counts the chief's own
 * thread; else agents.max_concurrent_threads_per_session (or max_threads) counts only the agents; else Codex allows 4
 * threads, so 3 agents (codex-rs/core/src/config/mod.rs, resolve_multi_agent_v2_config). A plugin cannot set this value.
 */
function threadWarning(input, codexHome, env) {
  let numbers = new Map();
  try { numbers = tomlNumbers(readFileSync(join(codexHome, "config.toml"), "utf8")); } catch { /* No config yet: Codex's default. */ }
  const need = agentCaps(tool.config(env)).cap(tool.projectName(input.cwd ?? process.cwd()));
  const v2 = "features.multi_agent_v2.max_concurrent_threads_per_session", own = numbers.get(v2);
  const agents = numbers.get("agents.max_concurrent_threads_per_session") ?? numbers.get("agents.max_threads");
  const [allowed, from, fix] = own !== undefined ? [Math.max(own - 1, 0), `${v2} = ${own}, which counts the chief's own thread`, `max_concurrent_threads_per_session = ${need + 1} under [features.multi_agent_v2]`]
    : agents !== undefined ? [agents, `agents.max_concurrent_threads_per_session = ${agents}`, `max_concurrent_threads_per_session = ${need} under [agents]`]
    : [3, "Codex's default of 4 threads, the chief's own included", `max_concurrent_threads_per_session = ${need} under [agents]`];
  if (allowed >= need) return undefined;
  return `sage: Codex runs at most ${allowed} agents at once in this session (${from}), and this project's agent cap is ${need} (max_agents, or cap.<project>). An agent over Codex's limit fails to start with "agent thread limit reached". To raise it, set ${fix} in ${join(codexHome, "config.toml")}, then start a new session.`;
}

/** Whether sage mode is on in the session, from the mode hook's file (a resumed session keeps it). */
function sageOn(input, env) {
  try { return readModeFile(readState, join(modeDirectory(env), `${stateKey(input)}.json`)).state.sage === true; } catch { return false; }
}

/**
 * Turn sage mode on at a new start (startup or clear) of the root thread when the project's logbook says so (T948). It
 * returns { on } (sage mode is on from this start), or { warning } when the hook could not save it. As in the Claude
 * hook, it turns on only a mode that nothing set yet, so an off phrase in the same session holds.
 */
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

/** Turn autopilot off before status. The gate does not depend on this write: the start mark ends every earlier on. */
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

/**
 * The hook's output JSON for one SessionStart input, or undefined for any other event. The chief always gets the
 * status. The user gets a warning (a systemMessage) only for a limit: a sage hook without a trust record, or a Codex
 * outside the tested range.
 */
export function sessionStatus(input, { pluginRoot, codexHome, env = process.env }) {
  if (input?.hook_event_name !== "SessionStart") return undefined;
  const resetWarning = resetAutopilot(input, env);
  const start = startMode(input, env);
  const markWarning = ["startup", "resume", "clear"].includes(input.source) ? saveStartMark(modeDirectory(env), input, start.on === true) : undefined;
  const plugin = readJson(join(pluginRoot, ".codex-plugin/plugin.json")).version;
  const version = codexVersion(input.transcript_path);
  const keys = hookKeys(pluginRoot);
  const trusted = trustedCount(keys, codexHome);
  const [low, high] = TESTED_CODEX.map(minor);
  const at = version && minor(version);
  const inRange = at && (at[0] - low[0] || at[1] - low[1]) >= 0 && (at[0] - high[0] || at[1] - high[1]) <= 0;
  const limits = [resetWarning, start.warning, markWarning].filter(Boolean);
  if (trusted < keys.length) limits.push(`sage: ${keys.length - trusted} of the ${keys.length} sage hooks ${keys.length - trusted === 1 ? "is" : "are"} not trusted yet, so some sage rules do not run. To trust them, type /hooks in the Codex CLI.`);
  if (!inRange) limits.push(`sage: ${version ? `sage was not tested with Codex ${version}` : "the hook could not read the Codex version"}, so some sage rules may not run. Autopilot merges in Codex ${RECORD_RANGE}.`);
  // Codex trusts a plugin hook only when its record matches the hash of the hook and of the plugin's files. Codex
  // computes both, so the status counts only the records, and says that Codex checks each hash.
  const threads = threadWarning(input, codexHome, env);
  if (threads) limits.push(threads);
  const status = [
    `sage ${plugin} is installed. Codex ${version ?? "version unknown"}. sage hooks: ${trusted} of ${keys.length} have a trust record (Codex checks each hash).`,
    sageOn(input, env) ? `sage mode is on in this session${start.on ? ", because this project starts each session in sage mode" : ""}.` : `To start sage mode, the user sends this message alone: ${ON_PHRASE}`,
    'Autopilot is off at each start of a session. To turn it on, the user sends "autopilot on" alone, while sage mode is on.',
    ...limits,
  ].join("\n");
  return { ...(limits.length ? { systemMessage: limits.join("\n") } : {}), hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: status } };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const output = sessionStatus(JSON.parse(readFileSync(0, "utf8")), {
      pluginRoot: join(dirname(fileURLToPath(import.meta.url)), ".."),
      codexHome: process.env.CODEX_HOME || join(homedir(), ".codex"),
    });
    if (output) process.stdout.write(JSON.stringify(output));
  } catch { /* A status line must not break a coding session. */ }
}
