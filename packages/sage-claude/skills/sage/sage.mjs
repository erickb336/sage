#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createStateTool } from "sage-core";

/**
 * Each provider's legacy logbook root, with its provider's name, for the core's resolver and the move. This function is
 * the one place where this adapter names another provider's logbook setting (see AGENTS.md). An explicit SAGE_HOME stands
 * for both, so a scratch run stays apart from the real roots: it is this tool's own root.
 */
const legacyRoots = (env) => (env.SAGE_HOME ? [env.SAGE_HOME] : [
  { provider: "claude", path: join(env.CLAUDE_CONFIG_DIR ?? join(env.HOME ?? homedir(), ".claude"), "sage") },
  { provider: "codex", path: join(env.CODEX_HOME ?? join(env.HOME ?? homedir(), ".codex"), "sage") },
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
  // The owner's Q2 of T656: a task that Claude takes from another provider's chief merges after one Claude cycle of its own, on a review copy.
  takeoverCycle: (task) => `run sage-pr import ${task}, run one cycle of its reviews and QA on that review copy, record each verdict, then merge with sage-pr merge ${task}`,
});
export const { SIZES, BLOCKS, RISKS, KINDS, STATES, DEFAULTS, PR, sageRoot, locate, chiefFor, sessionBar, branchBar, actorOptions, git, projectRoot, optionsOf, slug, worktreeRoot, BRANCH, ofTask, branchOfTask, branchHome, branchTip, projectName, storeDir, config, cyclesFor, modelFor, read, mergeCheck, landingBar, logbookView, sage, withLock, board, answerPaths, keepReport, takenRows } = tool;
if (process.argv[1] === fileURLToPath(import.meta.url)) tool.runCli();
