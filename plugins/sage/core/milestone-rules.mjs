import { BREAKS, LINE, proposalOf } from "./logbook-fields.mjs";
import { milestoneWord, releaseWord } from "./state-words.mjs";

export const MET = ["merged", "concluded"];
export const ENDED = [...MET, "abandoned"];
export const TASK_ID = /^T[1-9]\d*$/;
export const MILESTONE_ID = /^M[1-9]\d*$/;
export const GATE_ID = /^G[1-9]\d*$/;
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
export const waitWords = (value) => String(value ?? "").split(/[\s,]+/).filter(Boolean);
export const waitsOf = (task) => {
  const words = waitWords(task?.waits);
  return { ids: [...new Set(words.filter((w) => TASK_ID.test(w)))], odd: words.some((w) => !TASK_ID.test(w)) };
};
export const byIds = (tasks) => new Map(tasks.map((t) => [t.id, t]));
export const BREAKDOWN = "approve|change|drop";
export const droppedBy = (decisions, renamed = renamedIds(decisions)) => new Set(decisions.filter((d) => d.why === "the user's answer" && d.decision?.endsWith(" → drop")).map((d) => proposalOf({ question: d.decision }, renamed)).filter(Boolean));

const RENAMED = /^(M[1-9]\d*) was (PG[1-9]\d*)$/;
export const RENAME_WHY = "program renamed to milestone (T995)";
export const renamedIds = (decisions) => new Map(decisions.map(({ decision }) => RENAMED.exec(decision ?? "")).filter(Boolean).map(([, id, old]) => [old, id]));
const OLD_ID = /^PG[1-9]\d*$/;
const numberOf = (id) => BigInt(id.replace(/^\D+/, ""));
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
export const milestoneState = (gate, milestone, dropped) =>
  gate?.task !== milestone.pilot || gate.options !== BREAKDOWN
    ? dropped.has(milestone.id) ? "dropped" : "lost"
    : !gate.answer ? "proposed" : ({ approve: "active", drop: "dropped" }[gate.answer] ?? "changing");
export const waitGraph = (tasks, milestones, gates, decisions) => {
  const gateOf = byIds(gates), renamed = renamedIds(decisions), dropped = droppedBy(decisions, renamed);
  return { byId: byIds(tasks), renamed, milestones: new Map(milestones.map((p) => [p.id, { ...p, state: milestoneState(gateOf.get(p.gate), p, dropped), gateFound: gateOf.has(p.gate) }])) };
};
export const waitsWithState = (task, { byId, milestones, loops }) => {
  const { ids, odd } = waitsOf(task);
  const milestone = task?.milestone ? (milestones.get(task.milestone) ?? { id: task.milestone, state: "lost", missing: true }) : undefined;
  const pilot = milestone?.state === "active" && milestone.pilot !== task.id ? milestone.pilot : undefined;
  const wait = (id) => ({ id, state: byId.get(id)?.state, ...(id === pilot && { pilot: milestone.id }), ...(loops?.has(task.id) && loops.get(task.id) === loops.get(id) && { loop: true }) });
  return [...ids.map(wait), ...(pilot && !ids.includes(pilot) ? [wait(pilot)] : []), ...(milestone && milestone.state !== "active" ? [{ milestone }] : []), ...(odd ? [{ odd }] : [])];
};
export const unmetWaits = (task, graph, passes = () => false) => waitsWithState(task, graph).filter(({ id, state, odd, milestone, pilot }) => odd || milestone || (!MET.includes(state) && (pilot || !passes(id))));
export function dead(state) {
  return state === "abandoned" || state === undefined;
}
export const shownWaits = (task, graph) => waitsWithState(task, graph).flatMap((wait) => {
  const pilot = wait.milestone?.pilot, state = graph.byId.get(pilot)?.state;
  if (!["proposed", "changing"].includes(wait.milestone?.state) || !dead(state)) return [wait];
  return pilot === task.id || waitsOf(task).ids.includes(pilot) ? [] : [{ id: pilot, state, pilot: wait.milestone.id }];
});

