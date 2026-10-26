// A made-up git history for the carry-over tests of the merge check (T493): a main branch with origin/main, a task
// branch, and merges of main into it. Only local git commands: no remote, no network. origin/main is a ref that the
// fixture sets with update-ref, as git fetch would.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** The base commit's files: one source, the change log and one file of a built folder, both marked sage-built. */
export const BASE = { ".gitattributes": "CHANGELOG.md sage-built\nbuilt/** sage-built\n", "src.js": "a\n", "CHANGELOG.md": "- base\n", "built/out.js": "a\n" };

/**
 * The history helpers for one repository (made with git init, or with one commit already). Each commit helper returns
 * the new head SHA. start() makes the base commit on main and points origin/main at it, then puts the task branch there.
 */
export function history(repo, branch = "sage/t1") {
  const git = (...args) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const put = (files) => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(repo, path)), { recursive: true });
      writeFileSync(join(repo, path), text);
    }
  };
  const head = () => git("rev-parse", "HEAD");
  const commit = (message, files) => (put(files), git("add", "-A"), git("commit", "-q", "--allow-empty", "-m", message), head());
  return {
    git,
    start() {
      git("checkout", "-q", "-B", "main");
      const base = commit("base", BASE);
      git("update-ref", "refs/remotes/origin/main", base);
      git("checkout", "-q", "-B", branch, base);
      return base;
    },
    /** A commit on the task branch. */
    work: (files) => commit("the task", files),
    /** A commit on main, which origin/main then names; the task branch stays checked out. */
    main(files) {
      git("checkout", "-q", "main");
      const sha = commit("main moves", files);
      git("update-ref", "refs/remotes/origin/main", sha);
      git("checkout", "-q", branch);
      return sha;
    },
    /** Merges a commit into the task branch. files is the conflict fix (as npm run build writes it) or more changes. */
    merge(other, files = {}) {
      try {
        git("merge", "-q", "--no-ff", "--no-commit", other);
      } catch {} // a conflict: files fixes it
      put(files);
      git("add", "-A");
      git("commit", "-q", "--no-edit", "--allow-empty");
      return head();
    },
  };
}
