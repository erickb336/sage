import { basename, dirname, isAbsolute, join, sep } from "node:path";
import { lstatSync, readlinkSync, realpathSync, statSync } from "node:fs";

const refuse = () => { throw Error("File write paths are unavailable"); };
const textPath = path => typeof path === "string" && path.length > 0 && path.length <= 4096 && !/\p{Cc}/u.test(path);
const from = (cwd, path) => isAbsolute(path) ? path : `${cwd}/${path}`;
const fold = text => text.normalize("NFKC").toLowerCase();

// Resolve links before '..'. Preserve missing suffixes so new files are checked too.
function canonical(path) {
  let rest = [], hops = 0;
  for (;;) {
    try { return fold(join(realpathSync.native(path), ...rest)); }
    catch (error) {
      if (!["ENOENT", "ELOOP"].includes(error.code)) throw error;
      const link = lstatSync(path, { throwIfNoEntry: false });
      if (link?.isSymbolicLink()) {
        if (++hops > 64) refuse();
        path = from(dirname(path), readlinkSync(path));
        if (!textPath(path)) refuse();
      } else if (dirname(path) === path) return fold(join(path, ...rest));
      else { rest.unshift(basename(path)); path = dirname(path); }
    }
  }
}
const contains = (root, path) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

/** A path check only. The caller supplies trusted roots and execution cwd, then enforces the decision. */
export function fileWriteOutsideRoots({ paths, cwd, roots }) {
  if (!Array.isArray(paths) || paths.length > 4096 || !paths.every(textPath)
    || !textPath(cwd) || !isAbsolute(cwd) || !Array.isArray(roots) || !roots.length
    || !roots.every(root => textPath(root) && isAbsolute(root))) refuse();
  try {
    const protectedRoots = roots.map(canonical);
    for (const path of paths) {
      const absolute = from(cwd, path);
      if (!textPath(absolute)) refuse();
      const resolved = canonical(absolute);
      // An ancestor can remove or replace the protected tree as a whole.
      if (protectedRoots.some(root => contains(root, resolved) || contains(resolved, root))) return false;
      const existing = statSync(absolute, { throwIfNoEntry: false });
      // A second name can reach a protected inode without sharing its directory.
      if (existing?.isFile() && existing.nlink > 1) return false;
    }
    return true;
  } catch { refuse(); }
}
