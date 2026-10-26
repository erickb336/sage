import { spawnSync } from "node:child_process";

/**
 * A pull request's number: digits with no leading zero, so that "#5", "05" or a link never hides a task from merge-check
 * --pr. The PR script reads the logbook's PR cell with this same rule.
 */
export const PR = /^[1-9][0-9]*$/;

/**
 * The head branch and the base commit of pull request pr, as gh in the merge's folder reads them: the repository that gh
 * pr merge acts on. Read only, at most 5 seconds. It throws when gh fails or is slow, when it gives no branch, and for a
 * pull request from a fork, whose branch name says nothing about a task here (F-T273-8). base is the full SHA of the base
 * branch's tip on GitHub, or undefined when gh gives none: the merge check carries verdicts over a merge of main only
 * when main's side is in that commit (T493), never by a local ref, which any agent's worktree can move. Each provider's
 * merge rule reads it for the merge check.
 */
export function pullRequest(pr, cwd, env = process.env) {
  if (!/^\d+$/.test(String(pr ?? "")) || !BigInt(pr)) throw new Error("the merge names no pull request number");
  pr = String(BigInt(pr)); // as gh reads it: 012 is PR 12
  const r = spawnSync("gh", ["pr", "view", pr, "--json", "headRefName,isCrossRepository,baseRefOid"], { cwd, encoding: "utf8", timeout: 5000, killSignal: "SIGKILL", maxBuffer: 2 ** 20, stdio: ["ignore", "pipe", "ignore"], env: { ...env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" } });
  if (r.error) throw new Error(r.error.code === "ETIMEDOUT" ? "gh did not answer in 5 seconds" : r.error.message);
  if (r.status !== 0) throw new Error(`gh pr view ${pr} failed`);
  const view = JSON.parse(r.stdout);
  if (view?.isCrossRepository !== false) throw new Error(`PR ${pr} is not a branch of this repository`);
  if (typeof view.headRefName !== "string" || !view.headRefName) throw new Error("gh gave no head branch");
  return { head: view.headRefName, base: /^[0-9a-f]{40}$/.test(view.baseRefOid ?? "") ? view.baseRefOid : undefined };
}
