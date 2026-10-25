#!/usr/bin/env node
// The sage hook for Codex (T453): sage mode, autopilot and the chief role on the stock Codex binary, through its
// lifecycle hooks. Codex sends one JSON event on stdin; the hook answers with one JSON object on stdout, or nothing.
// One node hook for its events, which reads one mode file for each session: the pattern of oh-my-codex (MIT,
// github.com/Yeachan-Heo/oh-my-codex).
//   - UserPromptSubmit: Codex sends only the text that the user typed (T451), never an agent's text or a notice. So the
//     whole prompt is one message of the owner for the core mode rules (switchModes, the rules of the Claude hook).
//     When sage mode turns on, the chief role goes into that turn as developer context.
//   - SessionStart with source compact: a compaction can drop the role, so the hook gives it again while sage mode is on.
//   - A subagent's event (agent_id) switches nothing and gets no role.
//   - An unknown input shape, or a mode file that cannot be read or written, switches nothing, turns autopilot off when it
//     can, and shows the user one plain line.
// Autopilot is recorded, but this hook has no merge check yet: so the chief merges nothing (chief-bindings.json).
// SAGE_HOOKS=off turns it off.
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderChiefInstructions, switchModes } from "../core/index.mjs";
import { privateDirectory, readState, saveState, stateKey } from "./principles-hook.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TOOL = join(ROOT, "skills/sage/sage.mjs");

/** What the mode notes say about Codex. Codex has no queued messages and no board phrase in this hook. */
const CODEX_HOST = {
  name: "Codex",
  timing: "Send a phrase as a message alone. A phrase typed while Codex works switches when its turn starts.",
  board: false,
  update: null,
};

const AUTOPILOT_ON = "sage: autopilot is on. In Codex, sage has no merge check yet, so autopilot merges nothing: work stops at verified, and the user merges.";
const UNKNOWN = "sage: the sage hook did not recognise this Codex event, so it switched no mode, and autopilot is off. Update the sage plugin or Codex.";

/** The chief role: the switch line, the state tool's command, and the shared chief instructions with Codex's bindings. */
export function chiefText() {
  const bindings = JSON.parse(readFileSync(join(ROOT, "chief-bindings.json"), "utf8"));
  return [
    'sage: sage mode is on. You are the user\'s chief of staff until the user sends the message "sage mode off", alone.',
    `The state tool: node "${TOOL}" <command> --project <path>. Each shell call starts fresh, so write this full command every time.`,
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
  if (event === "SessionStart") return input.source === "compact" && state.sage ? context(event, chiefText()) : undefined;
  const notes = switchModes({ owner: true, text: input.prompt, all: input.prompt }, state, { autopilotOn: () => AUTOPILOT_ON, host: CODEX_HOST });
  if (state.sage && !state.given) {
    state.given = true;
    notes.unshift(chiefText());
  }
  return notes.length ? context(event, notes.join("\n\n---\n\n")) : undefined;
}

/** The mode files: under the Codex logbook root (SAGE_HOME, or CODEX_HOME/sage), as the Codex state tool finds it. */
const stateDir = (env) => resolve(env.SAGE_HOME ?? join(env.CODEX_HOME ?? join(homedir(), ".codex"), "sage"), ".hooks", "codex");

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url) && process.env.SAGE_HOOKS !== "off") {
  let output, input;
  try { input = JSON.parse(readFileSync(0, "utf8")); } catch { /* no JSON: an unknown shape */ }
  try {
    // An unknown shape with a session id still saves autopilot off for that session.
    const key = input && typeof input === "object" ? stateKey(input) : undefined;
    if (!key) output = handle(input, {});
    else {
      const dir = stateDir(process.env);
      privateDirectory(dir);
      const file = join(dir, `${key}.json`);
      let state = {};
      // No file is a new session; a damaged file reads as no state (sage mode off, autopilot off) and is written again.
      try { state = readState(file); } catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
      if (!state || typeof state !== "object" || Array.isArray(state)) state = {};
      const before = JSON.stringify(state);
      output = handle(input, state);
      if (JSON.stringify(state) !== before) saveState(file, state);
    }
  } catch {
    // Fail closed: no switch and no role. The next prompt tries again.
    output = { systemMessage: "sage: the sage hook could not read or save the sage mode of this session, so it switched no mode. Check the sage folder in the Codex home." };
  }
  if (output) process.stdout.write(JSON.stringify(output));
}
