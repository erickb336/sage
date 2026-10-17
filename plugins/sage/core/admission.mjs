// Atomic admission journal. Unknown work stays reserved until an exact verified completion.
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fsyncSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, opendirSync, readSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, parse, resolve, sep } from "node:path";
import { createAssignment, parseAssignment } from "./assignments.mjs";
import { parseRolePlan, checkRoleReservation, checkLeadOwnership } from "./role-policy.mjs";
import { parseBrief } from "./brief.mjs";
import { parseReport } from "./report.mjs";
import { parseRunTarget } from "./run-target.mjs";
import { REVIEW_ROLES, parseReviewTarget } from "./review.mjs";

const KEY = /^[A-Za-z0-9_.:-]{1,256}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_RECORDS = 4096, MAX_BYTES = 64 * 1024;
const refuse = (reason) => { throw new Error(`Admission: ${reason}`); };
const hash = (text) => createHash("sha256").update(text).digest("hex");
const json = (value) => JSON.stringify(value);
const fields = (value, keys) => {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) refuse("invalid record fields");
};
const word = (value, key, pattern = KEY) => typeof value === "string" && pattern.test(value) ? value : refuse(`invalid ${key}`);
const cap = (value) => Number.isInteger(value) && value >= 1 && value <= 50 ? value : refuse("capacity must be 1 through 50");
function configuration(input) {
  fields(input, ["total", "projects"]);
  if (!Array.isArray(input.projects) || !input.projects.length || input.projects.length > 50) refuse("invalid project limits");
  const projects = Array.from(input.projects, (row) => {
    fields(row, ["project", "limit"]);
    return { project: word(row.project, "project"), limit: cap(row.limit) };
  }).sort((a, b) => a.project < b.project ? -1 : a.project > b.project ? 1 : 0);
  if (new Set(projects.map((p) => p.project)).size !== projects.length) refuse("duplicate project limit");
  return { total: cap(input.total), projects };
}
function activation(input) {
  fields(input, ["project", "session", "activation"]);
  return { project: word(input.project, "project"), session: word(input.session, "session"), activation: word(input.activation, "activation", UUID) };
}
function modeChange(input) {
  fields(input, ["project", "session", "epoch", "after", "turn", "sage"]);
  if (typeof input.sage !== "boolean") refuse("invalid mode value");
  return { project: word(input.project, "project"), session: word(input.session, "session"),
    epoch: word(input.epoch, "epoch", UUID), after: word(input.after, "prior mode turn", UUID),
    turn: word(input.turn, "mode turn", UUID), sage: input.sage };
}
function dispatchIdentity(input) {
  const hasTaskHash = Object.hasOwn(input ?? {}, "taskHash");
  fields(input, ["tool", "turn", "name", "argumentsHash", ...(hasTaskHash ? ["taskHash"] : [])]);
  return { tool: word(input.tool, "tool"), turn: word(input.turn, "turn"), name: word(input.name, "name"),
    argumentsHash: word(input.argumentsHash, "argumentsHash", /^[0-9a-f]{64}$/),
    ...(hasTaskHash ? { taskHash: word(input.taskHash, "taskHash", /^[0-9a-f]{64}$/) } : {}) };
}
function childBinding(input) {
  fields(input, ["project", "session", "epoch", "assignment", "issuer", "call", "child", "turn"]);
  return { project: word(input.project, "project"), session: word(input.session, "session"),
    epoch: word(input.epoch, "epoch", UUID), assignment: word(input.assignment, "assignment", UUID),
    issuer: word(input.issuer, "issuer"), call: word(input.call, "call"),
    child: word(input.child, "child"), turn: word(input.turn, "turn") };
}
function dispatchFailure(input) {
  fields(input, ["project", "session", "epoch", "assignment", "issuer", "call", "evidenceHash"]);
  return { project: word(input.project, "project"), session: word(input.session, "session"),
    epoch: word(input.epoch, "epoch", UUID), assignment: word(input.assignment, "assignment", UUID),
    issuer: word(input.issuer, "issuer"), call: word(input.call, "call"),
    evidenceHash: word(input.evidenceHash, "failure evidence hash", /^[0-9a-f]{64}$/) };
}
function continuationFailure(input) {
  fields(input, ["project", "session", "epoch", "assignment", "issuer", "call", "previous", "target", "turn", "argumentsHash", "taskHash", "evidenceHash"]);
  const { previous, target, turn, argumentsHash, taskHash, ...identity } = input;
  return { ...dispatchFailure(identity), previous: word(previous, "prior assignment", UUID),
    target: word(target, "continuation target"), turn: word(turn, "dispatch turn"),
    argumentsHash: word(argumentsHash, "arguments hash", /^[0-9a-f]{64}$/),
    taskHash: word(taskHash, "task hash", /^[0-9a-f]{64}$/) };
}
function interruptedFinish(input) {
  fields(input, ["binding", "task", "run", "role", "status", "evidenceHash", "runTarget"]);
  if (!["blocked", "question", "failed"].includes(input.status)) refuse("invalid interrupted run status");
  const request = { binding: childBinding(input.binding), task: word(input.task, "task", /^T[1-9][0-9]*$/),
    run: word(input.run, "run", /^R[1-9][0-9]*$/), role: word(input.role, "role"), status: input.status,
    evidenceHash: word(input.evidenceHash, "interruption evidence hash", /^[0-9a-f]{64}$/),
    runTarget: parseRunTarget(input.runTarget) };
  if (["task", "run", "role"].some(key => request[key] !== request.runTarget[key])) refuse("finish target differs from its run");
  return request;
}
// A historical child and all of its historical descendants form one protected team.
function finishActors(state, binding) {
  const actors = new Set([binding.child]);
  let changed;
  do {
    changed = false;
    for (const row of state.bindings) {
      if (["project", "session", "epoch"].every(key => row[key] === binding[key])
        && actors.has(row.issuer) && !actors.has(row.child)) { actors.add(row.child); changed = true; }
    }
  } while (changed);
  return actors;
}
function touchesFinish(state, request, value, continuation) {
  if (!["project", "session", "epoch"].every(key => value[key] === request.binding[key])) return false;
  const actors = finishActors(state, request.binding);
  const predecessor = continuation && state.bindings.find(row => row.assignment === continuation);
  return actors.has(value.issuer) || actors.has(value.child) || (predecessor && actors.has(predecessor.child));
}
function refuseFencedWork(state, value, continuation) {
  if ((state.interruptedFinishes ?? []).some(row => !row.receiptHash && touchesFinish(state, row.request, value, continuation)))
    refuse("interrupted run publication still owns this child team");
}
const taskGeneration = (state, project, task) => (state.taskUpdates ?? []).filter(row => row.update.project === project
  && row.update.task === task && row.accepted && row.update.disruptive).length;
