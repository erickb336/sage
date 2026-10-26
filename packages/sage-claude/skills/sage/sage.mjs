#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createStateTool } from "sage-core";

const tool = createStateTool({
  defaultRoot: (env) => join(env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "sage"),
  models: ["opus", "sonnet", "haiku", "fable", "inherit"],
  modelDefaults: {
    arena_models: "opus,sonnet,sonnet",
    ...Object.fromEntries(["pe", "designer", "implementer", "code-reviewer", "security-reviewer", "ux-reviewer", "qa", "arena-judge"].map(role => [`model.${role}`, role === "ux-reviewer" ? "sonnet" : "opus"])),
    "model.implementer.tiny": "sonnet", "model.code-reviewer.tiny": "sonnet",
    "model.qa.tiny": "sonnet", "model.qa.small": "sonnet",
  },
});
export const { SIZES, BLOCKS, RISKS, KINDS, STATES, DEFAULTS, PR, sageRoot, git, projectRoot, optionsOf, slug, worktreeRoot, BRANCH, ofTask, projectName, storeDir, config, cyclesFor, modelFor, read, mergeCheck, logbookView, sage, withLock, board, answerPaths, keepReport, verdictBacking } = tool;
if (process.argv[1] === fileURLToPath(import.meta.url)) tool.runCli();
