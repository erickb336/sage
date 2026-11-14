import { createHash } from "node:crypto";
import { basename } from "node:path";
import { githubRepository, hookProvider } from "./board-reader.mjs";
import { LINE, PRIORITIES, TASK_KINDS, agentCaps, agentLimit, proposalOf, queueOrder } from "./logbook-fields.mjs";
import { ENDED, MET, breakdownGate, dead, gateLines, lostWhy, milestoneName, milestoneWordOf, namedText, progressOf, progressText, releasesOf, shownGraph, shownMilestoneState, shownWaits, waitGraph, waitsOf } from "./milestone-rules.mjs";
import { taskWord } from "./state-words.mjs";
import { offerOf, replaceOf } from "./chiefs.mjs";
import { boardChiefs } from "./chief-live.mjs";
import { checkoutLabel, plainName } from "./shared-root.mjs";
const COLUMNS = [
  ["backlog", "Backlog", ["framed"]],
  ["design", "Design", ["designing", "awaiting-you"]],
  ["building", "Building", ["briefed", "building", "repairing", "held", "replan"]],
  ["review", "In review", ["reviewing", "verifying"]],
  ["ready", "Ready to merge", ["verified", "pr-ready"]],
  ["done", "Done", ["merged", "concluded"]],
];
const CLEAN = { checks: "checks-pass", "code-review": "review-clean", "security-review": "security-clean", "ux-review": "ux-clean", qa: "qa-pass", "evidence-review": "evidence-clean" };
const FAILED = { checks: ["checks-fail"], qa: ["qa-fail"], "code-review": ["findings"], "security-review": ["findings"], "ux-review": ["findings"], "evidence-review": ["findings"] };
const RUN_ROLE = { "code-review": "code-reviewer", "security-review": "security-reviewer", "ux-review": "ux-reviewer" };
const time = value => Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
let build = 0;
const once = fn => { let cache, at = -1; return list => { if (at !== build) [cache, at] = [new WeakMap(), build]; if (!cache.has(list)) cache.set(list, fn(list)); return cache.get(list); }; };
const byTask = once(list => { const index = new Map(); for (const row of list) (index.get(row.task) ?? index.set(row.task, []).get(row.task)).push(row); return index; });
const NONE = [];
const rows = (project, name, task) => byTask(project.tables[name] ?? NONE).get(task.id) ?? NONE;
const runRecords = once(records => new Map(records.filter(record => record.kind === "run").map(record => [record.data.run, record])));
const movesOf = once(decisions => {
  const from = new Map(), to = new Map();
  for (const row of decisions) {
    const move = /^(F-\S+) moved to (T[1-9]\d*) as (F-\S+):/.exec(row.decision ?? "");
    if (!move) continue;
    (from.get(row.task) ?? from.set(row.task, []).get(row.task)).push({ row, move });
    (to.get(move[2]) ?? to.set(move[2], []).get(move[2])).push({ row, move });
  }
  return { from, to };
});
const standIn = source => source.provider ?? source.label ?? source.id;
const standInOf = (source, project) => project.old?.provider ?? (project.shared ? "unknown" : standIn(source));
export const projectName = project => project.displayName ?? [project.upstream, project.repository].map(url => githubRepository(url)?.split("/").at(-1)).find(Boolean)
  ?? (project.checkout ? plainName(basename(project.checkout)) : project.name.replace(/-[0-9a-f]{6}$/, ""));
const WRITERS = ["implementer", "designer", "arena-judge"];
const rank = task => task.priority ? PRIORITIES.indexOf(task.priority) : PRIORITIES.length;
const positive =value => /^([1-9]\d*)$/.test(String(value)) ? Number(value) : null;

function latest(records, kind, accept = () => true) {
  return records.filter(record => record.kind === kind && accept(record.data)).reduce((best, record) => !best || Date.parse(record.observedAt) >= Date.parse(best.observedAt) ? record : best, null);
}

