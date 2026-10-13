import { join } from "node:path";
import { readAdmission } from "../core/index.mjs";
import { nativeToolContext, nativeToolEvent } from "./native-tool.mjs";
import { readInitialSession, readAssignmentTurn, readChildTurn } from "./identity.mjs";
import { RUNTIME_VERSION, decodeEvent, publish, readObservations } from "./events.mjs";
import { bindNativeChild } from "./child-binding.mjs";

const refuse = () => { throw Error("Sage could not verify this child's task."); };

/** The first tool's native actor and transcript prove identity when the MCP start hook was unavailable. */
export function bindNativeChildTool(input, context, options) {
  const native = nativeToolContext(context);
  const event = nativeToolEvent(input, native, "PreToolUse");
  if (native.actor === event.session_id || typeof event.transcript_path !== "string") refuse();
  readChildTurn(event.transcript_path, { sessionsDir: options.sessionsDir }, {
    session: event.session_id, child: native.actor, turn: event.turn_id,
  }, { active: true });
  return bindNativeChildTranscript({ session: event.session_id, turn: event.turn_id, transcript: event.transcript_path }, native, options);
}

/** A native callback can verify initial task delivery without inventing a tool call. */
export function bindNativeChildTranscript(input, context, options) {
  return bindObservedTranscript(input, nativeToolContext(context), options);
}

// The native caller supplies identity; the transcript supplies delivery evidence.
function bindObservedTranscript(input, native, options) {
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
  if (initial.turn !== event.turn_id) refuse();
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
  // Retain validated delivery even when its parent result has not arrived yet.
  // This observation grants no binding, tool permission, or completed assignment.
  if (!readObservations(directory).some(row => row.kind === "spawn-result" && row.actor === started.parent
    && row.call === assigned.assignment.call)) {
    publish(directory, { schema: 1, runtime: RUNTIME_VERSION, session: event.session_id, kind: "initial-child-transcript",
      child: native.actor, turn: initial.turn, transcript: event.transcript_path });
  }
  const { schema, runtime, kind, ...identity } = started;
  const result = bindNativeChild({ directory: options.directory, project: options.project, observationsDirectory: directory }, identity);
  publish(directory, { schema: 1, runtime: RUNTIME_VERSION, session: event.session_id, kind: "child-transcript",
    child: native.actor, turn: initial.turn, transcript: event.transcript_path });
  return result;
}

/** A native parent can recover delivery through a path already verified for this child. */
export function recoverNativeInitialDeliveries(context, session, options, assignment) {
  const native = nativeToolContext(context);
  if (typeof session !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(session)) refuse();
  const state = readAdmission(options.directory);
  const owner = state.sessions.find(row => row.project === options.project && row.session === `codex:${session}`);
  if (!owner) refuse();
  const scope = row => row.project === options.project && row.session === owner.session && row.epoch === owner.epoch;
  const candidates = state.reservations.filter(row => scope(row.assignment) && row.assignment.issuer === native.actor
    && (assignment === undefined || row.assignment.id === assignment)
    && !state.completions?.some(done => done.assignment === row.assignment.id));
  if (!candidates.length) return;
  const observations = readObservations(join(options.observationsRoot, session));
  for (const assigned of candidates) {
    const existing = state.bindings.find(row => row.assignment === assigned.assignment.id);
    if (existing && observations.some(row => row.kind === "child-transcript" && row.child === existing.child && row.turn === existing.turn)) continue;
    const starts = observations.filter(row => row.kind === "child-start" && row.parent === native.actor
      && row.path.slice(row.path.lastIndexOf("/") + 1) === assigned.dispatch.name);
    if (!starts.length) continue;
    if (starts.length !== 1) refuse();
    const started = starts[0];
    const paths = observations.filter(row => row.kind === "initial-child-transcript"
      && row.child === started.child && row.turn === started.turn);
    if (!paths.length) continue;
    if (paths.length !== 1) refuse();
    if (!observations.some(row => row.kind === "spawn-result" && row.actor === native.actor
      && row.call === assigned.assignment.call)) continue;
    bindObservedTranscript({ session, turn: started.turn, transcript: paths[0].transcript },
      { version: native.version, actor: started.child }, options);
  }
}
