import { createHash } from "node:crypto";
import { join } from "node:path";
import { readAdmission } from "sage-core";
import { nativeToolContext } from "./native-tool.mjs";
import { readObservations } from "./events.mjs";
import { readChildTurn, readAssignmentTurn, readNativeRecovery } from "./identity.mjs";
import { preparedTaskMessage } from "./instructions.mjs";

const refuse = () => { throw Error("Sage could not read this child's current assignment."); };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Read only the caller's active, delivered assignment. Caller input selects nothing. */
export function readNativeChildAssignment(input, context, options) {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length) refuse();
  const native = nativeToolContext(context), state = readAdmission(options.directory);
  const candidates = state.bindings.filter(row => row.project === options.project && row.child === native.actor
    && !state.completions?.some(done => done.assignment === row.assignment));
  if (candidates.length !== 1) refuse();
  const bound = candidates[0], session = bound.session.slice(6);
  if (bound.session !== `codex:${session}` || !UUID.test(session) || native.actor === session) refuse();
  const owner = state.sessions.find(row => row.project === options.project && row.session === bound.session && row.epoch === bound.epoch);
  const assigned = state.reservations.find(row => row.assignment.id === bound.assignment);
  const prepared = state.preparations.find(row => row.id === assigned?.preparation);
  if (!owner || !assigned || !prepared || state.failures?.some(row => row.assignment === bound.assignment)
    || ["project", "session", "epoch", "issuer"].some(key => assigned.assignment[key] !== bound[key] || prepared[key] !== bound[key])
    || ["task", "run"].some(key => prepared[key] !== assigned.assignment[key])
    || prepared.rolePlan.role !== assigned.rolePlan.role) refuse();
  const observations = readObservations(join(options.observationsRoot, session));
  const transcripts = observations.filter(row => row.kind === "child-transcript" && row.child === native.actor && row.turn === bound.turn);
  const starts = observations.filter(row => row.kind === "child-start" && row.child === native.actor);
  if (transcripts.length !== 1 || starts.length !== 1 || starts[0].parent !== bound.issuer) refuse();
  const transcript = transcripts[0].transcript, path = starts[0].path;
  const expected = { session, child: native.actor, turn: bound.turn };
  const nativeTurn = readChildTurn(transcript, { sessionsDir: options.sessionsDir }, expected, { active: true });
  if (nativeTurn.metadata.parent_thread_id !== bound.issuer || nativeTurn.metadata.agent_path !== path) refuse();
  const message = preparedTaskMessage(prepared), taskHash = createHash("sha256").update(message).digest("hex");
  if (Buffer.byteLength(message, "utf8") > 1024 * 1024 || taskHash !== assigned.dispatch.taskHash) refuse();
  readAssignmentTurn(transcript, { sessionsDir: options.sessionsDir }, {
    ...expected, parent: bound.issuer, path, author: path.slice(0, path.lastIndexOf("/")), taskHash,
  });
  // A read grants no permission. Refuse an observed concurrent lifecycle change.
  readChildTurn(transcript, { sessionsDir: options.sessionsDir }, expected, { active: true });
  if (JSON.stringify(readAdmission(options.directory)) !== JSON.stringify(state)) refuse();
  return { decision: "current-assignment", assignment: bound.assignment, preparation: prepared.id,
    task: prepared.task, run: prepared.run, role: prepared.rolePlan.role, child: native.actor,
    turn: bound.turn, taskHash, message };
}

/** An existing child must recover after compaction, including after Sage off. */
export function checkChildToolRecovery(event, native, options, prior) {
  const state = readAdmission(options.directory);
  const candidates = state.bindings.filter(row => row.project === options.project && row.child === native.actor
    && !state.completions?.some(done => done.assignment === row.assignment));
  if (!candidates.length) {
    if (prior) refuse();
    return null;
  }
  if (candidates.length !== 1) refuse();
  const bound = candidates[0];
  const owner = state.sessions.find(row => row.project === options.project && row.session === bound.session);
  if (bound.session !== `codex:${event.session_id}` || bound.turn !== event.turn_id || owner?.epoch !== bound.epoch
    || (prior && bound.assignment !== prior)) refuse();
  const assigned = state.reservations.find(row => row.assignment.id === bound.assignment);
  if (!assigned || state.failures?.some(row => row.assignment === bound.assignment)) refuse();
  const observations = readObservations(join(options.observationsRoot, event.session_id));
  const transcripts = observations.filter(row => row.kind === "child-transcript" && row.child === native.actor && row.turn === bound.turn);
  const starts = observations.filter(row => row.kind === "child-start" && row.child === native.actor);
  if (transcripts.length !== 1 || transcripts[0].transcript !== event.transcript_path
    || starts.length !== 1 || starts[0].parent !== bound.issuer) refuse();
  const path = starts[0].path;
  const recovery = readNativeRecovery(event.transcript_path, { sessionsDir: options.sessionsDir }, {
    session: event.session_id, child: native.actor, turn: bound.turn, parent: bound.issuer,
    path, author: path.slice(0, path.lastIndexOf("/")), taskHash: assigned.dispatch.taskHash,
  });
  // Uncompacted off-mode work keeps its existing behavior. Recovery itself requires
  // the current saved assignment and an active native turn.
  if (recovery.compaction !== null) readNativeChildAssignment({}, native, options);
  return { assignment: bound.assignment, required: recovery.required };
}
