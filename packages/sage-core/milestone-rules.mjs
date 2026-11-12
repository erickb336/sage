// The rules of waits (T336) and milestones (T337), in one place: the state tool and the board read a logbook with them
// (T233), so the status line, the merge check and the board never disagree. Pure functions of table rows: no file access.
import { BREAKS, LINE, proposalOf } from "./logbook-fields.mjs";
import { milestoneWord, releaseWord } from "./state-words.mjs";

/**
 * Waits (T336): a task may wait for other tasks of its own logbook. A wait is met when that task is merged or concluded; an
 * abandoned or lost task never meets it, also in the same merge (the owner, 2026-10-19). A task with an unmet wait takes
 * no build work (WAIT_ROLES, a move to building) and does not merge; its design and PE may run.
 *
 * Milestones (T337) add two waits that no cell holds: each task of a milestone waits for the owner's approval of the
 * milestone's breakdown, and after it, each task but the pilot waits for the pilot. The same rules read them.
 */
export const MET = ["merged", "concluded"];
export const ENDED = [...MET, "abandoned"];
export const TASK_ID = /^T[1-9]\d*$/;
export const MILESTONE_ID = /^M[1-9]\d*$/;
export const GATE_ID = /^G[1-9]\d*$/;
/**
 * The milestones table as both boards read it (C3, T233): two rows of one id, two rows that name one gate, or a bad id,
 * pilot or gate cell, make it unreadable (it throws), as the state tool never writes such a table. So no board marks a
 * gate from a damaged table, and no milestone's answered gate sets another milestone's state. The error names the row's line
 * (lines: the file's line number of each row; by default the header is line 1 and no line is blank) and its id when the
 * id is a milestone id; no other cell text.
 */
