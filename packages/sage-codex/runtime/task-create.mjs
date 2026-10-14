import { chiefLogbook } from "./logbook-owner.mjs";

/** Record a chief's request in the fixed logbook. This grants no dispatch or merge permission. */
export function createNativeTask(input, context, options) {
  const fields = ["request", "title", "size", "risk", "add", "why"];
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== fields.length
    || fields.some(key => !Object.hasOwn(input, key))) throw Error("Invalid task request");
  const { tool, project, owner, env } = chiefLogbook(context, options);
  return tool.createRequestedTask({ ...input, project, owner }, env);
}