function briefFields(text) {
  const fields = {}; let field = null;
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const match = /^(?:[ \t]|[*_#|>-])*([A-Z]+)\b[*_]*(?:[ \t]*:[*_ \t]*|[ \t]+|$)(.*)$/i.exec(line);
    if (match && ["GOAL", "SCOPE", "CONTEXT", "DECISIONS", "ACCEPTANCE", "VERIFY", "BUDGET", "FORBIDDEN", "REPORT", "STANDING"].includes(match[1].toUpperCase())) { field = match[1].toUpperCase(); fields[field] = match[2]; }
    else if (field) fields[field] += `\n${line}`;
  }
  return { goal: fields.GOAL?.trim() || null, acceptance: fields.ACCEPTANCE?.trim() || null };
}
const ROLE_WORD = { checks: "checks", "code-review": "code review", "security-review": "security review", "ux-review": "UX review", qa: "QA", "evidence-review": "evidence review" };
const AGENT_WORD = { implementer: "implementer", lead: "lead", designer: "designer", pe: "PE", investigate: "investigator", "code-reviewer": "code reviewer", "security-reviewer": "security reviewer", "ux-reviewer": "UX reviewer", qa: "QA agent", "evidence-review": "evidence reviewer" };
const PART = { done: "done", failed: "fail", pending: "wait", unknown: "unknown" };
const PLANNING = ["framed", "designing", "awaiting-you"];
const BEFORE_REVIEW = [...PLANNING, "briefed", "building", "held", "replan"];
const MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");
const dayMonth = ms => { const at = new Date(ms); return `${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]}`; };
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const cap = text => text.charAt(0).toUpperCase() + text.slice(1);
const and = list => list.length > 1 ? `${list.slice(0, -1).join(", ")} and ${list.at(-1)}` : list[0] ?? "";
const STALE_MS = 86400000;
export function runClock(started, now, lastActivity) {
  const start = time(started);
  if (start === null) return { text: "start time unknown", stale: false };
  const minutes = Math.max(0, Math.floor((now - start) / 60000));
  if (minutes < 60) return { text: `${minutes} min`, stale: false };
  if (minutes < 24 * 60) return { text: `${Math.floor(minutes / 60)} h ${minutes % 60} min`, stale: false };
  const last = Math.max(start, time(lastActivity) ?? start);
  return now - last >= STALE_MS ? { text: `no news since ${dayMonth(last)}. The run may have stopped, so ask the chief to check it`, stale: true, since: dayMonth(last) } : { text: `since ${dayMonth(start)}`, stale: false };
}

const PHASE = {
  framed: ["plan", "agent", false], designing: ["plan", "agent", true], "awaiting-you": ["plan", "owner", true],
  briefed: ["build", "agent", false], building: ["build", "agent", true], held: ["build", "chief", true], replan: ["build", "chief", true],
  reviewing: ["review", "agent", true], repairing: ["repair", "agent", true], verifying: ["merge", "chief", false],
  verified: ["merge", "owner", false], "pr-ready": ["merge", "owner", false], merged: [null, "done"], concluded: [null, "done"], abandoned: [null, "done"],
};

function stepLine({ task, route, cycles, required, head, judged, reasons, merge, gates, runs, ledger, rounds, autopilot }) {
  const state = PHASE[task.state] ? task.state : "abandoned", build = route.includes("build"), sha = head ? head.slice(0, 7) : null;
  const gate = gates.find(row => !row.answer), answered = !gate && gates.length && gates.at(-1).answer ? gates.at(-1) : null;
  const running = runs.filter(run => run.status === "running"), live = running.filter(run => !run.clock.stale), stale = running.filter(run => run.clock.stale);
  const round = Number(task.round) || 1;
  const reviewing = task.state === "reviewing";
  const clean = cycle => cycle.steps.every(step => step.status === "done");
  const at = Math.max(0, cycles.findIndex(cycle => !clean(cycle)));
  const allClean = reviewing && judged && cycles.every(clean);
  const failed = reviewing && judged && !allClean ? cycles[at].steps.filter(step => step.status === "failed").map(step => ROLE_WORD[step.role] ?? step.role) : [];
  let [step, who, started] = PHASE[state];
  if (allClean) [step, who, started] = ["merge", "chief", false];
  if (["verified", "pr-ready"].includes(state) && (autopilot || !build)) who = "chief";
  if (state === "awaiting-you" && answered) who = "chief";
  if (gate && who !== "done") who = "owner";

  const reviewName = i => build ? `review cycle ${i} of ${required}` : required > 1 ? `evidence review ${i} of ${required}` : "the evidence review";
  const NAME = { plan: task.state === "designing" ? "the design" : "the plan", build: build ? "the build" : "the investigation", review: reviewName(at + 1), repair: `repair round ${round} of ${rounds}`, merge: build ? "the merge" : "the conclusion" };
  const actor = list => and([...new Set(list.map(run => `the ${AGENT_WORD[run.role] ?? run.role}`))]);
  const ago = run => { const clock = run.clock.text; return /^\d/.test(clock) ? `${clock} ago` : clock.startsWith("since ") ? `on ${clock.slice(6)}` : "at a time that is not recorded"; };
  const runText = run => run.clock.stale ? `No news from the ${AGENT_WORD[run.role] ?? run.role} (run ${run.id}) since ${run.clock.since}. The run may have stopped, so ask the chief to check it.`
    : `The ${AGENT_WORD[run.role] ?? run.role} (${run.evidence?.data.provider ? `${run.evidence.data.provider}, ` : ""}run ${run.id}) is at work. It started ${ago(run)}.`;
  const heldAt = gate ? `Held at gate ${gate.id} (the question above).` : null;
  const status = who === "owner" ? "need" : failed.length ? "fail" : who === "agent" ? live.length ? "run" : stale.length ? "stale" : started ? "idle" : "wait" : who === "chief" ? "idle" : "done";
  const agentDetail = idle => live.length ? runText(live[0]) : stale.length ? runText(stale[0]) : idle;

  const steps = [];
  const order = s => ["plan", "build", "review", "repair", "merge"].indexOf(s);
  const place = key => step === null ? (state === "abandoned" && key !== "plan" ? "after" : "before") : order(key) < order(step) ? "before" : order(key) > order(step) ? "after" : "at";
  const mark = (key, done = "done") => ({ before: done, at: status, after: "wait" })[place(key)];

  const pe = running.find(run => run.role === "pe");
  const planDetail = place("plan") === "before" ? "Framed and briefed." : heldAt ?? (state === "framed" ? "In the backlog. No agent works on it."
    : state === "awaiting-you" ? answered ? `You answered gate ${answered.id}. The chief moves the design on.` : "The design waits for your answer."
    : agentDetail("No agent works on the design now."));
  const designPart = place("plan") === "before" ? "done" : state === "framed" ? "wait" : pe ? "done" : status;
  steps.push({ key: "plan", label: "Plan", status: mark("plan"), detail: planDetail,
    parts: [["framed", "done"], ...(route.includes("design") ? [["design", designPart]] : []),
      ...(route.includes("pe") ? [["PE check", pe ? pe.clock.stale ? "stale" : "run" : PLANNING.includes(state) ? "wait" : "done"]] : []),
      ["briefed", place("plan") === "before" ? "done" : "wait"]] });

  const doneBuild = build ? task.pr ? `PR ${task.pr}${sha ? `, last commit ${sha}` : ""}.` : "Built." : "The report is written.";
  const buildDetail = { before: doneBuild, after: "" }[place("build")] ?? heldAt ?? (state === "held" ? task.hold === "round" ? `Held after ${plural(Number(task.round) || 0, "repair round")} that did not make it clean.` : "Held by the chief."
    : state === "replan" ? "It needs a new plan." : agentDetail(state === "briefed" ? "Briefed. No agent took the brief yet." : `No agent works on ${NAME.build} now.`));
  steps.push({ key: "build", label: build ? "Build" : "Investigate", status: mark("build"), detail: buildDetail });

  const why = required > 1 ? task.risk ? `A risk flag (${task.risk.replace(/,/g, ", ")}) needs ${required} clean cycles.` : task.size === "large" ? `A large task needs ${required} clean cycles.` : `The project needs ${required} clean cycles.` : "";
  const reviewLabel = number => build ? `Review ${number} of ${required}` : required > 1 ? `Evidence review ${number} of ${required}` : "Evidence review";
  const partOf = item => item.status === "running" ? runs.find(run => run.id === item.run)?.clock.stale ? "stale" : "run" : PART[item.status] ?? "unknown";
  const waiting = cycle => cycle.steps.map(item => [ROLE_WORD[item.role] ?? item.role, "wait"]);
  if (task.state === "repairing") {
    const fails = ledger.filter(row => String(row.pr) === task.pr && ["findings", "checks-fail", "qa-fail"].includes(row.kind)), last = fails.at(-1);
    const what = last ? { "checks-fail": "The checks failed", "qa-fail": "QA failed" }[last.kind] ?? `The ${ROLE_WORD[(runs.find(run => run.id === last.run)?.role ?? "").replace(/er$/, "")] ?? "review"} found problems` : "A review found problems";
    steps.push({ key: "review", label: last && positive(last.cycle) ? reviewLabel(positive(last.cycle)) : build ? "Review" : "Evidence review", status: "fail", detail: `${what}${last?.sha && build ? ` on ${String(last.sha).slice(0, 7)}` : ""}.` });
    steps.push({ key: "repair", label: `Repair, round ${round} of ${rounds}`, status, detail: heldAt ?? agentDetail("No agent works on the repair now.") },
      { key: "again", label: "Review again", status: "wait", detail: build ? `A new commit starts again from cycle 1 of ${required}.` : "The evidence review starts again.", parts: cycles[0] ? waiting(cycles[0]) : [] });
  } else for (const [i, cycle] of cycles.entries()) {
    if (place("review") === "before" && !clean(cycle)) continue;
    const where = place("review"), pos = where === "at" ? i < at ? "before" : i > at ? "after" : "at" : where;
    const first = build ? task.pr ? "Starts when the build is done." : "Starts when the PR opens." : "Starts when the report is written.";
    const runningRun = cycle.steps.map(item => runs.find(run => run.id === item.run)).find(Boolean);
    const detail = pos === "before" ? build && sha ? `Clean on ${sha}.` : "Clean."
      : pos === "after" ? where === "after" && i === 0 && BEFORE_REVIEW.includes(task.state) ? first : why
      : heldAt ?? (failed.length ? `${cap(and(failed))} failed${sha ? ` on ${sha}` : ""}.` : `${build ? sha ? `On the last commit (${sha}).` : "The board does not know the PR's last commit, so it shows no verdicts yet." : "The evidence review checks the report."}${live.length || stale.length ? ` ${runText(runningRun ?? live[0] ?? stale[0])}` : ""}`);
    const parts = pos === "before" ? cycle.steps.map(item => [ROLE_WORD[item.role] ?? item.role, "done"]) : BEFORE_REVIEW.includes(task.state) ? waiting(cycle) : cycle.steps.map(item => [ROLE_WORD[item.role] ?? item.role, partOf(item)]);
    steps.push({ key: `review-${i + 1}`, label: reviewLabel(i + 1), status: { before: "done", at: status, after: "wait" }[pos], detail, parts });
  }

  const mergeDetail = { before: build ? task.state === "concluded" ? "Closed with no merge." : "Merged." : "The report went to you.", after: build ? `After ${plural(required, "clean cycle")}${required > 1 ? " on one commit" : ""}.` : "The report goes to you." }[place("merge")]
    ?? heldAt ?? (!build ? "The chief concludes it." : task.state === "verifying" || allClean ? "The chief checks the verdicts first." : merge && !merge.ok ? merge.text
      : `${merge ? `${merge.text} ` : ""}${autopilot ? "Autopilot merges it."
      : reasons.some(reason => reason.kind === "merge" && reason.mode) ? "Autopilot is off, so the merge waits for you." : "The board cannot tell if autopilot is on, so the merge waits for you."}`);
  steps.push({ key: "merge", label: build ? "Merge" : "Conclude", status: mark("merge"), detail: mergeDetail });

  const name = step === "review" ? NAME.review : NAME[step] ?? "";
  const needs = reasons.length ? reasons.map(reason => `${reason.text}${reason.recommendation ? `${reason.text.includes(LINE) ? LINE : " "}I recommend: ${reason.recommendation}` : ""}`).join(reasons.some(reason => reason.text.includes(LINE)) ? LINE : " ") : null;
  const CHIEF = {
    held: () => `${task.hold === "round" ? `Held after ${plural(Number(task.round) || 0, "repair round")} that did not make it clean.` : "Held by the chief."}${answered ? ` You answered gate ${answered.id}, so the chief moves it on.` : ""}`,
    replan: () => `The last repair round did not fix its findings, so the task needs a new plan.${answered ? ` You answered gate ${answered.id}.` : ""}`,
    "awaiting-you": () => `You answered gate ${answered.id}. The chief moves the design on.`,
    verifying: () => build ? "The chief checks the verdicts before the merge." : "The chief checks the evidence review before the conclusion.",
    verified: () => build ? `Verified. Autopilot merges ${task.pr ? `PR ${task.pr}` : "it"}.` : "Verified. The chief concludes it.",
  };
  CHIEF["pr-ready"] = CHIEF.verified;
  const IDLE = { framed: "In the backlog. No agent works on it.", briefed: `Briefed. No agent works on ${NAME.build} yet.` };
  const noHead = build && reviewing && !head ? " The board does not know the PR's last commit." : "";
  const nowText = who === "done" ? { merged: build ? "Merged." : "Done.", concluded: build ? "Closed with no merge." : "Concluded. The report went to you.", abandoned: "Abandoned." }[state]
    : allClean ? build ? `The reviews are done, with ${plural(required, "clean cycle")} on ${sha}.` : "The evidence review is done."
    : failed.length ? `${cap(and(failed))} failed${sha ? ` on ${sha}` : ""}.`
    : who === "chief" ? CHIEF[state]()
    : live.length ? `${cap(actor(live))} ${new Set(live.map(run => run.role)).size > 1 ? "are" : "is"} at work on ${name}.${noHead}`
    : stale.length ? `No news from ${actor(stale)} since ${stale[0].clock.since}. The run may have stopped, so ask the chief to check it.`
    : `${IDLE[state] ?? `No agent works on ${name} now.`}${noHead}`;

  const pending = reviewing && judged ? cycles[at].steps.find(item => item.status === "pending") : null;
  const after = at + 1 < required ? reviewName(at + 2) : NAME.merge;
  const NEXT = {
    framed: route.includes("design") ? "The design." : `${cap(NAME.build)}.`,
    designing: "The design goes to you. It waits for your answer only when it changes what you see or data that you keep.",
    "awaiting-you": answered ? `The chief briefs ${NAME.build}.` : `${cap(NAME.build)} is briefed after your answer.`,
    briefed: `${cap(NAME.build)}.`,
    building: build ? `Review cycle 1 of ${required}, ${task.pr ? "on the PR's last commit" : "when the PR opens"}.` : `${cap(reviewName(1))}.`,
    held: answered ? `${cap(NAME.build)} goes on, or the chief briefs it again.` : "The chief asks you how to go on.",
    replan: "The chief briefs it again.",
    reviewing: allClean ? build ? "The chief checks the verdicts, then the merge." : "The chief checks the evidence review, then the conclusion."
      : failed.length ? build ? "A repair round, then the reviews start again at cycle 1." : "A repair round, then the evidence review starts again."
      : !build ? at + 1 < required ? `${cap(reviewName(at + 2))}.` : "The conclusion. The report comes to you."
      : !head ? "The review cycles on the PR's last commit, then the merge."
      : pending ? `${cap(ROLE_WORD[pending.role] ?? pending.role)}, then ${after}.` : `${cap(after)}.`,
    repairing: build ? "The reviews start again at cycle 1 on the new commit." : "The evidence review starts again.",
    verifying: build ? "The merge." : "The conclusion. The report comes to you.",
    verified: build ? "Done after the merge." : "The conclusion. The report comes to you.",
  };
  NEXT["pr-ready"] = NEXT.verified;
  const AFTER = { replan: "The chief briefs it again after your answer.", "awaiting-you": `${cap(NAME.build)} is briefed after your answer.` };
  const next = who === "done" ? null : gate ? AFTER[state] ?? `${cap(name)} ${started ? "goes on" : "starts"} after your answer.` : NEXT[state];
  return { steps, current: step, now: needs ? { needs: true, text: needs } : { needs: false, stale: status === "stale", text: nowText }, next };
}


const graphOf = project => shownGraph(waitGraph((project.tables.tasks ?? []).filter(task => /^T[1-9]\d*$/.test(task.id)), project.tables.milestones ?? [], project.tables.gates ?? [], project.tables.decisions ?? []), project.tables.gates ?? []);
const LOST_FIX = id => `ask the chief to repair the logbook, or to propose ${id} again.`;
const waitsFor = (task, graph) => shownWaits(task, graph).map(wait =>
  wait.odd ? { odd: true, met: false, never: true }
  : wait.milestone ? { breakdown: { id: wait.milestone.id, gate: wait.milestone.gate ?? null, pilot: wait.milestone.pilot, state: wait.milestone.state, gateFound: !!wait.milestone.gateFound, ...(wait.milestone.missing && { missing: true }), ...(wait.milestone.named !== undefined && { named: wait.milestone.named }) }, met: false, never: ["dropped", "lost"].includes(wait.milestone.state) }
  : { id: wait.id, state: wait.state ?? null, pilot: !!wait.pilot, met: MET.includes(wait.state), never: dead(wait.state) || !!wait.loop, ...(wait.loop && { loop: true }) });
const BREAKDOWN_WAIT = {
  proposed: (id, gate) => `your approval of ${milestoneName({ id }, true)} (gate ${gate})`,
  changing: (id, gate) => `the new breakdown of ${milestoneName({ id }, true)}: you asked for changes (gate ${gate})`,
  dropped: (id, gate) => `the breakdown of ${milestoneName({ id }, true)}, which you dropped (gate ${gate})`,
};
const waitName = wait => wait.breakdown ? BREAKDOWN_WAIT[wait.breakdown.state]?.(wait.breakdown.id, wait.breakdown.gate) ?? `the breakdown of ${milestoneName({ id: wait.breakdown.id }, true)}, ${wait.breakdown.missing ? "which is not in the logbook" : !wait.breakdown.gate ? "whose milestone names no breakdown gate" : wait.breakdown.named !== undefined ? `whose gate ${wait.breakdown.gate} ${namedText(wait.breakdown.named, wait.breakdown.id)}` : wait.breakdown.gateFound ? `whose gate ${wait.breakdown.gate} is not a breakdown gate` : `whose gate ${wait.breakdown.gate} is not in the logbook`}`
  : `${wait.id}${wait.pilot || wait.word ? ` (${[wait.pilot && "pilot", wait.word].filter(Boolean).join(", ")})` : ""}`;
function namedWaits(tasks, byKey) {
  for (const task of tasks) task.word = taskWord(task).word;
  for (const task of tasks) {
    for (const wait of task.waits) if (wait.id) wait.word = `${wait.state === null ? "not in the logbook" : byKey.get(`${task.project}/${wait.id}`)?.word ?? wait.state}${wait.loop ? ", in a loop" : ""}`;
    if (task.waitLine) task.waitLine = waitLine(task, task.waits, task.column);
  }
}
function waitLine(task, waits, column) {
  const unmet = ENDED.includes(task.state) ? [] : waits.filter(wait => !wait.met), breakdown = unmet.some(wait => wait.breakdown);
  const open = [...unmet.filter(wait => wait.never), ...unmet.filter(wait => !wait.never && (!breakdown || wait.breakdown))];
  if (!open.length) return null;
  const never = open.some(wait => wait.never), named = open.filter(wait => !wait.odd), odd = named.length < open.length ? " Its waits cell has text that is not a task id: the chief sets its waits again." : "";
  const loop = open.some(wait => wait.loop) ? " Its waits make a loop, which never ends: the chief sets its waits again." : "";
  if (!named.length) return { never, text: `It cannot start.${odd}` };
  return { never, text: `Waits for ${and(named.map(waitName))}${never ? ": it cannot start." : "."}${odd}${loop}${!never && column === "design" ? " Design and PE may run." : ""}` };
}

function card(source, project, group, task, now, graph, landing) {
  const records = (byTask(project.observations?.records ?? NONE).get(task.id) ?? NONE).filter(record => time(record.observedAt) !== null && time(record.observedAt) <= now);
  const pr = latest(records, "pr", data => String(data.number) === task.pr);
  const completion = latest(records, "completion", data => data.state === task.state);
  const mode = latest(records, "mode"), files = latest(records, "files");
  const ledger = rows(project, "ledger", task);
  const times = [...rows(project, "runs", task).flatMap(run => [run.started, run.ended]), ...ledger.map(row => row.at), ...rows(project, "decisions", task).map(row => row.at)].map(time).filter(at => at !== null);
  const lastActivity = times.length ? new Date(Math.max(...times)).toISOString() : null;
  const shared = !!project.shared, chiefs = project.chiefs ?? NONE, chiefOf = id => chiefs.find(chief => chief.id === id);
  const goneCheckouts = project.goneCheckouts ?? NONE, unchecked = project.uncheckedCheckouts ?? NONE;
  const where = checkout => shared && checkout?.startsWith("/") ? { checkoutName: checkoutLabel(project.checkouts ?? NONE, checkout), checkoutGone: unchecked.includes(checkout) ? null : goneCheckouts.includes(checkout) } : {};
  const runs = rows(project, "runs", task).map(({ checkout, ...run }) => { const evidence = latest(records, "run", data => data.run === run.id); const chief = shared ? chiefOf(run.chief) : null; return { ...run, ...where(checkout), evidence, provider: evidence?.data.provider ?? (chief ? title(chief.provider) : null), clock: runClock(run.started, now, lastActivity) }; });
  const writer = runs.filter(run => WRITERS.includes(run.role) && String(run.branch ?? "").toLowerCase() === String(task.branch ?? "").toLowerCase() && /^R[1-9]\d*$/.test(run.id)).sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1))).at(-1);
  const agents = runs.filter(run => run.status === "running").map(run => ({ id: run.id, role: run.role, provider: run.provider, evidence: run.evidence, recordedStatus: run.status, stale: run.clock.stale }));
  const label = id => chiefOf(id) ? `${title(chiefOf(id).provider)} · ${id}` : id;
  const allGates = rows(project, "gates", task), gates = allGates.filter(gate => !gate.answer);
  const reasons = (project.old && ENDED.includes(task.state) ? NONE : gates).map(gate => {
    const breakdown = breakdownGate(gate, graph.milestones);
    const lost = (graph.byGate.get(gate.id) ?? []).filter(milestone => milestone.state === "lost").map(milestone => `${lostWhy(milestone)}: ${LOST_FIX(milestone.id)}`);
    const replace = gate.kind === "replace" && replaceOf(gate), options = gate.options ? gate.options.split("|").map(option => option.trim()) : [];
    const what = `${task.id}${task.pr ? ` and PR ${task.pr}` : ""}`;
    const text = replace ? `${replace.from ? `Hand ${what} from ${label(replace.from)} to ${label(replace.to)}?` : `Hand ${what} to ${label(replace.to)}? It has no owning chief.`} ${replace.runs.length ? `${and(replace.runs)} ${replace.runs.length === 1 ? "ends" : "end"} as failed.` : "No run ends as failed."}${replace.fresh ? ` ${label(replace.to)} runs one fresh cycle before it merges.` : ""}` : [...gateLines(gate, graph.milestones), ...lost].join(LINE);
    const offered = replace && offerOf(task), handed = offered && offered.from === replace.from && offered.to === replace.to;
    const why = !replace ? "" : handed ? `because ${label(replace.from)} offered ${task.id} to ${label(replace.to)}` : !replace.from ? `because ${task.id} has no owning chief` : replace.runs.length ? `when you know that ${label(replace.from)} stopped` : `because no run of ${task.id} ends as failed`;
    const recommendation = replace && gate.recommendation === options[0] ? `${options[0]}, ${why}` : gate.recommendation || null;
    return { kind: "gate", ...(replace && { replace: true }), key: `${project.key}/${gate.id}`, text, recommendation, gateId: gate.id, options,
      breakdown: breakdown ? { key: `${project.key}/${breakdown}`, id: breakdown, name: graph.milestones.get(breakdown).name } : null };
  });
  if (task.state === "awaiting-you" && !gates.length && !allGates.at(-1)?.answer) reasons.push({ kind: "design", text: "The design waits for your answer." });
  const unknown = shared && !reasons.some(reason => reason.replace) ? unknownChief(task, runs, label) : null;
  if (unknown) reasons.push(unknown);
  const round = Number(task.round || 0), repairing = task.state === "repairing";
  const verdicts = task.pr ? ledger.filter(row => String(row.pr) === task.pr && /^[0-9a-f]{40}$/.test(row.sha)) : [];
  const rounds = verdicts.map(row => { const run = runs.find(run => run.id === row.run); return run ? Number(run.round || 0) : null; });
  const first = verdicts.findLastIndex((row, i) => verdicts.findIndex(other => other.sha === row.sha) === i);
  const known = round === 0 || rounds.some(r => r !== null && r <= round);
  const reviewed = !repairing && known && first > rounds.findLastIndex(r => r !== null && r < round) ? verdicts[first].sha : null;
  const head = pr?.data.head ?? reviewed;
  const headBasis = pr?.data.head ? "observed" : head ? "ledger" : null;
  const route = task.route.split(",").filter(Boolean), build = route.includes("build");
  const judged = build ? !!head : true;
  const verified = ["verified", "pr-ready"].includes(task.state) && build;
  const checked = verified && head && landing ? landing(source.id, head, task.pr, project) : null;
  const projectCheck = checked?.scope === "project" ? checked : null;
  const checkName = projectCheck ? "The project check" : "The merge check";
  const merge = !verified ? null : !head ? { ok: false, text: `The merge check is not checked, because the board does not know ${task.pr ? `the last commit of PR ${task.pr}` : "the task's PR"}.` }
    : !checked ? { ok: false, text: `The merge check is not checked on ${head.slice(0, 7)}, because this board cannot run it.` }
    : checked.ok ? { ok: !projectCheck, text: `${checkName} passes on ${head.slice(0, 7)}. ${projectCheck ? "The global merge check is not checked. " : ""}The board does not check the PR's head branch.` }
    : { ok: false, text: `${checkName} refuses ${head.slice(0, 7)}. ${cap(checked.reason.split(/\.(?:\s|$)/)[0])}.` };
  if (merge && !merge.ok) reasons.push({ kind: checked && !checked.ok ? "merge-refused" : "merge-check", text: merge.text });
  else if (merge && mode?.data.autopilot !== true) {
    const what = task.pr ? `review and merge PR ${task.pr}` : "review and merge it";
    reasons.push({ kind: "merge", mode: !!mode, text: mode ? `Autopilot is off, so ${what}.` : `The board cannot tell if autopilot is on, so ${what}.` });
  }
  const current = repairing ? [] : build ? head ? ledger.filter(row => row.sha === head && String(row.pr) === task.pr) : [] : ledger.filter(row => !row.sha);
  const steps = [...(build ? ["checks"] : []), ...route.filter(block => CLEAN[block])];
  const required = Math.max(positive(source.config?.["cycles.small"]) ?? 1, task.size === "large" ? Math.max(2, positive(source.config?.["cycles.large"] ?? source.config?.autopilot_cycles) ?? 2) : 1, task.risk ? Math.max(2, positive(source.config?.["cycles.risk"]) ?? 2) : 1);
  const count = Math.min(required, 10);
  const verdict = (role, number) => current.filter(row => (role === "checks" || positive(row.cycle) === number) && (row.kind === CLEAN[role] || (FAILED[role] ?? []).includes(row.kind) && (row.kind !== "findings" || runs.some(run => run.id === row.run && run.role === (RUN_ROLE[role] ?? role))))).at(-1) ?? null;
  const cycles = Array.from({ length: count }, (_, i) => ({ number: i + 1, steps: steps.map(role => {
    const last = verdict(role, i + 1);
    const open = Array.from({ length: count }, (_, j) => j + 1).find(number => !verdict(role, number));
    const running = runs.find(run => run.status === "running" && run.role === (RUN_ROLE[role] ?? role) && (run.evidence ? (run.evidence.data.head ?? null) === head && run.evidence.data.cycle === i + 1 : open === i + 1));
    return { role, status: !judged ? "unknown" : last ? last.kind === CLEAN[role] ? "done" : "failed" : running ? "running" : "pending", evidence: last, run: running?.id ?? null };
  }) }));
  for (const [index, row] of current.entries()) {
    if (!["checks-fail", "qa-fail"].includes(row.kind)) continue;
    const newer = current.slice(index + 1).find(other => other.kind === (row.kind === "checks-fail" ? "checks-pass" : "qa-pass") && other.cycle === row.cycle);
    if (!newer && !merge?.ok) reasons.push({ kind: row.kind, text: `${row.kind === "checks-fail" ? "Checks" : "QA"} failed on the recorded PR head.`, evidence: row });
  }
  const worker = project.shared ? NO_SLOT_NOTES.includes(String(chiefOf(task.chief)?.provider ?? "").toLowerCase()) : task.branch.startsWith("codex/");
  const inferred = pr?.data.state === "open" && worker && !agents.length;
  if (inferred && !["merged", "concluded", "abandoned"].includes(task.state)) reasons.push({ kind: "review-wait", text: "The PR has inferred provider work and waits for review." });
  const column = merge && !merge.ok ? "review" : COLUMNS.find(([, , states]) => states.includes(task.state))?.[0] ?? null;
  const milestone = task.milestone ? graph.milestones.get(task.milestone) : null, waits = waitsFor(task, graph);
  const completionDecision = rows(project, "decisions", task).filter(row => row.decision === `state ${task.state}`).at(-1);
  const completedAt = completion ? time(completion.data.at) : ["merged", "concluded", "abandoned"].includes(task.state) ? time(completionDecision?.at) : null;
  const brief = project.contents?.[latest(records, "artifact", data => data.type === "brief")?.id]?.text ?? null;
  const moves = movesOf(project.tables.decisions ?? NONE);
  const found = (to, key) => rows(project, "findings", { id: to }).find(row => row.key === key);
  const findings = [
    ...rows(project, "findings", task).map(row => ({ ...row, movedFrom: (moves.to.get(task.id) ?? NONE).find(({ move }) => move[3] === row.key)?.row.task ?? null })),
    ...(moves.from.get(task.id) ?? NONE).map(({ row, move }) => { const [, run = "", severity = ""] = /^the (?:follow-up|open) task \(from (R[1-9]\d*), (\w+)\)/.exec(row.why ?? "") ?? []; return { severity, summary: row.decision.slice(row.decision.indexOf(":") + 1).trim(), ...found(move[2], move[3]), run, task: task.id, key: move[1], status: "moved", reason: "", movedTo: move[2] }; }),
  ];
  return { key: `${project.key}/${task.id}`, source: source.id, sourceLabel: source.label, providerStandIn: standInOf(source, project), repository: githubRepository(pr?.data.repository) ?? githubRepository(project.repository), lastActivity, headBasis, project: project.key, group: group.key, projectName: group.name, archived: group.archived, milestone: task.milestone ? { key: `${project.key}/${task.milestone}`, id: task.milestone, name: milestone?.name ?? null, pilot: milestone?.pilot === task.id } : null, waits, waitLine: waitLine(task, waits, column), priority: PRIORITIES.includes(task.priority) ? task.priority : "", kind: TASK_KINDS.includes(task.kind) ? task.kind : "", ...Object.fromEntries(["id", "title", "size", "risk", "route", "state", "branch", "pr", "round", "keys", "hold"].map(field => [field, task[field] ?? ""])), column, prEvidence: pr, currentHead: head, modeEvidence: mode, completedAt, visible: column !== "done" || completedAt !== null && completedAt <= now && completedAt >= now - 7 * 86400000, agents, inferredWork: inferred, cycles, requiredCycles: required, reasons, runs, ledger, gates, findings, decisions: rows(project, "decisions", task).slice(-10), decisionRows: rows(project, "decisions", task), gateRows: allGates, brief, briefFields: briefFields(brief), projectCheck, mergeCheck: merge, loop: stepLine({ task, route, cycles, required: count, head, judged, reasons, merge, gates: allGates, runs, ledger, rounds: positive(source.config?.max_rounds) ?? 3, autopilot: mode?.data.autopilot === true }), changedFiles: files && { ...files.data, observedAt: files.observedAt }, mayConflict: [], runClocks: Object.fromEntries(runs.filter(run => run.status === "running").map(run => [run.id, run.clock])), goneRun: writer?.checkoutGone ? writer.id : null, artifacts: records.filter(record => record.kind === "artifact").map(record => ({ ...record, content: project.contents?.[record.id] ?? null })), diagnostics: [...project.diagnostics], ...holderOf(project, task, runs, label, gates),...(wasOf(project, task) && { was: wasOf(project, task) }) };
}

