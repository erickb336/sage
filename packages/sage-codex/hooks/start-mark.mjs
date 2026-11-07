// The start mark of a Codex session (T663): where this start of the session begins in Codex's record, and which Codex
// process started it. A resume writes no session_meta line into the record (T662 proof, case 5c), so the owner record
// reader counts only the owner's messages after the mark. The SessionStart hooks write it for startup, resume, clear
// (session-start-hook.mjs) and fork (sage-codex-hook.mjs), never for compact: a compaction is no new start. Text for
// the user calls the mark sage's "note of this session start".
import { readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { privateDirectory, saveState, stateKey } from "./principles-hook.mjs";

/** The mark file of the session's root thread, in the mode folder dir. */
export const markFile = (dir, sessionId) => join(dir, "marks", `${stateKey({ session_id: sessionId })}.json`);

/** The count of lines in the record now (a partial last line counts), or 0 when Codex has not written it yet. */
function recordLines(path) {
  if (typeof path !== "string" || !path) return 0;
  let bytes;
  try { bytes = readFileSync(path); } catch (error) { if (error.code === "ENOENT") return 0; throw error; }
  let lines = bytes.length && bytes.at(-1) !== 10 ? 1 : 0;
  for (let i = bytes.indexOf(10); i >= 0; i = bytes.indexOf(10, i + 1)) lines++;
  return lines;
}

/**
 * Save the start mark of one SessionStart event of the root thread, with an atomic rename. It returns undefined, or a
 * limit line for the user when the save fails: then it also removes an older mark of the session, so that no stale
 * boundary stays. It never throws, so a failed mark never blocks the session.
 */
export function saveStartMark(dir, input) {
  if (typeof input?.session_id !== "string" || !input.session_id || "agent_id" in input) return undefined;
  const file = markFile(dir, input.session_id);
  try {
    privateDirectory(dir);
    privateDirectory(join(dir, "marks"));
    saveState(file, { session: input.session_id, source: input.source, lines: recordLines(input.transcript_path), pid: process.ppid });
    return undefined;
  } catch (error) {
    try { unlinkSync(file); } catch { /* No older mark, or the folder cannot change. */ }
    return `sage: the sage hook could not save its note of this session start, so autopilot merges nothing until the session starts again. Check that sage can write to the folder ${dir}${error.code ? ` (${error.code})` : ""}.`;
  }
}
