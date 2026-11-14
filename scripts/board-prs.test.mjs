import "./test-env.mjs";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildBoardModel } from "../packages/sage-core/board-model.mjs";
import { boardOverview } from "../packages/sage-core/board-overview.mjs";
import { readBoardSources } from "../packages/sage-core/board-reader.mjs";
import { landingRule } from "../packages/sage-core/board-view.mjs";
import { writeTasksLogbook } from "./fixtures/board-app.mjs";

const NOW = "2026-11-13T12:00:00.000Z";
const KEY = id => `shared/sample-app-abc123/${id}`;
const REPOSITORY = "https://github.com/sample-owner/sample-app";

function rows(t, edit = null) {
  const dir = mkdtempSync(join(tmpdir(), "sage-board-prs-")), before = process.env.SAGE_WORKTREES;
  process.env.SAGE_WORKTREES = join(dir, "worktrees");
  t.after(() => { if (before === undefined) delete process.env.SAGE_WORKTREES; else process.env.SAGE_WORKTREES = before; rmSync(dir, { recursive: true, force: true }); });
  const logbook = writeTasksLogbook(join(dir, "logbooks"), join(dir, "worktrees"), NOW, { prs: true });
  if (edit) writeFileSync(join(logbook, "tasks.tsv"), edit(readFileSync(join(logbook, "tasks.tsv"), "utf8")));
  const sources = [{ id: "shared", path: join(dir, "logbooks"), label: "Shared" }];
  const { tasks } = boardOverview(buildBoardModel(readBoardSources(sources, { now: Date.parse(NOW) }), { now: NOW, landing: landingRule(sources) }));
  return id => tasks.find(task => task.id === id);
}

const pick = task => ({ word: task.word, prUrl: task.prUrl, ci: task.ci, cycles: task.cycles, why: task.why });

test("T1063: each PR row carries its GitHub link, clean cycles, CI state from the ledger, and the reason it waits", t => {
  const row = rows(t);
  assert.deepEqual(pick(row("T5")), { word: "in progress", prUrl: `${REPOSITORY}/pull/14`, ci: "pass", cycles: { required: 1, clean: 1, reviews: true }, why: null }, "verified, the merge check passes and autopilot is on: ready to merge");
  assert.deepEqual(pick(row("T3")), { word: "in progress", prUrl: `${REPOSITORY}/pull/12`, ci: "pass", cycles: { required: 1, clean: 0, reviews: true }, why: null }, "in review: CI passes, QA still runs");
  assert.deepEqual(pick(row("T8")), { word: "needs you", prUrl: `${REPOSITORY}/pull/17`, ci: "fail", cycles: { required: 1, clean: 0, reviews: true }, why: "Checks failed on the recorded PR head." });
  assert.equal(row("T6").ci, null, "no checks verdict on the PR's head: CI is not known, not passing");
  assert.equal(row("T7").ci, null, "repairing: the ledger has no verdict on a new head yet");
  assert.equal(row("T7").prUrl, null, "no PR record names its repository, so the board makes no link");
  assert.equal(row("T9").doneAt, "2026-11-13T07:00:00.000Z", "merged 5 hours before now");
  assert.equal(row("T9").ci, "pass");
});

test("T1063: each row lists the tasks it waits for, met or not, so the page can draw the links", t => {
  const row = rows(t);
  assert.deepEqual(row("T6").waitsFor, [{ key: KEY("T5"), id: "T5", met: false }, { key: KEY("T1"), id: "T1", met: true }], "T5 by its waits cell, T1 as the pilot of M1");
  assert.equal(row("T6").waits, "Waits for T5 (in progress).");
  assert.deepEqual(row("T13").waitsFor.filter(wait => !wait.met), [{ key: KEY("T6"), id: "T6", met: false }]);
  assert.equal(row("T13").pr, null);
  assert.deepEqual(row("T8").waitsFor, []);
  assert.deepEqual(row("T8").conflicts.map(other => other.id), ["T3"], "T8 (C1) and T3 (C2) change src/shared.js");
});

test("T1063: a PR cell that is not a whole number gets no link", t => {
  const row = rows(t, text => text.replace(/\t14\t/, "\t14/../../evil\t"));
  assert.equal(row("T5").pr, "14/../../evil");
  assert.equal(row("T5").prUrl, null);
  assert.equal(row("T3").prUrl, `${REPOSITORY}/pull/12`);
});
