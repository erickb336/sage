#!/usr/bin/env node
// The sage gates for Codex (T456). Codex sends one PreToolUse or PermissionRequest event on stdin; the hook answers with
// one JSON object on stdout, or nothing. The rules come from core and the state tool, as in the Claude sage hook:
//   - A .codex folder: no thread, in any mode, writes under a folder named .codex (apply_patch, or a plain shell write
//     form that names one), because Codex reads project settings from it.
//   - The chief: in sage mode the root thread (no agent_id) changes no file with apply_patch. A child may.
//   - A merge (sage mode): only the one merge form of core, only on the root thread, only with autopilot on and a passing
//     merge check for that head SHA. PreToolUse denies every other merge with one reason line. PermissionRequest allows
//     the escalation of that exact command when the same rules pass, so Codex shows no prompt; for every other request it
//     declines to decide, so Codex shows its own prompt.
// It fails closed: a PreToolUse event that it cannot read is denied with one plain line. A PermissionRequest that it
// cannot read gets no decision, so the user decides in Codex's own prompt.
import { realpathSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chiefEditDenied, commandWrites, createCommandPolicy, PR, pullRequestHead } from "../core/index.mjs";
import { patchPaths, readState, stateKey } from "./principles-hook.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TOOL = join(ROOT, "skills/sage/sage.mjs");
const policy = createCommandPolicy({ stateToolPath: TOOL, prPattern: PR });

export const UNREADABLE = "sage: the hook could not read this tool call, so it refuses it. Codex may have changed its hook input: update the sage plugin, or tell the user.";
const CODEX_FOLDER = "sage: no agent changes files under a .codex folder, because Codex reads its project settings there. Ask the user to make this change.";
const CHIEF = 'sage: sage mode is on, so the chief does not change files. Brief an implementer to make this change. The user ends sage mode with the message "sage mode off", alone.';
const AGENT_MERGE = "sage: an agent never merges. Report the pull request as ready.";
const AUTOPILOT_OFF = 'sage: autopilot is off, so the user merges. Report the pull request as ready. The user turns it on with the message "autopilot on", alone.';

/** A path segment named .codex, in any letter case (the Mac file system ignores case). */
const CODEX_SEGMENT = /(?:^|[\s/\\'"=:<>])\.codex(?=$|[\s/\\'"<>;|&)])/i;
const text = (value) => typeof value === "string" && value.length > 0 && value.length <= 4096;
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * The mode of the session's root thread: { sage, autopilot }. The mode hook keeps it in one file for each thread, under
 * the Codex logbook root (SAGE_HOME, or CODEX_HOME/sage); a child shares its parent's session_id. No file is no mode. A
 * file that cannot be read keeps the chief rule on and refuses merges.
 */
export function readMode(session, env = process.env) {
  const dir = resolve(env.SAGE_HOME ?? join(env.CODEX_HOME ?? join(homedir(), ".codex"), "sage"), ".hooks", "codex");
  let state;
  try {
    state = readState(join(dir, `${stateKey({ session_id: session })}.json`));
  } catch (error) {
    return error?.code === "ENOENT" ? { sage: false, autopilot: false } : { sage: true, autopilot: false };
  }
  const sage = state?.sage === true;
  return { sage, autopilot: sage && state.autopilot === true };
}

/** The merge check for one merge form: the pull request's head branch from gh, then the state tool's ledger check. */
export async function checkMerge({ pr, sha }, cwd, env = process.env) {
  let head;
  try {
    head = pullRequestHead(pr, cwd, env);
  } catch (error) {
    return { ok: false, reason: `sage: the hook could not read the head branch of PR ${pr} from GitHub (${error?.message ?? error}), so it refuses the merge. Try again, or tell the user.` };
  }
  try {
    const { tool } = await import("../skills/sage/sage.mjs");
    const verdict = tool.mergeCheck(sha, env, { pr, head, project: realpathSync.native(cwd) });
    return verdict?.ok === true ? { ok: true } : { ok: false, reason: `sage: the merge check refuses: ${verdict?.reason}` };
  } catch (error) {
    return { ok: false, reason: `sage: the merge check could not run (${error?.message ?? error}), so it refuses every merge. Tell the user.` };
  }
}

const deny = (reason) => ({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } });
const ALLOW = { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } };
const UNREAD_REQUEST = { systemMessage: "sage: the hook could not read this approval request, so Codex asks you." };

