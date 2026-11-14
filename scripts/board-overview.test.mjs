import "./test-env.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { buildBoardModel } from "../packages/sage-core/board-model.mjs";
import { boardOverview } from "../packages/sage-core/board-overview.mjs";
import { boardChiefs } from "../packages/sage-core/chief-live.mjs";
import { appTables } from "./fixtures/board-app.mjs";

const NOW = "2026-11-13T12:00:00.000Z";
const source = (tables = appTables(NOW)) => ({ id: "claude", label: "claude", provider: null, config: {}, diagnostics: [], hooks: { present: false, slots: [], helpers: [], problem: null },
  projects: [{ key: "claude/sample-app-abc123", source: "claude", name: "sample-app-abc123", checkout: "/sample/app", displayName: "sample app", diagnostics: [], warnings: [], tables, observations: { version: 1, records: [] } }] });
const overview = (tables, now = NOW) => boardOverview(buildBoardModel([source(tables)], { now }));

test("T1054: Needs you lists each open question oldest first, with its recommendation, gate, task and the time it was asked", () => {
  const { needs } = overview();
  assert.deepEqual(needs.map(need => [need.gate, need.question, need.recommendation, need.task.id, need.askedAt]), [
    ["G4", "Can a viewer copy a shared list into their own lists?", "A: yes, as a new private list", "T10", "2026-11-13T09:00:00.000Z"],
    ["G5", "Crash reports: send them on their own, or ask each time?", "A: ask each time", "T30", "2026-11-13T11:18:00.000Z"],
  ]);
});

test("T1054: a milestone problem that is not a gate is in Needs you too, with no invented time", () => {
  const tables = appTables(NOW);
  tables.tasks = tables.tasks.map(task => task.id === "T20" ? { ...task, state: "abandoned" } : task);
  tables.milestones = tables.milestones.map(milestone => milestone.id === "M3" ? { ...milestone, pilot: "T20" } : milestone);
  tables.tasks.push({ ...tables.tasks.find(task => task.id === "T21"), id: "T22", state: "framed" });
  const stuck = overview(tables).needs.find(need => need.kind === "stuck");
  assert.equal(stuck.question, "Milestone 3: Sign-in rework is stuck");
  assert.equal(stuck.askedAt, null);
  assert.equal(stuck.milestone, "claude/sample-app-abc123/M3", "F-T1061-26: the need names its milestone, so it can link to it");
});

test("T1054: milestones come by the top priority of their open tasks, with progress; a done milestone shows for 7 days", () => {
  const rows = overview().milestones.map(m => [m.id, m.priority, m.state, m.merged, m.total, m.moving, m.waiting, m.needsYou]);
  assert.deepEqual(rows, [
    ["M2", "P0", "active", 0, 2, 1, 1, 1],
    ["M1", "P1", "active", 1, 4, 2, 1, 0],
    ["M3", null, "done", 2, 2, 0, 0, 0],
  ]);
  const later = overview(undefined, "2026-11-19T12:00:00.000Z");
  assert.deepEqual(later.milestones.map(m => m.id), ["M2", "M1"], "M3's last task merged 30 h before NOW, so it leaves after 7 days");
  assert.equal(later.hiddenDone, 1);
});

test("T1054: the counts cover the last 24 hours: a merge 2 h ago counts and one 30 h ago does not; a failed run counts as stuck", () => {
  const { counts, next } = overview();
  assert.deepEqual(counts, { merged: 1, stuck: 1, stuckNow: 0, added: null });
  assert.equal(next, Date.parse("2026-11-14T10:00:00.000Z") + 1, "T1's merge leaves the window first");
  assert.deepEqual(overview(undefined, "2026-11-14T13:00:00.000Z").counts, { merged: 0, stuck: 0, stuckNow: 0, added: null });
});

test("T1054: a stale model says so, with its problems", () => {
  const model = { ...buildBoardModel([source()], { now: NOW }), stale: true, diagnostics: [{ source: "claude", message: "tasks: the file cannot be read" }] };
  const result = boardOverview(model);
  assert.equal(result.stale, true);
  assert.deepEqual(result.problems, ["tasks: the file cannot be read"]);
  assert.equal(result.milestones.length, 3, "the last good data stays");
});

test("F-T1059-10: a chief that waits for the owner sets no refresh time, so the board still refreshes when another live chief stops", () => {
  const now = Date.parse(NOW), iso = ms => new Date(ms).toISOString();
  const rows = [{ id: "C1", provider: "claude", at: iso(now - 5 * 3600_000) }, { id: "C2", provider: "codex", at: iso(now - 5 * 3600_000) }];
  const live = { C1: { checkout: "/sample/a", sageMode: true, autopilot: false, at: now - 2 * 3600_000 }, C2: { checkout: "/sample/b", sageMode: true, autopilot: false, at: now - 60_000 } };
  const chiefs = boardChiefs({ rows, live, runs: [], waits: ["C1"], now }).map(chief => ({ key: `claude/sample-app-abc123/${chief.id}`, ...chief }));
  assert.deepEqual(chiefs.map(chief => [chief.id, chief.waitsForOwner, chief.stopped]), [["C1", true, false], ["C2", false, false]]);
  const { next } = boardOverview({ at: NOW, tasks: [], needsOwner: [], milestones: [], projects: [{ name: "sample-app", chiefs }], agents: { projects: [] } });
  assert.equal(next, now - 60_000 + 30 * 60_000 + 1, "the next refresh is when C2 stops: 30 minutes after its last event");
});
