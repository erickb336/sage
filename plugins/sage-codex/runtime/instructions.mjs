import { readFileSync } from "node:fs";
import { renderRoleInstructions, renderReportInstructions, renderBrief } from "../core/index.mjs";
import { bindNativeChild } from "./child-binding.mjs";

function taskInstructions(roleName, brief, heading, review, runTarget) {
  const bindings = JSON.parse(readFileSync(new URL("../role-bindings.json", import.meta.url), "utf8"));
  const role = renderRoleInstructions(roleName, { ...bindings.common, ...bindings[roleName] });
  const report = renderReportInstructions(bindings.report);
  const run = runTarget ? `# Saved run target\n\nTask round: ${runTarget.round}\nTask branch: ${runTarget.taskBranch || "none"}\nRun branch: ${runTarget.runBranch || "none"}\nCandidate: ${runTarget.candidate || "none"}\n\nWork only on this saved target. A changed target needs a new run and brief.` : "";
  const target = review ? `# Review target\n\nBranch: ${review.branch}\nCommit: ${review.sha}\nTask round: ${review.round}\nReview cycle: ${review.cycle}\n\nReview this exact commit. Name it in the report. A changed branch needs a new review assignment.` : "";
  const reviewReport = review ? ["# Review report values",
    "For this review, these EVIDENCE and FINDINGS formats replace the general report values above. Use [] for empty FINDINGS; use none only for other empty fields.",
    `Use STATUS done only for a finished review. RESULT is ${roleName === "qa" ? "PASS or FAIL" : "CLEAN or FINDINGS"}.`,
    `Set BRANCH to ${review.branch} and QUESTIONS to none. If a question blocks the review, use STATUS question.`,
    `EVIDENCE must be a JSON object with exactly these fields: ${JSON.stringify({ commit: review.sha, round: review.round, cycle: review.cycle, summary: "Describe what you checked, with evidence references." })}`,
    'FINDINGS must be a JSON array. Each finding has exactly "severity" (low, medium, or high) and "summary" (the input, problem, and evidence). Use [] when there are no findings.',
    `A medium or high finding requires RESULT ${roleName === "qa" ? "FAIL" : "FINDINGS"}. Low findings alone allow a clean result, but each still needs triage.`,
    "Keep the other required report fields. These values state your findings; only the chief can accept the review."].join("\n\n") : "";
  return [heading, role, report, ...(run ? [run] : []), ...(target ? [target, reviewReport] : []), "# Task brief\n\n" + renderBrief(brief)].join("\n\n");
}

/** Render the saved preparation before dispatch; admission requires these exact bytes. */
export function preparedTaskMessage(preparation) {
  return taskInstructions(preparation.rolePlan.role, preparation.brief,
    `Role: ${preparation.rolePlan.role}\nPreparation: ${preparation.id}\nTask: ${preparation.task}\nRun: ${preparation.run}`, preparation.review, preparation.runTarget);
}

/** Deliver only the role and brief attached to this verified native child. */
export function boundChildInstructions(options, identity) {
  const result = bindNativeChild(options, identity);
  if (!result.brief) throw Error("The native child has no saved task brief");
  const assignment = result.assignment;
  return { decision: "deliver", brief: taskInstructions(result.role, result.brief,
    `Role: ${result.role}\nAssignment: ${assignment.id}\nTask: ${assignment.task}\nRun: ${assignment.run}`, result.review, result.runTarget) };
}
