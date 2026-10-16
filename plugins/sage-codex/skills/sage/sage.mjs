#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createStateTool } from "../../core/index.mjs";

// Codex inherits the selected model. Its logbook is separate unless SAGE_HOME is explicit.
export const tool = createStateTool({ defaultRoot: (env) => join(env.CODEX_HOME ?? join(homedir(), ".codex"), "sage") });
let entryPath;
try {
  if (process.argv[1]) entryPath = realpathSync(process.argv[1]);
} catch {
  // Imports from stdin or virtual entry points have no filesystem entry path.
}
if (entryPath === fileURLToPath(import.meta.url)) tool.runCli();
