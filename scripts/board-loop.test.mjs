// The step line, Now and Next over the whole space (R1077): every state of the state tool, on a build route, a design and
// PE route and an investigation route, with no gate, an open gate or an answered gate, no run, a running run or a stale
// run, a known or an unknown head, and no verdicts, some or all clean, or a failed one. Each case checks the invariants of the
// design. An investigation's verdicts have no SHA and no PR (R1081-1); a reviewing task's run is the run of a review role.
import test from "node:test";
import assert from "node:assert/strict";
import { buildBoardModel } from "../packages/sage-core/board-model.mjs";

const now = "2026-10-08T20:00:00.000Z", head = "a".repeat(40), old = "2026-10-05T08:00:00.000Z", recent = "2026-10-08T19:50:00.000Z";
export const STATES = ["framed", "designing", "awaiting-you", "briefed", "building", "held", "replan", "reviewing", "repairing", "verifying", "verified", "pr-ready", "merged", "concluded", "abandoned"];
export const ROUTES = { build: "build,code-review,qa", design: "design,pe,build,code-review,security-review,qa", investigation: "investigate,evidence-review" };
const FINAL = ["merged", "concluded", "abandoned"];

/** One case as the logbook and the observations give it. A build route has a risk flag, so it needs 2 clean cycles. */
export function sample({ state, route, gate, run, known, cycles, autopilot = null, hold = "" }) {
  const build = route !== "investigation";
  const task = { id: "T1", title: "Sample", size: build ? "small" : "investigate", risk: route === "build" ? "auth" : "", route: ROUTES[route], state, branch: "", pr: build ? "12" : "", round: state === "repairing" ? "1" : hold ? "3" : "0", keys: "", hold };
  const role = { designing: "designer", reviewing: build ? "qa" : "evidence-review", repairing: "implementer" }[state] ?? (build ? "implementer" : "investigate");
  // R5 is the ended run of the review that failed (findings); a findings verdict counts only for a run of its role. A failed
  // check or QA would need you as well, so the failed case is a review.
  const runs = [...(cycles === "failed" ? [{ id: "R5", task: "T1", role: build ? "code-reviewer" : "evidence-review", round: task.round, status: "done", started: old, ended: old }] : []),
    ...(run === "none" ? [] : [{ id: "R7", task: "T1", role, round: task.round, status: "running", started: run === "stale" ? old : recent }])];
  const verdict = (kind, cycle) => ({ task: "T1", pr: build ? known ? "12" : "99" : "", sha: build ? head : "", kind, cycle: String(cycle), run: kind === "findings" ? "R5" : "", at: old });
  const ledger = cycles === "none" ? [] : !build ? cycles === "all" ? [verdict("evidence-clean", 1)] : cycles === "failed" ? [verdict("findings", 1)] : []
    : cycles === "partial" ? [verdict("checks-pass", 1), verdict("review-clean", 1)]
    : cycles === "failed" ? [verdict("checks-pass", 1), verdict("findings", 1)]
    : [verdict("checks-pass", 1), ...[1, 2].flatMap(n => [verdict("review-clean", n), verdict("security-clean", n), verdict("qa-pass", n)])];
  const gates = gate === "none" ? [] : [{ id: "G3", task: "T1", question: "Sample: keep the old copy?", options: "yes|no", recommendation: "yes", answer: gate === "answered" ? "yes" : "", at: old }];
  const records = [...(known && build ? [{ id: "O1", task: "T1", kind: "pr", source: "sample", basis: "observed", observedAt: now, recordedAt: now, data: { number: 12, head, state: "open" } }] : []),
    ...(autopilot === null ? [] : [{ id: "O2", task: "T1", kind: "mode", source: "sample", basis: "observed", observedAt: now, recordedAt: now, data: { autopilot } }])];
  const model = buildBoardModel([{ id: "claude", label: "claude", diagnostics: [], projects: [{ key: "claude/sample-abcdef", name: "sample-abcdef", diagnostics: [], tables: { tasks: [task], runs, ledger, gates }, observations: { version: 1, records } }] }], { now });
  return model.tasks[0];
}

