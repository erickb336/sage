#!/usr/bin/env node
// The sage gates for Codex (T456). Codex sends one PreToolUse or PermissionRequest event on stdin; the hook answers with
// one JSON object on stdout, or nothing. The rules come from core and the state tool, as in the Claude sage hook:
//   - A .codex folder: no thread, in any mode, writes under a folder named .codex inside the project (apply_patch, or
//     a plain shell write form that names one), because Codex reads project settings from it. Only the part of the
//     path from the project folder down counts, so a project in the desktop app's ~/.codex/worktrees edits as usual.
//   - The thread: Codex's record of the thread (the session_meta line that starts transcript_path) says which thread
//     an event comes from. Only the session's root thread is the chief. A thread that Codex starts itself (its review
//     thread, guardian) shares the session id and has no agent_id, but its record names a subagent source or another
//     thread id: it counts as a read-only role agent. A child whose record cannot be read is read-only and starts nothing.
//   - The chief: in sage mode the root thread changes no file with apply_patch. A child may.
//   - A read-only role: in sage mode a child under a role that core keeps from editing (a reviewer, QA, the PE), at
//     any part of its agent path, changes no file, with apply_patch or with a shell write form (core's commandWrites,
//     or Codex's own apply_patch program). A part that starts with sage_ but is not a sage task name counts as a
//     read-only role.
//   - The logbook: only the chief records it. A child, in any mode, calls only the sage MCP tools that read, and runs
//     only the read commands of the plugin's state tool from the shell (never its MCP server).
//   - No role agent starts agents: a child under a sage_ name, in any mode, gets no spawn_agent.
//   - The sage folder: no thread, in any mode, runs a shell command that names the Codex sage folder (the logbook and the
//     mode files) or the Codex sessions folder, or that resumes or forks a Codex session, so an agent cannot forge a
//     mode file or a typed message.
//   - A new Codex: no sage child, in any mode, runs codex from the shell, because a new Codex session (codex exec,
//     codex) runs outside the hooks of this session. Codex is its name, or the real file of a Codex executable (not
//     every program of its package: Codex puts its own rg first on PATH). codex --version and --help start no session.
//   - A push (sage mode): only core's push form, as in the Claude hook.
//   - A merge (sage mode): only the one merge form of core, only on the root thread, only with autopilot on and a passing
//     merge check for that head SHA. Autopilot counts only when the mode file and the user's own typed messages in
//     Codex's transcript of the thread both give it, so a forged mode file alone unlocks nothing. PreToolUse denies every
//     other merge with one reason line. PermissionRequest allows the escalation of that exact command when the same
//     rules pass, so Codex shows no prompt; for every other request it declines to decide, so Codex shows its own prompt.
// It fails closed: a PreToolUse event that it cannot read is denied with one plain line. A PermissionRequest that it
// cannot read gets no decision, so the user decides in Codex's own prompt.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, realpathSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chiefEditDenied, commandWrites, createCommandPolicy, createPushPolicy, PR, programName, programsRun, pullRequestHead, readModeFile, roleEditDenied, switchModes } from "../core/index.mjs";
import { patchPaths, readState, stateKey } from "./principles-hook.mjs";
import { agentPathOf, sageName, sessionMeta, TASK_NAME } from "./report-gate.mjs";
import { modeDirectory } from "./sage-codex-hook.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TOOL = join(ROOT, "skills/sage/sage.mjs");
const SERVER = join(ROOT, "mcp/state-server.mjs");
const policy = createCommandPolicy({ stateToolPath: TOOL, prPattern: PR });
/** The branch of the checkout at dir, or undefined when git cannot read it (the Claude hook's reader). */
const branchAt = (dir) => {
  try {
    return execFileSync("git", ["-C", dir, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined } }).trim();
  } catch { return undefined; }
};
const pushes = createPushPolicy({ stateToolPath: TOOL, readBranch: branchAt });

