import { chiefLogbook } from "./logbook-owner.mjs";

export function readNativeTask(input, context, options) {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== 1
    || !Object.hasOwn(input, "task")) throw Error("Invalid task read");
  const { tool, project, env } = chiefLogbook(context, options);
  return tool.readTaskSnapshot({ ...input, project }, env);
}

