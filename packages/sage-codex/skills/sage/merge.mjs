#!/usr/bin/env node
// The Codex merge command of autopilot (T663): node "<plugin>/skills/sage/merge.mjs" <pr> <head sha>. It fails closed.
// A Codex hook that crashes, times out or cannot start lets its command run (T662 proof, case 2a), so this command
// does not trust that the gate ran. It merges only with the one-time merge permit that the gate saved for this exact
// tool call, and only when Codex's session record still shows the owner's on switch. Each check below refuses, and
// each refusal gives the agent a next step to tell the owner:
//   1. The arguments are exactly a pull request number and a 40-character head SHA.
//   2. The call comes from the session's root thread (CODEX_THREAD_ID equals CODEX_SESSION_ID): only the chief merges.
//   3. It takes the merge permit of CODEX_TOOL_CALL_ID with one atomic rename, so a permit is used once. No permit, a
//      used permit, a damaged permit, a permit older than 300 s, or a permit for another session, pull request, SHA
//      or command refuses. In Codex's sandbox the rename fails: then it asks for an escalated run.
//   4. Right before gh, it reads the record from the permit's start mark (owner-record.mjs): the owner's autopilot
//      switch must be on, and the permit's turn must have no turn_aborted event. Esc does not stop a command that
//      already runs (T662 proof, case 1c), so this check is the last stop before the merge.
//   5. gh pr merge --repo <the permit's repository> --match-head-commit, with no shell, in an empty private folder of
//      sage outside every worktree, and without the variables that send gh to another host or repository. So the merge
//      goes to the reviewed head of that repository only, and gh runs no git command in a checkout (with --repo, gh
//      deletes only the remote branch). GH_CONFIG_DIR stays: gh keeps the owner's login there when it is set, and the
//      agent cannot set it, because the permit admits only the exact command.
// No hook writes a merge permit yet (T677 adds the gate's admission), so this command refuses every merge for now.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync, renameSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { autopilotSwitch, readRecord, turnAborted } from "../../hooks/owner-record.mjs";
import { privateDirectory, readState } from "../../hooks/principles-hook.mjs";
import { modeDirectory } from "../../hooks/sage-codex-hook.mjs";

