#!/usr/bin/env node
// Codex 0.159.2 native hook boundary. Unknown events and tools have no effect.
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyPrinciples } from "../core/index.mjs";

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

// Hash the full identity: a child shares its parent's session_id but gets separate advice.
export function stateKey(input) {
  if (typeof input.session_id !== "string" || !input.session_id) return undefined;
  return createHash("sha256").update(JSON.stringify([input.session_id, input.agent_id ?? null])).digest("hex");
}

// Refuse links and ancestors controlled by another user. Root-owned system parents are trusted.
// Existing state directories must be private and owned by this user.
function privateDirectory(path) {
  const parent = dirname(path);
  if (parent !== path) {
    try {
      const info = lstatSync(parent);
      if (!info.isDirectory() || info.isSymbolicLink() || ![0, process.getuid()].includes(info.uid) || ((info.mode & 0o022) && !(info.mode & 0o1000))) throw new Error("unsafe advice parent");
      // Check existing ancestors too, without changing their permissions.
      let ancestor = dirname(parent);
      while (ancestor !== dirname(ancestor)) {
        const entry = lstatSync(ancestor);
        if (!entry.isDirectory() || ![0, process.getuid()].includes(entry.uid) || ((entry.mode & 0o022) && !(entry.mode & 0o1000))) throw new Error("unsafe advice ancestor");
        ancestor = dirname(ancestor);
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      privateDirectory(parent);
    }
  }
  try { mkdirSync(path, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
  const info = lstatSync(path);
  if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o077)) throw new Error("unsafe advice directory");
}

export function readState(file) {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.uid !== process.getuid() || info.size > 1024 * 1024) throw new Error("unsafe advice file");
    return JSON.parse(readFileSync(fd, "utf8"));
  } finally { closeSync(fd); }
}

function saveState(file, state) {
  const temporary = `${file}.${randomUUID()}`;
  let fd, created = false;
  try {
    fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    created = true;
    writeFileSync(fd, JSON.stringify(state));
    closeSync(fd); fd = undefined;
    renameSync(temporary, file);
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (created) {
      try { unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url) && process.env.AGENT_KIT_HOOKS !== "off") {
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
