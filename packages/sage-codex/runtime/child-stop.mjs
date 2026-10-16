import { join } from "node:path";
import { readAdmission, completeAdmission, interruptAdmission, REPORT_FIELDS, missingReportFields } from "sage-core";
import { checkPreparedRunAssignment } from "./run-assignment.mjs";
import { nativeToolContext } from "./native-tool.mjs";
import { readChildTurn, readNativeCompletion, readNativeInterruption, readNativeRecovery } from "./identity.mjs";
import { bindNativeChildTranscript, recoverNativeChildDeliveries } from "./child-tool.mjs";
import { RUNTIME_VERSION, decodeEvent, publish, readObservations } from "./events.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const refuse = () => { throw Error("Sage could not verify this child's completion."); };

function nativeStopContext(input, context) {
  const native = nativeToolContext(context);
  const keys = ["hook_event_name", "session_id", "agent_id", "turn_id", "transcript_path",
    ...(input && Object.hasOwn(input, "agent_transcript_path") ? ["agent_transcript_path"] : [])];
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== keys.length
    || keys.some(key => !Object.hasOwn(input, key)) || input.hook_event_name !== "SubagentStop"
    || !["session_id", "agent_id", "turn_id"].every(key => typeof input[key] === "string" && UUID.test(input[key]))
    || input.agent_id !== native.actor || native.actor === input.session_id
    || typeof input.transcript_path !== "string" || input.transcript_path.length > 4096
    || !input.transcript_path.startsWith("/") || /\p{Cc}/u.test(input.transcript_path)
    || (Object.hasOwn(input, "agent_transcript_path") && (typeof input.agent_transcript_path !== "string"
      || input.agent_transcript_path.length > 4096 || !input.agent_transcript_path.startsWith("/")
      || /\p{Cc}/u.test(input.agent_transcript_path)))) refuse();
  return native;
}

// Off-mode native children are not automatically Sage runs. Prove their identity
// and check existing claims before skipping report correction or completion writes.
function unmanagedStop(input, native, state, options, owner) {
  const session = `codex:${input.session_id}`;
  const scoped = row => row.project === options.project && row.session === session;
  const mode = owner && state.modes.filter(row => scoped(row) && row.epoch === owner.epoch).at(-1);
  if (mode?.sage || state.bindings.some(row => scoped(row) && row.child === native.actor && row.turn === input.turn_id)) return false;
  if (state.reservations.some(row => scoped(row.assignment) && row.continuation
    && state.bindings.some(bound => bound.assignment === row.continuation && bound.child === native.actor)
    && !state.completions?.some(done => done.assignment === row.assignment.id))) return false;
  if (!input.agent_transcript_path) refuse();
  const initial = readChildTurn(input.agent_transcript_path, { sessionsDir: options.sessionsDir },
    { session: input.session_id, child: native.actor, turn: input.turn_id });
  if (initial.metadata.cli_version !== RUNTIME_VERSION) refuse();
  const started = decodeEvent({ hook_event_name: "SubagentStart", session_id: input.session_id,
    agent_id: native.actor, turn_id: initial.initialTurn }, { ...native, metadata: initial.metadata });
  if (started.parent === native.actor) refuse();
  // A not-yet-bound first task may still own a pending reservation. Retain it.
  return initial.initialTurn !== input.turn_id || !state.reservations.some(row => scoped(row.assignment)
    && row.assignment.issuer === started.parent && row.dispatch.name === started.path.split("/").at(-1)
    && !state.bindings.some(bound => bound.assignment === row.assignment.id)
    && !(state.failures ?? []).some(failed => failed.assignment === row.assignment.id));
}

/** Record an authenticated stop; release its slot only with native terminal evidence. */
export function completeNativeChild(input, context, options) {
  const native = nativeStopContext(input, context);
  let state = readAdmission(options.directory);
  const session = `codex:${input.session_id}`;
  const owner = state.sessions.find(row => row.project === options.project && row.session === session);
  if (unmanagedStop(input, native, state, options, owner)) return { decision: "unmanaged" };
  if (!owner) refuse();
  const finished = state.completions?.some(row => row.project === options.project && row.session === session
    && row.epoch === owner.epoch && row.child === native.actor && row.turn === input.turn_id);
  if (!finished && input.agent_transcript_path) {
    // SubagentStop supplies the child's path separately from the parent transcript path.
    // This also retries a binding whose later observation publication was interrupted.
    bindNativeChildTranscript({ session: input.session_id, turn: input.turn_id, transcript: input.agent_transcript_path }, native, options);
    state = readAdmission(options.directory);
  }
  const bindings = state.bindings.filter(row => row.project === options.project && row.session === session
    && row.epoch === owner.epoch && row.child === native.actor && row.turn === input.turn_id);
  if (bindings.length !== 1) refuse();
  const bound = bindings[0];
  const evidence = completionEvidence(state, bound, input.session_id, options, input.agent_transcript_path);
  if (evidence.recoveryRequired) return { decision: "recovery-required" };
  publish(evidence.directory, { schema: 1, runtime: RUNTIME_VERSION, kind: "child-stop", session: input.session_id,
    child: native.actor, turn: input.turn_id });
  if (!evidence.completed) return { decision: "stop-observed" };
  return { decision: completeAdmission(options.directory, bound).decision };
}

