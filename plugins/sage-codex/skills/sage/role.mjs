#!/usr/bin/env node
// Prints the text that goes at the top of a role agent's spawn message: the role text, the principles of the role (from
// core's ROLE_PRINCIPLES) and the sage report.
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderReportInstructions, renderRoleInstructions, ROLE_PRINCIPLES } from "../../core/index.mjs";

// These two roles belong to the Codex skill-led path; core has no role text for them.
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
  return `${instructions}${role === "lead" ? leadSteps() : ""}${principles(role)}\n\n${reference(approvalRoles.has(role) ? "approvals.md" : "sandbox-refusal.md")}\n\n${renderReportInstructions(bindings.report)}\n`;
}

const reference = (name) => readFileSync(new URL(`references/${name}`, import.meta.url), "utf8").trim();
const principleFile = (name) => new URL(`../principle-${name}/SKILL.md`, import.meta.url);

/**
 * The principles of the role. A helper gets their text; the lead, whose text is long, gets the path of each one to read.
 * The text is the skill without its frontmatter and its generated-file note, with its title one level down.
 */
function principles(role) {
  const names = ROLE_PRINCIPLES[role] ?? [];
  if (!names.length) return "";
  if (role === "lead") return `\n\nThe principles of your role: read ${names.map((name) => `\`${fileURLToPath(principleFile(name))}\``).join(" and ")} before you start.`;
  const text = (name) => readFileSync(principleFile(name), "utf8").replace(/^---\n[\s\S]*?\n---\n/, "").replace(/<!--[\s\S]*?-->/, "").trim().replace(/^# /, "## ");
  return `\n\n# The principles of your role\n\n${names.map(text).join("\n\n")}`;
}

/** The shared lead text names no tool, so Codex adds its own dispatch steps, with the real path of this script for each helper's role text. */
const leadSteps = () => `\n\n${reference("lead-steps.md").replaceAll("<node>", process.execPath).replaceAll("<role.mjs>", fileURLToPath(import.meta.url))}`;

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try { process.stdout.write(roleMessage(process.argv[2])); } catch (error) {
    console.error(`sage: ${error.message}. Give one role from references/roles.md.`);
    process.exit(1);
  }
}
