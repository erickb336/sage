// The shape check of the chief's messages in Codex (T1005), in note mode. Codex sends Stop when a turn of the main thread
// ends, with the turn's last message (last_assistant_message). In a session in sage mode, the hook checks that message
// with core's messageMiss: only a message that names its kind on its first line is checked, and the board's text, the
// Ref line and the Page block may name ids. A miss keeps the note for the session's next prompt (the mode hook gives it
// to the chief) and adds one line to the count of misses: the time, the kind and the problems' names, never a word of
// the message. The note is about the last message only, as in Claude (T1004): each Stop removes the older note first, so
// a later message that fits, or that names no kind, leaves none (T1011). The check never blocks, and it fails open: an
// error keeps no note and counts nothing.
import { appendFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { messageMiss, readModeFile } from "sage-core";
import { modeDirectory, privateDirectory, readState, saveState, stateKey } from "./hook-state.mjs";

/** The kept note of a session's main thread, in the mode folder dir. */
const noteFile = (dir, key) => join(dir, "notes", `${key}.json`);
/** Removes the kept note of a session's main thread. No note, or a folder that cannot change, removes nothing. */
const dropNote = (dir, key) => { try { unlinkSync(noteFile(dir, key)); } catch { /* no note to remove */ } };
/** The count of misses: one JSON line for each miss, in the mode folder dir. */
export const missesFile = (dir) => join(dir, "message-misses.jsonl");

/** Stop: check the last message of the chief's turn. It gives no output, so it never blocks the stop. */
export function messageCheck(input, env = process.env) {
  try {
    if (env.SAGE_HOOKS === "off" || !input || "agent_id" in input) return undefined;
    const key = stateKey(input), dir = modeDirectory(env);
    if (!key || readModeFile(readState, join(dir, `${key}.json`)).state.sage !== true) return undefined;
    dropNote(dir, key);
    const miss = typeof input.last_assistant_message === "string" && messageMiss(input.last_assistant_message);
    if (!miss) return undefined;
    privateDirectory(join(dir, "notes"));
    saveState(noteFile(dir, key), { note: miss.note });
    appendFileSync(missesFile(dir), `${JSON.stringify({ at: new Date().toISOString(), kind: miss.kind, problems: miss.names })}\n`, { mode: 0o600 });
  } catch { /* fail open: no note and no count */ }
  return undefined;
}

/**
 * The kept note of a session's main thread, once: it is removed when read, also when it cannot be read (F-T1005-3), so
 * a damaged note never comes back. Undefined when there is none, or on an error.
 */
export function takeNote(dir, key) {
  try {
    const { note } = readState(noteFile(dir, key));
    return typeof note === "string" ? note : undefined;
  } catch { return undefined; } finally { dropNote(dir, key); }
}
