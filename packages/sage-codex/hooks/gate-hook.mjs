#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { accessSync, constants, existsSync, linkSync, mkdirSync, readdirSync, realpathSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_GH, agentCommandProblem, agentGh, boardCommandProblem, boardPathProblem, chiefEditDenied, commandWrites, createCommandPolicy, createPushPolicy, ghRuns, leadStopped as coreLeadStopped, logbookWrite, PR, programName, programsRun, pullRequestHead, readModeFile, roleEditDenied, sharedRoot, shellCommands, shellWriteEvidence, TEAM } from "sage-core";
import { modeFile, readMode, tool } from "../skills/sage/sage.mjs";
import { verificationOptions } from "../skills/sage/verify-install.mjs";
import { privateDirectory, readState } from "./hook-state.mjs";
import { briefChecked, briefProject, NAME_RULE } from "./brief-hook.mjs";
import { patchTargets } from "../runtime/patch-targets.mjs";
import { managedPatchPath } from "../runtime/managed-worktree.mjs";
import { agentPathOf, sageName, sessionMeta, TASK_NAME } from "./report-gate.mjs";
import { modeDirectory } from "./sage-codex-hook.mjs";
import { autopilotSwitch, callInRecord, NEW_ON, readRecord, RECORD_RANGE, RECORD_VERSION } from "./owner-record.mjs";
import { markFile } from "./start-mark.mjs";
import { launcherFolder, versionsFolder } from "./launch.mjs";
import { ASK_INSTALL } from "./entries.mjs";
import { CHIEF_SHELL, chiefShellProblem, READ_ONLY_SHELL_WAY, TEMP } from "sage-core";
import { mergeCommand, permitFile, permitFolder } from "../skills/sage/merge.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TOOL = join(ROOT, "skills/sage/sage.mjs");
const SERVER = join(ROOT, "mcp/state-server.mjs");
const policy = createCommandPolicy({ prPattern: PR });
const pushes = createPushPolicy();

const UNREADABLE = "sage: the hook could not read this tool call, so it refuses it. Codex may have changed its hook input: update the sage plugin, or tell the user.";
const CODEX_FOLDER = "sage: no agent changes files under a .codex folder, because Codex reads its project settings there. Ask the user to make this change.";
const CODEX_SETTINGS = "sage: no agent writes Codex's config file, its hooks.json, sage's hook launcher (sage-hooks), the sage plugin's folder or its installed versions (plugins/cache/sage/sage) from the shell, because sage's hooks and their trust are there. Ask the user to make this change.";
const CHIEF = 'sage: sage mode is on, so the chief does not change files. Brief an implementer to make this change. The user ends sage mode with the message "sage mode off", alone.';
const OWNER_MERGE = "sage: in Codex, only sage's merge command merges, on autopilot, as the chief's instructions say. Without autopilot, the owner merges the pull request in GitHub";
const LOGBOOK_WRITE = (word) => `sage: no agent writes, moves or removes a logbook file from the shell: ${JSON.stringify(word)} is in the Codex sage folder or the shared root, or holds one. Use the sage MCP tools for the logbook.`;
const LOGBOOK_PATCH = (path) => `sage: no patch changes a logbook file: ${JSON.stringify(path)} is in the Codex sage folder or the shared root. Use the sage MCP tools for the logbook.`;
const CODEX_RUN = "sage: no agent runs codex from the shell, except codex --version and codex --help, because a new session runs outside these hooks, and Codex records the prompt of a resumed, forked or queued turn as the user's typed message, also a mode phrase. Ask the user.";
const READ_ONLY = (role, way) => `sage: in sage mode, the ${role} agent changes no files. Report the finding instead.${way ? ` ${way}` : ""}`;
const LEAD_EDIT = "sage: a lead changes no files. Start an implementer of your task to make this change.";
const BAD_NAME = (name) => `sage: "${name}" starts with sage_ but is not a sage task name (sage_<role>_t<n>_r<k>), so this agent counts as a read-only role: it changes no files. Report instead.`;
const BAD_CHAIN = (name) => `sage: "${name}" is above this agent in its agent path, and only a lead (sage_lead_t<n>) has sage agents under it, so this agent changes no files. Report instead.`;
const UNREAD_ROLE = "sage: the hook could not read this agent's task name from Codex's record of its thread, so it refuses this call. Tell the user.";
const UNREAD_CODEX = "sage: the hook could not read this shell command, and it names codex, so it refuses it. Write the command in a plainer form.";
const CHILD_LOGBOOK = "sage: role agents report; only the chief records the logbook. Put this in your report.";
const CHILD_SPAWN = "sage: role agents start no agents; only the chief and a lead do. Put what you need in your report.";
const TEAM_NAMES = [...TEAM].map((role) => role.replaceAll("-", "_")).join(", ").replace(/, (?=[^,]*$)/, " or ");
const LEAD_SPAWN = (task, name) => `sage: a lead starts only the team of its own task: sage_<role>_t${task}_r<k>, where the role is ${TEAM_NAMES}. ${JSON.stringify(name ?? "no task_name")} is not one of these. Put what else you need in your report.`;
const NO_BRIEF = (name) => `sage: ${name} does not start, because no brief for it was checked in the last 30 minutes. Run the sage tool brief with this task name and the whole brief until it says checked, then spawn the agent again.`;
const MALFORMED = (name) => `sage: ${JSON.stringify(name)} does not start, because its name is malformed: it starts with sage_, but a sage task name is ${NAME_RULE}. Give the agent such a name.`;
const LEAD_RESUME = "sage: a lead restarts no agent, because each agent works only from its checked brief. To go on with its work, start a new agent on a new run, with a new brief.";
const CHILD_SEND = "sage: agents send no input to another thread, because a message to the chief's thread would count as the user's. Put it in your report.";
const LEAD_SEND = "sage: a lead sends no message to an agent, because each agent works only from its checked brief. To steer your team, start a new agent on a new run, with a new brief.";
const ROOT_SEND = "sage: no thread sends input to the session's main thread, because Codex counts that message as the user's own typed message, also a mode phrase. Put it in your reply or your report.";
const V1_REFUSED = "sage: in sage mode, no thread uses multi-agent v1's send_input, because Codex can deliver it to the main thread as the user's typed message. sage sends with multi-agent v2.";
const AGENT_GH_TEXT = `${Object.entries(AGENT_GH).map(([group, subs]) => `gh ${group} ${subs.join(", ")}`).join("; ")}; and gh api with GET`;
const NO_GH = (run) => `sage: in sage mode, an agent runs only these gh commands: ${AGENT_GH_TEXT}. ${JSON.stringify(["gh", run.group, run.group === "api" ? run.method : run.sub].filter(Boolean).join(" "))} is not one of them. Ask the chief to run any other gh command.`;

