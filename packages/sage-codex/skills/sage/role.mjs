#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderReportInstructions, renderRoleInstructions, ROLE_PRINCIPLES } from "sage-core";

const approvalRoles = new Set(["implementer", "designer", "arena-judge", "lead"]);

export function roleMessage(role) {
  const bindings = JSON.parse(readFileSync(new URL("../../role-bindings.json", import.meta.url), "utf8"));
  const instructions = renderRoleInstructions(role, { ...bindings.common, ...bindings[role] });
  return `${instructions}${role === "lead" ? leadSteps() : ""}${principles(role)}\n\n${reference(approvalRoles.has(role) ? "approvals.md" : "sandbox-refusal.md")}\n\n${renderReportInstructions(bindings.report)}\n`;
}

const reference = (name) => readFileSync(new URL(`references/${name}`, import.meta.url), "utf8").trim();
const principleFile = (name) => new URL(`../principle-${name}/SKILL.md`, import.meta.url);

function principles(role) {
  const names = ROLE_PRINCIPLES[role] ?? [];
  if (!names.length) return "";
  if (role === "lead") return `\n\nThe principles of your role: read ${names.map((name) => `\`${fileURLToPath(principleFile(name))}\``).join(" and ")} before you start.`;
  const text = (name) => readFileSync(principleFile(name), "utf8").replace(/^---\n[\s\S]*?\n---\n/, "").replace(/<!--[\s\S]*?-->/, "").trim().replace(/^# /, "## ");
  return `\n\n# The principles of your role\n\n${names.map(text).join("\n\n")}`;
}

const leadSteps = () => `\n\n${reference("lead-steps.md").replaceAll("<node>", process.execPath).replaceAll("<role.mjs>", fileURLToPath(import.meta.url))
  .replaceAll("<ci-wait.mjs>", fileURLToPath(new URL("ci-wait.mjs", import.meta.url)))}`;

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try { process.stdout.write(roleMessage(process.argv[2])); } catch (error) {
    console.error(`sage: ${error.message}. Give one role from references/roles.md.`);
    process.exit(1);
  }
}
