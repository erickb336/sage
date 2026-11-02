#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createStateTool } from "../../core/index.mjs";
import { claimStep, legacyRoots, replaceStep } from "../../runtime/logbook-env.mjs";
import { verifyInstall } from "./verify-install.mjs";

// Codex inherits the selected model. A project without a shared logbook keeps its own, unless SAGE_HOME is explicit.
export const tool = createStateTool({ provider: "codex", claimStep, replaceStep, legacyRoots, usageInterfaces: [
  { provider: "codex", interface: "collaboration-tools", capability: "unavailable", reason: "The collaboration tools expose no authoritative per-run token count.", source: "Codex collaboration tool schema; chief-declared execution interface, not host attestation" },
  { provider: "codex", interface: "app-server", capability: "measured", reason: "The app-server protocol exposes thread and turn token usage events.", source: "Codex app-server thread/tokenUsage/updated" },
], defaultRoot: (env) => join(env.CODEX_HOME ?? join(env.HOME ?? homedir(), ".codex"), "sage") });
let entryPath;
try {
  if (process.argv[1]) entryPath = realpathSync(process.argv[1]);
} catch {
  // Imports from stdin or virtual entry points have no filesystem entry path.
}
if (entryPath === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === "verify-install") {
    try {
      const result = verifyInstall(process.argv.slice(2), tool.projectRoot);
      console.log(JSON.stringify(result, null, 2));
      process.exitCode = result.result === "match" ? 0 : 1;
    } catch (error) { console.error(`sage: ${error.message}`); process.exitCode = 1; }
  } else tool.runCli();
}
