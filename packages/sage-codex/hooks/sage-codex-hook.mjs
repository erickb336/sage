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
//   - A subagent's event (agent_id) switches nothing and gets no role.
//   - The hook tells the user directly (a systemMessage) only for a limit or a fault: a damaged mode file, an unknown input shape, a mode folder that it cannot use, or SAGE_HOOKS=off. For a normal switch, the
//     note tells the chief to confirm the switch in one line of its reply.
// Autopilot is recorded here; the gate hook (gate-hook.mjs) holds the merge rule, and it reads this mode file.
// SAGE_HOOKS=off turns it off.
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { exactPhrase, MODE_DAMAGED, readModeFile, renderChiefInstructions, switchModes } from "sage-core";
import { privateDirectory, readState, saveState, stateKey } from "./principles-hook.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TOOL = join(ROOT, "skills/sage/sage.mjs");

/** What the mode notes say about Codex, for the user (the help list). Codex has no queued messages and no board phrase in this hook. */
const CODEX_HOST = {
  name: "Codex",
  timing: "Send a phrase when Codex is idle. With autopilot on, sage merges a pull request by itself after its clean reviews and checks, and Codex does not ask you first.",
  board: false,
  update: null,
};

/** The Codex versions (major.minor, both ends included) that sage was checked with. */
export const TESTED_CODEX = ["0.160", "0.164"];

const AUTOPILOT_ON ="sage: autopilot is on. In Codex, autopilot merges verified work: the hook allows only the exact merge command when the merge check passes, with no prompt. After a task's clean cycles and a passing merge_check, merge with gh pr merge <n> --squash --delete-branch --match-head-commit <sha>.";
const UNKNOWN = `sage: the sage hook did not recognise this Codex event, so it switched no mode, and autopilot is off. Update the sage plugin, and keep Codex in the tested range (${TESTED_CODEX.join(" to ")}).`;
const HOOK_OFF = "sage: the sage hook is off (SAGE_HOOKS=off), so this phrase switched no mode. Start Codex without SAGE_HOOKS=off to use the phrases.";
const DAMAGED_NOTE = 'sage: the sage mode file of this session was damaged, so sage mode and autopilot are now off. This is a normal session until the user sends "sage mode" alone, also if the history shows the chief role: you may change files yourself. Tell the user this in one line of your reply.';
const FORK_NOTE = 'sage: this thread is a fork, so sage mode and autopilot are off in it, also if the history shows the chief role: this is a normal session, and you may change files yourself. If the history shows the chief role, tell the user in one line of your reply that sage mode is off in this fork, and that the message "sage mode" alone turns it on.';
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
export function handle(input, state) {
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
  const notes = switchModes({ owner: true, text: input.prompt, all: input.prompt }, state, { autopilotOn: () => AUTOPILOT_ON, host: CODEX_HOST });
  if (state.sage && !state.given) {
    state.given = true;
    notes.unshift(chiefText());
  }
  if (was.sage !== Boolean(state.sage) || was.autopilot !== Boolean(state.autopilot)) {
    notes.push(`sage: confirm the switch to the user in one line of your reply: sage mode is ${onOff(state.sage)}, and autopilot is ${onOff(state.autopilot)}.`);
  }
  return notes.length ? context(event, notes.join("\n\n---\n\n")) : undefined;
}

/** The mode files: under the Codex logbook root (SAGE_HOME, or CODEX_HOME/sage), as the Codex state tool finds it. */
export const modeDirectory = (env) => resolve(env.SAGE_HOME ?? join(env.CODEX_HOME ?? join(homedir(), ".codex"), "sage"), ".hooks", "codex");

/** The hook's whole answer to one parsed event: it reads and saves the session's mode file with the core reader. */
export function answer(input, env) {
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
    const output = handle(input, state);
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