function markConflicts(tasks) {
  const open = tasks.filter(task => task.owner && task.changedFiles && !ENDED.includes(task.state));
  for (const [i, a] of open.entries()) {
    const mine = new Set(a.changedFiles.paths);
    for (const b of open.slice(i + 1)) {
      const paths = a.project === b.project && a.owner.id !== b.owner.id ? b.changedFiles.paths.filter(path => mine.has(path)) : NONE;
      if (!paths.length) continue;
      a.mayConflict.push({ key: b.key, id: b.id, chief: b.owner.label, paths });
      b.mayConflict.push({ key: a.key, id: a.id, chief: a.owner.label, paths });
    }
  }
}

function holderOf(project, task, runs, label, gates) {
  if (project.old) {
    const provider = project.old.provider;
    return { old: { provider, label: `Old · ${title(provider)} · read-only`, finished: ENDED.includes(task.state) }, who: provider, holder: `Old · ${title(provider)} · read-only` };
  }
  if (!project.shared) return {};
  const chief = task.chief ? (project.chiefs ?? NONE).find(row => row.id === task.chief) ?? null : null;
  const owner = task.chief ? { id: task.chief, provider: chief?.provider ?? null, label: label(task.chief), ...(!chief && project.chiefs && { unlisted: true }) } : null;
  const offer = offerOf(task), active = runs.filter(run => run.status === "running").map(run => run.id);
  const asked = offer && gates.find(gate => gate.kind === "replace" && ((p) => p && p.from === offer.from && p.to === offer.to)(replaceOf(gate)));
  const offerText = !offer ? null : asked ? `${label(offer.to)} asks to take this. Needs you: ${asked.id}.` : `Offered to ${label(offer.to)}. ${active.length ? `It waits for ${and(active)} to end, then ${label(offer.to)} accepts.` : `Ready: ${label(offer.to)} can accept.`}`;
  return { shared: true, owner, offer: offerText, who: String(owner?.provider ?? "").toLowerCase(), holder: owner ? owner.label : "Unclaimed" };
}

