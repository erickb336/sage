#!/usr/bin/env node
// The sage gates for Codex (T456). Codex sends one PreToolUse or PermissionRequest event on stdin; the hook answers with
// one JSON object on stdout, or nothing. The rules come from core and the state tool, as in the Claude sage hook:
//   - A .codex folder: no thread, in any mode, writes under a folder named .codex (apply_patch, or a plain shell write
//     form that names one), because Codex reads project settings from it.
//   - The chief: in sage mode the root thread (no agent_id) changes no file with apply_patch. A child may.
//   - A read-only role: in sage mode a child whose task name names a role that core keeps from editing (a reviewer, QA,
//     the PE) changes no file with apply_patch. The task name is the last part of the agent path in the first line of
//     the child's transcript, as the report gate reads it.
//   - The sage folder: no thread, in any mode, runs a shell command that names the Codex sage folder (the logbook and the
//     mode files) or that resumes or forks a Codex session, so an agent cannot forge a mode file or a typed message.
//   - A merge (sage mode): only the one merge form of core, only on the root thread, only with autopilot on and a passing
//     merge check for that head SHA. Autopilot counts only when the mode file and the user's own typed messages in
//     Codex's transcript of the thread both give it, so a forged mode file alone unlocks nothing. PreToolUse denies every
//     other merge with one reason line. PermissionRequest allows the escalation of that exact command when the same
//     rules pass, so Codex shows no prompt; for every other request it declines to decide, so Codex shows its own prompt.
// It fails closed: a PreToolUse event that it cannot read is denied with one plain line. A PermissionRequest that it
// cannot read gets no decision, so the user decides in Codex's own prompt.
import { realpathSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chiefEditDenied, commandWrites, createCommandPolicy, PR, pullRequestHead, readModeFile, roleEditDenied, switchModes } from "../core/index.mjs";
import { patchPaths, readState, stateKey } from "./principles-hook.mjs";
import { modeDirectory } from "./sage-codex-hook.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TOOL = join(ROOT, "skills/sage/sage.mjs");
const policy = createCommandPolicy({ stateToolPath: TOOL, prPattern: PR });

export const UNREADABLE = "sage: the hook could not read this tool call, so it refuses it. Codex may have changed its hook input: update the sage plugin, or tell the user.";
const CODEX_FOLDER = "sage: no agent changes files under a .codex folder, because Codex reads its project settings there. Ask the user to make this change.";
const CHIEF = 'sage: sage mode is on, so the chief does not change files. Brief an implementer to make this change. The user ends sage mode with the message "sage mode off", alone.';
const AGENT_MERGE = "sage: an agent never merges. Report the pull request as ready.";
const AUTOPILOT_OFF = 'sage: autopilot is off, so the user merges. Report the pull request as ready. The user turns it on with the message "autopilot on", alone.';
const SAGE_FOLDER = "sage: no agent runs a shell command that names the Codex sage folder, because the logbook and the mode files are there. Use the sage MCP tools for the logbook.";
const RESUME = "sage: no agent resumes or forks a Codex session from the shell, because its prompts would count as the user's. Ask the user.";
const READ_ONLY = (role) => `sage: a ${role} reviews and changes no files; report the finding instead.`;
const UNREAD_ROLE = "sage: the hook could not read this agent's task name from its transcript, so it refuses the edit. Tell the user.";

