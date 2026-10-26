// A fake GitHub for the carry-over tests of the merge check (T493). githubAnswer answers the read-only API calls of the
// merge check (commits, compare, git/trees, git/blobs) from a separate git repository that stands in for GitHub, so a
// test can give the local clone other objects, refs or nothing at all. fakeGithub writes a fake gh that uses it and
// answers gh pr view from a JSON file. It runs git with arguments, never a shell, and never reaches the network.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

/**
 * GitHub's answer to one API path of repo (owner/name) as JSON, from the repository in the folder github, or undefined
 * for a path that GitHub would answer with 404: another repository, an unknown endpoint or a missing commit. With cut,
 * every tree is a cut list (truncated: true).
 */
export function githubAnswer(github, repo, path, cut = false) {
  const git = (...a) => execFileSync("git", ["-C", github, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  const holds = (...a) => {
    try {
      return git(...a), true;
    } catch {
      return false;
    }
  };
  const tree = (sha) => git("rev-parse", `${sha}^{tree}`);
  const prefix = `repos/${repo}/`;
  if (!path.startsWith(prefix)) return undefined;
  const rest = path.slice(prefix.length);
  let m;
  try {
    if ((m = /^commits\/([0-9a-f]{40})$/.exec(rest))) {
      const [sha, ...parents] = git("rev-list", "--parents", "-n", "1", `${m[1]}^{commit}`, "--").split(" ");
      return { sha, parents: parents.map((p) => ({ sha: p })), commit: { tree: { sha: tree(sha) } } };
    }
    if ((m = /^compare\/([0-9a-f]{40})\.\.\.([0-9a-f]{40})$/.exec(rest))) {
      const [a, b] = [m[1], m[2]];
      const base = git("merge-base", a, b);
      const status = a === b ? "identical" : holds("merge-base", "--is-ancestor", a, b) ? "ahead" : holds("merge-base", "--is-ancestor", b, a) ? "behind" : "diverged";
      return { status, base_commit: { sha: a, commit: { tree: { sha: tree(a) } } }, merge_base_commit: { sha: base, commit: { tree: { sha: tree(base) } } } };
    }
    if ((m = /^git\/trees\/([0-9a-f]{40})\?recursive=1$/.exec(rest))) {
      const entries = git("ls-tree", "-r", "-t", m[1]).split("\n").filter(Boolean).map((line) => {
        const [info, p] = line.split("\t");
        const [mode, type, sha] = info.split(" ");
        return { path: p, mode, type, sha };
      });
      return { sha: m[1], tree: entries, truncated: cut };
    }
    if ((m = /^git\/blobs\/([0-9a-f]{40})$/.exec(rest))) return { sha: m[1], encoding: "base64", content: execFileSync("git", ["-C", github, "cat-file", "blob", m[1]]).toString("base64") };
  } catch {}
  return undefined;
}

/**
 * Runs the fake gh: logs the call, fails when <dir>/gh-fail exists, prints <dir>/pr.json for gh pr view, and answers gh
 * api --hostname github.com <path> with githubAnswer (a cut list when <dir>/truncate exists). Any other call, a 404 and
 * a call with GH_REPO or GH_HOST set exit 1.
 */
export function runFake(dir, github, repo, args) {
  appendFileSync(join(dir, "gh-calls.log"), `${args.join(" ")}\n`);
  if (existsSync(join(dir, "gh-fail"))) process.exit(1);
  if (args[0] === "pr" && args[1] === "view") return process.stdout.write(readFileSync(join(dir, "pr.json"), "utf8"));
  if (args[0] !== "api" || args[1] !== "--hostname" || args[2] !== "github.com" || args.length !== 4 || process.env.GH_REPO || process.env.GH_HOST) process.exit(1);
  const out = githubAnswer(github, repo, args[3], existsSync(join(dir, "truncate")));
  if (out === undefined) process.exit(1);
  process.stdout.write(JSON.stringify(out));
}

/** Writes the fake gh as <dir>/bin/gh for the repository in the folder github, named repo (owner/name). Returns the bin folder. */
export function fakeGithub(dir, github, repo) {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  const self = new URL(import.meta.url).href;
  writeFileSync(join(bin, "gh"), `#!/usr/bin/env node\nimport(${JSON.stringify(self)}).then(({ runFake }) => runFake(...${JSON.stringify([dir, github, repo])}, process.argv.slice(2)));\n`, { mode: 0o755 });
  return bin;
}

/** The text of gh pr view for pull request 41 of repo, with base as GitHub's base commit. */
export const prView = (repo, base, head = "sage/t1") => JSON.stringify({ headRefName: head, isCrossRepository: false, baseRefOid: base ?? "", url: `https://github.com/${repo}/pull/41` });
