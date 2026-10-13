import { reconcileNativeFailures } from "./dispatch-failure.mjs";
import { completeNativeChild, reconcileNativeCompletions } from "./child-stop.mjs";
import { join } from "node:path";
import { decodeEvent, observation, publish, readObservations, RUNTIME_VERSION } from "./events.mjs";
import { nativeToolContext, nativeToolEvent } from "./native-tool.mjs";
import { readMode } from "./mode.mjs";
import { reservePreparedSpawn } from "./preparation.mjs";
import { checkChildToolRecovery } from "./child-assignment.mjs";
import { bindNativeChildTool, bindPendingNativeChildTool } from "./child-tool.mjs";
import { decodeNativeCommand } from "./command-input.mjs";
import { readInitialSession, readNativeCommand, readChildTurn } from "./identity.mjs";
import { boundChildInstructions } from "./instructions.mjs";

const refuse = () => { throw Error("Sage could not evaluate this native operation."); };
const decision = value => {
  if (!value || typeof value !== "object" || Array.isArray(value)) refuse();
  if (Object.keys(value).length === 1 && Object.hasOwn(value, "decision") && value.decision === "pass") return { decision: "pass" };
  if (Object.keys(value).length === 2 && Object.hasOwn(value, "decision") && Object.hasOwn(value, "reason")
    && value.decision === "deny" && typeof value.reason === "string" && value.reason.length > 0
    && value.reason.length <= 500 && value.reason.trim() === value.reason && !/\p{Cc}/u.test(value.reason)) {
    return { decision: "deny", reason: value.reason };
  }
  refuse();
};
const modeStamp = value => JSON.stringify([value.owner?.epoch, value.modes.at(-1)?.turn, value.sage]);

/** The launcher supplies fixed storage and a complete tool policy. There is no permissive default. */
export function createNativePolicy(options, evaluateTool) {
  if (!options || typeof evaluateTool !== "function"
    || !["directory", "project", "observationsRoot"].every(key => typeof options[key] === "string" && options[key])) refuse();
  const fixed = Object.freeze({ directory: options.directory, project: options.project, observationsRoot: options.observationsRoot, sessionsDir: options.sessionsDir });
  const mode = session => readMode(fixed.directory, fixed.project, session);
  const record = value => {
    const event = observation(value);
    publish(join(fixed.observationsRoot, event.session), event);
  };
  return Object.freeze({
    async evaluate(input, context) {
      const native = nativeToolContext(context);
      // The MCP boundary adds agent_id. Validate that derived field before rebuilding raw input.
      const snapshot = structuredClone(input);
      const child = native.actor !== snapshot.session_id;
      if (Object.hasOwn(snapshot, "agent_id") !== child || (child && snapshot.agent_id !== native.actor)) refuse();
      const { agent_id, ...raw } = snapshot;
      const event = nativeToolEvent(raw, native, "PreToolUse");
      const observed = decodeEvent(event, native);
      if (observed) record(observed); // Keep inactive and denied attempts; name reuse must stay visible.
      const before = mode(event.session_id);
      if (before.sage && child) bindNativeChildTool(raw, native, fixed);
      else if (child) bindPendingNativeChildTool(raw, native, fixed);
      let command, readCommand;
      // Path and state-tool protection also need original inputs while Sage is off.
      if (event.tool_name === "Bash") {
        if (Object.keys(event.tool_input).length !== 1 || !Object.hasOwn(event.tool_input, "command")) refuse();
        let parent = null, path = "/root";
        if (child) {
          const starts = readObservations(join(fixed.observationsRoot, event.session_id))
            .filter(row => row.kind === "child-start" && row.child === native.actor);
          if (before.sage) {
            const current = starts; // Native child identity stays fixed across admitted turns.
            if (current.length !== 1) refuse();
            ({ parent, path } = current[0]);
          } else {
            // An inactive child needs no Sage admission or start callback. Its native
            // transcript supplies stable identity; readNativeCommand verifies the current turn.
            const initial = readInitialSession(event.transcript_path, { sessionsDir: fixed.sessionsDir });
            if (initial.metadata.cli_version !== RUNTIME_VERSION) refuse();
            const started = decodeEvent({ hook_event_name: "SubagentStart", session_id: event.session_id,
              agent_id: native.actor, turn_id: initial.turn }, { ...native, metadata: initial.metadata });
            ({ parent, path } = started);
            if (parent === native.actor || starts.some(row => row.parent !== parent || row.path !== path)) refuse();
          }
        }
        readCommand = () => decodeNativeCommand(readNativeCommand(event.transcript_path, { sessionsDir: fixed.sessionsDir }, {
          session: event.session_id, actor: native.actor, parent, path, turn: event.turn_id,
          call: event.tool_use_id, command: event.tool_input.command,
        }));
        command = readCommand();
      }
      const recovery = child ? checkChildToolRecovery(event, native, fixed) : null;
      const recoveryReader = event.tool_name === "mcp__sage_preparation__sage_read_assignment"
        && Object.keys(event.tool_input).length === 0;
      const recoveryDenied = { decision: "deny", reason: "Read your current assignment with sage_read_assignment before continuing." };
      if (recovery?.required && !recoveryReader) return recoveryDenied;
      const checked = decision(await evaluateTool(structuredClone(event), Object.freeze({ ...native, sage: before.sage, ...(command ? { command: structuredClone(command) } : {}) })));
      // A concurrent mode change cannot turn an earlier decision into current permission.
      if (modeStamp(before) !== modeStamp(mode(event.session_id))) refuse();
      if (checked.decision === "deny") return checked;
      if (readCommand && JSON.stringify(readCommand()) !== JSON.stringify(command)) refuse();
      const recovered = child ? checkChildToolRecovery(event, native, fixed, recovery?.assignment) : null;
      if (recovered?.required && !recoveryReader) return recoveryDenied;
      if (before.sage && child) readChildTurn(event.transcript_path, { sessionsDir: fixed.sessionsDir }, {
        session: event.session_id, child: native.actor, turn: event.turn_id,
      }, { active: true });
      if (before.sage && observed?.kind === "spawn-request") {
        reconcileNativeFailures(raw, native, fixed);
        const reserved = reservePreparedSpawn(raw, native, fixed);
        return reserved.decision === "permit-once" ? { decision: "pass" }
          : { decision: "deny", reason: "Sage already reserved this native dispatch." };
      }
      return checked;
    },
    recordDispatchResult(value) {
      const event = observation(value);
      if (!["spawn-result", "dispatch-result"].includes(event.kind)) refuse();
      record(event);
      return { decision: "recorded" };
    },
    reconcileCompletions(input, context) {
      const native = nativeToolContext(context);
      const event = nativeToolEvent(input, native, "PostToolUse");
      if (!["collaborationlist_agents", "collaborationwait_agent"].includes(event.tool_name)) refuse();
      if (!mode(event.session_id).owner) return { decision: "reconciled" };
      reconcileNativeFailures(input, native, fixed);
      return reconcileNativeCompletions(native, event.session_id, fixed);
    },
    completeChild(input, context) {
      return completeNativeChild(input, context, fixed);
    },
    startChild(identity) {
      // nativeChildStart has already authenticated this identity against the current connection.
      record({ schema: 1, runtime: RUNTIME_VERSION, kind: "child-start", ...identity });
      if (!mode(identity.session).sage) return { decision: "pass" };
      return boundChildInstructions({ directory: fixed.directory, project: fixed.project,
        observationsDirectory: join(fixed.observationsRoot, identity.session) }, identity);
    },
  });
}
