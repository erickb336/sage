import { createStateTool } from "../core/index.mjs";
import { validateLogbookLocation } from "./run-report.mjs";

/** Fixed launcher storage and a verified binding identify the current logbook run. */
export function captureNativeRunAssignment(options, input) {
  validateLogbookLocation(options);
  const tool = createStateTool({ defaultRoot: () => { throw Error("Sage needs its configured logbook."); } });
  return tool.captureRunAssignment({ project: options.projectDirectory, task: input.task, run: input.run,
    role: input.role }, { ...process.env, SAGE_HOME: options.logbookRoot });
}

/** Old preparations remain readable but cannot authorize tools without a saved target. */
export function checkNativeRunAssignment(options, input, target) {
  const current = captureNativeRunAssignment(options, input);
  if (!target || JSON.stringify(current) !== JSON.stringify(target))
    throw Error("Sage could not evaluate this operation: the saved run target changed. Record a new run and brief.");
  return current;
}
