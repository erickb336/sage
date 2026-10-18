import { basename } from "node:path";
import { githubRepository } from "./board-reader.mjs";
import { PRIORITIES, TASK_KINDS } from "./logbook-fields.mjs";
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
const FAILED = { checks: ["checks-fail"], qa: ["qa-fail"], "code-review": ["findings"], "security-review": ["findings"], "ux-review": ["findings"] };
const RUN_ROLE = { "code-review": "code-reviewer", "security-review": "security-reviewer", "ux-review": "ux-reviewer" };
const time = value => Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const rows = (project, name, task) => (project.tables[name] ?? []).filter(row => row.task === task.id);
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
const AGENT_WORD = { implementer: "implementer", lead: "lead", designer: "designer", pe: "PE", investigate: "investigator" };
const PART = { done: "done", failed: "fail", running: "run", pending: "wait", unknown: "unknown" };
const PLANNING = ["framed", "designing", "awaiting-you"];
const BEFORE_REVIEW = [...PLANNING, "briefed", "building", "held", "replan"];
const MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");
const dayMonth = ms => { const at = new Date(ms); return `${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]}`; };
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
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
  return now - last >= 86400000 ? { text: `no news since ${dayMonth(last)}: the run may have stopped; ask the sage to check it`, stale: true } : { text: `since ${dayMonth(start)}`, stale: false };
}

/**
 * Where a task is in its route, as design 1 of the T305 notes: only the route's steps (Plan, then Build, the review cycles
 * and Merge; or Investigate, Evidence review and Conclude), the current step marked, a repair as its own step, a "Now" or
 * "Needs you" line, and a "Next" line from a fixed rule per state (notes, section 4).
 */
