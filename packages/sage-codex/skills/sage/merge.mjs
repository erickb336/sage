#!/usr/bin/env node
// The Codex merge command of autopilot (T663): node "<plugin>/skills/sage/merge.mjs" <pr> <head sha>. It fails closed.
// A Codex hook that crashes, times out or cannot start lets its command run (T662 proof, case 2a), so this command
// does not trust that the gate ran. It merges only with the one-time merge permit that the gate saved for this exact
// tool call, and only when Codex's record still shows the owner's on switch. Each check below refuses:
//   1. The arguments are exactly a pull request number and a 40-character head SHA.
//   2. The call comes from the session's root thread (CODEX_THREAD_ID equals CODEX_SESSION_ID): only the chief merges.
//   3. It takes the merge permit of CODEX_TOOL_CALL_ID with one atomic rename, so a permit is used once. No permit, a
//      used permit, a damaged permit, a permit older than 300 s, or a permit for another session, pull request, SHA
//      or command refuses. In Codex's sandbox the rename fails: then it asks for an escalated run.
//   4. Right before gh, it reads the record from the permit's boundary (owner-record.mjs): the owner's latest
//      autopilot switch must be on, and the permit's turn must have no turn_aborted event. Esc does not stop a command
//      that already runs (T662 proof, case 1c), so this check is the last stop before the merge.
//   5. gh pr merge --match-head-commit, with no shell, and without GH_HOST and GH_REPO, so the merge goes to the
//      repository of the working folder and to the reviewed head only.
// No hook writes a merge permit yet (T677 adds the gate's admission), so this command refuses every merge for now.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync, renameSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { autopilotSwitch, readRecord, turnAborted } from "../../hooks/owner-record.mjs";
import { readState } from "../../hooks/principles-hook.mjs";
import { modeDirectory } from "../../hooks/sage-codex-hook.mjs";

/** The age after which a merge permit is no longer valid. */
const PERMIT_AGE = 300_000;
const SCRIPT = fileURLToPath(import.meta.url);
const SANDBOXED = new Set(["EPERM", "EACCES", "EROFS"]);
const text = (value) => typeof value === "string" && value.length > 0;
/**
 * A merge permit, as the gate saves it: the session, pull request, head SHA and exact command that it admits, the
 * turn of the call, the record and its boundary (the start mark's line count), and the time of the gate's admission.
 */
const PERMIT_FIELDS = [["session", text], ["pr", text], ["sha", text], ["command", text], ["turn", text], ["transcript", text],
  ["from", Number.isInteger], ["time", Number.isFinite]];

/** The one form of the merge command, as the gate admits it and as the permit names it. */
export const mergeCommand = (pr, sha) => `node "${SCRIPT}" ${pr} ${sha}`;

/** The merge permit file of one tool call: its name is a hash, so no call id can name another path. */
export const permitFile = (env, callId) => join(modeDirectory(env), "permits", `${createHash("sha256").update(callId).digest("hex")}.json`);

/** The reason to refuse the merge, or undefined to merge. It uses up the call's merge permit, also when it refuses. */
function refusal(args, env = process.env, now = Date.now()) {
  if (args.length !== 2 || !/^[1-9]\d*$/.test(args[0]) || !/^[0-9a-f]{40}$/.test(args[1])) return "give exactly two arguments: the pull request number and its 40-character head SHA";
  const [pr, sha] = args;
  const session = env.CODEX_SESSION_ID;
  if (!session || env.CODEX_THREAD_ID !== session) return "only the root thread of the session (the chief) merges";
  const callId = env.CODEX_TOOL_CALL_ID;
  if (!callId) return "Codex gave this command no tool call id";
  const file = permitFile(env, callId);
  const used = file.replace(/\.json$/, ".used.json");
  try { renameSync(file, used); } catch (error) {
    if (SANDBOXED.has(error.code)) return `the sandbox does not let it take its merge permit (${error.code}): run it escalated`;
    return error.code === "ENOENT" ? "this tool call has no merge permit, or its permit was used" : `it cannot take its merge permit (${error.code ?? error.message})`;
  }
  let permit;
  try { permit = readState(used); } catch { permit = undefined; }
  if (!PERMIT_FIELDS.every(([field, valid]) => valid(permit?.[field]))) return "the merge permit is damaged";
  const age = now - permit.time;
  if (!(age >= 0 && age <= PERMIT_AGE)) return "the merge permit is not from the last 300 s";
  if (permit.session !== session) return "the merge permit is for another session";
  if (permit.pr !== pr) return "the merge permit is for another pull request";
  if (permit.sha !== sha) return "the merge permit is for another head SHA";
  if (permit.command !== mergeCommand(pr, sha)) return "the merge permit is for another command";
  const record = readRecord(permit.transcript);
  if (record.refused) return record.refused;
  const owner = autopilotSwitch(record, permit.from);
  if (!owner.on) return owner.reason;
  if (turnAborted(record, permit.turn)) return "the owner stopped the turn of this merge (Esc)";
  return undefined;
}

if (process.argv[1] && realpathSync(process.argv[1]) === SCRIPT) {
  const args = process.argv.slice(2);
  const why = refusal(args);
  if (why) {
    process.stderr.write(`sage: the merge command refuses: ${why}.\n`);
    process.exit(1);
  }
  const { GH_HOST, GH_REPO, ...env } = process.env;
  try {
    execFileSync("gh", ["pr", "merge", args[0], "--squash", "--delete-branch", "--match-head-commit", args[1]], { env, stdio: "inherit" });
  } catch (error) {
    process.stderr.write(`sage: gh pr merge failed (${error.status ?? error.code}).\n`);
    process.exit(typeof error.status === "number" ? error.status : 1);
  }
}
