#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { REPORT_FIELDS, TEAM, missingFields, stopReason } from "sage-core";
import { tool } from "../skills/sage/sage.mjs";

const UNREAD = "sage: the report check could not read this agent's stop, so it did not check its report.";

export const TASK_NAME = /^sage_([a-z]+(?:_[a-z]+)*)_t[1-9]\d*(?:_r[1-9]\d*)?$/;
export const sageName = (name) => /^sage_/i.test(name);

export const META_BYTES = 1 << 20;

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

export const agentPathOf = (meta) => String(meta.agent_path ?? "").split("/").filter(Boolean);
export const agentPath = (path) => agentPathOf(sessionMeta(path));

export const childTask = (path) => agentPath(path).at(-1) ?? "";

const RUN_NAME = /_t([1-9]\d*)(?:_r([1-9]\d*))?$/;
export function keepRunText(project, kind, name, text, env = process.env) {
  const [, task, run] = RUN_NAME.exec(String(name)) ?? [], [, said, saidTask] = /^Run (R[1-9]\d*) · task (T[1-9]\d*)(?![\w/])/.exec(String(text ?? "").split("\n", 1)[0]) ?? [];
  const named = run ? { run: `R${run}`, task: `T${task}` } : said && (!task || saidTask === `T${task}`) && { run: said, task: saidTask };
  if (!named || typeof text !== "string" || typeof project !== "string") return;
  try { tool.keepRunText(project, { kind, ...named, text }, env); } catch {}
}

const REPORT_ROLES = { implementer: "implementer", arena_judge: "arena-judge", pe: "pe", designer: "designer", investigate: "investigate", evidence_review: "evidence-review", code_reviewer: "code-reviewer", security_reviewer: "security-reviewer", ux_reviewer: "ux-reviewer", qa: "qa" };
export function reviewChild(meta, roles = REPORT_ROLES) {
  const path = agentPathOf(meta), [, role, number, run] = /^sage_([a-z_]+)_t([1-9]\d*)_(r[1-9]\d*)$/.exec(path.at(-1) ?? "") ?? [];
  const underLead = path.length === 3 && TEAM.has(roles[role]) && new RegExp(`^sage_lead_t${number}(?:_r[1-9]\\d*)?$`).test(path[1]);
  if (!roles[role] || (path.length !== 2 && !underLead) || path[0] !== "root" || typeof meta.id !== "string" || !meta.id) return undefined;
  return { role: roles[role], task: `T${number}`, run: run.toUpperCase(), thread: meta.id };
}
const REVIEW_NAME = /^sage_(?:code_reviewer|security_reviewer|ux_reviewer|qa)(?:_|$)/i;
const bindingOf =(cwd, run, env) => join(tool.storeDir(cwd, env), "kept", `${run}.child`);
export function bindChild(transcript, cwd, env = process.env) {
  try {
    const child = reviewChild(sessionMeta(transcript)), run = child && tool.logbookView(cwd, env).row(child.run);
    if (!run || run.task !== child.task || run.role !== child.role || run.status !== "running") return;
    mkdirSync(dirname(bindingOf(cwd, child.run, env)), { recursive: true, mode: 0o700 });
    writeFileSync(bindingOf(cwd, child.run, env), JSON.stringify({ thread: child.thread, tip: branchHead(cwd, child.run, env) }), { flag: "wx", mode: 0o600 });
  } catch {}
}
const WRITERS = ["implementer", "arena-judge", "designer"];
function branchHead(cwd, run, env) {
  const view = tool.logbookView(cwd, env), row = view.row(run);
  const branch = WRITERS.includes(row?.role) ? row.branch : view.task(row?.task)?.branch;
  if (!branch) return "";
  const clean = Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith("GIT_")));
  const r = spawnSync("git", ["-C", cwd, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`], { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"], env: clean });
  const sha = String(r.stdout ?? "").trim();
  return r.status === 0 && /^[0-9a-f]{40}$/.test(sha) ? sha : "";
}
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

export const TAIL_BYTES = 8 << 20;
export function tokenTotal(path, thread) {
  let text;
  try {
    const fd = openSync(path, "r");
    try {
      const size = fstatSync(fd).size, start = Math.max(0, size - TAIL_BYTES), chunk = Buffer.alloc(size - start);
      text = chunk.subarray(0, readSync(fd, chunk, 0, chunk.length, start)).toString("utf8");
      if (start) text = text.slice(text.indexOf("\n") + 1);
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
const USAGE_ROLES = { ...REPORT_ROLES, lead: "lead" };
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
  const reason = !missing.length && !input.stop_hook_active && REVIEW_NAME.test(task) ? stopReason(message, typeof input.cwd === "string" ? input.cwd : process.cwd(), { who: "the report check" }) : undefined;
  if (reason) return { decision: "block", reason };
  const unkept = !missing.length || input.stop_hook_active ? keep(meta, message, input.cwd, env) : undefined;
  if (sageName(task) && (!missing.length || input.stop_hook_active)) keepRunText(input.cwd, "reports", task, message, env);
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
