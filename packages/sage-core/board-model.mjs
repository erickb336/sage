import { createHash } from "node:crypto";
import { basename } from "node:path";
import { githubRepository } from "./board-reader.mjs";
import { LINE, PRIORITIES, TASK_KINDS, agentCaps, proposalOf } from "./logbook-fields.mjs";
import { ENDED, MET, breakdownGate, dead, gateLines, lostWhy, namedText, progressOf, progressText, shownGraph, shownWaits, waitGraph, waitsOf } from "./program-rules.mjs";
// One semantic model for HTML, chat and the read-only server.
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
/**
 * fn of a list, computed once for each list (a table or the observations) in one build: so each card reads only its own
 * rows, and the model stays linear in the rows (T383). Each build starts new caches, so no build reads an older index.
 */
let build = 0;
const once = fn => { let cache, at = -1; return list => { if (at !== build) [cache, at] = [new WeakMap(), build]; if (!cache.has(list)) cache.set(list, fn(list)); return cache.get(list); }; };
const byTask = once(list => { const index = new Map(); for (const row of list) (index.get(row.task) ?? index.set(row.task, []).get(row.task)).push(row); return index; });
const NONE = [];
const rows = (project, name, task) => byTask(project.tables[name] ?? NONE).get(task.id) ?? NONE;
/** The newest run record of each run, by its id. */
const runRecords = once(records => new Map(records.filter(record => record.kind === "run").map(record => [record.data.run, record])));
/** N8: the move decisions of a logbook, by the task they leave and by the task they go to. */
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
// N1: the name that stands in for a run's provider when the run does not record it: the source's provider, else its label.
const standIn = source => source.provider ?? source.label ?? source.id;
// N9: a project's name: the owner's display name, else the repository name of its upstream remote, then of its origin,
// then its main checkout's folder, then its logbook folder without the hash.
export const projectName = project => project.displayName ?? [project.upstream, project.repository].map(url => githubRepository(url)?.split("/").at(-1)).find(Boolean)
  ?? (project.checkout ? basename(project.checkout) : project.name.replace(/-[0-9a-f]{6}$/, ""));
// A priority's rank: P0 first, no priority last.
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
// T305 loop design 1: the step line. Each step and each part has one of these statuses; the renderer gives each a mark and a word.
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
/**
 * A running run's age: minutes, or hours and minutes, up to 24 h; then the day it started. After 24 h with no change in
 * the task's logbook rows, the run may have stopped, and the text says so (T305, bug bash R1023).
 */
export function runClock(started, now, lastActivity) {
  const start = time(started);
  if (start === null) return { text: "start time unknown", stale: false };
  const minutes = Math.max(0, Math.floor((now - start) / 60000));
  if (minutes < 60) return { text: `${minutes} min`, stale: false };
  if (minutes < 24 * 60) return { text: `${Math.floor(minutes / 60)} h ${minutes % 60} min`, stale: false };
  const last = Math.max(start, time(lastActivity) ?? start);
  return now - last >= STALE_MS ? { text: `no news since ${dayMonth(last)}. The run may have stopped, so ask the chief to check it`, stale: true, since: dayMonth(last) } : { text: `since ${dayMonth(start)}`, stale: false };
}

/**
 * Who acts in each state, and on which step (R1077: one table, not a rule per state by hand). The step is the current
 * step of the line; "started" says whether it began. Who acts: an agent (the step runs, may have stopped, or waits for
 * an agent, by the task's running runs), the chief (no agent), the owner (the step needs you) or nobody (the task is done).
 * An open gate makes the current step need you in every state but a final one. A reviewing task whose cycles are all
 * clean moves to the merge step, where the chief acts. A failed review marks its cycle failed, and the step stays the review.
 */
const PHASE = {
  framed: ["plan", "agent", false], designing: ["plan", "agent", true], "awaiting-you": ["plan", "owner", true],
  briefed: ["build", "agent", false], building: ["build", "agent", true], held: ["build", "chief", true], replan: ["build", "chief", true],
  reviewing: ["review", "agent", true], repairing: ["repair", "agent", true], verifying: ["merge", "chief", false],
  verified: ["merge", "owner", false], "pr-ready": ["merge", "owner", false], merged: [null, "done"], concluded: [null, "done"], abandoned: [null, "done"],
};

/**
 * Where a task is in its route, as design 1 of the T305 notes: only the route's steps (Plan, then Build, the review cycles
 * and Merge; or Investigate, Evidence review and Conclude), the current step marked, a repair as its own step, a "Now" or
 * "Needs you" line, and a "Next" line. Every text comes from the state's row of PHASE and the facts: the gates, the runs
 * (running, or stale after 24 h with no news), the cycles and the known head. "judged" says whether the cycles know their
 * verdicts: a build route needs the PR's head; a route without build has no commit, so its verdicts have no SHA (R1081-1).
 */
