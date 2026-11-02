#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createStateTool } from "../../core/index.mjs";

/**
 * Each provider's legacy logbook root, for the core's resolver. This function is the one place where this adapter names
 * another provider's logbook setting (see AGENTS.md). An explicit SAGE_HOME stands for both, so a scratch run stays apart
 * from the real roots.
 */
const legacyRoots = (env) => (env.SAGE_HOME ? [env.SAGE_HOME] : [
  join(env.CLAUDE_CONFIG_DIR ?? join(env.HOME ?? homedir(), ".claude"), "sage"),
  join(env.CODEX_HOME ?? join(env.HOME ?? homedir(), ".codex"), "sage"),
]);
const tool = createStateTool({
  provider: "claude",
  defaultRoot: (env) => join(env.CLAUDE_CONFIG_DIR ?? join(env.HOME ?? homedir(), ".claude"), "sage"),
  legacyRoots,
  models: ["opus", "sonnet", "haiku", "fable", "inherit"],
  modelDefaults: {
    arena_models: "opus,sonnet,sonnet",
    ...Object.fromEntries(["pe", "designer", "implementer", "code-reviewer", "security-reviewer", "ux-reviewer", "qa", "arena-judge"].map(role => [`model.${role}`, role === "ux-reviewer" ? "sonnet" : "opus"])),
    "model.implementer.tiny": "sonnet", "model.code-reviewer.tiny": "sonnet",
    "model.qa.tiny": "sonnet", "model.qa.small": "sonnet",
  },
});
export const { SIZES, BLOCKS, RISKS, KINDS, STATES, DEFAULTS, PR, sageRoot, locate, chiefFor, sessionBar, actorOptions, git, projectRoot, optionsOf, slug, worktreeRoot, BRANCH, ofTask, branchOfTask, projectName, storeDir, config, cyclesFor, modelFor, read, mergeCheck, landingBar, logbookView, sage, withLock, board, answerPaths, keepReport, verdictBacking } = tool;
if (process.argv[1] === fileURLToPath(import.meta.url)) tool.runCli();
