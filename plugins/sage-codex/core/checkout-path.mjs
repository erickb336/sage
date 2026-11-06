import { lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, parse, sep } from "node:path";
import { readLocalGit } from "./local-git.mjs";

const valid = value => typeof value === "string" && value.length > 0 && value.length <= 4096 && !/\p{Cc}/u.test(value);
const unavailable = () => { throw Error("Checkout path evidence is unavailable"); };
export const checkoutContains = (root, path) => {
  const a = root.split(sep), b = path.split(sep);
  return a.length <= b.length && a.every((part, i) => part === b[i]);
};

/** Resolve in filesystem order. No case folding or Unicode normalization grants access. */
export function resolveCheckoutPath(path, cwd = "/") {
  if (!valid(path) || !valid(cwd) || !isAbsolute(cwd)) unavailable();
  const absolute = isAbsolute(path) ? path : `${cwd}/${path}`;
  let current = parse(absolute).root, pending = absolute.slice(current.length).split(sep), missing = false, hops = 0;
  const traversed = [];
  while (pending.length) {
    const part = pending.shift();
    if (!part || part === ".") continue;
    if (part === "..") {
      if (missing) unavailable();
      current = dirname(current);
      traversed.push(current);
      continue;
    }
    const next = join(current, part);
    traversed.push(next);
    if (missing) { current = next; continue; }
    let stat;
    try { stat = lstatSync(next); }
    catch (error) {
      if (error.code !== "ENOENT") unavailable();
      missing = true; current = next; continue;
    }
    if (stat.isSymbolicLink()) {
      if (++hops > 64) unavailable();
      // A dangling link is not a missing suffix supplied by the caller.
      try { realpathSync.native(next); } catch { unavailable(); }
      const link = readlinkSync(next);
      if (!valid(link)) unavailable();
      if (isAbsolute(link)) current = parse(link).root;
      pending = [...link.split(sep), ...pending];
      continue;
    }
    if (pending.some(Boolean) && !stat.isDirectory()) unavailable();
    if (stat.isFile() && stat.nlink > 1) unavailable();
    current = realpathSync.native(next);
    traversed.push(current);
  }
  return { canonicalTarget: current, traversed, missing, directory: !missing && lstatSync(current).isDirectory() };
}

/** A marker alone proves nothing. Verify Git's checkout, common directory, and backlink. */
export function verifiedCheckout(path) {
  try {
    const resolved = resolveCheckoutPath(path);
    let root = resolved.canonicalTarget;
    if (!lstatSync(root, { throwIfNoEntry: false })?.isDirectory()) root = dirname(root);
    while (!lstatSync(join(root, ".git"), { throwIfNoEntry: false })) {
      if (dirname(root) === root) return { verified: false };
      root = dirname(root);
    }
    const values = readLocalGit(root, ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir", "--absolute-git-dir"]).toString().trim().split("\n");
    if (values.length !== 3 || !values.every(isAbsolute)) return { verified: false };
    const [checkoutRoot, commonGitDir, gitDir] = values.map(value => realpathSync.native(value));
    if (checkoutRoot !== root || basename(commonGitDir) !== ".git") return { verified: false };
    const markerPath = join(root, ".git"), markerStat = lstatSync(markerPath);
    if (markerStat.isSymbolicLink()) return { verified: false };
    const marker = realpathSync.native(markerPath);
    if (marker !== markerPath) return { verified: false };
    const main = gitDir === commonGitDir && commonGitDir === join(root, ".git") && marker === commonGitDir;
    let backlink = false;
    if (markerStat.isFile() && gitDir !== commonGitDir && dirname(gitDir) === join(commonGitDir, "worktrees")) {
      const value = readFileSync(join(gitDir, "gitdir"), "utf8").trim();
      const path = isAbsolute(value) ? value : `${gitDir}/${value}`;
      backlink = lstatSync(path).isFile() && resolveCheckoutPath(value, gitDir).canonicalTarget === marker;
    }
    if (!main && !backlink) return { verified: false };
    const owner = readLocalGit(dirname(commonGitDir), ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir", "--absolute-git-dir"]).toString().trim().split("\n");
    if (owner.length !== 3 || realpathSync.native(owner[0]) !== dirname(commonGitDir)
      || realpathSync.native(owner[1]) !== commonGitDir || realpathSync.native(owner[2]) !== commonGitDir) return { verified: false };
    return { verified: true, checkoutRoot, commonGitDir, gitDir, ...resolved };
  } catch { return { verified: false }; }
}
