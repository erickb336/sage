#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { balancedModels, createStateTool, readModeFile } from "sage-core";
import { modeDirectory, readState, stateKey } from "../../hooks/hook-state.mjs";
import { claimStep, legacyRoots, replaceStep } from "../../runtime/logbook-env.mjs";
import { verifyInstall } from "./verify-install.mjs";
import { hooksCommand } from "../../hooks/entries.mjs";

export const modeFile = (session, env) => join(modeDirectory(env), `${stateKey({ session_id: session })}.json`);
export function readMode({ session }, env = process.env) {
  const { state } = readModeFile(readState, modeFile(session, env));
  const sage = state.sage === true;
  return { sage, autopilot: sage && state.autopilot === true };
}

export const EFFORTS = { opus: "high", sonnet: "medium", haiku: "low" };
export const tool = createStateTool({ provider: "codex", claimStep, replaceStep, legacyRoots, autopilot: (session, env) => readMode({ session }, env).autopilot,
  models: ["opus", "sonnet", "haiku", "fable", "inherit"], modelDefaults: balancedModels("opus", "sonnet"),
  spawnFields: (model) => (Object.hasOwn(EFFORTS, model) ? { reasoning_effort: EFFORTS[model] } : {}), usageInterfaces: [
  { provider: "codex", interface: "collaboration-tools", capability: "unavailable", reason: "The collaboration tools expose no authoritative per-run token count; the report gate reads the agent's own count from its session record at its stop, when the record has one.", source: "Codex collaboration tool schema; chief-declared execution interface, not host attestation" },
  { provider: "codex", interface: "app-server", capability: "measured", reason: "The app-server protocol exposes thread and turn token usage events.", source: "Codex app-server thread/tokenUsage/updated" },
], defaultRoot: (env) => join(env.CODEX_HOME ?? join(env.HOME ?? homedir(), ".codex"), "sage") });
let entryPath;
try {
  if (process.argv[1]) entryPath = realpathSync(process.argv[1]);
} catch {
}
if (entryPath === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === "verify-install") {
    try {
      const result = verifyInstall(process.argv.slice(2), tool.projectRoot);
      console.log(JSON.stringify(result, null, 2));
      process.exitCode = result.result === "match" ? 0 : 1;
    } catch (error) { console.error(`sage: ${error.message}`); process.exitCode = 1; }
  } else if (process.argv[2] === "hooks") {
    const { code, text } = hooksCommand(process.argv.slice(3));
    (code ? console.error : console.log)(text);
    process.exitCode = code;
  } else tool.runCli();
}
