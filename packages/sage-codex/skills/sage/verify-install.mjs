import { readLocalGit as git } from "sage-core";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const PREFIX = "plugins/sage-codex/";
const USAGE = "usage: sage.mjs verify-install --commit <full40hexSHA> --project <absolute assigned project>";

/** Validate the whole interface before any repository or package access. Shared with the gate. */
export function verificationOptions(args) {
  if (args.length !== 5 || args[0] !== "verify-install") return undefined;
  const options = {};
  for (let i = 1; i < args.length; i += 2) {
    const key = args[i];
    if (!["--commit", "--project"].includes(key) || Object.hasOwn(options, key)) return undefined;
    options[key] = args[i + 1];
  }
  const commit = options["--commit"], project = options["--project"];
  if (!/^[0-9a-fA-F]{40}$/.test(commit ?? "") || !isAbsolute(project ?? "") || /[\x00-\x1f\x7f]/.test(project)) return undefined;
  return { commit: commit.toLowerCase(), project };
}

const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.nlink === b.nlink && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;

/** No link, special file, or unreadable file can supply matching bytes. Recheck identities after the read. */
function installedBytes(name) {
  const parts = name.split("/");
  const parents = [];
  let path = ROOT;
  for (const part of [null, ...parts.slice(0, -1)]) {
    if (part !== null) path = join(path, part);
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error("unsafe directory");
    parents.push([path, stat]);
  }
  path = join(path, parts.at(-1));
  const before = lstatSync(path);
  if (!before.isFile() || before.nlink !== 1 || !(before.mode & 0o444)) throw Error("unsafe file");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd);
    if (!sameFile(before, opened)) throw Error("file changed");
    const bytes = readFileSync(fd);
    if (!sameFile(opened, fstatSync(fd)) || !sameFile(opened, lstatSync(path))
      || parents.some(([parent, stat]) => !sameFile(stat, lstatSync(parent)))) throw Error("path changed");
    return bytes;
  } finally { closeSync(fd); }
}

export function verifyInstall(args, projectRoot) {
  const options = verificationOptions(args);
  if (!options) throw Error(USAGE);
  const { commit, project } = options;
  let assigned, requested;
  try { assigned = realpathSync(projectRoot(process.cwd())); requested = realpathSync(projectRoot(project)); } catch { /* fail closed */ }
  if (!assigned || requested !== assigned) throw Error("verify-install requires the assigned project");
  try {
    if (git(project, ["rev-parse", "--verify", "--end-of-options", commit]).toString().trim() !== commit) throw Error("ambiguous reference");
    if (git(project, ["cat-file", "-t", commit]).toString().trim() !== "commit") throw Error("not a commit");
  } catch { throw Error("reference must name an existing commit"); }
  let entries;
  try {
    const listing = new TextDecoder("utf-8", { fatal: true }).decode(git(project, ["ls-tree", "-r", "-z", "--full-tree", commit, "--", PREFIX]));
    entries = listing.split("\0").filter(Boolean).map(line => {
      const match = /^(\d{6}) (blob|commit) ([0-9a-f]{40})\t([\s\S]+)$/.exec(line);
      if (!match || !match[4].startsWith(PREFIX)) throw Error("invalid tree");
      const [, mode, type, oid, path] = match;
      return { mode, type, oid, name: path.slice(PREFIX.length) };
    });
  } catch { throw Error("could not read tracked package paths"); }
  if (!entries.length) throw Error("no tracked package files at this reference");
  const result = { scope: "tracked plugins/sage-codex files", commit, result: "match",
    counts: { tracked: entries.length, matched: 0, missing: 0, changed: 0, errors: 0 }, missing: [], changed: [], errors: [],
    limit: "This verifies tracked package files, not runtime trust or release readiness." };
  const seen = new Set();
  for (const { mode, type, oid, name } of entries) {
    let outcome;
    if (type !== "blob" || !["100644", "100755"].includes(mode) || seen.has(name)
      || name.split("/").some(part => !part || part === "." || part === "..") || /[\\\x00-\x1f\x7f]/.test(name)) outcome = "errors";
    seen.add(name);
    if (!outcome) {
      let expected;
      try { expected = git(project, ["cat-file", "blob", oid]); } catch { outcome = "errors"; }
      if (!outcome) try { outcome = installedBytes(name).equals(expected) ? "matched" : "changed"; }
      catch (error) { outcome = error.code === "ENOENT" ? "missing" : "errors"; }
    }
    result.counts[outcome] += 1;
    if (outcome !== "matched") result[outcome].push(name);
  }
  if (result.counts.matched !== result.counts.tracked) result.result = "different";
  return result;
}