export const CHILD_READS = new Set(["status", "standing", "merge_check"]);
const SAGE_TOOL = /^mcp__sage__(.+)$/;
const SPAWN = /(?:spawn|resume)_agent$/;
const SEND_INPUT = /^(?:(?:multi_agent_v1)?send_input|(?!mcp__).*(?:send_message|followup_task))$/;
const V1_SEND = /^(?:multi_agent_v1)?send_input$/;
const uuidOf = (value) => {
  const id = value.trim().toLowerCase().replace(/^urn:uuid:/, "").replace(/^\{(.*)\}$/, "$1").replaceAll("-", "");
  return /^[0-9a-f]{32}$/.test(id) ? id : null;
};
function sendsToRoot(target, session) {
  if (typeof target !== "string") return true;
  const id = uuidOf(target);
  if (id || target.trim() === session) return target.trim() === session || id === uuidOf(session);
  return `/${target.trim()}`.replace(/\/+/g, "/").replace(/(.)\/$/, "$1") === "/root";
}
function ghProblem(command, cwd, env) {
  let runs;
  try { runs = ghRuns(command, cwd, env.PATH ?? ""); } catch { return undefined; }
  const run = runs.find((r) => !agentGh(r));
  return run && NO_GH(run);
}
const childMayCall = (name, input) => CHILD_READS.has(name) || (name === "pages" && ["record", "run", "text"].every((key) => input[key] === undefined));

const leadBrief = ({ task_name: name }, own) => (TEAM.has(taskRole(String(name))) && `T${taskNumber(name)}` === own ? undefined : `sage: a lead records a brief only for the team of ${own}, not for ${JSON.stringify(name)}.`);
const LEAD_SHELL = `sage: a lead records with the sage MCP tools (${[...tool.LEAD_COMMANDS, "brief"].map((command) => command.replaceAll(" ", "_")).join(", ")}), not from the shell. Use one of these, or put what the logbook needs in your report.`;
function leadStopped({ task: own, run }, view, start = false) {
  const task = view.task(own), lead = view.leadRun(own);
  if (!task || !lead || (run && lead.id !== run)) return `sage: ${own} has no running lead run${run ? ` ${run}` : ""}, so ${start ? "this lead does not start. Add the lead run with the sage tool run_add, then spawn the lead with that run's id in its task name" : "this lead records nothing and starts no agent. Report to the chief"}.`;
  const stopped = coreLeadStopped(own, task);
  return stopped && (start ? `sage: ${own} is ${task.state}, so no lead starts for it.` : `sage: ${stopped}`);
}
const UNREAD_LOGBOOK = (error) => `sage: the gate could not read the logbook for this lead (${error?.message ?? error}), so it refuses this call. Tell the chief.`;

