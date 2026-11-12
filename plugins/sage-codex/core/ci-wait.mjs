import { spawnSync } from "node:child_process";

const BUCKETS = { pass: "pass", skipping: "pass", fail: "fail", cancel: "fail", pending: "pending" };
const NEXT = {
  pass: "CI passed on this head: start the reviews and QA on it.",
  fail: "CI failed on this head: start no review. End blocked, with the failed checks in EVIDENCE and Left: the checks.",
  none: "The pull request has no checks, so the project has no CI: go on, and say so in your report.",
  unknown: "End blocked, with this output in EVIDENCE and Left: the checks.",
};

const ghRead = (cwd, env) => (args) => {
  const r = spawnSync("gh", args, { cwd, env: { ...env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" }, encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL", maxBuffer: 2 ** 22, stdio: ["ignore", "pipe", "pipe"] });
  return { status: r.error ? -1 : r.status, stdout: r.stdout ?? "", stderr: r.error ? r.error.message : r.stderr ?? "" };
};

export function readChecks(pr, sha, gh) {
  const view = gh(["pr", "view", pr, "--json", "headRefOid"]);
  let head;
  try { head = JSON.parse(view.stdout).headRefOid; } catch {}
  if (view.status !== 0 || typeof head !== "string") return { state: "unknown", text: `gh pr view ${pr} failed: ${(view.stderr || view.stdout).trim().split("\n")[0]}` };
  if (head.toLowerCase() !== sha.toLowerCase()) return { state: "head", text: `PR ${pr}'s head is ${head.slice(0, 7)}, not the branch's head ${sha.slice(0, 7)}` };
  const checks = gh(["pr", "checks", pr]);
  const rows = checks.stdout.split("\n").map((line) => line.split("\t")).filter((cells) => cells.length > 1 && cells[0]).map(([name, bucket]) => [name, bucket]);
  if (!rows.length) return /no checks reported/i.test(checks.stderr) ? { state: "none", rows } : { state: "unknown", text: `gh pr checks ${pr} failed: ${(checks.stderr || checks.stdout).trim().split("\n")[0]}` };
  const states = rows.map(([, bucket]) => BUCKETS[bucket] ?? "pending");
  return { state: states.includes("fail") ? "fail" : states.includes("pending") ? "pending" : "pass", rows };
}

export async function waitForChecks(pr, sha, gh, { ms = 540_000, every = Math.min(15_000, ms / 20), grace = Math.min(60_000, ms / 2), now = Date.now, sleep = (t) => new Promise((done) => setTimeout(done, t)) } = {}) {
  const started = now();
  for (;;) {
    const look = readChecks(pr, sha, gh), spent = now() - started;
    const done = ["pass", "fail", "unknown"].includes(look.state) || (look.state === "none" && spent >= grace);
    if (done || spent >= ms) {
      const state = done ? look.state : "runs";
      const next = done ? NEXT[state] : `${look.text ?? "CI still runs"} after ${Math.round(ms / 60_000)} minutes: run this command again.`;
      return [`CI ${state} · PR ${pr} · ${sha}`, ...(look.rows ?? []).map((cells) => cells.join(" ")), ...(look.state === "unknown" ? [look.text] : []), next].join("\n");
    }
    await sleep(Math.max(0, Math.min(every, ms - spent)));
  }
}

export async function waitForCi(tool, project, task, { env = process.env, ms, gh = ghRead(project, env) } = {}) {
  const row = tool.logbookView(project, env).task(task);
  if (!row) return `the logbook has no task ${task}.`;
  if (!row.pr || !row.branch) return `${task} has no ${row.pr ? "branch" : "PR"} in the logbook yet, so there is no CI to wait for. Set it first with task set ${row.pr ? "branch" : "pr"}=.`;
  const sha = tool.branchTip(project, row.branch, env);
  if (!sha) return `the head of ${row.branch} cannot be read in this folder, so there is no CI to wait for. Report it to your chief.`;
  return waitForChecks(row.pr, sha, gh, ms ? { ms } : {});
}
