import { join } from "node:path";
import { readAdmission, completeAdmission } from "../core/index.mjs";
import { nativeToolContext } from "./native-tool.mjs";
import { readNativeCompletion } from "./identity.mjs";
import { bindNativeChildTranscript } from "./child-tool.mjs";
import { RUNTIME_VERSION, publish, readObservations } from "./events.mjs";

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

/** Record an authenticated stop; release its slot only with native terminal evidence. */
export function completeNativeChild(input, context, options) {
  const native = nativeStopContext(input, context);
  let state = readAdmission(options.directory);
  const session = `codex:${input.session_id}`;
  const owner = state.sessions.find(row => row.project === options.project && row.session === session);
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
  const transcripts = observations.filter(row => row.kind === "child-transcript" && row.child === bound.child);
  const starts = observations.filter(row => row.kind === "child-start" && row.child === bound.child);
  if (transcripts.length !== 1 || starts.length !== 1 || transcripts[0].turn !== bound.turn
    || starts[0].turn !== bound.turn || starts[0].parent !== bound.issuer
    || (suppliedPath && suppliedPath !== transcripts[0].transcript)) refuse();
  const path = starts[0].path;
  const completed = readNativeCompletion(transcripts[0].transcript, { sessionsDir: options.sessionsDir }, {
    session, child: bound.child, parent: bound.issuer, path,
    author: path.slice(0, path.lastIndexOf("/")), turn: bound.turn, taskHash: assigned.dispatch.taskHash,
  });
  return { directory, observations, completed };
}

/** Only a native parent reconciles its own stopped children; the transcript is the terminal evidence. */
export function reconcileNativeCompletions(context, session, options) {
  const native = nativeToolContext(context);
  if (typeof session !== "string" || !UUID.test(session)) refuse();
  const state = readAdmission(options.directory);
  const key = `codex:${session}`;
  const owner = state.sessions.find(row => row.project === options.project && row.session === key);
  if (!owner) refuse();
  for (const bound of state.bindings.filter(row => row.project === options.project && row.session === key
    && row.epoch === owner.epoch && row.issuer === native.actor)) {
    if (state.completions?.some(row => row.assignment === bound.assignment)) continue;
    const observations = readObservations(join(options.observationsRoot, session));
    if (!observations.some(row => row.kind === "child-stop" && row.child === bound.child && row.turn === bound.turn)) continue;
    const evidence = completionEvidence(state, bound, session, options);
    if (evidence.completed) completeAdmission(options.directory, bound);
  }
  return { decision: "reconciled" };
}

export async function childStopOutput(input, context, loadPolicy) {
  const native = nativeStopContext(input, context);
  const snapshot = structuredClone(input);
  const policy = await loadPolicy();
  const result = await policy.completeChild(snapshot, native);
  if (!result || typeof result !== "object" || Array.isArray(result) || Object.keys(result).length !== 1
    || !Object.hasOwn(result, "decision") || !["stop-observed", "completed", "already-completed"].includes(result.decision)) refuse();
  return {};
}
