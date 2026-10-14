import { createStateTool, REVIEW_ROLES } from "sage-core";
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


/** Recovery and completion must use the same immutable preparation and current target. */
export function checkPreparedRunAssignment(options, assigned, prepared) {
  const refuse = () => { throw Error("Sage could not verify this assignment target."); };
  if (!prepared || assigned.preparation !== prepared.id
    || ["project", "session", "epoch", "issuer", "task", "run"].some(key => assigned.assignment[key] !== prepared[key])
    || assigned.rolePlan.role !== prepared.rolePlan.role) refuse();
  const current = checkNativeRunAssignment(options, { ...assigned.assignment, role: prepared.rolePlan.role }, prepared.runTarget);
  if (REVIEW_ROLES.includes(prepared.rolePlan.role)) {
    if (!prepared.review) refuse();
    const tool = createStateTool({ defaultRoot: refuse });
    const review = tool.captureReviewTarget({ project: options.projectDirectory, task: prepared.task, run: prepared.run,
      role: prepared.rolePlan.role, cycle: prepared.review.cycle }, { ...process.env, SAGE_HOME: options.logbookRoot });
    if (JSON.stringify(review) !== JSON.stringify(prepared.review)) refuse();
  }
  return current;
}
