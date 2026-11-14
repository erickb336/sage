import { closeSync, existsSync, fstatSync, openSync, readSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";
import { threadOf } from "./gate-hook.mjs";
import { privateDirectory, readState, saveState, stateKey } from "./hook-state.mjs";
import { RECORD_BUDGET } from "./owner-record.mjs";

export const markFile = (dir, sessionId) => join(dir, "marks", `${stateKey({ session_id: sessionId })}.json`);

function recordLines(path) {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size, bytes = Buffer.alloc(RECORD_BUDGET.chunk);
    const deadline = performance.now() + RECORD_BUDGET.milliseconds;
    let lines = 0, offset = 0, last;
    while (offset < size) {
      if (performance.now() >= deadline) throw Object.assign(new Error("scan deadline"), { code: "scan deadline" });
      const n = readSync(fd, bytes, 0, Math.min(bytes.length, size - offset), offset);
      if (n <= 0) throw Object.assign(new Error("short read"), { code: "short read" });
      for (let i = bytes.indexOf(10); i >= 0 && i < n; i = bytes.indexOf(10, i + 1)) lines++;
      last = bytes[n - 1];
      offset += n;
    }
    return lines + (size && last !== 10 ? 1 : 0);
  } finally { closeSync(fd); }
}

const limit = (cause, step) => `sage: the sage hook could not ${cause}, so autopilot merges nothing in this session for now. ${step}, then send "autopilot on" again.`;

export function saveStartMark(dir, input, sage = false) {
  if (typeof input?.session_id !== "string" || !input.session_id || "agent_id" in input) return undefined;
  const file = markFile(dir, input.session_id);
  const path = typeof input.transcript_path === "string" && input.transcript_path ? input.transcript_path : null;
  const thread = threadOf({ session: input.session_id, child: false, transcript: path });
  if (thread.child && !thread.unread) return undefined;
  const remove = () => { try { unlinkSync(file); } catch {} };
  const unread = (code) => {
    remove();
    return limit("read Codex's record of this session", `Start or resume the session again${code ? ` (${code})` : ""}`);
  };
  const own = path !== null && basename(path).endsWith(`-${input.session_id}.jsonl`);
  if (path === null || (thread.unread && !own)) {
    if (input.source !== "resume") return undefined;
    if (path === null) return unread();
  }
  let lines;
  try {
    lines = recordLines(path);
    if (thread.unread && !own) return unread();
  } catch (error) {
    if (error.code !== "ENOENT" || input.source === "resume") return unread(error.code);
    lines = 0;
  }
  let folder = dir;
  try {
    privateDirectory(dir);
    folder = join(dir, "marks");
    privateDirectory(folder);
    let started = sage;
    if (input.source === "resume") try { started = readState(file).sage === true; } catch { started = false; }
    saveState(file, { session: input.session_id, source: input.source, lines, pid: process.ppid, ...(started ? { sage: true } : {}) });
    return undefined;
  } catch (error) {
    remove();
    if (folder !== dir && !existsSync(folder)) folder = dir;
    return limit("save its note of this session start", `Check that sage can write to the folder ${folder}${error.code ? ` (${error.code})` : ""}, then start or resume the session again`);
  }
}
