import { appendFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { messageMiss, readModeFile } from "../core/index.mjs";
import { modeDirectory, privateDirectory, readState, saveState, stateKey } from "./hook-state.mjs";

const noteFile = (dir, key) => join(dir, "notes", `${key}.json`);
const dropNote = (dir, key) => { try { unlinkSync(noteFile(dir, key)); } catch {} };
export const missesFile = (dir) => join(dir, "message-misses.jsonl");

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
  } catch {}
  return undefined;
}

export function takeNote(dir, key) {
  try {
    const { note } = readState(noteFile(dir, key));
    return typeof note === "string" ? note : undefined;
  } catch { return undefined; } finally { dropNote(dir, key); }
}