/** Every case of the matrix: 15 states × 3 routes × 3 gates × 3 runs × 2 heads × 4 verdict sets = 3,240 cases. */
export function* matrix() {
  for (const state of STATES) for (const route of Object.keys(ROUTES)) for (const gate of ["none", "open", "answered"])
    for (const run of ["none", "running", "stale"]) for (const known of [true, false]) for (const cycles of ["none", "partial", "all", "failed"])
      yield { state, route, gate, run, known, cycles };
}

// What the Now line says in each state when nothing needs you; an agent's step may also say its run is at work or may have stopped.
const NOW = {
  framed: /^In the backlog|at work on the plan/, designing: /the design/, "awaiting-you": /^You answered gate G3/, briefed: /^Briefed|at work on the (build|investigation)/,
  building: /the (build|investigation)/, held: /^Held/, replan: /new plan/, reviewing: /review|failed/, repairing: /repair round 1 of 3/, verifying: /^The chief checks/,
  verified: /^Verified/, "pr-ready": /^Verified/, merged: /^(Merged|Done)\.$/, concluded: /^(Concluded|Closed with no merge)\./, abandoned: /^Abandoned\.$/,
};
const CURRENT = ["run", "stale", "idle", "need", "fail"];

/** The invariants of one case; each failure names the case. */
export function check(c, task = sample(c)) {
  const { steps, now, next } = task.loop, name = JSON.stringify(c), build = c.route !== "investigation";
  const live = c.run === "running", stale = c.run === "stale", openGate = c.gate === "open";
  const ownerState = c.state === "awaiting-you" && c.gate === "none" || ["verified", "pr-ready"].includes(c.state) && build && c.autopilot !== true;
  const texts = [now.needs ? null : now.text, next, ...steps.map(step => step.detail)].filter(Boolean);
  // "Running now" only with a live run: a step, a part, or the Now line ("at work").
  if (!live) {
    assert.ok(!steps.some(step => step.status === "run" || step.parts?.some(([, value]) => value === "run")), `${name}: a step runs with no live run`);
    assert.ok(!/at work/.test(now.text), `${name}: Now says at work with no live run`);
  }
  // A stale run shows its mark on the step and on the Now line, unless a gate or the owner comes first.
  if (stale && !now.needs && steps.some(step => step.status === "stale")) assert.ok(now.stale && /may have stopped/.test(now.text), `${name}: the stale step has no stale Now line`);
  if (!stale) assert.ok(!steps.some(step => step.status === "stale") && !now.stale, `${name}: a stale mark with no stale run`);
  // Needs you only with an open gate or a state that waits for the owner; then the current step needs you.
  assert.equal(now.needs, openGate || ownerState, `${name}: Needs you is ${now.needs}`);
  assert.equal(task.reasons.length > 0, now.needs, `${name}: the card's needs differs from its Needs you line`);
  if (now.needs && !FINAL.includes(c.state)) assert.equal(steps.filter(step => step.status === "need").length, 1, `${name}: no step needs you`);
  if (!now.needs) assert.ok(!steps.some(step => step.status === "need"), `${name}: a step needs you, but the Now line does not`);
  // At most one current step; a repair also shows the review that failed.
  assert.ok(steps.filter(step => CURRENT.includes(step.status)).length <= (c.state === "repairing" ? 2 : 1), `${name}: more than one current step`);
  // Only the route's steps, and no text names a step that is not on the route.
  const labels = steps.map(step => step.label.replace(/, round \d+ of \d+$/, "").replace(/ \d+ of \d+$/, ""));
  for (const label of labels) assert.ok((build ? ["Plan", "Build", "Review", "Repair", "Review again", "Merge"] : ["Plan", "Investigate", "Evidence review", "Repair", "Review again", "Conclude"]).includes(label), `${name}: step ${label}`);
  for (const text of texts) {
    if (!build) assert.doesNotMatch(text, /\b(PR|merge[sd]?|build|commit|review cycle)\b/i, `${name}: an investigation text names a build step`);
    else assert.doesNotMatch(text, /\b(conclu\w*|investigat\w*|evidence review)\b/i, `${name}: a build text names an investigation step`);
    if (!ROUTES[c.route].includes("pe")) assert.doesNotMatch(text, /\bPE\b/, `${name}: names a PE check that is not on the route`);
    const cycle = /review cycle (\d+) of (\d+)/i.exec(text);
    if (cycle) assert.ok(Number(cycle[1]) <= Number(cycle[2]) && Number(cycle[2]) === task.requiredCycles, `${name}: ${text}`);
    // No doubled punctuation and no label inside a line ("Next: Concluded: …"); each text is whole sentences.
    assert.doesNotMatch(text, /[.:;,!?]\s*[.:;,]|\.\s*\.|:/, `${name}: punctuation in ${JSON.stringify(text)}`);
    assert.match(text, /[.)]$/, `${name}: ${JSON.stringify(text)} is not a whole sentence`);
  }
  // The cycles agree with the verdicts once the board knows them: a known head, or a route without build (R1081-1, R1080-3).
  const judged = c.state === "reviewing" && (c.known || !build) && !openGate;
  const reviews = steps.filter(step => /^(Review|Evidence review)/.test(step.label));
  if (judged && c.cycles === "all") {
    assert.ok(reviews.every(step => step.status === "done"), `${name}: a clean review is not done`);
    assert.match(now.text, build ? /^The reviews are done/ : /^The evidence review is done\.$/, `${name}: Now ${JSON.stringify(now.text)}`);
  }
  // A failed verdict fails its cycle: one step fails, Now names the failed role, and Next is a repair round (R1078-1).
  if (judged && c.cycles === "failed") {
    assert.deepEqual(steps.filter(step => step.status === "fail").map(step => step.label), [build ? `Review 1 of ${task.requiredCycles}` : "Evidence review"], `${name}: the failed review`);
    assert.equal(now.text, build ? "Code review failed on aaaaaaa." : "Evidence review failed.", `${name}: Now`);
    assert.match(next, /^A repair round/, `${name}: Next ${next}`);
  }
  // A live run of a review role that has no verdict yet runs its part (R1080-3).
  if (judged && live && ["none", "partial"].includes(c.cycles)) {
    assert.ok(reviews.some(step => step.status === "run" && step.parts.some(([part, value]) => part === (build ? "QA" : "evidence review") && value === "run")), `${name}: the running review is not running now`);
    assert.ok(!reviews.some(step => step.status === "done"), `${name}: a review is done with no verdict`);
  }
  // Next: none for a final state; after an answer when a gate is open.
  if (FINAL.includes(c.state)) assert.equal(next, null, `${name}: Next on a final state`);
  else {
    assert.ok(next, `${name}: no Next`);
    if (openGate) {
      assert.match(next, /after your answer\.$/, `${name}: ${next}`);
      // It names the step that waits for the answer: the one that needs you (R1073-1, R1073-3).
      const label = steps.find(step => step.status === "need").label;
      const said = { Plan: c.state === "designing" ? "The design" : "The plan", Build: "The build", Investigate: "The investigation", Merge: "The merge", Conclude: "The conclusion", "Evidence review": "The evidence review" }[label]
        ?? label.replace(/^Review (\d)/, "Review cycle $1").replace(/^Repair, round/, "Repair round");
      const expected = { replan: "The chief briefs it again", "awaiting-you": `${build ? "The build" : "The investigation"} is briefed` }[c.state] ?? said;
      assert.ok(next.startsWith(expected), `${name}: ${next} does not name ${label}`);
    }
  }
  // The Now line matches the state.
  if (!now.needs && !(c.state === "awaiting-you" && c.gate !== "answered")) assert.match(now.text, stale && ![c.gate === "answered" && "awaiting-you", "held", "replan", "verifying", "verified", "pr-ready", ...FINAL].includes(c.state) && !/failed|review(s are| is) done/.test(now.text) ? /may have stopped/ : NOW[c.state], `${name}: Now ${JSON.stringify(now.text)}`);
}

test("R1077: the step line, Now and Next keep every invariant over the whole space of states, routes, gates, runs, heads and verdicts", () => {
  let n = 0;
  for (const c of matrix()) { check(c); n++; }
  assert.equal(n, 3240);
});

test("R1077: the same invariants hold with autopilot on, off and unknown, and on a task held by the round limit", () => {
  for (const autopilot of [true, false, null]) for (const state of ["verified", "pr-ready"]) for (const route of Object.keys(ROUTES)) for (const gate of ["none", "open"]) check({ state, route, gate, run: "none", known: true, cycles: "all", autopilot });
  for (const gate of ["none", "open", "answered"]) for (const route of Object.keys(ROUTES)) check({ state: "held", route, gate, run: "none", known: true, cycles: "none", hold: "round" });
});
