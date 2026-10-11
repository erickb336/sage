import { createStateTool } from "sage-core";
import { validateLogbookLocation } from "./run-report.mjs";

/** Fixed launcher storage and a verified binding identify the current logbook run. */
export function captureNativeRunAssignment(options, input) {
  validateLogbookLocation(options);
  const tool = createStateTool({ defaultRoot: () => { throw Error("Sage needs its configured logbook."); } });
  return tool.captureRunAssignment({ project: options.projectDirectory, task: input.task, run: input.run,
    role: input.role }, { ...process.env, SAGE_HOME: options.logbookRoot });
}
