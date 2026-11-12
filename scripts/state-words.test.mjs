// T1002: the six state words of a task, a milestone and a release (the T995 design, gate G141, with the PE's corrections),
// read from real board cards, and the agreement of "needs you" with the board's Needs you box. SAMPLE DATA only.
import test from "node:test";
import assert from "node:assert/strict";
import { buildBoardModel, milestoneWord, releaseWord, taskWord } from "../packages/sage-core/index.mjs";
import { NOW as MILESTONES_NOW, milestonesSource } from "./fixtures/board-milestones.mjs";

const SIX = ["not started", "waiting", "needs you", "in progress", "done", "stopped"];
const now = "2026-10-08T20:00:00.000Z", head = "a".repeat(40);
const task = (id, state, extra = {}) => ({ id, title: "Sample", size: "small", risk: "", route: "build,code-review,qa", state, branch: "", pr: "", round: "0", keys: "", ...extra });
const observation = (kind, data) => ({ id: "O1", task: "T1", kind, source: "sample recorder", basis: "observed", observedAt: now, recordedAt: now, data });
const gate = (answer = "") => ({ id: "G1", task: "T1", question: "Sample: which layout?", recommendation: "the first", answer });
const clean = ["checks-pass", "review-clean", "qa-pass"].map(kind => ({ task: "T1", pr: "41", sha: head, kind, cycle: "1", at: now }));
const autopilot = on => [observation("pr", { number: 41, head, state: "open" }), observation("mode", { autopilot: on })];
// A failed verdict on the head after a clean one (as in T294): the board shows it only while the merge check does not pass.
const failed = kind => [...clean, { task: "T1", pr: "41", sha: head, kind, cycle: "1", at: now }];
const passes = () => ({ ok: true, reason: "" });
const refuses = () => ({ ok: false, reason: "T1 has open findings: F-T1-1. Fix them." });
/** The board model of one logbook: T1 and the tasks it waits for. */
const model = ({ row, others = [], gates = [], ledger = [], records = [], landing = passes }) =>
  buildBoardModel([{ id: "one", label: "one", diagnostics: [], config: {}, projects: [{ key: "one/sample-abcdef", name: "sample-abcdef", diagnostics: [], tables: { tasks: [row, ...others], gates, ledger }, observations: { version: 1, records } }] }], { now, landing });

// Each recorded state, each edge case F1 to F6 and each PE correction: the fixture, then the word that the design gives.
const CASES = [
  ["framed: no agent works on it", { row: task("T1", "framed") }, "not started"],
  ["framed with an unmet wait", { row: task("T1", "framed", { waits: "T2" }), others: [task("T2", "building")] }, "waiting"],
  ["framed with a wait that is never met: it cannot start", { row: task("T1", "framed", { waits: "T2" }), others: [task("T2", "abandoned")] }, "waiting"],
  ["designing", { row: task("T1", "designing") }, "in progress"],
  ["PE: designing with an unmet wait", { row: task("T1", "designing", { waits: "T2" }), others: [task("T2", "building")] }, "in progress"],
  ["awaiting-you with no gate", { row: task("T1", "awaiting-you") }, "needs you"],
  ["awaiting-you with an open gate", { row: task("T1", "awaiting-you"), gates: [gate()] }, "needs you"],
  ["F2: awaiting-you after the owner answered", { row: task("T1", "awaiting-you"), gates: [gate("the first")] }, "in progress"],
  ["briefed", { row: task("T1", "briefed") }, "in progress"],
  ["F3: briefed with an unmet wait", { row: task("T1", "briefed", { waits: "T2" }), others: [task("T2", "reviewing")] }, "waiting"],
  ["building", { row: task("T1", "building") }, "in progress"],
  ["F4: held by the chief, no open gate", { row: task("T1", "held") }, "in progress"],
  ["F4: held after repair rounds, no open gate yet", { row: task("T1", "held", { hold: "round", round: "3" }) }, "in progress"],
  ["F4: held after repair rounds, with an open gate", { row: task("T1", "held", { hold: "round", round: "3" }), gates: [gate()] }, "needs you"],
  ["reviewing", { row: task("T1", "reviewing", { pr: "41" }) }, "in progress"],
  ["repairing", { row: task("T1", "repairing", { pr: "41" }) }, "in progress"],
  ["replan with no open gate", { row: task("T1", "replan") }, "in progress"],
  ["replan with an open gate", { row: task("T1", "replan"), gates: [gate()] }, "needs you"],
  ["verifying", { row: task("T1", "verifying", { pr: "41" }) }, "in progress"],
  ["verified, autopilot on", { row: task("T1", "verified", { pr: "41" }), ledger: clean, records: autopilot(true) }, "in progress"],
  ["PE: verified, autopilot off", { row: task("T1", "verified", { pr: "41" }), ledger: clean, records: autopilot(false) }, "needs you"],
  ["PE: verified, autopilot unknown", { row: task("T1", "verified", { pr: "41" }), ledger: clean, records: autopilot(true).slice(0, 1) }, "needs you"],
  ["pr-ready, autopilot on", { row: task("T1", "pr-ready", { pr: "41" }), ledger: clean, records: autopilot(true) }, "in progress"],
  ["PE: pr-ready, autopilot off", { row: task("T1", "pr-ready", { pr: "41" }), ledger: clean, records: autopilot(false) }, "needs you"],
  ["F5: verified, the merge check refuses the head", { row: task("T1", "verified", { pr: "41" }), ledger: clean, records: autopilot(false), landing: refuses }, "in progress"],
  ["F5: pr-ready, the merge check refuses the head", { row: task("T1", "pr-ready", { pr: "41" }), ledger: clean, records: autopilot(true), landing: refuses }, "in progress"],
  ["F5: verified, refused, QA failed, autopilot on", { row: task("T1", "verified", { pr: "41" }), ledger: failed("qa-fail"), records: autopilot(true), landing: refuses }, "in progress"],
  ["F5: verified, refused, QA failed, autopilot off", { row: task("T1", "verified", { pr: "41" }), ledger: failed("qa-fail"), records: autopilot(false), landing: refuses }, "in progress"],
  ["F5: pr-ready, refused, checks failed, autopilot on", { row: task("T1", "pr-ready", { pr: "41" }), ledger: failed("checks-fail"), records: autopilot(true), landing: refuses }, "in progress"],
  ["F5: pr-ready, refused, checks failed, autopilot off", { row: task("T1", "pr-ready", { pr: "41" }), ledger: failed("checks-fail"), records: autopilot(false), landing: refuses }, "in progress"],
  ["verified with no build: the chief concludes it", { row: task("T1", "verified", { route: "investigate,evidence-review" }) }, "in progress"],
  ["merged", { row: task("T1", "merged", { pr: "41" }) }, "done"],
  ["concluded", { row: task("T1", "concluded", { route: "investigate,evidence-review" }) }, "done"],
  ["abandoned", { row: task("T1", "abandoned") }, "stopped"],
  ["an open gate on any state that has not ended", { row: task("T1", "building"), gates: [gate()] }, "needs you"],
  ["a done task with an open gate keeps its word", { row: task("T1", "merged", { pr: "41" }), gates: [gate()], records: [observation("completion", { state: "merged", at: now })] }, "done"],
  ["a stopped task with an open gate keeps its word", { row: task("T1", "abandoned"), gates: [gate()] }, "stopped"],
];
const cardOf = fixture => model(fixture).tasks.find(card => card.id === "T1");