function stepLine({ task, route, cycles, required, head, reasons, runs, ledger, rounds, autopilot, now, lastActivity }) {
  const state = task.state, build = route.includes("build"), sha = head ? head.slice(0, 7) : null;
  const working = roles => runs.find(run => run.status === "running" && roles.includes(run.role));
  const at = run => `${AGENT_WORD[run.role] ?? run.role} (${run.evidence?.data.provider ? `${run.evidence.data.provider}, ` : ""}run ${run.id})`;
  const clock = run => runClock(run.started, now, lastActivity).text;
  const gate = reasons.find(reason => reason.kind === "gate");
  const held = gate ? `Held at gate ${gate.gateId} (the question above).` : "Held (the note above).";
  const steps = [];

  const pe = working(["pe"]);
  const planStatus = state === "framed" ? "wait" : state === "designing" ? "run" : state === "awaiting-you" ? "need" : "done";
  steps.push({ key: "plan", label: "Plan", status: planStatus,
    detail: { framed: "In the backlog. No agent works on it.", designing: pe ? `The ${at(pe)} checks the plan, ${clock(pe)}.` : "The design is in progress.", "awaiting-you": "The design waits for your answer." }[state] ?? "Framed and briefed.",
    parts: [["framed", "done"],
      ...(route.includes("design") ? [["design", state === "framed" ? "wait" : state === "designing" ? pe ? "done" : "run" : state === "awaiting-you" ? "need" : "done"]] : []),
      ...(route.includes("pe") ? [["PE check", pe ? "run" : PLANNING.includes(state) ? "wait" : "done"]] : []),
      ["briefed", PLANNING.includes(state) ? "wait" : "done"]] });

  const doer = working(build ? ["implementer", "lead"] : ["investigate", "lead"]);
  const buildStatus = PLANNING.includes(state) || state === "briefed" ? "wait" : state === "building" ? reasons.length ? "need" : "run" : ["held", "replan"].includes(state) ? "need" : "done";
  const buildDetail = buildStatus === "run" || buildStatus === "need" && state === "building" ? doer ? `The ${at(doer)} is at work, ${clock(doer)}.` : "No agent runs now."
    : state === "held" ? held : state === "replan" ? "It needs a new plan (the note above)." : buildStatus === "wait" ? "" : build ? task.pr ? `PR ${task.pr} opened${sha ? `, head ${sha}` : ""}.` : "Built." : "The report is written.";
  steps.push({ key: "build", label: build ? "Build" : "Investigate", status: buildStatus, detail: buildDetail });

  const roleParts = cycle => cycle.steps.map(step => [ROLE_WORD[step.role] ?? step.role, PART[step.status] ?? "unknown"]);
  const waiting = cycle => cycle.steps.map(step => [ROLE_WORD[step.role] ?? step.role, "wait"]);
  const why = required > 1 ? task.risk ? `A risk flag (${task.risk.replace(/,/g, ", ")}) needs ${required} clean cycles.` : task.size === "large" ? `A large task needs ${required} clean cycles.` : `The project needs ${required} clean cycles.` : "";
  const reviewLabel = number => build ? `Review ${number} of ${required}` : required > 1 ? `Evidence review ${number} of ${required}` : "Evidence review";
  const fails = ledger.filter(row => String(row.pr) === task.pr && ["findings", "checks-fail", "qa-fail"].includes(row.kind));
  let current = null;
  if (state === "repairing") {
    const failed = fails.at(-1), round = Number(task.round) || 1, fixer = working(["implementer", "lead"]);
    const what = failed ? { "checks-fail": "The checks failed", "qa-fail": "QA failed" }[failed.kind] ?? `The ${ROLE_WORD[(runs.find(run => run.id === failed.run)?.role ?? "").replace(/er$/, "")] ?? "review"} found problems` : "A review found problems";
    steps.push({ key: "review", label: failed && positive(failed.cycle) ? reviewLabel(positive(failed.cycle)) : "Review", status: "fail", detail: `${what}${failed?.sha ? ` on ${String(failed.sha).slice(0, 7)}` : ""}.` });
    current = { key: "repair", label: `Repair, round ${round} of ${rounds}`, status: reasons.length ? "need" : "run", detail: fixer ? `The ${at(fixer)} fixes the findings on the same branch, ${clock(fixer)}.` : "No agent runs now." };
    steps.push(current, { key: "again", label: "Review again", status: "wait", detail: `A new commit starts again from cycle 1 of ${required}.`, parts: cycles[0] ? waiting(cycles[0]) : [] });
  } else {
    const open = cycles.findIndex(cycle => cycle.steps.some(step => step.status !== "done"));
    for (const [i, cycle] of cycles.entries()) {
      const failedRoles = cycle.steps.filter(step => step.status === "failed").map(step => ROLE_WORD[step.role] ?? step.role);
      const runningRoles = cycle.steps.filter(step => step.status === "running");
      let status, detail;
      if (BEFORE_REVIEW.includes(state)) [status, detail] = ["wait", i === 0 ? build ? task.pr ? "Starts when the build is done." : "Starts when the PR opens." : "Starts when the report is written." : why];
      else if (["verified", "pr-ready", "merged", "concluded"].includes(state) || cycle.steps.every(step => step.status === "done")) [status, detail] = ["done", sha ? `Clean on ${sha}.` : "Clean."];
      else if (failedRoles.length) [status, detail] = ["fail", `${failedRoles.join(" and ")} failed${sha ? ` on ${sha}` : ""}.`];
      else if (i === open || open === -1 && i === 0) {
        status = reasons.length ? "need" : "run";
        const run = runningRoles.map(step => runs.find(item => item.id === step.run)).find(Boolean);
        detail = !head ? "No verdict is recorded on the PR's last commit yet." : `On the last commit (${sha}).${run ? ` The ${ROLE_WORD[runningRoles[0].role] ?? runningRoles[0].role} (run ${run.id}) started ${clock(run)} ago.` : ""}`;
      } else [status, detail] = ["wait", why];
      const step = { key: `review-${i + 1}`, label: reviewLabel(i + 1), status, detail, parts: BEFORE_REVIEW.includes(state) ? waiting(cycle) : roleParts(cycle) };
      if (["run", "need", "fail"].includes(status) && !current) current = step;
      steps.push(step);
    }
  }
  const mergeStatus = ["verified", "pr-ready"].includes(state) ? build ? autopilot ? "run" : "need" : "done" : ["merged", "concluded"].includes(state) ? "done" : "wait";
  steps.push({ key: "merge", label: build ? "Merge" : "Conclude", status: mergeStatus,
    detail: build ? { done: "Merged.", run: "Autopilot merges it.", need: "Autopilot is off, so the merge waits for you." }[mergeStatus] ?? `After ${plural(required, "clean cycle")}${required > 1 ? " on one commit" : ""}.` : { done: "The report went to you.", run: "The chief concludes it." }[mergeStatus] ?? "The report goes to you. Nothing merges." });

  // The current step: the first that runs, fails or needs you; else none (a task in the backlog or done).
  current ??= steps.find(step => ["run", "need", "fail"].includes(step.status)) ?? null;
  const name = current?.key === "plan" ? "the plan" : current?.key === "build" ? build ? "the build" : "the investigation" : current?.key === "merge" ? build ? "the merge" : "the conclusion" : current?.key === "repair" ? "the repair" : "the review";
  const cycleNumber = Math.max(1, cycles.findIndex(cycle => cycle.steps.some(step => step.status !== "done")) + 1);
  const cycle = cycles[cycleNumber - 1];
  const runningNow = cycle?.steps.filter(step => step.status === "running").map(step => ROLE_WORD[step.role] ?? step.role) ?? [];
  const pendingNext = cycle?.steps.find(step => step.status === "pending");
  // A gate's question says why a task is held, so the line does not add "The task is held." to it.
  const needs = reasons.length ? reasons.filter(reason => !gate || reason.kind !== "held").map(reason => `${reason.text}${reason.recommendation ? ` I recommend: ${reason.recommendation}` : ""}`).join(" ") : state === "awaiting-you" ? "The design waits for your answer." : null;
  const nowText = {
    framed: "In the backlog. No agent works on it.",
    designing: pe ? "The PE check runs" : "The design is in progress",
    briefed: build ? "Briefed. The build starts next" : "Briefed. The investigation starts next",
    building: doer ? build ? `The ${AGENT_WORD[doer.role] ?? doer.role} builds it` : "The investigator works on it" : "No agent works on it now",
    reviewing: build ? !head ? `Review cycle 1 of ${required}: no verdict on the last commit yet` : runningNow.length ? `${runningNow.join(" and ")} ${runningNow.length === 1 ? "runs" : "run"} (cycle ${cycleNumber} of ${required})` : `Review cycle ${cycleNumber} of ${required} waits for its next run` : "The evidence review checks the report",
    repairing: `Repair, round ${Number(task.round) || 1} of ${rounds}: fix the open findings`,
    verifying: build ? "The chief checks the verdicts before the merge" : "The evidence review checks the report",
    verified: autopilot ? `Verified: autopilot merges PR ${task.pr}` : "Verified",
    "pr-ready": autopilot ? `Verified: autopilot merges PR ${task.pr}` : "Verified",
    merged: "Merged", concluded: "Concluded: the report went to you", abandoned: "Abandoned",
  }[state] ?? `Recorded state: ${state}`;
  const failedNow = cycle?.steps.some(step => step.status === "failed") && ["reviewing", "verifying"].includes(state);
  const next = ["merged", "concluded", "abandoned"].includes(state) ? null
    : gate && state !== "awaiting-you" ? `${name.charAt(0).toUpperCase()}${name.slice(1)} continues after your answer`
    : failedNow ? "A repair round, then the reviews start again at cycle 1"
    : {
      framed: route.includes("design") ? "The design" : build ? "The build" : "The investigation",
      designing: "You approve the design",
      "awaiting-you": build ? "The build is briefed after your answer" : "The investigation is briefed after your answer",
      briefed: build ? "The build" : "The investigation",
      building: build ? `Review cycle 1 of ${required} starts ${task.pr ? "on the PR's last commit" : "when the PR opens"}` : "The evidence review",
      held: "The build continues after your answer",
      replan: "The chief briefs it again",
      reviewing: build ? pendingNext ? `${ROLE_WORD[pendingNext.role] ?? pendingNext.role}, then ${cycleNumber < required ? `review cycle ${cycleNumber + 1} of ${required}` : "the merge"}` : cycleNumber < required ? `Review cycle ${cycleNumber + 1} of ${required}` : "The merge" : "Concluded: the report comes to you, with no PR",
      repairing: "The reviews start again at cycle 1 on the new commit",
      verifying: build ? "The merge" : "Concluded: the report comes to you, with no PR",
      verified: "Done after the merge",
      "pr-ready": "Done after the merge",
    }[state] ?? null;
  return { steps, current: current?.key ?? null, now: needs ? { needs: true, text: needs } : { needs: false, text: nowText }, next };
}

