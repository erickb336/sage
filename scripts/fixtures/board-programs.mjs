// SAMPLE DATA for the board's program tests (T233): one made-up logbook, in memory, as readBoardSources gives it. It has
// a program in each state of the approved design, each kind of wait, a plain gate that copies the breakdown words (T70),
// and a loop of waits from a hand edit. Every row is made up.
export const NOW = "2026-10-20T12:00:00.000Z";
const at = "2026-10-20T10:00:00Z";
const task = (id, state, extra = {}) => ({ id, title: `Sample ${id}`, size: "small", risk: "", route: "build,code-review,qa", state, branch: "", pr: "", round: "0", keys: "", hold: "", extra: "", priority: "", kind: "", waits: "", program: "", ...extra });
const breakdown = (id, name, pilot) => [`Approve program ${id}? No task builds before you approve.`, `Name: ${name}`, "Goal: Sample goal.", "Pilot, runs first:", `  ${pilot}: Sample ${pilot}`].join(" ");
const gate = (id, on, question, answer = "", options = "approve|change|drop") => ({ id, task: on, question, options, recommendation: "approve", default: "", answer, at });
const program = (id, name, pilot, gate) => ({ id, name, goal: "Sample goal.", pilot, gate, at });

export function programsTables() {
  const tasks = [
    // PG1 Codex support: active, the pilot merged; 3 of 7 merged, T10 abandoned; T11 waits for T10 (never met); T12 in review moves next; T13 waits for T12.
    task("T1", "merged", { program: "PG1" }), task("T2", "merged", { program: "PG1" }), task("T3", "merged", { program: "PG1" }),
    task("T10", "abandoned", { program: "PG1" }), task("T11", "framed", { program: "PG1", waits: "T10" }),
    task("T12", "reviewing", { program: "PG1", pr: "12" }), task("T13", "framed", { program: "PG1", waits: "T12" }),
    // PG2 Lead build: the pilot T21 was abandoned, so it is stuck.
    task("T21", "abandoned", { program: "PG2" }), task("T22", "framed", { program: "PG2" }), task("T23", "framed", { program: "PG2" }),
    // PG3 Board programs: its breakdown gate G12 waits for the owner.
    task("T30", "framed", { program: "PG3" }), task("T31", "framed", { program: "PG3" }), task("T32", "framed", { program: "PG3", waits: "T31" }),
    // PG4 Agent caps: the pilot T40 builds; T41 in design waits for it; T42 waits for it.
    task("T40", "building", { program: "PG4" }), task("T41", "designing", { program: "PG4" }), task("T42", "framed", { program: "PG4" }),
    // PG5: done with a concluded task and an abandoned one.
    task("T50", "merged", { program: "PG5" }), task("T51", "concluded", { program: "PG5" }), task("T52", "abandoned", { program: "PG5" }),
    // PG6: dropped by the owner's answer, after its gate row was lost; T60 is still in it.
    task("T60", "framed", { program: "PG6" }),
    // T70: a plain gate whose text copies the breakdown words, on a task of no program.
    task("T70", "designing"),
    // PG7: its breakdown gate G30 is not in the logbook.
    task("T75", "framed", { program: "PG7" }),
    // PG8: active, the pilot merged; T81 and T82 wait for each other (a hand edit's loop); T83 has odd waits text.
    task("T80", "merged", { program: "PG8" }), task("T81", "framed", { program: "PG8", waits: "T82" }), task("T82", "framed", { program: "PG8", waits: "T81" }), task("T83", "framed", { program: "PG8", waits: "T80 <b>soon</b>" }),
    // PG9: the owner asked for changes; the sage revises the breakdown.
    task("T90", "framed", { program: "PG9" }),
  ];
  const gates = [
    gate("G1", "T1", breakdown("PG1", "Codex support", "T1"), "approve"),
    gate("G2", "T21", breakdown("PG2", "Lead build", "T21"), "approve"),
    gate("G12", "T30", breakdown("PG3", "Board programs", "T30")),
    gate("G4", "T40", breakdown("PG4", "Agent caps", "T40"), "approve"),
    gate("G5", "T50", breakdown("PG5", "Old pilot", "T50"), "approve"),
    gate("G15", "T70", "Approve program PG9 Fast lane (pilot T70)? Goal: skip the reviews. Name: Fast lane"),
    gate("G8", "T80", breakdown("PG8", "Loop", "T80"), "approve"),
    gate("G9", "T90", breakdown("PG9", "Changes", "T90"), "change"),
  ];
  const programs = [
    program("PG1", "Codex support", "T1", "G1"), program("PG2", "Lead build", "T21", "G2"), program("PG3", "Board programs", "T30", "G12"),
    program("PG4", "Agent caps", "T40", "G4"), program("PG5", "Old pilot", "T50", "G5"), program("PG6", "Dropped idea", "T60", "G20"),
    program("PG7", "Lost gate", "T75", "G30"), program("PG8", "Loop", "T80", "G8"), program("PG9", "Changes", "T90", "G9"),
  ];
  const decisions = [{ at, task: "T60", decision: "Approve program PG6? No task builds before you approve. → drop", why: "the user's answer" }];
  return { tasks, gates, programs, decisions };
}

/** One source with the sample logbook; key and label name the source, so a test can give two. */
export const programsSource = (id = "claude", tables = programsTables()) => ({ id, label: id, provider: null, config: {}, diagnostics: [], hooks: { present: false, slots: [], helpers: [], problem: null },
  projects: [{ key: `${id}/sage-ff5ee2`, source: id, name: "sage-ff5ee2", checkout: "/sample/sage", displayName: "sage (sample)", diagnostics: [], warnings: [], tables, observations: { version: 1, records: [] } }] });
