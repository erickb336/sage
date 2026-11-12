// sage's one hook entry for Codex (T957). The launcher in <CODEX_HOME>/sage-hooks imports this file from the installed
// sage version and calls dispatch with the event of its entry. The entries have no matcher (entries.mjs), so the matchers
// of the hooks before T957 are here: a route runs when its pattern matches the input's field, as Codex's matcher did
// (hooks/src/engine/matcher.rs: a list of names such as startup|resume is an exact match, any other pattern an unanchored
// regex search, on the source or the tool name). An input without that field goes to the hook, which answers an unread
// input as before (the gate refuses it).
import { briefAnswer } from "./brief-hook.mjs";
import { gateAnswer } from "./gate-hook.mjs";
import { messageCheck } from "./message-check.mjs";
import { reportGate } from "./report-gate.mjs";
import { answer } from "./sage-codex-hook.mjs";
import { startStatus } from "./session-start-hook.mjs";

const mode = (input) => answer(input, process.env);
const stop = (input) => reportGate(input, process.env);
const check = (input) => messageCheck(input, process.env);
/**
 * Each event's routes: [the field that Codex matched, its pattern, the hook], the first that matches runs. A hook gets the
 * input and the launcher's context; a hook whose second parameter is its env gets a wrapper (mode, stop, check), never the context.
 */
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

/** The output object of sage's hook for one event and its parsed input (undefined when it was not JSON), or undefined. */
export async function dispatch(event, input, context) {
  for (const [field, pattern, hook] of ROUTES[event] ?? []) {
    const value = input?.[field];
    if (pattern && typeof value === "string" && !pattern.test(value)) continue;
    return hook(input, context);
  }
  return undefined;
}
