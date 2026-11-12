import { spawnSync } from "node:child_process";

const SETUP = 'On GitHub, open the repository, then Settings, Rules, and add a ruleset for the default branch with "Require a pull request before merging" (or Settings, Branches, and add a branch protection rule with the same setting).';

const DEADLINE_MS = 5000;

function get(path, cwd, env, deadline) {
  const left = Math.min(4000, deadline - Date.now());
  if (left <= 0) return { ok: false };
  const { GH_HOST, GH_REPO, ...rest } = env;
  const r = spawnSync("gh", ["api", "--hostname", "github.com", path], { cwd, encoding: "utf8", timeout: left, killSignal: "SIGKILL", maxBuffer: 2 ** 20, stdio: ["ignore", "pipe", "ignore"], env: { ...rest, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" } });
  let body;
  try { body = JSON.parse(r.stdout); } catch {}
  return { ok: !r.error && r.status === 0 && body !== undefined, body };
}

function offered(read) {
  return !read.ok && typeof read.body?.message === "string" && read.body.message.startsWith("Upgrade to GitHub");
}

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

export function protectionNote(state, cwd, env = process.env) {
  if (state.protection || typeof cwd !== "string" || !cwd) return "";
  const found = branchProtection(cwd, env);
  if (found.kind === "unknown") return " sage could not check whether the default branch of this repository requires a pull request on GitHub. Autopilot still runs.";
  state.protection = found.kind;
  if (found.kind === "protected") return "";
  if (found.kind === "unavailable") return ` Warning: GitHub offers no branch protection for this private repository on your plan, so nothing locks the default branch (${found.branch}). A merge or a push can land with no lock. Autopilot still runs. To get a lock, make the repository public or upgrade to GitHub Pro.`;
  return ` Warning: the default branch of this repository (${found.branch}) has no GitHub protection that requires a pull request, so a merge or a push can land with no lock. Autopilot still runs. ${SETUP}`;
}
