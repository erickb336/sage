import { join } from "node:path";
import { chiefBeat } from "sage-core";
import { readMode, tool } from "../skills/sage/sage.mjs";
import { briefAnswer } from "./brief-hook.mjs";
import { gateAnswer } from "./gate-hook.mjs";
import { messageCheck } from "./message-check.mjs";
import { reportGate } from "./report-gate.mjs";
import { answer } from "./sage-codex-hook.mjs";
import { startStatus } from "./session-start-hook.mjs";
import { modeDirectory, privateDirectory, readState, saveState, stateKey } from "./hook-state.mjs";

const mode = (input) => answer(input, process.env);
const stop = (input) => reportGate(input, process.env);
const check = (input) => messageCheck(input, process.env);
export const ROUTES = {
  SessionStart: [["source", /^(?:startup|resume|clear)$/, startStatus], ["source", /^(?:compact|fork)$/, mode]],
  UserPromptSubmit: [[null, null, mode]],
  PreToolUse: [["tool_name", /^(?:Bash|apply_patch|mcp__sage__.+)$|(?:spawn|resume)_agent$|^(?:multi_agent_v1)?send_input$|(?:send_message|followup_task)$/, gateAnswer]],
  PermissionRequest: [["tool_name", /^Bash$/, gateAnswer]],
  PostToolUse: [["tool_name", /spawn_agent$/, briefAnswer]],
  SubagentStart: [[null, null, briefAnswer]],
  SubagentStop: [[null, null, stop]],
  Stop: [[null, null, check]],
};

function routed(event, input, context) {
  for (const [field, pattern, hook] of ROUTES[event] ?? []) {
    const value = input?.[field];
    if (pattern && typeof value === "string" && !pattern.test(value)) continue;
    return hook(input, context);
  }
  return undefined;
}

function beat(input, env = process.env) {
  if (env.SAGE_HOOKS === "off" || !ROUTES[input?.hook_event_name] || "agent_id" in input || typeof input.cwd !== "string" || !stateKey(input)) return;
  try {
    const dir = join(modeDirectory(env), "live"), file = join(dir, `${stateKey(input)}.json`);
    let last;
    try { last = readState(file); } catch {}
    const { sage, autopilot } = readMode({ session: input.session_id }, env);
    const next = chiefBeat({ last, mode: { sageMode: sage, autopilot }, now: Date.now(), project: input.cwd, native: input.session_id, provider: "codex", tool, env });
    if (next === last) return;
    privateDirectory(dir);
    saveState(file, next);
  } catch {}
}

export async function dispatch(event, input, context) {
  const output = await routed(event, input, context);
  beat(input);
  return output;
}
