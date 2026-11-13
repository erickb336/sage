#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync, renameSync, rmSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readModeFile } from "../../core/index.mjs";
import { autopilotSwitch, readRecord, turnAborted } from "../../hooks/owner-record.mjs";
import { privateDirectory, readState } from "../../hooks/hook-state.mjs";

const PERMIT_AGE = 300_000;
const SCRIPT = fileURLToPath(import.meta.url);
const SANDBOXED = new Set(["EPERM", "EACCES", "EROFS"]);
const text = (value) => typeof value === "string" && value.length > 0;
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]*\/(?!\.\.?$)[A-Za-z0-9_.][A-Za-z0-9_.-]*$/;
const REDIRECTS = ["GH_HOST", "GH_REPO", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"];
const PERMIT_FIELDS = [["session", text], ["repo", (v) => REPOSITORY.test(v)], ["pr", text], ["sha", text], ["command", text], ["cwd", text], ["turn", text],
  ["transcript", text], ["mark", (v) => v !== null && typeof v === "object"], ["mode", text], ["gh", (v) => text(v) && isAbsolute(v)],
  ["path", (v) => text(v) && v.split(":").every(isAbsolute)], ["time", Number.isFinite]];

const AGAIN = "Ask for the merge again";
const SWITCH_ON = 'To merge on autopilot, the owner sends "autopilot on" alone while sage mode is on, then asks for the merge again. Or the owner merges the pull request in GitHub';

export const mergeCommand = (pr, sha) => `"${process.execPath}" "${SCRIPT}" ${pr} ${sha}`;

const INSTALLED = /^(.+)\/plugins\/cache\/[^/]+\/[^/]+\/[^/]+\/skills\/sage\/merge\.mjs$/.exec(SCRIPT)?.[1] ?? null;
const PRIVATE = INSTALLED && join(INSTALLED, "sage", ".hooks", "codex");

export const permitFolder = PRIVATE && join(PRIVATE, "permits");
export const permitFile = (callId) => permitFolder && join(permitFolder, `${createHash("sha256").update(callId).digest("hex")}.json`);

export const ghFolder = () => PRIVATE && join(PRIVATE, "merge-folder");

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
  const record = readRecord(permit.transcript);
  if (record.refused) return { why: record.refused };
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
