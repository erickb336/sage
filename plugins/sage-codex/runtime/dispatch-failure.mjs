import { join } from "node:path";
import { readAdmission, failAdmission } from "../core/index.mjs";
import { nativeToolContext, nativeToolEvent } from "./native-tool.mjs";
import { readObservations } from "./events.mjs";
import { readNativeDispatchFailure } from "./identity.mjs";

const refuse = () => { throw Error("Sage could not verify this dispatch failure."); };

/** Reconcile only the authenticated issuer's unbound calls, using its protected native transcript. */
export function reconcileNativeFailures(input, context, options) {
  const native = nativeToolContext(context);
  const event = nativeToolEvent(input, native, input?.hook_event_name);
  if (event.hook_event_name === "PreToolUse") {
    if (event.tool_name !== "collaborationspawn_agent") refuse();
    if (!event.transcript_path) return; // No native transcript means no failure can be proved.
  } else if (!["collaborationlist_agents", "collaborationwait_agent"].includes(event.tool_name)) refuse();
  const state = readAdmission(options.directory), session = `codex:${event.session_id}`;
  const owner = state.sessions.find(row => row.project === options.project && row.session === session);
  if (!owner) refuse();
  const candidates = state.reservations.filter(row => row.assignment.project === options.project
    && row.assignment.session === session && row.assignment.epoch === owner.epoch && row.assignment.issuer === native.actor
    && row.dispatch.tool === "collaborationspawn_agent"
    && !state.bindings.some(bound => bound.assignment === row.assignment.id)
    && !(state.failures ?? []).some(failed => failed.assignment === row.assignment.id));
  if (!candidates.length) return;
  const observations = readObservations(join(options.observationsRoot, event.session_id));
  let parent = null, path = "/root";
  if (native.actor !== event.session_id) {
    const bound = state.bindings.filter(row => row.project === options.project && row.session === session
      && row.epoch === owner.epoch && row.child === native.actor);
    const start = observations.filter(row => row.kind === "child-start" && row.child === native.actor);
    if (bound.length !== 1 || start.length !== 1 || start[0].parent !== bound[0].issuer || start[0].turn !== bound[0].turn) refuse();
    parent = bound[0].issuer; path = start[0].path;
  }
  for (const row of candidates) {
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
