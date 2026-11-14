import { briefAnswer } from "./brief-hook.mjs";
import { gateAnswer } from "./gate-hook.mjs";
import { messageCheck } from "./message-check.mjs";
import { reportGate } from "./report-gate.mjs";
import { answer } from "./sage-codex-hook.mjs";
import { startStatus } from "./session-start-hook.mjs";
import { tool } from "../skills/sage/sage.mjs";

const mode = (input) => answer(input, process.env);
const stop = (input) => reportGate(input, process.env);
const check = (input) => messageCheck(input, process.env);
const pushed = (input) => { try { tool.observePush(input.tool_input?.command, input.cwd, process.env); } catch {} };
export const ROUTES = {
  SessionStart: [["source", /^(?:startup|resume|clear)$/, startStatus], ["source", /^(?:compact|fork)$/, mode]],
  UserPromptSubmit: [[null, null, mode]],
  PreToolUse: [["tool_name", /^(?:Bash|apply_patch|mcp__sage__.+)$|(?:spawn|resume)_agent$|^(?:multi_agent_v1)?send_input$|(?:send_message|followup_task)$/, gateAnswer]],
  PermissionRequest: [["tool_name", /^Bash$/, gateAnswer]],
  PostToolUse: [["tool_name", /spawn_agent$/, briefAnswer], ["tool_name", /^Bash$/, pushed]],
  SubagentStart: [[null, null, briefAnswer]],
  SubagentStop: [[null, null, stop]],
  Stop: [[null, null, check]],
};

export async function dispatch(event, input, context) {
  for (const [field, pattern, hook] of ROUTES[event] ?? []) {
    const value = input?.[field];
    if (pattern && typeof value === "string" && !pattern.test(value)) continue;
    return hook(input, context);
  }
  return undefined;
}
