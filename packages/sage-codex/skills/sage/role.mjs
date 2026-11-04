#!/usr/bin/env node
// Prints the text that goes at the top of a role agent's spawn message: the role text and the sage report.
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderReportInstructions, renderRoleInstructions } from "sage-core";

// These two roles belong to the Codex skill-led path, not protected native admission.
const localRoles = new Map([
  ["investigate", "references/investigate.md"],
  ["evidence-review", "references/evidence-review.md"],
]);

// These roles write git or reach the network, so Codex's default sandbox asks the owner each time.
// Every other role only runs checks and reads, and gets the short text.
const approvalRoles = new Set(["implementer", "designer", "arena-judge", "lead"]);

export function roleMessage(role) {
  const bindings = JSON.parse(readFileSync(new URL("../../role-bindings.json", import.meta.url), "utf8"));
  const local = localRoles.get(role);
  const instructions = local ? readFileSync(new URL(local, import.meta.url), "utf8").trim()
    : renderRoleInstructions(role, { ...bindings.common, ...bindings[role] });
  return `${instructions}${role === "lead" ? leadSteps() : ""}\n\n${reference(approvalRoles.has(role) ? "approvals.md" : "sandbox-refusal.md")}\n\n${renderReportInstructions(bindings.report)}\n`;
}

const reference = (name) => readFileSync(new URL(`references/${name}`, import.meta.url), "utf8").trim();

/** The shared lead text names no tool, so Codex adds its own dispatch steps, with the real path of this script for each helper's role text. */
const leadSteps = () => `\n\n${reference("lead-steps.md").replaceAll("<node>", process.execPath).replaceAll("<role.mjs>", fileURLToPath(import.meta.url))}`;

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try { process.stdout.write(roleMessage(process.argv[2])); } catch (error) {
    console.error(`sage: ${error.message}. Give one role from references/roles.md.`);
    process.exit(1);
  }
}
