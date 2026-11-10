#!/usr/bin/env node
// The report check of Codex, on SubagentStop. A sage role agent is a child whose task name (the last part of
// its agent path) starts with "sage_" in any letter case, as skills/sage/references/roles.md tells the chief.
// Its first stop without every report field continues it once with the missing fields; the second stop
// goes through with one plain line, as the Claude stop gate. A review or QA child's first stop also goes through
// the one reader of core. Other agents pass. An input that the gate cannot read stops nothing: it gives one
// plain line, and the gate never reads it as a checked report.
import { spawnSync } from "node:child_process";
import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { REPORT_FIELDS, TEAM, missingFields, stopReason } from "sage-core";
import { tool } from "../skills/sage/sage.mjs";

const UNREAD = "sage: the report check could not read this agent's stop, so it did not check its report.";

/** A sage task name: sage_, the role with _ for -, the task and an optional run, for example sage_code_reviewer_t12_r40. */
export const TASK_NAME = /^sage_([a-z]+(?:_[a-z]+)*)_t[1-9]\d*(?:_r[1-9]\d*)?$/;
/** A name that claims a sage agent: it starts with sage_, in any letter case. */
export const sageName = (name) => /^sage_/i.test(name);

/** The most of a transcript that sessionMeta reads. A real session_meta line is about 20 KB. */
export const META_BYTES = 1 << 20;

/** Codex's record of a thread: the payload of the session_meta line that starts its transcript. It throws when there is none,
 * and when the first line does not end in the first META_BYTES, so a long transcript never has to fit in one string. */
export function sessionMeta(path) {
  const chunk = Buffer.alloc(META_BYTES + 1), fd = openSync(path, "r");
  let size;
  try { size = readSync(fd, chunk, 0, chunk.length, 0); } finally { closeSync(fd); }
  const end = chunk.subarray(0, size).indexOf(10);
  if (end < 0 && size > META_BYTES) throw Error("no session_meta in the first line");
  const meta = JSON.parse(chunk.subarray(0, end < 0 ? size : end).toString("utf8"));
  if (meta?.type !== "session_meta" || meta.payload === null || typeof meta.payload !== "object") throw Error("no session_meta");
  return meta.payload;
}

/** Every part of a Codex child's agent path (its own task name last), from its session record. */
export const agentPathOf = (meta) => String(meta.agent_path ?? "").split("/").filter(Boolean);
export const agentPath = (path) => agentPathOf(sessionMeta(path));

/** The task name of a Codex child: the last part of its agent path. */
export const childTask = (path) => agentPath(path).at(-1) ?? "";

/** Roles whose reports the hook retains. Design, investigation, build and arena-judge retention does not back or grant a verdict. */
const REPORT_ROLES = { implementer: "implementer", arena_judge: "arena-judge", pe: "pe", designer: "designer", investigate: "investigate", evidence_review: "evidence-review", code_reviewer: "code-reviewer", security_reviewer: "security-reviewer", ux_reviewer: "ux-reviewer", qa: "qa" };
/**
 * The run of a design, review, QA or investigation child of the chief (T483), or of a team child of its task's lead (T552): its task name carries the
 * run (sage_qa_t12_r40), and its agent path is the root thread, that lead if it has one, and that name, so no other child of a child names a run.
 * Its thread id is the session_meta id.
 */
export function reviewChild(meta, roles = REPORT_ROLES) {
  const path = agentPathOf(meta), [, role, number, run] = /^sage_([a-z_]+)_t([1-9]\d*)_(r[1-9]\d*)$/.exec(path.at(-1) ?? "") ?? [];
  const underLead = path.length === 3 && TEAM.has(roles[role]) && new RegExp(`^sage_lead_t${number}(?:_r[1-9]\\d*)?$`).test(path[1]);
  if (!roles[role] || (path.length !== 2 && !underLead) || path[0] !== "root" || typeof meta.id !== "string" || !meta.id) return undefined;
  return { role: roles[role], task: `T${number}`, run: run.toUpperCase(), thread: meta.id };
}
/** The name of a role whose report the stop gate reads with the one reader (the Claude hook's REVIEWERS). It takes any letter
 * case, and it needs no task or run: as Claude reads an agent by its role, not by the run that keeps its report (T461). */
