#!/usr/bin/env node
// The sage gates for Codex (T456). Codex sends one PreToolUse or PermissionRequest event on stdin; the hook answers with
// one JSON object on stdout, or nothing. The rules come from core and the state tool, as in the Claude sage hook:
//   - A .codex folder: no thread, in any mode, writes under a folder named .codex inside the project (apply_patch, or
//     a plain shell write form that names one), because Codex reads project settings from it. A direct patch in a
//     trusted managed checkout may pass only after exact path and repository verification.
//   - The thread: Codex's record of the thread (the session_meta line that starts transcript_path) says which thread
//     an event comes from. Only the session's root thread is the chief. A thread that Codex starts itself (its review
//     thread, guardian) shares the session id and has no agent_id, but its record names a subagent source or another
//     thread id: it counts as a read-only role agent. A child whose record cannot be read is read-only and starts nothing.
//   - The chief: in sage mode the root thread changes no file with apply_patch. A child may.
//   - A read-only role: in sage mode the leaf sage name (the last part of the agent path that starts with sage_) decides
//     the edit rule. Under a role that core keeps from editing (a reviewer, QA, the PE, the lead), a child changes no
//     file, with apply_patch or with a shell write form (core's commandWrites, or Codex's own apply_patch program).
//     Each sage name above the leaf must be a lead's, or the child changes no file. A part that starts with sage_ but
//     is not a sage task name counts as a read-only role.
//   - The logbook: the chief records it, and a lead (a child of the root thread named sage_lead_t<n>, while its task's lead
//     run runs) records its own task with the sage MCP tools of LEAD_RULES. Any other child, in any mode, calls only the
//     tools that read, also a child named like a chief: only the root thread is the chief. No child writes with the
//     plugin's state tool from the shell (never its MCP server).
//   - Only a lead starts agents: a child under a sage_ name, in any mode, gets no spawn_agent. The one exception is a
//     lead (sage_lead_t<n>, with only leads above it), which starts core's TEAM roles with its own t<n>, while its lead
//     run runs and its task can move.
//   - No sage child, in any mode, sends a message to another thread (multi-agent v1's send_input, v2's send_message
//     and followup_task): its message to the root thread would start a root turn as if the user typed it. No thread,
//     in any mode, also the root, sends to the root thread: Codex records it as the user's typed message (R1940-1).
//   - gh in sage mode: only the gh command paths that sage uses (a group and its subcommand, such as pr view), by name,
//     and no setting before gh that changes what it runs or reads (its pager, editor, browser, HOME or config folder),
//     because an alias, an extension or such a program can run any gh command, also a merge (R1940-2, R1948, F-T534-1).
//   - Multi-agent v1's send_input: none in sage mode (sage sends with v2).
//   - The sage folder: no thread, in any mode, runs a shell command that names the Codex sage folder (the logbook and the
//     mode files) or the Codex sessions folder, so an agent cannot forge a mode file or a typed message.
//   - Codex from the shell: no thread, in any mode, runs codex except codex --version, -V, --help or -h. A new session
//     (codex exec) runs outside the hooks of this session, and a resumed session, a fork or a queued message (codex
//     queue) gives Codex a prompt that it records as the user's typed message, also "autopilot on" (R1981-1). Codex is
//     its name, or the real file of a Codex executable (not every program of its package: Codex puts its own rg first
//     on PATH).
//   - A push (sage mode): only core's push form, as in the Claude hook.
//   - The gate's proof: for each sage MCP call that it lets through, the gate saves a proof by the call's id, with the
//     caller's role and task, and the sage MCP server serves no call without one, so sage does not work while Codex runs
//     no sage hook. The server applies the caller's rule again (callerRefusal).
//   - Codex's settings: no thread, in any mode, writes Codex's config file (the hook trust) or this plugin's folder
//     from the shell.
//   - Code mode: Codex runs no hook for its exec tool, but each tool call inside the code comes here with its own name,
//     as a direct call does (T541). The js tool of Codex's REPL servers (mcp__node_repl__js, mcp__cua_repl__js, by the
//     MCP hook name of Codex 0.164.0 handlers/mcp.rs:139-161) runs
//     its code in its own process, where no hook sees a shell command. The owner chose to allow it, so the manifest
//     does not match it and the gate never sees it.
//   - A merge (T677): only sage's merge command (skills/sage/merge.mjs) merges, in its one exact form, from the root
//     thread. A recognized gh merge, and a run of merge.mjs in any other form, is refused in every mode and thread.
//     The gate admits the exact form only when, in this order: the mode file has sage mode and autopilot on; the Codex
//     that runs is 0.164 to 0.166 (its own --version: a resume writes no version into the record); the owner record
//     reader reads Codex's record and finds autopilot on after the session's start mark, and that mark is of the Codex
//     process that runs now (its pid, F-T663-22); the call itself is in the record after the mark; node and gh are
//     outside every folder that Codex's sandbox can write; the repository is known; and checkMerge passes. Then it
//     saves the call's one-time merge permit. PermissionRequest allows the escalation of that call only with a matching
//     unused permit (same session, turn, exact command and working folder); for every other request it declines to
//     decide, so Codex shows its own prompt. Non-Sage MCP and arbitrary interpreter programs remain outside this
//     bounded shell-command guard; merge.mjs itself checks the permit, the record and the mode file again.
// It fails closed: a PreToolUse event that it cannot read is denied with one plain line. A PermissionRequest that it
// cannot read gets no decision, so the user decides in Codex's own prompt.
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { accessSync, constants, existsSync, linkSync, mkdirSync, readdirSync, realpathSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chiefEditDenied, commandWrites as knownCommandWrites, createCommandPolicy, createPushPolicy, gitInternalPath, LOGBOOK_FILES, partNames, PR, programName, programsRun, pullRequestHead, readModeFile, roleEditDenied, sharedRoot, shellCommands, shellWriteEvidence, shellExecutionUncertain, TEAM } from "sage-core";

// Codex treats executable stdin conservatively without changing other callers' known-write classification.
const commandWrites = (text, cwd) => knownCommandWrites(text, cwd) || shellExecutionUncertain(text, cwd);
import { tool } from "../skills/sage/sage.mjs";
import { verificationOptions } from "../skills/sage/verify-install.mjs";
import { privateDirectory, readState, stateKey } from "./principles-hook.mjs";
import { patchTargets } from "../runtime/patch-targets.mjs";
import { managedPatchPath } from "../runtime/managed-worktree.mjs";
import { agentPathOf, sageName, sessionMeta, TASK_NAME } from "./report-gate.mjs";
import { modeDirectory } from "./sage-codex-hook.mjs";
import { autopilotSwitch, callInRecord, readRecord, RECORD_VERSION } from "./owner-record.mjs";
import { markFile } from "./start-mark.mjs";
import { mergeCommand, permitFile, permitFolder } from "../skills/sage/merge.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TOOL = join(ROOT, "skills/sage/sage.mjs");
const SERVER = join(ROOT, "mcp/state-server.mjs");
const policy = createCommandPolicy({ stateToolPath: TOOL, prPattern: PR });
/** git's output for args in the checkout at dir, or undefined when git fails (the Claude hook's reader). */
const readGit = (dir, args) => {
  try {
    return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined } });
  } catch { return undefined; }
};
/** gh's output for args (a GET of GitHub's API), or undefined when gh fails. GH_HOST and GH_REPO never change its target. */
const readGh = (args) => {
  try {
    return execFileSync("gh", args, { encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, GH_HOST: undefined, GH_REPO: undefined } });
  } catch { return undefined; }
};
const pushes = createPushPolicy({ stateToolPath: TOOL, readGit, readGh });
const GIT_FOLDER = "sage: in sage mode no thread changes files under a .git folder, where git keeps its hooks and settings. Ask the user";

