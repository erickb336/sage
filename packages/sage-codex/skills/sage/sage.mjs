#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createStateTool } from "sage-core";
import { createCaptureDiagnostics } from "../../hooks/capture-diagnostics.mjs";
import { verifyInstall } from "./verify-install.mjs";

// Codex inherits the selected model. Its logbook is separate unless SAGE_HOME is explicit.
const base = createStateTool({ usageInterfaces: [
  { provider: "codex", interface: "collaboration-tools", capability: "unavailable", reason: "The collaboration tools expose no authoritative per-run token count.", source: "Codex collaboration tool schema; chief-declared execution interface, not host attestation" },
  { provider: "codex", interface: "app-server", capability: "measured", reason: "The app-server protocol exposes thread and turn token usage events.", source: "Codex app-server thread/tokenUsage/updated" },
], defaultRoot: (env) => join(env.CODEX_HOME ?? join(homedir(), ".codex"), "sage") });
export const diagnostics = createCaptureDiagnostics(base);
export const tool = { ...base, command(argv, env = process.env) {
  const pruned = diagnostics.prune(env);
  const result = base.command(argv, env);
  const project = base.roleReadProject(argv);
  if (!result.code && project && /^T[1-9]\d*$/.test(argv[1] ?? "") && ["task", "board"].includes(argv[0]) && !env.SAGE_BOARD_ROOTS) {
    result.text += `\ncapture diagnostics ${JSON.stringify(diagnostics.read(project, argv[1], env, pruned))}`;
  }
  if (!result.code && argv[0] === "run" && argv[1] === "done") {
    const option = argv.find(a => a.startsWith("--project="));
    const selected = option?.slice(10) ?? argv[argv.indexOf("--project") + 1];
    if (selected) diagnostics.complete(selected, argv[2], env);
  }
  return result;
}, runCli(argv = process.argv.slice(2)) {
  const result = tool.command(argv);
  (result.code ? console.error : console.log)(result.text);
  process.exitCode = result.code;
} };
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
