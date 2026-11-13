#!/usr/bin/env node
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { balancedModels, createStateTool } from "sage-core";

const legacyRoots = (env) => (env.SAGE_HOME ? [env.SAGE_HOME] : [
  { provider: "claude", path: join(env.CLAUDE_CONFIG_DIR ?? join(env.HOME ?? homedir(), ".claude"), "sage") },
  { provider: "codex", path: join(env.CODEX_HOME ?? join(env.HOME ?? homedir(), ".codex"), "sage") },
]);
const defaultRoot = (env) => join(env.CLAUDE_CONFIG_DIR ?? join(env.HOME ?? homedir(), ".claude"), "sage");
function autopilot(session, env) {
  const file = join(env.SAGE_HOOKS_STATE ?? join(env.SAGE_HOME ?? defaultRoot(env), ".hooks"), `${String(session).replace(/[^\w.-]/g, "_").slice(0, 128)}.json`);
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0));
    const stat = fstatSync(fd);
    return stat.isFile() && stat.nlink === 1 && stat.size <= 1 << 20 && JSON.parse(readFileSync(fd, "utf8"))?.autopilot === true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
const tool = createStateTool({
  provider: "claude",
  defaultRoot,
  autopilot,
  legacyRoots,
  models: ["opus", "sonnet", "haiku", "fable", "inherit"],
  modelDefaults: { arena_models: "opus,sonnet,sonnet", ...balancedModels("opus", "sonnet") },
  takeoverCycle: () => "run one cycle of its reviews and QA on this SHA, record each verdict, then merge with gh pr merge",
});
export const { SIZES, BLOCKS, RISKS, KINDS, STATES, DEFAULTS, PR, sageRoot, locate, chiefFor, sessionBar, branchBar, actorOptions, git, projectRoot, optionsOf, slug, worktreeRoot, pagesRoot, BRANCH, ofTask, branchOfTask, branchTip, projectName, storeDir, config, cyclesFor, modelFor, read, mergeCheck, logbookView, sage, withLock, keepReport } = tool;
if (process.argv[1] === fileURLToPath(import.meta.url)) tool.runCli();
export const { leadProblem, leadRequest } = tool;
