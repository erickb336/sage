#!/usr/bin/env node
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { boardNote, exactPhrase, MODE_DAMAGED, parseBoardIntent, PHRASES, protectionNote, readModeFile, renderChiefInstructions, ROLE_PRINCIPLES, switchModes } from "sage-core";
import { takeNote } from "./message-check.mjs";
import { NEW_ON, onCanCount, readRecord } from "./owner-record.mjs";
import { modeDirectory, privateDirectory, readState, saveState, stateKey } from "./hook-state.mjs";
import { sessionMeta } from "./report-gate.mjs";
import { saveStartMark } from "./start-mark.mjs";
import { mergeCommand } from "../skills/sage/merge.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TOOL = join(ROOT, "skills/sage/sage.mjs");
const BOARD = join(ROOT, "board/cli.mjs");

const CODEX_HOST = {
  name: "Codex",
  timing: "Send an on phrase when Codex is idle. With autopilot on, sage merges a pull request by itself after its clean reviews and checks. To stop a merge now, press Esc: a merge whose call to GitHub has started still completes, and autopilot stays on. An off phrase sent with Enter stops merges from Codex's next step, but not a merge that sage already admitted. A phrase queued with Tab waits until the turn ends.",
  update: null,
};

const CODEX_BOARD = {
  state: (args) => `node "${TOOL}" ${args}`,
  ensure: `node "${BOARD}" board --ensure`,
  server: "Codex's sandbox blocks the first command below, because it opens a local port and writes the board config in the owner's home folder. So run it escalated (outside the sandbox), and Codex asks the owner to approve it; run the board's stop command in the same way. If it cannot run outside the sandbox (the owner declines, or approvals are off), still run the chat board, and give the owner the first command to run in Terminal on the Mac. ",
  choice: "a choice card (request_user_input_async when you have it), also while work runs, because it does not hold your turn",
};

export const TESTED_CODEX = ["0.164", "0.167"];

const AUTOPILOT_ON = `sage: autopilot is on. In Codex, autopilot merges verified work with sage's merge command. After a task's clean cycles and a passing merge_check, run it from the main thread, escalated, as one command with no other words: ${mergeCommand("<n>", "<sha>")}. The hook admits it only while autopilot is on and the merge check passes, with no prompt.`;
const UNKNOWN = `sage: the sage hook did not recognise this Codex event, so it switched no mode, and autopilot is off. Update the sage plugin, and keep Codex in the tested range (${TESTED_CODEX.join(" to ")}).`;
const HOOK_OFF = "sage: the sage hook is off (SAGE_HOOKS=off), so this phrase switched no mode. Start Codex without SAGE_HOOKS=off to use the phrases.";
const DAMAGED_NOTE = 'sage: the sage mode file of this session was damaged, so sage mode and autopilot are now off. This is a normal session until the user sends "sage mode" alone, also if the history shows the chief role: you may change files yourself. Tell the user this in one line of your reply.';
const FORK_NOTE = 'sage: this thread is a fork, so sage mode and autopilot are off in it, also if the history shows the chief role: this is a normal session, and you may change files yourself. If the history shows the chief role, tell the user in one line of your reply that sage mode is off in this fork, and that the message "sage mode" alone turns it on.';
const OFF_IN_CODEX = "sage: in Codex, a merge that sage admitted before this off can still complete. Say so in the line that confirms the switch.";
const onOff = (value) => (value ? "on" : "off");
const joinedOn = (still, why) => `sage: this "autopilot on" did not count, because ${why}. ${still
  ? "Autopilot is still on, from the user's earlier on phrase."
  : `Autopilot is still off. Tell the user in one line of your reply that the on did not count, and to send "autopilot on" alone, ${NEW_ON}.`}`;
const JOINED = "it did not start a new turn: it came while Codex worked, or from a queue";
function joins(input, state) {
  if (state.onTurn === input.turn_id) return JOINED;
  const record = readRecord(input.transcript_path);
  if (record.refused) return record;
  return onCanCount(record, input.turn_id) ? undefined : JOINED;
}

export function chiefText() {
  const bindings = JSON.parse(readFileSync(join(ROOT, "chief-bindings.json"), "utf8"));
  const principles = ROLE_PRINCIPLES["chief-of-staff"].map((name) => `\`${join(ROOT, "skills", `principle-${name}`, "SKILL.md")}\``);
  return [
    'sage: sage mode is on. You are the user\'s chief of staff until the user sends the message "sage mode off", alone.',
    `The state tool, for reads only: node "${TOOL}" <command> --project <path>. Write the logbook only with the sage MCP tools.`,
    `The principles of your role: read ${principles.join(" and ")} before you start.`,
    renderChiefInstructions(bindings),
  ].join("\n\n");
}

const context = (event, text) => ({ hookSpecificOutput: { hookEventName: event, additionalContext: text } });

