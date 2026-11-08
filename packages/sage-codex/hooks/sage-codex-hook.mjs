#!/usr/bin/env node
// The sage hook for Codex (T453): sage mode, autopilot and the chief role on the stock Codex binary, through its
// lifecycle hooks. Codex sends one JSON event on stdin; the hook answers with one JSON object on stdout, or nothing.
// One node hook for its events, which reads one mode file for each session: the pattern of oh-my-codex (MIT,
// github.com/Yeachan-Heo/oh-my-codex).
//   - UserPromptSubmit: Codex sends the text that the user typed (T451), never an agent's report or a notice. A review
//     or guardian subsession also sends its own prompt, with the root session id and no agent_id (R1652). Its prompt
//     is never one phrase alone, so it switches nothing. So the whole prompt is one message of the owner for the core
//     mode rules (switchModes, the rules of the Claude hook). When sage mode turns on, the chief role goes into that
//     turn as developer context.
//   - SessionStart with source compact: a compaction can drop the role, so the hook gives it again while sage mode is on.
//   - SessionStart with source fork: a fork has a new session id, and Codex does not give the hook the parent's id.
//     So a fork starts with sage mode off, and the hook tells the chief so, because its history can show the role.
//     It also saves the fork's start mark (start-mark.mjs). A compaction saves none: it is no new start.
//   - A subagent's event (agent_id) switches nothing in its own thread and gets no role. An off phrase from any
//     thread that is not a session's main thread stops the merges of every session (offBeyondThread).
//   - The hook tells the user directly (a systemMessage) only for a limit or a fault: a damaged mode file, an unknown input shape, a mode folder that it cannot use, or SAGE_HOOKS=off; and for an off phrase from another thread. For a normal switch, the
//     note tells the chief to confirm the switch in one line of its reply.
// Autopilot is recorded here, and the chief gets the merge command when it turns on. The gate (gate-hook.mjs) holds the
// merge rule: it needs this mode file and the owner's own switch in Codex's record of the session (owner-record.mjs).
// SAGE_HOOKS=off turns it off.
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { exactPhrase, MODE_DAMAGED, PHRASES, protectionNote, readModeFile, renderChiefInstructions, switchModes } from "sage-core";
import { privateDirectory, readState, saveState, stateKey } from "./principles-hook.mjs";
import { sessionMeta } from "./report-gate.mjs";
import { saveStartMark } from "./start-mark.mjs";
import { mergeCommand } from "../skills/sage/merge.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TOOL = join(ROOT, "skills/sage/sage.mjs");

/** What the mode notes say about Codex, for the user (the help list). Codex has no queued messages and no board phrase in this hook. */
const CODEX_HOST = {
  name: "Codex",
  timing: "Send an on phrase when Codex is idle. With autopilot on, sage merges a pull request by itself after its clean reviews and checks. To stop a merge now, press Esc: a merge whose call to GitHub has started still completes, and autopilot stays on. An off phrase sent with Enter stops merges from Codex's next step, but not a merge that sage already admitted. A phrase queued with Tab waits until the turn ends.",
  board: false,
  update: null,
};

/** The Codex versions (major.minor, both ends included) that sage was checked with. */
export const TESTED_CODEX = ["0.164", "0.167"];

const AUTOPILOT_ON = `sage: autopilot is on. In Codex, autopilot merges verified work with sage's merge command. After a task's clean cycles and a passing merge_check, run it from the main thread, escalated, as one command with no other words: ${mergeCommand("<n>", "<sha>")}. The hook admits it only while autopilot is on and the merge check passes, with no prompt.`;
const UNKNOWN = `sage: the sage hook did not recognise this Codex event, so it switched no mode, and autopilot is off. Update the sage plugin, and keep Codex in the tested range (${TESTED_CODEX.join(" to ")}).`;
const HOOK_OFF = "sage: the sage hook is off (SAGE_HOOKS=off), so this phrase switched no mode. Start Codex without SAGE_HOOKS=off to use the phrases.";
const DAMAGED_NOTE = 'sage: the sage mode file of this session was damaged, so sage mode and autopilot are now off. This is a normal session until the user sends "sage mode" alone, also if the history shows the chief role: you may change files yourself. Tell the user this in one line of your reply.';
const FORK_NOTE = 'sage: this thread is a fork, so sage mode and autopilot are off in it, also if the history shows the chief role: this is a normal session, and you may change files yourself. If the history shows the chief role, tell the user in one line of your reply that sage mode is off in this fork, and that the message "sage mode" alone turns it on.';
/** Codex's addition to core's off note (F-T677-7): the merge command can already run when the off comes. */
const OFF_IN_CODEX = "sage: in Codex, a merge that sage admitted before this off can still complete. Say so in the line that confirms the switch.";
const onOff = (value) => (value ? "on" : "off");

