import { LINE, PRIORITIES, boardAnswer } from "./logbook-fields.mjs";
import { milestoneName } from "./milestone-rules.mjs";
import { STOPPED_MS } from "./chief-live.mjs";
import { taskWord } from "./state-words.mjs";

const DAY = 86_400_000, DONE_DAYS = 7, EVENT_DAYS = 30;
const ENDED = ["merged", "concluded", "abandoned"];
const MOVING = ["design", "building", "review", "ready"];
const time = value => {
  const at = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(at) ? at : null;
};
const iso = value => { const at = time(value); return at === null ? null : new Date(at).toISOString(); };
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
      task: { key: task.key, id: task.id, title: task.title },
      chief: task.holder ?? title(task.sourceLabel) ?? null,
      ...(reason.gateId && { logbook: reason.logbook, options: reason.options, digest: reason.digest, owner: reason.owner, takeover: !!reason.replace }),
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
  milestone: need.milestone ? need.key : null,
  chief: null,
  project: need.projectName ?? null,
  askedAt: null,
});

const chiefTag = (task, chiefs, chief = task.owner && chiefs.find(item => item.key === `${task.project}/${task.owner.id}`)) => task.owner ? { id: task.owner.id, provider: title(task.owner.provider) || null, stopped: chief?.stopped ?? null, waits: !!chief?.waitsForOwner }
  : task.old ? { id: null, provider: title(task.old.provider), stopped: null } : task.shared ? null : { id: null, provider: title(task.providerStandIn), stopped: null };
const QUIET = ["done", "wait"];
const stepOf = task => task.loop?.steps.find(step => !QUIET.includes(step.status)) ?? null;
const CI = { done: "pass", failed: "fail" };

function cyclesOf(task) {
  const reviews = task.cycles.some(cycle => cycle.steps.length > 0);
  const known = !task.cycles.some(cycle => cycle.steps.some(step => step.status === "unknown"));
  return { required: task.requiredCycles, clean: reviews && known ? task.cycles.filter(cycle => cycle.steps.every(step => step.status === "done")).length : null, reviews };
}

function taskRow(task, chiefs) {
  const step = task.route ? stepOf(task) : null;
  return {
    key: task.key, id: task.id, title: task.title, project: task.projectName, state: task.state, word: task.word ?? null, ended: ENDED.includes(task.state),
    priority: task.priority || null, kind: task.kind || null, size: task.size || null, pr: task.pr || null,
    milestone: task.milestone ? { key: task.milestone.key, id: task.milestone.id, title: milestoneName({ id: task.milestone.id, name: task.milestone.name ?? "" }) } : null,
    chief: chiefTag(task, chiefs), needsYou: task.reasons.length > 0, waits: task.waitLine?.text ?? null,
    waitsFor: task.waits.filter(wait => wait.id).map(wait => ({ key: `${task.project}/${wait.id}`, id: wait.id, met: wait.met })),
    why: task.reasons.length ? taskWord(task).reason : null,
    conflicts: task.mayConflict.map(other => ({ key: other.key, id: other.id, chief: other.chief })),
    step: step ? { label: step.label, status: step.status } : null, lastActivity: task.lastActivity,
    addedAt: iso(task.addedAt), doneAt: iso(task.completedAt),
    prUrl: /^[1-9]\d*$/.test(task.pr) && task.repository ? `${task.repository}/pull/${task.pr}` : null, cycles: cyclesOf(task),
    ci: CI[task.cycles[0]?.steps.find(item => item.role === "checks")?.status] ?? null,
  };
}

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
  const chiefs = (model.projects ?? []).filter(project => !project.archived).flatMap(project => (project.chiefs ?? []).map(chief => ({ ...chief, project: project.name, logbook: chief.key.slice(0, chief.key.lastIndexOf("/")) })));
  const leaving = [...merged.map(task => time(task.completedAt)), ...failed.map(run => time(run.ended))].map(when => when + DAY + 1)
    .concat(chiefs.filter(chief => chief.stopped === false && !chief.agents && !chief.waitsForOwner).map(chief => time(chief.heartbeat) + STOPPED_MS + 1));

  return {
    at: model.at,
    stale: !!model.stale,
    problems: (model.diagnostics ?? []).map(item => item.message),
    projects: (model.projects ?? []).filter(project => !project.archived).map(project => project.name),
    chiefs,
    needs,
    answered: tasks.flatMap(task => task.boardAnswers.map(item => ({ ...item, task: { key: task.key, id: task.id, title: task.title }, project: task.projectName }))).sort((a, b) => (time(a.at) ?? 0) - (time(b.at) ?? 0)),
    tasks: tasks.map(task => taskRow(task, chiefs)),
    failedAt: tasks.flatMap(task => task.runs).filter(run => run.status === "failed" && time(run.ended) > at - EVENT_DAYS * DAY).map(run => iso(run.ended)),
    milestones,
    hiddenDone,
    counts: { merged: merged.length, stuck: failed.length + stuckAgents(model.agents), stuckNow: stuckAgents(model.agents), added: tasks.some(task => task.addedAt) ? tasks.filter(task => recent(task.addedAt)).length : null },
    next: leaving.length ? Math.min(...leaving) : null,
  };
}

