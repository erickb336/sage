import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";

export const PRIORITIES = ["P0", "P1", "P2", "P3"];
export const PRIORITY_SCALE = "A task needs a priority: P0 the owner's current focus and what blocks it; P1 next: function or safety bugs, work in flight, pre-pilot items; P2 later: polish, hardening lows, follow-ups; P3 parked but kept.";
export const TASK_KINDS = ["design", "ui", "orchestration", "optimization", "bug-fix", "logbook", "docs", "security", "providers", "checks"];
export const FINDING_CLASSES = ["state-edge", "speed", "copy", "layout", "security", "other"];
export const NAME_MAX = 60;
export const TASK_ADDED = "task added";
export function boardAnswer(gate) {
  if (!gate || gate.answer) return null;
  try {
    const a = JSON.parse(gate.answered || "null");
    return a && typeof a === "object" && a.via === "board" && typeof a.at === "string" && typeof a.answer === "string" && a.answer ? a : null;
  } catch { return null; }
}
export const gateDigest = (gate) => createHash("sha256").update(JSON.stringify([gate.id, gate.task, gate.question, gate.options])).digest("hex").slice(0, 16);

const NUMERIC = /^\s*[+-]?(\d+(\.\d*)?|\.\d+)(e[+-]?\d+)?\s*$/i;
export function countOf(value, { floor = 1, limit = 50, up = false } = {}) {
  const n = typeof value === "number" || (typeof value === "string" && NUMERIC.test(value)) ? Number(value) : NaN;
  return Number.isFinite(n) ? Math.min(Math.max(up ? Math.ceil(n) : Math.floor(n), floor), limit) : undefined;
}
export const AGENT_CAPS = { max_agents: 10, max_leads: 5, cap_total: 20 };
export function agentCaps(config) {
  const c = config && typeof config === "object" && !Array.isArray(config) ? config : {};
  const max = countOf(c.max_agents) ?? AGENT_CAPS.max_agents;
  return { total: countOf(c.cap_total) ?? AGENT_CAPS.cap_total, cap: project => countOf(c[`cap.${project}`]) ?? max };
}
export function agentLimit(logbook, roots, names) {
  const held = countOf(logbook?.max_agents);
  if (held !== undefined) return held;
  const set = roots.flatMap(c => names.map(n => countOf(c?.[`cap.${n}`]) ?? countOf(c?.max_agents))).filter(v => v !== undefined);
  return set.length ? Math.max(...set) : AGENT_CAPS.max_agents;
}
export const ADMIT_LEASE_MS = 10 * 60_000;
export const queueOrder = runs => runs.filter(run => run.status === "queued").sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));

export const HIDDEN = /[\0-\x08\x0b-\x1f\x7f-\x9f\u061c\u200b\u200e\u200f\u2060\ufeff\ufe00-\ufe0e\u202a-\u202e\u2066-\u2069\u{e0000}-\u{e007f}\u{e0100}-\u{e01ef}]|(?<![\p{Extended_Pictographic}0-9#*])\ufe0f|(?<![\p{L}\p{M}](?=[\u200c\u200d]\p{L})|[\p{Extended_Pictographic}\p{Emoji_Modifier}]\ufe0f?(?=\u200d\p{Extended_Pictographic}))[\u200c\u200d]/gu;
export const LINE = "\u2028";
export const BREAKS = /[\n\r\u0085\u2028\u2029]/g;
const FIRST_LINE = /^Approve (?:milestone (M[1-9]\d*)|program (PG[1-9]\d*))[ ?]/;
export const proposalOf = (gate, renamed) => {
  const [, id, old] = FIRST_LINE.exec(gate?.question ?? "") ?? [];
  return id ?? renamed?.get(old);
};
export const breakdownLine = (gate) => FIRST_LINE.test(gate?.question ?? "");
const BLANK = /[\u034f\u115f\u1160\u3164\uffa0\u2800\u2028\u2029]/u;
const MARKS_MAX = 3;

export function nameProblem(name, max = NAME_MAX) {
  if (typeof name !== "string") return "is not text";
  const length = [...name].length;
  if (!length || length > max) return `has ${length} characters: give 1 to ${max}`;
  if (name.normalize("NFC") !== name) return "is not in the composed Unicode form (NFC)";
  if (/^\s|\s$|\s\s/u.test(name)) return "has a space at its start or end, or two spaces together";
  if (name.replace(HIDDEN, "") !== name || /[\p{Cc}\p{Co}\p{Cn}]|(?![\u200c\u200d])\p{Cf}/u.test(name) || BLANK.test(name)) return "has a control, format or hidden character (such as a tab, a line break, a zero-width space or a right-to-left mark)";
  if (new RegExp(`\\p{M}{${MARKS_MAX + 1}}`, "u").test(name)) return `has more than ${MARKS_MAX} combining marks in a row`;
  if (!/[\p{L}\p{N}\p{P}\p{S}]/u.test(name)) return "has no visible character";
  return null;
}

export const TABLES = {
  tasks: ["id", "title", "size", "risk", "route", "state", "branch", "pr", "round", "keys", "hold", "extra", "priority", "kind", "waits", "milestone", "adoption", "approvals"],
  runs: ["id", "task", "role", "round", "candidate", "branch", "status", "tokens", "report", "started", "ended", "model", "usage_provider", "usage_interface", "usage_capability", "usage_binding", "usage_reason", "usage_basis", "usage_status", "usage_source", "usage_evidence"],
  findings: ["task", "key", "round", "source", "severity", "summary", "triage", "reason", "status", "run", "class"],
  ledger: ["task", "pr", "sha", "kind", "cycle", "run", "at"],
  gates: ["id", "task", "question", "options", "recommendation", "default", "answer", "at"],
  decisions: ["at", "task", "decision", "why"],
  milestones: ["id", "name", "goal", "pilot", "gate", "at"],
  releases: ["name", "goal", "at"],
};

export const START_SAGE_MODE = "sage-mode";

export function logbookSettings(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) return { name: null, archived: false, sageModeStart: false, limit: null, warnings: ["config: config is not an object"] };
  const why = config.name === undefined ? null : nameProblem(config.name);
  const warnings = [
    ...(why ? [`config: the name ${why}`] : []),
    ...(config.archived !== undefined && typeof config.archived !== "boolean" ? ["config: archived is not true or false"] : []),
    ...(config.start !== undefined && config.start !== START_SAGE_MODE ? [`config: start is not "${START_SAGE_MODE}"`] : []),
  ];
  return { name: config.name === undefined || why ? null : config.name, archived: config.archived === true, sageModeStart: config.start === START_SAGE_MODE, limit: countOf(config.max_agents) ?? null, warnings };
}

export function startsInSageMode(logbook) {
  let fd;
  try {
    fd = openSync(join(logbook, "config.json"), constants.O_RDONLY | constants.O_NONBLOCK);
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > 64 * 1024) return false;
    const bytes = Buffer.alloc(info.size);
    const read = readSync(fd, bytes, 0, info.size, 0);
    return logbookSettings(JSON.parse(bytes.toString("utf8", 0, read))).sageModeStart;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