function completionEvidence(state, bound, session, options, suppliedPath) {
  const assigned = state.reservations.find(row => row.assignment.id === bound.assignment);
  if (!assigned?.dispatch.taskHash) refuse();
  const directory = join(options.observationsRoot, session);
  const observations = readObservations(directory);
  const transcripts = observations.filter(row => row.kind === "child-transcript" && row.child === bound.child && row.turn === bound.turn);
  const starts = observations.filter(row => row.kind === "child-start" && row.child === bound.child);
  if (transcripts.length !== 1 || starts.length !== 1 || transcripts[0].turn !== bound.turn
    || (!assigned.continuation && starts[0].turn !== bound.turn) || starts[0].parent !== bound.issuer
    || (suppliedPath && suppliedPath !== transcripts[0].transcript)) refuse();
  const path = starts[0].path;
  const expected = {
    session, child: bound.child, parent: bound.issuer, path,
    author: path.slice(0, path.lastIndexOf("/")), turn: bound.turn, taskHash: assigned.dispatch.taskHash,
  };
  const recovery = readNativeRecovery(transcripts[0].transcript, { sessionsDir: options.sessionsDir }, expected);
  if (recovery.required) {
    const interrupted = readNativeInterruption(transcripts[0].transcript, { sessionsDir: options.sessionsDir }, expected);
    return { directory, observations, completed: null, interrupted, recoveryRequired: true };
  }
  const completed = readNativeCompletion(transcripts[0].transcript, { sessionsDir: options.sessionsDir, requireRecovery: true }, expected);
  const interrupted = completed ? null : readNativeInterruption(transcripts[0].transcript, { sessionsDir: options.sessionsDir }, expected);
  // Historical completion and authoritative interruption do not grant a new success.
  if (recovery.compaction !== null && !interrupted
    && !state.completions?.some(row => row.assignment === bound.assignment)) {
    checkPreparedRunAssignment(options, assigned, state.preparations.find(row => row.id === assigned.preparation));
  }
  return { directory, observations, completed, interrupted };
}

/** A native parent verifies terminal evidence for its own bound children. */
export function reconcileNativeCompletions(context, session, options, assignment) {
  const native = nativeToolContext(context);
  if (typeof session !== "string" || !UUID.test(session)) refuse();
  recoverNativeChildDeliveries(native, session, options, assignment);
  const state = readAdmission(options.directory);
  const key = `codex:${session}`;
  const owner = state.sessions.find(row => row.project === options.project && row.session === key);
  if (!owner) refuse();
  for (const bound of state.bindings.filter(row => row.project === options.project && row.session === key
    && row.epoch === owner.epoch && row.issuer === native.actor
    && (assignment === undefined || row.assignment === assignment))) {
    if (state.completions?.some(row => row.assignment === bound.assignment)) continue;
    // The start callback can bind a child before its first transcript reference arrives.
    // Keep that assignment pending; existing references still require full validation.
    const observations = readObservations(join(options.observationsRoot, session));
    if (!observations.some(row => row.kind === "child-transcript" && row.child === bound.child && row.turn === bound.turn)) continue;
    const evidence = completionEvidence(state, bound, session, options);
    if (evidence.completed) completeAdmission(options.directory, bound);
    else if (evidence.interrupted) interruptAdmission(options.directory, bound, evidence.interrupted.evidenceHash);
  }
  return { decision: "reconciled" };
}

export async function childStopOutput(input, context, loadPolicy) {
  if (!input || !Object.hasOwn(input, "stop_hook_active") || !Object.hasOwn(input, "last_assistant_message")
    || typeof input.stop_hook_active !== "boolean" || typeof input.last_assistant_message !== "string"
    || Buffer.byteLength(input.last_assistant_message, "utf8") > 1024 * 1024) refuse();
  const { stop_hook_active, last_assistant_message, ...identity } = input;
  const native = nativeStopContext(identity, context);
  const snapshot = structuredClone(identity);
  const policy = await loadPolicy();
  const result = await policy.completeChild(snapshot, native);
  if (!result || typeof result !== "object" || Array.isArray(result) || Object.keys(result).length !== 1
    || !Object.hasOwn(result, "decision") || !["stop-observed", "completed", "already-completed", "unmanaged", "recovery-required"].includes(result.decision)) refuse();
  if (result.decision === "recovery-required") return { decision: "block",
    reason: "After compaction, read your current assignment with sage_read_assignment before completing this task." };
  // A native terminal record ends correction. Otherwise ask once, as Claude does.
  if (result.decision === "stop-observed" && !stop_hook_active) {
    const missing = missingReportFields(last_assistant_message);
    if (missing.length) return { decision: "block", reason: `Sage: your report has no ${missing.join(", ")}. End with all required fields: ${REPORT_FIELDS.join(", ")}, each at the start of a line, with "none" where a field has nothing.` };
  }
  return {};
}