/** The chief role: the switch line, the state tool's command, and the shared chief instructions with Codex's bindings. */
export function chiefText() {
  const bindings = JSON.parse(readFileSync(join(ROOT, "chief-bindings.json"), "utf8"));
  return [
    'sage: sage mode is on. You are the user\'s chief of staff until the user sends the message "sage mode off", alone.',
    `The state tool, for reads only: node "${TOOL}" <command> --project <path>. Write the logbook only with the sage MCP tools.`,
    renderChiefInstructions(bindings),
  ].join("\n\n");
}

const context = (event, text) => ({ hookSpecificOutput: { hookEventName: event, additionalContext: text } });

/** Whether the input has the shape of the Codex hook docs for the events in hooks.json. */
function known(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  if (typeof input.session_id !== "string" || !input.session_id) return false;
  if (input.hook_event_name === "UserPromptSubmit") return typeof input.prompt === "string";
  if (input.hook_event_name === "SessionStart") return typeof input.source === "string";
  return false;
}

/** The answer to one event. state is the session's mode state ({ sage, autopilot, given, off }); handle changes it. */
export function handle(input, state, env = process.env) {
  if (!known(input)) {
    state.autopilot = false;
    return { systemMessage: UNKNOWN };
  }
  if ("agent_id" in input) return undefined;
  const event = input.hook_event_name;
  if (event === "SessionStart") {
    if (input.source === "fork") return context(event, FORK_NOTE);
    return input.source === "compact" && state.sage ? context(event, chiefText()) : undefined;
  }
  const was = { sage: Boolean(state.sage), autopilot: Boolean(state.autopilot) };
  const notes = switchModes({ owner: true, text: input.prompt, all: input.prompt }, state, { autopilotOn: () => AUTOPILOT_ON + protectionNote(state, input.cwd, env), host: CODEX_HOST });
  if (state.sage && !state.given) {
    state.given = true;
    notes.unshift(chiefText());
  }
  if (was.autopilot && !state.autopilot) notes.push(OFF_IN_CODEX);
  if (was.sage !== Boolean(state.sage) || was.autopilot !== Boolean(state.autopilot)) {
    notes.push(`sage: confirm the switch to the user in one line of your reply: sage mode is ${onOff(state.sage)}, and autopilot is ${onOff(state.autopilot)}.`);
  }
  return notes.length ? context(event, notes.join("\n\n---\n\n")) : undefined;
}

/** The mode files: under the Codex logbook root (SAGE_HOME, or CODEX_HOME/sage), as the Codex state tool finds it. */
export const modeDirectory = (env) => resolve(env.SAGE_HOME ?? join(env.CODEX_HOME ?? join(env.HOME ?? homedir(), ".codex"), "sage"), ".hooks", "codex");

/**
 * The hook's whole answer to one parsed event. A fork of the root thread also saves its start mark (start-mark.mjs): a
 * failed save adds a limit line for the user and never blocks.
 */
export function answer(input, env) {
  const output = modeAnswer(input, env);
  const markWarning = known(input) && input.hook_event_name === "SessionStart" && input.source === "fork" ? saveStartMark(modeDirectory(env), input) : undefined;
  return markWarning ? { ...output, systemMessage: [output?.systemMessage, markWarning].filter(Boolean).join("\n") } : output;
}

/** The autopilot off phrase. */
const AUTOPILOT_OFF_PHRASE = Object.keys(PHRASES).find((phrase) => PHRASES[phrase].autopilot === false && !("sage" in PHRASES[phrase]));

/** Apply an off phrase to one mode file. A missing file is off, and a damaged file counts as off everywhere: both stay. */
function switchOff(file, text) {
  const { state, damaged } = readModeFile(readState, file);
  if (damaged || (state.sage !== true && state.autopilot !== true)) return;
  switchModes({ owner: true, text, all: text }, state, { autopilotOn: () => "" });
  saveState(file, state);
}

