import { spawnSync } from "node:child_process";

// T547: autopilot lands pull requests, and GitHub protection is the real lock on the default branch. When autopilot turns on,
// sage reads whether that branch requires a pull request, and warns if not. It warns only: it never blocks, and a failed
// read says "could not check". No single GitHub read covers both kinds of protection, so the check reads at most 3 things:
// the repository (for its default branch), the rulesets that apply to that branch, and the classic branch protection.

const SETUP = 'On GitHub, open the repository, then Settings, Rules, and add a ruleset for the default branch with "Require a pull request before merging" (or Settings, Branches, and add a branch protection rule with the same setting).';

/** One read-only gh GET at most 4 seconds: { ok, body } with the parsed JSON, or { ok: false, body } for an error body (404 and the like). */
function get(path, cwd, env) {
  const { GH_HOST, GH_REPO, ...rest } = env;
  const r = spawnSync("gh", ["api", "--hostname", "github.com", path], { cwd, encoding: "utf8", timeout: 4000, killSignal: "SIGKILL", maxBuffer: 2 ** 20, stdio: ["ignore", "pipe", "ignore"], env: { ...rest, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" } });
  let body;
  try { body = JSON.parse(r.stdout); } catch { /* no JSON: the read failed */ }
  return { ok: !r.error && r.status === 0 && body !== undefined, body };
}

/**
 * Whether the default branch of the repository in cwd requires a pull request: "protected", "unprotected" or "unknown".
 * Read only. A rule counts when it requires a pull request: a ruleset rule of type pull_request, or classic protection
 * with required_pull_request_reviews. Protection that only requires status checks is "unprotected" for this check.
 */
export function branchProtection(cwd, env = process.env) {
  const repo = get("repos/{owner}/{repo}", cwd, env);
  const name = repo.body?.full_name, branch = repo.body?.default_branch;
  if (!repo.ok || typeof name !== "string" || typeof branch !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(name) || !branch) return { kind: "unknown" };
  const where = `repos/${name}/`;
  const rules = get(`${where}rules/branches/${encodeURIComponent(branch)}`, cwd, env);
  if (rules.ok && Array.isArray(rules.body) && rules.body.some((rule) => rule?.type === "pull_request")) return { kind: "protected", branch };
  const classic = get(`${where}branches/${encodeURIComponent(branch)}/protection`, cwd, env);
  if (classic.ok && classic.body?.required_pull_request_reviews) return { kind: "protected", branch };
  const rulesRead = rules.ok && Array.isArray(rules.body);
  const classicRead = classic.ok || classic.body?.message === "Branch not protected";
  return { kind: rulesRead && classicRead ? "unprotected" : "unknown", branch };
}

/**
 * The one line for the autopilot-on note, or "" for none. state is the session's mode state: it keeps the answer (state.protection)
 * so that the session reads GitHub once and warns once. An unknown answer is not kept, so the next autopilot-on tries again.
 */
export function protectionNote(state, cwd, env = process.env) {
  if (state.protection || typeof cwd !== "string" || !cwd) return "";
  const found = branchProtection(cwd, env);
  if (found.kind === "unknown") return " sage could not check whether the default branch of this repository requires a pull request on GitHub. Autopilot still runs.";
  state.protection = found.kind;
  if (found.kind === "protected") return "";
  return ` Warning: the default branch of this repository (${found.branch}) has no GitHub protection that requires a pull request, so a merge or a push can land with no lock. Autopilot still runs. ${SETUP}`;
}
