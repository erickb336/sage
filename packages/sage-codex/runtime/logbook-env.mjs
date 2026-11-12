import { homedir } from "node:os";
import { join } from "node:path";

export const legacyRoots = (env) => (env.SAGE_HOME ? [env.SAGE_HOME] : [
  { provider: "claude", path: join(env.CLAUDE_CONFIG_DIR ?? join(env.HOME ?? homedir(), ".claude"), "sage") },
  { provider: "codex", path: join(env.CODEX_HOME ?? join(env.HOME ?? homedir(), ".codex"), "sage") },
]);

export const claimStep = (task, version) => `call the claim tool with this task and version ${version}`;
export const replaceStep = (task, chief) => `call the gate_replace tool with this task and to ${chief}`;
