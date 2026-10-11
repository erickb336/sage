import { createStateTool, readAdmission } from "../core/index.mjs";
import { nativeToolContext } from "./native-tool.mjs";
import { validateLogbookLocation } from "./run-report.mjs";

/** Record a chief's request in the fixed logbook. This grants no dispatch or merge permission. */
export function createNativeTask(input, context, options) {
  const fields = ["request", "title", "size", "risk", "add", "why"];
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== fields.length
    || fields.some(key => !Object.hasOwn(input, key))) throw Error("Invalid task request");
  const native = nativeToolContext(context);
  validateLogbookLocation(options);
  const state = readAdmission(options.directory);
  const owner = state.sessions.find(row => row.project === options.project && row.session === `codex:${native.actor}`);
  if (!owner) throw Error("Task creation needs the current root owner");
  const tool = createStateTool({ defaultRoot: () => { throw Error("No ambient logbook"); } });
  return tool.createRequestedTask({ ...input, project: options.projectDirectory,
    owner: JSON.stringify([owner.project, owner.session, owner.epoch]) }, { ...process.env, SAGE_HOME: options.logbookRoot });
}