const LOG_MAX = 200;
const firstLine = text => String(text ?? "").split(LINE)[0].trim();

function logOf(task) {
  const events = [
    ...(task.decisionRows ?? []).map(row => ({ at: row.at, who: "chief", text: `${row.decision}${row.why ? ` · ${row.why}` : ""}` })),
    ...task.runs.flatMap(run => [
      { at: run.started, who: run.id, text: `${run.role} started` },
      ...(run.status === "running" ? [] : [{ at: run.ended, who: run.id, text: `${run.role} ended: ${run.status}` }]),
    ]),
    ...task.ledger.map(row => ({ at: row.at, who: row.run || "CI", text: `${row.kind}${row.cycle ? ` · cycle ${row.cycle}` : ""}${row.sha ? ` on ${String(row.sha).slice(0, 7)}` : ""}` })),
  ].map(event => ({ ...event, at: iso(event.at) }));
  return events.sort((a, b) => (time(b.at) ?? -Infinity) - (time(a.at) ?? -Infinity));
}

export function taskPanel(model, key) {
  const task = model.tasks.find(item => item.key === key);
  if (!task) return null;
  const chiefs = (model.projects ?? []).flatMap(project => (project.chiefs ?? []).map(chief => ({ ...chief, project: project.name })));
  const log = logOf(task);
  return {
    ...taskRow(task, chiefs),
    at: model.at,
    route: task.route ? task.route.split(",") : [], risk: task.risk || null, branch: task.branch || null,
    logbook: task.project.slice(task.project.indexOf("/") + 1),
    conflicts: task.mayConflict.map(other => ({ key: other.key, id: other.id, chief: other.chief, paths: other.paths })),
    steps: task.route ? task.loop.steps.map(step => ({ key: step.key, label: step.label, status: step.status, detail: step.detail, parts: (step.parts ?? []).map(([name, status]) => ({ name, status })) })) : [],
    now: task.route ? task.loop.now.text : "The logbook records no route for this task, so the board shows no steps.", next: task.route ? task.loop.next : null,
    lastEvent: log[0] ?? null,
    log: log.slice(0, LOG_MAX), logMore: Math.max(0, log.length - LOG_MAX),
    decisions: [...(task.gateRows ?? [])].reverse().map(gate => ({ id: gate.id, question: firstLine(gate.question), answer: gate.answer || null, pending: boardAnswer(gate)?.answer ?? null, recommendation: gate.recommendation || null, at: iso(gate.at) })),
    artifacts: task.artifacts.map(record => ({ id: record.id, type: record.data.type, label: record.data.label, run: record.data.run ?? null, at: iso(record.observedAt),
      url: /^https:\/\//.test(record.data.url ?? "") ? record.data.url : null, path: record.data.path ?? null, verified: !!record.content?.verified })),
    runs: task.runs.map(run => ({ id: run.id, role: run.role })),
  };
}