export const UNREADABLE = "sage: the hook could not read this tool call, so it refuses it. Codex may have changed its hook input: update the sage plugin, or tell the user.";
const CODEX_FOLDER = "sage: no agent changes files under a .codex folder, because Codex reads its project settings there. Ask the user to make this change.";
const CHIEF = 'sage: sage mode is on, so the chief does not change files. Brief an implementer to make this change. The user ends sage mode with the message "sage mode off", alone.';
const AGENT_MERGE = "sage: an agent never merges. Report the pull request as ready.";
const AUTOPILOT_OFF = 'sage: autopilot is off, so the user merges. Report the pull request as ready. The user turns it on with the message "autopilot on", alone.';
const SAGE_FOLDER = "sage: no agent runs a shell command that names the Codex sage folder or the Codex sessions folder, because the logbook, the mode files and the user's typed messages are there. Use the sage MCP tools for the logbook.";
const RESUME = "sage: no agent resumes or forks a Codex session from the shell, because its prompts would count as the user's. Ask the user.";
const READ_ONLY = (role) => `sage: in sage mode, the ${role} agent changes no files. Report the finding instead.`;
const BAD_NAME = (name) => `sage: "${name}" starts with sage_ but is not a sage task name (sage_<role>_t<n>_r<k>), so this agent counts as a read-only role: it changes no files. Report instead.`;
const UNREAD_ROLE = "sage: the hook could not read this agent's task name from its transcript, so it refuses this call. Tell the user.";
const UNREAD_CODEX = "sage: the hook could not read this shell command, and it names codex, so it refuses it. Write the command in a plainer form.";
const CHILD_CODEX = "sage: role agents never start Codex from the shell, because a new Codex session runs outside the hooks of this session. Put what you need in your report.";
const CHILD_LOGBOOK = "sage: role agents report; only the chief records the logbook. Put this in your report.";
const CHILD_SPAWN = "sage: role agents start no agents; only the chief does. Put what you need in your report.";

/** The sage MCP tools that only read the logbook: a child may call these, and pages without record. */
export const CHILD_READS = new Set(["status", "standing", "merge_check"]);
const SAGE_TOOL = /^mcp__sage__(.+)$/;
/** Codex's hook name of the spawn tool: spawn_agent (the default and the multi_agent_v1 forms), or with its namespace before it (collaborationspawn_agent). */
const SPAWN = /spawn_agent$/;
const childMayCall = (name, input) => CHILD_READS.has(name) || (name === "pages" && input.record === undefined);

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
 * the core reader: no file is no mode, and a damaged file is off. Autopilot also needs the user's typed messages, so the
 * gate reads the transcript only when it asks for autopilot (a merge).
 */
export function readMode({ session, transcript }, env = process.env) {
  const { state } = readModeFile(readState, join(modeDirectory(env), `${stateKey({ session_id: session })}.json`));
  const sage = state.sage === true;
  return { sage, get autopilot() { return sage && state.autopilot === true && typeof transcript === "string" && typedModes(transcript, session).autopilot; } };
}

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

/** Whether a child thread is under a sage_ name (a thread that Codex starts itself counts), or undefined when its record cannot be read. */
const underSage = (t) => (t.codex ? true : t.parts?.some(sageName));

