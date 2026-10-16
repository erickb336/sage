import { createStateTool, REVIEW_ROLES, readAdmission } from "sage-core";
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
  checkPreparationIssuer(options, prepared);
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

/** Nested authority belongs to the issuing assignment, never the actor's latest work. */
export function checkPreparationIssuer(options, prepared, expectedAssignment) {
  const refuse = () => { throw Error("Sage could not verify the original issuing lead assignment."); };
  if (!prepared) refuse();
  if (prepared.rolePlan.issuerRole === "chief-of-staff") {
    if (prepared.issuerAssignment || expectedAssignment || prepared.session !== `codex:${prepared.issuer}`) refuse();
    return;
  }
  if (prepared.rolePlan.issuerRole !== "lead" || !prepared.issuerAssignment
    || (expectedAssignment && expectedAssignment !== prepared.issuerAssignment)) refuse();
  const state = readAdmission(options.directory);
  const parents = state.bindings.filter(row => row.assignment === prepared.issuerAssignment
    && row.child === prepared.issuer && ["project", "session", "epoch"].every(key => row[key] === prepared[key]));
  const parent = state.reservations.find(row => row.assignment.id === prepared.issuerAssignment);
  const target = state.preparations.find(row => row.id === parent?.preparation);
  if (parents.length !== 1 || !parent || !target || parent.rolePlan?.role !== "lead"
    || parent.rolePlan.issuerRole !== "chief-of-staff" || parent.assignment.task !== prepared.task
    || state.completions?.some(row => row.assignment === prepared.issuerAssignment)
    || state.failures?.some(row => row.assignment === prepared.issuerAssignment)) refuse();
  checkPreparedRunAssignment(options, parent, target);
}

export function checkBoundRunAssignment(options, assignment, target) {
  const state = readAdmission(options.directory);
  const assigned = state.reservations.find(row => row.assignment.id === assignment.id);
  const prepared = state.preparations.find(row => row.id === assigned?.preparation);
  checkPreparationIssuer(options, prepared);
  return checkNativeRunAssignment(options, assignment, target);
}