test("T1002: each recorded state and edge case gives the design's word", () => {
  assert.deepEqual(CASES.map(([name, fixture]) => [name, taskWord(cardOf(fixture)).word]), CASES.map(([name, , word]) => [name, word]));
});

test("T1002: the case table covers all 15 recorded states, and every word is one of the six with a reason", () => {
  const STATES = ["framed", "designing", "awaiting-you", "briefed", "building", "held", "reviewing", "repairing", "replan", "verifying", "verified", "pr-ready", "merged", "concluded", "abandoned"];
  assert.deepEqual([...new Set(CASES.map(([, fixture]) => fixture.row.state))].sort(), [...STATES].sort());
  for (const [name, fixture] of CASES) {
    const { word, reason } = taskWord(cardOf(fixture));
    assert.ok(SIX.includes(word), `${name}: ${word}`);
    assert.ok(typeof reason === "string" && reason.length > 0, `${name}: a reason`);
  }
});

test("T1002: the reason says what the owner answers, what the task waits for, or the refusal (F5)", () => {
  const reason = fixture => taskWord(cardOf(fixture)).reason;
  assert.equal(reason({ row: task("T1", "building"), gates: [gate()] }), "Sample: which layout?");
  assert.equal(reason({ row: task("T1", "verified", { pr: "41" }), ledger: clean, records: autopilot(false) }), "Autopilot is off, so review and merge PR 41.");
  assert.equal(reason({ row: task("T1", "framed", { waits: "T2" }), others: [task("T2", "building")] }), "Waits for T2 (building).");
  assert.match(reason({ row: task("T1", "framed", { waits: "T2" }), others: [task("T2", "abandoned")] }), /cannot start/);
  assert.equal(reason({ row: task("T1", "verified", { pr: "41" }), ledger: clean, records: autopilot(false), landing: refuses }), "The merge check refuses aaaaaaa. T1 has open findings: F-T1-1.");
  assert.equal(reason({ row: task("T1", "verified", { pr: "41" }), ledger: failed("qa-fail"), records: autopilot(true), landing: refuses }), "The merge check refuses aaaaaaa. T1 has open findings: F-T1-1.");
});

test("T1002: a state that the state tool does not write has no word, also one named like an Object key", () => {
  assert.equal(taskWord(cardOf({ row: task("T1", "half-done") })).word, null);
  for (const state of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
    assert.equal(taskWord({ state, reasons: [] }).word, null, state);
    // A milestone state with no table row takes its tasks' word, as an active milestone does.
    assert.deepEqual(milestoneWord({ state }, ["done"]), { word: "done", reason: "1 of 1 done." }, state);
  }
});

