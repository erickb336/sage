import { createHash } from "node:crypto";
import { join } from "node:path";
import { readAdmission, prepareAdmission, reservePreparedAdmission, reservePreparedContinuation, createStateTool, REVIEW_ROLES } from "../core/index.mjs";
import { nativeToolContext, nativeToolEvent } from "./native-tool.mjs";
import { bindings, decodeEvent, publish, readObservations } from "./events.mjs";
import { readNativeFollowup } from "./identity.mjs";
import { preparedTaskMessage } from "./instructions.mjs";
import { validateLogbookLocation } from "./run-report.mjs";
import { captureNativeRunAssignment, checkNativeRunAssignment } from "./run-assignment.mjs";

const NAME = /^(?!root$)[a-z0-9_]{1,256}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const refuse = () => { throw Error("Sage could not verify this task preparation."); };

/** The current connection supplies the actor. Saved names and model arguments cannot select a role. */
function actorScope(options, native) {
  const state = readAdmission(options.directory);
  const own = state.sessions.find(row => row.project === options.project && row.session === `codex:${native.actor}`);
  if (own) return { scope: { project: own.project, session: own.session, epoch: own.epoch }, role: "chief-of-staff" };
  const candidates = state.bindings.filter(row => row.project === options.project && row.child === native.actor);
  if (candidates.length !== 1) refuse();
  const bound = candidates[0];
  const session = bound.session.slice(6);
  if (bound.session !== `codex:${session}` || !UUID.test(session)) refuse();
  const owner = state.sessions.find(row => row.project === options.project && row.session === bound.session && row.epoch === bound.epoch);
  const reservation = state.reservations.find(row => row.assignment.id === bound.assignment);
  if (!owner || !reservation || (state.completions ?? []).some(row => row.assignment === bound.assignment) || reservation.rolePlan?.role !== "lead" || reservation.rolePlan.issuerRole !== "chief-of-staff"
    || bound.issuer !== session || reservation.dispatch.tool !== "collaborationspawn_agent") refuse();
  const observations = readObservations(join(options.observationsRoot, session));
  const joined = bindings(observations).reservations.find(row => row.child === native.actor && row.state === "bound");
  if (!joined || joined.session !== session || joined.actor !== session || joined.call !== bound.call
    || joined.path !== `/root/${reservation.dispatch.name}`) refuse();
  const requests = observations.filter(row => row.kind === "spawn-request" && row.actor === session && row.name === reservation.dispatch.name);
  if (requests.length !== 1 || requests[0].call !== bound.call || requests[0].turn !== reservation.dispatch.turn
    || !observations.some(row => row.kind === "child-start" && row.child === native.actor && row.turn === bound.turn)) refuse();
  const prepared = state.preparations.find(row => row.id === reservation.preparation);
  checkNativeRunAssignment(options, { ...reservation.assignment, role: "lead" }, prepared?.runTarget);
  return { scope: { project: owner.project, session: owner.session, epoch: owner.epoch }, role: "lead", task: reservation.assignment.task };
}


function captureReview(options, input, cycle) {
  validateLogbookLocation(options);
  const tool = createStateTool({ defaultRoot: refuse });
  return tool.captureReviewTarget({ project: options.projectDirectory, task: input.task, run: input.run,
    role: input.role, cycle }, { ...process.env, SAGE_HOME: options.logbookRoot });
}

/** Fixed launcher options select storage. This operation saves work but never permits a native spawn. */
export function prepareNativeTask(input, context, options) {
  const native = nativeToolContext(context);
  const hasCycle = Object.hasOwn(input ?? {}, "reviewCycle");
  const hasPrevious = Object.hasOwn(input ?? {}, "previous");
  const keys = ["task", "run", "name", "role", "brief", ...(hasCycle ? ["reviewCycle"] : []), ...(hasPrevious ? ["previous"] : [])];
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== keys.length
    || keys.some(key => !Object.hasOwn(input, key)) || typeof input.name !== "string" || !NAME.test(input.name)) refuse();
  const { scope, role, task } = actorScope(options, native);
  if (role === "lead" && input.task !== task) refuse();
  let previous;
  if (hasPrevious) previous = completedRecipient(options, scope, native.actor, input.previous, input.task, input.role);
  const runTarget = captureNativeRunAssignment(options, input);
  const reviewRole = REVIEW_ROLES.includes(input.role);
  if (hasCycle && (!reviewRole || !options.logbookRoot)) refuse();
  const review = reviewRole && options.logbookRoot ? captureReview(options, input, input.reviewCycle) : undefined;
  const result = prepareAdmission(options.directory, scope,
    { task: input.task, run: input.run, issuer: native.actor, name: input.name },
    { issuerRole: role, role: input.role }, input.brief, review, runTarget, hasPrevious ? input.previous : undefined);
  const saved = result.preparation;
  return { decision: result.decision, preparation: saved.id, task: saved.task, run: saved.run, name: saved.name, role: saved.rolePlan.role, message: preparedTaskMessage(saved), ...(previous ? { target: previous.child, previous: input.previous } : { fork_turns: "none" }), ...(saved.review ? { review: saved.review } : {}) };
}