function unknownChief(task, runs, label) {
  const run = task.chief ? runs.find(run => run.status === "running" && run.chief === task.chief && run.clock.stale) : null;
  return run ? { kind: "chief-unknown", text: `The owning chief, ${label(task.chief)}, may have stopped: ${run.id} shows no change for over 24 h.`, recommendation: "if it stopped, ask any chief to open a takeover gate." } : null;
}

const title = value => String(value ?? "").charAt(0).toUpperCase() + String(value ?? "").slice(1);
function wasOf(project, task) {
  if (!project.shared) return null;
  try {
    const record = JSON.parse(task.adoption || "null");
    return record?.version === 2 && /^[a-z][a-z0-9-]*$/.test(record.provider ?? "") && /^T[1-9]\d*$/.test(record.task ?? "") ? `was ${title(record.provider)} ${record.task}` : null;
  } catch {
    return null;
  }
}
const ACTIVE_DAYS = 14;
const repoPath = url => githubRepository(url)?.slice("https://github.com/".length) ?? null;
const unique = list => list.filter((item, i) => item && list.indexOf(item) === i);

function projectGroups(sources) {
  const byName = new Map(), groups = [], notes = [];
  for (const source of sources) for (const project of source.projects) if (!project.old) byName.set(project.name, [...(byName.get(project.name) ?? []), { source, project }]);
  const keys = books => books.map(book => book.project.key).join(" and ");
  const note = (books, message) => notes.push({ source: books.map(book => book.source.id).join(" + "), project: books[0].project.name, message });
  for (const books of byName.values()) {
    if (unique(books.map(book => book.project.checkout)).length > 1) {
      note(books, `Two projects: ${keys(books)} have one logbook key but name different checkouts, so the board keeps them apart.`);
      for (const book of books) groups.push({ key: book.project.key, books: [book] });
      continue;
    }
    const unknown = books.filter(book => !book.project.checkout);
    if (books.length > 1 && unknown.length) note(books, `One project: the checkout of ${keys(unknown)} is not known, and the logbook key is the same.`);
    groups.push({ key: books[0].project.name, books });
  }
  for (const source of sources) for (const project of source.projects.filter(project => project.old)) {
    const group = groups.find(group => group.books.some(book => book.project.key === project.old.of));
    if (group) group.books.push({ source, project }); else groups.push({ key: project.key, books: [{ source, project }] });
  }
  for (const group of groups) {
    const own = group.books.filter(book => !book.project.old), known = own.filter(book => book.project.checkout), trusted = known.length ? known : own.length ? own : group.books;
    const projects = trusted.map(book => book.project), first = field => projects.map(project => project[field]).find(Boolean) ?? null;
    const names = unique(projects.map(project => project.displayName));
    if (names.length > 1) note(trusted, `Two display names: the board shows "${names[0]}" (the first source), not ${names.slice(1).map(other => `"${other}"`).join(", ")}.`);
    const archived = trusted.filter(book => book.project.archived);
    if (archived.length && archived.length < trusted.length) note(trusted, `Archived in ${keys(archived)} only: the board does not archive the project.`);
    const merged = { name: projects[0].name, displayName: first("displayName"), upstream: first("upstream"), repository: first("repository"), checkout: first("checkout") };
    const full = repoPath(merged.upstream) ?? repoPath(merged.repository), folder = merged.checkout ? plainName(basename(merged.checkout)) : null;
    const all = group.books.map(book => book.project), problem = all.flatMap(project => project.diagnostics)[0] ?? null;
    const remote = full ? `${full}${!merged.displayName && repoPath(merged.upstream) ? " (upstream)" : ""}` : null;
    const linked = own.flatMap(book => book.project.checkouts ?? NONE), live = linked.filter(item => !item.gone);
    const where = live.length > 1 ? `${live.length} checkouts: ${live.map(item => checkoutLabel(linked, item.root)).join(", ")}` : folder && `folder ${folder}`;
    for (const book of own) for (const name of book.project.foreignCheckouts ?? NONE) note([book], `A checkout named ${name} is linked to this logbook, but it has no first commit in common with it. sage does not use that link: commands in ${name} stop and offer a new link. Ask the chief in ${name}.`);
    const sub = merged.checkout || remote ? [remote ?? "no GitHub remote", where] : [`logbook ${merged.name}`];
    Object.assign(group, {
      name: all.every(project => unreadable(project).length) ? merged.name : projectName(merged),
      remote, path: merged.checkout ?? null,
      archived: archived.length > 0 && archived.length === trusted.length, problem: problem && plainProblem(problem),
      providers: unique(group.books.flatMap(book => book.project.old ? [title(book.project.old.provider)] : book.project.shared ? (book.project.chiefs ?? []).map(chief => title(chief.provider)) : [title(standIn(book.source))])),
      sub: unique(sub).join(" · "),
      terms: unique([...names, repoPath(merged.upstream), ...all.map(project => repoPath(project.repository)), folder, ...linked.map(item => plainName(basename(item.root))), merged.name, ...all.map(project => project.key)]),
      paths: unique([...all.map(project => project.checkout), ...linked.map(item => item.root)]),
    });
  }
  const lines = new Map(groups.map(group => [group, `${group.name}\n${group.sub}`])), line = group => lines.get(group);
  const twins = groups.filter(group => group.path && groups.some(other => other !== group && line(other) === line(group)));
  for (const group of twins) {
    const others = twins.filter(other => other !== group && line(other) === line(group)), parts = group.path.split(/[\\/]/).filter(Boolean);
    const end = n => parts.slice(-n).join("/"), clone = [group, ...others].map(item => item.key).sort().indexOf(group.key) + 1;
    let n = 1; while (n < parts.length && others.some(other => other.path.split(/[\\/]/).filter(Boolean).slice(-n).join("/") === end(n))) n++;
    Object.assign(group, { sub: `clone ${clone} · ${group.remote ?? "no GitHub remote"}`, pathSub: `…/${end(n)} · ${group.remote ?? "no GitHub remote"}` });
  }
  return { groups, notes };
}

