import { homedir } from "node:os";
import { join } from "node:path";
import { createStateTool, sharedRoot } from "../core/index.mjs";

/**
 * Each provider's legacy logbook root, for the core's resolver. This function is the one place where this adapter names
 * another provider's logbook setting (see AGENTS.md). An explicit SAGE_HOME stands for both, so a scratch run stays apart
 * from the real roots.
 */
export const legacyRoots = (env) => (env.SAGE_HOME ? [env.SAGE_HOME] : [
  join(env.CLAUDE_CONFIG_DIR ?? join(env.HOME ?? homedir(), ".claude"), "sage"),
  join(env.CODEX_HOME ?? join(env.HOME ?? homedir(), ".codex"), "sage"),
]);

/**
 * The environment of every logbook call of the runtime. The runtime sets SAGE_HOME to the launcher's logbookRoot, also in
 * production, so it fixes the shared root here, from the launcher's option or the server's own environment. Without this,
 * a real Codex run would use a shared root under the Codex root.
 */
export const logbookEnv = (options) => ({ ...process.env, SAGE_HOME: options.logbookRoot, SAGE_SHARED_HOME: sharedRoot(process.env, options.sharedRoot) });

/** The claim that a Codex chief can make: the server's tool, because the sandbox keeps the logbook closed to its shell. */
export const claimStep = (task, version) => `call the claim tool with this task and version ${version}`;
/** The same for a replace gate. */
export const replaceStep = (task, chief) => `call the gate_replace tool with this task and to ${chief}`;

/** A state tool with no ambient logbook. The call's env selects the logbook; the legacy roots come from the server's own environment. */
export const logbookTool = (defaultRoot) => createStateTool({ provider: "codex", claimStep, replaceStep, defaultRoot, legacyRoots: () => legacyRoots(process.env) });
