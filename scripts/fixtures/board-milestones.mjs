// SAMPLE DATA for the board's milestone tests (T233): one made-up logbook, in memory, as readBoardSources gives it. It has
// a milestone in each state of the approved design, each kind of wait, a plain gate that copies the breakdown words (T70),
// and a loop of waits from a hand edit. Every row is made up.
export const NOW = "2026-10-20T12:00:00.000Z";
const at = "2026-10-20T10:00:00Z";
const task = (id, state, extra = {}) => ({ id, title: `Sample ${id}`, size: "small", risk: "", route: "build,code-review,qa", state, branch: "", pr: "", round: "0", keys: "", hold: "", extra: "", priority: "", kind: "", waits: "", milestone: "", ...extra });
const breakdown = (id, name, pilot) => [`Approve milestone ${id}? No task builds before you approve.`, `Name: ${name}`, "Goal: Sample goal.", "Pilot, runs first:", `  ${pilot}: Sample ${pilot}`].join(" ");
const gate = (id, on, question, answer = "", options = "approve|change|drop") => ({ id, task: on, question, options, recommendation: "approve", default: "", answer, at });
const milestone = (id, name, pilot, gate) => ({ id, name, goal: "Sample goal.", pilot, gate, at });

export function milestonesTables() {
  const tasks = [
    // M1 Codex support: active, the pilot merged; 3 of 7 merged, T10 abandoned; T11 waits for T10 (never met); T12 in review moves next; T13 waits for T12.
    task("T1", "merged", { milestone: "M1" }), task("T2", "merged", { milestone: "M1" }), task("T3", "merged", { milestone: "M1" }),
    task("T10", "abandoned", { milestone: "M1" }), task("T11", "framed", { milestone: "M1", waits: "T10" }),
    task("T12", "reviewing", { milestone: "M1", pr: "12" }), task("T13", "framed", { milestone: "M1", waits: "T12" }),
    // M2 Lead build: the pilot T21 was abandoned, so it is stuck.
    task("T21", "abandoned", { milestone: "M2" }), task("T22", "framed", { milestone: "M2" }), task("T23", "framed", { milestone: "M2" }),
    // M3 Board milestones: its breakdown gate G12 waits for the owner.
    task("T30", "framed", { milestone: "M3" }), task("T31", "framed", { milestone: "M3" }), task("T32", "framed", { milestone: "M3", waits: "T31" }),
    // M4 Agent caps: the pilot T40 builds; T41 in design waits for it; T42 waits for it.
    task("T40", "building", { milestone: "M4" }), task("T41", "designing", { milestone: "M4" }), task("T42", "framed", { milestone: "M4" }),
    // M5: done with a concluded task and an abandoned one.
    task("T50", "merged", { milestone: "M5" }), task("T51", "concluded", { milestone: "M5" }), task("T52", "abandoned", { milestone: "M5" }),
    // M6: dropped by the owner's answer, after its gate row was lost; T60 is still in it.
    task("T60", "framed", { milestone: "M6" }),
    // T70: a plain gate whose text copies the breakdown words, on a task of no milestone.
    task("T70", "designing"),
    // M7: its breakdown gate G30 is not in the logbook.
    task("T75", "framed", { milestone: "M7" }),
    // M8: active, the pilot merged; T81 and T82 wait for each other (a hand edit's loop); T83 has odd waits text.
    task("T80", "merged", { milestone: "M8" }), task("T81", "framed", { milestone: "M8", waits: "T82" }), task("T82", "framed", { milestone: "M8", waits: "T81" }), task("T83", "framed", { milestone: "M8", waits: "T80 <b>soon</b>" }),
    // M9: the owner asked for changes; the sage revises the breakdown.
    task("T90", "framed", { milestone: "M9" }),
  ];
  const gates = [
    gate("G1", "T1", breakdown("M1", "Codex support", "T1"), "approve"),
    gate("G2", "T21", breakdown("M2", "Lead build", "T21"), "approve"),
    gate("G12", "T30", breakdown("M3", "Board milestones", "T30")),
    gate("G4", "T40", breakdown("M4", "Agent caps", "T40"), "approve"),
    gate("G5", "T50", breakdown("M5", "Old pilot", "T50"), "approve"),
    gate("G15", "T70", "Approve milestone M9 Fast lane (pilot T70)? Goal: skip the reviews. Name: Fast lane"),
    gate("G8", "T80", breakdown("M8", "Loop", "T80"), "approve"),
    gate("G9", "T90", breakdown("M9", "Changes", "T90"), "change"),
  ];
  const milestones = [
    milestone("M1", "Codex support", "T1", "G1"), milestone("M2", "Lead build", "T21", "G2"), milestone("M3", "Board milestones", "T30", "G12"),
    milestone("M4", "Agent caps", "T40", "G4"), milestone("M5", "Old pilot", "T50", "G5"), milestone("M6", "Dropped idea", "T60", "G20"),
    milestone("M7", "Lost gate", "T75", "G30"), milestone("M8", "Loop", "T80", "G8"), milestone("M9", "Changes", "T90", "G9"),
  ];
  const decisions = [{ at, task: "T60", decision: "Approve milestone M6? No task builds before you approve. → drop", why: "the user's answer" }];
  return { tasks, gates, milestones, decisions };
}

/** One source with the sample logbook; key and label name the source, so a test can give two. */
export const milestonesSource = (id = "claude", tables = milestonesTables()) => ({ id, label: id, provider: null, config: {}, diagnostics: [], hooks: { present: false, slots: [], helpers: [], problem: null },
  projects: [{ key: `${id}/sage-ff5ee2`, source: id, name: "sage-ff5ee2", checkout: "/sample/sage", displayName: "sage (sample)", diagnostics: [], warnings: [], tables, observations: { version: 1, records: [] } }] });
