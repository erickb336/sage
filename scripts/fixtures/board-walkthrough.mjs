// SAMPLE DATA for the worked example in docs/guide/learn-sage.md (T381): one made-up project, Ramen Finder, and one
// small task, T1, at four moments from the question to the merge. Each stage is one logbook, in memory, as
// readBoardSources gives it. Every row is made up.
export const NOW = "2026-10-20T12:00:00.000Z";
const at = (minutes) => new Date(Date.parse(NOW) - minutes * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");
const SHA = "4787c81f0a9b3c2d1e6f5a4b3c2d1e0f9a8b7c6d";
const ROUTE = "build,code-review,security-review,qa";
const QUESTION = "An empty search: what does Ramen Finder show?";
const task = (state, extra = {}) => ({ id: "T1", title: "An empty search crashes the app", size: "small", risk: "input", route: ROUTE, state, branch: "", pr: "", round: "0", keys: "", hold: "", extra: "", priority: "", kind: "bug-fix", waits: "", program: "", ...extra });
const gate = (answer = "") => ({ id: "G1", task: "T1", question: QUESTION, options: "a hint to type a name|all ramen shops", recommendation: "a hint to type a name", default: "a hint to type a name", answer, at: at(50) });
const run = (id, role, status, started, ended = "") => ({ id, task: "T1", role, round: "0", candidate: "", branch: "sage/t1-empty-search", status, tokens: status === "done" ? "84000" : "", report: "", started: at(started), ended: ended === "" ? "" : at(ended), model: "" });
const verdict = (kind, minutes, cycle = "1") => ({ task: "T1", pr: "41", sha: SHA, kind, cycle, run: "", at: at(minutes) });
// A risk flag asks for 2 clean cycles on the same commit; verified needs the first.
const LEDGER = [verdict("review-clean", 15), verdict("security-clean", 14), verdict("qa-pass", 12), verdict("review-clean", 10, "2"), verdict("security-clean", 9, "2"), verdict("qa-pass", 7, "2"), verdict("checks-pass", 5)];
const framed = { at: at(52), task: "T1", decision: "framed small, input", why: "the request" };
const answered = { at: at(45), task: "T1", decision: `${QUESTION} → a hint to type a name`, why: "the user's answer" };

/** The four moments: the chief asks, the agents build, the pull request is ready, and it is merged. */
export const STAGES = {
  asks: { tasks: [task("framed")], gates: [gate()], runs: [], ledger: [], decisions: [framed] },
  building: { tasks: [task("building", { branch: "sage/t1-empty-search" })], gates: [gate("a hint to type a name")], runs: [run("R1", "lead", "running", 40), run("R2", "implementer", "running", 38)], ledger: [], decisions: [framed, answered] },
  ready: {
    tasks: [task("verified", { branch: "sage/t1-empty-search", pr: "41" })], gates: [gate("a hint to type a name")],
    runs: [run("R1", "lead", "done", 40, 6), run("R2", "implementer", "done", 38, 25), run("R3", "code-reviewer", "done", 24, 15), run("R4", "security-reviewer", "done", 24, 14), run("R5", "qa", "done", 14, 7)],
    ledger: LEDGER, decisions: [framed, answered],
  },
  merged: {
    tasks: [task("merged", { branch: "sage/t1-empty-search", pr: "41" })], gates: [gate("a hint to type a name")],
    runs: [run("R1", "lead", "done", 40, 6), run("R2", "implementer", "done", 38, 25), run("R3", "code-reviewer", "done", 24, 15), run("R4", "security-reviewer", "done", 24, 14), run("R5", "qa", "done", 14, 7)],
    ledger: LEDGER, decisions: [framed, answered, { at: at(1), task: "T1", decision: "state merged", why: "the user merged PR #41" }],
  },
};

/** One source with the logbook of a stage. */
export const walkthroughSource = (stage) => ({ id: "claude", label: "claude", provider: null, config: {}, diagnostics: [], hooks: { present: false, slots: [], helpers: [], problem: null },
  projects: [{ key: "claude/ramen-finder-a1b2c3", source: "claude", name: "ramen-finder-a1b2c3", checkout: "/sample/ramen-finder", displayName: "Ramen Finder (sample)", diagnostics: [], warnings: [], tables: { programs: [], findings: [], ...STAGES[stage] }, observations: { version: 1, records: [] } }] });
