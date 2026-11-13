import { LINE, PRIORITIES } from "./logbook-fields.mjs";
import { milestoneName } from "./milestone-rules.mjs";

const DAY = 86_400_000, DONE_DAYS = 7;
const ENDED = ["merged", "concluded", "abandoned"];
const MOVING = ["design", "building", "review", "ready"];
const time = value => {
  const at = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(at) ? at : null;
};
const title = text => text ? `${String(text).charAt(0).toUpperCase()}${String(text).slice(1)}` : text;
const rank = priority => priority ? PRIORITIES.indexOf(priority) : PRIORITIES.length;
const STATE_ORDER = ["stuck", "lost", "active", "changing", "proposed", "done"];
const stateRank = state => STATE_ORDER.includes(state) ? STATE_ORDER.indexOf(state) : STATE_ORDER.length;
const number = id => Number(String(id).replace(/^\D+/, "")) || 0;

function stuckAgents(agents) {
  let count = 0;
  const walk = agent => { if (agent.state === "stuck") count++; for (const child of agent.children ?? []) walk(child); };
  for (const project of agents?.projects ?? []) for (const agent of project.agents) walk(agent);
  return count;
}

function gateNeeds(task) {
  return task.reasons.map((reason, index) => {
    const [question, ...more] = String(reason.text ?? "").split(LINE).map(line => line.trim()).filter(Boolean);
    const gate = reason.gateId ? task.gates.find(row => row.id === reason.gateId) : null;
    return {
      key: reason.key ?? `${task.key}/${reason.kind}/${index}`,
      kind: reason.kind,
      question: question ?? "",
      more,
      recommendation: reason.recommendation ?? null,
      gate: reason.gateId ?? null,
      task: { id: task.id, title: task.title },
      chief: task.holder ?? title(task.sourceLabel) ?? null,
      project: task.projectName,
      askedAt: gate && time(gate.at) !== null ? new Date(time(gate.at)).toISOString() : null,
    };
  });
}

const milestoneNeed = need => ({
  key: `${need.kind}/${need.key ?? ""}/${need.title}`,
  kind: need.kind,
  question: need.title,
  more: need.text ? [need.text] : [],
  recommendation: null,
  gate: null,
  task: null,
  chief: null,
  project: need.projectName ?? null,
  askedAt: null,
});

export function boardOverview(model) {
  const at = time(model.at);
  const since = at - DAY;
  const recent = value => { const when = time(value); return when !== null && when > since && when <= at; };
  const tasks = model.tasks.filter(task => !task.archived);
  const byKey = new Map(model.tasks.map(task => [task.key, task]));

  const needs = [...model.needsOwner.flatMap(gateNeeds), ...(model.milestoneNeeds ?? []).map(milestoneNeed)]
    .sort((a, b) => (time(a.askedAt) ?? -Infinity) - (time(b.askedAt) ?? -Infinity));

  let hiddenDone = 0;
  const milestones = model.milestones.filter(milestone => !milestone.archived && milestone.state !== "dropped").flatMap(milestone => {
    const own = milestone.tasks.map(key => byKey.get(key)).filter(Boolean);
    const open = own.filter(task => !ENDED.includes(task.state));
    const lastDone = Math.max(-Infinity, ...own.map(task => time(task.completedAt)).filter(when => when !== null));
    if (milestone.state === "done" && !(lastDone > at - DONE_DAYS * DAY)) { hiddenDone++; return []; }
    return [{
      key: milestone.key,
      id: milestone.id,
      title: milestoneName(milestone),
      goal: milestone.goal || null,
      project: milestone.projectName,
      state: milestone.state,
      word: milestone.word,
      priority: PRIORITIES.find(priority => open.some(task => task.priority === priority)) ?? null,
      merged: milestone.progress.merged,
      total: milestone.progress.total,
      abandoned: milestone.progress.abandoned.length,
      moving: open.filter(task => MOVING.includes(task.column)).length,
      waiting: milestone.waiting,
      needsYou: open.filter(task => task.reasons.length).length + (milestone.need ? 1 : 0),
      progressText: milestone.progressText,
      pilot: milestone.pilot,
      doneAt: milestone.state === "done" && Number.isFinite(lastDone) ? new Date(lastDone).toISOString() : null,
    }];
  }).sort((a, b) => rank(a.priority) - rank(b.priority) || stateRank(a.state) - stateRank(b.state) || number(a.id) - number(b.id));

  const merged = tasks.filter(task => task.state === "merged" && recent(task.completedAt));
  const failed = tasks.flatMap(task => task.runs).filter(run => run.status === "failed" && recent(run.ended));
  const leaving = [...merged.map(task => time(task.completedAt)), ...failed.map(run => time(run.ended))].map(when => when + DAY + 1);

  return {
    at: model.at,
    stale: !!model.stale,
    problems: (model.diagnostics ?? []).map(item => item.message),
    projects: (model.projects ?? []).filter(project => !project.archived).map(project => project.name),
    needs,
    milestones,
    hiddenDone,
    counts: { merged: merged.length, stuck: failed.length + stuckAgents(model.agents), added: null },
    next: leaving.length ? Math.min(...leaving) : null,
  };
}