test("T1002: a missing card, reasons or words read as an unknown state or an empty list", () => {
  assert.equal(taskWord(null).word, null);
  assert.equal(taskWord().word, null);
  assert.deepEqual(taskWord({ state: "building", reasons: null }), { word: "in progress", reason: "Agents build it." });
  assert.deepEqual(milestoneWord({ state: "active" }), { word: "not started", reason: "Nothing is in it yet." });
  assert.deepEqual(releaseWord(), { word: "not started", reason: "Nothing is in it yet." });
});

test("T1002: 'needs you' agrees with the board's Needs you box, but for the design's two changes", () => {
  // The box is the board's own output: the cards of model.needsOwner. The design changes two cases, which T997 shows:
  // a task that is done or stopped keeps its word, and a refused head is the chief's to repair (F5).
  const changed = new Set([...CASES.map(([name]) => name).filter(name => name.startsWith("F5:")), "a done task with an open gate keeps its word"]);
  const sample = MILESTONES_NOW, board = buildBoardModel([milestonesSource()], { now: sample });
  const cards = [...CASES.map(([name, fixture]) => [name, model(fixture)]).map(([name, built]) => [name, built.tasks.find(card => card.id === "T1"), built]),
    ...board.tasks.map(card => [`milestones fixture ${card.id}`, card, board])];
  const agree = cards.filter(([name]) => !changed.has(name)).map(([name, card, built]) => [name, taskWord(card).word === "needs you", built.needsOwner.includes(card)]);
  assert.deepEqual(agree.map(([name, word]) => [name, word]), agree.map(([name, , box]) => [name, box]));
  assert.ok(agree.filter(([, word]) => word).length >= 8, "the fixtures hold cards in the box, not only cards out of it");
  for (const name of changed) {
    const [, card, built] = cards.find(([n]) => n === name);
    assert.deepEqual([built.needsOwner.includes(card), taskWord(card).word === "needs you"], [true, false], name);
  }
});

test("T1002 F1: while a breakdown waits for the owner, only the pilot needs you; the milestone's other tasks wait", () => {
  const board = buildBoardModel([milestonesSource()], { now: MILESTONES_NOW });
  const word = id => taskWord(board.tasks.find(card => card.id === id)).word;
  assert.deepEqual(["T30", "T31", "T32"].map(word), ["needs you", "waiting", "waiting"]);
  assert.match(taskWord(board.tasks.find(card => card.id === "T31")).reason, /your approval of the M3 breakdown/);
});

test("T1002: each milestone's word, from its state and its tasks' words", () => {
  const board = buildBoardModel([milestonesSource()], { now: MILESTONES_NOW });
  const byKey = new Map(board.tasks.map(card => [card.key, card]));
  const words = Object.fromEntries(board.milestones.map(milestone => [milestone.id, milestoneWord(milestone, milestone.tasks.map(key => taskWord(byKey.get(key)).word)).word]));
  assert.deepEqual(words, {
    M1: "in progress", // active: 3 merged, one in review
    M2: "needs you", // stuck: its pilot was abandoned, so the owner chooses a new pilot or drops it
    M3: "needs you", // proposed: its breakdown waits for the owner
    M4: "in progress", // active: the pilot builds
    M5: "done", // each task merged, concluded or abandoned (progressOf)
    M6: "stopped", // dropped by the owner
    M7: "needs you", // lost: its breakdown gate is not in the logbook
    M8: "in progress", // active: the pilot merged, the others wait
    M9: "in progress", // changing: the chief revises the breakdown
  });
  // Each milestone that needs you has its question in the board's Needs you: its own item, or its gate on a card in the box.
  for (const milestone of board.milestones) {
    const inBox = !!milestone.need || board.needsOwner.some(card => card.reasons.some(reason => reason.breakdown?.id === milestone.id));
    assert.equal(words[milestone.id] === "needs you", inBox, milestone.id);
  }
});

test("T1002: an active milestone with nothing started is not started; a stuck one whose tasks all stopped still needs you", () => {
  assert.deepEqual(milestoneWord({ state: "active" }, ["not started", "waiting", "waiting"]), { word: "not started", reason: "Nothing in it has started." });
  assert.equal(milestoneWord({ state: "active" }, ["waiting", "needs you"]).word, "in progress");
  assert.equal(milestoneWord({ state: "stuck" }, ["stopped", "stopped"]).word, "needs you");
});

test("T1002 F6: a release's word, from the words of its items", () => {
  const word = words => releaseWord(words).word;
  assert.deepEqual([
    word([]), word(["not started", "waiting"]), word(["done", "waiting"]), word(["needs you"]), word(["in progress", "done"]),
    word(["done", "stopped"]), word(["done"]), word(["stopped", "stopped"]),
  ], ["not started", "not started", "in progress", "in progress", "in progress", "done", "done", "stopped"]);
  assert.equal(releaseWord(["done", "stopped", "in progress", "not started"]).reason, "1 of 4 done.");
});
