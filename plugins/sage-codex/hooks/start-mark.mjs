// The start mark of a Codex session (T663): where this start of the session begins in Codex's record, and which Codex
// process started it. A resume writes no session_meta line into the record (T662 proof, case 5c), so the owner record
// reader counts only the owner's messages after the mark. The SessionStart hooks write it for startup, resume, clear
// (session-start-hook.mjs) and fork (sage-codex-hook.mjs), never for compact: a compaction is no new start. Text for
// the user calls the mark sage's "note of this session start".
//   - Only the root thread's start saves a mark. Codex's review and guardian threads send events with the root session
//     id and no agent_id, but their own record: the gate's threadOf tells them apart, and their start changes no mark.
//   - Startup, clear and fork start a new record (a new thread id), which Codex may not have written yet: then the
//     mark is line 0, as the reader starts at the record's session_meta anyway. A resume continues a record that
//     holds the earlier starts, so a resume (or a session that has a mark already) whose record the hook cannot show
//     to be the root thread's saves no mark. Then, and when a save fails, the hook removes the older mark, so that the
//     reader refuses, and gives a limit line.
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { threadOf } from "./gate-hook.mjs";
import { privateDirectory, saveState, stateKey } from "./principles-hook.mjs";

/** The mark file of the session's root thread, in the mode folder dir. */
export const markFile = (dir, sessionId) => join(dir, "marks", `${stateKey({ session_id: sessionId })}.json`);

/** The count of lines in the record now (a partial last line counts), or 0 when Codex has not written it yet. */
function recordLines(path) {
  if (path === null) return 0;
  let bytes;
  try { bytes = readFileSync(path); } catch (error) { if (error.code === "ENOENT") return 0; throw error; }
  let lines = bytes.length && bytes.at(-1) !== 10 ? 1 : 0;
  for (let i = bytes.indexOf(10); i >= 0; i = bytes.indexOf(10, i + 1)) lines++;
  return lines;
}

const limit = (cause, step) => `sage: the sage hook could not ${cause}, so autopilot merges nothing until the session starts again. ${step}.`;

/**
 * Save the start mark of one SessionStart event of the root thread, with an atomic rename. It returns undefined, or a
 * limit line for the user when it saves no mark: then it also removes an older mark of the session, so that no stale
 * boundary stays. It never throws, so a failed mark never blocks the session.
 */
export function saveStartMark(dir, input) {
  if (typeof input?.session_id !== "string" || !input.session_id || "agent_id" in input) return undefined;
  const file = markFile(dir, input.session_id);
  const path = typeof input.transcript_path === "string" && input.transcript_path ? input.transcript_path : null;
  const thread = threadOf({ session: input.session_id, child: false, transcript: path });
  if (thread.child && !thread.unread) return undefined; // another thread of the session (F-T663-10)
  const remove = () => { try { unlinkSync(file); } catch { /* No older mark, or the folder cannot change. */ } };
  let lines;
  try {
    lines = recordLines(path);
    if ((thread.unread || path === null) && (input.source === "resume" || existsSync(file))) throw new Error("no record of the root thread");
  } catch (error) {
    remove();
    return limit("read Codex's record of this session", `Start or resume the session again${error.code ? ` (${error.code})` : ""}`);
  }
  let folder = dir;
  try {
    privateDirectory(dir);
    folder = join(dir, "marks");
    privateDirectory(folder);
    saveState(file, { session: input.session_id, source: input.source, lines, pid: process.ppid });
    return undefined;
  } catch (error) {
    remove();
    return limit("save its note of this session start", `Check that sage can write to the folder ${folder}${error.code ? ` (${error.code})` : ""}, then start or resume the session again`);
  }
}
