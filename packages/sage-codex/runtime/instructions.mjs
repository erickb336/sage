import { readFileSync } from "node:fs";
import { renderRoleInstructions, renderReportInstructions, renderBrief } from "sage-core";
import { bindNativeChild } from "./child-binding.mjs";

function taskInstructions(roleName, brief, heading) {
  const bindings = JSON.parse(readFileSync(new URL("../role-bindings.json", import.meta.url), "utf8"));
  const role = renderRoleInstructions(roleName, { ...bindings.common, ...bindings[roleName] });
  const report = renderReportInstructions(bindings.report);
  return [heading, role, report, "# Task brief\n\n" + renderBrief(brief)].join("\n\n");
}

/** Render the saved preparation before dispatch; admission requires these exact bytes. */
export function preparedTaskMessage(preparation) {
  return taskInstructions(preparation.rolePlan.role, preparation.brief,
    `Role: ${preparation.rolePlan.role}\nPreparation: ${preparation.id}\nTask: ${preparation.task}\nRun: ${preparation.run}`);
}

/** Deliver only the role and brief attached to this verified native child. */
export function boundChildInstructions(options, identity) {
  const result = bindNativeChild(options, identity);
  if (!result.brief) throw Error("The native child has no saved task brief");
  const assignment = result.assignment;
  return { decision: "deliver", brief: taskInstructions(result.role, result.brief,
    `Role: ${result.role}\nAssignment: ${assignment.id}\nTask: ${assignment.task}\nRun: ${assignment.run}`) };
}
