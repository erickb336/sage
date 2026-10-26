import { spawnSync } from "node:child_process";

/**
 * A pull request's number: digits with no leading zero, so that "#5", "05" or a link never hides a task from merge-check
 * --pr. The PR script reads the logbook's PR cell with this same rule.
 */
export const PR = /^[1-9][0-9]*$/;

/** gh with no prompt and no update check; with clear, also without GH_HOST and GH_REPO, so the call names its own repository. */
const ghEnv = (env, clear) => ({ ...env, ...(clear ? { GH_HOST: undefined, GH_REPO: undefined } : {}), GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" });

/**
 * The head branch, the base commit and the repository of pull request pr, as gh reads them: with repo, in that
 * repository (owner/name, with GH_HOST and GH_REPO cleared); without it, as gh pr merge in the merge's folder would
 * resolve it. Read only, at most 5 seconds. It throws when gh fails or is slow, when it gives no branch, and for a pull
 * request from a fork, whose branch name says nothing about a task here (F-T273-8). base is the full SHA of the base
 * branch's tip on GitHub, or undefined when gh gives none: the merge check carries verdicts over a merge of main only
 * when main's side is in that commit (T493). repo comes from the pull request's URL, or is undefined. Each provider's
 * merge rule reads it for the merge check.
 */
export function pullRequest(pr, cwd, env = process.env, repo) {
  if (!/^\d+$/.test(String(pr ?? "")) || !BigInt(pr)) throw new Error("the merge names no pull request number");
  pr = String(BigInt(pr)); // as gh reads it: 012 is PR 12
  const args = ["pr", "view", pr, ...(repo ? ["--repo", repo] : []), "--json", "headRefName,isCrossRepository,baseRefOid,url"];
  const r = spawnSync("gh", args, { cwd, encoding: "utf8", timeout: 5000, killSignal: "SIGKILL", maxBuffer: 2 ** 20, stdio: ["ignore", "pipe", "ignore"], env: ghEnv(env, !!repo) });
  if (r.error) throw new Error(r.error.code === "ETIMEDOUT" ? "gh did not answer in 5 seconds" : r.error.message);
  if (r.status !== 0) throw new Error(`gh pr view ${pr} failed`);
  const view = JSON.parse(r.stdout);
  if (view?.isCrossRepository !== false) throw new Error(`PR ${pr} is not a branch of this repository`);
  if (typeof view.headRefName !== "string" || !view.headRefName) throw new Error("gh gave no head branch");
  const base = /^[0-9a-f]{40}$/.test(view.baseRefOid ?? "") ? view.baseRefOid : undefined;
  return { head: view.headRefName, base, repo: /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/\d+$/.exec(view.url ?? "")?.[1] };
}

/** The time that all GitHub reads of one merge check may take together: the merge rule runs inside a 10-second hook. */
export const GITHUB_TIME = 4000;

/**
 * One GET of GitHub's API on github.com, through gh, before the deadline: the answer as JSON. path names its repository
 * (repos/<owner>/<name>/…), and GH_HOST and GH_REPO are cleared. It throws on an error, a status that is not 2xx (gh
 * exits non-zero), a timeout or an answer that is not JSON.
 */
export function githubGet(path, env = process.env, deadline = Date.now() + GITHUB_TIME) {
  const timeout = Math.min(GITHUB_TIME, deadline - Date.now());
  if (timeout <= 0) throw new Error("GitHub did not answer in time");
  const r = spawnSync("gh", ["api", "--hostname", "github.com", path], { encoding: "utf8", timeout, killSignal: "SIGKILL", maxBuffer: 64 * 2 ** 20, stdio: ["ignore", "pipe", "ignore"], env: ghEnv(env, true) });
  if (r.error) throw new Error(r.error.code === "ETIMEDOUT" ? "GitHub did not answer in time" : r.error.message);
  if (r.status !== 0) throw new Error(`gh api ${path} failed`);
  return JSON.parse(r.stdout);
}