function stepLine({ task, route, cycles, required, head, judged, reasons, merge, gates, runs, ledger, rounds, autopilot }) {
  const state = PHASE[task.state] ? task.state : "abandoned", build = route.includes("build"), sha = head ? head.slice(0, 7) : null;
  const gate = gates.find(row => !row.answer), answered = !gate && gates.length && gates.at(-1).answer ? gates.at(-1) : null;
  const running = runs.filter(run => run.status === "running"), live = running.filter(run => !run.clock.stale), stale = running.filter(run => run.clock.stale);
  const round = Number(task.round) || 1;
  // The current review cycle: the first that is not clean. A failed role fails it. Unjudged cycles (no known head) are not known.
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

  // Each step's name, as the Now and Next lines say it.
  const reviewName = i => build ? `review cycle ${i} of ${required}` : required > 1 ? `evidence review ${i} of ${required}` : "the evidence review";
  const NAME = { plan: task.state === "designing" ? "the design" : "the plan", build: build ? "the build" : "the investigation", review: reviewName(at + 1), repair: `repair round ${round} of ${rounds}`, merge: build ? "the merge" : "the conclusion" };
  const actor = list => and([...new Set(list.map(run => `the ${AGENT_WORD[run.role] ?? run.role}`))]);
  const ago = run => { const clock = run.clock.text; return /^\d/.test(clock) ? `${clock} ago` : clock.startsWith("since ") ? `on ${clock.slice(6)}` : "at a time that is not recorded"; };
  const runText = run => run.clock.stale ? `No news from the ${AGENT_WORD[run.role] ?? run.role} (run ${run.id}) since ${run.clock.since}. The run may have stopped, so ask the chief to check it.`
    : `The ${AGENT_WORD[run.role] ?? run.role} (${run.evidence?.data.provider ? `${run.evidence.data.provider}, ` : ""}run ${run.id}) is at work. It started ${ago(run)}.`;
  const heldAt = gate ? `Held at gate ${gate.id} (the question above).` : null;
  // The current step's status: it needs you, it failed, an agent runs it, its run may have stopped, or nobody runs it now.
  const status = who === "owner" ? "need" : failed.length ? "fail" : who === "agent" ? live.length ? "run" : stale.length ? "stale" : started ? "idle" : "wait" : who === "chief" ? "idle" : "done";
  const agentDetail = idle => live.length ? runText(live[0]) : stale.length ? runText(stale[0]) : idle;

  const steps = [];
  const order = s => ["plan", "build", "review", "repair", "merge"].indexOf(s);
  const place = key => step === null ? (state === "abandoned" && key !== "plan" ? "after" : "before") : order(key) < order(step) ? "before" : order(key) > order(step) ? "after" : "at";
  const mark = (key, done = "done") => ({ before: done, at: status, after: "wait" })[place(key)];

  // Plan: framed, design and PE check, briefed.
  const pe = running.find(run => run.role === "pe");
  const planDetail = place("plan") === "before" ? "Framed and briefed." : heldAt ?? (state === "framed" ? "In the backlog. No agent works on it."
    : state === "awaiting-you" ? answered ? `You answered gate ${answered.id}. The chief moves the design on.` : "The design waits for your answer."
    : agentDetail("No agent works on the design now."));
  const designPart = place("plan") === "before" ? "done" : state === "framed" ? "wait" : pe ? "done" : status;
  steps.push({ key: "plan", label: "Plan", status: mark("plan"), detail: planDetail,
    parts: [["framed", "done"], ...(route.includes("design") ? [["design", designPart]] : []),
      ...(route.includes("pe") ? [["PE check", pe ? pe.clock.stale ? "stale" : "run" : PLANNING.includes(state) ? "wait" : "done"]] : []),
      ["briefed", place("plan") === "before" ? "done" : "wait"]] });

  // Build or Investigate.
  const doneBuild = build ? task.pr ? `PR ${task.pr}${sha ? `, last commit ${sha}` : ""}.` : "Built." : "The report is written.";
  const buildDetail = { before: doneBuild, after: "" }[place("build")] ?? heldAt ?? (state === "held" ? task.hold === "round" ? `Held after ${plural(Number(task.round) || 0, "repair round")} that did not make it clean.` : "Held by the chief."
    : state === "replan" ? "It needs a new plan." : agentDetail(state === "briefed" ? "Briefed. No agent took the brief yet." : `No agent works on ${NAME.build} now.`));
  steps.push({ key: "build", label: build ? "Build" : "Investigate", status: mark("build"), detail: buildDetail });

  // The review cycles, or a failed review, the repair and Review again.
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
    // Past the reviews, only a cycle with a recorded clean verdict set ran: the line never claims a cycle that did not (T387).
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

  // Merge or Conclude.
  const mergeDetail = { before: build ? task.state === "concluded" ? "Closed with no merge." : "Merged." : "The report went to you.", after: build ? `After ${plural(required, "clean cycle")}${required > 1 ? " on one commit" : ""}.` : "The report goes to you." }[place("merge")]
    ?? heldAt ?? (!build ? "The chief concludes it." : task.state === "verifying" || allClean ? "The chief checks the verdicts first." : merge && !merge.ok ? merge.text
      : `${merge ? `${merge.text} ` : ""}${autopilot ? "Autopilot merges it."
      : reasons.some(reason => reason.kind === "merge" && reason.mode) ? "Autopilot is off, so the merge waits for you." : "The board cannot tell if autopilot is on, so the merge waits for you."}`);
  steps.push({ key: "merge", label: build ? "Merge" : "Conclude", status: mark("merge"), detail: mergeDetail });

  // Now: what needs you (the reasons, each once), else what happens on the current step.
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

  // Next: after an answer, the current step goes on; else the fixed rule of the state.
  const pending = reviewing && judged ? cycles[at].steps.find(item => item.status === "pending") : null;
  const after = at + 1 < required ? reviewName(at + 2) : NAME.merge;
  const NEXT = {
    framed: route.includes("design") ? "The design." : `${cap(NAME.build)}.`,
    designing: "You approve the design.",
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
  // A gate's answer lets the current step go on; awaiting-you and replan say what the chief does after it.
  const AFTER = { replan: "The chief briefs it again after your answer.", "awaiting-you": `${cap(NAME.build)} is briefed after your answer.` };
  const next = who === "done" ? null : gate ? AFTER[state] ?? `${cap(name)} ${started ? "goes on" : "starts"} after your answer.` : NEXT[state];
  return { steps, current: step, now: needs ? { needs: true, text: needs } : { needs: false, stale: status === "stale", text: nowText }, next };
}


// Programs (T233). A program's key is its logbook's key, a slash and its id, as a task's key is: PG1 of the Claude logbook
// and PG1 of the Codex logbook of one project are two programs. Waits resolve inside the task's own logbook, with the
// state tool's rules (program-rules.mjs), so the board and the status line never disagree.
const WAIT_WORD = { backlog: "not started", design: "in design", building: "building", review: "in review", ready: "ready to merge" };
/** A task state as a wait names it: "merged", "in review", or "not in the logbook" for a task that the logbook lost. */
const stateWord = state => state === undefined ? "not in the logbook" : ["merged", "concluded", "abandoned"].includes(state) ? state : WAIT_WORD[COLUMNS.find(([, , states]) => states.includes(state))?.[0]] ?? state;
/** The graph of one logbook's waits and programs: its tasks by id and each program with its state, as every printer shows it (shownGraph). */
const graphOf = project => shownGraph(waitGraph((project.tables.tasks ?? []).filter(task => /^T[1-9]\d*$/.test(task.id)), project.tables.programs ?? [], project.tables.gates ?? [], project.tables.decisions ?? []), project.tables.gates ?? []);
const LOST_FIX = id => `ask the chief to repair the logbook, or to propose ${id} again.`;
/**
 * Each wait of a task, with its state: a task (met when merged or concluded; never met when abandoned or lost), the pilot
 * of its program, the breakdown that the owner has not approved (never met when dropped or lost), or a waits cell with
 * text that is not a task id (never met, and its text is never shown). A breakdown whose pilot is abandoned or lost
 * makes its program stuck (programsOf), so a task waits for that pilot instead (shownWaits): it cannot start.
 */
const waitsFor = (task, graph) => shownWaits(task, graph).map(wait =>
  wait.odd ? { odd: true, met: false, never: true }
  : wait.program ? { breakdown: { id: wait.program.id, gate: wait.program.gate ?? null, pilot: wait.program.pilot, state: wait.program.state, gateFound: !!wait.program.gateFound, ...(wait.program.missing && { missing: true }), ...(wait.program.named !== undefined && { named: wait.program.named }) }, met: false, never: ["dropped", "lost"].includes(wait.program.state) }
  // A wait of a loop of waits (a hand edit) is never met, as no task of the loop can start first.
  : { id: wait.id, state: wait.state ?? null, word: `${stateWord(wait.state)}${wait.loop ? ", in a loop" : ""}`, pilot: !!wait.pilot, met: MET.includes(wait.state), never: dead(wait.state) || !!wait.loop, ...(wait.loop && { loop: true }) });
const BREAKDOWN_WAIT = {
  proposed: (id, gate) => `your approval of the ${id} breakdown (gate ${gate})`,
  changing: (id, gate) => `the new breakdown of ${id}: you asked for changes (gate ${gate})`,
  dropped: (id, gate) => `the ${id} breakdown, which you dropped (gate ${gate})`,
};
const waitName = wait => wait.breakdown ? BREAKDOWN_WAIT[wait.breakdown.state]?.(wait.breakdown.id, wait.breakdown.gate) ?? `the ${wait.breakdown.id} breakdown, ${wait.breakdown.missing ? "which is not in the logbook" : !wait.breakdown.gate ? "whose program names no breakdown gate" : wait.breakdown.named !== undefined ? `whose gate ${wait.breakdown.gate} ${namedText(wait.breakdown.named, wait.breakdown.id)}` : wait.breakdown.gateFound ? `whose gate ${wait.breakdown.gate} is not a breakdown gate` : `whose gate ${wait.breakdown.gate} is not in the logbook`}`
  : `${wait.id} (${wait.pilot ? "pilot, " : ""}${wait.word})`;
/**
 * The card's wait line, or null when nothing waits: each wait that is never met, first, so a task that cannot start
 * says so, as the program page and status do (R1509-1); then each other unmet wait, only the breakdown when it waits for one.
 * A task in design may run its design and PE meanwhile. The task page's Now and Next lines read this line.
 */
function waitLine(task, waits, column) {
  const unmet = ENDED.includes(task.state) ? [] : waits.filter(wait => !wait.met), breakdown = unmet.some(wait => wait.breakdown);
  const open = [...unmet.filter(wait => wait.never), ...unmet.filter(wait => !wait.never && (!breakdown || wait.breakdown))];
  if (!open.length) return null;
  // Odd text in the waits cell is never shown: a sentence says that the cell needs new waits, and the task cannot start.
  const never = open.some(wait => wait.never), named = open.filter(wait => !wait.odd), odd = named.length < open.length ? " Its waits cell has text that is not a task id: the chief sets its waits again." : "";
  const loop = open.some(wait => wait.loop) ? " Its waits make a loop, which never ends: the chief sets its waits again." : "";
  if (!named.length) return { never, text: `It cannot start.${odd}` };
  return { never, text: `Waits for ${and(named.map(waitName))}${never ? ": it cannot start." : "."}${odd}${loop}${!never && column === "design" ? " Design and PE may run." : ""}` };
}

function card(source, project, group, task, now, graph, landing) {
  const records = (byTask(project.observations?.records ?? NONE).get(task.id) ?? NONE).filter(record => time(record.observedAt) !== null && time(record.observedAt) <= now);
  const pr = latest(records, "pr", data => String(data.number) === task.pr);
  const completion = latest(records, "completion", data => data.state === task.state);
  const mode = latest(records, "mode");
  const ledger = rows(project, "ledger", task);
  // N7: the newest run, verdict or decision time. A running run with no news for 24 h may have stopped (its clock is stale).
  const times = [...rows(project, "runs", task).flatMap(run => [run.started, run.ended]), ...ledger.map(row => row.at), ...rows(project, "decisions", task).map(row => row.at)].map(time).filter(at => at !== null);
  const lastActivity = times.length ? new Date(Math.max(...times)).toISOString() : null;
  const runs = rows(project, "runs", task).map(run => ({ ...run, evidence: latest(records, "run", data => data.run === run.id), clock: runClock(run.started, now, lastActivity) }));
  const agents = runs.filter(run => run.status === "running").map(run => ({ id: run.id, role: run.role, provider: run.evidence?.data.provider ?? null, evidence: run.evidence, recordedStatus: run.status, stale: run.clock.stale }));
  // Needs you: an open gate, or a state that waits for the owner (R1077). Held and replan wait for the chief, not for you.
  const allGates = rows(project, "gates", task), gates = allGates.filter(gate => !gate.answer);
  // Only a breakdown gate keeps its lines (gateLines), and only by the data rule (breakdownGate: a programs row names it,
  // on its pilot, with the breakdown options): the renderers split no other question into lines (R1249-1, the owner's Q1).
  // An open gate that a lost program names (F-T233-2) says so on its own line of the question, so Needs you counts that problem once.
  const reasons = gates.map(gate => {
    const breakdown = breakdownGate(gate, graph.programs);
    const lost = (graph.byGate.get(gate.id) ?? []).filter(program => program.state === "lost").map(program => `${lostWhy(program)}: ${LOST_FIX(program.id)}`);
    return { kind: "gate", key: `${project.key}/${gate.id}`, text: [...gateLines(gate, graph.programs), ...lost].join(LINE), recommendation: gate.recommendation || null, gateId: gate.id, options: gate.options ? gate.options.split("|").map(option => option.trim()) : [],
      breakdown: breakdown ? { key: `${project.key}/${breakdown}`, id: breakdown, name: graph.programs.get(breakdown).name } : null };
  });
  if (task.state === "awaiting-you" && !gates.length && !allGates.at(-1)?.answer) reasons.push({ kind: "design", text: "The design waits for your answer." });
  // N2: an observed PR head wins. Else the ledger head: the newest commit of the task's PR by its first verdict (the ledger
  // is append-only), when that first verdict comes after every verdict by a run of an earlier round. At round 1 or later, a
  // verdict by a run of round 1 or earlier must show where the round starts. A repairing task pushes a new head, so it
  // has no ledger head, and no verdict makes it fail or need the owner.
  const round = Number(task.round || 0), repairing = task.state === "repairing";
  const verdicts = task.pr ? ledger.filter(row => String(row.pr) === task.pr && /^[0-9a-f]{40}$/.test(row.sha)) : [];
  const rounds = verdicts.map(row => { const run = runs.find(run => run.id === row.run); return run ? Number(run.round || 0) : null; });
  const first = verdicts.findLastIndex((row, i) => verdicts.findIndex(other => other.sha === row.sha) === i);
  const known = round === 0 || rounds.some(r => r !== null && r <= round);
  const reviewed = !repairing && known && first > rounds.findLastIndex(r => r !== null && r < round) ? verdicts[first].sha : null;
  const head = pr?.data.head ?? reviewed;
  const headBasis = pr?.data.head ? "observed" : head ? "ledger" : null;
  const route = task.route.split(",").filter(Boolean), build = route.includes("build");
  // A route without build has no commit: its verdicts are the task's rows, with no SHA (R1081-1).
  const judged = build ? !!head : true;
  // T280: a verified PR is ready to merge only when sage's own merge check (landing) passes on its known head. With no
  // head or no merge check, the board says that it did not check, and the task is not ready. The board does not see the
  // PR's head branch on GitHub, so that part of the rule stays unchecked also when the check passes.
  const verified = ["verified", "pr-ready"].includes(task.state) && build;
  const checked = verified && head && landing ? landing(source.id, head, task.pr) : null;
  const checkName = checked?.scope === "project" ? "The project check" : "The merge check";
  const merge = !verified ? null : !head ? { ok: false, text: `The merge check is not checked, because the board does not know ${task.pr ? `the last commit of PR ${task.pr}` : "the task's PR"}.` }
    : !checked ? { ok: false, text: `The merge check is not checked on ${head.slice(0, 7)}, because this board cannot run it.` }
    : checked.ok ? { ok: true, text: `${checkName} passes on ${head.slice(0, 7)}. ${checked.scope === "project" ? "The global merge check is not checked. " : ""}The board does not check the PR's head branch.` }
    : { ok: false, text: `${checkName} refuses ${head.slice(0, 7)}. ${cap(checked.reason.split(/\.(?:\s|$)/)[0])}.` };
  if (merge && !merge.ok) reasons.push({ kind: "merge-check", text: merge.text });
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
    // A running run of the step's role runs the cycle its evidence names; with no run evidence, the role's first cycle without a verdict.
    const open = Array.from({ length: count }, (_, j) => j + 1).find(number => !verdict(role, number));
    const running = runs.find(run => run.status === "running" && run.role === (RUN_ROLE[role] ?? role) && (run.evidence ? (run.evidence.data.head ?? null) === head && run.evidence.data.cycle === i + 1 : open === i + 1));
    return { role, status: !judged ? "unknown" : last ? last.kind === CLEAN[role] ? "done" : "failed" : running ? "running" : "pending", evidence: last, run: running?.id ?? null };
  }) }));
  for (const [index, row] of current.entries()) {
    if (!["checks-fail", "qa-fail"].includes(row.kind)) continue;
    // The ledger is append-only; order resolves equal second-precision timestamps.
    const newer = current.slice(index + 1).find(other => other.kind === (row.kind === "checks-fail" ? "checks-pass" : "qa-pass") && other.cycle === row.cycle);
    if (!newer) reasons.push({ kind: row.kind, text: `${row.kind === "checks-fail" ? "Checks" : "QA"} failed on the recorded PR head.`, evidence: row });
  }
  const inferred = pr?.data.state === "open" && task.branch.startsWith("codex/") && !agents.length;
  if (inferred && !["merged", "concluded", "abandoned"].includes(task.state)) reasons.push({ kind: "review-wait", text: "The PR has inferred provider work and waits for review." });
  // A verified PR that the merge check did not pass stays in review: the Ready to merge column holds only what may land.
  const column = merge && !merge.ok ? "review" : COLUMNS.find(([, , states]) => states.includes(task.state))?.[0] ?? null;
  const program = task.program ? graph.programs.get(task.program) : null, waits = waitsFor(task, graph);
  const completionDecision = rows(project, "decisions", task).filter(row => row.decision === `state ${task.state}`).at(-1);
  const completedAt = completion ? time(completion.data.at) : ["merged", "concluded", "abandoned"].includes(task.state) ? time(completionDecision?.at) : null;
  const brief = project.contents?.[latest(records, "artifact", data => data.type === "brief")?.id]?.text ?? null;
  // N8: a moved finding leaves its task; the move decision on the old task names the new task and key.
  const moves = movesOf(project.tables.decisions ?? NONE);
  const found = (to, key) => rows(project, "findings", { id: to }).find(row => row.key === key);
  const findings = [
    ...rows(project, "findings", task).map(row => ({ ...row, movedFrom: (moves.to.get(task.id) ?? NONE).find(({ move }) => move[3] === row.key)?.row.task ?? null })),
    ...(moves.from.get(task.id) ?? NONE).map(({ row, move }) => ({ severity: "", summary: row.decision.slice(row.decision.indexOf(":") + 1).trim(), ...found(move[2], move[3]), task: task.id, key: move[1], status: "moved", reason: "", movedTo: move[2] })),
  ];
  return { key: `${project.key}/${task.id}`, source: source.id, sourceLabel: source.label, providerStandIn: standIn(source), repository: githubRepository(pr?.data.repository) ?? githubRepository(project.repository), lastActivity, headBasis, project: project.key, group: group.key, projectName: group.name, archived: group.archived, program: task.program ? { key: `${project.key}/${task.program}`, id: task.program, name: program?.name ?? null, pilot: program?.pilot === task.id } : null, waits, waitLine: waitLine(task, waits, column), priority: PRIORITIES.includes(task.priority) ? task.priority : "", kind: TASK_KINDS.includes(task.kind) ? task.kind : "", ...Object.fromEntries(["id", "title", "size", "risk", "route", "state", "branch", "pr", "round", "keys", "hold"].map(field => [field, task[field] ?? ""])), column, prEvidence: pr, currentHead: head, modeEvidence: mode, completedAt, visible: column !== "done" || completedAt !== null && completedAt <= now && completedAt >= now - 7 * 86400000, agents, inferredWork: inferred, cycles, requiredCycles: required, reasons, runs, ledger, gates, findings, decisions: rows(project, "decisions", task).slice(-10), brief, briefFields: briefFields(brief), mergeCheck: merge, loop: stepLine({ task, route, cycles, required: count, head, judged, reasons, merge, gates: allGates, runs, ledger, rounds: positive(source.config?.max_rounds) ?? 3, autopilot: mode?.data.autopilot === true }), runClocks: Object.fromEntries(runs.filter(run => run.status === "running").map(run => [run.id, run.clock])), artifacts: records.filter(record => record.kind === "artifact").map(record => ({ ...record, content: project.contents?.[record.id] ?? null })), diagnostics: [...project.diagnostics] };
}