/** Why the gate refuses a child's change of files in sage mode, or undefined: a read-only role at any part of its agent path. */
function childChange(t, sage) {
  if (!sage || !t.child) return undefined;
  if (t.codex) return READ_ONLY(`Codex ${t.codex}`);
  if (!t.parts) return UNREAD_ROLE;
  for (const name of t.parts.filter(sageName)) {
    const role = taskRole(name);
    let denied;
    try { denied = role !== null && roleEditDenied({ sage, role }); } catch { denied = undefined; } // core throws for a role that it does not know
    if (denied === undefined || role === null) return BAD_NAME(name);
    if (denied) return READ_ONLY(role);
  }
  return undefined;
}

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Whether a shell command names the Codex sage folder (also from ~ or $HOME, $SAGE_HOME or $CODEX_HOME/sage) or the Codex sessions folder. */
export function namesSageFolder(command, env = process.env) {
  const dirs = [dirname(dirname(modeDirectory(env))), join(resolve(env.CODEX_HOME ?? join(homedir(), ".codex")), "sessions")];
  const forms = new Set(dirs);
  for (const dir of dirs) try { forms.add(realpathSync.native(dir)); } catch { /* not made yet */ }
  const home = env.HOME || homedir();
  for (const form of [...forms]) if (form.startsWith(`${home}/`)) for (const start of ["~", "$HOME", "${HOME}"]) forms.add(start + form.slice(home.length));
  const paths = [...forms].map((form) => `(?<![\\w.~/$-])${escape(form)}(?=$|[/\\s'"\`;|&)<>:])`);
  return new RegExp([...paths, "\\$\\{?SAGE_HOME\\b", "\\$\\{?CODEX_HOME\\}?/(?:sage|sessions)(?![\\w.-])", "\\.hooks/codex"].join("|"), "i").test(command);
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
const resumes = (args) => args.some((word) => /^(?:resume|fork)$/i.test(word));
/** Whether a shell command runs Codex's apply_patch program, which writes files as the apply_patch tool does. */
const runsPatch = (command, cwd, env) => { try { return programsRun(command, cwd, env.PATH ?? "").some((p) => PATCH_NAME.test(programName(p.word))); } catch { return true; } };

/** The read commands of the state tool, which a child may run from the shell (pages only without record). */
const STATE_READS = new Set(["status", "standing", "merge-check", "logbook"]);
const STATE_SCRIPT = /(?:^|\/)(?:skills\/sage\/sage\.mjs|mcp\/state-server\.mjs)$/;
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
    if (!(STATE_READS.has(words[0]) || (words[0] === "pages" && !words.includes("record")))) return true;
  }
  return false;
}
/** Whether a shell command runs codex with resume or fork. */
export const resumesSession = (command, cwd, env) => (codexRuns(command, cwd, env) ?? []).some(resumes);

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
const UNREAD_THREAD = "sage: the hook could not read Codex's record of this thread, so it refuses this call. Tell the user.";
/** A refusal of a child rule; a thread whose record the hook cannot read gets the line that says so. */
const refuse = (thread, reason) => deny(thread.unread ? UNREAD_THREAD : reason);
const ALLOW = { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } };
const UNREAD_REQUEST = { systemMessage: "sage: the hook could not read this approval request, so Codex asks you." };

