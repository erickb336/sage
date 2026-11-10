#!/usr/bin/env node
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createStateTool } from "../../core/index.mjs";

/**
 * Each provider's legacy logbook root, with its provider's name, for the core's resolver and the move. This function is
 * the one place where this adapter names another provider's logbook setting (see AGENTS.md). An explicit SAGE_HOME stands
 * for both, so a scratch run stays apart from the real roots: it is this tool's own root.
 */
const legacyRoots = (env) => (env.SAGE_HOME ? [env.SAGE_HOME] : [
  { provider: "claude", path: join(env.CLAUDE_CONFIG_DIR ?? join(env.HOME ?? homedir(), ".claude"), "sage") },
  { provider: "codex", path: join(env.CODEX_HOME ?? join(env.HOME ?? homedir(), ".codex"), "sage") },
]);
const defaultRoot = (env) => join(env.CLAUDE_CONFIG_DIR ?? join(env.HOME ?? homedir(), ".claude"), "sage");
/**
 * Is autopilot on for a Claude session? The sage hook keeps it in the session's state file, which the merge rule reads
 * (sage-hook.mjs: stateDir and safe). Only a regular file with one link and at most 1 MB counts; any doubt is off (T804).
 */
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
  modelDefaults: {
    arena_models: "opus,sonnet,sonnet",
    ...Object.fromEntries(["pe", "designer", "implementer", "code-reviewer", "security-reviewer", "ux-reviewer", "qa", "arena-judge"].map(role => [`model.${role}`, role === "ux-reviewer" ? "sonnet" : "opus"])),
    "model.implementer.tiny": "sonnet", "model.code-reviewer.tiny": "sonnet",
    "model.qa.tiny": "sonnet", "model.qa.small": "sonnet",
  },
  // The owner's Q2 of T656: a task that Claude takes from another provider's chief merges after one Claude cycle of its own.
  takeoverCycle: () => "run one cycle of its reviews and QA on this SHA, record each verdict, then merge with gh pr merge",
});
export const { SIZES, BLOCKS, RISKS, KINDS, STATES, DEFAULTS, PR, sageRoot, locate, chiefFor, sessionBar, branchBar, actorOptions, git, projectRoot, optionsOf, slug, worktreeRoot, BRANCH, ofTask, branchOfTask, branchTip, projectName, storeDir, config, cyclesFor, modelFor, read, mergeCheck, logbookView, sage, withLock, board, answerPaths, keepReport } = tool;
if (process.argv[1] === fileURLToPath(import.meta.url)) tool.runCli();
