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
 * The programs table as both boards read it (C3, T233): two rows of one id, two rows that name one gate, or a bad id,
 * pilot or gate cell, make it unreadable (it throws), as the state tool never writes such a table. So no board marks a
 * gate from a damaged table, and no program's answered gate sets another program's state. The error names the row's line
 * (lines: the file's line number of each row; by default the header is line 1 and no line is blank) and its id when the
 * id is a program id; no other cell text.
 */
export const checkPrograms = (rows, lines = rows.map((_, i) => i + 2)) => {
  const ids = new Map(), gates = new Map();
  for (const [i, row] of rows.entries()) {
    const at = `line ${lines[i]}`;
    if (!PROGRAM_ID.test(row.id)) throw new Error(`${at} has a program id that is not PG and a number`);
    if (ids.has(row.id)) throw new Error(`${at} has the program ${row.id} again (first on line ${ids.get(row.id)})`);
    if (!TASK_ID.test(row.pilot)) throw new Error(`${at}: the pilot of ${row.id} is not a task id`);
    if (!GATE_ID.test(row.gate)) throw new Error(`${at}: the gate of ${row.id} is not a gate id`);
    if (gates.has(row.gate)) throw new Error(`${at}: ${row.id} names the gate ${row.gate} of ${gates.get(row.gate)}`);
    ids.set(row.id, lines[i]);
    gates.set(row.gate, row.id);
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
/** The programs that the owner dropped by an answer (a decision row of the owner's answer), read once per logbook. */
export const droppedBy = (decisions) => new Set(decisions.filter((d) => d.why === "the user's answer" && d.decision?.endsWith(" → drop")).map((d) => proposalOf({ question: d.decision })).filter(Boolean));
/**
 * A program's state, from the answer of its latest breakdown gate, never from a cell: proposed while the gate is open,
 * active after approve, dropped after drop, changing after change or the owner's own words (they say what to change).
 * It is lost when the gate's row is gone, or when the row is not a breakdown gate on the program's pilot (R1208-3), so
 * no other gate sets it; but a drop holds also then, as the decision row of the owner's answer says it (R1249-4, R1266-1).
 * dropped: the ids of droppedBy. An active program whose tasks have all ended is done (progressOf).
 */
export const programState = (gate, program, dropped) =>
  gate?.task !== program.pilot || gate.options !== BREAKDOWN
    ? dropped.has(program.id) ? "dropped" : "lost"
    : !gate.answer ? "proposed" : ({ approve: "active", drop: "dropped" }[gate.answer] ?? "changing");
/** What the waits of the logbook's tasks are read against: the tasks by id, and each program with its state. Built once per logbook. */
export const waitGraph = (tasks, programs, gates, decisions) => {
  const gateOf = byIds(gates), dropped = droppedBy(decisions);
  // gateFound: the gate row that the program names is in the logbook, so a lost program says why (R1308-1).
  return { byId: byIds(tasks), programs: new Map(programs.map((p) => [p.id, { ...p, state: programState(gateOf.get(p.gate), p, dropped), gateFound: gateOf.has(p.gate) }])) };
};
/**
 * A task's waits, each with the state of its task (undefined for a task that the logbook lost), then its program's two
 * implicit waits: the pilot (pilot: the program's id) once the breakdown is approved, else the breakdown itself
 * (program), and odd text as one more. A program that the logbook does not have is a stand-in with missing: true.
 */
export const waitsWithState = (task, { byId, programs, loops }) => {
  const { ids, odd } = waitsOf(task);
  const program = task?.program ? (programs.get(task.program) ?? { id: task.program, state: "lost", missing: true }) : undefined;
  const pilot = program?.state === "active" && program.pilot !== task.id ? program.pilot : undefined;
  // An explicit wait on the pilot is a pilot wait too. loop: the wait is a link of a loop of waits (shownGraph only).
  const wait = (id) => ({ id, state: byId.get(id)?.state, ...(id === pilot && { pilot: program.id }), ...(loops?.has(task.id) && loops.get(task.id) === loops.get(id) && { loop: true }) });
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
 * A task's waits as every printer shows them (the boards, the status line and the task line; never a write rule or the
 * merge check): a breakdown whose pilot is abandoned or lost makes its program stuck, so the task waits for that pilot
 * instead, as in an active program, and never meets it (F-T385-1). graph: a shownGraph.
 */
export const shownWaits = (task, graph) => waitsWithState(task, graph).flatMap((wait) => {
  const pilot = wait.program?.pilot, state = graph.byId.get(pilot)?.state;
  if (!["proposed", "changing"].includes(wait.program?.state) || !dead(state)) return [wait];
  return pilot === task.id || waitsOf(task).ids.includes(pilot) ? [] : [{ id: pilot, state, pilot: wait.program.id }];
});

/**
 * The program whose breakdown gate this gate is, from data, never from its text alone (the owner's Q1, T233): a programs
 * row names this gate, the gate is on that program's pilot, its options are approve|change|drop, and its question's first
 * line names the same program. Any other gate is a plain gate, whatever its text says. programs: the programs rows, as a
 * Map by id (one lookup) or an array.
 */
export const breakdownGate = (gate, programs) => {
  const id = proposalOf(gate);
  if (!id || gate?.options !== BREAKDOWN) return undefined;
  const p = programs instanceof Map ? programs.get(id) : programs?.find((row) => row.id === id);
  return p && p.gate === gate.id && p.pilot === gate.task ? id : undefined;
};
/**
 * The loops of waits among the tasks that have not ended, from a hand edit (the state tool refuses a loop): each task of a
 * loop with the number of its loop. The links are the waits cell and the pilot of the task's program, as the write rule
 * reads them. One walk (Tarjan's strongly connected components, with its own stack), so it is linear in the waits.
 */
function loopsOf(byId, programs) {
  const live = (id) => byId.has(id) && !ENDED.includes(byId.get(id).state);
  const links = new Map();
  for (const [id, task] of byId) if (live(id)) {
    const pilot = programs.get(task.program)?.pilot;
    links.set(id, [...waitsOf(task).ids, ...(pilot && pilot !== id ? [pilot] : [])].filter(live));
  }
  const index = new Map(), low = new Map(), stack = [], on = new Set(), loops = new Map();
  let n = 0;
  const enter = (id) => { index.set(id, n); low.set(id, n++); stack.push(id); on.add(id); };
  for (const start of links.keys()) {
    if (index.has(start)) continue;
    enter(start);
    const walk = [[start, 0]];
    while (walk.length) {
      const top = walk.at(-1), id = top[0], next = links.get(id)[top[1]++];
      if (next !== undefined) {
        if (!index.has(next)) { enter(next); walk.push([next, 0]); }
        else if (on.has(next)) low.set(id, Math.min(low.get(id), index.get(next)));
        continue;
      }
      walk.pop();
      if (walk.length) low.set(walk.at(-1)[0], Math.min(low.get(walk.at(-1)[0]), low.get(id)));
      if (low.get(id) !== index.get(id)) continue;
      const members = [];
      for (let member; member !== id; ) { member = stack.pop(); on.delete(member); members.push(member); }
      if (members.length > 1 || links.get(id).includes(id)) for (const member of members) loops.set(member, id);
    }
  }
  return loops;
}
/** Why a lost program's gate on its pilot is not its breakdown gate, by its question (shownGraph's named): "names no program in its question". */
export const namedText = (named, id) => named ? `names ${named} in its question, not ${id}` : "names no program in its question";
/**
 * Why a lost program is lost, as every line that names it says it: its gate cell is empty (R1508-1); its gate row is gone;
 * the gate is on its pilot with the breakdown options, but its question names no program or another (named, shownGraph);
 * or the row is not its breakdown gate.
 */
export const lostWhy = (program) => !program.gate ? `${program.id} names no breakdown gate`
  : !program.gateFound ? `The breakdown gate ${program.gate} of ${program.id} is not in the logbook`
  : program.named !== undefined ? `The gate ${program.gate} of ${program.id} ${namedText(program.named, program.id)}`
  : `The gate ${program.gate} of ${program.id} is not a breakdown gate on its pilot ${program.pilot}`;
/**
 * The wait graph as every printer shows it (the boards, the status line and the task line; never a write rule or the
 * merge check): a program is proposed or changing only while its gate is its breakdown gate by the data rule
 * (breakdownGate); else it is lost, so no line says that a breakdown waits for the owner while Needs you shows the gate as
 * a plain gate. A lost program whose gate is on its pilot with the breakdown options keeps named: the program that the
 * gate's question names, or "" for none, so its reason names the question. It adds, built once: the programs by gate,
 * the tasks by program, and the loops of waits (loopsOf), so each wait of a loop is never met.
 */
export const shownGraph = ({ byId, programs }, gates) => {
  const gateOf = byIds(gates);
  const shown = (p) => {
    const gate = gateOf.get(p.gate);
    if (!["proposed", "changing"].includes(p.state) || breakdownGate(gate, programs) === p.id) return { ...p, state: p.state };
    return { ...p, state: "lost", ...(gate?.task === p.pilot && gate.options === BREAKDOWN && { named: proposalOf(gate) ?? "" }) };
  };
  const out = new Map([...programs].map(([id, p]) => [id, shown(p)])), byGate = new Map(), byProgram = new Map();
  for (const p of out.values()) (byGate.get(p.gate) ?? byGate.set(p.gate, []).get(p.gate)).push(p);
  for (const task of byId.values()) if (task.program) (byProgram.get(task.program) ?? byProgram.set(task.program, []).get(task.program)).push(task);
  return { byId, programs: out, byGate, byProgram, loops: loopsOf(byId, out) };
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
