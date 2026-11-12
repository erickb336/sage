// SAMPLE DATA for the board's release tests (T996): one made-up logbook, in memory, as readBoardSources gives it, after
// the T995 design's sample. Release 0.9 is done; release 1.0 holds milestone 5 (its pilot builds, 7 tasks wait for it) and
// two single tasks (one needs you, one done); release 1.1 holds milestone 6, whose breakdown waits for the owner, and one
// single task. Two tasks are in no release. Every row is made up.
export const NOW = "2026-11-12T18:00:00.000Z";
const at = "2026-11-12T10:00:00Z";
const task = (id, title, state, extra = {}) => ({ id, title, size: "small", risk: "", route: "build,code-review,qa", state, branch: "", pr: "", round: "0", keys: "", hold: "", priority: "P2", kind: "", waits: "", milestone: "", release: "", ...extra });
const gate = (id, on, question, options, answer = "") => ({ id, task: on, question, options, recommendation: options.split("|")[0], default: "", answer, at });
const breakdown = (id, name, pilot) => [`Approve milestone ${id}? No task builds before you approve.`, `Name: ${name}`, "Goal: Sample goal.", "Pilot, runs first:", `  ${pilot}: Sample ${pilot}`].join(" ");

export function releasesTables() {
  const playbooks = ["a new feature", "a bug fix", "a study", "a design", "a release", "a review", "a migration"];
  const tasks = [
    task("T900", "First install", "merged", { release: "0.9" }),
    task("T984", "Presentation skill", "building", { milestone: "M5", priority: "P1" }),
    ...playbooks.map((name, i) => task(`T${985 + i}`, `Playbook: ${name}`, "framed", { milestone: "M5", waits: "T984" })),
    task("T996", "Board footer links", "designing", { release: "1.0" }),
    task("T993", "Clearer stop message", "merged", { release: "1.0", pr: "512" }),
    task("T1010", "Review lanes", "framed", { milestone: "M6" }),
    task("T1011", "Review cache", "framed", { milestone: "M6", waits: "T1010" }),
    task("T1012", "Faster checks", "framed", { release: "1.1", priority: "P3" }),
    task("T992", "Fix a typo in the guide", "framed", { priority: "P3" }),
    task("T994", "Old status layout", "abandoned"),
  ];
  const gates = [
    gate("G1", "T984", breakdown("M5", "Sage feel", "T984"), "approve|change|drop", "approve"),
    gate("G2", "T996", "Keep the old footer links on the board?", "keep|remove"),
    gate("G3", "T1010", breakdown("M6", "Faster reviews", "T1010"), "approve|change|drop"),
  ];
  const milestones = [
    { id: "M5", name: "Sage feel", goal: "Make sage clear and calm to read after time away.", pilot: "T984", gate: "G1", at, release: "1.0" },
    { id: "M6", name: "Faster reviews", goal: "Review a change in half the time.", pilot: "T1010", gate: "G3", at, release: "1.1" },
  ];
  const releases = [
    { name: "0.9", goal: "A first version for the owner alone.", at },
    { name: "1.0", goal: "The first version that other people install.", at },
    { name: "1.1", goal: "Faster reviews.", at },
  ];
  // Each task's completion time for the Done column: in the last 7 days.
  const decisions = tasks.filter(t => ["merged", "abandoned"].includes(t.state)).map(t => ({ at, task: t.id, decision: `state ${t.state}`, why: "sample" }));
  return { tasks, gates, milestones, releases, decisions };
}

/** One source with the sample logbook. tables: the tables to use, for example without the releases table. */
export const releasesSource = (tables = releasesTables(), id = "claude") => ({ id, label: id, provider: null, config: {}, diagnostics: [], hooks: { present: false, slots: [], helpers: [], problem: null },
  projects: [{ key: `${id}/sage-ff5ee2`, source: id, name: "sage-ff5ee2", checkout: "/sample/sage", displayName: "sage (sample)", diagnostics: [], warnings: [], tables, observations: { version: 1, records: [] } }] });
