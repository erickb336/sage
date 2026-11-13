import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TABLES } from "../../packages/sage-core/logbook-fields.mjs";

const HOUR = 3_600_000;
const breakdown = (id, name, pilot) => [`Approve milestone ${id}? No task builds before you approve.`, `Name: ${name}`, "Goal: Sample goal.", "Pilot, runs first:", `  ${pilot}: Sample ${pilot}`].join(" ");

export function appTables(now) {
  const at = hours => new Date(Date.parse(now) - hours * HOUR).toISOString();
  const task = (id, title, state, extra = {}) => ({ id, title, size: "small", risk: "", route: "build,code-review,qa", state, branch: "", pr: "", round: "0", keys: "", hold: "", extra: "", priority: "", kind: "", waits: "", milestone: "", adoption: "", approvals: "", ...extra });
  const run = (id, on, role, status, started, ended = "") => ({ id, task: on, role, round: "0", candidate: "", branch: "", status, tokens: "", report: "", started: at(started), ended: ended === "" ? "" : at(ended) });
  const gate = (id, on, question, options, recommendation, answer, asked) => ({ id, task: on, question, options, recommendation, default: "", answer, at: at(asked) });
  return {
    tasks: [
      task("T1", "Sample pinned bundle", "merged", { milestone: "M1", priority: "P1" }),
      task("T2", "Sample chief records", "building", { milestone: "M1", priority: "P1" }),
      task("T3", "Sample shared limits", "reviewing", { milestone: "M1", priority: "P2", pr: "12" }),
      task("T4", "Sample queue", "framed", { milestone: "M1", priority: "P2", waits: "T2" }),
      task("T10", "Sample sync design", "awaiting-you", { milestone: "M2", priority: "P0" }),
      task("T11", "Sample sync build", "framed", { milestone: "M2", priority: "P0", waits: "T10" }),
      task("T20", "Sample sign-in screen", "merged", { milestone: "M3", priority: "P1" }),
      task("T21", "Sample passkeys", "merged", { milestone: "M3", priority: "P1" }),
      task("T30", "Sample crash reports", "awaiting-you", { priority: "P2" }),
    ],
    runs: [run("R1", "T2", "implementer", "failed", 3, 1), run("R2", "T3", "code-reviewer", "running", 0.5)],
    gates: [
      gate("G1", "T1", breakdown("M1", "Board redesign", "T1"), "approve|change|drop", "approve", "approve", 72),
      gate("G2", "T10", breakdown("M2", "Offline sync", "T10"), "approve|change|drop", "approve", "approve", 70),
      gate("G3", "T20", breakdown("M3", "Sign-in rework", "T20"), "approve|change|drop", "approve", "approve", 96),
      gate("G4", "T10", "Can a viewer copy a shared list into their own lists?", "A: yes, as a new private list|B: no", "A: yes, as a new private list", "", 3),
      gate("G5", "T30", "Crash reports: send them on their own, or ask each time?", "A: ask each time|B: send them", "A: ask each time", "", 0.7),
    ],
    decisions: [
      { at: at(2), task: "T1", decision: "state merged", why: "sample" },
      { at: at(50), task: "T20", decision: "state merged", why: "sample" },
      { at: at(30), task: "T21", decision: "state merged", why: "sample" },
      { at: at(1), task: "T30", decision: "added crash report question", why: "sample" },
    ],
    milestones: [
      { id: "M1", name: "Board redesign", goal: "One board for every chief", pilot: "T1", gate: "G1", at: at(72) },
      { id: "M2", name: "Offline sync", goal: "Edits made offline reach the server safely", pilot: "T10", gate: "G2", at: at(70) },
      { id: "M3", name: "Sign-in rework", goal: "Passkeys and clearer session messages", pilot: "T20", gate: "G3", at: at(96) },
    ],
    findings: [],
    ledger: [],
  };
}

export function writeAppLogbook(root, now) {
  const project = join(root, "sample-app-abc123");
  mkdirSync(project, { recursive: true });
  for (const [name, rows] of Object.entries(appTables(now))) {
    const columns = TABLES[name];
    writeFileSync(join(project, `${name}.tsv`), [columns.join("\t"), ...rows.map(row => columns.map(column => row[column] ?? "").join("\t"))].join("\n") + "\n");
  }
  return project;
}
