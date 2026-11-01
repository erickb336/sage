import { spawnSync } from "node:child_process";

// T547: autopilot lands pull requests, and GitHub protection is the real lock on the default branch. When autopilot turns on,
// sage reads whether that branch requires a pull request, and warns if not. It warns only: it never blocks, and a failed
// read says "could not check". No single GitHub read covers both kinds of protection, so the check reads at most 3 things:
// the repository (for its default branch), the rulesets that apply to that branch, and the classic branch protection.

const SETUP = 'On GitHub, open the repository, then Settings, Rules, and add a ruleset for the default branch with "Require a pull request before merging" (or Settings, Branches, and add a branch protection rule with the same setting).';

// The whole check shares one deadline, because the host kills a hook at 10 seconds and the state saves only after the hook returns.
const DEADLINE_MS = 5000;

/** One read-only gh GET: { ok, body } with the parsed JSON, or { ok: false, body } for an error body (404 and the like). It waits at most 4 seconds, and never past the deadline (a time stamp): with no time left it reads nothing. */
function get(path, cwd, env, deadline) {
  const left = Math.min(4000, deadline - Date.now());
  if (left <= 0) return { ok: false };
  const { GH_HOST, GH_REPO, ...rest } = env;
  const r = spawnSync("gh", ["api", "--hostname", "github.com", path], { cwd, encoding: "utf8", timeout: left, killSignal: "SIGKILL", maxBuffer: 2 ** 20, stdio: ["ignore", "pipe", "ignore"], env: { ...rest, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" } });
  let body;
  try { body = JSON.parse(r.stdout); } catch { /* no JSON: the read failed */ }
  return { ok: !r.error && r.status === 0 && body !== undefined, body };
}

/** True when GitHub answers that this feature needs a paid plan or a public repository (a private repository on the free plan: HTTP 403). */
function offered(read) {
  return !read.ok && typeof read.body?.message === "string" && read.body.message.startsWith("Upgrade to GitHub");
}

/**
 * Whether the default branch of the repository in cwd requires a pull request: "protected", "unprotected", "unavailable"
 * (GitHub offers no protection for this private repository on its plan) or "unknown". Read only, and done within 5 seconds. A rule counts when it requires a pull request: a ruleset rule of type pull_request, or classic protection
 * with required_pull_request_reviews. Protection that only requires status checks is "unprotected" for this check.
 */
export function branchProtection(cwd, env = process.env) {
  const deadline = Date.now() + DEADLINE_MS;
  const repo = get("repos/{owner}/{repo}", cwd, env, deadline);
  const name = repo.body?.full_name, branch = repo.body?.default_branch;
  if (!repo.ok || typeof name !== "string" || typeof branch !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(name) || !branch) return { kind: "unknown" };
  const where = `repos/${name}/`;
  const rules = get(`${where}rules/branches/${encodeURIComponent(branch)}`, cwd, env, deadline);
  if (rules.ok && Array.isArray(rules.body) && rules.body.some((rule) => rule?.type === "pull_request")) return { kind: "protected", branch };
  if (offered(rules)) return { kind: "unavailable", branch };
  const classic = get(`${where}branches/${encodeURIComponent(branch)}/protection`, cwd, env, deadline);
  if (classic.ok && classic.body?.required_pull_request_reviews) return { kind: "protected", branch };
  if (offered(classic)) return { kind: "unavailable", branch };
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
  if (found.kind === "unavailable") return ` Warning: GitHub offers no branch protection for this private repository on your plan, so nothing locks the default branch (${found.branch}). A merge or a push can land with no lock. Autopilot still runs. To get a lock, make the repository public or upgrade to GitHub Pro.`;
  return ` Warning: the default branch of this repository (${found.branch}) has no GitHub protection that requires a pull request, so a merge or a push can land with no lock. Autopilot still runs. ${SETUP}`;
}
