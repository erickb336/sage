#!/usr/bin/env node
// Codex 0.159.2 native hook boundary. Unknown events and tools have no effect.
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyPrinciples } from "sage-core";
import { privateDirectory, readState, saveState, stateKey } from "./hook-state.mjs";

const SKILLS = join(dirname(fileURLToPath(import.meta.url)), "../skills");
const skillText = (name) => readFileSync(join(SKILLS, name, "SKILL.md"), "utf8").replace(/^---\n[\s\S]*?\n---\n/, "").replace(/<!--[\s\S]*?-->/, "").trim();

/** All patch headers, including both ends of a move. This selects advice, not write authorization. */
export function patchPaths(patch) {
  if (typeof patch !== "string") return [];
  const lines = patch.replaceAll("\r\n", "\n").trim().split("\n");
  if (lines[0] !== "*** Begin Patch" || lines.at(-1) !== "*** End Patch") return [];
  return lines.flatMap((line) => /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/.exec(line)?.slice(1) ?? []);
}

export function handle(input, state) {
  if (!input || typeof input !== "object") return;
  const event = input.hook_event_name;
  let normalized;
  if (event === "UserPromptSubmit" && typeof input.prompt === "string") {
    normalized = { kind: "prompt", prompt: input.prompt };
  } else if (event === "PreToolUse") {
    if (input.tool_name === "apply_patch") normalized = { kind: "before-tool", paths: patchPaths(input.tool_input?.command) };
    else if (input.tool_name === "Bash" && typeof input.tool_input?.command === "string") normalized = { kind: "before-tool", command: input.tool_input.command };
  }
  if (!normalized) return;
  // Stop continuations and failure outcomes have not been verified; this adapter never blocks.
  const effect = applyPrinciples(normalized, state, skillText);
  return effect?.context ? { hookSpecificOutput: { hookEventName: event, additionalContext: effect.context } } : undefined;
}

// An import (the Codex state tool reads modeDirectory here) never throws: argv[1] may be no file, as under node -e.
const entry = (() => { try { return process.argv[1] && realpathSync(process.argv[1]); } catch { return undefined; } })();
if (entry === fileURLToPath(import.meta.url) && process.env.AGENT_KIT_HOOKS !== "off") {
  try {
    const input = JSON.parse(readFileSync(0, "utf8"));
    const key = stateKey(input);
    if (key) {
      const base = resolve(process.env.AGENT_KIT_HOOKS_STATE ?? join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "advice"));
      privateDirectory(base);
      const dir = join(base, "codex");
      privateDirectory(dir);
      const file = join(dir, `${key}.json`);
      let state = { given: [], failures: {} };
      try {
        const saved = readState(file);
        if (Array.isArray(saved.given) && saved.given.every((s) => typeof s === "string")) state = { ...state, given: saved.given };
      } catch { /* New session or damaged advice state. */ }
      const output = handle(input, state);
      saveState(file, state);
      if (output) process.stdout.write(JSON.stringify(output));
    }
  } catch { /* Advice must not break a coding session. */ }
}