/** The input fields that the gate reads, or undefined for a shape that it does not know. */
function fieldsOf(input) {
  if (!record(input) || !["PreToolUse", "PermissionRequest"].includes(input.hook_event_name)) return undefined;
  const { session_id, cwd, tool_name, tool_input } = input;
  if (!text(session_id) || !text(cwd) || !isAbsolute(cwd) || !["Bash", "apply_patch"].includes(tool_name)) return undefined;
  if (Object.hasOwn(input, "agent_id") && typeof input.agent_id !== "string") return undefined;
  if (!record(tool_input) || typeof tool_input.command !== "string") return undefined;
  // An empty agent_id is still a child: only an event without one is the root thread.
  return { event: input.hook_event_name, session: session_id, cwd, tool: tool_name, command: tool_input.command, child: Object.hasOwn(input, "agent_id") };
}

/** A shell write form that names a .codex folder. The plugin's own path (it can be under CODEX_HOME) does not count. */
const codexShellWrite = (command, cwd) => CODEX_SEGMENT.test(command.split(ROOT).join(" ")) && commandWrites(command, cwd);

/**
 * The gate's answer to one hook event: a hook output object, or undefined for no decision. deps replaces the mode
 * reader and the merge check, for tests.
 */
export async function gate(input, { mode = readMode, check = checkMerge, env = process.env } = {}) {
  const f = fieldsOf(input);
  if (!f) return input?.hook_event_name === "PermissionRequest" ? UNREAD_REQUEST : deny(UNREADABLE);
  if (f.event === "PermissionRequest") {
    if (f.tool !== "Bash" || f.child || !mode(f.session, env).autopilot) return undefined;
    const merge = policy.mergeIn(f.command);
    if (!merge || merge.problem) return undefined;
    return (await check(merge, f.cwd, env)).ok === true ? ALLOW : undefined;
  }
  if (f.tool === "apply_patch") {
    const paths = patchPaths(f.command);
    if (!paths.length) return deny("sage: the hook could not read this patch, so it refuses it. Send one patch from *** Begin Patch to *** End Patch.");
    if (paths.some((path) => CODEX_SEGMENT.test(resolve(f.cwd, path)))) return deny(CODEX_FOLDER);
    return chiefEditDenied({ sage: mode(f.session, env).sage, chief: !f.child }) ? deny(CHIEF) : undefined;
  }
  if (codexShellWrite(f.command, f.cwd)) return deny(CODEX_FOLDER);
  const merge = policy.mergeIn(f.command);
  if (!merge) return undefined;
  const { sage, autopilot } = mode(f.session, env);
  if (!sage) return undefined; // outside sage mode the gate does not judge merges, as in the Claude hook
  if (merge.problem) return deny(`sage: ${merge.problem}`);
  if (f.child) return deny(AGENT_MERGE);
  if (!autopilot) return deny(AUTOPILOT_OFF);
  const verdict = await check(merge, f.cwd, env);
  return verdict.ok === true ? undefined : deny(verdict.reason ?? "sage: the merge check refuses.");
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let input;
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {}
  let output;
  try {
    output = await gate(input);
  } catch {
    // Never let a merge or an edit through because the gate failed.
    output = input?.hook_event_name === "PermissionRequest" ? UNREAD_REQUEST : deny(UNREADABLE);
  }
  if (output) process.stdout.write(JSON.stringify(output));
}