function known(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  if (typeof input.session_id !== "string" || !input.session_id) return false;
  if (input.hook_event_name === "UserPromptSubmit") return typeof input.prompt === "string";
  if (input.hook_event_name === "SessionStart") return typeof input.source === "string";
  return false;
}

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
  const on = PHRASES[exactPhrase(input.prompt)]?.autopilot === true;
  const why = on && state.sage ? joins(input, state) : undefined;
  if (why?.refused) return context(event, `sage: this request switched no mode. ${why.refused}`);
  if (why) return context(event, joinedOn(state.autopilot, why));
  const was = { sage: Boolean(state.sage), autopilot: Boolean(state.autopilot) };
  const notes = switchModes({ owner: true, text: input.prompt, all: input.prompt }, state, { autopilotOn: () => AUTOPILOT_ON + protectionNote(state, input.cwd, env), host: CODEX_HOST });
  const asked = parseBoardIntent(input.prompt);
  if (asked) notes.push(boardNote(asked, input.cwd, CODEX_BOARD));
  if (on && state.autopilot) state.onTurn = input.turn_id;
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

export { modeDirectory };

export function answer(input, env) {
  const output = modeAnswer(input, env);
  const markWarning = known(input) && input.hook_event_name === "SessionStart" && input.source === "fork" ? saveStartMark(modeDirectory(env), input) : undefined;
  return markWarning ? { ...output, systemMessage: [output?.systemMessage, markWarning].filter(Boolean).join("\n") } : output;
}

const AUTOPILOT_OFF_PHRASE = Object.keys(PHRASES).find((phrase) => PHRASES[phrase].autopilot === false && !("sage" in PHRASES[phrase]));

function switchOff(file, text) {
  const { state, damaged } = readModeFile(readState, file);
  if (damaged || (state.sage !== true && state.autopilot !== true)) return;
  switchModes({ owner: true, text, all: text }, state, { autopilotOn: () => "" });
  saveState(file, state);
}

function offBeyondThread(input, dir) {
  const change = input.hook_event_name === "UserPromptSubmit" ? PHRASES[exactPhrase(input.prompt)] : undefined;
  if (change?.autopilot !== false) return undefined;
  const subagent = "agent_id" in input;
  let meta;
  if (!subagent) try { meta = sessionMeta(input.transcript_path); } catch {}
  if (meta && typeof meta.forked_from_id !== "string") return undefined;
  const mode = subagent && change.sage === false;
  try {
    privateDirectory(dir);
    if (mode) switchOff(join(dir, `${stateKey({ session_id: input.session_id })}.json`), input.prompt);
    for (const name of readdirSync(dir)) if (/^[0-9a-f]{64}\.json$/.test(name)) switchOff(join(dir, name), AUTOPILOT_OFF_PHRASE);
  } catch (error) {
    return `sage: the hook could not turn autopilot off in every Codex session (${error?.code ?? error?.message ?? error}). Send the off phrase in the main thread of the session, or press Esc there.`;
  }
  const said = subagent || meta ? `you sent the off phrase in ${subagent ? "a subagent's thread" : "a fork"}, so autopilot is now off in every Codex session${mode ? ", and sage mode is off in this thread's session" : ""}`
    : "sage cannot read Codex's record of this thread, so it does not know if this is a main thread or a side conversation. So it turned autopilot off in every Codex session";
  return `sage: ${said}. To turn it on again, send "autopilot on" alone in the main thread of a session, ${NEW_ON}.`;
}

function modeAnswer(input, env) {
  const output = threadAnswer(input, env);
  if (env.SAGE_HOOKS === "off" || !known(input)) return output;
  const line = offBeyondThread(input, modeDirectory(env));
  return line ? { ...output, systemMessage: [output?.systemMessage, line].filter(Boolean).join("\n") } : output;
}

function threadAnswer(input, env) {
  if (env.SAGE_HOOKS === "off") {
    const phrase = known(input) && input.hook_event_name === "UserPromptSubmit" && !("agent_id" in input) && exactPhrase(input.prompt);
    return phrase ? { systemMessage: HOOK_OFF } : undefined;
  }
  const key = input && typeof input === "object" ? stateKey(input) : undefined;
  if (!key) return handle(input, {});
  const dir = modeDirectory(env);
  try {
    privateDirectory(dir);
    const file = join(dir, `${key}.json`);
    const { state, damaged } = readModeFile(readState, file);
    if (damaged) {
      saveState(file, state);
      const note = known(input) && !("agent_id" in input) ? context(input.hook_event_name, DAMAGED_NOTE) : {};
      return { systemMessage: MODE_DAMAGED, ...note };
    }
    const before = JSON.stringify(state);
    const output = handle(input, state, env);
    if (JSON.stringify(state) !== before) saveState(file, state);
    const note = known(input) && input.hook_event_name === "UserPromptSubmit" && !("agent_id" in input) ? takeNote(dir, key) : undefined;
    if (!note || !state.sage) return output;
    const given = output?.hookSpecificOutput?.additionalContext;
    return { ...output, ...context("UserPromptSubmit", given ? `${given}\n\n---\n\n${note}` : note) };
  } catch {
    return { systemMessage: `sage: the sage hook could not read or save the sage mode of this session, so it switched no mode. Check the folder ${dir}.` };
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let input;
  try { input = JSON.parse(readFileSync(0, "utf8")); } catch {}
  const output = answer(input, process.env);
  if (output) process.stdout.write(JSON.stringify(output));
}
