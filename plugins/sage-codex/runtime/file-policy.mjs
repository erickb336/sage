import { chiefEditDenied, shellWriteOutsideRoots } from "../core/index.mjs";

/** This is one policy check, not a complete tool policy. Mode and chief identity must be verified by the caller. */
export function directEditDecision(input, context) {
  if (input.tool_name !== "apply_patch") return { decision: "pass" };
  return chiefEditDenied(context)
    ? { decision: "deny", reason: "Sage mode is on. The chief must give file changes to an implementer." }
    : { decision: "pass" };
}

/** The caller supplies verified command text and execution cwd. Other command/role rules still apply. */
export function shellPathDecision(command, { cwd, roots }) {
  return shellWriteOutsideRoots({ command, cwd, roots }) ? { decision: "pass" }
    : { decision: "deny", reason: "This write command reaches a protected path or has unresolved path evidence. Use literal paths outside the logbook." };
}