/** A path segment named .codex, in any letter case (the Mac file system ignores case). */
const CODEX_SEGMENT = /(?:^|[\s/\\'"=:<>])\.codex(?=$|[\s/\\'"<>;|&)])/i;
const text = (value) => typeof value === "string" && value.length > 0 && value.length <= 4096;
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * The modes that the user's own typed messages in Codex's transcript of the thread give, replayed with the core rules.
 * Codex writes each typed message as an item_completed event with a UserMessage item and the thread's id. A fork's
 * copied items keep the parent's id, so a fork starts off, as in the mode hook. A transcript that cannot be read gives off.
 */
export function typedModes(transcript, session) {
  const state = {};
  let lines = [];
  try { lines = readFileSync(transcript, "utf8").split("\n"); } catch { return { sage: false, autopilot: false }; }
  for (const line of lines) {
    let item;
    try { item = JSON.parse(line); } catch { continue; }
    const p = item?.payload;
    if (item?.type !== "event_msg" || p?.type !== "item_completed" || p.thread_id !== session || p.item?.type !== "UserMessage") continue;
    const text = (Array.isArray(p.item.content) ? p.item.content : []).filter((c) => c?.type === "text").map((c) => c.text).join("");
    switchModes({ owner: true, text, all: text }, state, { autopilotOn: () => "" });
  }
  return { sage: state.sage === true, autopilot: state.sage === true && state.autopilot === true };
}

/**
 * The mode of the session's root thread: { sage, autopilot }. The mode hook keeps it in one file for each thread, with
 * the core reader: no file is no mode, and a damaged file is off. Autopilot also needs the user's typed messages.
 */
export function readMode({ session, transcript }, env = process.env) {
  const { state } = readModeFile(readState, join(modeDirectory(env), `${stateKey({ session_id: session })}.json`));
  const sage = state.sage === true;
  return { sage, autopilot: sage && state.autopilot === true && typeof transcript === "string" && typedModes(transcript, session).autopilot };
}

/** The role of a sage child from the task name in its transcript (sage_<role with _ for ->_t<n>), or null for another child. */
export function childRole(transcript) {
  const meta = JSON.parse(readFileSync(transcript, "utf8").split("\n", 1)[0]);
  if (meta?.type !== "session_meta") throw Error("no session_meta");
  const task = /^sage_([a-z_]+?)_t\d+$/.exec(String(meta.payload?.agent_path ?? "").split("/").at(-1));
  return task ? task[1].replaceAll("_", "-") : null;
}

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Whether a shell command names the Codex sage folder: its path (also from ~ or $HOME), $SAGE_HOME, or $CODEX_HOME/sage. */
export function namesSageFolder(command, env = process.env) {
  const dir = dirname(dirname(modeDirectory(env)));
  const forms = new Set([dir]);
  try { forms.add(realpathSync.native(dir)); } catch { /* not made yet */ }
  const home = env.HOME || homedir();
  for (const form of [...forms]) if (form.startsWith(`${home}/`)) for (const start of ["~", "$HOME", "${HOME}"]) forms.add(start + form.slice(home.length));
  const paths = [...forms].map((form) => `(?<![\\w.~/$-])${escape(form)}(?=$|[/\\s'"\`;|&)<>:])`);
  return new RegExp([...paths, "\\$\\{?SAGE_HOME\\b", "\\$\\{?CODEX_HOME\\}?/sage(?![\\w.-])", "\\.hooks/codex"].join("|"), "i").test(command);
}

const WRAPPERS = new Set(["env", "exec", "command", "nohup", "sudo", "npx", "time"]);
/** Whether a simple command of a shell command runs codex with resume or fork. */
export function resumesSession(command) {
  return command.split(/[;&|\n()`]+/).some((part) => {
    const words = part.trim().split(/\s+/).map((word) => word.replace(/^['"]+|['"]+$/g, "").toLowerCase());
    const at = words.findIndex((word) => !/^\w+=/.test(word) && !WRAPPERS.has(word));
    return at >= 0 && /(?:^|\/)codex(?:\.exe)?$/.test(words[at]) && words.slice(at + 1).some((word) => word === "resume" || word === "fork");
  });
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
  const transcript = typeof input.transcript_path === "string" ? input.transcript_path : null;
  return { event: input.hook_event_name, session: session_id, cwd, tool: tool_name, command: tool_input.command, child: Object.hasOwn(input, "agent_id"), transcript };
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
    if (f.tool !== "Bash" || f.child || !mode(f, env).autopilot) return undefined;
    const merge = policy.mergeIn(f.command);
    if (!merge || merge.problem) return undefined;
    return (await check(merge, f.cwd, env)).ok === true ? ALLOW : undefined;
  }
  if (f.tool === "apply_patch") {
    const paths = patchPaths(f.command);
    if (!paths.length) return deny("sage: the hook could not read this patch, so it refuses it. Send one patch from *** Begin Patch to *** End Patch.");
    if (paths.some((path) => CODEX_SEGMENT.test(resolve(f.cwd, path)))) return deny(CODEX_FOLDER);
    const { sage } = mode(f, env);
    if (!f.child) return chiefEditDenied({ sage, chief: true }) ? deny(CHIEF) : undefined;
    if (!sage || f.transcript === null) return undefined;
    let role, readOnly;
    try {
      role = childRole(f.transcript);
      readOnly = role !== null && roleEditDenied({ sage, role }); // core throws for a role that it does not know
    } catch { return deny(UNREAD_ROLE); }
    return readOnly ? deny(READ_ONLY(role)) : undefined;
  }
  if (namesSageFolder(f.command, env)) return deny(SAGE_FOLDER);
  if (resumesSession(f.command)) return deny(RESUME);
  if (codexShellWrite(f.command, f.cwd)) return deny(CODEX_FOLDER);
  const merge = policy.mergeIn(f.command);
  if (!merge) return undefined;
  const { sage, autopilot } = mode(f, env);
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
