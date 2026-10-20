// The rules of waits (T336) and programs (T337), in one place: the state tool and the board read a logbook with them
// (T233), so the status line, the merge check and the board never disagree. Pure functions of table rows: no file access.
import { BREAKS, LINE, proposalOf } from "./logbook-fields.mjs";

/**
 * Waits (T336): a task may wait for other tasks of its own logbook. A wait is met when that task is merged or concluded; an
 * abandoned or lost task never meets it, also in the same merge (the owner, 2026-10-19). A task with an unmet wait takes
 * no build work (WAIT_ROLES, a move to building) and does not merge; its design and PE may run.
 *
 * Programs (T337) add two waits that no cell holds: each task of a program waits for the owner's approval of the
 * program's breakdown, and after it, each task but the pilot waits for the pilot. The same rules read them.
 */
export const MET = ["merged", "concluded"];
export const ENDED = [...MET, "abandoned"];
export const TASK_ID = /^T[1-9]\d*$/;
export const PROGRAM_ID = /^PG[1-9]\d*$/;
export const GATE_ID = /^G[1-9]\d*$/;
/**
 * The programs table as both boards read it (C3, T233): two rows of one id, or a bad id, pilot or gate cell, make it
 * unreadable (it throws), as the state tool never writes such a table. So no board marks a gate from a damaged table.
 */
export const checkPrograms = (rows) => {
  const ids = new Set();
  for (const row of rows) {
    if (!PROGRAM_ID.test(row.id) || ids.has(row.id) || !TASK_ID.test(row.pilot) || !GATE_ID.test(row.gate)) throw new Error("damaged program identity, pilot or gate");
    ids.add(row.id);
  }
  return rows;
};
/** The words of a waits value, as a write and a read split them: by commas or spaces. */
export const waitWords = (value) => String(value ?? "").split(/[\s,]+/).filter(Boolean);
/**
 * A task's waits cell, read with the parser of the writes: its task ids, and odd when a hand edit put other text there. No
 * line prints the cell itself, so its text never reaches the chief; odd counts as one unmet wait, so the task still waits.
 */
export const waitsOf = (task) => {
  const words = waitWords(task?.waits);
  return { ids: [...new Set(words.filter((w) => TASK_ID.test(w)))], odd: words.some((w) => !TASK_ID.test(w)) };
};
/** The tasks by id, built once by a caller that looks up many waits, so a merge check stays linear. */
export const byIds = (tasks) => new Map(tasks.map((t) => [t.id, t]));
/** The options of a breakdown gate, in this order: the owner answers by number. */
export const BREAKDOWN = "approve|change|drop";
/**
 * A program's state, from the answer of its latest breakdown gate, never from a cell: proposed while the gate is open,
 * active after approve, dropped after drop, changing after change or the owner's own words (they say what to change).
 * It is lost when the gate's row is gone, or when the row is not a breakdown gate on the program's pilot (R1208-3), so
 * no other gate sets it; but a drop holds also then, as the decision row of the owner's answer says it (R1249-4, R1266-1).
 * An active program whose tasks have all ended is done (progressOf).
 */
export const programState = (gate, program, decisions) =>
  gate?.task !== program.pilot || gate.options !== BREAKDOWN
    ? decisions.some((d) => d.why === "the user's answer" && proposalOf({ question: d.decision }) === program.id && d.decision.endsWith(" → drop")) ? "dropped" : "lost"
    : !gate.answer ? "proposed" : ({ approve: "active", drop: "dropped" }[gate.answer] ?? "changing");
/** What the waits of the logbook's tasks are read against: the tasks by id, and each program with its state. Built once per logbook. */
export const waitGraph = (tasks, programs, gates, decisions) => {
  const gateOf = byIds(gates);
  // gateFound: the gate row that the program names is in the logbook, so a lost program says why (R1308-1).
  return { byId: byIds(tasks), programs: new Map(programs.map((p) => [p.id, { ...p, state: programState(gateOf.get(p.gate), p, decisions), gateFound: gateOf.has(p.gate) }])) };
};
/**
 * A task's waits, each with the state of its task (undefined for a task that the logbook lost), then its program's two
 * implicit waits: the pilot (pilot: the program's id) once the breakdown is approved, else the breakdown itself
 * (program), and odd text as one more.
 */
