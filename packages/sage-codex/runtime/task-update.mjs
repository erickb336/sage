import { chiefLogbook } from "./logbook-owner.mjs";

export function readNativeTask(input, context, options) {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== 1
    || !Object.hasOwn(input, "task")) throw Error("Invalid task read");
  const { tool, project, env } = chiefLogbook(context, options);
  return tool.readTaskSnapshot({ ...input, project }, env);
}

/** An authenticated root changes metadata through shared rules. This tool cannot record a merge. */
export function updateNativeTask(input, context, options) {
  const fields = ["request", "task", "version", "changes"];
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== fields.length
    || fields.some(key => !Object.hasOwn(input, key)) || input.changes?.state === "merged") throw Error("Invalid task update");
  const { tool, project, owner, env } = chiefLogbook(context, options);
  return tool.updateRequestedTask({ ...input, project, owner }, env);
}