const taskFence = (state, project, task) => (state.taskUpdates ?? []).find(row => row.update.project === project
  && row.update.task === task && row.accepted && !row.released);
function taskUpdateRequest(input) {
  fields(input, ["project", "session", "epoch", "request", "task", "digest", "disruptive"]);
  if (typeof input.disruptive !== "boolean") refuse("invalid update settlement rule");
  return { project: word(input.project, "project"), session: word(input.session, "session"),
    epoch: word(input.epoch, "epoch", UUID), request: word(input.request, "request", UUID),
    task: word(input.task, "task", /^T[1-9]\d*$/), digest: word(input.digest, "intent digest", /^[0-9a-f]{64}$/), disruptive: input.disruptive };
}
function preparation(input) {
  const hasReview = Object.hasOwn(input ?? {}, "review");
  const hasRunTarget = Object.hasOwn(input ?? {}, "runTarget");
  const hasContinuation = Object.hasOwn(input ?? {}, "continuation");
  const hasIssuerAssignment = Object.hasOwn(input ?? {}, "issuerAssignment");
  const hasGeneration = Object.hasOwn(input ?? {}, "generation");
  if (hasGeneration && (!Number.isSafeInteger(input.generation) || input.generation < 0)) refuse("invalid task generation");
  fields(input, ["project", "session", "epoch", "id", "task", "run", "issuer", "name", "rolePlan", "brief", ...(hasReview ? ["review"] : []), ...(hasRunTarget ? ["runTarget"] : []), ...(hasContinuation ? ["continuation"] : []), ...(hasIssuerAssignment ? ["issuerAssignment"] : []), ...(hasGeneration ? ["generation"] : [])]);
  const { name, rolePlan, brief, review, runTarget, continuation, issuerAssignment, generation, ...identity } = input;
  if (hasReview && !REVIEW_ROLES.includes(rolePlan?.role)) refuse("only a review role can carry a review target");
  const { call, ...parsed } = parseAssignment({ ...identity, call: name });
  const target = hasRunTarget ? parseRunTarget(runTarget) : undefined;
  if (target && (target.task !== parsed.task || target.run !== parsed.run || target.role !== rolePlan.role)) refuse("run target differs from its preparation");
  return { ...parsed, name: call, rolePlan: parseRolePlan(rolePlan), brief: parseBrief(brief),
    ...(hasReview ? { review: parseReviewTarget(review) } : {}), ...(target ? { runTarget: target } : {}),
    ...(hasContinuation ? { continuation: word(continuation, "prior assignment", UUID) } : {}),
    ...(hasIssuerAssignment ? { issuerAssignment: word(issuerAssignment, "issuer assignment", UUID) } : {}),
    ...(hasGeneration ? { generation } : {}) };
}
function reportRecord(input) {
  fields(input, ["binding", "task", "run", "reportMessage", "reportHash", "text"]);
  parseReport(input.text);
  const report = { binding: childBinding(input.binding), task: word(input.task, "task", /^T[1-9][0-9]*$/),
    run: word(input.run, "run", /^R[1-9][0-9]*$/), reportMessage: word(input.reportMessage, "report message"),
    reportHash: word(input.reportHash, "report hash", /^[0-9a-f]{64}$/), text: input.text };
  if (hash(report.text) !== report.reportHash) refuse("report content differs from its hash");
  return report;
}
function action(input) {
  if (["begin-interrupted-finish", "end-interrupted-finish"].includes(input?.kind)) {
    const end = input.kind === "end-interrupted-finish";
    fields(input, ["kind", "request", ...(end ? ["receiptHash"] : [])]);
    return { kind: input.kind, request: interruptedFinish(input.request),
      ...(end ? { receiptHash: word(input.receiptHash, "finish receipt hash", /^[0-9a-f]{64}$/) } : {}) };
  }
  if (["decide-task-update", "acknowledge-task-update", "release-task-update"].includes(input?.kind)) {
    const receipt = input.kind !== "decide-task-update";
    fields(input, ["kind", "update", ...(receipt ? ["receiptHash"] : [])]);
    return { kind: input.kind, update: taskUpdateRequest(input.update),
      ...(receipt ? { receiptHash: word(input.receiptHash, "receipt hash", /^[0-9a-f]{64}$/) } : {}) };
  }
  if (input?.kind === "configure") {
    fields(input, ["kind", "config"]);
    return { kind: "configure", config: configuration(input.config) };
  }
  if (input?.kind === "activate") {
    const hasMode = Object.hasOwn(input, "sage");
    fields(input, hasMode ? ["kind", "owner", "sage"] : ["kind", "owner"]);
    if (hasMode && typeof input.sage !== "boolean") refuse("invalid initial mode");
    fields(input.owner, ["project", "session", "activation", "epoch"]);
    const { epoch, ...request } = input.owner;
    return { kind: "activate", owner: { ...activation(request), epoch: word(epoch, "epoch", UUID) }, ...(hasMode ? { sage: input.sage } : {}) };
  }
  if (input?.kind === "mode") {
    fields(input, ["kind", "change"]);
    return { kind: "mode", change: modeChange(input.change) };
  }
  if (input?.kind === "prepare") {
    fields(input, ["kind", "preparation"]);
    return { kind: "prepare", preparation: preparation(input.preparation) };
  }
  if (input?.kind === "reserve") {
    const hasRole = Object.hasOwn(input, "rolePlan");
    const uniqueName = Object.hasOwn(input, "uniqueName");
    const hasBrief = Object.hasOwn(input, "brief");
    const hasPreparation = Object.hasOwn(input, "preparation");
    const hasContinuation = Object.hasOwn(input, "continuation");
    fields(input, ["kind", "assignment", "dispatch", ...(hasRole ? ["rolePlan"] : []), ...(uniqueName ? ["uniqueName"] : []), ...(hasBrief ? ["brief"] : []), ...(hasPreparation ? ["preparation"] : []), ...(hasContinuation ? ["continuation"] : [])]);
    if (uniqueName && (!hasRole || input.uniqueName !== true)) refuse("invalid unique-name rule");
    if (hasBrief && (!hasRole || !uniqueName)) refuse("a brief requires a role and unique child name");
    if (hasPreparation && !hasBrief) refuse("prepared dispatch requires its saved brief");
    if (hasContinuation && !hasPreparation) refuse("a continuation requires prepared work");
    return { kind: "reserve", assignment: parseAssignment(input.assignment), dispatch: dispatchIdentity(input.dispatch),
      ...(hasRole ? { rolePlan: parseRolePlan(input.rolePlan) } : {}), ...(uniqueName ? { uniqueName: true } : {}), ...(hasBrief ? { brief: parseBrief(input.brief) } : {}),
      ...(hasPreparation ? { preparation: word(input.preparation, "preparation", UUID) } : {}),
      ...(hasContinuation ? { continuation: word(input.continuation, "prior assignment", UUID) } : {}) };
  }
  if (input?.kind === "record-report") {
    fields(input, ["kind", "report"]);
    return { kind: "record-report", report: reportRecord(input.report) };
  }
  if (["fail-dispatch", "fail-continuation"].includes(input?.kind)) {
    fields(input, ["kind", "failure"]);
    return { kind: input.kind, failure: input.kind === "fail-continuation" ? continuationFailure(input.failure) : dispatchFailure(input.failure) };
  }
  if (input?.kind === "interrupt") {
    fields(input, ["kind", "completion", "evidenceHash"]);
    return { kind: "interrupt", completion: childBinding(input.completion),
      evidenceHash: word(input.evidenceHash, "interruption evidence hash", /^[0-9a-f]{64}$/) };
  }
  if (input?.kind === "complete") {
    fields(input, ["kind", "completion"]);
    return { kind: "complete", completion: childBinding(input.completion) };
  }
  if (["bind-child", "bind-continuation"].includes(input?.kind)) {
    fields(input, ["kind", "binding"]);
    return { kind: input.kind, binding: childBinding(input.binding) };
  }
  return refuse("unknown action");
}
function apply(state, event, replay = false) {
  const copy = structuredClone(state);
  if (event.kind === "configure") {
    if (copy.config) {
      if (json(copy.config) !== json(event.config)) refuse("configuration differs; reconciliation is required");
      return { state, result: copy.config, changed: false };
    }
    copy.config = event.config;
    return { state: copy, result: event.config, changed: true };
  }
  if (!copy.config) refuse("store is not configured");
  const value = event.update ?? (event.request ? event.request.binding : ["fail-dispatch", "fail-continuation"].includes(event.kind) ? event.failure : event.kind === "record-report" ? event.report.binding : event.kind === "activate" ? event.owner : event.kind === "mode" ? event.change : ["bind-child", "bind-continuation"].includes(event.kind) ? event.binding : ["complete", "interrupt"].includes(event.kind) ? event.completion : event.kind === "prepare" ? event.preparation : event.assignment);
  if (!copy.config.projects.some((p) => p.project === value.project)) refuse("project is not configured");
  const owner = copy.sessions.find((s) => s.project === value.project && s.session === value.session);
  if (event.kind === "activate") {
    if (owner) {
      if (owner.activation !== value.activation) refuse("session already has an owner; reconcile before a new activation");
      const initial = copy.modes.find(m => m.project === owner.project && m.session === owner.session && m.epoch === owner.epoch && m.after === null);
      if (initial.sage !== (event.sage ?? true)) refuse("activation has a different initial mode");
      return { state, result: owner, changed: false };
    }
    copy.sessions.push(value);
    copy.modes.push({ project: value.project, session: value.session, epoch: value.epoch,
      after: null, turn: value.activation, sage: event.sage ?? true });
    return { state: copy, result: value, changed: true };
  }
  if (!owner || owner.epoch !== value.epoch) refuse("assignment has no current session owner");
  if (event.update) {
    const prior = (copy.taskUpdates ?? []).find(row => ["project", "session", "epoch", "request"].every(key => row.update[key] === value[key]));
    if (prior) {
      if (json(prior.update) !== json(value)) refuse("task update request changed");
      if (event.kind === "decide-task-update") return { state, result: prior, changed: false };
      if (!prior.accepted) refuse("a rejected task update cannot be acknowledged or released");
      if (prior.receiptHash && prior.receiptHash !== event.receiptHash) refuse("task update receipt changed");
      if (event.kind === "release-task-update" && !prior.receiptHash) refuse("task update needs receipt acknowledgement before release");
      const next = { ...prior, receiptHash: event.receiptHash, ...(event.kind === "release-task-update" ? { released: true } : {}) };
      if (json(prior) === json(next)) return { state, result: prior, changed: false };
      Object.assign(prior, next);
      return { state: copy, result: prior, changed: true };
    }
    if (event.kind !== "decide-task-update") refuse("task update has no saved decision");
    const ended = new Set([...(copy.completions ?? []), ...(copy.failures ?? [])].map(row => row.assignment));
    const live = copy.reservations.filter(row => row.assignment.project === value.project && row.assignment.task === value.task
      && !ended.has(row.assignment.id));
    const conflict = taskFence(copy, value.project, value.task);
    const reason = conflict ? "Another task update is unresolved. Retry its original request."
      : value.disruptive && live.length ? `Reconcile or interrupt these assignments first: ${live.map(row => row.assignment.id).join(", ")}` : "";
    const decision = { update: value, accepted: !reason, reason };
    copy.taskUpdates = [...(copy.taskUpdates ?? []), decision];
    return { state: copy, result: decision, changed: true };
  }
  const modes = copy.modes.filter(m => m.project === value.project && m.session === value.session && m.epoch === value.epoch);
  const mode = modes.at(-1);
  if (event.kind === "mode") {
    const previous = modes.find(m => m.turn === value.turn);
    if (previous) {
      if (json(previous) !== json(value)) refuse("turn already has a different mode request");
      return { state, result: { decision: "already-recorded", mode }, changed: false };
    }
    if (mode.turn !== value.after) refuse("mode changed; read the current mode before a new request");
    copy.modes.push(value);
    return { state: copy, result: { decision: "changed", mode: value }, changed: true };
  }
  if (event.request) {
    const request = event.request;
    const previous = (copy.interruptedFinishes ?? []).find(row => row.request.binding.assignment === value.assignment);
    if (previous) {
      if (json(previous.request) !== json(request)) refuse("interrupted run already has a different finish request");
      if (event.kind === "begin-interrupted-finish") return { state, result: previous, changed: false };
      if (previous.receiptHash) {
        if (previous.receiptHash !== event.receiptHash) refuse("interrupted run receipt differs");
        return { state, result: previous, changed: false };
      }
      previous.receiptHash = event.receiptHash;
      return { state: copy, result: previous, changed: true };
    }
    if (event.kind !== "begin-interrupted-finish") refuse("interrupted run has no pending finish");
    const reserved = copy.reservations.find(row => row.assignment.id === value.assignment);
    const prepared = copy.preparations.find(row => row.id === reserved?.preparation);
    const bound = copy.bindings.find(row => row.assignment === value.assignment);
    const terminal = (copy.completions ?? []).find(row => row.assignment === value.assignment);
    if (!reserved?.preparation || !bound || json(bound) !== json(value)
      || reserved.assignment.task !== request.task || reserved.assignment.run !== request.run
      || reserved.rolePlan?.role !== request.role
      || !prepared?.runTarget || json(prepared.runTarget) !== json(request.runTarget)
      || json(terminal) !== json({ ...value, outcome: "interrupted", evidenceHash: request.evidenceHash }))
      refuse("interrupted run finish has no matching evidence");
    const ended = new Set([...(copy.completions ?? []), ...(copy.failures ?? [])].map(row => row.assignment));
    if (copy.reservations.some(row => !ended.has(row.assignment.id)
      && (touchesFinish(copy, request, row.assignment, row.continuation)
        || copy.bindings.some(binding => binding.assignment === row.assignment.id && touchesFinish(copy, request, binding)))))
      refuse("interrupted child team still has active work");
    const finish = { request };
    copy.interruptedFinishes = [...(copy.interruptedFinishes ?? []), finish];
    return { state: copy, result: finish, changed: true };
  }
  if (["fail-dispatch", "fail-continuation"].includes(event.kind)) {
    const reserved = copy.reservations.find(row => row.assignment.id === value.assignment);
    if (!reserved || ["project", "session", "epoch", "issuer", "call"].some(key => reserved.assignment[key] !== value[key])) refuse("failure has no matching reservation");
    if (event.kind === "fail-dispatch" && reserved.continuation) refuse("continuation failure requires separate evidence");
    if (event.kind === "fail-continuation") {
      const prior = copy.reservations.find(row => row.assignment.id === value.previous);
      const bound = copy.bindings.find(row => row.assignment === value.previous);
      const prepared = copy.preparations.find(row => row.id === reserved.preparation);
      if (reserved.continuation !== value.previous || !prior || !bound || !prepared?.runTarget
        || !(copy.completions ?? []).some(row => row.assignment === value.previous)
        || ["project", "session", "epoch", "issuer", "task"].some(key => prior.assignment[key] !== reserved.assignment[key])
        || ["project", "session", "epoch", "issuer"].some(key => bound[key] !== value[key])
        || bound.child !== value.target || json(prior.rolePlan) !== json(reserved.rolePlan)
        || ["project", "session", "epoch", "issuer", "task", "run"].some(key => prepared[key] !== reserved.assignment[key])
        || json(prepared.rolePlan) !== json(reserved.rolePlan) || json(prepared.brief) !== json(reserved.brief)
        || prepared.name !== reserved.dispatch.name
        || (prepared.continuation && prepared.continuation !== value.previous)
        || ["turn", "argumentsHash", "taskHash"].some(key => reserved.dispatch[key] !== value[key]))
        refuse("continuation failure differs from its prepared dispatch and completed owner");
    }
    if (copy.bindings.some(row => row.assignment === value.assignment)) refuse("a bound assignment cannot fail dispatch");
    const previous = (copy.failures ?? []).find(row => row.assignment === value.assignment);
    if (previous) {
      if (json(previous) !== json(value)) refuse("dispatch already has different failure evidence");
      return { state, result: { decision: "already-failed", failure: previous }, changed: false };
    }
    copy.failures = [...(copy.failures ?? []), value];
    return { state: copy, result: { decision: event.kind === "fail-continuation" ? "continuation-failed" : "dispatch-failed", failure: value }, changed: true };
  }
  if (["complete", "interrupt"].includes(event.kind)) {
    const bound = copy.bindings.find(row => row.assignment === value.assignment);
    if (!bound || json(bound) !== json(value)) refuse("completion has no matching child binding");
    const terminal = event.kind === "interrupt" ? { ...value, outcome: "interrupted", evidenceHash: event.evidenceHash } : value;
    const previous = (copy.completions ?? []).find(row => row.assignment === value.assignment);
    if (previous) {
      if (json(previous) !== json(terminal)) refuse("assignment already has different terminal evidence");
      return { state, result: { decision: "already-completed", completion: previous }, changed: false };
    }
    copy.completions = [...(copy.completions ?? []), terminal];
    return { state: copy, result: { decision: "completed", completion: terminal }, changed: true };
  }
  if (event.kind === "record-report") {
    const bound = copy.bindings.find(row => row.assignment === value.assignment);
    const completed = (copy.completions ?? []).find(row => row.assignment === value.assignment);
    const reserved = copy.reservations.find(row => row.assignment.id === value.assignment);
    if (!bound || !completed || json(bound) !== json(value) || json(completed) !== json(value)
      || reserved?.assignment.task !== event.report.task || reserved?.assignment.run !== event.report.run) {
      refuse("report has no matching completed assignment");
    }
    const previous = (copy.reports ?? []).find(row => row.binding.assignment === value.assignment);
    if (previous) {
      if (json(previous) !== json(event.report)) refuse("assignment already has a different recorded report");
      return { state, result: { decision: "already-recorded", report: previous }, changed: false };
    }
    copy.reports = [...(copy.reports ?? []), event.report];
    return { state: copy, result: { decision: "report-recorded", report: event.report }, changed: true };
  }
  if (["prepare", "reserve"].includes(event.kind)) {
    if (taskFence(copy, value.project, value.task)) refuse("task update is unresolved; new work is fenced");
    const prepared = event.kind === "prepare" ? value : copy.preparations.find(row => row.id === event.preparation);
    if (prepared && (prepared.generation ?? 0) !== taskGeneration(copy, value.project, value.task)) refuse("preparation belongs to a retired task generation");
  }
  const completed = new Set((copy.completions ?? []).map(row => row.assignment));
  const failed = new Set((copy.failures ?? []).map(row => row.assignment));
  const failedContinuations = new Set((copy.failures ?? []).filter(row => row.previous).map(row => row.assignment));
  const active = copy.reservations.filter(row => !completed.has(row.assignment.id) && !failed.has(row.assignment.id));
  const issuerBindings = copy.bindings.filter(row => row.project === value.project
    && row.session === value.session && row.epoch === value.epoch && row.child === value.issuer);
  if (["prepare", "reserve"].includes(event.kind) && issuerBindings.length
    && issuerBindings.every(row => completed.has(row.assignment))) refuse("completed issuer cannot admit new work");
  if (event.kind === "prepare") {
    const previous = copy.preparations.find(row => ["project", "session", "epoch", "issuer", "name"].every(key => row[key] === value[key]));
    if (previous) {
      const { id: oldId, ...oldWork } = previous;
      const { id: newId, ...newWork } = value;
      if (json(oldWork) !== json(newWork)) refuse("child name already prepares different work");
      return { state, result: { decision: "already-prepared", preparation: previous }, changed: false };
    }
    if (!mode.sage) refuse("Sage mode is off");
    if (copy.preparations.some(row => row.id === value.id)) refuse("preparation ID already exists");
    if (copy.reservations.some(row => ["project", "session", "epoch", "issuer"].every(key => row.assignment[key] === value[key])
      && row.dispatch.name === value.name)) refuse("child dispatch name is already reserved");
    if (value.continuation) {
      const prior = copy.reservations.find(row => row.assignment.id === value.continuation);
      const bound = copy.bindings.find(row => row.assignment === value.continuation);
      if (!prior || !bound || !completed.has(value.continuation) || !value.runTarget
        || ["project", "session", "epoch", "issuer", "task"].some(key => prior.assignment[key] !== value[key])
        || json(prior.rolePlan) !== json(value.rolePlan)) refuse("continuation preparation requires its completed owner and target");
      if (copy.reservations.some(row => row.continuation === value.continuation && !failedContinuations.has(row.assignment.id))) refuse("continuation predecessor already has later work");
    }
    if (value.issuerAssignment) {
      const parents = issuerBindings.filter(row => row.assignment === value.issuerAssignment && !completed.has(row.assignment));
      const parent = copy.reservations.find(row => row.assignment.id === value.issuerAssignment);
      if (parents.length !== 1 || !parent || parent.rolePlan?.role !== "lead"
        || parent.rolePlan.issuerRole !== "chief-of-staff" || value.rolePlan.issuerRole !== "lead"
        || parent.assignment.task !== value.task) refuse("preparation issuer assignment is not its active lead");
    }
    refuseFencedWork(copy, value, value.continuation);
    // Preparation checks the role relationship. Dispatch checks occupied slots again.
    checkRoleReservation([], value, value.rolePlan);
    copy.preparations.push(value);
    return { state: copy, result: { decision: "prepared", preparation: value }, changed: true };
  }
  if (["bind-child", "bind-continuation"].includes(event.kind)) {
    if (failed.has(value.assignment)) refuse("a failed dispatch cannot bind a child");
    const reserved = copy.reservations.find(row => row.assignment.id === value.assignment);
    if (!reserved || ["project", "session", "epoch", "issuer", "call"].some(key => reserved.assignment[key] !== value[key])) refuse("child binding has no matching reservation");
    if (!reserved.rolePlan) refuse("child binding requires a recorded role");
    if (Boolean(reserved.continuation) !== (event.kind === "bind-continuation")) refuse("binding requires its matching assignment kind");
    if (completed.has(value.assignment)) refuse("completed assignment cannot bind");
    if (value.child === value.issuer) refuse("issuer cannot bind itself as a child");
    const previous = copy.bindings.find(row => row.assignment === value.assignment);
    if (previous) {
      if (json(previous) !== json(value)) refuse("assignment already has a different child binding");
      return { state, result: { decision: "already-bound", binding: previous, role: reserved.rolePlan.role }, changed: false };
    }
    refuseFencedWork(copy, value, reserved.continuation);
    if (copy.reservations.filter(row => row.assignment.project === value.project && row.assignment.session === value.session
      && row.assignment.epoch === value.epoch && row.assignment.issuer === value.issuer
      && row.dispatch.name === reserved.dispatch.name).length !== 1) refuse("child dispatch name is ambiguous");
    if (reserved.continuation) {
      const prior = copy.bindings.find(row => row.assignment === reserved.continuation);
      if (!prior || !completed.has(prior.assignment) || value.child !== prior.child) refuse("continuation child differs from its completed predecessor");
      if (copy.bindings.some(row => row.session === value.session && row.child === value.child
        && (row.turn === value.turn || !completed.has(row.assignment)))) refuse("continuation child turn is occupied");
    } else if (copy.bindings.some(row => row.session === value.session && row.child === value.child)) refuse("child already belongs to another assignment");
    copy.bindings.push(value);
    return { state: copy, result: { decision: "bound", binding: value, role: reserved.rolePlan.role }, changed: true };
  }
  const prior = copy.reservations.find(({ assignment: a }) => a.project === value.project && a.session === value.session
    && a.epoch === value.epoch && a.issuer === value.issuer && a.call === value.call);
  if (prior) {
    if (["task", "run"].some((key) => prior.assignment[key] !== value[key]) || json(prior.dispatch) !== json(event.dispatch) || json(prior.rolePlan) !== json(event.rolePlan) || json(prior.brief) !== json(event.brief) || prior.preparation !== event.preparation || prior.continuation !== event.continuation) refuse("dispatch call already names different work");
    return { state, result: { decision: "already-reserved", assignment: prior.assignment }, changed: false };
  }
  refuseFencedWork(copy, value, event.continuation);
  if (!mode.sage) refuse("Sage mode is off");
  if (event.preparation) {
    const prepared = copy.preparations.find(row => row.id === event.preparation);
    if (!prepared || ["project", "session", "epoch", "task", "run", "issuer"].some(key => prepared[key] !== value[key])
      || prepared.name !== event.dispatch.name || json(prepared.rolePlan) !== json(event.rolePlan)
      || json(prepared.brief) !== json(event.brief)
      || (prepared.continuation && prepared.continuation !== event.continuation)) refuse("dispatch differs from its preparation");
    if (copy.reservations.some(row => row.preparation === event.preparation)) refuse("preparation already has a dispatch");
  }
  let continuingLead;
  if (event.continuation) {
    const prior = copy.reservations.find(row => row.assignment.id === event.continuation);
    const bound = copy.bindings.find(row => row.assignment === event.continuation);
    const prepared = copy.preparations.find(row => row.id === event.preparation);
    if (!prior || !bound || !completed.has(event.continuation)
      || ["project", "session", "epoch", "issuer", "task"].some(key => prior.assignment[key] !== value[key])
      || json(prior.rolePlan) !== json(event.rolePlan)) refuse("continuation requires the same completed task and role owner");
    if (!prepared.runTarget || !event.dispatch.taskHash) refuse("continuation requires a saved run target and task hash");
    if (copy.reservations.some(row => row.continuation === event.continuation && !failedContinuations.has(row.assignment.id))) refuse("continuation predecessor already has later work");
    if (copy.bindings.some(row => row.session === bound.session && row.child === bound.child && !completed.has(row.assignment)))
      refuse("continuation child is still active");
    if (event.rolePlan.role === "lead") continuingLead = bound.child;
  }
  if (copy.reservations.some(({ assignment: a }) => a.id === value.id)) refuse("assignment ID already exists");
  if (event.rolePlan && event.uniqueName && copy.reservations.some(row => row.assignment.project === value.project && row.assignment.session === value.session
    && row.assignment.epoch === value.epoch && row.assignment.issuer === value.issuer
    && row.dispatch.name === event.dispatch.name)) refuse("child dispatch name is already reserved");
  // A run names one execution. Preserve initial records written before this rule;
  // continuation records already required a new run. Failed starts may retry.
  if ((!replay || event.continuation) && copy.reservations.some(row => row.assignment.project === value.project
    && row.assignment.run === value.run && !failed.has(row.assignment.id))) refuse("run already has a dispatch; record a new run");
  if (event.rolePlan) {
    checkRoleReservation(active, value, event.rolePlan);
    if (!replay) checkLeadOwnership(copy, active, value, event.rolePlan, continuingLead);
  }
  if (active.length >= copy.config.total) refuse("total capacity is occupied");
  const projectLimit = copy.config.projects.find((p) => p.project === value.project).limit;
  if (active.filter(({ assignment: a }) => a.project === value.project).length >= projectLimit) refuse("project capacity is occupied");
  copy.reservations.push({ assignment: value, dispatch: event.dispatch, ...(event.rolePlan ? { rolePlan: event.rolePlan } : {}), ...(event.brief ? { brief: event.brief } : {}), ...(event.preparation ? { preparation: event.preparation } : {}), ...(event.continuation ? { continuation: event.continuation } : {}) });
  return { state: copy, result: { decision: "permit-once", assignment: value }, changed: true };
}
function syncDirectory(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function directory(path, create) {
  if (!isAbsolute(path) || resolve(path) !== path) refuse("directory must be absolute and canonical");
  let parent = parse(path).root;
  for (const part of path.slice(parent.length).split(sep).filter(Boolean)) {
    const current = join(parent, part);
    try { if (!lstatSync(current).isDirectory()) refuse("directory is not a real directory"); }
    catch (error) {
      if (!create || error.code !== "ENOENT") throw error;
      try { mkdirSync(current, { mode: 0o700 }); } catch (e) { if (e.code !== "EEXIST") throw e; }
      if (!lstatSync(current).isDirectory()) refuse("directory is not a real directory");
    }
    if (create) syncDirectory(parent);
    parent = current;
  }
}
function bytesAt(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_BYTES) refuse("invalid journal file");
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const n = readSync(fd, buffer, size, buffer.length - size, size);
      if (!n) break;
      size += n;
    }
    if (size > MAX_BYTES) refuse("journal file exceeds bound");
    const bytes = buffer.subarray(0, size), text = bytes.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(bytes)) refuse("invalid journal UTF-8");
    return text;
  } finally { closeSync(fd); }
}
const filename = (revision) => `${String(revision).padStart(8, "0")}.json`;
const envelope = (revision, previous, data) => {
  const body = { schema: 1, revision, previous, data };
  return { ...body, hash: hash(json(body)) };
};
function read(dir) {
  directory(dir, false);
  let maximum = -1, entries = 0;
  const stream = opendirSync(dir);
  try {
    for (let entry; (entry = stream.readSync());) {
      if (++entries > MAX_RECORDS * 2) refuse("too many journal entries");
      if (/^\.pending-[0-9a-f-]{36}$/.test(entry.name)) continue;
      if (!entry.isFile() || !/^\d{8}\.json$/.test(entry.name)) refuse("unexpected journal entry");
      const revision = Number(entry.name.slice(0, 8));
      if (revision >= MAX_RECORDS) refuse("journal limit reached; reconciliation is required");
      maximum = Math.max(maximum, revision);
    }
  } finally { stream.closeSync(); }
  let state = { config: null, sessions: [], reservations: [], modes: [], bindings: [], preparations: [] }, previous = null;
  for (let revision = 0; revision <= maximum; revision++) {
    const bytes = bytesAt(join(dir, filename(revision)));
    let record;
    try { record = JSON.parse(bytes); } catch { refuse("journal record is not JSON"); }
    fields(record, ["schema", "revision", "previous", "data", "hash"]);
    const event = action(record.data);
    const expected = envelope(revision, previous, event);
    if (json(expected) + "\n" !== bytes) refuse("journal chain or record differs");
    const next = apply(state, event, true);
    if (!next.changed) refuse("journal contains a duplicate transition");
    state = next.state;
    previous = expected.hash;
  }
  return { state, revision: maximum + 1, previous };
}
function commit(dir, input, create = false) {
  const event = action(input);
  directory(dir, create);
  // Each lost publication means another whole record won. Recompute against that state.
  for (let attempt = 0; attempt < MAX_RECORDS; attempt++) {
    const snapshot = read(dir);
    const next = apply(snapshot.state, event);
    if (!next.changed) { syncDirectory(dir); return structuredClone(next.result); }
    if (snapshot.revision >= MAX_RECORDS) refuse("journal limit reached; reconciliation is required");
    const bytes = json(envelope(snapshot.revision, snapshot.previous, event)) + "\n";
    if (Buffer.byteLength(bytes) > MAX_BYTES) refuse("record exceeds bound");
    const pending = join(dir, `.pending-${randomUUID()}`);
    const fd = openSync(pending, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    let won = false;
    try {
      try { linkSync(pending, join(dir, filename(snapshot.revision))); won = true; }
      catch (error) { if (error.code !== "EEXIST") throw error; }
      if (won) syncDirectory(dir);
    } finally { unlinkSync(pending); }
    if (won) return structuredClone(next.result);
  }
  return refuse("admission contention did not settle");
}

export const configureAdmission = (dir, config) => commit(dir, { kind: "configure", config }, true);
/** Activation must come from the trusted entry path, never a model-supplied ownership claim. */
export const activateAdmission = (dir, request, options = { sage: true }) => {
  fields(options, ["sage"]);
  return commit(dir, { kind: "activate", owner: { ...activation(request), epoch: randomUUID() }, sage: options.sage });
};
/** A verified owner prompt supplies the new turn and the expected previous mode turn. */
export const changeAdmissionMode = (dir, request) => commit(dir, { kind: "mode", change: request });
export const reserveAdmission = (dir, scope, request, dispatch) => commit(dir, { kind: "reserve", assignment: createAssignment(scope, request), dispatch });
/** The adapter must verify the issuer role before it requests this atomic reservation. */
export const reserveRoleAdmission = (dir, scope, request, dispatch, rolePlan) => commit(dir,
  { kind: "reserve", assignment: createAssignment(scope, request), dispatch, rolePlan: parseRolePlan(rolePlan), uniqueName: true });
/** Save role, brief, and capacity together before permitting the initial dispatch. */
export const reserveBriefAdmission = (dir, scope, request, dispatch, rolePlan, brief) => commit(dir,
  { kind: "reserve", assignment: createAssignment(scope, request), dispatch, rolePlan: parseRolePlan(rolePlan), uniqueName: true, brief: parseBrief(brief) });
/** Save instructions before the native dispatch call exists. No capacity or permission is granted. */
export function prepareAdmission(dir, scope, request, rolePlan, brief, options = {}) {
  const keys = ["review", "runTarget", "continuation", "issuerAssignment", "generation"].filter(key => Object.hasOwn(options ?? {}, key));
  fields(options, keys);
  const { review, runTarget, continuation, issuerAssignment, generation } = options;
  fields(request, ["task", "run", "issuer", "name"]);
  const { call, ...identity } = createAssignment(scope, { task: request.task, run: request.run, issuer: request.issuer, call: request.name });
  return commit(dir, { kind: "prepare", preparation: { ...identity, name: call, rolePlan, brief, generation: generation ?? taskGeneration(readAdmission(dir), identity.project, identity.task), ...(review === undefined ? {} : { review }), ...(runTarget === undefined ? {} : { runTarget }), ...(continuation === undefined ? {} : { continuation }), ...(issuerAssignment === undefined ? {} : { issuerAssignment }) } });
}
/** The adapter verifies the current issuer and role, then supplies the actual native call and dispatch. */
export function reservePreparedAdmission(dir, scope, request, dispatch, issuerRole) {
  fields(request, ["preparation", "issuer", "call"]);
  return reservePrepared(dir, scope, request, dispatch, issuerRole);
}
/** Reuse only a completed child from the same task, role, and owner. The adapter verifies native evidence. */
export function reservePreparedContinuation(dir, scope, request, dispatch, issuerRole) {
  fields(request, ["preparation", "issuer", "call", "previous"]);
  const { previous, ...work } = request;
  word(previous, "prior assignment", UUID);
  return reservePrepared(dir, scope, work, dispatch, issuerRole, previous);
}
function reservePrepared(dir, scope, request, dispatch, issuerRole, continuation) {
  word(request.preparation, "preparation", UUID);
  const prepared = readAdmission(dir).preparations.find(row => row.id === request.preparation);
  if (!prepared) refuse("preparation is unavailable");
  return commit(dir, { kind: "reserve", assignment: createAssignment(scope,
    { task: prepared.task, run: prepared.run, issuer: request.issuer, call: request.call }), dispatch,
    rolePlan: { issuerRole, role: prepared.rolePlan.role }, uniqueName: true, brief: prepared.brief, preparation: prepared.id,
    ...(continuation ? { continuation } : {}) });
}
/** Record a verified initial child identity. This neither permits dispatch nor releases capacity. */
export const bindAdmission = (dir, binding) => commit(dir, { kind: "bind-child", binding });
/** Bind a separately admitted later turn; an initial binding can never substitute for it. */
export const bindContinuationAdmission = (dir, binding) => commit(dir, { kind: "bind-continuation", binding });
/** The trusted adapter proves dispatch failed before a child existed. Late bindings cannot revive it. */
export const failAdmission = (dir, failure) => commit(dir, { kind: "fail-dispatch", failure });
/** The trusted adapter proves this exact later dispatch failed before a new child turn bound. */
export const failContinuationAdmission = (dir, failure) => commit(dir, { kind: "fail-continuation", failure });
/** Only a trusted adapter may submit authoritative terminal evidence for this exact binding.
 * Completion releases capacity; task success and report acceptance remain separate. */
export const completeAdmission = (dir, completion) => commit(dir, { kind: "complete", completion });
/** Verified interruption ends capacity ownership, not the task or its report gates. */
export const interruptAdmission = (dir, completion, evidenceHash) => commit(dir, { kind: "interrupt", completion, evidenceHash });
/** The trusted adapter verifies report provenance and parent identity before recording it.
 * This stores evidence only; it does not accept claims, write verdicts, or change task state. */
export const recordReportAdmission = (dir, report) => commit(dir, { kind: "record-report", report });
export function readAdmission(dir) {
  const { state } = read(dir);
  if (!state.config) refuse("store is not configured");
  return state;
}

/** Trusted provider only: acquire publication ownership while holding the logbook lock. */
export const beginInterruptedRunFinish = (dir, request) => commit(dir, { kind: "begin-interrupted-finish", request });
/** A durable validated logbook receipt must precede this exact acknowledgement. */
export const endInterruptedRunFinish = (dir, request, receiptHash) => commit(dir, { kind: "end-interrupted-finish", request, receiptHash });

/** Atomic task decision, receipt acknowledgement, and release are separate journal events. */
export const decideTaskUpdate = (directory, update) => commit(directory, { kind: "decide-task-update", update });
export const acknowledgeTaskUpdate = (directory, update, receiptHash) => commit(directory, { kind: "acknowledge-task-update", update, receiptHash });
export const releaseTaskUpdate = (directory, update, receiptHash) => commit(directory, { kind: "release-task-update", update, receiptHash });
export function assertTaskAdmissionOpen(directory, project, task, preparationId) {
  const state = readAdmission(directory);
  if (taskFence(state, project, task)) refuse("task update is unresolved; authority is fenced");
  if (preparationId) {
    const prepared = state.preparations.find(row => row.id === preparationId);
    if (!prepared || prepared.project !== project || prepared.task !== task
      || (prepared.generation ?? 0) !== taskGeneration(state, project, task)) refuse("assignment belongs to a retired task generation");
  }
  return taskGeneration(state, project, task);
}
