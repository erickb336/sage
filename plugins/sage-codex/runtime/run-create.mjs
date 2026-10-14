import { chiefLogbook } from "./logbook-owner.mjs";

/** Record a chief's run request. Preparation and native admission remain separate. */
export function createNativeRun(input, context, options) {
  const fields = ["request", "task", "role", "branch", "candidate"];
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== fields.length
    || fields.some(key => !Object.hasOwn(input, key))) throw Error("Invalid run request");
  const { tool, project, owner, env } = chiefLogbook(context, options);
  return tool.createRequestedRun({ ...input, project, owner }, env);
}