/** Input is the raw native PreToolUse payload, before any derived agent_id is added. */
export function reservePreparedSpawn(input, context, options) {
  const native = nativeToolContext(context);
  const event = nativeToolEvent(input, native, "PreToolUse");
  const observed = decodeEvent(event, native);
  if (observed?.kind !== "spawn-request") refuse();
  // Keep rejected and inactive attempts too. They can make later path reuse ambiguous.
  publish(join(options.observationsRoot, observed.session), observed);
  if (input.tool_input.fork_turns !== "none") refuse();
  const message = input.tool_input.message;
  if (typeof message !== "string" || !message || Buffer.byteLength(message, "utf8") > 1024 * 1024
    || Buffer.from(message, "utf8").toString("utf8") !== message) refuse();
  const taskHash = createHash("sha256").update(message).digest("hex");
  const { scope, role, task } = actorScope(options, native);
  if (scope.session !== `codex:${observed.session}`) refuse();
  const prepared = readAdmission(options.directory).preparations.filter(row => row.project === scope.project
    && row.session === scope.session && row.epoch === scope.epoch && row.issuer === native.actor && row.name === observed.name);
  if (prepared.length !== 1 || prepared[0].continuation || message !== preparedTaskMessage(prepared[0])) refuse();
  if (role === "lead" && prepared[0].task !== task) refuse();
  checkNativeRunAssignment(options, { ...prepared[0], role: prepared[0].rolePlan.role }, prepared[0].runTarget);
  if (REVIEW_ROLES.includes(prepared[0].rolePlan.role) && (options.logbookRoot || prepared[0].review)) {
    if (!prepared[0].review) refuse();
    const current = captureReview(options, { ...prepared[0], role: prepared[0].rolePlan.role }, prepared[0].review.cycle);
    if (JSON.stringify(current) !== JSON.stringify(prepared[0].review)) refuse();
  }
  return reservePreparedAdmission(options.directory, scope,
    { preparation: prepared[0].id, issuer: native.actor, call: observed.call },
    { tool: input.tool_name, turn: observed.turn, name: observed.name,
      argumentsHash: createHash("sha256").update(JSON.stringify(input.tool_input)).digest("hex"), taskHash }, role);
}


/** A saved assignment, not a supplied agent name, fixes the continuation recipient. */
function completedRecipient(options, scope, issuer, previous, task, role) {
  if (typeof previous !== "string" || !UUID.test(previous)) refuse();
  const state = readAdmission(options.directory);
  const assigned = state.reservations.find(row => row.assignment.id === previous);
  const bound = state.bindings.find(row => row.assignment === previous);
  if (!assigned || !bound || !state.completions?.some(row => row.assignment === previous)
    || !UUID.test(bound.child) || bound.child === issuer
    || ["project", "session", "epoch"].some(key => assigned.assignment[key] !== scope[key])
    || assigned.assignment.issuer !== issuer || assigned.assignment.task !== task || assigned.rolePlan?.role !== role) refuse();
  return bound;
}

/** Reserve an exact saved follow-up before native dispatch. Binding its later turn remains separate. */
export function reservePreparedFollowup(input, context, options) {
  const native = nativeToolContext(context);
  const event = nativeToolEvent(input, native, "PreToolUse");
  const observed = decodeEvent(event, native);
  if (observed?.kind !== "dispatch-request" || observed.mode !== "task"
    || Object.keys(event.tool_input).length !== 2 || !Object.hasOwn(event.tool_input, "target")
    || !Object.hasOwn(event.tool_input, "message") || !UUID.test(event.tool_input.target ?? "")) refuse();
  const { scope, role, task } = actorScope(options, native);
  if (scope.session !== `codex:${event.session_id}`) refuse();
  const message = event.tool_input.message;
  if (typeof message !== "string" || Buffer.byteLength(message) > 1024 * 1024) refuse();
  // The header locates a candidate; only complete saved bytes can authorize it.
  const id = /^Role: [a-z-]+\nPreparation: ([0-9a-f-]{36})\n/.exec(message)?.[1];
  if (!id || !UUID.test(id)) refuse();
  const prepared = readAdmission(options.directory).preparations.filter(row => row.id === id && row.project === scope.project
    && row.session === scope.session && row.epoch === scope.epoch && row.issuer === native.actor
    && row.continuation && message === preparedTaskMessage(row));
  if (prepared.length !== 1) refuse();
  const saved = prepared[0];
  if (role === "lead" && saved.task !== task) refuse();
  const previous = completedRecipient(options, scope, native.actor, saved.continuation, saved.task, saved.rolePlan.role);
  if (event.tool_input.target !== previous.child) refuse();
  checkNativeRunAssignment(options, { ...saved, role: saved.rolePlan.role }, saved.runTarget);
  if (REVIEW_ROLES.includes(saved.rolePlan.role)) {
    if (!saved.review || JSON.stringify(captureReview(options, { ...saved, role: saved.rolePlan.role }, saved.review.cycle)) !== JSON.stringify(saved.review)) refuse();
  }
  const taskHash = createHash("sha256").update(event.tool_input.message).digest("hex");
  const directory = join(options.observationsRoot, event.session_id);
  const sender = native.actor === event.session_id ? { parent: null, path: "/root" } : (() => {
    const starts = readObservations(directory).filter(row => row.kind === "child-start" && row.child === native.actor);
    if (starts.length !== 1) refuse();
    return { parent: starts[0].parent, path: starts[0].path };
  })();
  if (readNativeFollowup(event.transcript_path, { sessionsDir: options.sessionsDir }, {
    session: event.session_id, actor: native.actor, ...sender, turn: event.turn_id,
    call: event.tool_use_id, target: previous.child, taskHash,
  }) !== null) refuse(); // A completed call cannot become a new dispatch permission.
  publish(directory, observed);
  publish(directory, { schema: 1, runtime: native.version, kind: "followup-transcript", session: event.session_id,
    actor: native.actor, call: event.tool_use_id, turn: event.turn_id, target: previous.child, transcript: event.transcript_path });
  return reservePreparedContinuation(options.directory, scope,
    { preparation: saved.id, issuer: native.actor, call: event.tool_use_id, previous: saved.continuation },
    { tool: event.tool_name, turn: event.turn_id, name: saved.name,
      argumentsHash: createHash("sha256").update(JSON.stringify(event.tool_input)).digest("hex"), taskHash }, role);
}
