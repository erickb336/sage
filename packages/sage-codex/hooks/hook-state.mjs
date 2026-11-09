// The private per-session state files of the Codex hooks: the mode files and the start marks.
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/** The mode files: under the Codex logbook root (SAGE_HOME, or CODEX_HOME/sage), as the Codex state tool finds it. */
export const modeDirectory = (env) => resolve(env.SAGE_HOME ?? join(env.CODEX_HOME ?? join(env.HOME ?? homedir(), ".codex"), "sage"), ".hooks", "codex");

// Hash the full identity: a child shares its parent's session_id but gets its own state.
export function stateKey(input) {
  if (typeof input.session_id !== "string" || !input.session_id) return undefined;
  return createHash("sha256").update(JSON.stringify([input.session_id, input.agent_id ?? null])).digest("hex");
}

// Refuse links and ancestors controlled by another user. Root-owned system parents are trusted.
// Existing state directories must be private and owned by this user.
export function privateDirectory(path) {
  const parent = dirname(path);
  if (parent !== path) {
    try {
      const info = lstatSync(parent);
      if (!info.isDirectory() || info.isSymbolicLink() || ![0, process.getuid()].includes(info.uid) || ((info.mode & 0o022) && !(info.mode & 0o1000))) throw new Error("unsafe state parent");
      // Check existing ancestors too, without changing their permissions.
      let ancestor = dirname(parent);
      while (ancestor !== dirname(ancestor)) {
        const entry = lstatSync(ancestor);
        if (!entry.isDirectory() || ![0, process.getuid()].includes(entry.uid) || ((entry.mode & 0o022) && !(entry.mode & 0o1000))) throw new Error("unsafe state ancestor");
        ancestor = dirname(ancestor);
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      privateDirectory(parent);
    }
  }
  try { mkdirSync(path, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
  const info = lstatSync(path);
  if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o077)) throw new Error("unsafe state directory");
}

export function readState(file) {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.uid !== process.getuid() || info.size > 1024 * 1024) throw new Error("unsafe state file");
    return JSON.parse(readFileSync(fd, "utf8"));
  } finally { closeSync(fd); }
}

export function saveState(file, state) {
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
