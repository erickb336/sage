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
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PHRASES, readModeFile, startsInSageMode } from "../core/index.mjs";
import { privateDirectory, readState, saveState, stateKey } from "./hook-state.mjs";
import { sessionMeta } from "./report-gate.mjs";
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
  if (!inRange) limits.push(`sage: ${version ? `this is Codex ${version}` : "the hook could not read the Codex version"}, and sage is tested only with Codex ${TESTED_CODEX.join(" to ")}. Some sage rules may not run.`);
  // Codex trusts a plugin hook only when its record matches the hash of the hook and of the plugin's files. Codex
  // computes both, so the status counts only the records, and says that Codex checks each hash.
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