export const checkMilestones = (rows, lines = rows.map((_, i) => i + 2)) => {
  const ids = new Map(), gates = new Map();
  for (const [i, row] of rows.entries()) {
    const at = `line ${lines[i]}`;
    if (!MILESTONE_ID.test(row.id)) throw new Error(`${at} has a milestone id that is not M and a number`);
    if (ids.has(row.id)) throw new Error(`${at} has the milestone ${row.id} again (first on line ${ids.get(row.id)})`);
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
/** The milestones that the owner dropped by an answer (a decision row of the owner's answer), read once per logbook. */
export const droppedBy = (decisions, renamed = renamedIds(decisions)) => new Set(decisions.filter((d) => d.why === "the user's answer" && d.decision?.endsWith(" → drop")).map((d) => proposalOf({ question: d.decision }, renamed)).filter(Boolean));

/**
 * The rename of program to milestone (T995). A logbook from before it has programs.tsv with PG<n> ids, a program column in
 * tasks.tsv, and breakdown gates whose first line reads "Approve program PG<n>". The rename gives each old id, in the
 * order of its number, the next free milestone id after the highest M<n> that a decision's first word or a milestones row
 * names (the id floor, T641), and records the map in one decision row for each id: "M5 was PG1". Its first word is the
 * new id, so nextId counts it.
 */
const RENAMED = /^(M[1-9]\d*) was (PG[1-9]\d*)$/;
export const RENAME_WHY = "program renamed to milestone (T995)";
/** The map of old program ids to their milestone ids, from the decision rows of the rename. */
export const renamedIds = (decisions) => new Map(decisions.map(({ decision }) => RENAMED.exec(decision ?? "")).filter(Boolean).map(([, id, old]) => [old, id]));
const OLD_ID = /^PG[1-9]\d*$/;
const numberOf = (id) => BigInt(id.replace(/^\D+/, ""));
/**
 * A logbook's rows as this version reads them, and as the migration writes them (T995). tables: the rows of tasks,
 * decisions and gates, milestones (undefined when milestones.tsv is missing) and programs (undefined when programs.tsv is
 * missing). It adds a map row for each old id that has none yet (at: its time), takes each row of programs.tsv as its
 * milestone, moves each task's program cell to its milestone cell through the map, and gives each open breakdown gate the
 * new first line, so the owner's answer to it still counts once. While programs.tsv is there, its rows are the newest:
 * only a migration copies them to milestones.tsv, and an older sage may change or add one after a stopped migration
 * (F-T995-6), so a milestones row of the same id gives way to it. An answered gate and the old decision rows stay as
 * they are: proposalOf reads them through the map. A logbook after the rename reads as it is.
 */
export function renameRows({ tasks, decisions, gates, milestones, programs }, at) {
  const renamed = renamedIds(decisions);
  const old = new Set([...(programs ?? []).map((p) => p.id), ...tasks.map((t) => t.program), ...gates.map((g) => /^Approve program (PG[1-9]\d*)[ ?]/.exec(g.question ?? "")?.[1])]);
  let top = [...decisions.map((d) => /^M([1-9]\d*)(?![A-Za-z0-9])/.exec(d.decision ?? "")?.[1]), ...(milestones ?? []).map((m) => MILESTONE_ID.test(m.id) && m.id.slice(1))]
    .filter(Boolean).reduce((max, n) => (BigInt(n) > max ? BigInt(n) : max), 0n);
  const added = [...old].filter((id) => OLD_ID.test(id ?? "") && !renamed.has(id)).sort((a, b) => (numberOf(a) < numberOf(b) ? -1 : 1))
    .map((id) => { renamed.set(id, `M${++top}`); return { at, task: "", decision: `M${top} was ${id}`, why: RENAME_WHY }; });
  const to = (id) => renamed.get(id) ?? id;
  const carried = (programs ?? []).map((p) => ({ ...p, id: to(p.id) })), ids = new Set(carried.map((m) => m.id));
  return {
    decisions: added.length ? [...decisions, ...added] : decisions,
    milestones: [...carried, ...(milestones ?? []).filter((m) => !ids.has(m.id))],
    tasks: tasks.map(({ program, ...task }) => (program === undefined ? task : { ...task, milestone: task.milestone || to(program) })),
    gates: gates.map((g) => (g.answer ? g : { ...g, question: String(g.question ?? "").replace(/^Approve program (PG[1-9]\d*)(?=[ ?])/, (_, id) => (renamed.has(id) ? `Approve milestone ${renamed.get(id)}` : _)) })),
  };
}
/**
 * A milestone's state, from the answer of its latest breakdown gate, never from a cell: proposed while the gate is open,
 * active after approve, dropped after drop, changing after change or the owner's own words (they say what to change).
 * It is lost when the gate's row is gone, or when the row is not a breakdown gate on the milestone's pilot (R1208-3), so
 * no other gate sets it; but a drop holds also then, as the decision row of the owner's answer says it (R1249-4, R1266-1).
 * dropped: the ids of droppedBy. An active milestone whose tasks have all ended is done (progressOf).
 */
export const milestoneState = (gate, milestone, dropped) =>
  gate?.task !== milestone.pilot || gate.options !== BREAKDOWN
    ? dropped.has(milestone.id) ? "dropped" : "lost"
    : !gate.answer ? "proposed" : ({ approve: "active", drop: "dropped" }[gate.answer] ?? "changing");
/** What the waits of the logbook's tasks are read against: the tasks by id, and each milestone with its state. Built once per logbook. */
export const waitGraph = (tasks, milestones, gates, decisions) => {
  const gateOf = byIds(gates), renamed = renamedIds(decisions), dropped = droppedBy(decisions, renamed);
  // gateFound: the gate row that the milestone names is in the logbook, so a lost milestone says why (R1308-1). renamed:
  // the map of old program ids, for a gate's old first line (T995).
  return { byId: byIds(tasks), renamed, milestones: new Map(milestones.map((p) => [p.id, { ...p, state: milestoneState(gateOf.get(p.gate), p, dropped), gateFound: gateOf.has(p.gate) }])) };
};
/**
 * A task's waits, each with the state of its task (undefined for a task that the logbook lost), then its milestone's two
 * implicit waits: the pilot (pilot: the milestone's id) once the breakdown is approved, else the breakdown itself
 * (milestone), and odd text as one more. A milestone that the logbook does not have is a stand-in with missing: true.
 */
export const waitsWithState = (task, { byId, milestones, loops }) => {
  const { ids, odd } = waitsOf(task);
  const milestone = task?.milestone ? (milestones.get(task.milestone) ?? { id: task.milestone, state: "lost", missing: true }) : undefined;
  const pilot = milestone?.state === "active" && milestone.pilot !== task.id ? milestone.pilot : undefined;
  // An explicit wait on the pilot is a pilot wait too. loop: the wait is a link of a loop of waits (shownGraph only).
  const wait = (id) => ({ id, state: byId.get(id)?.state, ...(id === pilot && { pilot: milestone.id }), ...(loops?.has(task.id) && loops.get(task.id) === loops.get(id) && { loop: true }) });
  return [...ids.map(wait), ...(pilot && !ids.includes(pilot) ? [wait(pilot)] : []), ...(milestone && milestone.state !== "active" ? [{ milestone }] : []), ...(odd ? [{ odd }] : [])];
};
/**
 * The waits of a task that are not met. passes(id) meets a wait too: a task that passes in the same merge. A pilot wait is
 * met only when the pilot is merged or concluded, so the pilot runs first (R1204-3). A breakdown that is not approved is never met.
 */
export const unmetWaits = (task, graph, passes = () => false) => waitsWithState(task, graph).filter(({ id, state, odd, milestone, pilot }) => odd || milestone || (!MET.includes(state) && (pilot || !passes(id))));
/** A task that never meets a wait: abandoned, or lost from the logbook. */
export function dead(state) {
  return state === "abandoned" || state === undefined;
}
/**
 * A task's waits as every printer shows them (the boards, the status line and the task line; never a write rule or the
 * merge check): a breakdown whose pilot is abandoned or lost makes its milestone stuck, so the task waits for that pilot
 * instead, as in an active milestone, and never meets it (F-T385-1). graph: a shownGraph.
 */
export const shownWaits = (task, graph) => waitsWithState(task, graph).flatMap((wait) => {
  const pilot = wait.milestone?.pilot, state = graph.byId.get(pilot)?.state;
  if (!["proposed", "changing"].includes(wait.milestone?.state) || !dead(state)) return [wait];
  return pilot === task.id || waitsOf(task).ids.includes(pilot) ? [] : [{ id: pilot, state, pilot: wait.milestone.id }];
});

/**
 * The milestone whose breakdown gate this gate is, from data, never from its text alone (the owner's Q1, T233): a milestones
 * row names this gate, the gate is on that milestone's pilot, its options are approve|change|drop, and its question's first
 * line names the same milestone. Any other gate is a plain gate, whatever its text says. milestones: the milestones rows, as a
 * Map by id (one lookup) or an array.
 */
export const breakdownGate = (gate, milestones, renamed) => {
  const id = proposalOf(gate, renamed);
  if (!id || gate?.options !== BREAKDOWN) return undefined;
  const p = milestones instanceof Map ? milestones.get(id) : milestones?.find((row) => row.id === id);
  return p && p.gate === gate.id && p.pilot === gate.task ? id : undefined;
};
/**
 * The loops of waits among the tasks that have not ended, from a hand edit (the state tool refuses a loop): each task of a
 * loop with the number of its loop. The links are the waits cell and the pilot of the task's milestone, as the write rule
 * reads them. One walk (Tarjan's strongly connected components, with its own stack), so it is linear in the waits.
 */
function loopsOf(byId, milestones) {
  const live = (id) => byId.has(id) && !ENDED.includes(byId.get(id).state);
  const links = new Map();
  for (const [id, task] of byId) if (live(id)) {
    const pilot = milestones.get(task.milestone)?.pilot;
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
/** Why a lost milestone's gate on its pilot is not its breakdown gate, by its question (shownGraph's named): "names no milestone in its question". */
export const namedText = (named, id) => named ? `names ${named} in its question, not ${id}` : "names no milestone in its question";
/**
 * Why a lost milestone is lost, as every line that names it says it: its gate cell is empty (R1508-1); its gate row is gone;
 * the gate is on its pilot with the breakdown options, but its question names no milestone or another (named, shownGraph);
 * or the row is not its breakdown gate.
 */
export const lostWhy = (milestone) => !milestone.gate ? `${milestone.id} names no breakdown gate`
  : !milestone.gateFound ? `The breakdown gate ${milestone.gate} of ${milestone.id} is not in the logbook`
  : milestone.named !== undefined ? `The gate ${milestone.gate} of ${milestone.id} ${namedText(milestone.named, milestone.id)}`
  : `The gate ${milestone.gate} of ${milestone.id} is not a breakdown gate on its pilot ${milestone.pilot}`;
/**
 * The same reason as a clause after the milestone's name, for a line that already names the milestone (the status and chat
 * milestone lines, a wait for its breakdown): one rule for each of them (R1534-1). missing: a task's milestone that has no row.
 */
export const lostClause = (milestone) => milestone.missing ? "the milestone is not in the logbook" : !milestone.gate ? "the milestone names no breakdown gate"
  : !milestone.gateFound ? `its breakdown gate ${milestone.gate} is not in the logbook`
  : milestone.named !== undefined ? `its gate ${milestone.gate} ${namedText(milestone.named, milestone.id)}`
  : `its gate ${milestone.gate} is not a breakdown gate on its pilot ${milestone.pilot}`;
/**
 * The wait graph as every printer shows it (the boards, the status line and the task line; never a write rule or the
 * merge check): a milestone is proposed or changing only while its gate is its breakdown gate by the data rule
 * (breakdownGate); else it is lost, so no line says that a breakdown waits for the owner while Needs you shows the gate as
 * a plain gate. A lost milestone whose gate is on its pilot with the breakdown options keeps named: the milestone that the
 * gate's question names, or "" for none, so its reason names the question. It adds, built once: the milestones by gate,
 * the tasks by milestone, and the loops of waits (loopsOf), so each wait of a loop is never met.
 */
export const shownGraph = ({ byId, milestones, renamed }, gates) => {
  const gateOf = byIds(gates);
  const shown = (p) => {
    const gate = gateOf.get(p.gate);
    if (!["proposed", "changing"].includes(p.state) || breakdownGate(gate, milestones, renamed) === p.id) return { ...p, state: p.state };
    return { ...p, state: "lost", ...(gate?.task === p.pilot && gate.options === BREAKDOWN && { named: proposalOf(gate, renamed) ?? "" }) };
  };
  const out = new Map([...milestones].map(([id, p]) => [id, shown(p)])), byGate = new Map(), byMilestone = new Map();
  for (const p of out.values()) (byGate.get(p.gate) ?? byGate.set(p.gate, []).get(p.gate)).push(p);
  for (const task of byId.values()) if (task.milestone) (byMilestone.get(task.milestone) ?? byMilestone.set(task.milestone, []).get(task.milestone)).push(task);
  return { byId, renamed, milestones: out, byGate, byMilestone, loops: loopsOf(byId, out) };
};
/**
 * A gate's question as the board and status show it, line by line: only a breakdown gate's question (breakdownGate) has
 * lines; any other is one line, each line break a space, so no question of another gate shows a line that reads as a part of the board.
 */
export const gateLines = (gate, milestones, renamed) => (breakdownGate(gate, milestones, renamed) ? gate.question.split(LINE) : [String(gate?.question ?? "").replace(BREAKS, " ")]);

/**
 * A milestone's progress from its tasks (the owner's Q3, T233): the merged or concluded tasks of all its tasks, which keeps
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

/**
 * Releases (T1003): a release is a version that the owner ships, such as 1.0. It holds milestones and single tasks (the
 * tasks outside a milestone); a task of a milestone is in its milestone's release. A release is optional, and nothing
 * moves a milestone or a task to another release by itself. Its name is its key: two names are one name when they are equal without
 * case or width (NFKC). The releases keep their row order, so the next release is the next row: no name sorts.
 */
export const releaseKey = (name) => String(name ?? "").normalize("NFKC").toLowerCase();
/**
 * Why a release name is refused, besides the name rule of a display name (nameProblem), or null: the form of a sage id
 * (T12, M5, G3, R7, C2, PG1), which a command or a line reads as that id; none, which takes a milestone or a task out; a comma or a
 * middle dot, which a value or a status line reads as a separator; and a name that a release has already.
 */
export function releaseNameProblem(name, releases) {
  const key = releaseKey(name);
  if (/^(?:t|m|g|r|c|pg)[0-9]+$/.test(key)) return "has the form of a sage id (such as T12 or M5), so a line could read it as that id: give it a name such as 1.0 or Beta";
  if (key === "none") return "is none, which takes a milestone or a single task out of its release: give it a name such as 1.0 or Beta";
  if (/[,·]/.test(key)) return "has a comma or a middle dot (·), which a value or a status line reads as a separator";
  const twin = releases.find((r) => releaseKey(r.name) === key);
  return twin ? `is the name of the release ${twin.name} already (case and width do not count): give each release its own name` : null;
}
/**
 * The word of a task row in its release's state (the state words of T1002 read a board card; a release needs only whether
 * the task is done, stopped, not started or under way): done (merged or concluded), stopped (abandoned), not started
 * (framed), else in progress.
 */
const rowWord = (task) => (MET.includes(task.state) ? "done" : task.state === "abandoned" ? "stopped" : task.state === "framed" ? "not started" : "in progress");
/**
 * A milestone's state as the board and status show it: the state tool's, plus done (each task that is not abandoned is
 * merged or concluded) and stuck (the pilot of an active, proposed or changing milestone is abandoned or lost, so no card
 * shows its breakdown gate). graph: a shownGraph.
 */
export function shownMilestoneState(milestone, { byId, byMilestone }) {
  const pilot = byId.get(milestone.pilot)?.state;
  if (milestone.state === "active") return progressOf(byMilestone.get(milestone.id) ?? []).done ? "done" : dead(pilot) ? "stuck" : "active";
  return ["proposed", "changing"].includes(milestone.state) && dead(pilot) ? "stuck" : milestone.state;
}
/**
 * A milestone as the owner names it, with its level (T996): "Milestone 5: Sage feel" (M5), or its id when the logbook lost
 * it. Inside a sentence, give no name and inline: "the breakdown of milestone 5", as the T995 design says it.
 */
export const milestoneName = ({ id, name }, inline = false) => `${inline ? "milestone" : "Milestone"} ${/^M[1-9]\d*$/.test(id) ? id.slice(1) : id}${name ? `: ${name}` : ""}`;
/** A milestone's word and reason (state-words.mjs), as the board, status and its release show it: from its shown state, or its tasks. */
export const milestoneWordOf = (milestone, graph) => milestoneWord({ state: shownMilestoneState(milestone, graph) }, (graph.byMilestone.get(milestone.id) ?? []).map(rowWord));
/**
 * Each release in row order, with its milestones, its single tasks, its state and the count of its tasks (the tasks of its
 * milestones and its single tasks): done, stopped and all. Then a stand-in (missing: true) for each name that a release
 * cell names and the releases table lacks, so no milestone or task drops out of the count. graph: a shownGraph.
 */
export function releasesOf(releases, graph) {
  const { byId, milestones, byMilestone } = graph;
  const out = new Map(releases.map((r) => [releaseKey(r.name), { ...r, milestones: [], singles: [] }]));
  const of = (name) => out.get(releaseKey(name)) ?? out.set(releaseKey(name), { name, missing: true, milestones: [], singles: [] }).get(releaseKey(name));
  for (const m of milestones.values()) if (m.release) of(m.release).milestones.push(m);
  for (const t of byId.values()) if (t.release && !t.milestone) of(t.release).singles.push(t);
  return [...out.values()].map((r) => {
    const tasks = [...r.milestones.flatMap((m) => byMilestone.get(m.id) ?? []), ...r.singles];
    // The state words' one rule (state-words.mjs, T1002): a milestone's word from its state or its tasks, a release's from its items.
    const words = [...r.milestones.map((m) => milestoneWordOf(m, graph).word), ...r.singles.map(rowWord)];
    return { ...r, state: releaseWord(words).word, done: tasks.filter((t) => MET.includes(t.state)).length, stopped: tasks.filter((t) => t.state === "abandoned").length, total: tasks.length };
  });
}