function card(source, project, group, task, now) {
  const records = (project.observations?.records ?? []).filter(record => record.task === task.id && time(record.observedAt) !== null && time(record.observedAt) <= now);
  const pr = latest(records, "pr", data => String(data.number) === task.pr);
  const completion = latest(records, "completion", data => data.state === task.state);
  const mode = latest(records, "mode");
  const runs = rows(project, "runs", task).map(run => ({ ...run, evidence: latest(records, "run", data => data.run === run.id) }));
  const agents = runs.filter(run => run.status === "running").map(run => ({ id: run.id, role: run.role, provider: run.evidence?.data.provider ?? null, evidence: run.evidence, recordedStatus: run.status }));
  const ledger = rows(project, "ledger", task);
  const gates = rows(project, "gates", task).filter(gate => !gate.answer);
  const reasons = gates.map(gate => ({ kind: "gate", key: `${project.key}/${gate.id}`, text: gate.question, recommendation: gate.recommendation || null, gateId: gate.id, options: gate.options ? gate.options.split("|").map(option => option.trim()) : [] }));
  if (["held", "replan"].includes(task.state)) reasons.push({ kind: task.state, text: task.state === "held" ? "The task is held." : "The task needs a new plan." });
  if (["verified", "pr-ready"].includes(task.state)) {
    const merge = task.pr ? `review and merge PR ${task.pr}` : "review the merge";
    if (!mode || !mode.data.autopilot) reasons.push({ kind: "merge", text: mode ? `Autopilot is off: ${merge}.` : `Autopilot state is unknown: ${merge}.` });
  }
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
  const current = head && !repairing ? ledger.filter(row => row.sha === head && String(row.pr) === task.pr) : [];
  const route = task.route.split(",").filter(Boolean);
  const steps = [...(route.includes("build") ? ["checks"] : []), ...route.filter(block => CLEAN[block])];
  const required = Math.max(positive(source.config?.["cycles.small"]) ?? 1, task.size === "large" ? Math.max(2, positive(source.config?.["cycles.large"] ?? source.config?.autopilot_cycles) ?? 2) : 1, task.risk ? Math.max(2, positive(source.config?.["cycles.risk"]) ?? 2) : 1);
  const count = Math.min(required, 10);
  const verdict = (role, number) => current.filter(row => (role === "checks" || positive(row.cycle) === number) && (row.kind === CLEAN[role] || (FAILED[role] ?? []).includes(row.kind) && (row.kind !== "findings" || runs.some(run => run.id === row.run && run.role === (RUN_ROLE[role] ?? role))))).at(-1) ?? null;
  const cycles = Array.from({ length: count }, (_, i) => ({ number: i + 1, steps: steps.map(role => {
    const last = verdict(role, i + 1);
    // A running run of the step's role runs the cycle its evidence names; with no run evidence, the role's first cycle without a verdict.
    const open = Array.from({ length: count }, (_, j) => j + 1).find(number => !verdict(role, number));
    const running = runs.find(run => run.status === "running" && run.role === (RUN_ROLE[role] ?? role) && (run.evidence ? run.evidence.data.head === head && run.evidence.data.cycle === i + 1 : open === i + 1));
    return { role, status: !head ? "unknown" : last ? last.kind === CLEAN[role] ? "done" : "failed" : running ? "running" : "pending", evidence: last, run: running?.id ?? null };
  }) }));
  for (const [index, row] of current.entries()) {
    if (!["checks-fail", "qa-fail"].includes(row.kind)) continue;
    // The ledger is append-only; order resolves equal second-precision timestamps.
    const newer = current.slice(index + 1).find(other => other.kind === (row.kind === "checks-fail" ? "checks-pass" : "qa-pass") && other.cycle === row.cycle);
    if (!newer) reasons.push({ kind: row.kind, text: `${row.kind === "checks-fail" ? "Checks" : "QA"} failed on the recorded PR head.`, evidence: row });
  }
  const inferred = pr?.data.state === "open" && task.branch.startsWith("codex/") && !agents.length;
  if (inferred && !["merged", "concluded", "abandoned"].includes(task.state)) reasons.push({ kind: "review-wait", text: "The PR has inferred provider work and waits for review." });
  const column = COLUMNS.find(([, , states]) => states.includes(task.state))?.[0] ?? null;
  const completionDecision = rows(project, "decisions", task).filter(row => row.decision === `state ${task.state}`).at(-1);
  const completedAt = completion ? time(completion.data.at) : ["merged", "concluded", "abandoned"].includes(task.state) ? time(completionDecision?.at) : null;
  const brief = project.contents?.[latest(records, "artifact", data => data.type === "brief")?.id]?.text ?? null;
  // N7: the newest run, verdict or decision time.
  const times = [...runs.flatMap(run => [run.started, run.ended]), ...ledger.map(row => row.at), ...rows(project, "decisions", task).map(row => row.at)].map(time).filter(at => at !== null);
  const lastActivity = times.length ? new Date(Math.max(...times)).toISOString() : null;
  // N8: a moved finding leaves its task; the move decision on the old task names the new task and key.
  const moves = (project.tables.decisions ?? []).map(row => ({ row, move: /^(F-\S+) moved to (T[1-9]\d*) as (F-\S+):/.exec(row.decision ?? "") })).filter(item => item.move);
  const found = (to, key) => (project.tables.findings ?? []).find(row => row.task === to && row.key === key);
  const findings = [
    ...rows(project, "findings", task).map(row => ({ ...row, movedFrom: moves.find(({ move }) => move[2] === task.id && move[3] === row.key)?.row.task ?? null })),
    ...moves.filter(({ row }) => row.task === task.id).map(({ row, move }) => ({ severity: "", summary: row.decision.slice(row.decision.indexOf(":") + 1).trim(), ...found(move[2], move[3]), task: task.id, key: move[1], status: "moved", reason: "", movedTo: move[2] })),
  ];
  return { key: `${project.key}/${task.id}`, source: source.id, sourceLabel: source.label, providerStandIn: standIn(source), repository: githubRepository(pr?.data.repository) ?? githubRepository(project.repository), lastActivity, headBasis, project: project.key, group: group.key, projectName: group.name, archived: group.archived, priority: PRIORITIES.includes(task.priority) ? task.priority : "", kind: TASK_KINDS.includes(task.kind) ? task.kind : "", ...Object.fromEntries(["id", "title", "size", "risk", "route", "state", "branch", "pr", "round", "keys"].map(field => [field, task[field] ?? ""])), column, prEvidence: pr, currentHead: head, modeEvidence: mode, completedAt, visible: column !== "done" || completedAt !== null && completedAt <= now && completedAt >= now - 7 * 86400000, agents, inferredWork: inferred, cycles, requiredCycles: required, reasons, runs, ledger, gates, findings, decisions: rows(project, "decisions", task).slice(-10), brief, briefFields: briefFields(brief), loop: stepLine({ task, route, cycles, required: count, head, reasons, runs, ledger, rounds: positive(source.config?.max_rounds) ?? 3, autopilot: mode?.data.autopilot === true, now, lastActivity }), runClocks: Object.fromEntries(runs.filter(run => run.status === "running").map(run => [run.id, runClock(run.started, now, lastActivity)])), artifacts: records.filter(record => record.kind === "artifact").map(record => ({ ...record, content: project.contents?.[record.id] ?? null })), diagnostics: [...project.diagnostics] };
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
 * differs; a project is archived when one of its logbooks is, with a note when another is not.
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
    const projects = group.books.map(book => book.project), first = field => projects.map(project => project[field]).find(Boolean) ?? null;
    const names = unique(projects.map(project => project.displayName));
    if (names.length > 1) note(group.books, `Two display names: the board shows "${names[0]}" (the first source), not ${names.slice(1).map(other => `"${other}"`).join(", ")}.`);
    const archived = group.books.filter(book => book.project.archived);
    if (archived.length && archived.length < projects.length) note(group.books, `Archived in ${keys(archived)} only: the board archives the project.`);
    const merged = { name: projects[0].name, displayName: first("displayName"), upstream: first("upstream"), repository: first("repository"), checkout: first("checkout") };
    const full = repoPath(merged.upstream) ?? repoPath(merged.repository), folder = merged.checkout ? basename(merged.checkout) : null;
    const problem = projects.flatMap(project => project.diagnostics)[0] ?? null;
    // The quiet second line names the next source of the name (notes, section 2), or says first that there is no GitHub
    // remote, then the folder; projectGroups gives the path instead when two projects would show the same lines.
    const remote = merged.displayName ? full : full && `${full.split("/")[0]}${repoPath(merged.upstream) ? " (upstream)" : ""}`;
    const sub = merged.checkout || remote ? [remote ?? "no GitHub remote", folder && `folder ${folder}`] : [`logbook ${merged.name}`];
    Object.assign(group, {
      // A project that no logbook can name, because every logbook of it is unreadable, is named by its folder, with the
      // reason (the prototype's failure state). One unreadable logbook does not rename what the others name (F-T305-3).
      name: projects.every(project => project.diagnostics.length) ? merged.name : projectName(merged),
      remote, path: merged.checkout ?? null,
      archived: archived.length > 0, problem,
      providers: unique(group.books.map(book => title(standIn(book.source)))),
      sub: unique(sub).join(" · "),
      // Search matches every name a person may know: the display names, the repositories, the folder, its path and the logbook keys.
      terms: unique([...names, repoPath(merged.upstream), ...projects.map(project => repoPath(project.repository)), folder, ...projects.map(project => project.checkout), merged.name, ...projects.map(project => project.key)]),
    });
  }
  // Two projects with the same name and the same second line, such as two clones in two folders of one name: each shows
  // its checkout's path in place of its folder, so that the picker tells them apart (F-T305-11).
  const line = group => `${group.name}\n${group.sub}`;
  for (const group of groups) if (group.path && groups.some(other => other !== group && line(other) === line(group))) group.twin = true;
  for (const group of groups) if (group.twin) group.sub = `${group.remote ?? "no GitHub remote"} · ${group.path}`;
  return { groups, notes };
}

