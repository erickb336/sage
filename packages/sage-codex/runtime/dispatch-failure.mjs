import { join } from "node:path";
import { readAdmission, failAdmission, failContinuationAdmission } from "sage-core";
import { nativeToolContext, nativeToolEvent } from "./native-tool.mjs";
import { readObservations } from "./events.mjs";
import { readNativeDispatchFailure, readNativeFollowupFailure, readDeliveredAssignment } from "./identity.mjs";

const refuse = () => { throw Error("Sage could not verify this dispatch failure."); };

/** Reconcile only the authenticated issuer's unbound calls, using its protected native transcript. */
export function reconcileNativeFailures(input, context, options) {
  const native = nativeToolContext(context);
  const event = nativeToolEvent(input, native, input?.hook_event_name);
  if (event.hook_event_name === "PreToolUse") {
    if (!["collaborationspawn_agent", "collaborationfollowup_task"].includes(event.tool_name)) refuse();
    if (!event.transcript_path) return; // No native transcript means no failure can be proved.
  } else if (!["collaborationlist_agents", "collaborationwait_agent"].includes(event.tool_name)) refuse();
  const state = readAdmission(options.directory), session = `codex:${event.session_id}`;
  const owner = state.sessions.find(row => row.project === options.project && row.session === session);
  if (!owner) refuse();
  const candidates = state.reservations.filter(row => row.assignment.project === options.project
    && row.assignment.session === session && row.assignment.epoch === owner.epoch && row.assignment.issuer === native.actor
    && ["collaborationspawn_agent", "collaborationfollowup_task"].includes(row.dispatch.tool)
    && !state.bindings.some(bound => bound.assignment === row.assignment.id)
    && !(state.failures ?? []).some(failed => failed.assignment === row.assignment.id));
  if (!candidates.length) return;
  const observations = readObservations(join(options.observationsRoot, event.session_id));
  let parent = null, path = "/root";
  if (native.actor !== event.session_id) {
    const bound = state.bindings.filter(row => row.project === options.project && row.session === session
      && row.epoch === owner.epoch && row.child === native.actor);
    const start = observations.filter(row => row.kind === "child-start" && row.child === native.actor);
    // Later assignments reuse this native actor. Its original binding proves identity.
    if (start.length !== 1 || bound.filter(row => row.turn === start[0].turn).length !== 1
      || bound.some(row => row.issuer !== start[0].parent)) refuse();
    parent = start[0].parent; path = start[0].path;
  }
  for (const row of candidates) {
    if (row.continuation) {
      reconcileFollowup(row, state, observations, event, native, owner, parent, path, options);
      continue;
    }
    // Any result or child-start evidence keeps the slot; this path covers preflight rejection only.
    if (observations.some(item => (item.kind === "spawn-result" && item.actor === native.actor && item.call === row.assignment.call)
      || (item.kind === "child-start" && item.parent === native.actor && item.path === `${path}/${row.dispatch.name}`))) continue;
    const requests = observations.filter(item => item.kind === "spawn-request" && item.actor === native.actor && item.call === row.assignment.call);
    if (requests.length !== 1 || requests[0].turn !== row.dispatch.turn || requests[0].name !== row.dispatch.name) refuse();
    const failure = readNativeDispatchFailure(event.transcript_path, { sessionsDir: options.sessionsDir }, {
      session: event.session_id, actor: native.actor, parent, path, turn: row.dispatch.turn,
      call: row.assignment.call, argumentsHash: row.dispatch.argumentsHash,
    });
    if (failure) failAdmission(options.directory, { project: options.project, session, epoch: owner.epoch,
      assignment: row.assignment.id, issuer: native.actor, call: row.assignment.call, evidenceHash: failure.evidenceHash });
  }
}


function reconcileFollowup(row, state, observations, event, native, owner, parent, path, options) {
  const session = owner.session;
  const predecessors = state.bindings.filter(bound => bound.assignment === row.continuation
    && bound.project === options.project && bound.session === session && bound.epoch === owner.epoch
    && bound.issuer === native.actor);
  if (predecessors.length !== 1 || !state.completions?.some(done => done.assignment === row.continuation)) refuse();
  const previous = predecessors[0], target = previous.child;
  // A success receipt or actual child delivery conflicts with preflight-only failure.
  if (observations.some(item => item.kind === "dispatch-result" && item.actor === native.actor && item.call === row.assignment.call)) return;
  const requests = observations.filter(item => item.kind === "dispatch-request" && item.actor === native.actor && item.call === row.assignment.call);
  const senders = observations.filter(item => item.kind === "followup-transcript" && item.actor === native.actor && item.call === row.assignment.call);
  if (requests.length !== 1 || requests[0].turn !== row.dispatch.turn || requests[0].mode !== "task" || requests[0].target !== target
    || senders.length !== 1 || senders[0].turn !== row.dispatch.turn || senders[0].target !== target
    || senders[0].transcript !== event.transcript_path) refuse();
  const failure = readNativeFollowupFailure(event.transcript_path, { sessionsDir: options.sessionsDir }, {
    session: event.session_id, actor: native.actor, parent, path, turn: row.dispatch.turn,
    call: row.assignment.call, argumentsHash: row.dispatch.argumentsHash,
    previous: row.continuation, target, taskHash: row.dispatch.taskHash,
  });
  if (!failure) return;
  const paths = observations.filter(item => item.kind === "child-transcript" && item.child === target && item.turn === previous.turn);
  const starts = observations.filter(item => item.kind === "child-start" && item.child === target);
  if (paths.length !== 1 || starts.length !== 1 || starts[0].parent !== native.actor) refuse();
  if (readDeliveredAssignment(paths[0].transcript, { sessionsDir: options.sessionsDir }, {
    session: event.session_id, child: target, parent: native.actor, path: starts[0].path,
    author: starts[0].path.slice(0, starts[0].path.lastIndexOf("/")), taskHash: row.dispatch.taskHash,
  })) return;
  if (failure) failContinuationAdmission(options.directory, { project: options.project, session, epoch: owner.epoch,
    assignment: row.assignment.id, issuer: native.actor, call: row.assignment.call,
    previous: row.continuation, target, turn: row.dispatch.turn, argumentsHash: row.dispatch.argumentsHash,
    taskHash: row.dispatch.taskHash, evidenceHash: failure.evidenceHash });
}