/** The age after which a merge permit is no longer valid. */
const PERMIT_AGE = 300_000;
const SCRIPT = fileURLToPath(import.meta.url);
const SANDBOXED = new Set(["EPERM", "EACCES", "EROFS"]);
const text = (value) => typeof value === "string" && value.length > 0;
/** A GitHub repository as owner/name, in GitHub's own name rules: no host, no path, and no leading dash (no flag). */
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]*\/(?!\.\.?$)[A-Za-z0-9_.][A-Za-z0-9_.-]*$/;
/** The variables that send gh to another host or repository than the permit's. */
const REDIRECTS = ["GH_HOST", "GH_REPO", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"];
/**
 * A merge permit, as the gate saves it: the session, repository (owner/name), pull request, head SHA and exact command
 * that it admits, the turn of the call, the record, the session's start mark, and the time of the gate's admission.
 */
const PERMIT_FIELDS = [["session", text], ["repo", (v) => REPOSITORY.test(v)], ["pr", text], ["sha", text], ["command", text], ["turn", text],
  ["transcript", text], ["mark", (v) => v !== null && typeof v === "object"], ["time", Number.isFinite]];

const AGAIN = "Ask for the merge again";
const IN_GITHUB = `${AGAIN}. If it refuses again, the owner can merge the pull request in GitHub`;
const SWITCH_ON = 'To merge on autopilot, the owner sends "autopilot on" alone while sage mode is on, then asks for the merge again. Or the owner merges the pull request in GitHub';

/** The one form of the merge command, as the gate admits it and as the permit names it. */
export const mergeCommand = (pr, sha) => `node "${SCRIPT}" ${pr} ${sha}`;

/** The merge permit file of one tool call: its name is a hash, so no call id can name another path. */
export const permitFile = (env, callId) => join(modeDirectory(env), "permits", `${createHash("sha256").update(callId).digest("hex")}.json`);

/** The folder that gh runs in: empty, private to sage, and outside every worktree. */
export const ghFolder = (env) => join(modeDirectory(env), "merge-folder");

/**
 * { why } to refuse the merge (the cause and the next step), or { repo } to merge. It uses up the call's merge permit,
 * also when it refuses.
 */
function check(args, env, now) {
  if (args.length !== 2 || !/^[1-9]\d*$/.test(args[0]) || !/^[0-9a-f]{40}$/.test(args[1])) return { why: "give exactly two arguments: the pull request number and its 40-character head SHA" };
  const [pr, sha] = args;
  const session = env.CODEX_SESSION_ID;
  if (!session || env.CODEX_THREAD_ID !== session) return { why: "only the chief merges, not a subagent. Ask the chief to run the merge" };
  const callId = env.CODEX_TOOL_CALL_ID;
  if (!callId) return { why: `Codex gave this command no tool call id. ${AGAIN}` };
  const file = permitFile(env, callId);
  const used = file.replace(/\.json$/, ".used.json");
  try { renameSync(file, used); } catch (error) {
    if (SANDBOXED.has(error.code)) return { why: `Codex's sandbox does not let it use its merge permit (${error.code}). Approve the command to run outside the sandbox` };
    return { why: error.code === "ENOENT" ? `this command has no merge permit, or its merge permit was used. ${AGAIN}` : `it cannot use its merge permit (${error.code ?? error.message}). ${AGAIN}` };
  }
  let permit;
  try { permit = readState(used); } catch { permit = undefined; }
  if (!PERMIT_FIELDS.every(([field, valid]) => valid(permit?.[field]))) return { why: `the merge permit is damaged. ${AGAIN}` };
  const age = now - permit.time;
  if (!(age >= 0 && age <= PERMIT_AGE)) return { why: `the merge permit is not from the last 300 s. ${AGAIN}` };
  if (permit.session !== session) return { why: `the merge permit is for another session. ${AGAIN}` };
  if (permit.pr !== pr) return { why: `the merge permit is for another pull request. ${AGAIN}` };
  if (permit.sha !== sha) return { why: `the merge permit is for another head SHA. ${AGAIN}` };
  if (permit.command !== mergeCommand(pr, sha)) return { why: `the merge permit is for another command. ${AGAIN}` };
  const record = readRecord(permit.transcript);
  if (record.refused) return { why: `${record.refused}. ${IN_GITHUB}` };
  const owner = autopilotSwitch(record, permit.mark);
  if (owner.refused) return { why: `${owner.refused}. ${IN_GITHUB}` };
  if (!owner.on) return { why: `${owner.reason}. ${SWITCH_ON}` };
  if (turnAborted(record, permit.turn)) return { why: "the owner stopped the turn of this merge with Esc. Ask for the merge again only if the owner wants it" };
  return { repo: permit.repo };
}

if (process.argv[1] && realpathSync(process.argv[1]) === SCRIPT) {
  const args = process.argv.slice(2);
  const { why, repo } = check(args, process.env, Date.now());
  if (why) {
    process.stderr.write(`sage: the merge command refuses: ${why}.\n`);
    process.exit(1);
  }
  const env = { ...process.env };
  for (const name of REDIRECTS) delete env[name];
  try {
    const cwd = ghFolder(env);
    privateDirectory(cwd);
    execFileSync("gh", ["pr", "merge", args[0], "--repo", repo, "--squash", "--delete-branch", "--match-head-commit", args[1]], { cwd, env, stdio: "inherit" });
  } catch (error) {
    const cause = typeof error.status === "number"
      ? `gh pr merge failed (exit status ${error.status}): the head may have moved, the pull request may not be ready to merge, or gh may not be logged in`
      : error.signal ? `gh pr merge stopped (${error.signal}) before it finished`
        : `gh pr merge could not start (${error.code ?? error.message}): gh may not be installed, or sage cannot use its folder ${ghFolder(env)}`;
    process.stderr.write(`sage: ${cause}. Check the pull request in GitHub, then ask for the merge again.\n`);
    process.exit(typeof error.status === "number" ? error.status : 1);
  }
}
