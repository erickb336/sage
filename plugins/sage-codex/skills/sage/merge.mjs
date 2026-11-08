#!/usr/bin/env node
// The Codex merge command of autopilot (T663, T677): "<node>" "<plugin>/skills/sage/merge.mjs" <pr> <head sha>, with
// the absolute path of the node that runs the sage hooks. It fails closed. A Codex hook that crashes, times out or
// cannot start lets its command run (T662 proof, case 2a), so this command does not trust that the gate ran. It merges
// only with the one-time merge permit that the gate saved for this exact tool call, and only when Codex's session
// record and the session's mode file still show autopilot on. Each check below refuses, and each refusal gives the
// agent a next step to tell the owner:
//   1. The arguments are exactly a pull request number and a 40-character head SHA.
//   2. The call comes from the session's root thread (CODEX_THREAD_ID equals CODEX_SESSION_ID): only the chief merges.
//   3. It takes the merge permit of CODEX_TOOL_CALL_ID with one atomic rename, so a permit is used once. No permit, a
//      used permit, a damaged permit, a permit older than 300 s, or a permit for another session, pull request, SHA
//      or command refuses. In Codex's sandbox the rename fails: then it asks for an escalated run.
//      The permits are in a folder of the Codex home where this plugin is installed (<CODEX_HOME>/plugins/cache/
//      <marketplace>/<plugin>/<version>), never from the caller's SAGE_HOME, CODEX_HOME or HOME: a caller cannot point
//      the command at a permit that it wrote (F-T663-21). A copy of the plugin outside such an install has no permits.
//   4. Right before gh, it reads the record from the permit's start mark (owner-record.mjs) and the session's mode file:
//      both must still show autopilot on, from the same on (its turn, F-T677-33), and the permit's turn must have no
//      turn_aborted event. Esc does not stop a
//      command that already runs (T662 proof, case 1c), so this check is the last stop before the merge.
//   5. gh pr merge --repo <the permit's repository> --match-head-commit, run by the gh file that the gate found outside
//      every folder that Codex's sandbox can write, with the name gh (a launcher such as snap or mise picks its tool by
//      that name) and the PATH that the gate kept (only folders outside the sandbox's, for the git that gh starts), with
//      no shell, in an empty private folder of sage outside every worktree, and without the variables that send gh to
//      another host or repository. So the merge goes to the
//      reviewed head of that repository only, and gh runs no git command in a checkout (with --repo, gh deletes only
//      the remote branch). GH_CONFIG_DIR stays: gh keeps the owner's login there when it is set, and the agent cannot
//      set it, because the permit admits only the exact command.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync, renameSync, rmSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readModeFile } from "../../core/index.mjs";
import { autopilotSwitch, readRecord, turnAborted } from "../../hooks/owner-record.mjs";
import { privateDirectory, readState } from "../../hooks/principles-hook.mjs";

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
 * A merge permit, as the gate saves it: the session, repository (owner/name), pull request, head SHA, exact command
 * and working folder that it admits, the turn of the call, the record, the session's start mark and mode file, the gh
 * file to run (its real file, whose name can be a launcher's), the PATH for gh, and the time of the gate's admission.
 */
const PERMIT_FIELDS = [["session", text], ["repo", (v) => REPOSITORY.test(v)], ["pr", text], ["sha", text], ["command", text], ["cwd", text], ["turn", text],
  ["transcript", text], ["mark", (v) => v !== null && typeof v === "object"], ["mode", text], ["gh", (v) => text(v) && isAbsolute(v)],
  ["path", (v) => text(v) && v.split(":").every(isAbsolute)], ["time", Number.isFinite]];

const AGAIN = "Ask for the merge again";
const SWITCH_ON = 'To merge on autopilot, the owner sends "autopilot on" alone while sage mode is on, then asks for the merge again. Or the owner merges the pull request in GitHub';

/** The one form of the merge command, as the gate admits it and as the permit names it. */
export const mergeCommand = (pr, sha) => `"${process.execPath}" "${SCRIPT}" ${pr} ${sha}`;

/** The Codex home where this plugin is installed (<home>/plugins/cache/<marketplace>/<plugin>/<version>), or null. */
const INSTALLED = /^(.+)\/plugins\/cache\/[^/]+\/[^/]+\/[^/]+\/skills\/sage\/merge\.mjs$/.exec(SCRIPT)?.[1] ?? null;
/** sage's private folder of merge permits and gh's working folder, in that Codex home: null outside an install. */
const PRIVATE = INSTALLED && join(INSTALLED, "sage", ".hooks", "codex");

/** The folder of the merge permits, or null outside an install. */
export const permitFolder = PRIVATE && join(PRIVATE, "permits");
/** The merge permit file of one tool call, or null outside an install: its name is a hash, so no call id can name another path. */
export const permitFile = (callId) => permitFolder && join(permitFolder, `${createHash("sha256").update(callId).digest("hex")}.json`);

/** The folder that gh runs in: empty, private to sage, and outside every worktree. */
export const ghFolder = () => PRIVATE && join(PRIVATE, "merge-folder");

/**
 * { why } to refuse the merge (the cause and the next step), or { repo, gh } to merge. It uses up the call's merge
 * permit, also when it refuses.
 */
function check(args, env, now) {
  if (args.length !== 2 || !/^[1-9]\d*$/.test(args[0]) || !/^[0-9a-f]{40}$/.test(args[1])) return { why: "give exactly two arguments: the pull request number and its 40-character head SHA" };
  const [pr, sha] = args;
  const session = env.CODEX_SESSION_ID;
  if (!session || env.CODEX_THREAD_ID !== session) return { why: "only the chief merges, not a subagent. Ask the chief to run the merge" };
  const callId = env.CODEX_TOOL_CALL_ID;
  if (!callId) return { why: `Codex gave this command no tool call id. ${AGAIN}` };
  const file = permitFile(callId);
  if (!file) return { why: "this copy of sage is not installed as a Codex plugin, so it has no merge permits. The owner merges the pull request in GitHub" };
  const used = file.replace(/\.json$/, ".used.json");
  try { renameSync(file, used); } catch (error) {
    if (SANDBOXED.has(error.code)) return { why: `Codex's sandbox does not let it use its merge permit (${error.code}). Approve the command to run outside the sandbox` };
    return { why: error.code === "ENOENT" ? `this command has no merge permit, or its merge permit was used. ${AGAIN}` : `it cannot use its merge permit (${error.code ?? error.message}). ${AGAIN}` };
  }
  let permit;
  try { permit = readState(used); } catch { permit = undefined; }
  rmSync(used, { force: true });
  if (!PERMIT_FIELDS.every(([field, valid]) => valid(permit?.[field]))) return { why: `the merge permit is damaged. ${AGAIN}` };
  const age = now - permit.time;
  if (!(age >= 0 && age <= PERMIT_AGE)) return { why: `the merge permit is not from the last 300 s. ${AGAIN}` };
  if (permit.session !== session) return { why: `the merge permit is for another session. ${AGAIN}` };
  if (permit.pr !== pr) return { why: `the merge permit is for another pull request. ${AGAIN}` };
  if (permit.sha !== sha) return { why: `the merge permit is for another head SHA. ${AGAIN}` };
  if (permit.command !== mergeCommand(pr, sha)) return { why: `the merge permit is for another command. ${AGAIN}` };
  // The reader's refusals give their own cause and next step.
  const record = readRecord(permit.transcript);
  if (record.refused) return { why: record.refused };
  // The mode hook's own off: it saves every off that it sees, also after a damaged mode file (F-T663-24).
  const { state } = readModeFile(readState, permit.mode);
  if (state.sage !== true || state.autopilot !== true) return { why: `autopilot is off in sage's mode file of this session. ${SWITCH_ON}` };
  const owner = autopilotSwitch(record, permit.mark, state.onTurn);
  if (owner.refused) return { why: owner.refused };
  if (!owner.on) return { why: `${owner.reason}. ${SWITCH_ON}` };
  if (turnAborted(record, permit.turn)) return { why: "the owner stopped the turn of this merge with Esc. Ask for the merge again only if the owner wants it" };
  return { repo: permit.repo, gh: permit.gh, path: permit.path };
}

if (process.argv[1] && realpathSync(process.argv[1]) === SCRIPT) {
  const args = process.argv.slice(2);
  const { why, repo, gh, path } = check(args, process.env, Date.now());
  if (why) {
    process.stderr.write(`sage: the merge command refuses: ${why}.\n`);
    process.exit(1);
  }
  const env = { ...process.env, PATH: path };
  for (const name of REDIRECTS) delete env[name];
  try {
    const cwd = ghFolder();
    privateDirectory(cwd);
    execFileSync(gh, ["pr", "merge", args[0], "--repo", repo, "--squash", "--delete-branch", "--match-head-commit", args[1]], { argv0: "gh", cwd, env, stdio: "inherit" });
  } catch (error) {
    const cause = typeof error.status === "number"
      ? `gh pr merge failed (exit status ${error.status}): the head may have moved, the pull request may not be ready to merge, or gh may not be logged in`
      : error.signal ? `gh pr merge stopped (${error.signal}) before it finished`
        : `gh pr merge could not start (${error.code ?? error.message}): gh may not be installed at ${gh}, or sage cannot use its folder ${ghFolder()}`;
    process.stderr.write(`sage: ${cause}. Check the pull request in GitHub, then ask for the merge again.\n`);
    process.exit(typeof error.status === "number" ? error.status : 1);
  }
}