const REVIEW_NAME = /^sage_(?:code_reviewer|security_reviewer|ux_reviewer|qa)(?:_|$)/i;
const bindingOf =(cwd, run, env) => join(tool.storeDir(cwd, env), "kept", `${run}.child`);
/**
 * At a design, review, QA or investigation child's start (SubagentStart, from the brief hook): the first such child (reviewChild) that starts for a
 * running run binds the run to its thread, once (R1908-3), with the tip of its task's branch at the start: the commit that
 * it reviews (R1933-1), or no SHA for a task without a branch. Only that child's report is kept for the run.
 */
export function bindChild(transcript, cwd, env = process.env) {
  try {
    const child = reviewChild(sessionMeta(transcript)), run = child && tool.logbookView(cwd, env).row(child.run);
    if (!run || run.task !== child.task || run.role !== child.role || run.status !== "running") return;
    mkdirSync(dirname(bindingOf(cwd, child.run, env)), { recursive: true, mode: 0o700 });
    writeFileSync(bindingOf(cwd, child.run, env), JSON.stringify({ thread: child.thread, tip: branchHead(cwd, child.run, env) }), { flag: "wx", mode: 0o600 });
  } catch {}
}
/** The roles that commit during their run, on the branch that the run names (T585). */
const WRITERS = ["implementer", "arena-judge", "designer"];
/** The commit at the head of a run's branch in the project's repository, or "" (as the Claude hook reads it). A writer reads
 * the branch of its run and no other, so a missing branch gives "". Any other run reads the branch of its task (T585). */
function branchHead(cwd, run, env) {
  const view = tool.logbookView(cwd, env), row = view.row(run);
  const branch = WRITERS.includes(row?.role) ? row.branch : view.task(row?.task)?.branch;
  if (!branch) return "";
  const clean = Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith("GIT_")));
  const r = spawnSync("git", ["-C", cwd, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`], { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"], env: clean });
  const sha = String(r.stdout ?? "").trim();
  return r.status === 0 && /^[0-9a-f]{40}$/.test(sha) ? sha : "";
}
/**
 * Keep the report of the child that its run is bound to, where the state tool reads it for the run's verdict (T483), with
 * its commit. A writer's commit is the head of its branch at this stop: the branch has one writer while the run runs, so that
 * head is the run's own work (T585). Another run's commit is the branch tip at its start, when the branch did not move until
 * this stop; else none, so the report's own BRANCH must name the full head SHA (R1933-1). The line for the chief when the
 * state tool refused to keep it (for one, a second report of the run), or undefined.
 * Design and investigation reports may have no SHA; their retention never grants a verdict or design approval.
 */
function keep(meta, text, cwd, env) {
  const child = reviewChild(meta);
  if (!child || typeof text !== "string" || typeof cwd !== "string") return undefined;
  try {
    const bound = JSON.parse(readFileSync(bindingOf(cwd, child.run, env), "utf8"));
    if (bound?.thread !== child.thread) return `sage: ${child.run}'s report is not kept: this agent is not the child that started for ${child.run}.`;
    const head = branchHead(cwd, child.run, env);
    const sha = WRITERS.includes(child.role) || bound.tip === head ? head : "";
    tool.keepReport(cwd, { role: child.role, task: child.task, run: child.run, sha, text }, env);
  } catch (error) {
    return error?.code === "ENOENT" ? `sage: ${child.run}'s report is not kept: no child started for ${child.run} while it ran.` : `sage: ${child.run}'s report is not kept: ${error?.message ?? error}`;
  }
  return undefined;
}

/** The most of a session record's end that tokenTotal reads. Codex writes a token line after each model response, so the last one is near the end. */
export const TAIL_BYTES = 8 << 20;
/**
 * An agent's own token count from its Codex session record (T954): thread_token_usage.total_tokens of the last
 * token_usage_record line of its own thread (a line of another thread is skipped), as { tokens }, a whole number as text.
 * When the record gives none, { reason }: the gate never guesses a number.
 */
