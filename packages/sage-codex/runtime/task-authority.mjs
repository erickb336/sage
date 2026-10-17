import { assertTaskAdmissionOpen, createStateTool, readAdmission } from "sage-core";
import { validateLogbookLocation } from "./run-report.mjs";

/** A publication transaction fences managed work even when ordinary Sage policy is off. */
export function assertNativeTaskOpen(options, task, preparation) {
  validateLogbookLocation(options);
  const tool = createStateTool({ defaultRoot: () => { throw Error("No ambient logbook"); } });
  tool.assertTaskUpdateOpen({ project: options.projectDirectory, task }, { ...process.env, SAGE_HOME: options.logbookRoot });
  return assertTaskAdmissionOpen(options.directory, options.project, task, preparation);
}

export function checkManagedTaskUpdate(event, native, options) {
  if (native.actor === event.session_id) return;
  const state = readAdmission(options.directory);
  const bindings = state.bindings.filter(row => row.project === options.project && row.session === `codex:${event.session_id}`
    && row.child === native.actor && row.turn === event.turn_id);
  if (!bindings.length) return;
  if (bindings.length !== 1) throw Error("Managed task identity is ambiguous");
  const assigned = state.reservations.find(row => row.assignment.id === bindings[0].assignment);
  if (!assigned) throw Error("Managed task reservation is missing");
  assertNativeTaskOpen(options, assigned.assignment.task, assigned.preparation);
}
