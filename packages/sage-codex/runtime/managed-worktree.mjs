import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { checkoutContains, fileWriteOutsideRoots, resolveCheckoutPath, sharedRoot, verifiedCheckout } from "sage-core";
import { legacyRoots } from "./logbook-env.mjs";

export function managedPatchPath(path, { cwd, env, pluginRoot }) {
  try {
    const target = resolveCheckoutPath(path, cwd);
    if (target.directory) return false;
    const home = resolveCheckoutPath(resolve(env.CODEX_HOME ?? join(env.HOME ?? homedir(), ".codex"))).canonicalTarget;
    const event = verifiedCheckout(cwd), destination = verifiedCheckout(target.canonicalTarget);
    const roots = [join(home, "config.toml"), join(home, "plugins"), join(home, "cache"), join(home, "sessions"),
      join(home, "sage"), sharedRoot(env), pluginRoot,
      sharedRoot({ ...env, SAGE_HOME: undefined, SAGE_SHARED_HOME: undefined }),
      ...[...legacyRoots(env), ...legacyRoots({ ...env, SAGE_HOME: undefined })].map(root => typeof root === "string" ? root : root.path)];
    for (const proof of [event, destination]) if (proof.verified) roots.push(proof.commonGitDir, proof.gitDir, join(proof.checkoutRoot, ".git"));
    const canonicalRoots = roots.map(root => resolveCheckoutPath(root).canonicalTarget);
    if (!fileWriteOutsideRoots({ paths: [path], cwd, roots })
      || target.traversed.some(place => canonicalRoots.some(root => checkoutContains(root, place)))) return false;
    const names = value => value.split("/").some(part => [".codex", ".git"].includes(part.normalize("NFKC").toLowerCase()));
    const worktrees = join(home, "worktrees");
    const entered = target.traversed.find(place => checkoutContains(worktrees, place)
      && relative(worktrees, place).split("/").length >= 2);
    if (entered) {
      const parts = relative(worktrees, entered).split("/");
      if (names(parts.slice(0, 2).join("/"))) return false;
      const outer = join(worktrees, ...parts.slice(0, 2));
      if (!checkoutContains(outer, target.canonicalTarget)) return false;
      const proof = verifiedCheckout(outer);
      if (!proof.verified || proof.checkoutRoot !== outer || !event.verified || !destination.verified
        || proof.commonGitDir !== event.commonGitDir || destination.commonGitDir !== event.commonGitDir) return false;
      if (canonicalRoots.some(root => checkoutContains(root, outer) || checkoutContains(root, event.checkoutRoot))) return false;
      const eventParts = relative(worktrees, event.checkoutRoot).split("/");
      if (checkoutContains(worktrees, event.checkoutRoot)) {
        if (eventParts.length < 2 || names(eventParts.join("/"))) return false;
        const eventOuter = verifiedCheckout(join(worktrees, ...eventParts.slice(0, 2)));
        if (!eventOuter.verified || eventOuter.commonGitDir !== proof.commonGitDir) return false;
      } else if (names(event.checkoutRoot)) return false;
      if (target.traversed.some(place => checkoutContains(home, place) && names(relative(home, place)))) return false;
      if (target.traversed.some(place => !checkoutContains(home, place) && names(place))) return false;
      return true;
    }
    if (checkoutContains(home, target.canonicalTarget)) return false;
    if (target.traversed.some(names)) return false;
    return true;
  } catch { return false; }
}