/** The input fields that the gate reads, or undefined for a shape that it does not know. */
function fieldsOf(input) {
  if (!record(input) || !["PreToolUse", "PermissionRequest"].includes(input.hook_event_name)) return undefined;
  const { session_id, cwd, tool_name, tool_input } = input;
  if (!text(session_id) || !text(cwd) || !isAbsolute(cwd) || typeof tool_name !== "string") return undefined;
  const shell = ["Bash", "apply_patch"].includes(tool_name);
  if (!shell && !SPAWN.test(tool_name) && !SAGE_TOOL.test(tool_name)) return undefined;
  if (Object.hasOwn(input, "agent_id") && typeof input.agent_id !== "string") return undefined;
  if (!record(tool_input) || (shell && typeof tool_input.command !== "string")) return undefined;
  // An empty agent_id is still a child: only an event without one is the root thread.
  const transcript = typeof input.transcript_path === "string" ? input.transcript_path : null;
  return { event: input.hook_event_name, session: session_id, cwd, tool: tool_name, input: tool_input, command: tool_input.command, child: Object.hasOwn(input, "agent_id"), transcript };
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
const codexShellWrite = (command, cwd) => {
  const named = [ROOT, projectRoot(cwd)].reduce((rest, dir) => rest.replace(new RegExp(`${escape(dir)}(?=$|[/\\s'"])`, "g"), " "), command);
  return CODEX_SEGMENT.test(named) && commandWrites(command, cwd);
};

/**
 * The gate's answer to one hook event: a hook output object, or undefined for no decision. deps replaces the mode
 * reader and the merge check, for tests.
 */
export async function gate(input, { mode = readMode, check = checkMerge, env = process.env } = {}) {
  const f = fieldsOf(input);
  if (!f) return input?.hook_event_name === "PermissionRequest" ? UNREAD_REQUEST : deny(UNREADABLE);
  const thread = threadOf(f);
  if (f.event === "PermissionRequest") {
    if (f.tool !== "Bash" || thread.child || !mode(f, env).autopilot) return undefined;
    const merge = policy.mergeIn(f.command);
    if (!merge || merge.problem) return undefined;
    return (await check(merge, f.cwd, env)).ok === true ? ALLOW : undefined;
  }
  const sageTool = SAGE_TOOL.exec(f.tool);
  if (sageTool) return thread.child && !childMayCall(sageTool[1], f.input) ? refuse(thread, CHILD_LOGBOOK) : undefined;
  if (SPAWN.test(f.tool)) {
    const under = thread.child && underSage(thread);
    return under === false ? undefined : refuse(thread, under ? CHILD_SPAWN : UNREAD_ROLE);
  }
  if (f.tool === "apply_patch") {
    const paths = patchPaths(f.command);
    if (!paths.length) return deny("sage: the hook could not read this patch, so it refuses it. Send one patch from *** Begin Patch to *** End Patch.");
    const root = projectRoot(f.cwd);
    if (paths.some((path) => codexPath(root, resolve(f.cwd, path)))) return deny(CODEX_FOLDER);
    const { sage } = mode(f, env);
    if (!thread.child) return chiefEditDenied({ sage, chief: true }) ? deny(CHIEF) : undefined;
    const why = childChange(thread, sage);
    return why ? refuse(thread, why) : undefined;
  }
  if (namesSageFolder(f.command, env)) return deny(SAGE_FOLDER);
  const runs = codexRuns(f.command, f.cwd, env);
  // A command that the reader cannot read and that names codex: refused when it may resume or fork a session, and for
  // a role agent in sage mode. Any other thread runs it, for example "$EDITOR codex/a.txt".
  if (runs === null && /codex/i.test(f.command)
    && (/\b(?:resume|fork)\b/i.test(f.command) || (thread.child && underSage(thread) !== false && mode(f, env).sage))) return deny(UNREAD_CODEX);
  if (runs?.some(resumes)) return deny(RESUME);
  if (codexShellWrite(f.command, f.cwd)) return deny(CODEX_FOLDER);
  if (thread.child) {
    if (stateToolWrites(f.command, f.cwd, env)) return refuse(thread, CHILD_LOGBOOK);
    if (runs?.some((args) => !printsOnly(args))) {
      const under = underSage(thread);
      if (under !== false) return refuse(thread, under ? CHILD_CODEX : UNREAD_ROLE);
    }
    const why = commandWrites(f.command, f.cwd) || runsPatch(f.command, f.cwd, env) ? childChange(thread, mode(f, env).sage) : undefined;
    if (why) return refuse(thread, why);
  }
  const now = mode(f, env);
  if (!now.sage) return undefined; // outside sage mode the gate does not judge pushes or merges, as in the Claude hook
  const push = pushes.pushProblem(f.command, f.cwd);
  if (push) return deny(`sage: ${push}`);
  const merge = policy.mergeIn(f.command);
  if (!merge) return undefined;
  if (merge.problem) return deny(`sage: ${merge.problem}`);
  if (thread.child) return refuse(thread, AGENT_MERGE);
  if (!now.autopilot) return deny(AUTOPILOT_OFF);
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
