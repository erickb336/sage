import { join } from "node:path";
import { readAdmission, bindContinuationAdmission } from "sage-core";
import { nativeToolContext, nativeToolEvent } from "./native-tool.mjs";
import { readInitialSession, readAssignmentTurn, readNativeFollowup, readChildTurn } from "./identity.mjs";
import { RUNTIME_VERSION, decodeEvent, publish, readObservations } from "./events.mjs";
import { bindNativeChild } from "./child-binding.mjs";

const refuse = () => { throw Error("Sage could not verify this child's task."); };

/** The first tool's native actor and transcript prove identity when the MCP start hook was unavailable. */
export function bindNativeChildTool(input, context, options) {
  const native = nativeToolContext(context);
  const event = nativeToolEvent(input, native, "PreToolUse");
  if (native.actor === event.session_id || typeof event.transcript_path !== "string") refuse();
  return bindNativeChildTranscript({ session: event.session_id, turn: event.turn_id, transcript: event.transcript_path }, native, options);
}

/** A native callback can verify initial task delivery without inventing a tool call. */
export function bindNativeChildTranscript(input, context, options) {
  const native = nativeToolContext(context);
  const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== 3
    || !["session", "turn", "transcript"].every(key => Object.hasOwn(input, key))
    || typeof input.session !== "string" || !uuid.test(input.session) || input.session === native.actor
    || typeof input.turn !== "string" || !uuid.test(input.turn)) refuse();
  const event = { session_id: input.session, turn_id: input.turn, transcript_path: input.transcript };
  const initial = readInitialSession(event.transcript_path, { sessionsDir: options.sessionsDir });
  if (initial.metadata.cli_version !== RUNTIME_VERSION) refuse();
  // This is an observation of the transcript's initial task, not a received MCP start callback.
  const started = decodeEvent({ hook_event_name: "SubagentStart", session_id: event.session_id,
    agent_id: native.actor, turn_id: initial.turn }, { version: native.version, metadata: initial.metadata });
  if (started.parent === started.child) refuse();
  const state = readAdmission(options.directory);
  const session = `codex:${event.session_id}`;
  const owner = state.sessions.find(row => row.project === options.project && row.session === session);
  if (!owner) refuse();
  if (initial.turn !== event.turn_id) return bindLaterTurn(event, native, options, state, owner, started);
  const name = started.path.slice(started.path.lastIndexOf("/") + 1);
  const candidates = state.reservations.filter(row => row.assignment.project === options.project
    && row.assignment.session === session && row.assignment.epoch === owner.epoch
    && row.assignment.issuer === started.parent && row.dispatch.name === name);
  if (candidates.length !== 1 || !candidates[0].dispatch.taskHash) refuse();
  const assigned = candidates[0];
  readAssignmentTurn(event.transcript_path, { sessionsDir: options.sessionsDir }, {
    session: event.session_id, child: native.actor, parent: started.parent, path: started.path,
    author: started.path.slice(0, started.path.lastIndexOf("/")), turn: initial.turn, taskHash: assigned.dispatch.taskHash,
  });
  const directory = join(options.observationsRoot, event.session_id);
  const prior = readObservations(directory).filter(row => row.kind === "child-transcript" && row.child === native.actor);
  if (prior.length > 1 || prior.some(row => row.turn !== initial.turn || row.transcript !== event.transcript_path)) refuse();
  publish(directory, started);
  const { schema, runtime, kind, ...identity } = started;
  const result = bindNativeChild({ directory: options.directory, project: options.project, observationsDirectory: directory }, identity);
  publish(directory, { schema: 1, runtime: RUNTIME_VERSION, session: event.session_id, kind: "child-transcript",
    child: native.actor, turn: initial.turn, transcript: event.transcript_path });
  return result;
}

/** A later turn needs both successful parent dispatch and exact recipient delivery. */
function bindLaterTurn(event, native, options, state, owner, started) {
  readChildTurn(event.transcript_path, { sessionsDir: options.sessionsDir }, {
    session: event.session_id, child: native.actor, turn: event.turn_id,
  });
  const scope = row => row.project === options.project && row.session === owner.session && row.epoch === owner.epoch;
  const initial = state.bindings.filter(row => scope(row) && row.child === native.actor && row.turn === started.turn);
  if (initial.length !== 1 || initial[0].issuer !== started.parent) refuse();
  const candidates = state.reservations.filter(row => scope(row.assignment) && row.continuation
    && row.assignment.issuer === started.parent
    && state.bindings.some(bound => bound.assignment === row.continuation && bound.child === native.actor)
    && !state.completions?.some(done => done.assignment === row.assignment.id)
    && !state.bindings.some(bound => bound.assignment === row.assignment.id && bound.turn !== event.turn_id));
  if (candidates.length !== 1) refuse();
  const assigned = candidates[0];
  const directory = join(options.observationsRoot, event.session_id);
  const observations = readObservations(directory);
  const receipts = observations.filter(row => row.kind === "followup-transcript"
    && row.actor === started.parent && row.call === assigned.assignment.call && row.turn === assigned.dispatch.turn);
  if (receipts.length !== 1 || receipts[0].target !== native.actor) refuse();
  let sender = { parent: null, path: "/root" };
  if (started.parent !== event.session_id) {
    const starts = observations.filter(row => row.kind === "child-start" && row.child === started.parent);
    if (starts.length !== 1) refuse();
    sender = { parent: starts[0].parent, path: starts[0].path };
  }
  if (!readNativeFollowup(receipts[0].transcript, { sessionsDir: options.sessionsDir }, {
    session: event.session_id, actor: started.parent, ...sender, turn: assigned.dispatch.turn,
    call: assigned.assignment.call, target: native.actor, taskHash: assigned.dispatch.taskHash,
  })) refuse();
  readAssignmentTurn(event.transcript_path, { sessionsDir: options.sessionsDir }, {
    session: event.session_id, child: native.actor, parent: started.parent, path: started.path,
    author: started.path.slice(0, started.path.lastIndexOf("/")), turn: event.turn_id, taskHash: assigned.dispatch.taskHash,
  });
  const prior = observations.filter(row => row.kind === "child-transcript" && row.child === native.actor);
  if (prior.some(row => row.transcript !== event.transcript_path)) refuse();
  publish(directory, started);
  const result = bindContinuationAdmission(options.directory, { project: options.project, session: owner.session,
    epoch: owner.epoch, assignment: assigned.assignment.id, issuer: started.parent,
    call: assigned.assignment.call, child: native.actor, turn: event.turn_id });
  publish(directory, { schema: 1, runtime: RUNTIME_VERSION, session: event.session_id, kind: "child-transcript",
    child: native.actor, turn: event.turn_id, transcript: event.transcript_path });
  const { review, runTarget } = state.preparations.find(row => row.id === assigned.preparation) ?? {};
  return { ...result, ...(review ? { review } : {}), ...(runTarget ? { runTarget } : {}),
    assignment: assigned.assignment, ...(assigned.brief ? { brief: assigned.brief } : {}) };
}
