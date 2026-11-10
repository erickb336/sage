#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { balancedModels, createStateTool, readModeFile } from "../../core/index.mjs";
import { modeDirectory, readState, stateKey } from "../../hooks/hook-state.mjs";
import { claimStep, legacyRoots, replaceStep } from "../../runtime/logbook-env.mjs";
import { verifyInstall } from "./verify-install.mjs";
import { hooksCommand } from "../../hooks/entries.mjs";

/** The mode file of the session's root thread. */
export const modeFile = (session, env) => join(modeDirectory(env), `${stateKey({ session_id: session })}.json`);
/**
 * The mode of the session's root thread: { sage, autopilot }. The mode hook keeps it in one file for each thread, with
 * the core reader: no file is no mode, and a damaged file is off. Autopilot counts only in sage mode. The gate's merge
 * rule and the state tool's extra repair round (T804) read it here.
 */
export function readMode({ session }, env = process.env) {
  const { state } = readModeFile(readState, modeFile(session, env));
  const sage = state.sage === true;
  return { sage, autopilot: sage && state.autopilot === true };
}

/**
 * The reasoning effort of a Codex agent for each model name of the model keys (T955). The keys are Claude's, with Claude's
 * names, so that one config reads the same in both providers. Codex keeps the session's model and gets only an effort.
 * A name with no effort here (fable, inherit) passes none: the agent keeps the session's effort.
 */
export const EFFORTS = { opus: "high", sonnet: "medium", haiku: "low" };
// A project without a shared logbook keeps its own, unless SAGE_HOME is explicit.
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
  // Imports from stdin or virtual entry points have no filesystem entry path.
}
if (entryPath === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === "verify-install") {
    try {
      const result = verifyInstall(process.argv.slice(2), tool.projectRoot);
      console.log(JSON.stringify(result, null, 2));
      process.exitCode = result.result === "match" ? 0 : 1;
    } catch (error) { console.error(`sage: ${error.message}`); process.exitCode = 1; }
  } else if (process.argv[2] === "hooks") {
    // sage's entries in the user's Codex hooks.json and the launcher (T957): install, uninstall or status.
    const { code, text } = hooksCommand(process.argv.slice(3));
    (code ? console.error : console.log)(text);
    process.exitCode = code;
  } else tool.runCli();
}