export function callerRefusal(caller, name, input, env = process.env) {
  if (caller.role === "chief") return undefined;
  if (caller.role !== "lead" || CHILD_READS.has(name)) return childMayCall(name, input) ? undefined : CHILD_LOGBOOK;
  const own = caller.task, request = { ...input, command: name.replaceAll("_", " ") };
  if (name !== "brief" && !tool.LEAD_COMMANDS.includes(request.command)) return `sage: ${tool.leadProblem(undefined, { task: own }, request, input.project, env)}`;
  try {
    if (!caller.project || real(tool.projectRoot(input.project)) !== caller.project) return `sage: a lead records only the logbook of its own project, and ${JSON.stringify(input.project)} is not that project.`;
    const view = tool.logbookView(input.project, env), stopped = leadStopped(caller, view);
    if (stopped) return stopped;
    if (name === "brief") return leadBrief(input, own);
    const why = tool.leadProblem(view, { id: view.leadRun(own).id, task: own }, request, input.project, env);
    return why && `sage: ${why}`;
  } catch (error) {
    return UNREAD_LOGBOOK(error);
  }
}

const CODEX_SEGMENT = /(?:^|[\s/\\'"`=:<>])\.codex(?=$|[\s/\\'"`<>;|&)])/i;
const text = (value) => typeof value === "string" && value.length > 0 && value.length <= 4096;
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

export { readMode };

export function taskRole(name) {
  const task = TASK_NAME.exec(name);
  return task ? task[1].replaceAll("_", "-") : null;
}

const ROOT_THREAD = { child: false };
export function threadOf(f) {
  let meta;
  if (f.transcript !== null) try { meta = sessionMeta(f.transcript); } catch {}
  if (!meta) return f.child ? { child: true } : f.transcript !== null ? { child: true, unread: true } : ROOT_THREAD;
  const source = record(meta.source) ? meta.source.subagent ?? meta.source.internal : undefined;
  if (source === undefined && !f.child && meta.id === f.session) return ROOT_THREAD;
  if (source === undefined ? f.child : record(source) && record(source.thread_spawn)) return { child: true, parts: agentPathOf(meta) };
  const name = typeof source === "string" ? source : record(source) ? (typeof source.other === "string" ? source.other : Object.keys(source)[0]) : undefined;
  return { child: true, ...(/^[a-z][\w-]{0,39}$/i.test(name ?? "") ? { codex: name.replaceAll("_", " ") } : {}) };
}

const CODEX_THREADS = { guardian: "approval check" };

const underSage = (t) => (t.codex ? true : t.parts?.some(sageName));

const isLead = (name) => taskRole(name) === "lead";
const notLeadAbove = (parts) => parts.filter(sageName).slice(0, -1).find((name) => !isLead(name));
const realLead = (t) => isLead(t.parts?.at(-1)) && !notLeadAbove(t.parts);

function childChange(t, sage, way) {
  if (!sage || !t.child) return undefined;
  if (t.codex) return READ_ONLY(`Codex ${CODEX_THREADS[t.codex] ?? t.codex}`, way);
  if (!t.parts) return UNREAD_ROLE;
  const leaf = t.parts.findLast(sageName);
  if (leaf === undefined) return undefined;
  const above = notLeadAbove(t.parts);
  if (above) return BAD_CHAIN(above);
  const role = taskRole(leaf);
  if (role === "lead") return LEAD_EDIT;
  let denied;
  try { denied = role !== null && roleEditDenied({ sage, role }); } catch { denied = undefined; }
  if (denied === undefined || role === null) return BAD_NAME(leaf);
  return denied ? READ_ONLY(role, way) : undefined;
}

const taskParts = (name) => /_t(\d+)(?:_r(\d+))?$/.exec(name).slice(1);
const taskNumber = (name) => taskParts(name)[0];
const leadOf = (name) => {
  const [task, run] = taskParts(name);
  return { task: `T${task}`, ...(run ? { run: `R${run}` } : {}) };
};
const recordsAsLead = (t) => t.parts?.length === 2 && t.parts[0] === "root" && isLead(t.parts[1]);
function callerOf(t, cwd) {
  if (!t.child) return { role: "chief" };
  return recordsAsLead(t) ? { role: "lead", ...leadOf(t.parts[1]), project: real(tool.projectRoot(cwd)) } : { role: "child" };
}
function childSpawn(t, name, cwd, session, env) {
  const self = t.parts?.at(-1);
  if (!isLead(self) || notLeadAbove(t.parts)) return CHILD_SPAWN;
  const fits = typeof name === "string" && TEAM.has(taskRole(name)) && taskNumber(name) === taskNumber(self);
  if (!fits) return LEAD_SPAWN(taskNumber(self), name);
  try { return leadStopped(leadOf(self), tool.logbookView(cwd, env)) ?? unbriefed(name, briefProject(cwd, session, name, env), env); } catch (error) { return UNREAD_LOGBOOK(error); }
}
const unbriefed = (name, project, env) => (!TASK_NAME.test(name) ? MALFORMED(name) : briefChecked(project, name, env) ? undefined : NO_BRIEF(name));
function chiefSpawn(name, cwd, session, env) {
  if (typeof name !== "string" || !sageName(name)) return undefined;
  const project = briefProject(cwd, session, name, env);
  if (isLead(name)) {
    let why;
    try { why = leadStopped(leadOf(name), tool.logbookView(project, env), true); } catch (error) { return `sage: the gate could not read the logbook (${error?.message ?? error}), so no lead starts. Tell the user.`; }
    if (why) return why;
  }
  return unbriefed(name, project, env);
}

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function wordsOf(command, cwd, env) {
  try {
    const runs = programsRun(command, cwd, env.PATH ?? "");
    const targets = programsRun(command, cwd, env.PATH ?? "", { redirectEvidence: true, redirectParts: true });
    return [...runs.flatMap((p) => [p.word, ...p.args, ...p.stdin].map((word) => ({ word, dir: p.dir ?? cwd }))), ...targets.map((r) => ({ word: r.target ?? r.redirect, dir: r.dir ?? cwd }))];
  } catch { return []; }
}

const codexHome = (env) => resolve(env.CODEX_HOME ?? join(homedir(), ".codex"));
const sageRoot = (env) => dirname(dirname(modeDirectory(env)));
const logbookWord = (command, env, cwd) => {
  try { return logbookWrite(command, cwd, [sageRoot(env), sharedRoot(env)], env.HOME || homedir()); } catch { return undefined; }
};
const asWord = (path) => `: '${path.replaceAll("'", "'\\''")}'`;
const asWrite = (path) => `: > '${path.replaceAll("'", "'\\''")}'`;
export const namesCodexSettings = (command, env = process.env, cwd = "/") =>
  names(command, env, cwd, [join(codexHome(env), "config.toml"), join(codexHome(env), "hooks.json"), launcherFolder(codexHome(env)), versionsFolder(codexHome(env)), ROOT], []);

function names(command, env, cwd, dirs, patterns) {
  const forms = new Set(dirs);
  for (const dir of dirs) try { forms.add(realpathSync.native(dir)); } catch {}
  const home = env.HOME || homedir();
  for (const form of [...forms]) if (form.startsWith(`${home}/`)) forms.add(`~${form.slice(home.length)}`);
  const paths = [...forms].map((form) => `(?<![\\w.~/$-])${escape(form)}(?=$|[/\\s'"\`;|&)<>:])`);
  const named = new RegExp([...paths, ...patterns].join("|"), "i");
  const path = (word, dir) => resolve(dir, word.replace(/^~(?=\/|$)/, home));
  return named.test(command) || wordsOf(command, cwd, env).some(({ word, dir }) => named.test(word) || named.test(path(word, dir)));
}

const CODEX_NAME = /(?:^|\/)codex(?:\.exe|\.js|@[\w.-]+)?$/i;
const real = (file) => { try { return realpathSync.native(file); } catch { return undefined; } };
const PATCH_NAME = /^(?:apply_patch|applypatch)$/;

const printsOnly = (args) => args.length > 0 && args.every((word) => /^(?:--version|-V|--help|-h)$/.test(word));

export function codexRuns(command, cwd = "/", env = process.env) {
  let runs;
  try { runs = programsRun(command, cwd, env.PATH ?? ""); } catch { return null; }
  const found = [];
  for (const p of runs) {
    if (PATCH_NAME.test(programName(p.word))) continue;
    if (CODEX_NAME.test(p.word)) { found.push(p.args); continue; }
    if (!/^(?:node|nodejs)$/i.test(programName(p.word))) continue;
    const at = p.args.findIndex((word) => !word.startsWith("-"));
    if (at >= 0 && CODEX_NAME.test(p.args[at])) found.push(p.args.slice(at + 1));
  }
  return found;
}
const runsPatch = (command, cwd, env) => { try { return programsRun(command, cwd, env.PATH ?? "").some((p) => PATCH_NAME.test(programName(p.word))); } catch { return true; } };

const STATE_READS = new Map([["status", null], ["merge-check", null], ["logbook", "repair"], ["standing", "add"], ["pages", "record"]]);
const readsOnly = ([command, ...rest]) => STATE_READS.has(command) && !rest.includes(STATE_READS.get(command));
const STATE_SCRIPT = /(?:^|\/)(?:skills\/sage\/sage\.mjs|mcp\/state-server\.mjs)$/;
const LITERAL_WORD = /(?:[A-Za-z0-9_./,:=+-]|'[^'\r\n]*'|"[^"$`\\\r\n]*")+/;
const LITERAL_COMMAND = new RegExp(`^[ \\t]*${LITERAL_WORD.source}(?:[ \\t]+${LITERAL_WORD.source})*[ \\t]*$`);
function namesVerification(command, cwd, env) {
  try {
    return programsRun(command, cwd, env.PATH ?? "").some(run => (run.args.includes("verify-install") || run.args.includes("--commit"))
      && ([run.word, ...run.args].some(word => STATE_SCRIPT.test(word) || real(resolve(run.dir ?? cwd, word)) === real(TOOL))
        || /sage\.mjs/.test(command)));
  } catch { return /sage\.mjs/.test(command) && /(?:^|\s)['"]?verify-install(?:['"]?(?:\s|$))/.test(command); }
}
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
export function stateToolWrites(command, cwd = "/", env = process.env) {
  let runs;
  try { runs = programsRun(command, cwd, env.PATH ?? ""); } catch { return /sage\.mjs|state-server/.test(command); }
  const own = new Set([real(TOOL), real(SERVER)].filter(Boolean));
  for (const p of runs) {
    let script = p.file ?? p.word, args = p.args;
    if (/^(?:node|nodejs)$/i.test(programName(p.word))) {
      const at = p.args.findIndex((word) => !word.startsWith("-"));
      if (at < 0) continue;
      script = resolve(p.dir ?? cwd, p.args[at]), args = p.args.slice(at + 1);
    }
    const file = real(script) ?? script;
    if (!own.has(file) && !STATE_SCRIPT.test(file) && !STATE_SCRIPT.test(script)) continue;
    if (/state-server\.mjs$/.test(file) || /state-server\.mjs$/.test(script)) return true;
    const words = args.filter((word) => !word.startsWith("-"));
    if (!readsOnly(words)) return true;
  }
  return false;
}

const proofFile = (env, id) => join(modeDirectory(env), "proofs", `${createHash("sha256").update(id).digest("hex")}.json`);
const comparisonHash = input => createHash("sha256").update(JSON.stringify([input?.project, input?.task, input?.run, input?.sha256])).digest("hex");
export function writeProof({ tool_use_id: id, session_id: session, tool_name: tool, tool_input: input }, env = process.env, caller) {
  if (!text(id)) throw Error("the call has no tool_use_id");
  const file = proofFile(env, id);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify({ session, tool, caller, ...(tool === "mcp__sage__report_compare" ? { comparison: comparisonHash(input) } : {}) }), { mode: 0o600 });
}
const callerForm = (c) => record(c) && (c.role === "chief" || c.role === "child" || (c.role === "lead" && /^T[1-9]\d*$/.test(c.task) && text(c.project) && (c.run === undefined || /^R[1-9]\d*$/.test(c.run))));
export function takeProof(meta, name, env = process.env, input) {
  if (!record(meta) || !text(meta.callId)) return null;
  const file = proofFile(env, meta.callId);
  let proof;
  try { proof = JSON.parse(readFileSync(file, "utf8")); rmSync(file); } catch { return null; }
  const seen = proof?.tool === `mcp__sage__${name}` && proof.session === meta.sessionId
    && (name !== "report_compare" || proof.comparison === comparisonHash(input));
  return seen && callerForm(proof.caller) ? proof.caller : null;
}
export const NO_GATE = `sage's gate is not running. If sage's hooks are not installed yet, tell the user. To install them, ${ASK_INSTALL}. Then the user trusts them with /hooks in the Codex CLI (or the app's hook review), and you try again.`;

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

const MERGE_SCRIPT = /(?:^|\/)merge\.mjs$/;
function runsMerge(command, cwd, env) {
  if (!/merge\.mjs/.test(command)) return false;
  let runs;
  try { runs = programsRun(command, cwd, env.PATH ?? ""); } catch { return true; }
  return runs.some((p) => {
    if (MERGE_SCRIPT.test(p.word) || MERGE_SCRIPT.test(p.file ?? "")) return true;
    const script = p.args.find((word) => !word.startsWith("-"));
    return /^(?:node|nodejs)$/i.test(programName(p.word)) && MERGE_SCRIPT.test(script ?? "");
  });
}
function mergeForm(command) {
  const [, pr, sha] = /^"[^"]+" "[^"]+" ([1-9]\d*) ([0-9a-f]{40})$/.exec(command) ?? [];
  return pr && command === mergeCommand(pr, sha) ? { pr, sha } : undefined;
}
const MERGE_FORM = `sage: run sage's merge command in its one form, alone: ${mergeCommand("<pr>", "<head sha>")}`;
const AGENT_MERGE = "sage: only the chief merges, not an agent. Report the pull request as ready";
const AUTOPILOT_OFF = `sage: autopilot is off, so the owner merges. Report the pull request as ready. To turn autopilot on while sage mode is on, the owner sends "autopilot on" alone, ${NEW_ON}`;
const READY = "Report the pull request as ready: the owner merges it in GitHub";
const writableRoots = (cwd, env, temporary) => [projectRoot(cwd), cwd, env.TMPDIR, ...temporary].filter(Boolean).map((dir) => real(dir) ?? resolve(dir));
export const TEMPORARY = ["/tmp", "/private/tmp", "/var/tmp"];
const inside = (path, roots) => roots.some((root) => { const at = relative(root, path); return at === "" || (!at.startsWith("..") && !isAbsolute(at)); });
const trustedPath = (roots, env) => (env.PATH ?? "").split(":").filter((dir) => { const at = isAbsolute(dir) && real(dir); return at && !inside(at, roots); }).join(":");
function trustedGh(roots, env) {
  for (const dir of trustedPath(roots, env).split(":")) {
    const file = real(join(dir, "gh"));
    try { if (file && !inside(file, roots) && statSync(file).isFile()) { accessSync(file, constants.X_OK); return file; } } catch {}
  }
  return undefined;
}
function runningCodex(roots, env) {
  const dirs = (env.PATH ?? "").split(":").filter((dir) => basename(dir).startsWith("codex-arg0"));
  if (dirs.length === 0) return undefined;
  for (const dir of dirs) {
    const binary = real(join(dir, "apply_patch"));
    if (!binary || inside(binary, roots)) continue;
    try {
      const out = execFileSync(binary, ["--version"], { env, encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
      return /^codex-cli (\S+)\s*$/.exec(out)?.[1] ?? null;
    } catch { return null; }
  }
  return null;
}
function repositoryOf(gh, cwd, env) {
  try {
    const name = execFileSync(gh, ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], { argv0: "gh", cwd, env: { ...env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" }, encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] }).trim();
    return /^[A-Za-z0-9][A-Za-z0-9-]*\/(?!\.\.?$)[A-Za-z0-9_.][A-Za-z0-9_.-]*$/.test(name) ? name : undefined;
  } catch { return undefined; }
}
const PERMIT_AGE = 300_000;
function savePermit(file, permit) {
  const dir = dirname(file);
  privateDirectory(dir);
  for (const name of readdirSync(dir)) {
    try { if (Date.now() - statSync(join(dir, name)).mtimeMs > PERMIT_AGE) rmSync(join(dir, name), { force: true }); } catch {}
  }
  const temporary = `${file}.${randomUUID()}`;
  writeFileSync(temporary, JSON.stringify(permit), { flag: "wx", mode: 0o600 });
  try { linkSync(temporary, file); } finally { rmSync(temporary, { force: true }); }
}
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

async function admit(f, merge, { env, check, ppid, temporary }) {
  const mode = modeFile(f.session, env);
  const { state } = readModeFile(readState, mode);
  if (state.sage !== true || state.autopilot !== true) return AUTOPILOT_OFF;
  const roots = writableRoots(f.cwd, env, temporary);
  const version = runningCodex(roots, env);
  if (version === undefined) return `sage: sage cannot tell which Codex runs this session, because Codex's own folder is not on the hook's PATH. A login profile, such as ~/.zprofile, that sets PATH without its earlier value drops it: keep the earlier value there (export PATH="<folder>:$PATH"), then ask for the merge again. ${READY}`;
  if (!RECORD_VERSION.test(version ?? "")) return `sage: ${version ? `this session runs Codex ${version}` : "sage cannot tell which Codex runs this session"}, and autopilot merges only in Codex ${RECORD_RANGE}. ${READY}`;
  const codexRecord = readRecord(f.transcript ?? "");
  if (codexRecord.refused) return `sage: ${codexRecord.refused}`;
  let mark;
  try { mark = readState(markFile(modeDirectory(env), f.session)); } catch { mark = undefined; }
  if (record(mark) && mark.pid !== ppid) return `sage: sage's note of this session start is from another Codex process, so autopilot merges nothing in this session for now. ${READY}, or resume the session and send "autopilot on" again`;
  const owner = autopilotSwitch(codexRecord, mark, state.onTurn);
  if (owner.refused) return `sage: ${owner.refused}`;
  if (!owner.on) return `sage: ${owner.reason}, so the owner merges. ${READY}. To turn autopilot on, the owner sends "autopilot on" alone, ${NEW_ON}`;
  if (!text(f.toolUseId) || !callInRecord(codexRecord, f.toolUseId, mark.lines)) return "sage: this merge call is not in Codex's record of this session, so sage refuses it. Ask for the merge again";
  if (inside(real(process.execPath) ?? process.execPath, roots)) return `sage: node runs from a folder that Codex's sandbox can write (${process.execPath}), so autopilot merges nothing. ${READY}`;
  const gh = trustedGh(roots, env);
  if (!gh) return `sage: sage found no gh outside the folders that Codex's sandbox can write, so autopilot merges nothing. ${READY}`;
  const path = trustedPath(roots, env);
  const repo = repositoryOf(gh, f.cwd, { ...env, PATH: path });
  if (!repo) return "sage: gh could not name the GitHub repository of this folder, so sage refuses the merge. Try again, or tell the user";
  const verdict = await check(merge, f.cwd, { ...env, PATH: path }, f.session);
  if (verdict?.ok !== true) return verdict?.reason ?? "sage: the merge check refuses";
  const file = permitFile(f.toolUseId);
  if (!file) return `sage: this copy of sage is not installed as a Codex plugin, so it has no merge permits. ${READY}`;
  try {
    savePermit(file, { session: f.session, repo, pr: merge.pr, sha: merge.sha, command: f.command, cwd: f.cwd, turn: f.turn, transcript: f.transcript, mark, mode, gh, path, time: Date.now() });
  } catch (error) {
    return `sage: the gate could not save the merge permit of this call (${error?.code ?? error?.message ?? error}), so it refuses the merge. Check the folder ${dirname(file)}`;
  }
  return undefined;
}
const ALLOW = { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } };
const allowedDescription = (description) => description === undefined || (typeof description === "string" && !description.startsWith("network-access "));

const deny = (reason) => ({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason.replace(/\.$/, "") } });
const UNREAD_THREAD = "sage: the hook could not read Codex's record of this thread, so it refuses this call. Tell the user.";
const refuse = (thread, reason) => deny(thread.unread ? UNREAD_THREAD : reason);
const UNREAD_REQUEST = { systemMessage: "sage: the hook could not read this approval request, so Codex asks you." };

function fieldsOf(input) {
  if (!record(input) || !["PreToolUse", "PermissionRequest"].includes(input.hook_event_name)) return undefined;
  const { session_id, cwd, tool_name, tool_input } = input;
  if (!text(session_id) || !text(cwd) || !isAbsolute(cwd) || typeof tool_name !== "string") return undefined;
  const shell = ["Bash", "apply_patch"].includes(tool_name);
  if (!shell && !SPAWN.test(tool_name) && !SEND_INPUT.test(tool_name) && !SAGE_TOOL.test(tool_name)) return undefined;
  if (Object.hasOwn(input, "agent_id") && typeof input.agent_id !== "string") return undefined;
  if (!record(tool_input) || (shell && typeof tool_input.command !== "string")) return undefined;
  const transcript = typeof input.transcript_path === "string" ? input.transcript_path : null;
  return { event: input.hook_event_name, session: session_id, cwd, tool: tool_name, input: tool_input, command: tool_input.command, child: Object.hasOwn(input, "agent_id"), transcript, turn: input.turn_id, toolUseId: input.tool_use_id };
}

function projectRoot(cwd) {
  for (let dir = cwd; dir !== dirname(dir); dir = dirname(dir)) if (existsSync(join(dir, ".git"))) return dir;
  return cwd;
}
const codexPath = (root, path) => {
  const inner = relative(root, path);
  return CODEX_SEGMENT.test(inner.startsWith("..") || isAbsolute(inner) ? path : inner);
};
const codexShellWrite = (command, cwd) => {
  const outside = (text) => [ROOT, projectRoot(cwd)].reduce((rest, dir) => rest.replace(new RegExp(`${escape(dir)}(?=$|[/\\s'"])`, "g"), " "), text);
  return CODEX_SEGMENT.test(outside(command)) && commandWrites(command, cwd);
};

export async function gate(input, { mode = readMode, check = checkMerge, env = process.env, ppid = process.ppid, temporary = TEMPORARY } = {}) {
  if (typeof input?.tool_name === "string" && /^mcp__/.test(input.tool_name) && !SAGE_TOOL.test(input.tool_name)) return undefined;
  const f = fieldsOf(input);
  if (!f) return input?.hook_event_name === "PermissionRequest" ? UNREAD_REQUEST : deny(UNREADABLE);
  const thread = threadOf(f);
  if (f.event === "PermissionRequest") return f.tool === "Bash" && !thread.child && mergeForm(f.command) && allowedDescription(f.input.description) && permitted(f) ? ALLOW : undefined;
  if (f.tool === "Bash" && policy.mergeRun(f.command, f.cwd)) return deny(OWNER_MERGE);
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
  if (SEND_INPUT.test(f.tool)) {
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
    if (under === false) {
      const why = !thread.child && mode(f, env).sage ? chiefSpawn(f.input.task_name, f.cwd, f.session, env) : undefined;
      return why ? deny(why) : undefined;
    }
    const why = under ? childSpawn(thread, f.input.task_name, f.cwd, f.session, env) : UNREAD_ROLE;
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
      const board = boardPathProblem(path, f.cwd, { home: env.HOME || homedir() });
      if (board) return deny(`sage: ${board}`);
      if (managedPatchPath(path, { cwd: f.cwd, env, pluginRoot: ROOT })) continue;
      if (codexPath(projectRoot(f.cwd), resolve(f.cwd, path))) return deny(CODEX_FOLDER);
      if (logbookWord(asWrite(path), env, f.cwd) !== undefined) return deny(LOGBOOK_PATCH(path));
      return deny("sage: this patch reaches protected storage or has unverified checkout paths");
    }
    const { sage } = mode(f, env);
    if (!thread.child) return chiefEditDenied({ sage, chief: true }) ? deny(CHIEF) : undefined;
    const why = childChange(thread, sage);
    return why ? refuse(thread, why) : undefined;
  }
  const parsedWrites = shellWriteEvidence(f.command, f.cwd, env.PATH ?? "");
  const writeEvidence = parsedWrites?.uncertain ? undefined : parsedWrites;
  const namesReference = (references, test) => references.some(({ word, dir }) => test(asWord(resolve(dir, word)), env, f.cwd));
  const logbook = logbookWord(f.command, env, f.cwd);
  if (logbook !== undefined) return deny(LOGBOOK_WRITE(logbook));
  const board = boardCommandProblem(f.command, f.cwd, { home: env.HOME || homedir() });
  if (board) return deny(`sage: ${board}`);
  const runs = codexRuns(f.command, f.cwd, env);
  if (runs === null && /codex/i.test(f.command)
    && (/\b(?:resume|fork|queue)\b/i.test(f.command) || (thread.child && underSage(thread) !== false && mode(f, env).sage))) return deny(UNREAD_CODEX);
  if (runs?.some((args) => !printsOnly(args))) return deny(CODEX_RUN);
  if (writeEvidence ? writeEvidence.writes.some(({ word, dir }) => codexPath(projectRoot(f.cwd), resolve(dir, word))) : codexShellWrite(f.command, f.cwd)) return deny(CODEX_FOLDER);
  if (namesVerification(f.command, f.cwd, env)) {
    if ((!thread.child || thread.codex || thread.parts?.length) && scopedStateRead(f.command, f.cwd, env, true)) return undefined;
    return refuse(thread, "sage: verify-install requires one trusted literal CLI command, a full commit SHA and the assigned absolute project");
  }
  if (thread.child) {
    const knownThread = thread.codex || thread.parts?.length;
    if (stateToolWrites(f.command, f.cwd, env) && !(knownThread && scopedStateRead(f.command, f.cwd, env))) return refuse(thread, recordsAsLead(thread) ? LEAD_SHELL : CHILD_LOGBOOK);
    const why = commandWrites(f.command, f.cwd, TEMP, { readOnly: true }) || runsPatch(f.command, f.cwd, env) ? childChange(thread, mode(f, env).sage, READ_ONLY_SHELL_WAY) : undefined;
    if (why) return refuse(thread, why);
    const agent = underSage(thread) !== false || mode(f, env).sage ? agentCommandProblem(f.command, f.cwd, env.PATH ?? "") : undefined;
    if (agent) return refuse(thread, `sage: ${agent}`);
  }
  if (writeEvidence ? namesReference(writeEvidence.writes, namesCodexSettings) : commandWrites(f.command, f.cwd) && namesCodexSettings(f.command, env, f.cwd)) return deny(CODEX_SETTINGS);
  const now = mode(f, env);
  if (!now.sage) return undefined;
  if (!thread.child && chiefEditDenied({ sage: true, chief: true })) {
    const why = chiefShellProblem(f.command, f.cwd, env) ?? (runsPatch(f.command, f.cwd, env) ? CHIEF_SHELL : undefined);
    if (why) return deny(`sage: ${why}`);
  }
  const gh = thread.child ? ghProblem(f.command, f.cwd, env) : undefined;
  if (gh) return refuse(thread, gh);
  const push = pushes.pushProblem(f.command, f.cwd, { owner: (dir, branch) => tool.branchBar(real(dir) ?? dir, branch, f.session, env) });
  if (push) return deny(`sage: ${push}`);
  return undefined;
}

export async function gateAnswer(input) {
  try {
    return await gate(input);
  } catch {
    return input?.hook_event_name === "PermissionRequest" ? UNREAD_REQUEST : deny(UNREADABLE);
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let input;
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {}
  const output = await gateAnswer(input);
  if (output) process.stdout.write(JSON.stringify(output));
}
