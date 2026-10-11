import { patchTargets } from "./patch-targets.mjs";
import { chiefEditDenied, fileWriteOutsideRoots } from "sage-core";
export { commandWrites } from "sage-core";

/** This is one policy check, not a complete tool policy. Mode and chief identity must be verified by the caller. */
export function directEditDecision(input, context) {
  if (input.tool_name !== "apply_patch") return { decision: "pass" };
  return chiefEditDenied(context)
    ? { decision: "deny", reason: "Sage mode is on. The chief must give file changes to an implementer." }
    : { decision: "pass" };
}

/** Caller authenticates mode/role and fixes cwd/roots. This covers direct patches, not shell writes. */
export function patchEditDecision(input, context, { cwd, roots }) {
  const direct = directEditDecision(input, context);
  if (input.tool_name !== "apply_patch" || direct.decision === "deny") return direct;
  const value = input.tool_input;
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== 1 || !Object.hasOwn(value, "command")) throw Error("Codex patch input is unavailable");
  return fileWriteOutsideRoots({ paths: patchTargets(value.command), cwd, roots }) ? { decision: "pass" }
    : { decision: "deny", reason: "This patch reaches a protected path or a file with another hard link. Use the authorized state operation for logbook changes." };
}