export const waitsWithState = (task, { byId, programs }) => {
  const { ids, odd } = waitsOf(task);
  const program = task?.program ? (programs.get(task.program) ?? { id: task.program, state: "lost" }) : undefined;
  const pilot = program?.state === "active" && program.pilot !== task.id ? program.pilot : undefined;
  const wait = (id) => ({ id, state: byId.get(id)?.state, ...(id === pilot && { pilot: program.id }) }); // an explicit wait on the pilot is a pilot wait too
  return [...ids.map(wait), ...(pilot && !ids.includes(pilot) ? [wait(pilot)] : []), ...(program && program.state !== "active" ? [{ program }] : []), ...(odd ? [{ odd }] : [])];
};
/**
 * The waits of a task that are not met. passes(id) meets a wait too: a task that passes in the same merge. A pilot wait is
 * met only when the pilot is merged or concluded, so the pilot runs first (R1204-3). A breakdown that is not approved is never met.
 */
export const unmetWaits = (task, graph, passes = () => false) => waitsWithState(task, graph).filter(({ id, state, odd, program, pilot }) => odd || program || (!MET.includes(state) && (pilot || !passes(id))));
/** A task that never meets a wait: abandoned, or lost from the logbook. */
export function dead(state) {
  return state === "abandoned" || state === undefined;
}

/**
 * The program whose breakdown gate this gate is, from data, never from its text alone (the owner's Q1, T233): a programs
 * row names this gate, the gate is on that program's pilot, its options are approve|change|drop, and its question's first
 * line names the same program. Any other gate is a plain gate, whatever its text says. programs: the programs rows (an
 * array or a Map of them).
 */
export const breakdownGate = (gate, programs) => {
  const id = proposalOf(gate);
  if (!id || gate?.options !== BREAKDOWN) return undefined;
  for (const p of programs?.values() ?? []) if (p.id === id && p.gate === gate.id && p.pilot === gate.task) return id;
  return undefined;
};
/**
 * The wait graph as every printer shows it (the boards and the status line; never a write rule or the merge check): a
 * program is proposed or changing only while its gate is its breakdown gate by the data rule (breakdownGate); else it is
 * lost, so no line says that a breakdown waits for the owner while Needs you shows the gate as a plain gate.
 */
export const shownGraph = ({ byId, programs }, gates) => {
  const gateOf = byIds(gates);
  const shown = (p) => (["proposed", "changing"].includes(p.state) && breakdownGate(gateOf.get(p.gate), programs) !== p.id ? "lost" : p.state);
  return { byId, programs: new Map([...programs].map(([id, p]) => [id, { ...p, state: shown(p) }])) };
};
/**
 * A gate's question as the board and status show it, line by line: only a breakdown gate's question (breakdownGate) has
 * lines; any other is one line, each line break a space, so no question of another gate shows a line that reads as a part of the board.
 */
export const gateLines = (gate, programs) => (breakdownGate(gate, programs) ? gate.question.split(LINE) : [String(gate?.question ?? "").replace(BREAKS, " ")]);

/**
 * A program's progress from its tasks (the owner's Q3, T233): the merged or concluded tasks of all its tasks, which keeps
 * the approved total, and the abandoned tasks by id. It is done when it has a task that is not abandoned and each such
 * task is merged or concluded.
 */
export const progressOf = (tasks) => {
  const merged = tasks.filter((t) => MET.includes(t.state)).length, abandoned = tasks.filter((t) => t.state === "abandoned").map((t) => t.id);
  const live = tasks.length - abandoned.length;
  return { merged, total: tasks.length, abandoned, done: live > 0 && merged === live };
};
/** The progress as the board and the status line say it: "3 of 7 merged · T10 abandoned". */
export const progressText = ({ merged, total, abandoned }) => `${merged} of ${total} merged${abandoned.length ? ` · ${abandoned.join(", ")} abandoned` : ""}`;
