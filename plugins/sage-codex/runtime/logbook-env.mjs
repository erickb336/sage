import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Each provider's legacy logbook root, for the core's resolver. This function is the one place where this adapter names
 * another provider's logbook setting (see AGENTS.md). An explicit SAGE_HOME stands for both, so a scratch run stays apart
 * from the real roots.
 */
export const legacyRoots = (env) => (env.SAGE_HOME ? [env.SAGE_HOME] : [
  { provider: "claude", path: join(env.CLAUDE_CONFIG_DIR ?? join(env.HOME ?? homedir(), ".claude"), "sage") },
  { provider: "codex", path: join(env.CODEX_HOME ?? join(env.HOME ?? homedir(), ".codex"), "sage") },
]);

/** The claim that a Codex chief can make: the server's tool, because the sandbox keeps the logbook closed to its shell. */
export const claimStep = (task, version) => `call the claim tool with this task and version ${version}`;
/** The same for a replace gate. */
export const replaceStep = (task, chief) => `call the gate_replace tool with this task and to ${chief}`;
