#!/usr/bin/env node
// Prints the text that goes at the top of a role agent's spawn message: the role text and the sage report.
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderReportInstructions, renderRoleInstructions } from "../../core/index.mjs";

export function roleMessage(role) {
  const bindings = JSON.parse(readFileSync(new URL("../../role-bindings.json", import.meta.url), "utf8"));
  return `${renderRoleInstructions(role, { ...bindings.common, ...bindings[role] })}\n\n${renderReportInstructions(bindings.report)}\n`;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try { process.stdout.write(roleMessage(process.argv[2])); } catch (error) {
    console.error(`sage: ${error.message}. Give one role from references/roles.md.`);
    process.exit(1);
  }
}
