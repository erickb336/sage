import { createStateTool, readAdmission } from "sage-core";
import { nativeToolContext } from "./native-tool.mjs";
import { validateLogbookLocation } from "./run-report.mjs";

/** Fixed configuration and the native root connection select the logbook and owner scope. */
export function chiefLogbook(context, options) {
  const native = nativeToolContext(context);
  validateLogbookLocation(options);
  const state = readAdmission(options.directory);
  const owner = state.sessions.find(row => row.project === options.project && row.session === `codex:${native.actor}`);
  if (!owner) throw Error("Logbook changes need the current root owner");
  const tool = createStateTool({ defaultRoot: () => { throw Error("No ambient logbook"); } });
  return { tool, project: options.projectDirectory, owner: JSON.stringify([owner.project, owner.session, owner.epoch]),
    env: { ...process.env, SAGE_HOME: options.logbookRoot } };
}