export function tokenTotal(path, thread) {
  let text;
  try {
    const fd = openSync(path, "r");
    try {
      const size = fstatSync(fd).size, start = Math.max(0, size - TAIL_BYTES), chunk = Buffer.alloc(size - start);
      text = chunk.subarray(0, readSync(fd, chunk, 0, chunk.length, start)).toString("utf8");
      if (start) text = text.slice(text.indexOf("\n") + 1); // the first line of a tail is only a part of a line
    } finally { closeSync(fd); }
  } catch (error) { return { reason: `the session record cannot be read (${error?.code ?? "unknown error"})` }; }
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].trim()) continue;
    let line;
    try { line = JSON.parse(lines[i]); } catch { return { reason: "a line of the session record is not JSON" }; }
    if (line?.type !== "token_usage_record" || line.payload?.thread_id !== thread) continue;
    const total = line.payload.thread_token_usage?.total_tokens;
    return Number.isSafeInteger(total) && total > 0 && total < 1e12 ? { tokens: String(total) }
      : { reason: `the last token_usage_record of the session record has no total_tokens of 1 to 12 digits (${JSON.stringify(total) ?? "none"})` };
  }
  return { reason: `the session record has no token_usage_record line of this agent in its last ${TAIL_BYTES >> 20} MiB` };
}
/** The roles whose run gets its token count at its stop: each role of a run, and the lead. */
const USAGE_ROLES = { ...REPORT_ROLES, lead: "lead" };
/** At the stop of a run's agent, keep its token count for the run, or why there is none (T954). It never stops the agent. */
function keepTokens(meta, path, cwd, env) {
  const child = reviewChild(meta, USAGE_ROLES);
  if (!child || typeof cwd !== "string") return;
  const { tokens, reason } = tokenTotal(path, child.thread);
  try {
    tool.keepUsage(cwd, { role: child.role, task: child.task, run: child.run, tokens, source: "Codex session record: thread_token_usage.total_tokens of the agent's last token_usage_record line",
      evidence: reason ? `unavailable: ${reason}` : `the record of thread ${child.thread}, read at SubagentStop` }, env);
  } catch {}
}

export function reportGate(input, env = process.env) {
  const message = input?.last_assistant_message;
  if (input?.hook_event_name !== "SubagentStop" || typeof input.stop_hook_active !== "boolean"
    || !(message === null || typeof message === "string") || typeof input.agent_transcript_path !== "string") return { systemMessage: UNREAD };
  let task, meta;
  try { meta = sessionMeta(input.agent_transcript_path); task = agentPathOf(meta).at(-1) ?? ""; } catch { return { systemMessage: UNREAD }; }
  const missing = sageName(task) ? missingFields(REPORT_FIELDS, message ?? "") : [];
  // A review or QA child's report is read with the one reader at its first stop, as the Claude stop gate does: an unreadable
  // report, or a medium or high finding without a proof that the proof check can rerun (T947), gets one fix chance, and the
  // second stop keeps it (T560). One stop names both problems (T964).
  const reason = !missing.length && !input.stop_hook_active && REVIEW_NAME.test(task) ? stopReason(message, typeof input.cwd === "string" ? input.cwd : process.cwd(), { who: "the report check" }) : undefined;
  if (reason) return { decision: "block", reason };
  // A stop that goes through retains the bound child's exact report; the chief decides the outcome separately.
  const unkept = !missing.length || input.stop_hook_active ? keep(meta, message, input.cwd, env) : undefined;
  if (!missing.length || input.stop_hook_active) keepTokens(meta, input.agent_transcript_path, input.cwd, env);
  if (!missing.length) return unkept ? { systemMessage: unkept } : {};
  if (input.stop_hook_active) return { systemMessage: [`sage: the agent ${task} ended without a full report (no ${missing.join(", ")}). The chief reads it as it is.`, unkept].filter(Boolean).join(" ") };
  return { decision: "block", reason: `sage: your report has no ${missing.join(", ")}. End with the sage report: ${REPORT_FIELDS.join(", ")}, each at the start of a line that is not in a list or a code block, with "none" where a field has nothing.` };
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  let input;
  try { input = JSON.parse(readFileSync(0, "utf8")); } catch { input = undefined; }
  process.stdout.write(JSON.stringify(reportGate(input)));
}
