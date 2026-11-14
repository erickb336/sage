import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { CHIEF } from "./chiefs.mjs";
import { nameProblem } from "./logbook-fields.mjs";
import { plainName } from "./shared-root.mjs";

export const BEAT_MS = 60_000;
export const STOPPED_MS = 30 * 60_000;
export const SKEW_MS = 5 * 60_000;
export const NAMES_FILE = "chief-names.json";
export const LIVE_FOLDER = "live";

export function chiefBeat({ last, mode, now, project, native, provider, tool, env }) {
  const changed = last ? last.sageMode !== mode.sageMode || last.autopilot !== mode.autopilot : mode.sageMode, age = now - last?.at;
  if (!changed && (!last || (age >= 0 && age < BEAT_MS))) return last;
  try {
    const { dir, shared, row } = tool.locate(project, env);
    if (shared) {
      const chief = tool.chiefFor(project, native, env), live = join(dir, LIVE_FOLDER), file = join(live, `${chief}.json`), temp = `${file}.${randomUUID()}`;
      try { mkdirSync(live); } catch (error) { if (error.code !== "EEXIST") throw error; }
      if (lstatSync(live).isDirectory()) {
        try {
          writeFileSync(temp, `${JSON.stringify({ provider, checkout: row.root, ...mode, at: new Date(now).toISOString() })}\n`, { flag: "wx" });
          renameSync(temp, file);
        } finally { rmSync(temp, { force: true }); }
      }
    }
  } catch {}
  return { ...mode, at: now };
}

const flag = (value) => (typeof value === "boolean" ? value : null);
export function liveRecord(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const at = typeof data.at === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(data.at) ? Date.parse(data.at) : NaN;
  return { checkout: typeof data.checkout === "string" && isAbsolute(data.checkout) ? data.checkout : null, sageMode: flag(data.sageMode), autopilot: flag(data.autopilot), at: Number.isFinite(at) ? at : null };
}

export function chiefNames(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("not a JSON object");
  const names = {}, bad = [];
  for (const [id, name] of Object.entries(data)) {
    if (CHIEF.test(id) && !nameProblem(name)) names[id] = name;
    else bad.push(`the name of ${CHIEF.test(id) ? id : "a key that is no chief id"} is not valid`);
  }
  return { names, bad };
}

const title = (text) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
const utc = (at) => (Number.isFinite(Date.parse(at)) ? `${new Date(at).toISOString().slice(0, 16).replace("T", " ")} UTC` : null);
export function defaultChiefName(row, live) {
  return [title(row.provider), live?.checkout && plainName(basename(live.checkout)), utc(row.at)].filter(Boolean).join(" · ");
}

export function boardChiefs({ rows, live = {}, names = {}, runs = [], now }) {
  return rows.map((row) => {
    const record = live[row.id] ?? null, beat = record?.at != null && record.at - now > SKEW_MS ? null : record, heartbeat = beat?.at ?? null;
    const running = runs.filter((run) => run.chief === row.id && run.status === "running" && !run.clock?.stale).length;
    return {
      id: row.id, provider: row.provider, name: names[row.id] ?? defaultChiefName(row, beat), named: Object.hasOwn(names, row.id), startedAt: utc(row.at) ? new Date(row.at).toISOString() : null,
      checkout: beat?.checkout ?? null, sageMode: beat?.sageMode ?? null, autopilot: beat?.autopilot ?? null, heartbeat: heartbeat === null ? null : new Date(heartbeat).toISOString(), running,
      stopped: running ? false : heartbeat === null ? null : now - heartbeat > STOPPED_MS,
    };
  });
}