const PLAIN = { EACCES: "has no read permission", EPERM: "has no read permission", ENOENT: "is missing", EISDIR: "is a folder, not a file", ELOOP: "is a link, which the board does not follow", EMFILE: "cannot open now, because too many files are open" };
function plainProblem(message) {
  const coded = /^([a-z][\w .-]*): (E[A-Z]+)$/.exec(message) ?? /^()(E[A-Z]+)$/.exec(message);
  if (!coded) return message;
  return `${coded[1] ? `its ${coded[1]} file` : "its folder"} ${PLAIN[coded[2]] ?? "cannot be read"}`;
}

export const AGENT_QUIET_MS = 30 * 60_000;
const LONG_FACTOR = 2, LONG_BASIS = 5;
const NO_SLOT_NOTES = ["codex"];
export const AGENT_STATES = ["stuck", "stop", "long", "wait", "work", "unk"];
const LOOK = ["stuck", "stop", "long"];
const sha256 = text => createHash("sha256").update(text).digest("hex");
const minutes = ms => Math.max(0, Math.floor(ms / 60_000));
const span = ms => { const m = minutes(ms); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}`; };
const article = word => /^[aeiou]/i.test(word) ? `an ${word}` : `a ${word}`;
const median = list => { const sorted = [...list].sort((a, b) => a - b), mid = sorted.length >> 1; return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2; };

function slotOf(slot) {
  const mark = prefix => slot.marks.find(name => name.startsWith(prefix))?.slice(prefix.length);
  const hex = value => /^[0-9a-f]{64}$/.test(value ?? "") ? value : null;
  const helper = /^([0-9a-f]{64})\.(R[1-9]\d*)$/.exec(mark("helper-") ?? "");
  return { name: slot.name, at: slot.at, ok: slot.marks.includes("ok"), project: /^[a-z0-9][a-z0-9-]*$/.test(mark("project-") ?? "") ? mark("project-") : null,
    role: /^sage_[a-z-]+$/.test(mark("role-") ?? "") ? mark("role-").slice(5) : null, run: /^R[1-9]\d*$/.test(mark("run-") ?? "") ? mark("run-") : null,
    bound: hex(mark("bound-")), parent: hex(mark("parent-")), logbook: hex(mark("logbook-")), lead: helper?.[1] ?? null };
}

function agentsOf(sources, groups, groupOf, cards, at) {
  const rows = [], problems = [], caps = [];
  const bare = name => name.replace(/-[0-9a-f]{6}$/, "");
  const groupNamed = name => groups.find(group => group.books.some(book => bare(book.project.name) === name));
  const hooked = sources.map(source => {
    const hooks = source.hooks ?? { present: false, slots: [], helpers: [], problem: null };
    return { source, hooks, provider: String(source.provider ?? standIn(source)).toLowerCase(), writer: String(hookProvider(source) ?? standIn(source)).toLowerCase(), slots: hooks.slots.map(slotOf), known: hooks.present && !hooks.problem };
  });
  const runs = sources.flatMap(source => source.projects.filter(book => !book.old).flatMap(book => (book.tables.runs ?? []).filter(run => run.status === "running" && /^R[1-9]\d*$/.test(run.id)).map(run => ({ source, book, run }))));
  const leadKey = item => sha256(`${item.book.logbook}:${item.run.id}`);
  const providerOf = item => runRecords(item.book.observations?.records ?? NONE).get(item.run.id)?.data.provider ?? (item.book.shared ? (item.book.chiefs ?? NONE).find(chief => chief.id === item.run.chief)?.provider : null) ?? standInOf(item.source, item.book);
  const notesOf = (item, prov) => item.source.shared ? hooked.find(entry => !entry.source.shared && entry.writer === prov) : hooked.find(entry => entry.source === item.source);
  const taken = new Set();
  const row = (source, item, extra) => {
    const group = item ? groupOf.get(item.book.key) : groupNamed(extra.slot?.project);
    const card = item ? cards.get(`${item.book.key}/${item.run.task}`) : null;
    rows.push({ key: `${source.id}/${item ? `${item.book.name}/${item.run.id}` : extra.slot.name}`, source: source.id, runId: item?.run.id ?? extra.slot?.run ?? null, run: item?.run ?? null,
      group: group?.key ?? `slot:${extra.slot?.project ?? "other"}`, groupName: group?.name ?? extra.slot?.project ?? "other",
      provider: String(item ? providerOf(item) : source.provider ?? standIn(source)), role: item?.run.role ?? extra.slot?.role ?? "agent", model: item?.run.model || null,
      task: card ? { key: card.key, id: card.id, title: card.title, kind: card.kind, priority: card.priority } : item ? { key: null, id: item.run.task, title: "", kind: "", priority: "" } : null,
      lead: null, children: [], ...extra });
  };
  for (const { source, hooks, provider, slots, known } of hooked) {
    if (hooks.problem) problems.push({ source: source.id, message: plainProblem(hooks.problem) });
    if (known) {
      const config = agentCaps(source.config);
      const used = name => slots.filter(slot => slot.project === name).length;
      caps.push({ source: source.id, label: title(provider), total: { used: slots.length, cap: config.total }, of: name => ({ used: used(name), cap: config.cap(name) }) });
    }
    for (const slot of slots.filter(slot => slot.ok)) {
      const match = slot.run ? runs.filter(item => (item.source === source || item.source.shared) && item.run.id === slot.run && bare(item.book.name) === slot.project && (!slot.logbook || item.book.logbook === slot.logbook)) : [];
      const own = match.filter(item => item.source === source), found = own.length ? own : match;
      const item = found.length === 1 ? found[0] : null;
      if (item) taken.add(item);
      row(source, item, { slot, activity: slot.at, leadKey: item && slot.role === "lead" ? leadKey(item) : null, helperOf: slot.lead });
    }
  }
  for (const item of runs.filter(item => !taken.has(item))) {
    const prov = String(providerOf(item)).toLowerCase(), entry = notesOf(item, prov);
    const note = (entry?.hooks.helpers ?? NONE).filter(note => note.run === item.run.id && runs.some(lead => lead.book === item.book && lead.run.role === "lead" && leadKey(lead) === note.lead));
    const stopped = note.find(note => note.stopped);
    const how = NO_SLOT_NOTES.includes(prov) ? "logbook" : !entry?.known ? "unknown" : stopped ? "stopped" : "noslot";
    row(entry?.source ?? item.source, item, { slot: null, activity: null, how, stoppedAt: stopped?.at ?? null, leadKey: item.run.role === "lead" ? leadKey(item) : null, helperOf: note[0]?.lead ?? null });
  }
  for (const child of rows) {
    const lead = rows.find(other => other !== child && other.source === child.source && (child.slot?.parent && other.slot?.bound === child.slot.parent || child.helperOf && other.leadKey === child.helperOf));
    if (lead) { child.lead = lead.runId ?? lead.key; lead.children.push(child); }
  }
  const usual = new Map();
  const usualOf = (group, role) => {
    const key = `${group}\n${role}`;
    if (!usual.has(key)) {
      const books = groups.find(item => item.key === group)?.books ?? [];
      const ended = books.flatMap(book => book.project.tables.runs ?? []).filter(run => run.role === role && run.status !== "running").map(run => time(run.ended) - time(run.started)).filter(ms => Number.isFinite(ms) && ms >= 0);
      usual.set(key, ended.length >= LONG_BASIS ? median(ended) : null);
    }
    return usual.get(key);
  };
  let next = Infinity;
  const soon = ms => { if (ms > at) next = Math.min(next, ms); };
  for (const agent of rows) {
    const started = time(agent.run?.started);
    agent.running = started === null ? null : Math.max(0, at - started);
    agent.idle = agent.activity === null ? null : Math.max(0, at - agent.activity);
    const helpers = agent.children.filter(child => child.slot);
    if (agent.slot) {
      if (helpers.length) [agent.state, agent.why] = ["wait", `${helpers.filter(child => at - child.activity < AGENT_QUIET_MS).length} of ${agent.children.length} helper${agent.children.length === 1 ? "" : "s"} working`];
      else if (agent.idle >= AGENT_QUIET_MS) [agent.state, agent.why] = ["stuck", `no activity for ${span(agent.idle)}`];
      else { [agent.state, agent.why] = ["work", ""]; soon(agent.activity + AGENT_QUIET_MS); }
    } else if (agent.how === "logbook") [agent.state, agent.why] = ["unk", `${title(agent.provider)} sends no activity notes yet`];
    else if (agent.how === "unknown") [agent.state, agent.why] = ["unk", "no hook notes: activity not known"];
    else if (agent.how === "stopped") [agent.state, agent.why] = ["stop", `stopped${agent.stoppedAt ? ` at ${new Date(agent.stoppedAt).toISOString().slice(11, 16)} UTC` : ""}; the logbook still says running`];
    else [agent.state, agent.why] = ["stuck", "no agent slot holds this run: the hook frees a slot after 60 min with no activity. Ask the chief to check the run."];
    const basis = agent.run && ["work", "unk"].includes(agent.state) ? usualOf(agent.group, agent.run.role) : null;
    if (basis !== null && agent.running !== null) {
      if (agent.running > LONG_FACTOR * basis) [agent.state, agent.why] = ["long", `${span(agent.running)}; usual for ${article(agent.run.role)} here is about ${span(basis)}`];
      else soon(started + LONG_FACTOR * basis + 1);
    }
  }
  const order = agent => AGENT_STATES.indexOf(agent.state);
  const sort = list => list.sort((a, b) => order(a) - order(b) || (b.running ?? 0) - (a.running ?? 0));
  for (const agent of rows) sort(agent.children);
  const byGroup = new Map();
  for (const agent of rows) byGroup.set(agent.group, [...(byGroup.get(agent.group) ?? []), agent]);
  const projects = [...byGroup.entries()].map(([key, list]) => {
    const name = list[0].groupName, group = groups.find(item => item.key === key);
    const hooked = caps.find(entry => list.some(agent => agent.source === entry.source && agent.how !== "logbook"));
    const cap = hooked ? { label: hooked.label, ...hooked.of(group ? bare(group.books[0].project.name) : key.slice(5)) } : null;
    return { key, name, sub: group?.sub ?? "", pathSub: group?.pathSub ?? null, agents: sort(list.filter(agent => !agent.lead)), count: list.length, look: list.filter(agent => LOOK.includes(agent.state)).length, worst: Math.min(...list.map(order)), cap };
  }).sort((a, b) => a.worst - b.worst || b.count - a.count || a.name.localeCompare(b.name));
  const providers = [...new Set(rows.map(agent => title(agent.provider.toLowerCase())))].map(name => ({ name, count: rows.filter(agent => title(agent.provider.toLowerCase()) === name).length }));
  return { count: rows.length, queues: queuesOf(sources, groups), look: rows.filter(agent => LOOK.includes(agent.state)).length, providers, projects,
    caps: caps.map(entry => ({ label: entry.label, total: entry.total, projects: projects.filter(project => project.cap?.label === entry.label).map(project => ({ name: project.name, used: project.cap.used, cap: project.cap.cap })) })),
    problems, unmatched: rows.filter(agent => agent.how === "noslot").map(agent => ({ run: agent.runId, project: agent.groupName })), next: Number.isFinite(next) ? next : null,
    rules: { quiet: AGENT_QUIET_MS / 60_000, factor: LONG_FACTOR, basis: LONG_BASIS } };
}

function queuesOf(sources, groups) {
  const roots = sources.filter(source => !source.shared).map(source => source.config);
  return groups.flatMap(group => group.books.filter(({ project }) => !project.old).map(({ source, project }) => {
    const runs = project.tables.runs ?? [], running = runs.filter(run => run.status === "running").length;
    const chiefOf = run => (project.chiefs ?? NONE).find(chief => chief.id === run.chief);
    const queued = queueOrder(runs.filter(run => /^R[1-9]\d*$/.test(run.id))).map((run, i) => ({ run: run.id, task: run.task, role: run.role, chief: run.chief || null, chiefProvider: chiefOf(run)?.provider ?? null, place: i + 1, since: run.started || null }));
    const names = [project.name.replace(/-[0-9a-f]{6}$/, "")];
    const limit = project.shared ? agentLimit({ max_agents: project.limit }, roots, names) : agentLimit({}, [source.config], names);
    return { key: project.key, group: group.key, running, limit, queued, text: `${running} of ${limit} agents${queued.length ? ` · ${queued.length} queued` : ""}` };
  })).filter(queue => queue.running || queue.queued.length);
}

function milestoneOrder(milestone, own) {
  const byId = new Map(own.map(task => [task.id, task])), depth = new Map(), open = new Set();
  const pilot = byId.has(milestone.pilot);
  const upsOf = task => task.id === milestone.pilot ? [] : waitsOf(task).ids.filter(id => byId.has(id));
  for (const start of own) {
    if (depth.has(start.id)) continue;
    const stack = [[start, upsOf(start), 0]];
    open.add(start.id);
    while (stack.length) {
      const top = stack.at(-1), [task, ups] = top;
      const next = ups[top[2]++];
      if (next !== undefined) {
        if (!depth.has(next) && !open.has(next)) { open.add(next); stack.push([byId.get(next), upsOf(byId.get(next)), 0]); }
        continue;
      }
      const values = [...ups.map(id => depth.get(id) ?? 0), ...(pilot && task.id !== milestone.pilot ? [0] : [])];
      depth.set(task.id, values.length ? 1 + Math.max(...values) : 0);
      open.delete(task.id);
      stack.pop();
    }
  }
  const number = id => Number(id.slice(1));
  return own.map(task => [task, depth.get(task.id)]).sort((a, b) => a[1] - b[1] || number(a[0].id) - number(b[0].id));
}

function milestonesOf(source, project, group, graph, cards) {
  const gates = new Map((project.tables.gates ?? []).map(gate => [gate.id, gate]));
  const questions = new Map();
  for (const gate of gates.values()) { const id = proposalOf(gate, graph.renamed); if (id) questions.set(id, [...questions.get(id) ?? [], gate.question]); }
  const was = new Map([...graph.renamed].map(([old, id]) => [id, old]));
  return [...graph.milestones.values()].map(milestone => {
    const own = graph.byMilestone.get(milestone.id) ?? [], progress = progressOf(own), pilotState = graph.byId.get(milestone.pilot)?.state;
    const state = shownMilestoneState(milestone, graph);
    const layered = milestoneOrder(milestone, own), ordered = layered.map(([task]) => task), card = task => cards.get(`${project.key}/${task.id}`);
    const open = ordered.filter(task => !ENDED.includes(task.state)).map(card).filter(Boolean);
    const moving = open.filter(item => item.waits.every(wait => wait.met)), waiting = open.filter(item => item.waitLine);
    const first = state === "active" ? moving[0] : null;
    const unread = { stuck: "tasks", lost: "gates" }[state], damaged = unread && cannotRead(project, unread);
    const need = damaged ? { kind: "unread", title: `${milestoneName(milestone)}: its state cannot be read`, text: `The board cannot read ${unread}.tsv. Ask the chief to repair the logbook.` }
      : state === "stuck" ? { kind: "stuck", title: `${milestoneName(milestone)} is stuck`, text: `The pilot ${milestone.pilot} ${pilotState ? "was abandoned" : "is not in the logbook"}. Choose a new pilot, or drop the milestone.` }
      : state === "lost" && !(gates.get(milestone.gate) && !gates.get(milestone.gate).answer && inNeeds(card({ id: gates.get(milestone.gate).task }))) ? { kind: "lost", title: lostWhy(milestone), text: title(LOST_FIX(milestone.id)) }
      : null;
    return { key: `${project.key}/${milestone.id}`, id: milestone.id, name: milestone.name, goal: milestone.goal, pilot: milestone.pilot, pilotState: pilotState ?? null, gate: milestone.gate, gateFound: milestone.gateFound, questions: questions.get(milestone.id) ?? [], ...(milestone.named !== undefined && { named: milestone.named }), ...(was.has(milestone.id) && { was: was.get(milestone.id) }), open: open.length,
      source: source.id, sourceLabel: project.old ? `Old ${title(project.old.provider)}` : source.label, project: project.key, group: group.key, projectName: group.name, archived: group.archived,
      state, ...wordOf(milestoneWordOf(milestone, graph, task => card(task)?.word)), progress, progressText: progressText(progress), tasks: ordered.map(task => `${project.key}/${task.id}`), depths: layered.map(([, depth]) => depth),
      next: first ? { key: first.key, id: first.id, word: first.word, pilot: first.id === milestone.pilot } : null,
      waiting: waiting.filter(item => !item.waitLine.never).length, cannotStart: waiting.filter(item => item.waitLine.never).map(item => item.id),
      need: need && { ...need, key: `${project.key}/${milestone.id}`, milestone: milestone.id, source: source.id, sourceLabel: source.label, projectName: group.name, group: group.key, archived: group.archived } };
  }).filter(milestone => !project.old || ["done", "dropped"].includes(milestone.state) && !milestone.open);
}

const wordOf = ({ word, reason }) => ({ word, reason });
const cannotRead = (project, name) => !project.tables[name] || project.diagnostics.some(message => message.startsWith(`${name}: `) || name === "milestones" && message.startsWith("programs: "));
const RELEASE_TABLES = ["releases", "milestones", "tasks"];
const releasesHidden = project => !project.old && RELEASE_TABLES.some(name => cannotRead(project, name))
  && (cannotRead(project, "releases") || project.tables.releases.length > 0 || [...project.tables.milestones ?? [], ...project.tables.tasks ?? []].some(row => row.release));
function releasesOfBook(project, group, graph, byKey) {
  if (project.old || RELEASE_TABLES.some(name => cannotRead(project, name))) return null;
  const releases = releasesOf(project.tables.releases ?? [], graph, task => byKey.get(`${project.key}/${task.id}`)?.word);
  if (!releases.length) return null;
  const key = id => `${project.key}/${id}`, ids = new Set(), names = new Map();
  const out = releases.map(release => {
    for (const task of release.singles) names.set(task.id, release.name);
    for (const milestone of release.milestones) ids.add(milestone.id);
    return { name: release.name, goal: release.goal ?? "", ...(release.missing && { missing: true }), word: release.state, done: release.done, stopped: release.stopped, total: release.total,
      milestones: release.milestones.map(milestone => key(milestone.id)), singles: release.singles.map(task => key(task.id)) };
  });
  const singles = [...graph.byId.values()].filter(task => !task.milestone);
  for (const task of singles) { const card = byKey.get(key(task.id)); if (card) card.release = names.get(task.id) ?? null; }
  return { key: project.key, group: group.key, projectName: group.name, archived: group.archived, releases: out,
    loose: { milestones: [...graph.milestones.keys()].filter(id => !ids.has(id)).map(key), singles: singles.filter(task => !names.has(task.id)).map(task => key(task.id)) } };
}

const inNeeds = card => !!card?.visible && !!card.column;
function missingMilestones(source, project, group, graph) {
  const items = [];
  for (const [id, own] of graph.byMilestone) {
    const live = own.filter(task => !ENDED.includes(task.state)).map(task => task.id);
    if (graph.milestones.has(id) || !live.length) continue;
    const one = live.length === 1, names = id === "?" ? `The milestone cell of ${and(live)} ${one ? "is" : "are"} not a milestone id` : `${and(live)} ${one ? "names" : "name"} ${id}`;
    items.push({ kind: "missing", title: id === "?" ? "A milestone cell is not a milestone id" : `The milestone ${id} is not in the logbook`,
      text: `${names}, so ${one ? "it cannot" : "they cannot"} go on. Ask the chief to repair the logbook, or to take ${one ? "the task" : "each task"} out of the milestone.`,
      key: `${project.key}/${id}`, source: source.id, sourceLabel: source.label, projectName: group.name, group: group.key, archived: group.archived });
  }
  return items;
}
function sourceNeeds(source) {
  const problems = source.diagnostics.filter(message => message !== "ENOENT" && !message.startsWith("config: "));
  return problems.length ? [{ kind: "source", title: `The ${title(source.label)} logbooks cannot be read`, text: `${problems.map(message => title(plainProblem(message))).join(". ")}. The board shows no ${title(source.label)} logbook. Check that the board can read the folder.`,
    key: `${source.id}/source`, source: source.id, sourceLabel: source.label, projectName: "every project", group: null, archived: false }] : [];
}

const TABLE_NAMES = ["tasks", "runs", "findings", "ledger", "gates", "decisions", "milestones"];
const TABLE_FILE = new RegExp(`^(${[...TABLE_NAMES, "releases", "programs"].join("|")}): (.*)$`);
const unreadable = project => project.diagnostics.filter(message => !/^(milestones|programs|releases|observations|checkout|bindings|chiefs|sources|artifact [^:]*): /.test(message));
function reasonOf(message) {
  const [, name, rest] = TABLE_FILE.exec(message) ?? [];
  if (!name) return title(plainProblem(message));
  return /^E[A-Z]+$/.test(rest) ? `${name}.tsv ${PLAIN[rest] ?? "cannot be read"}` : /^line \d/.test(rest) ? `${name}.tsv ${rest}` : `${name}.tsv: ${rest}`;
}
function logbookNeeds(source, project, group) {
  const item = (kind, needTitle, text, hidesReleases = false) => ({ kind, title: needTitle, text, key: `${project.key}/${kind}`, source: source.id, sourceLabel: source.label, projectName: group.name, group: group.key, archived: group.archived, ...(hidesReleases && { hidesReleases }) });
  const milestones = project.diagnostics.filter(message => /^(milestones|programs): /.test(message)), lost = unreadable(project);
  const releases = project.old ? null : project.diagnostics.find(message => message.startsWith("releases: "));
  const others = group.books.filter(book => book.project !== project && !cannotRead(book.project, "tasks")).map(book => title(book.source.label));
  const tables = lost.map(message => TABLE_FILE.exec(message)?.[1]).filter(Boolean);
  const noTasks = cannotRead(project, "tasks"), why = [...lost, ...(noTasks ? milestones : [])], hides = releasesHidden(project);
  const shows = noTasks ? others.length ? `The board shows only the ${others.join(" and ")} logbook of ${group.name}.` : `The board shows no task of ${group.name}.`
    : `The board shows its tasks without the rows of ${tables.map(name => `${name}.tsv`).join(", ")}.`;
  const codes = new Set(why.map(message => TABLE_FILE.exec(message)?.[2]));
  const folder = TABLE_NAMES.every(name => why.some(message => message.startsWith(`${name}: `))) && codes.size === 1 && /^E[A-Z]+$/.test([...codes][0]) ? `Its folder ${PLAIN[[...codes][0]] ?? "cannot be read"}` : null;
  const moves = project.old ? [] : (project.tables.gates ?? []).filter(gate => !gate.answer && !gate.task && /^move · plan [0-9a-f]{8}$/.test(String(gate.question ?? "").split(LINE)[0]));
  return [
    ...moves.map(gate => ({ ...item("move", `The move gate ${gate.id} waits for your answer`, `${String(gate.question).split(LINE)[1] ?? "Move the project into one shared logbook?"} Answer the gate in the chat: the chief puts it to you word for word, with its options and its recommendation.`), key: `${project.key}/${gate.id}` })),
    ...(milestones.length && !noTasks ? [item("milestones", "The milestones table cannot be read", `${milestones.map(reasonOf).join(". ")}. The board shows the tasks without their milestones. Ask the chief to repair the logbook.`, hides)] : []),
    ...(releases && !noTasks ? [item("releases", "The releases table cannot be read", `${reasonOf(releases)}. The board shows the tasks without their releases. Ask the chief to repair the logbook.`, hides)] : []),
    ...(lost.length ? [item("logbook", `The ${title(source.label)} logbook cannot be read`, `${folder ?? why.map(reasonOf).join(". ")}. ${shows} Ask the chief to repair the logbook.`, hides && why.some(message => /^(tasks|programs|milestones): /.test(message)))] : []),
  ];
}
const withoutMilestones = project => !cannotRead(project, "milestones") || !project.tables.tasks ? project : { ...project, tables: { ...project.tables, milestones: undefined, tasks: project.tables.tasks.map(task => ({ ...task, milestone: "" })) } };

function changingOf(sources, groupOf) {
  const seen = new Map();
  for (const source of sources) for (const project of source.projects) if (project.changing) {
    const name = groupOf.get(project.key)?.name ?? project.name, item = seen.get(name) ?? { project: name, at: project.changing.at };
    const dropped = [...(item.dropped ?? []), ...(project.changing.dropped ?? [])];
    seen.set(name, { ...item, ...(dropped.length && { dropped }) });
  }
  return [...seen.values()];
}

export function buildBoardModel(input,{ now = new Date().toISOString(), landing = null } = {}) {
  const at = time(now);
  if (at === null) throw new TypeError("board time must be an ISO date");
  build++;
  const sources = input.map(source => ({ ...source, projects: source.projects.map(withoutMilestones) }));
  const { groups, notes: joined } = projectGroups(sources);
  const groupOf = new Map(groups.flatMap(group => group.books.map(book => [book.project.key, group])));
  const notes = [...joined, ...sources.flatMap(source => [...(source.notes ?? NONE).map(message => ({ source: source.id, project: title(source.label), message })),
    ...source.projects.flatMap(project => (project.notes ?? NONE).map(message => ({ source: source.id, project: groupOf.get(project.key)?.name ?? project.name, message })))])];
  const graphs = new Map(sources.flatMap(source => source.projects.map(project => [project.key, graphOf(project)])));
  const tasks = sources.flatMap(source => source.projects.flatMap(project => (project.tables.tasks ?? []).filter(task => /^T[1-9]\d*$/.test(task.id)).map(task => card(source, project, groupOf.get(project.key), task, at, graphs.get(project.key), landing))));
  const byKey = new Map(tasks.map(task => [task.key, task]));
  namedWaits(tasks, byKey);
  markConflicts(tasks);
  const milestones = sources.flatMap(source => source.projects.flatMap(project => milestonesOf(source, project, groupOf.get(project.key), graphs.get(project.key), byKey)));
  const releases = sources.flatMap(source => source.projects.map(project => releasesOfBook(project, groupOf.get(project.key), graphs.get(project.key), byKey)).filter(Boolean));
  const milestoneNeeds = [...milestones.filter(milestone => milestone.need).map(milestone => milestone.need),
    ...sources.flatMap(source => source.projects.flatMap(project => missingMilestones(source, project, groupOf.get(project.key), graphs.get(project.key)))),
    ...sources.flatMap(source => [...sourceNeeds(source), ...source.projects.flatMap(project => logbookNeeds(source, project, groupOf.get(project.key)))])], liveNeeds = milestoneNeeds.filter(need => !need.archived);
  const recent = task => task.lastActivity ? Date.parse(task.lastActivity) : 0;
  const newest = (a, b) => (b.reasons.length > 0) - (a.reasons.length > 0) || recent(b) - recent(a);
  const shown = tasks.filter(task => task.visible && task.column).sort((a, b) => (b.reasons.length > 0) - (a.reasons.length > 0) || rank(a) - rank(b) || recent(b) - recent(a));
  const visible = shown.filter(task => !task.archived);
  const columnOf = (key, list) => { const cards = list.filter(task => task.column === key); return key === "done" ? cards.sort(newest) : cards; };
  const LISTS = ["needs", "active", "idle", "archived"];
  const projects = groups.map(group => {
    const own = tasks.filter(task => task.group === group.key), live = shown.filter(task => task.group === group.key);
    const last = Math.max(0, ...own.map(recent)), extra = milestoneNeeds.filter(need => need.group === group.key).length, needsOwner = live.filter(task => task.reasons.length).length + extra;
    const chiefs = group.books.filter(book => book.project.shared && !book.project.old).flatMap(({ project }) => boardChiefs({ rows: project.chiefs ?? NONE, live: project.chiefLive, names: project.chiefNames, runs: own.filter(task => task.project === project.key).flatMap(task => task.runs), now: at }).map(chief => ({ key: `${project.key}/${chief.id}`, ...chief })));
    return { key: group.key, name: group.name, sub: group.sub, pathSub: group.pathSub ?? null, terms: group.terms, paths: group.paths, books: group.books.map(book => book.project.key), providers: group.providers, chiefs, archived: group.archived, problem: group.problem, tasks: own.length, needsOwner, agents: live.reduce((n, task) => n + task.agents.filter(agent => !agent.stale).length, 0), lastActivity: last ? new Date(last).toISOString() : null,
      list: group.archived ? "archived" : needsOwner ? "needs" : last && at - last <= ACTIVE_DAYS * 86400000 ? "active" : "idle" };
  }).sort((a, b) => LISTS.indexOf(a.list) - LISTS.indexOf(b.list) || (a.list === "needs" ? b.needsOwner - a.needsOwner : 0) || (Date.parse(b.lastActivity ?? 0) || 0) - (Date.parse(a.lastActivity ?? 0) || 0) || a.name.localeCompare(b.name));
  const archived = projects.filter(project => project.archived).map(project => ({ key: project.key, name: project.name, tasks: project.tasks, needsOwner: project.needsOwner }));
  const agents = agentsOf(sources, groups, groupOf, byKey, at);
  const moved = sources.flatMap(source => source.projects.filter(project => project.movedAt && at - Date.parse(project.movedAt) >= 0 && at - Date.parse(project.movedAt) <= 7 * 86400000 && !groupOf.get(project.key)?.archived)
    .map(project => ({ project: groupOf.get(project.key)?.name ?? project.name, folder: project.name, at: project.movedAt, tasks: tasks.filter(task => task.project === project.key && task.was && task.column !== "done").length, finished: tasks.filter(task => task.project === project.key && task.was && task.column === "done").length })));
  return { at: new Date(at).toISOString(), tasks, milestones, releases, milestoneNeeds: liveNeeds, projects, notes, agents, moved, columns: COLUMNS.map(([key, name]) => ({ key, name, tasks: columnOf(key, visible), archivedTasks: columnOf(key, shown.filter(task => task.archived)) })), needsOwner: visible.filter(task => task.reasons.length), archived, counts: { tasks: visible.length, needsOwner: visible.filter(task => task.reasons.length).length + liveNeeds.length, recordedAgents: visible.reduce((n, task) => n + task.agents.filter(agent => !agent.stale).length, 0), inferredWork: visible.filter(task => task.inferredWork).length, inReview: visible.filter(task => task.column === "review").length }, sources: sources.map(source => ({ id: source.id, label: source.label, standIn: standIn(source), diagnostics: source.diagnostics, ...(source.shared && { shared: true }) })), changing: changingOf(sources, groupOf), diagnostics: sources.flatMap(source => [...source.diagnostics.map(message => ({ source: source.id, message: plainProblem(message) })), ...source.projects.flatMap(project => project.diagnostics.map(message => ({ source: source.id, project: project.key, message: plainProblem(message) })))]), warnings: sources.flatMap(source => source.projects.flatMap(project => (project.warnings ?? []).map(message => ({ source: source.id, project: project.key, message: plainProblem(message) })))) };
}