const title = value => String(value ?? "").charAt(0).toUpperCase() + String(value ?? "").slice(1);
const ACTIVE_DAYS = 14;
const repoPath = url => githubRepository(url)?.slice("https://github.com/".length) ?? null;
const unique = list => list.filter((item, i) => item && list.indexOf(item) === i);

/**
 * One repository is one project (T305 notes, section 3). The logbooks of all sources with the same key and the same
 * checkout.txt are one project. A logbook without checkout.txt joins them, with a note: the key holds a hash of the path.
 * Two checkouts of one key stay two projects, with a note: the board never merges on doubt. Two clones at two paths have
 * two keys, so they stay two projects. The display name: the first source that has one wins, with a note when another
 * differs. A project is archived only when all its logbooks are. A joined logbook without checkout.txt never gives the
 * name or the archive (R1070-1), unless no logbook of the project has checkout.txt.
 */
function projectGroups(sources) {
  const byName = new Map(), groups = [], notes = [];
  for (const source of sources) for (const project of source.projects) byName.set(project.name, [...(byName.get(project.name) ?? []), { source, project }]);
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
  for (const group of groups) {
    const known = group.books.filter(book => book.project.checkout), trusted = known.length ? known : group.books;
    const projects = trusted.map(book => book.project), first = field => projects.map(project => project[field]).find(Boolean) ?? null;
    const names = unique(projects.map(project => project.displayName));
    if (names.length > 1) note(trusted, `Two display names: the board shows "${names[0]}" (the first source), not ${names.slice(1).map(other => `"${other}"`).join(", ")}.`);
    const archived = trusted.filter(book => book.project.archived);
    if (archived.length && archived.length < trusted.length) note(trusted, `Archived in ${keys(archived)} only: the board does not archive the project.`);
    const merged = { name: projects[0].name, displayName: first("displayName"), upstream: first("upstream"), repository: first("repository"), checkout: first("checkout") };
    const full = repoPath(merged.upstream) ?? repoPath(merged.repository), folder = merged.checkout ? basename(merged.checkout) : null;
    const all = group.books.map(book => book.project), problem = all.flatMap(project => project.diagnostics)[0] ?? null;
    // The quiet second line names the next source of the name (notes, section 2): the repository as owner/repo, or first
    // that there is no GitHub remote, then the folder. Two projects that would show the same lines show the end of their paths.
    const remote = full ? `${full}${!merged.displayName && repoPath(merged.upstream) ? " (upstream)" : ""}` : null;
    const sub = merged.checkout || remote ? [remote ?? "no GitHub remote", folder && `folder ${folder}`] : [`logbook ${merged.name}`];
    Object.assign(group, {
      // A project that no logbook can name, because every logbook of it is unreadable, is named by its folder, with the
      // reason (the prototype's failure state). One unreadable logbook does not rename what the others name (F-T305-3), and
      // a programs table, an observation or an artifact that cannot be read does not make the logbook unreadable (R1307-1).
      name: all.every(project => unreadable(project).length) ? merged.name : projectName(merged),
      remote, path: merged.checkout ?? null,
      archived: archived.length > 0 && archived.length === trusted.length, problem: problem && plainProblem(problem),
      providers: unique(group.books.map(book => title(standIn(book.source)))),
      sub: unique(sub).join(" · "),
      // Search matches every name a person may know: the display names, the repositories, the folder and the logbook keys.
      // The checkout paths are apart: only the Mac's own page carries them (R1069-2).
      terms: unique([...names, repoPath(merged.upstream), ...all.map(project => repoPath(project.repository)), folder, merged.name, ...all.map(project => project.key)]),
      paths: unique(all.map(project => project.checkout)),
    });
  }
  // Two projects with the same name and the same second line, such as two clones in two folders of one name: each shows
  // "clone 1", "clone 2" first, by the order of the logbook keys. Only the Mac's own page shows, in pathSub, the end of
  // the checkout's path instead, as many folders as tell them apart, so that a cut line keeps the part that differs
  // (F-T305-11, R1076-4, R1079-1).
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

// A logbook that the board cannot read says why in plain words, not as an error code: in its picker row and in the
// banners (R1075-6).
const PLAIN = { EACCES: "has no read permission", EPERM: "has no read permission", ENOENT: "is missing", EISDIR: "is a folder, not a file", ELOOP: "is a link, which the board does not follow", EMFILE: "cannot open now, because too many files are open" };
function plainProblem(message) {
  const coded = /^([a-z][\w .-]*): (E[A-Z]+)$/.exec(message) ?? /^()(E[A-Z]+)$/.exec(message);
  if (!coded) return message;
  return `${coded[1] ? `its ${coded[1]} file` : "its folder"} ${PLAIN[coded[2]] ?? "cannot be read"}`;
}

// The Agents page (T308, owner's decisions of 2026-10-18). Every rule is on recorded times; the board never reads the
// process list. "May be stuck" after 30 min with no hook activity (half the hook's 60-min slot lease); "running long"
// after more than 2 times the median time of the same role's ended runs in the project, with at least 5 of them.
export const AGENT_QUIET_MS = 30 * 60_000;
const LONG_FACTOR = 2, LONG_BASIS = 5;
/** Providers whose hook writes no agent slots yet: their agents show from the logbook only (T308 decision 2). */
const NO_SLOT_NOTES = ["codex"];
/** The states of an agent, most in need of a look first; the renderer gives each a mark and a word. */
export const AGENT_STATES = ["stuck", "stop", "long", "wait", "work", "unk"];
const LOOK = ["stuck", "stop", "long"];
const sha256 = text => createHash("sha256").update(text).digest("hex");
const minutes = ms => Math.max(0, Math.floor(ms / 60_000));
const span = ms => { const m = minutes(ms); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}`; };
const article = word => /^[aeiou]/i.test(word) ? `an ${word}` : `a ${word}`;
const median = list => { const sorted = [...list].sort((a, b) => a - b), mid = sorted.length >> 1; return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2; };

/** One slot's marks: the hook writes each as an empty file named <prefix><value>; only a slot marked ok is taken. */
function slotOf(slot) {
  const mark = prefix => slot.marks.find(name => name.startsWith(prefix))?.slice(prefix.length);
  const hex = value => /^[0-9a-f]{64}$/.test(value ?? "") ? value : null;
  const helper = /^([0-9a-f]{64})\.(R[1-9]\d*)$/.exec(mark("helper-") ?? "");
  return { name: slot.name, at: slot.at, ok: slot.marks.includes("ok"), project: /^[a-z0-9][a-z0-9-]*$/.test(mark("project-") ?? "") ? mark("project-") : null,
    role: /^sage_[a-z-]+$/.test(mark("role-") ?? "") ? mark("role-").slice(5) : null, run: /^R[1-9]\d*$/.test(mark("run-") ?? "") ? mark("run-") : null,
    bound: hex(mark("bound-")), parent: hex(mark("parent-")), logbook: hex(mark("logbook-")), lead: helper?.[1] ?? null };
}

/**
 * The agents that run now, in every project, from the logbooks and the hook's notes (T308 layout A). A slot joins its run
 * by its run mark, in a logbook of the slot's project. A running run that no slot holds shows from the logbook only: a
 * provider without slot notes (Codex) as "running"; a helper whose stop the hook noted as "stopped"; any other as "may be
 * stuck", as the hook frees a slot after 60 min with no event. A helper sits under its lead: by the slot's parent mark,
 * or by its helper note's lead key. at is the board's time in ms; cards gives each task's card by its key.
 */
function agentsOf(sources, groups, groupOf, cards, at) {
  const rows = [], problems = [], caps = [];
  const bare = name => name.replace(/-[0-9a-f]{6}$/, "");
  const groupNamed = name => groups.find(group => group.books.some(book => bare(book.project.name) === name));
  for (const source of sources) {
    const hooks = source.hooks ?? { present: false, slots: [], helpers: [], problem: null };
    const provider = String(source.provider ?? standIn(source)).toLowerCase();
    if (hooks.problem) problems.push({ source: source.id, message: plainProblem(hooks.problem) });
    const slots = hooks.slots.map(slotOf);
    const known = hooks.present && !hooks.problem;
    if (known) {
      const config = agentCaps(source.config);
      const used = name => slots.filter(slot => slot.project === name).length;
      caps.push({ source: source.id, label: title(provider), total: { used: slots.length, cap: config.total }, of: name => ({ used: used(name), cap: config.cap(name) }) });
    }
    const runs = source.projects.flatMap(book => (book.tables.runs ?? []).filter(run => run.status === "running" && /^R[1-9]\d*$/.test(run.id)).map(run => ({ book, run })));
    const leadKey = item => sha256(`${item.book.logbook}:${item.run.id}`);
    const taken = new Set();
    const row = (item, extra) => {
      const record = item && runRecords(item.book.observations?.records ?? NONE).get(item.run.id);
      const group = item ? groupOf.get(item.book.key) : groupNamed(extra.slot?.project);
      const card = item ? cards.get(`${item.book.key}/${item.run.task}`) : null;
      rows.push({ key: `${source.id}/${item ? `${item.book.name}/${item.run.id}` : extra.slot.name}`, source: source.id, runId: item?.run.id ?? extra.slot?.run ?? null, run: item?.run ?? null,
        group: group?.key ?? `slot:${extra.slot?.project ?? "other"}`, groupName: group?.name ?? extra.slot?.project ?? "other",
        provider: String(record?.data.provider ?? source.provider ?? standIn(source)), role: item?.run.role ?? extra.slot?.role ?? "agent", model: item?.run.model || null,
        task: card ? { key: card.key, id: card.id, title: card.title, kind: card.kind, priority: card.priority } : item ? { key: null, id: item.run.task, title: "", kind: "", priority: "" } : null,
        lead: null, children: [], ...extra });
    };
    // 1. Each taken slot, joined to its running run by the run mark, in a logbook of the slot's project.
    for (const slot of slots.filter(slot => slot.ok)) {
      const match = slot.run ? runs.filter(item => item.run.id === slot.run && bare(item.book.name) === slot.project && (!slot.logbook || item.book.logbook === slot.logbook)) : [];
      const item = match.length === 1 ? match[0] : null;
      if (item) taken.add(item);
      row(item, { slot, activity: slot.at, leadKey: item && slot.role === "lead" ? leadKey(item) : null, helperOf: slot.lead });
    }
    // 2. Each running run that no slot holds.
    const notes = hooks.helpers ?? [];
    for (const item of runs.filter(item => !taken.has(item))) {
      const note = notes.filter(note => note.run === item.run.id && runs.some(lead => lead.book === item.book && lead.run.role === "lead" && leadKey(lead) === note.lead));
      const stopped = note.find(note => note.stopped);
      const prov = String(runRecords(item.book.observations?.records ?? NONE).get(item.run.id)?.data.provider ?? source.provider ?? standIn(source)).toLowerCase();
      const how = NO_SLOT_NOTES.includes(prov) ? "logbook" : !known ? "unknown" : stopped ? "stopped" : "noslot";
      row(item, { slot: null, activity: null, how, stoppedAt: stopped?.at ?? null, leadKey: item.run.role === "lead" ? leadKey(item) : null, helperOf: note[0]?.lead ?? null });
    }
  }
  // The tree: a helper under its lead, by the slot's parent mark (the lead slot's bound mark) or by its lead key.
  for (const child of rows) {
    const lead = rows.find(other => other !== child && other.source === child.source && (child.slot?.parent && other.slot?.bound === child.slot.parent || child.helperOf && other.leadKey === child.helperOf));
    if (lead) { child.lead = lead.runId ?? lead.key; lead.children.push(child); }
  }
  // The usual time of each role in each project: the ended runs of its logbooks.
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
    // Running long is apart from stuck: a busy agent can take much longer than usual.
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
    // The cap of the hook that knows this project's agents: a provider with no slot notes has none (T308 decision 5).
    const hooked = caps.find(entry => list.some(agent => agent.source === entry.source && agent.how !== "logbook"));
    const cap = hooked ? { label: hooked.label, ...hooked.of(group ? bare(group.books[0].project.name) : key.slice(5)) } : null;
    return { key, name, sub: group?.sub ?? "", pathSub: group?.pathSub ?? null, agents: sort(list.filter(agent => !agent.lead)), count: list.length, look: list.filter(agent => LOOK.includes(agent.state)).length, worst: Math.min(...list.map(order)), cap };
  }).sort((a, b) => a.worst - b.worst || b.count - a.count || a.name.localeCompare(b.name));
  const providers = [...new Set(rows.map(agent => title(agent.provider.toLowerCase())))].map(name => ({ name, count: rows.filter(agent => title(agent.provider.toLowerCase()) === name).length }));
  return { count: rows.length, look: rows.filter(agent => LOOK.includes(agent.state)).length, providers, projects,
    caps: caps.map(entry => ({ label: entry.label, total: entry.total, projects: projects.filter(project => project.cap?.label === entry.label).map(project => ({ name: project.name, used: project.cap.used, cap: project.cap.cap })) })),
    problems, unmatched: rows.filter(agent => agent.how === "noslot").map(agent => ({ run: agent.runId, project: agent.groupName })), next: Number.isFinite(next) ? next : null,
    rules: { quiet: AGENT_QUIET_MS / 60_000, factor: LONG_FACTOR, basis: LONG_BASIS } };
}

/**
 * The tasks of a program in their order, each with its depth (the program page's layers): the pilot first, then each task after the tasks of the program that it waits
 * for, then by id. A hand edit can make a loop of waits that the state tool would refuse: a wait on a task whose depth
 * is still open counts as 0, so a loop ends there (C5). The walk keeps its own stack, so a long chain of waits cannot
 * overflow the call stack (F-T233-5).
 */
function programOrder(program, own) {
  const byId = new Map(own.map(task => [task.id, task])), depth = new Map(), open = new Set();
  const pilot = byId.has(program.pilot);
  const upsOf = task => task.id === program.pilot ? [] : waitsOf(task).ids.filter(id => byId.has(id));
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
      const values = [...ups.map(id => depth.get(id) ?? 0), ...(pilot && task.id !== program.pilot ? [0] : [])];
      depth.set(task.id, values.length ? 1 + Math.max(...values) : 0);
      open.delete(task.id);
      stack.pop();
    }
  }
  const number = id => Number(id.slice(1));
  return own.map(task => [task, depth.get(task.id)]).sort((a, b) => a[1] - b[1] || number(a[0].id) - number(b[0].id));
}

/**
 * The programs of one logbook (T233): each with its state (the state tool's, plus done, and stuck when the pilot of an
 * active, proposed or changing program is abandoned or lost: no card shows its breakdown gate then), its progress (Q3),
 * its tasks in order, what moves next (Q4: only a task with no unmet wait; the tasks that wait are a count), the tasks
 * that cannot start, and what needs the owner that no card shows (a stuck program; a breakdown gate that the logbook
 * lost, QA). A changing program needs no one until its new gate (QB).
 */
function programsOf(source, project, group, graph, cards) {
  const gates = new Map((project.tables.gates ?? []).map(gate => [gate.id, gate]));
  // The questions of each program's breakdown gates, by program id, read once: the page cuts them off the answer rows (F-T384-1).
  const questions = new Map();
  for (const gate of gates.values()) { const id = proposalOf(gate); if (id) questions.set(id, [...questions.get(id) ?? [], gate.question]); }
  return [...graph.programs.values()].map(program => {
    const own = graph.byProgram.get(program.id) ?? [], progress = progressOf(own), pilotState = graph.byId.get(program.pilot)?.state;
    const state = program.state === "active" ? progress.done ? "done" : dead(pilotState) ? "stuck" : "active"
      : ["proposed", "changing"].includes(program.state) && dead(pilotState) ? "stuck" : program.state;
    const layered = programOrder(program, own), ordered = layered.map(([task]) => task), card = task => cards.get(`${project.key}/${task.id}`);
    const open = ordered.filter(task => !ENDED.includes(task.state)).map(card).filter(Boolean);
    const moving = open.filter(item => item.waits.every(wait => wait.met)), waiting = open.filter(item => item.waitLine);
    const first = state === "active" ? moving[0] : null;
    const need = state === "stuck" ? { kind: "stuck", title: `${program.id} ${program.name} is stuck`, text: `The pilot ${program.pilot} ${pilotState ? "was abandoned" : "is not in the logbook"}. Choose a new pilot, or drop the program.` }
      // A lost program whose gate is open on a card in Needs you says so on that gate (card), so the problem counts once.
      : state === "lost" && !(gates.get(program.gate) && !gates.get(program.gate).answer && inNeeds(card({ id: gates.get(program.gate).task }))) ? { kind: "lost", title: lostWhy(program), text: title(LOST_FIX(program.id)) }
      : null;
    return { key: `${project.key}/${program.id}`, id: program.id, name: program.name, goal: program.goal, pilot: program.pilot, pilotState: pilotState ?? null, gate: program.gate, gateFound: program.gateFound, questions: questions.get(program.id) ?? [], ...(program.named !== undefined && { named: program.named }), open: open.length,
      source: source.id, sourceLabel: source.label, project: project.key, group: group.key, projectName: group.name, archived: group.archived,
      state, progress, progressText: progressText(progress), tasks: ordered.map(task => `${project.key}/${task.id}`), depths: layered.map(([, depth]) => depth),
      next: first ? { key: first.key, id: first.id, word: stateWord(first.state), pilot: first.id === program.pilot } : null,
      waiting: waiting.filter(item => !item.waitLine.never).length, cannotStart: waiting.filter(item => item.waitLine.never).map(item => item.id),
      need: need && { ...need, key: `${project.key}/${program.id}`, program: program.id, source: source.id, sourceLabel: source.label, projectName: group.name, group: group.key, archived: group.archived } };
  });
}

/** A card in Needs you when it has a reason: one on a column (not ended, or done in the last 7 days), as needsOwner reads it. */
const inNeeds = card => !!card?.visible && !!card.column;
/**
 * The programs that live tasks name but the logbook does not have (a lost programs row, or a program cell that is not a
 * program id, "?"): one item each, as the tasks cannot go on and no program line shows it.
 */
function missingPrograms(source, project, group, graph) {
  const items = [];
  for (const [id, own] of graph.byProgram) {
    const live = own.filter(task => !ENDED.includes(task.state)).map(task => task.id);
    if (graph.programs.has(id) || !live.length) continue;
    const one = live.length === 1, names = id === "?" ? `The program cell of ${and(live)} ${one ? "is" : "are"} not a program id` : `${and(live)} ${one ? "names" : "name"} ${id}`;
    items.push({ kind: "missing", title: id === "?" ? "A program cell is not a program id" : `The program ${id} is not in the logbook`,
      // "Cannot go on": also right for a task that is building already (R1391-4).
      text: `${names}, so ${one ? "it cannot" : "they cannot"} go on. Ask the chief to repair the logbook, or to take ${one ? "the task" : "each task"} out of the program.`,
      key: `${project.key}/${id}`, source: source.id, sourceLabel: source.label, projectName: group.name, group: group.key, archived: group.archived });
  }
  return items;
}
/**
 * A provider's root that the board cannot read (not a missing root: that is not set up yet) is one item, as it hides
 * every logbook of that provider. A config file that cannot be read is a line under the board only.
 */
function sourceNeeds(source) {
  const problems = source.diagnostics.filter(message => message !== "ENOENT" && !message.startsWith("config: "));
  return problems.length ? [{ kind: "source", title: `The ${title(source.label)} logbooks cannot be read`, text: `${problems.map(message => title(plainProblem(message))).join(". ")}. The board shows no ${title(source.label)} logbook. Check that the board can read the folder.`,
    key: `${source.id}/source`, source: source.id, sourceLabel: source.label, projectName: "every project", group: null, archived: false }] : [];
}

// A logbook problem that needs the owner (R1307-1, R1307-2): a programs table that the board cannot read, and a logbook
// that it cannot read (its folder, or a table but programs). An observation, an artifact or a checkout file that cannot be
// read is a line under the board only: every task shows. Each reason says the file and the line, as the reader gives them.
const TABLE_NAMES = ["tasks", "runs", "findings", "ledger", "gates", "decisions", "programs"];
const TABLE_FILE = new RegExp(`^(${TABLE_NAMES.join("|")}): (.*)$`);
const unreadable = project => project.diagnostics.filter(message => !/^(programs|observations|checkout|artifact [^:]*): /.test(message));
function reasonOf(message) {
  const [, name, rest] = TABLE_FILE.exec(message) ?? [];
  if (!name) return title(plainProblem(message));
  return /^E[A-Z]+$/.test(rest) ? `${name}.tsv ${PLAIN[rest] ?? "cannot be read"}` : /^line \d/.test(rest) ? `${name}.tsv ${rest}` : `${name}.tsv: ${rest}`;
}
function logbookNeeds(source, project, group) {
  const item = (kind, needTitle, text) => ({ kind, title: needTitle, text, key: `${project.key}/${kind}`, source: source.id, sourceLabel: source.label, projectName: group.name, group: group.key, archived: group.archived });
  const programs = project.diagnostics.find(message => message.startsWith("programs: ")), lost = unreadable(project);
  const others = group.books.filter(book => book.project !== project && book.project.tables.tasks).map(book => title(book.source.label));
  const tables = lost.map(message => TABLE_FILE.exec(message)?.[1]).filter(Boolean);
  // With no tasks, the board shows no program either: one item says why, with the programs table's reason too (T383).
  const noTasks = project.tables.tasks === undefined, why = [...lost, ...(noTasks && programs ? [programs] : [])];
  const shows = noTasks ? others.length ? `The board shows only the ${others.join(" and ")} logbook of ${group.name}.` : `The board shows no task of ${group.name}.`
    : `The board shows its tasks without the rows of ${tables.map(name => `${name}.tsv`).join(", ")}.`;
  // Every table with one error code (a folder with no read permission): the folder is the reason, once.
  const codes = new Set(why.map(message => TABLE_FILE.exec(message)?.[2]));
  const folder = why.length === TABLE_NAMES.length && codes.size === 1 && /^E[A-Z]+$/.test([...codes][0]) ? `Its folder ${PLAIN[[...codes][0]] ?? "cannot be read"}` : null;
  return [
    ...(programs && !noTasks ? [item("programs", "The programs table cannot be read", `${reasonOf(programs)}. The board shows the tasks without their programs. Ask the chief to repair the logbook.`)] : []),
    ...(lost.length ? [item("logbook", `The ${title(source.label)} logbook cannot be read`, `${folder ?? why.map(reasonOf).join(". ")}. ${shows} Ask the chief to repair the logbook.`)] : []),
  ];
}
/** A logbook whose programs table cannot be read shows its tasks with no program (R1307-1): no tag, and no program wait. */
const withoutPrograms = project => project.tables.programs || !project.tables.tasks ? project : { ...project, tables: { ...project.tables, tasks: project.tables.tasks.map(task => ({ ...task, program: "" })) } };

export function buildBoardModel(input, { now = new Date().toISOString(), landing = null } = {}) {
  const at = time(now);
  if (at === null) throw new TypeError("board time must be an ISO date");
  build++;
  const sources = input.map(source => ({ ...source, projects: source.projects.map(withoutPrograms) }));
  const { groups, notes } = projectGroups(sources);
  const groupOf = new Map(groups.flatMap(group => group.books.map(book => [book.project.key, group])));
  const graphs = new Map(sources.flatMap(source => source.projects.map(project => [project.key, graphOf(project)])));
  const tasks = sources.flatMap(source => source.projects.flatMap(project => (project.tables.tasks ?? []).filter(task => /^T[1-9]\d*$/.test(task.id)).map(task => card(source, project, groupOf.get(project.key), task, at, graphs.get(project.key), landing))));
  const byKey = new Map(tasks.map(task => [task.key, task]));
  const programs = sources.flatMap(source => source.projects.flatMap(project => programsOf(source, project, groupOf.get(project.key), graphs.get(project.key), byKey)));
  // What needs the owner that no card shows: a stuck program, a lost breakdown gate, a table or a logbook that the board
  // cannot read. An archived project's leave the counts, as its tasks do.
  const programNeeds = [...programs.filter(program => program.need).map(program => program.need),
    ...sources.flatMap(source => source.projects.flatMap(project => missingPrograms(source, project, groupOf.get(project.key), graphs.get(project.key)))),
    ...sources.flatMap(source => [...sourceNeeds(source), ...source.projects.flatMap(project => logbookNeeds(source, project, groupOf.get(project.key)))])], liveNeeds = programNeeds.filter(need => !need.archived);
  const recent = task => task.lastActivity ? Date.parse(task.lastActivity) : 0;
  // An archived project's tasks leave the columns and the counts; the archived group lists the project, with what needs you there.
  // Needs you first, then the newest activity. A priority sorts each column but Done, which stays newest first.
  const newest = (a, b) => (b.reasons.length > 0) - (a.reasons.length > 0) || recent(b) - recent(a);
  const shown = tasks.filter(task => task.visible && task.column).sort((a, b) => (b.reasons.length > 0) - (a.reasons.length > 0) || rank(a) - rank(b) || recent(b) - recent(a));
  const visible = shown.filter(task => !task.archived);
  const columnOf = (key, list) => { const cards = list.filter(task => task.column === key); return key === "done" ? cards.sort(newest) : cards; };
  // The picker's list (T305 design B): each project with its counts, in its list group: needs you, active in the last 14
  // days, idle, archived. Needs you sorts by its count, the others by the newest activity.
  const LISTS = ["needs", "active", "idle", "archived"];
  const projects = groups.map(group => {
    const own = tasks.filter(task => task.group === group.key), live = shown.filter(task => task.group === group.key);
    const last = Math.max(0, ...own.map(recent)), extra = programNeeds.filter(need => need.group === group.key).length, needsOwner = live.filter(task => task.reasons.length).length + extra;
    return { key: group.key, name: group.name, sub: group.sub, pathSub: group.pathSub ?? null, terms: group.terms, paths: group.paths, books: group.books.map(book => book.project.key), providers: group.providers, archived: group.archived, problem: group.problem, tasks: own.length, needsOwner, agents: live.reduce((n, task) => n + task.agents.filter(agent => !agent.stale).length, 0), lastActivity: last ? new Date(last).toISOString() : null,
      list: group.archived ? "archived" : needsOwner ? "needs" : last && at - last <= ACTIVE_DAYS * 86400000 ? "active" : "idle" };
  }).sort((a, b) => LISTS.indexOf(a.list) - LISTS.indexOf(b.list) || (a.list === "needs" ? b.needsOwner - a.needsOwner : 0) || (Date.parse(b.lastActivity ?? 0) || 0) - (Date.parse(a.lastActivity ?? 0) || 0) || a.name.localeCompare(b.name));
  const archived = projects.filter(project => project.archived).map(project => ({ key: project.key, name: project.name, tasks: project.tasks, needsOwner: project.needsOwner }));
  const agents = agentsOf(sources, groups, groupOf, byKey, at);
  return { at: new Date(at).toISOString(), tasks, programs, programNeeds: liveNeeds, projects, notes, agents, columns: COLUMNS.map(([key, name]) => ({ key, name, tasks: columnOf(key, visible), archivedTasks: columnOf(key, shown.filter(task => task.archived)), needsOwner: visible.some(task => task.column === key && task.reasons.length) })), needsOwner: visible.filter(task => task.reasons.length), archived, counts: { tasks: visible.length, needsOwner: visible.filter(task => task.reasons.length).length + liveNeeds.length, recordedAgents: visible.reduce((n, task) => n + task.agents.filter(agent => !agent.stale).length, 0), inferredWork: visible.filter(task => task.inferredWork).length, inReview: visible.filter(task => task.column === "review").length }, sources: sources.map(source => ({ id: source.id, label: source.label, standIn: standIn(source), diagnostics: source.diagnostics })), diagnostics: sources.flatMap(source => [...source.diagnostics.map(message => ({ source: source.id, message: plainProblem(message) })), ...source.projects.flatMap(project => project.diagnostics.map(message => ({ source: source.id, project: project.key, message: plainProblem(message) })))]), warnings: sources.flatMap(source => source.projects.flatMap(project => (project.warnings ?? []).map(message => ({ source: source.id, project: project.key, message: plainProblem(message) })))) };
}