/**
 * An off phrase from a thread that is not a session's main thread (F-T677-24, F-T677-29). The gate and the merge
 * command need the main thread's mode file on, and such a thread cannot always name that main thread: a fork's record
 * names only the thread that it came from, which can be a fork too, and a subagent of a fork has the fork's session id.
 * A missed off is a safety failure, and an extra off only makes merges wait. So the off turns autopilot off in every
 * mode file of the folder. It returns the line for the user in that thread, or undefined for a main thread: no agent_id,
 * and a record whose session_meta names no forked_from_id.
 *   - A subagent's thread (agent_id): its session id is its root thread's id (Codex's source, "session_id is equal to
 *     the root thread's ID", and the records of Codex 0.164.0 and 0.167.0-alpha.3.2). The mode's off phrase also turns
 *     sage mode off in that session's mode file.
 *   - A fork (its record names forked_from_id), and a thread whose record the hook cannot read: a side conversation
 *     (/side) is a fork with no record.
 * An on phrase never crosses: it counts only in the main thread (handle).
 */
function offBeyondThread(input, dir) {
  const change = input.hook_event_name === "UserPromptSubmit" ? PHRASES[exactPhrase(input.prompt)] : undefined;
  if (change?.autopilot !== false) return undefined;
  const subagent = "agent_id" in input;
  let meta;
  if (!subagent) try { meta = sessionMeta(input.transcript_path); } catch { /* no record: not a main thread */ }
  if (meta && typeof meta.forked_from_id !== "string") return undefined;
  const thread = subagent ? "a subagent's thread" : meta ? "a fork" : "a thread with no record that sage can read (a side conversation has none)";
  const mode = subagent && change.sage === false;
  try {
    privateDirectory(dir);
    if (mode) switchOff(join(dir, `${stateKey({ session_id: input.session_id })}.json`), input.prompt);
    for (const name of readdirSync(dir)) if (/^[0-9a-f]{64}\.json$/.test(name)) switchOff(join(dir, name), AUTOPILOT_OFF_PHRASE);
  } catch (error) {
    return `sage: the hook could not turn autopilot off in every Codex session (${error?.code ?? error?.message ?? error}). Send the off phrase in the main thread of the session, or press Esc there.`;
  }
  return `sage: you sent the off phrase in ${thread}, so autopilot is now off in every Codex session${mode ? ", and sage mode is off in this thread's session" : ""}. To turn it on again, send "autopilot on" in the main thread of a session.`;
}

/** The answer of the mode rules for the event's own thread, and the line of an off for another thread (offBeyondThread). */
function modeAnswer(input, env) {
  const output = threadAnswer(input, env);
  if (env.SAGE_HOOKS === "off" || !known(input)) return output;
  const line = offBeyondThread(input, modeDirectory(env));
  return line ? { ...output, systemMessage: [output?.systemMessage, line].filter(Boolean).join("\n") } : output;
}

/** The answer of the mode rules in the event's own thread: it reads and saves the thread's mode file with the core reader. */
function threadAnswer(input, env) {
  if (env.SAGE_HOOKS === "off") {
    const phrase = known(input) && input.hook_event_name === "UserPromptSubmit" && !("agent_id" in input) && exactPhrase(input.prompt);
    return phrase ? { systemMessage: HOOK_OFF } : undefined;
  }
  // An unknown shape with a session id still saves autopilot off for that session.
  const key = input && typeof input === "object" ? stateKey(input) : undefined;
  if (!key) return handle(input, {});
  const dir = modeDirectory(env);
  try {
    privateDirectory(dir);
    const file = join(dir, `${key}.json`);
    const { state, damaged } = readModeFile(readState, file);
    if (damaged) {
      // Fail closed and say so once: the clean off state replaces the damaged file, and this event switches nothing.
      saveState(file, state);
      const note = known(input) && !("agent_id" in input) ? context(input.hook_event_name, DAMAGED_NOTE) : {};
      return { systemMessage: MODE_DAMAGED, ...note };
    }
    const before = JSON.stringify(state);
    const output = handle(input, state, env);
    if (JSON.stringify(state) !== before) saveState(file, state);
    return output;
  } catch {
    // Fail closed: no switch and no role. The next prompt tries again.
    return { systemMessage: `sage: the sage hook could not read or save the sage mode of this session, so it switched no mode. Check the folder ${dir}.` };
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let input;
  try { input = JSON.parse(readFileSync(0, "utf8")); } catch { /* no JSON: an unknown shape */ }
  const output = answer(input, process.env);
  if (output) process.stdout.write(JSON.stringify(output));
}