export const breakdownGate = (gate, milestones, renamed) => {
  const id = proposalOf(gate, renamed);
  if (!id || gate?.options !== BREAKDOWN) return undefined;
  const p = milestones instanceof Map ? milestones.get(id) : milestones?.find((row) => row.id === id);
  return p && p.gate === gate.id && p.pilot === gate.task ? id : undefined;
};
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
export const namedText = (named, id) => named ? `names ${named} in its question, not ${id}` : "names no milestone in its question";
export const lostWhy = (milestone) => !milestone.gate ? `${milestone.id} names no breakdown gate`
  : !milestone.gateFound ? `The breakdown gate ${milestone.gate} of ${milestone.id} is not in the logbook`
  : milestone.named !== undefined ? `The gate ${milestone.gate} of ${milestone.id} ${namedText(milestone.named, milestone.id)}`
  : `The gate ${milestone.gate} of ${milestone.id} is not a breakdown gate on its pilot ${milestone.pilot}`;
export const lostClause = (milestone) => milestone.missing ? "the milestone is not in the logbook" : !milestone.gate ? "the milestone names no breakdown gate"
  : !milestone.gateFound ? `its breakdown gate ${milestone.gate} is not in the logbook`
  : milestone.named !== undefined ? `its gate ${milestone.gate} ${namedText(milestone.named, milestone.id)}`
  : `its gate ${milestone.gate} is not a breakdown gate on its pilot ${milestone.pilot}`;
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
export const gateLines = (gate, milestones, renamed) => (breakdownGate(gate, milestones, renamed) ? gate.question.split(LINE) : [String(gate?.question ?? "").replace(BREAKS, " ")]);

export const progressOf = (tasks) => {
  const merged = tasks.filter((t) => MET.includes(t.state)).length, abandoned = tasks.filter((t) => t.state === "abandoned").map((t) => t.id);
  const live = tasks.length - abandoned.length;
  return { merged, total: tasks.length, abandoned, done: live > 0 && merged === live };
};
export const progressText = ({ merged, total, abandoned }) => `${merged} of ${total} merged${abandoned.length ? ` · ${abandoned.join(", ")} abandoned` : ""}`;

export const releaseKey = (name) => String(name ?? "").normalize("NFKC").toLowerCase();
export function releaseNameProblem(name, releases) {
  const key = releaseKey(name);
  if (/^(?:t|m|g|r|c|pg)[0-9]+$/.test(key)) return "has the form of a sage id (such as T12 or M5), so a line could read it as that id: give it a name such as 1.0 or Beta";
  if (key === "none") return "is none, which takes a milestone or a single task out of its release: give it a name such as 1.0 or Beta";
  if (/[,·]/.test(key)) return "has a comma or a middle dot (·), which a value or a status line reads as a separator";
  const twin = releases.find((r) => releaseKey(r.name) === key);
  return twin ? `is the name of the release ${twin.name} already (case and width do not count): give each release its own name` : null;
}
export function shownMilestoneState(milestone, { byId, byMilestone }) {
  const pilot = byId.get(milestone.pilot)?.state;
  if (milestone.state === "active") return progressOf(byMilestone.get(milestone.id) ?? []).done ? "done" : dead(pilot) ? "stuck" : "active";
  return ["proposed", "changing"].includes(milestone.state) && dead(pilot) ? "stuck" : milestone.state;
}
export const milestoneName = ({ id, name }, inline = false) => `${inline ? "milestone" : "Milestone"} ${/^M[1-9]\d*$/.test(id) ? id.slice(1) : id}${name ? `: ${name}` : ""}`;
export const milestoneWordOf = (milestone, graph, wordOf) => milestoneWord({ state: shownMilestoneState(milestone, graph) }, (graph.byMilestone.get(milestone.id) ?? []).map(wordOf));
export function releasesOf(releases, graph, wordOf) {
  const { byId, milestones, byMilestone } = graph;
  const out = new Map(releases.map((r) => [releaseKey(r.name), { ...r, milestones: [], singles: [] }]));
  const of = (name) => out.get(releaseKey(name)) ?? out.set(releaseKey(name), { name, missing: true, milestones: [], singles: [] }).get(releaseKey(name));
  for (const m of milestones.values()) if (m.release) of(m.release).milestones.push(m);
  for (const t of byId.values()) if (t.release && !t.milestone) of(t.release).singles.push(t);
  return [...out.values()].map((r) => {
    const tasks = [...r.milestones.flatMap((m) => byMilestone.get(m.id) ?? []), ...r.singles];
    const words = [...r.milestones.map((m) => milestoneWordOf(m, graph, wordOf).word), ...r.singles.map(wordOf)];
    return { ...r, state: releaseWord(words).word, done: tasks.filter((t) => MET.includes(t.state)).length, stopped: tasks.filter((t) => t.state === "abandoned").length, total: tasks.length };
  });
}
