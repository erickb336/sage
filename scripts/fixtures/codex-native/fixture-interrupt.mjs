// The native policy authenticates context.actor before it calls this fixture evaluator.
export function fixtureInterruptDecision(input, context, enabled) {
  if (input.tool_name !== "collaborationinterrupt_agent") return null;
  const args = input.tool_input;
  const permitted = enabled && typeof input.session_id === "string" && input.session_id.length > 0
    && context.actor === input.session_id && !Object.hasOwn(input, "agent_id")
    && args !== null && typeof args === "object" && !Array.isArray(args)
    && Object.keys(args).length === 1 && Object.hasOwn(args, "target")
    && args.target === "/root/probe_child";
  return permitted ? { decision: "pass" }
    : { decision: "deny", reason: "Outside the fixed interruption fixture." };
}