const UNREADABLE = "sage: the hook could not read this tool call, so it refuses it. Codex may have changed its hook input: update the sage plugin, or tell the user.";
const CODEX_FOLDER = "sage: no agent changes files under a .codex folder, because Codex reads its project settings there. Ask the user to make this change.";
const CODEX_SETTINGS = "sage: no agent writes Codex's config file or the sage plugin's folder from the shell, because the trust of sage's hooks is there. Ask the user to make this change.";
const CHIEF = 'sage: sage mode is on, so the chief does not change files. Brief an implementer to make this change. The user ends sage mode with the message "sage mode off", alone.';
const OWNER_MERGE = "sage: in Codex, only sage's merge command merges, on autopilot, as the chief's instructions say. Without autopilot, the owner merges the pull request in GitHub";
const LOGBOOK_FILE = "sage: in sage mode, no agent writes a logbook file by its name outside the project. Use the sage MCP tools for the logbook.";
const SAGE_FOLDER = "sage: no agent runs a shell command that names the Codex sage folder, the shared root or the Codex sessions folder, and no patch changes them, because the logbook, the mode files and the user's typed messages are there. Use the sage MCP tools for the logbook.";
const CODEX_RUN = "sage: no agent runs codex from the shell, except codex --version and codex --help, because a new session runs outside these hooks, and Codex records the prompt of a resumed, forked or queued turn as the user's typed message, also a mode phrase. Ask the user.";
const READ_ONLY = (role) => `sage: in sage mode, the ${role} agent changes no files. Report the finding instead.`;
const LEAD_EDIT = "sage: a lead changes no files. Start an implementer of your task to make this change.";
const BAD_NAME = (name) => `sage: "${name}" starts with sage_ but is not a sage task name (sage_<role>_t<n>_r<k>), so this agent counts as a read-only role: it changes no files. Report instead.`;
const BAD_CHAIN = (name) => `sage: "${name}" is above this agent in its agent path, and only a lead (sage_lead_t<n>) has sage agents under it, so this agent changes no files. Report instead.`;
const UNREAD_ROLE = "sage: the hook could not read this agent's task name from Codex's record of its thread, so it refuses this call. Tell the user.";
const UNREAD_CODEX = "sage: the hook could not read this shell command, and it names codex, so it refuses it. Write the command in a plainer form.";
const CHILD_LOGBOOK = "sage: role agents report; only the chief records the logbook. Put this in your report.";
const LEAD_LOGBOOK = (name) => `sage: a lead records only its own task, and ${name} is not one of its tools. Put what the logbook needs in your report.`;
const CHILD_SPAWN = "sage: role agents start no agents; only the chief and a lead do. Put what you need in your report.";
const TEAM_NAMES = [...TEAM].map((role) => role.replaceAll("-", "_")).join(", ").replace(/, (?=[^,]*$)/, " or ");
const LEAD_SPAWN = (task, name) => `sage: a lead starts only the team of its own task: sage_<role>_t${task}_r<k>, where the role is ${TEAM_NAMES}. ${JSON.stringify(name ?? "no task_name")} is not one of these. Put what else you need in your report.`;
const LEAD_RESUME = "sage: a lead restarts no agent, because each agent works only from its checked brief. To go on with its work, start a new agent on a new run, with a new brief.";
const CHILD_SEND = "sage: agents send no input to another thread, because a message to the chief's thread would count as the user's. Put it in your report.";
const LEAD_SEND = "sage: a lead sends no message to an agent, because each agent works only from its checked brief. To steer your team, start a new agent on a new run, with a new brief.";
const ROOT_SEND = "sage: no thread sends input to the session's main thread, because Codex counts that message as the user's own typed message, also a mode phrase. Put it in your reply or your report.";
const V1_REFUSED = "sage: in sage mode, no thread uses multi-agent v1's send_input, because Codex can deliver it to the main thread as the user's typed message. sage sends with multi-agent v2.";
const GH_LITERAL = "sage: in sage mode, run gh by its name or by a path that ends in /gh, not from a variable or a substitution, so that the gate can read the command.";
const GH_SETUP = "sage: in sage mode, no setting before gh changes what it runs or reads: its pager, editor or browser, HOME or its config folder. Ask the user.";
const GH_PATH = (path) => `sage: in sage mode, gh runs only the commands that sage uses (${GH_LIST}), because "gh ${path}" can be an alias or an extension that runs any gh command, also a merge. Write one of these, or ask the user.`;

/** The sage MCP tools that only read the logbook: a child may call these, and pages without record, run or text. */
export const CHILD_READS = new Set(["status", "standing", "merge_check"]);
const SAGE_TOOL = /^mcp__sage__(.+)$/;
/**
 * Codex's hook names of the tools that start an agent: spawn_agent (the default and the multi_agent_v1 forms), or with its
 * namespace before it (collaborationspawn_agent), and resume_agent (multi_agent_v1resume_agent), which restarts a closed agent.
 */
const SPAWN = /(?:spawn|resume)_agent$/;
/**
 * Codex's hook names of the tools that send a message to another thread: multi-agent v1's send_input (with its
 * namespace or not), and v2's send_message and followup_task in any namespace (Codex 0.164.0 spec_plan.rs:1489-1508;
 * the hook name is the namespace, then the name, registry.rs:943-951; features.multi_agent_v2.tool_namespace renames
 * the default collaboration, F-T534-3). An MCP tool (mcp__<server>__<tool>) is not one of them.
 */
const SEND_INPUT = /^(?:(?:multi_agent_v1)?send_input|(?!mcp__).*(?:send_message|followup_task))$/;
/** Multi-agent v1's send tool: sage dispatches with v2, so in sage mode no thread uses it (R1948). */
const V1_SEND = /^(?:multi_agent_v1)?send_input$/;
/** A thread id as Codex reads it (Uuid::parse_str): any letter case, with or without hyphens, braces or urn:uuid:. */
const uuidOf = (value) => {
  const id = value.trim().toLowerCase().replace(/^urn:uuid:/, "").replace(/^\{(.*)\}$/, "$1").replaceAll("-", "");
  return /^[0-9a-f]{32}$/.test(id) ? id : null;
};
/**
 * Whether a send's target is the session's main thread: its thread id is the session id (every shell has it as
 * CODEX_THREAD_ID), and its agent path is /root. Codex delivers such a message as user input, runs the prompt hook for
 * it and records it as a UserMessage, so it would count as the owner's typed phrase (R1940-1). A target that is not
 * text cannot be read, so it counts too. Only the target counts, not the message text (R1947 F2).
 */
function sendsToRoot(target, session) {
  if (typeof target !== "string") return true;
  const id = uuidOf(target);
  if (id || target.trim() === session) return target.trim() === session || id === uuidOf(session);
  return `/${target.trim()}`.replace(/\/+/g, "/").replace(/(.)\/$/, "$1") === "/root";
}
/**
 * The gh command paths that sage uses, from the gh 2.101.0 man pages: a group with its subcommands, or a command with
 * none (null). Any other word path, at either level, can be an alias (also of two words, "pr mrg") or an extension,
 * which can run any gh command (R1940-2, R1946-2, F-T534-1). So alias, extension and config are not in it.
 */
const GH_PATHS = {
  pr: ["checkout", "checks", "close", "comment", "create", "diff", "edit", "list", "merge", "ready", "reopen", "review", "status", "view"],
  issue: ["close", "comment", "create", "edit", "list", "reopen", "status", "view"],
  repo: ["clone", "list", "view"], run: ["list", "rerun", "view", "watch"], workflow: ["list", "view"], release: ["list", "view"],
  search: ["code", "commits", "issues", "prs", "repos"], auth: ["status"], label: ["list"], api: null, status: null, version: null,
};
const GH_LIST = Object.entries(GH_PATHS).map(([group, subs]) => (subs ? `${group} ${subs.join("|")}` : group)).join(", ");
const GH_HELP = /^(?:--version|--help|-h)$/;
/** The settings that make gh run another program or read another config (its pager, editor, browser, aliases, F-T534-1 HOME). */
const GH_SETTINGS = /(?:^|[^\w])(?:GH_PAGER|PAGER|BROWSER|GH_BROWSER|EDITOR|GH_EDITOR|VISUAL|GH_CONFIG_DIR|XDG_CONFIG_HOME|HOME)\s*=/;
/**
 * Why a shell command's gh run is refused in sage mode, or undefined (R1940-2, R1946-2, R1947-1, F-T534-1): gh from a
 * variable or a substitution, a setting before gh that changes what it runs or reads, or a word path that is not in
 * GH_PATHS. The path is gh's first two words, with no option before or between them. A command that the reader cannot
 * read is left to the merge rule.
 */