export function buildBoardModel(sources, { now = new Date().toISOString() } = {}) {
  const at = time(now);
  if (at === null) throw new TypeError("board time must be an ISO date");
  const { groups, notes } = projectGroups(sources);
  const groupOf = new Map(groups.flatMap(group => group.books.map(book => [book.project.key, group])));
  const tasks = sources.flatMap(source => source.projects.flatMap(project => (project.tables.tasks ?? []).filter(task => /^T[1-9]\d*$/.test(task.id)).map(task => card(source, project, groupOf.get(project.key), task, at))));
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
    const last = Math.max(0, ...own.map(recent)), needsOwner = live.filter(task => task.reasons.length).length;
    return { key: group.key, name: group.name, sub: group.sub, terms: group.terms, providers: group.providers, archived: group.archived, problem: group.problem, tasks: own.length, needsOwner, agents: live.reduce((n, task) => n + task.agents.length, 0), lastActivity: last ? new Date(last).toISOString() : null,
      list: group.archived ? "archived" : needsOwner ? "needs" : last && at - last <= ACTIVE_DAYS * 86400000 ? "active" : "idle" };
  }).sort((a, b) => LISTS.indexOf(a.list) - LISTS.indexOf(b.list) || (a.list === "needs" ? b.needsOwner - a.needsOwner : 0) || (Date.parse(b.lastActivity ?? 0) || 0) - (Date.parse(a.lastActivity ?? 0) || 0) || a.name.localeCompare(b.name));
  const archived = projects.filter(project => project.archived).map(project => ({ key: project.key, name: project.name, tasks: project.tasks, needsOwner: project.needsOwner }));
  return { at: new Date(at).toISOString(), tasks, projects, notes, columns: COLUMNS.map(([key, name]) => ({ key, name, tasks: columnOf(key, visible), archivedTasks: columnOf(key, shown.filter(task => task.archived)), needsOwner: visible.some(task => task.column === key && task.reasons.length) })), needsOwner: visible.filter(task => task.reasons.length), archived, counts: { tasks: visible.length, needsOwner: visible.filter(task => task.reasons.length).length, recordedAgents: visible.reduce((n, task) => n + task.agents.length, 0), inferredWork: visible.filter(task => task.inferredWork).length, inReview: visible.filter(task => task.column === "review").length }, sources: sources.map(source => ({ id: source.id, label: source.label, standIn: standIn(source), diagnostics: source.diagnostics })), diagnostics: sources.flatMap(source => [...source.diagnostics.map(message => ({ source: source.id, message })), ...source.projects.flatMap(project => project.diagnostics.map(message => ({ source: source.id, project: project.key, message })))]), warnings: sources.flatMap(source => source.projects.flatMap(project => (project.warnings ?? []).map(message => ({ source: source.id, project: project.key, message })))) };
}