function ghProblem(command, cwd, env) {
  let runs;
  try { runs = programsRun(command, cwd, env.PATH ?? ""); } catch { return undefined; }
  if (/\bgh\b/.test(command) && runs.some((p) => /[$`…]/.test(p.word))) return GH_LITERAL;
  const gh = runs.filter((p) => programName(p.word) === "gh");
  if (!gh.length) return undefined;
  if (GH_SETTINGS.test(command)) return GH_SETUP;
  for (const { args: [group, sub] } of gh) {
    if (group === undefined || GH_HELP.test(group)) continue;
    const subs = Object.hasOwn(GH_PATHS, group) ? GH_PATHS[group] : undefined;
    if (subs === undefined) return GH_PATH(group);
    if (subs !== null && sub !== undefined && !GH_HELP.test(sub) && !subs.includes(sub)) return GH_PATH(`${group} ${sub}`);
  }
  return undefined;
}
const childMayCall = (name, input) => CHILD_READS.has(name) || (name === "pages" && ["record", "run", "text"].every((key) => input[key] === undefined));

/** The verdict kinds that a lead records: each has a kept report behind it. A checks verdict is the chief's. */
const LEAD_KINDS = new Set(["review-clean", "security-clean", "ux-clean", "qa-pass", "qa-fail", "findings"]);
/** The state moves of a cycle that a lead makes, by the task's state, as in the Claude hook. A held task moves only by the chief. */
const LEAD_MOVES = { briefed: ["building"], building: ["reviewing"], reviewing: ["verifying"], repairing: ["reviewing"], verifying: ["verified", "reviewing"], verified: ["reviewing"] };
/** The states in which a lead records nothing. */
const LEAD_STOPS = ["held", "replan", "merged", "concluded", "abandoned"];
const roundKeys = (task) => String(task.keys ?? "").split(",").filter(Boolean);
/** An open fix finding of the task's current round, at any severity, as the Claude hook's roundFixOpen. */
const roundFixOpen = ({ own, task, view }) => view.findings(own).some((f) => f.status === "open" && f.triage === "fix" && roundKeys(task).includes(f.key));
const notOwn = (id, own) => `${id} is not of ${own}, and a lead records only its own task`;
/** A repair goes through round, so the rounds count and a task can reach held: no close and no verdict on a new commit before it. */
const roundFirst = ({ own, task, view }) => (task.state !== "repairing" && view.findings(own).some((f) => f.status === "open" && f.triage === "fix" && f.severity !== "low")
  ? `${own} has a medium or high finding triaged fix and is not repairing: ${["reviewing", "verifying"].includes(task.state) ? "run round first" : "move it to reviewing, run round"}, then repair` : undefined);
/** The fields that a lead sets with task_set. A lead sets a branch or a PR only of its own task, and moves no task onto a shared branch. */
const LEAD_FIELDS = {
  state: (state, context) => {
    const { own, task } = context;
    if (!(LEAD_MOVES[task.state] ?? []).includes(state)) return `${own} is ${task.state}: ${LEAD_MOVES[task.state] ? `a lead moves it only to ${LEAD_MOVES[task.state].join(" or ")}` : "only the chief moves it from there"}`;
    return task.state === "repairing" && roundFixOpen(context) ? `${own} has an open fix finding of its round: close each one after the repair's commit (finding_close), then move it to reviewing` : undefined;
  },
  branch: (branch, { own, task, view }) => {
    if (!tool.branchOfTask(task, branch) || (task.branch && !tool.branchOfTask(task, task.branch))) return `${JSON.stringify(branch)} is not a branch named for ${own}, or ${own} is on a branch of another task: only the chief sets that`;
    const shared = branch !== task.branch && [task.branch, branch].find((name) => name && [...view.branchTasks(name)].some((id) => id !== own));
    return shared ? `${shared} is shared with another task: only the chief moves a task onto a shared branch or off it` : undefined;
  },
  pr: (pr, { own, task, view }) => (/^[1-9]\d*$/.test(pr) && !task.pr && [...view.prTasks(pr)].every((id) => id === own) ? undefined : `a lead gives ${own} one PR, once, that no other task has or had`),
};
/**
 * What a lead may record, by sage tool, as the Claude hook's LEAD_WRITES, with fewer rules (the owner's rule of
 * 2026-10-26: the flow and the clean cycles must hold; trust agents otherwise). Each rule takes the call's input and
 * { own, task, view }, and gives the reason for a refusal, or undefined. callerRefusal checks the input's task first.
 * The state tool holds the rest for every caller: a verdict needs a kept report of its run, and one run backs one verdict.
 */
const LEAD_RULES = {
  run_add: ({ role, branch }, { own, task }) => {
    if (!TEAM.has(role)) return `a lead adds only runs of its team (${[...TEAM].join(", ")}), not ${JSON.stringify(role)}`;
    return branch === undefined || tool.ofTask(own, branch) || branch === task.branch ? undefined : `${branch} is not a branch of ${own}`;
  },
  run_done: ({ run }, { own, view }) => {
    const row = view.row(run);
    if (row?.task !== own) return notOwn(run, own);
    return TEAM.has(row.role) ? undefined : `${run} is a ${row.role} run: only the chief ends it`;
  },
  finding_add: ({ key }) => (key === undefined ? undefined : "only the chief opens a known finding again: leave out key"),
  finding_triage: ({ key, decision }, { own, task, view }) => {
    const row = view.row(key);
    if (row?.task !== own) return notOwn(key, own);
    if (row.triage === "ask") return `${key} is triaged ask: only the chief changes it, with the owner's answer`;
    if (decision === "fix") return undefined;
    if (decision === "ask") return "a lead asks the owner nothing: report the question";
    if (row.severity !== "low") return `${key} is ${row.severity}: a lead dismisses only a low finding. Report it, or triage it fix`;
    return row.triage === "fix" && (roundKeys(task).includes(key) || Number(row.round) < Number(task.round)) ? `${key} is a fix key of a round: only the chief dismisses it` : undefined;
  },
  finding_close: ({ key }, context) => {
    const { own, task, view } = context, row = view.row(key);
    if (row?.task !== own) return notOwn(key, own);
    if (row.triage !== "fix") return `${key} is not triaged fix, so a lead does not close it`;
    if (task.state === "repairing" && !roundKeys(task).includes(key)) return `${key} is not a fix of ${own}'s round: it waits for the next round`;
    return roundFirst(context);
  },
  verdict: ({ kind, pr, run, sha }, context) => {
    const { own, task, view } = context, row = view.row(run);
    if (!LEAD_KINDS.has(kind)) return `the ${kind} verdict is the chief's: give what it needs in your report`;
    if (!task.pr || String(pr) !== task.pr) return `a lead's verdict names its task's PR (${task.pr ? `pr ${task.pr}` : `${own} has none yet: set it with task_set`})`;
    if (row?.task !== own || row.round !== task.round) return `a lead's verdict names a run of ${own} in its current round ${task.round}, whose kept report backs it; ${JSON.stringify(run ?? "no run")} is not one`;
    return view.shas(own).has(String(sha ?? "").toLowerCase()) ? undefined : roundFirst(context);
  },
  round: () => undefined,
  pages: () => undefined,
  task_set: ({ fields }, context) => {
    for (const [key, value] of Object.entries(fields ?? {})) {
      const why = Object.hasOwn(LEAD_FIELDS, key) ? LEAD_FIELDS[key](value, context) : `a lead sets only ${Object.keys(LEAD_FIELDS).join(", ")} of its task, not ${key}`;
      if (why) return why;
    }
    return undefined;
  },
  brief: ({ task_name: name }, { own }) => (TEAM.has(taskRole(String(name))) && `T${taskNumber(name)}` === own ? undefined : `a lead records a brief only for the team of ${own}, not for ${JSON.stringify(name)}`),
};
const LEAD_SHELL = `sage: a lead records with the sage MCP tools (${Object.keys(LEAD_RULES).join(", ")}), not from the shell. Use one of these, or put what the logbook needs in your report.`;
/** Why a lead of this task and run neither records nor starts agents now, or undefined: its lead run ended, or its task cannot move. */
function leadStopped({ task: own, run }, view) {
  const task = view.task(own), lead = view.leadRun(own);
  if (!task || !lead || (run && lead.id !== run)) return `sage: ${own} has no running lead run${run ? ` ${run}` : ""}, so this lead records nothing and starts no agent. Report to the chief.`;
  return LEAD_STOPS.includes(task.state) ? `sage: ${own} is ${task.state}, so its lead records nothing and starts no agent. Report to the chief.` : undefined;
}
const UNREAD_LOGBOOK = (error) => `sage: the gate could not read the logbook for this lead (${error?.message ?? error}), so it refuses this call. Tell the chief.`;

/**
 * Why a caller may not make this sage tool call, or undefined. The gate asks it before it saves its proof, and the server
 * asks it again with the proof's caller, because the logbook can change between the two. The chief makes every call. A
 * lead's call must name its project and its task, while its lead run runs and its task can move. Any other child reads.
 * A logbook that the rule cannot read refuses.
 */
export function callerRefusal(caller, name, input, env = process.env) {
  if (caller.role === "chief") return undefined;
  const rule = caller.role === "lead" && Object.hasOwn(LEAD_RULES, name) ? LEAD_RULES[name] : undefined;
  if (!rule) return childMayCall(name, input) ? undefined : caller.role === "lead" ? LEAD_LOGBOOK(name) : CHILD_LOGBOOK;
  const own = caller.task;
  if (input.task !== undefined && input.task !== own) return `sage: ${notOwn(input.task, own)}. Report to the chief what ${input.task} needs.`;
  try {
    if (!caller.project || real(tool.projectRoot(input.project)) !== caller.project) return `sage: a lead records only the logbook of its own project, and ${JSON.stringify(input.project)} is not that project.`;
    const view = tool.logbookView(input.project, env), stopped = leadStopped(caller, view);
    if (stopped) return stopped;
    const why = rule(input, { own, task: view.task(own), view });
    return why && `sage: ${why}.`;
  } catch (error) {
    return UNREAD_LOGBOOK(error);
  }
}

/** A path segment named .codex, in any letter case (the Mac file system ignores case). */
const CODEX_SEGMENT = /(?:^|[\s/\\'"`=:<>])\.codex(?=$|[\s/\\'"`<>;|&)])/i;
const text = (value) => typeof value === "string" && value.length > 0 && value.length <= 4096;
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * The mode of the session's root thread: { sage, autopilot }. The mode hook keeps it in one file for each thread, with
 * the core reader: no file is no mode, and a damaged file is off. Autopilot counts only in sage mode.
 */
export function readMode({ session }, env = process.env) {
  const { state } = readModeFile(readState, modeFile(session, env));
  const sage = state.sage === true;
  return { sage, autopilot: sage && state.autopilot === true };
}
/** The mode file of the session's root thread. */
const modeFile = (session, env) => join(modeDirectory(env), `${stateKey({ session_id: session })}.json`);

/** The role of one sage task name (sage_<role with _ for ->_t<n>, with _r<k> or not), or null for a name that is not one. */
export function taskRole(name) {
  const task = TASK_NAME.exec(name);
  return task ? task[1].replaceAll("_", "-") : null;
}

const ROOT_THREAD = { child: false };
/**
 * The thread of one event: { child: false } for the session's root thread (the chief), or { child: true } with parts
 * (the agent path of a spawned agent), codex (the name of a thread that Codex starts itself, such as review or
 * guardian), or neither (a child whose record cannot be read; unread when it has no agent_id either). Codex's record of
 * the thread is the session_meta line that starts transcript_path: the root thread's id is the session id, and its
 * source names no subagent and no internal thread. An event with no agent_id and no transcript is the root thread of an
 * ephemeral session.
 */
export function threadOf(f) {
  let meta;
  if (f.transcript !== null) try { meta = sessionMeta(f.transcript); } catch { /* unread */ }
  if (!meta) return f.child ? { child: true } : f.transcript !== null ? { child: true, unread: true } : ROOT_THREAD;
  const source = record(meta.source) ? meta.source.subagent ?? meta.source.internal : undefined;
  if (source === undefined && !f.child && meta.id === f.session) return ROOT_THREAD;
  if (source === undefined ? f.child : record(source) && record(source.thread_spawn)) return { child: true, parts: agentPathOf(meta) };
  const name = typeof source === "string" ? source : record(source) ? (typeof source.other === "string" ? source.other : Object.keys(source)[0]) : undefined;
  return { child: true, ...(/^[a-z][\w-]{0,39}$/i.test(name ?? "") ? { codex: name.replaceAll("_", " ") } : {}) };
}

/** The names that the user knows for the threads that Codex starts itself, where Codex's own name differs: its guardian is the approval check. */
const CODEX_THREADS = { guardian: "approval check" };

/** Whether a child thread is under a sage_ name (a thread that Codex starts itself counts), or undefined when its record cannot be read. */
const underSage = (t) => (t.codex ? true : t.parts?.some(sageName));

const isLead = (name) => taskRole(name) === "lead";
/** The first sage name above the leaf of an agent path that is not a lead's, or undefined. */
const notLeadAbove = (parts) => parts.filter(sageName).slice(0, -1).find((name) => !isLead(name));
/** A lead with only leads above it. */
const realLead = (t) => isLead(t.parts?.at(-1)) && !notLeadAbove(t.parts);

/** Why the gate refuses a child's change of files in sage mode, or undefined: the leaf sage name decides. */
function childChange(t, sage) {
  if (!sage || !t.child) return undefined;
  if (t.codex) return READ_ONLY(`Codex ${CODEX_THREADS[t.codex] ?? t.codex}`);
  if (!t.parts) return UNREAD_ROLE;
  const leaf = t.parts.findLast(sageName);
  if (leaf === undefined) return undefined;
  const above = notLeadAbove(t.parts);
  if (above) return BAD_CHAIN(above);
  const role = taskRole(leaf);
  if (role === "lead") return LEAD_EDIT;
  if (role === "investigate" || role === "evidence-review") return READ_ONLY(role);
  let denied;
  try { denied = role !== null && roleEditDenied({ sage, role }); } catch { denied = undefined; } // core throws for a role that it does not know
  if (denied === undefined || role === null) return BAD_NAME(leaf);
  return denied ? READ_ONLY(role) : undefined;
}

/** The task number and the run number (or undefined) of a sage task name. */
const taskParts = (name) => /_t(\d+)(?:_r(\d+))?$/.exec(name).slice(1);
const taskNumber = (name) => taskParts(name)[0];
/** The task and the run (when the name has one) of a lead's name. */
const leadOf = (name) => {
  const [task, run] = taskParts(name);
  return { task: `T${task}`, ...(run ? { run: `R${run}` } : {}) };
};
/** Whether a thread records as a lead: only a child of the root thread is a lead, because only the chief starts one. */
const recordsAsLead = (t) => t.parts?.length === 2 && t.parts[0] === "root" && isLead(t.parts[1]);
/**
 * Who makes a sage tool call, as its proof says: { role: "chief" } for the root thread and no other, whatever a child's
 * name says; { role: "lead", task, run, project } for a lead; or { role: "child" }.
 */
function callerOf(t, cwd) {
  if (!t.child) return { role: "chief" };
  return recordsAsLead(t) ? { role: "lead", ...leadOf(t.parts[1]), project: real(tool.projectRoot(cwd)) } : { role: "child" };
}
/**
 * Why the gate refuses a spawn by a child under a sage name: only a lead, with only leads above it, starts agents, and
 * only core's TEAM roles with its own task number, while it could record (leadStopped). The name of the new agent is the
 * spawn's task_name. A logbook that the rule cannot read, or a project with none, refuses.
 */
function childSpawn(t, name, cwd, env) {
  const self = t.parts?.at(-1);
  if (!isLead(self) || notLeadAbove(t.parts)) return CHILD_SPAWN;
  const fits = typeof name === "string" && TEAM.has(taskRole(name)) && taskNumber(name) === taskNumber(self);
  if (!fits) return LEAD_SPAWN(taskNumber(self), name);
  try { return leadStopped(leadOf(self), tool.logbookView(cwd, env)); } catch (error) { return UNREAD_LOGBOOK(error); }
}

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/**
 * The words of a shell command as the shell reads them, without their quotes (core's command reader): each program
 * word, its arguments, the commands piped into it and each redirection target, with the folder it runs in. None when
 * the reader cannot read the command.
 */
function wordsOf(command, cwd, env) {
  try {
    const runs = programsRun(command, cwd, env.PATH ?? "");
    const targets = programsRun(command, cwd, env.PATH ?? "", { redirectEvidence: true, redirectParts: true });
    return [...runs.flatMap((p) => [p.word, ...p.args, ...p.stdin].map((word) => ({ word, dir: p.dir ?? cwd }))), ...targets.map((r) => ({ word: r.target ?? r.redirect, dir: r.dir ?? cwd }))];
  } catch { return []; }
}

const codexHome = (env) => resolve(env.CODEX_HOME ?? join(homedir(), ".codex"));
/**
 * Whether a shell command names the Codex sage folder (also from ~ or $HOME, $SAGE_HOME or $CODEX_HOME/sage), the
 * shared root (also from $SAGE_SHARED_HOME) or the Codex sessions folder: in its text, or in a word as the shell reads
 * it (without quotes, R1669-4), also as a path from the folder the word runs in. A .sage folder outside the project
 * counts too, by name, also as a pattern: a project's own .sage folder stays free.
 */
export const namesSageFolder = (command, env = process.env, cwd = "/") => names(command, env, cwd,
  [dirname(dirname(modeDirectory(env))), sharedRoot(env), join(codexHome(env), "sessions")], ["\\$\\{?SAGE_HOME\\b", "\\$\\{?SAGE_SHARED_HOME\\b", "\\$\\{?CODEX_HOME\\}?/(?:sage|sessions)(?![\\w.-])", "\\.hooks/codex"])
  || leavingPaths(command, env, cwd).some((path) => partsOf(path).some((part) => part.startsWith(".") && partNames(part, ".sage")));
/** Whether a shell command or a patch names a logbook file outside the project: the Claude hook's list. A project's own config.json stays free. */
const namesLogbookFile = (command, env, cwd) => leavingPaths(command, env, cwd).some((path) => partsOf(path).some((part) => /[a-z]/.test(part) && LOGBOOK_FILES.some((name) => partNames(part, name))));
const partsOf = (path) => path.toLowerCase().split("/");
/** A patch's path as a shell command, so that the shell rules read it as one word from the patch's folder. */
const asWord = (path) => `: '${path.replaceAll("'", "'\\''")}'`;
/**
 * The words of a command that may lead out of the project, as paths. A word with a variable has no known place, and
 * neither has any word of a line that the reader cannot read (it stops at "cd ~"), so each of those counts. A checkout
 * of the same repository, such as a task worktree in a sibling folder, is the project.
 */
function leavingPaths(command, env, cwd) {
  const home = env.HOME || homedir(), root = projectRoot(cwd), read = wordsOf(command, cwd, env);
  const start = (word) => word.replace(/^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/, home);
  if (!read.length) return command.split(/[\s;&|()<>`'"=]+/).filter(Boolean).map(start);
  return read.flatMap(({ word, dir }) => {
    const path = start(word);
    if (/[$`]/.test(path)) return [path];
    const place = relative(root, resolve(dir, path));
    return (place === ".." || place.startsWith("../") || isAbsolute(place)) && !sameRepository(resolve(dir, path), cwd) ? [resolve(dir, path)] : [];
  });
}
/** Whether a path's nearest .git entry is a checkout of the cwd's repository. Core verifies it: a planted .git file is a project of its own. */
function sameRepository(path, cwd) {
  const top = projectRoot(path);
  return existsSync(join(top, ".git")) && real(tool.projectRoot(top)) === real(tool.projectRoot(cwd));
}
/**
 * Whether a shell command names Codex's config file, which keeps the trust records of the hooks, or the folder of this
 * installed plugin, whose hooks are the gate (R1916-2): the same forms as the sage folder.
 */
export const namesCodexSettings = (command, env = process.env, cwd = "/") => names(command, env, cwd,
  [join(codexHome(env), "config.toml"), ROOT], ["\\$\\{?CODEX_HOME\\}?/(?:config\\.toml|plugins)(?![\\w.-])"]);

/** Whether a shell command names one of these paths, or matches one of these patterns, as namesSageFolder says. */
function names(command, env, cwd, dirs, patterns) {
  const forms = new Set(dirs);
  for (const dir of dirs) try { forms.add(realpathSync.native(dir)); } catch { /* not made yet */ }
  const home = env.HOME || homedir();
  for (const form of [...forms]) if (form.startsWith(`${home}/`)) for (const start of ["~", "$HOME", "${HOME}"]) forms.add(start + form.slice(home.length));
  const paths = [...forms].map((form) => `(?<![\\w.~/$-])${escape(form)}(?=$|[/\\s'"\`;|&)<>:])`);
  const named = new RegExp([...paths, ...patterns].join("|"), "i");
  const path = (word, dir) => resolve(dir, word.replace(/^~(?=\/|$)/, home));
  return named.test(command) || wordsOf(command, cwd, env).some(({ word, dir }) => named.test(word) || named.test(path(word, dir)));
}

/** A program word or script that names Codex: codex, codex.exe, codex.js, or the npm package @openai/codex (with a version). */
const CODEX_NAME = /(?:^|\/)codex(?:\.exe|\.js|@[\w.-]+)?$/i;
const real = (file) => { try { return realpathSync.native(file); } catch { return undefined; } };
const list = (dir) => { try { return readdirSync(dir); } catch { return []; } };
/** Codex's own names for its binary on PATH (the arg0 links): they apply a patch, they start no session. */
const PATCH_NAME = /^(?:apply_patch|applypatch)$/;
/**
 * The real files of the Codex executables, and only those: Codex puts other programs of its package on PATH (its own
 * rg in codex-path), and they are not Codex. The files: the codex that the hook's PATH finds; in each @openai/codex
 * package (the one of that codex, and Codex's own CODEX_MANAGED_PACKAGE_ROOT), the launcher bin/codex.js and the native
 * binary vendor/<target>/bin/codex (or vendor/<target>/codex/codex); and the binary of the running Codex, which is the
 * target of the apply_patch link in the codex-arg0 folder that Codex puts on PATH (also the desktop app's own binary).
 */
function codexExecutables(env) {
  const found = new Set();
  const add = (path) => { const at = path && real(path); if (at) found.add(at); };
  const path = env.PATH ?? "";
  let file;
  try { file = programsRun("codex", "/", path)[0]?.file; } catch { /* no codex on PATH */ }
  file = file && real(file);
  add(file);
  const roots = [env.CODEX_MANAGED_PACKAGE_ROOT];
  for (let dir = file && dirname(file); dir && dir !== dirname(dir); dir = dirname(dir)) {
    try { if (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).name === "@openai/codex") { roots.push(dir); break; } } catch { /* not the package */ }
  }
  for (const root of roots.filter(Boolean)) {
    add(join(root, "bin/codex.js"));
    const vendors = [join(root, "vendor"), ...list(join(root, "node_modules/@openai")).map((pkg) => join(root, "node_modules/@openai", pkg, "vendor"))];
    for (const vendor of vendors) for (const target of list(vendor)) for (const binary of ["bin/codex", "codex/codex"]) add(join(vendor, target, binary));
  }
  for (const dir of path.split(":")) if (basename(dir).startsWith("codex-arg0")) add(join(dir, "apply_patch"));
  return found;
}

/** Whether a codex run starts no session: it only prints the version or the help. */
const printsOnly = (args) => args.length > 0 && args.every((word) => /^(?:--version|-V|--help|-h)$/.test(word));

/**
 * The arguments of each codex program that a shell command runs (after the program, or after node's script), read by
 * core's command reader (also after wrappers and in the -c text of a shell), or null when the reader cannot read the
 * command, or when the command names codex and runs a program from an expansion ($X, $(…), a backtick). A program is
 * Codex by its name, by the real file of a Codex executable, or as node's script. Codex's apply_patch links are not.
 */
export function codexRuns(command, cwd = "/", env = process.env) {
  let runs;
  try { runs = programsRun(command, cwd, env.PATH ?? ""); } catch { return null; }
  if (/codex/i.test(command) && runs.some((p) => /[$`]/.test(p.word))) return null;
  const executables = codexExecutables(env);
  const codex = (word, file) => CODEX_NAME.test(word) || (Boolean(file) && executables.has(real(file)));
  const found = [];
  for (const p of runs) {
    if (PATCH_NAME.test(programName(p.word))) continue;
    if (codex(p.word, p.file)) { found.push(p.args); continue; }
    if (!/^(?:node|nodejs)$/i.test(programName(p.word))) continue;
    const at = p.args.findIndex((word) => !word.startsWith("-"));
    if (at >= 0 && codex(p.args[at], resolve(p.dir ?? cwd, p.args[at]))) found.push(p.args.slice(at + 1));
  }
  return found;
}
/** Whether a shell command runs Codex's apply_patch program, which writes files as the apply_patch tool does. */
const runsPatch = (command, cwd, env) => { try { return programsRun(command, cwd, env.PATH ?? "").some((p) => PATCH_NAME.test(programName(p.word))); } catch { return true; } };

/**
 * The read commands of the state tool, which a child may run from the shell: pages without record, logbook without
 * repair and standing without add (the state tool writes the logbook for each of these words).
 */
const STATE_READS = new Map([["status", null], ["merge-check", null], ["logbook", "repair"], ["standing", "add"], ["pages", "record"]]);
const readsOnly = ([command, ...rest]) => STATE_READS.has(command) && !rest.includes(STATE_READS.get(command));
const STATE_SCRIPT = /(?:^|\/)(?:skills\/sage\/sage\.mjs|mcp\/state-server\.mjs)$/;
// A command word is made only from plain path/option characters or fully literal quoted parts.
// This grammar admits no shell operation or expansion. The existing reader then removes the quotes.
const LITERAL_WORD = /(?:[A-Za-z0-9_./,:=+-]|'[^'\r\n]*'|"[^"$`\\\r\n]*")+/;
const LITERAL_COMMAND = new RegExp(`^[ \\t]*${LITERAL_WORD.source}(?:[ \\t]+${LITERAL_WORD.source})*[ \\t]*$`);
function namesVerification(command, cwd, env) {
  try {
    return programsRun(command, cwd, env.PATH ?? "").some(run => (run.args.includes("verify-install") || run.args.includes("--commit"))
      && ([run.word, ...run.args].some(word => STATE_SCRIPT.test(word) || real(resolve(run.dir ?? cwd, word)) === real(TOOL))
        || /sage\.mjs/.test(command)));
  } catch { return /sage\.mjs/.test(command) && /(?:^|\s)['"]?verify-install(?:['"]?(?:\s|$))/.test(command); }
}
/**
 * The new reads use one literal invocation of this provider's CLI. Codex's hook cwd supplies project authority;
 * neither the shell's cd/workdir nor --project grants it. Core verifies linked worktrees against their main checkout.
 */
function scopedStateRead(command, cwd, env, verification = false) {
  if (!LITERAL_COMMAND.test(command)) return false;
  try {
    const commands = shellCommands(command);
    if (commands.length !== 1) return false;
    const [{ words, bodies, grouped }] = commands;
    if (bodies.length || grouped || !/^(?:node|nodejs)$/.test(programName(words[0] ?? ""))) return false;
    const [, script, ...args] = words;
    const project = verification ? verificationOptions(args)?.project : tool.roleReadProject(args);
    if (!project || (args[0] === "board" && env.SAGE_BOARD_ROOTS)) return false;
    if (!isAbsolute(words[0]) || !isAbsolute(script ?? "") || real(script) !== real(TOOL)) return false;
    const evidence = programsRun(command, cwd, env.PATH ?? "", { contextEvidence: true });
    if (evidence.redirects.length || evidence.programs.length !== 1 || evidence.programs[0].wrapper) return false;
    if (real(evidence.programs[0].run.file) !== real(process.execPath)) return false;
    const assigned = real(tool.projectRoot(cwd)), requested = real(tool.projectRoot(project));
    return assigned !== undefined && requested === assigned;
  } catch { return false; }
}
/**
 * Whether a shell command runs the plugin's MCP server or a state tool command that writes the logbook: the plugin's
 * own copies by their real files, or any skills/sage/sage.mjs and mcp/state-server.mjs by name, directly or as node's
 * script. A node script from an expansion in a command that names one of them counts too.
 */
export function stateToolWrites(command, cwd = "/", env = process.env) {
  let runs;
  try { runs = programsRun(command, cwd, env.PATH ?? ""); } catch { return /sage\.mjs|state-server/.test(command); }
  const own = new Set([real(TOOL), real(SERVER)].filter(Boolean));
  for (const p of runs) {
    let script = p.file ?? p.word, args = p.args;
    if (/^(?:node|nodejs)$/i.test(programName(p.word))) {
      // A preload or eval option can execute before the CLI. Do not mistake its value for the CLI script.
      if (p.args[0]?.startsWith("-") && p.args.some(word => STATE_SCRIPT.test(word))) return true;
      const at = p.args.findIndex((word) => !word.startsWith("-"));
      if (at < 0) continue;
      script = p.args[at], args = p.args.slice(at + 1);
      if (/[$`]/.test(script)) { if (/sage\.mjs|state-server/.test(command)) return true; continue; }
      script = resolve(p.dir ?? cwd, script);
    }
    const file = real(script) ?? script;
    if (!own.has(file) && !STATE_SCRIPT.test(file) && !STATE_SCRIPT.test(script)) continue;
    if (/state-server\.mjs$/.test(file) || /state-server\.mjs$/.test(script)) return true;
    const words = args.filter((word) => !word.startsWith("-"));
    if (!readsOnly(words)) return true;
  }
  return false;
}

/**
 * The gate's proof of one sage tool call that it let through (R1916-2). Codex gives the hook the call's id as
 * tool_use_id and the sage MCP server the same id as _meta.callId, with the session id in both (Codex 0.164.0
 * registry.rs:701-706, hook_runtime.rs:195-206, mcp_tool_call.rs:542-553 and 1323-1334). So the server serves a call
 * only when the gate saw it: when Codex runs no sage hook (a sage update makes every hook Modified until the user trusts
 * it again), the server refuses. The proofs live in the mode folder, which the shell rules keep from every agent. A
 * proof also carries the caller (callerOf): the hook knows the thread, and the server does not.
 */
const proofFile = (env, id) => join(modeDirectory(env), "proofs", `${createHash("sha256").update(id).digest("hex")}.json`);
const comparisonHash = input => createHash("sha256").update(JSON.stringify([input?.project, input?.task, input?.run, input?.sha256])).digest("hex");
export function writeProof({ tool_use_id: id, session_id: session, tool_name: tool, tool_input: input }, env = process.env, caller) {
  if (!text(id)) throw Error("the call has no tool_use_id");
  const file = proofFile(env, id);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify({ session, tool, caller, ...(tool === "mcp__sage__report_compare" ? { comparison: comparisonHash(input) } : {}) }), { mode: 0o600 });
}
/** Whether a proof's caller has a form that callerOf gives. */
const callerForm = (c) => record(c) && (c.role === "chief" || c.role === "child" || (c.role === "lead" && /^T[1-9]\d*$/.test(c.task) && text(c.project) && (c.run === undefined || /^R[1-9]\d*$/.test(c.run))));
/** The caller of this MCP call of the sage tool name, from its _meta, or null when the gate did not see it; the proof serves one call only. */
export function takeProof(meta, name, env = process.env, input) {
  if (!record(meta) || !text(meta.callId)) return null;
  const file = proofFile(env, meta.callId);
  let proof;
  try { proof = JSON.parse(readFileSync(file, "utf8")); rmSync(file); } catch { return null; }
  const seen = proof?.tool === `mcp__sage__${name}` && proof.session === meta.sessionId
    && (name !== "report_compare" || proof.comparison === comparisonHash(input));
  return seen && callerForm(proof.caller) ? proof.caller : null;
}
export const NO_GATE = "sage's gate is not running: trust sage's hooks with /hooks in the Codex CLI (or the app's hook review), then try again.";

/** The merge check for one merge form: the pull request's head branch from gh, then the state tool's ledger check. */
export async function checkMerge({ pr, sha }, cwd, env = process.env, session) {
  let head;
  try {
    head = pullRequestHead(pr, cwd, env);
  } catch (error) {
    return { ok: false, reason: `sage: the hook could not read the head branch of PR ${pr} from GitHub (${error?.message ?? error}), so it refuses the merge. Try again, or tell the user.` };
  }
  try {
    const { tool } = await import("../skills/sage/sage.mjs");
    const verdict = tool.mergeCheck(sha, env, { pr, head, project: realpathSync.native(cwd), session });
    return verdict?.ok === true ? { ok: true } : { ok: false, reason: `sage: the merge check refuses: ${verdict?.reason}` };
  } catch (error) {
    return { ok: false, reason: `sage: the merge check could not run (${error?.message ?? error}), so it refuses every merge. Tell the user.` };
  }
}

/** A program that a command runs as merge.mjs: by its path, or as the script of node. */
const MERGE_SCRIPT = /(?:^|\/)merge\.mjs$/;
/**
 * Whether a shell command runs sage's merge command (any skills/sage/merge.mjs, F-T663-21), or names merge.mjs in a form
 * that the reader cannot read. A command that only names the file as data (cat, git diff) does not.
 */
function runsMerge(command, cwd, env) {
  if (!/merge\.mjs/.test(command)) return false;
  let runs;
  try { runs = programsRun(command, cwd, env.PATH ?? ""); } catch { return true; }
  return runs.some((p) => {
    if (/[$`]/.test(p.word) || MERGE_SCRIPT.test(p.word) || MERGE_SCRIPT.test(p.file ?? "")) return true;
    const script = p.args.find((word) => !word.startsWith("-"));
    return /^(?:node|nodejs)$/i.test(programName(p.word)) && (p.args.some((word) => /[$`]/.test(word)) || MERGE_SCRIPT.test(script ?? ""));
  });
}
/** The pull request and head SHA of the merge command's one exact form, or undefined. */
function mergeForm(command) {
  const [, pr, sha] = /^"[^"]+" "[^"]+" ([1-9]\d*) ([0-9a-f]{40})$/.exec(command) ?? [];
  return pr && command === mergeCommand(pr, sha) ? { pr, sha } : undefined;
}
const MERGE_FORM = `sage: run sage's merge command in its one form, alone: ${mergeCommand("<pr>", "<head sha>")}`;
const AGENT_MERGE = "sage: only the chief merges, not an agent. Report the pull request as ready";
const AUTOPILOT_OFF = 'sage: autopilot is off, so the owner merges. Report the pull request as ready. The owner turns autopilot on with the message "autopilot on", alone, while sage mode is on';
const READY = "Report the pull request as ready: the owner merges it in GitHub";
/** The folders that Codex's sandbox lets a command write: the project and its working folder, and the temporary folders. */
const writableRoots = (cwd, env, temporary) => [projectRoot(cwd), cwd, env.TMPDIR, ...temporary].filter(Boolean).map((dir) => real(dir) ?? resolve(dir));
/** The temporary folders that Codex's sandbox can write on every machine, beside TMPDIR. */
export const TEMPORARY = ["/tmp", "/private/tmp", "/var/tmp"];
const inside = (path, roots) => roots.some((root) => { const at = relative(root, path); return at === "" || (!at.startsWith("..") && !isAbsolute(at)); });
/** The hook's PATH without the folders that the sandbox can write (and without relative folders). */
const trustedPath = (roots, env) => (env.PATH ?? "").split(":").filter((dir) => isAbsolute(dir) && !inside(real(dir) ?? resolve(dir), roots)).join(":");
/** The real file of gh on the trusted PATH, outside every folder that the sandbox can write, or undefined. */
function trustedGh(roots, env) {
  for (const dir of trustedPath(roots, env).split(":")) {
    const file = real(join(dir, "gh"));
    try { if (file && !inside(file, roots) && statSync(file).isFile()) { accessSync(file, constants.X_OK); return file; } } catch { /* not a program */ }
  }
  return undefined;
}
/**
 * The version of the Codex that runs this hook, or null: Codex puts a codex-arg0 folder on the hook's PATH, whose
 * apply_patch link names its own binary (the CLI's and the desktop app's alike), and that binary prints its version.
 * It runs the link's real file: by the link's own name, the binary acts as apply_patch (R2690 proof: in real hooks,
 * "codex-cli 0.164.0" for the CLI, and "codex-cli 0.166.0-alpha.6" for the desktop binary that resumed a 0.164.0 record).
 */
function runningCodex(roots, env) {
  for (const dir of (env.PATH ?? "").split(":")) {
    if (!basename(dir).startsWith("codex-arg0")) continue;
    const binary = real(join(dir, "apply_patch"));
    if (!binary || inside(binary, roots)) continue;
    try {
      const out = execFileSync(binary, ["--version"], { env, encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
      return /^codex-cli (\S+)\s*$/.exec(out)?.[1] ?? null;
    } catch { return null; }
  }
  return null;
}
/** The repository (owner/name) that gh finds for the folder, or undefined. */
function repositoryOf(gh, cwd, env) {
  try {
    const name = execFileSync(gh, ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], { cwd, env: { ...env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" }, encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] }).trim();
    return /^[A-Za-z0-9][A-Za-z0-9-]*\/(?!\.\.?$)[A-Za-z0-9_.][A-Za-z0-9_.-]*$/.test(name) ? name : undefined;
  } catch { return undefined; }
}
const PERMIT_AGE = 300_000;
/** Save the call's merge permit: created once, never over another file, and old permits go. */
function savePermit(file, permit) {
  const dir = dirname(file);
  privateDirectory(dir);
  for (const name of readdirSync(dir)) {
    try { if (Date.now() - statSync(join(dir, name)).mtimeMs > PERMIT_AGE) rmSync(join(dir, name), { force: true }); } catch { /* gone already */ }
  }
  const temporary = `${file}.${randomUUID()}`;
  writeFileSync(temporary, JSON.stringify(permit), { flag: "wx", mode: 0o600 });
  try { linkSync(temporary, file); } finally { rmSync(temporary, { force: true }); }
}
/** Whether an unused merge permit of the last 300 s admits this escalation: the same session, turn, exact command and folder. */
function permitted(f) {
  let names;
  try { names = readdirSync(permitFolder); } catch { return false; }
  return names.some((name) => {
    if (!/^[0-9a-f]{64}\.json$/.test(name)) return false;
    let permit;
    try { permit = readState(join(permitFolder, name)); } catch { return false; }
    return permit?.session === f.session && permit.turn === f.turn && permit.command === f.command && permit.cwd === f.cwd && Date.now() - permit.time <= PERMIT_AGE;
  });
}

/**
 * The gate's admission of the merge command's exact form from the root thread: undefined when it saved the call's
 * merge permit, else the reason to refuse. ppid is the Codex process that runs the hook.
 */
async function admit(f, merge, { env, check, ppid, temporary }) {
  const mode = modeFile(f.session, env);
  const { state } = readModeFile(readState, mode);
  if (state.sage !== true || state.autopilot !== true) return AUTOPILOT_OFF;
  const roots = writableRoots(f.cwd, env, temporary);
  const version = runningCodex(roots, env);
  if (!RECORD_VERSION.test(version ?? "")) return `sage: ${version ? `this session runs Codex ${version}` : "sage cannot tell which Codex runs this session"}, and autopilot merges only in Codex 0.164 to 0.166. ${READY}`;
  const codexRecord = readRecord(f.transcript ?? "");
  if (codexRecord.refused) return `sage: ${codexRecord.refused}`;
  let mark;
  try { mark = readState(markFile(modeDirectory(env), f.session)); } catch { mark = undefined; }
  // A mark that a failed start left (its removal failed too) names the Codex process of an earlier start (F-T663-9).
  if (record(mark) && mark.pid !== ppid) return `sage: sage's note of this session start is from another Codex process, so autopilot merges nothing in this session for now. ${READY}, or resume the session and send "autopilot on" again`;
  const owner = autopilotSwitch(codexRecord, mark);
  if (owner.refused) return `sage: ${owner.refused}`;
  if (!owner.on) return `sage: ${owner.reason}, so the owner merges. ${READY}`;
  if (!text(f.toolUseId) || !callInRecord(codexRecord, f.toolUseId, mark.lines)) return "sage: this merge call is not in Codex's record of this session, so sage refuses it. Ask for the merge again";
  if (inside(real(process.execPath) ?? process.execPath, roots)) return `sage: node runs from a folder that Codex's sandbox can write (${process.execPath}), so autopilot merges nothing. ${READY}`;
  const gh = trustedGh(roots, env);
  if (!gh) return `sage: sage found no gh outside the folders that Codex's sandbox can write, so autopilot merges nothing. ${READY}`;
  const repo = repositoryOf(gh, f.cwd, env);
  if (!repo) return "sage: gh could not name the GitHub repository of this folder, so sage refuses the merge. Try again, or tell the user";
  // checkMerge, unchanged, with the trusted PATH: its gh and git run outside the sandbox too.
  const verdict = await check(merge, f.cwd, { ...env, PATH: trustedPath(roots, env) }, f.session);
  if (verdict?.ok !== true) return verdict?.reason ?? "sage: the merge check refuses";
  const file = permitFile(f.toolUseId);
  if (!file) return `sage: this copy of sage is not installed as a Codex plugin, so it has no merge permits. ${READY}`;
  try {
    savePermit(file, { session: f.session, repo, pr: merge.pr, sha: merge.sha, command: f.command, cwd: f.cwd, turn: f.turn, transcript: f.transcript, mark, mode, gh, time: Date.now() });
  } catch (error) {
    return `sage: the gate could not save the merge permit of this call (${error?.code ?? error?.message ?? error}), so it refuses the merge. Check the folder ${dirname(file)}`;
  }
  return undefined;
}
const ALLOW = { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } };

// Codex adds ". Command: <the command>" after the reason, so a reason ends with no period of its own.
const deny = (reason) => ({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason.replace(/\.$/, "") } });
const UNREAD_THREAD = "sage: the hook could not read Codex's record of this thread, so it refuses this call. Tell the user.";
/** A refusal of a child rule; a thread whose record the hook cannot read gets the line that says so. */
const refuse = (thread, reason) => deny(thread.unread ? UNREAD_THREAD : reason);
const UNREAD_REQUEST = { systemMessage: "sage: the hook could not read this approval request, so Codex asks you." };

/** The input fields that the gate reads, or undefined for a shape that it does not know. */
function fieldsOf(input) {
  if (!record(input) || !["PreToolUse", "PermissionRequest"].includes(input.hook_event_name)) return undefined;
  const { session_id, cwd, tool_name, tool_input } = input;
  if (!text(session_id) || !text(cwd) || !isAbsolute(cwd) || typeof tool_name !== "string") return undefined;
  const shell = ["Bash", "apply_patch"].includes(tool_name);
  if (!shell && !SPAWN.test(tool_name) && !SEND_INPUT.test(tool_name) && !SAGE_TOOL.test(tool_name)) return undefined;
  if (Object.hasOwn(input, "agent_id") && typeof input.agent_id !== "string") return undefined;
  if (!record(tool_input) || (shell && typeof tool_input.command !== "string")) return undefined;
  // An empty agent_id is still a child: only an event without one is the root thread.
  const transcript = typeof input.transcript_path === "string" ? input.transcript_path : null;
  return { event: input.hook_event_name, session: session_id, cwd, tool: tool_name, input: tool_input, command: tool_input.command, child: Object.hasOwn(input, "agent_id"), transcript, turn: input.turn_id, toolUseId: input.tool_use_id };
}

/** The project folder of a cwd: the nearest folder with a .git entry, or the cwd itself. */
function projectRoot(cwd) {
  for (let dir = cwd; dir !== dirname(dir); dir = dirname(dir)) if (existsSync(join(dir, ".git"))) return dir;
  return cwd;
}
/** Whether a path names a .codex folder: from the project folder down, or the whole path when it is outside the project. */
const codexPath = (root, path) => {
  const inner = relative(root, path);
  return CODEX_SEGMENT.test(inner.startsWith("..") || isAbsolute(inner) ? path : inner);
};
/** A shell write form that names a .codex folder. The plugin's own path and the project's path above it do not count. */
const codexShellWrite = (command, cwd, env) => {
  const outside = (text) => [ROOT, projectRoot(cwd)].reduce((rest, dir) => rest.replace(new RegExp(`${escape(dir)}(?=$|[/\\s'"])`, "g"), " "), text);
  // The words as the shell reads them too, so a quote inside the name (".co""dex") does not hide it (R1669-6).
  const words = wordsOf(command, cwd, env).map(({ word }) => outside(word));
  return (CODEX_SEGMENT.test(outside(command)) || words.some((word) => CODEX_SEGMENT.test(` ${word}`))) && commandWrites(command, cwd);
};

/**
 * The gate's answer to one hook event: a hook output object, or undefined for no decision. deps replaces the mode
 * reader and the merge check, for tests.
 */
export async function gate(input, { mode = readMode, check = checkMerge, env = process.env, ppid = process.ppid, temporary = TEMPORARY } = {}) {
  // The manifest's send pattern has no lookahead (Codex reads it with Rust's regex), so it also matches an MCP tool such
  // as mcp__slack__send_message. The owner allows MCP tools: the gate judges only sage's own (F-T534-3).
  if (typeof input?.tool_name === "string" && /^mcp__/.test(input.tool_name) && !SAGE_TOOL.test(input.tool_name)) return undefined;
  const f = fieldsOf(input);
  if (!f) return input?.hook_event_name === "PermissionRequest" ? UNREAD_REQUEST : deny(UNREADABLE);
  const thread = threadOf(f);
  // The escalation of an admitted merge command: allowed only with its unused merge permit. Codex asks for every other.
  if (f.event === "PermissionRequest") return f.tool === "Bash" && !thread.child && mergeForm(f.command) && permitted(f) ? ALLOW : undefined;
  // Every merge goes through sage's merge command, before mode, role or saved-state checks: a gh merge never runs.
  if (f.tool === "Bash" && policy.mergeIn(f.command)) return deny(OWNER_MERGE);
  if (f.tool === "Bash" && runsMerge(f.command, f.cwd, env)) {
    const merge = mergeForm(f.command);
    if (!merge) return deny(MERGE_FORM);
    if (thread.child) return refuse(thread, AGENT_MERGE);
    const why = await admit(f, merge, { env, check, ppid, temporary });
    return why ? deny(why) : undefined;
  }
  const sageTool = SAGE_TOOL.exec(f.tool);
  if (sageTool) {
    const caller = callerOf(thread, f.cwd), why = callerRefusal(caller, sageTool[1], f.input, env);
    if (why) return refuse(thread, why);
    if (sageTool[1] === "report_compare") {
      const requested = typeof f.input.project === "string" && isAbsolute(f.input.project) ? real(tool.projectRoot(f.input.project)) : undefined;
      const assigned = real(tool.projectRoot(f.cwd));
      if (!assigned || requested !== assigned) return deny("sage: report comparison requires the chief's assigned absolute project");
    }
    try { writeProof(input, env, caller); } catch (error) { return deny(`sage: the gate could not save its proof of this call (${error?.message ?? error}), so the sage server would refuse it. Check the folder ${modeDirectory(env)}`); }
    return undefined;
  }
  // A sage child's message to another thread would start a turn there, as the user's on the root thread (F-T471-4),
  // or wake an implementer for a read-only reviewer (R1712-1). The chief and a child that is not a sage child may send.
  if (SEND_INPUT.test(f.tool)) {
    // In every mode and from every thread: autopilot on must come from the owner, never from a send (R1940-1).
    if (V1_SEND.test(f.tool) && mode(f, env).sage) return deny(V1_REFUSED);
    const targets = V1_SEND.test(f.tool) ? [f.input.target, f.input.id].filter((target) => target !== undefined) : [f.input.target];
    if (targets.some((target) => sendsToRoot(target, f.session))) return deny(ROOT_SEND);
    const under = thread.child && underSage(thread);
    if (under === false) return undefined;
    return refuse(thread, !under ? UNREAD_ROLE : realLead(thread) ? LEAD_SEND : CHILD_SEND);
  }
  if (SPAWN.test(f.tool)) {
    const under = thread.child && underSage(thread);
    if (under && realLead(thread) && f.tool.endsWith("resume_agent")) return refuse(thread, LEAD_RESUME);
    if (under === false) return undefined;
    const why = under ? childSpawn(thread, f.input.task_name, f.cwd, env) : UNREAD_ROLE;
    return why ? refuse(thread, why) : undefined;
  }
  if (f.tool === "apply_patch") {
    let paths;
    try {
      if (Object.keys(f.input).length !== 1) throw Error("unsupported patch shape");
      paths = patchTargets(f.command);
    } catch { return deny("sage: the hook could not read this patch, so it refuses it. Send one patch from *** Begin Patch to *** End Patch."); }
    if (!paths.length) return deny("sage: the hook could not read this patch, so it refuses it. Send one patch from *** Begin Patch to *** End Patch.");
    for (const path of paths) {
      if (managedPatchPath(path, { cwd: f.cwd, env, pluginRoot: ROOT })) continue;
      if (codexPath(projectRoot(f.cwd), resolve(f.cwd, path))) return deny(CODEX_FOLDER);
      if (namesSageFolder(asWord(path), env, f.cwd)) return deny(SAGE_FOLDER);
      if (mode(f, env).sage && namesLogbookFile(asWord(path), env, f.cwd)) return deny(LOGBOOK_FILE);
      if (mode(f, env).sage && gitInternalPath(resolve(f.cwd, path))) return deny(GIT_FOLDER);
      return deny("sage: this patch reaches protected storage or has unverified checkout paths");
    }
    if (paths.some((path) => namesSageFolder(asWord(path), env, f.cwd))) return deny(SAGE_FOLDER);
    const { sage } = mode(f, env);
    if (sage && paths.some((path) => namesLogbookFile(asWord(path), env, f.cwd))) return deny(LOGBOOK_FILE);
    // git's own files: a git hook or a setting there can push outside the push rule (T536).
    if (sage && paths.some((path) => gitInternalPath(resolve(f.cwd, path)))) return deny(GIT_FOLDER);
    if (!thread.child) return chiefEditDenied({ sage, chief: true }) ? deny(CHIEF) : undefined;
    const why = childChange(thread, sage);
    return why ? refuse(thread, why) : undefined;
  }
  const parsedWrites = shellWriteEvidence(f.command, f.cwd, env.PATH ?? "");
  const writeEvidence = parsedWrites?.uncertain ? undefined : parsedWrites;
  const namesReference = (references, test) => references.some(({ word, dir }) => test(asWord(resolve(dir, word)), env, f.cwd));
  if (writeEvidence ? namesReference([...writeEvidence.reads, ...writeEvidence.writes], namesSageFolder) : namesSageFolder(f.command, env, f.cwd)) return deny(SAGE_FOLDER);
  const runs = codexRuns(f.command, f.cwd, env);
  // A command that the reader cannot read and that names codex: refused when it may resume, fork or queue a turn, and
  // for a role agent in sage mode. Any other thread runs it, for example "$EDITOR codex/a.txt".
  if (runs === null && /codex/i.test(f.command)
    && (/\b(?:resume|fork|queue)\b/i.test(f.command) || (thread.child && underSage(thread) !== false && mode(f, env).sage))) return deny(UNREAD_CODEX);
  if (runs?.some((args) => !printsOnly(args))) return deny(CODEX_RUN);
  if (writeEvidence ? writeEvidence.writes.some(({ word, dir }) => codexPath(projectRoot(f.cwd), resolve(dir, word))) : codexShellWrite(f.command, f.cwd, env)) return deny(CODEX_FOLDER);
  // The dedicated package read grants no general shell or protected-write exception, in any mode or role.
  if (namesVerification(f.command, f.cwd, env)) {
    if ((!thread.child || thread.codex || thread.parts?.length) && scopedStateRead(f.command, f.cwd, env, true)) return undefined;
    return refuse(thread, "sage: verify-install requires one trusted literal CLI command, a full commit SHA and the assigned absolute project");
  }
  if (thread.child) {
    const knownThread = thread.codex || thread.parts?.length;
    if (stateToolWrites(f.command, f.cwd, env) && !(knownThread && scopedStateRead(f.command, f.cwd, env))) return refuse(thread, recordsAsLead(thread) ? LEAD_SHELL : CHILD_LOGBOOK);
    const why = commandWrites(f.command, f.cwd) || runsPatch(f.command, f.cwd, env) ? childChange(thread, mode(f, env).sage) : undefined;
    if (why) return refuse(thread, why);
  }
  if (writeEvidence ? namesReference(writeEvidence.writes, namesCodexSettings) : commandWrites(f.command, f.cwd) && namesCodexSettings(f.command, env, f.cwd)) return deny(CODEX_SETTINGS);
  if (parsedWrites?.uncertain) return deny("sage: the shell write target or its folder is uncertain. Use a literal target in the assigned project");
  const now = mode(f, env);
  if (!now.sage) return undefined; // the merge refusal above applies in every mode
  if (writeEvidence?.writes.some(({ word, dir }) => gitInternalPath(resolve(dir, word))) ||
    (shellExecutionUncertain(f.command, f.cwd) && (gitInternalPath(f.cwd) ||
      shellCommands(f.command).some(c => c.words.some(gitInternalPath)))))
    return deny("sage: this command writes a file under a .git folder, where git keeps its hooks and settings, so sage mode refuses it. Ask the user");
  if (writeEvidence ? namesReference(writeEvidence.writes, namesLogbookFile) : commandWrites(f.command, f.cwd) && namesLogbookFile(f.command, env, f.cwd)) return deny(LOGBOOK_FILE);
  const gh = ghProblem(f.command, f.cwd, env);
  if (gh) return deny(gh);
  const push = pushes.pushProblem(f.command, f.cwd);
  if (push) return deny(`sage: ${push}`);
  return undefined;
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
