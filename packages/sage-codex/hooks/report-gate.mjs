#!/usr/bin/env node
// The report check of Codex, on SubagentStop. A sage role agent is a child whose task name (the last part of
// its agent path) starts with "sage_" in any letter case, as skills/sage/references/roles.md tells the chief.
// Its first stop without every report field continues it once with the missing fields; the second stop
// goes through with one plain line, as the Claude stop gate. Other agents pass. An input that the gate
// cannot read stops nothing: it gives one plain line, and the gate never reads it as a checked report.
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { REPORT_FIELDS, missingReportFields } from "sage-core";
import { tool } from "../skills/sage/sage.mjs";

const UNREAD = "sage: the report check could not read this agent's stop, so it did not check its report. Missing child metadata is tracked in https://github.com/erickb336/sage/issues/376.";

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

/** The roles whose report backs a verdict, by the role part of a task name. */
const CHECKERS = { code_reviewer: "code-reviewer", security_reviewer: "security-reviewer", ux_reviewer: "ux-reviewer", qa: "qa" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const digest = text => createHash("sha256").update(text).digest("hex");
const reservationFile = (dir, name) => join(dir, "briefs", `${name}.reservation.json`);
const startFile = (dir, child) => join(dir, "kept", "starts", `${child}.json`);
const readJson = path => JSON.parse(readFileSync(path, "utf8"));
const childClaimed = (dir, child) => {
  const kept = join(dir, "kept");
  return existsSync(kept) && readdirSync(kept).filter(name => /^R[1-9]\d*\.child$/.test(name)).some(name => {
    try { return readJson(join(kept, name)).thread === child; } catch { return true; }
  });
};

/** Preserve the checked brief and head before spawn. The caller holds the project lock. */
export function reserveReview(project, name, text, session, env = process.env) {
  const child = reviewChild({ id: "reservation", agent_path: `/root/${name}` });
  if (!child || !UUID.test(session ?? "") || text.split(/\r?\n/, 1)[0] !== `Run ${child.run} · task ${child.task}`) return;
  const dir = tool.storeDir(project, env), view = tool.logbookView(project, env), run = view.row(child.run), task = view.task(child.task);
  if (run?.task !== child.task || run.role !== child.role || run.status !== "running" || !task?.branch) return;
  const tip = branchHead(project, child.task, env);
  if (!tip) return;
  const record = { name, task: child.task, run: child.run, role: child.role, project: tool.projectRoot(project), session,
    branch: task.branch, tip, brief: digest(text) };
  const file = reservationFile(dir, name);
  if (existsSync(file)) {
    const { id, ...prior } = readJson(file);
    if (!UUID.test(id ?? "") || JSON.stringify(prior) !== JSON.stringify(record)) throw Error(`${name} already has a different review reservation`);
    return id;
  }
  const id = randomUUID();
  writeFileSync(file, JSON.stringify({ id, ...record }), { flag: "wx", mode: 0o600 });
  return id;
}

/** A reservation remains eligible only while its checked brief, run, project and original head still match. */
function eligible(project, record, session, env) {
  if (!record || !UUID.test(record.id ?? "") || record.session !== session || record.project !== tool.projectRoot(project)) return false;
  const child = reviewChild({ id: "reservation", agent_path: `/root/${record.name}` });
  if (!child || child.task !== record.task || child.run !== record.run || child.role !== record.role) return false;
  const view = tool.logbookView(project, env), run = view.row(record.run), task = view.task(record.task);
  if (run?.task !== record.task || run.role !== record.role || run.status !== "running" || task?.branch !== record.branch
    || !/^[0-9a-f]{40}$/.test(record.tip ?? "") || branchHead(project, record.task, env) !== record.tip) return false;
  const brief = readJson(join(tool.storeDir(project, env), "briefs", `${record.name}.json`));
  return brief.task === record.name && brief.reservation === record.id && typeof brief.text === "string" && digest(brief.text) === record.brief;
}

/** Snapshot prior reservations at Start even when its transcript is unavailable. */
export function noteStart(input, env = process.env) {
  const { cwd, session_id: session, agent_id: child, turn_id: turn } = input;
  if (typeof cwd !== "string" || !UUID.test(session ?? "") || !UUID.test(child ?? "") || child === session
    || typeof turn !== "string" || !turn) return;
  try {
    const dir = tool.storeDir(cwd, env);
    tool.withLock(dir, () => {
      const candidates = readdirSync(join(dir, "briefs")).filter(name => name.endsWith(".reservation.json")).sort().flatMap(name => {
        try { const record = readJson(join(dir, "briefs", name)); return eligible(cwd, record, session, env) ? [record] : []; } catch { return []; }
      });
      if (!candidates.length) return;
      let observed;
      try { const meta = sessionMeta(input.transcript_path); if (typeof meta.agent_path === "string") observed = meta; } catch {}
      const file = startFile(dir, child), record = JSON.stringify({ session, child, turn, project: tool.projectRoot(cwd), candidates,
        ...(observed ? { observedPath: observed.agent_path, conflict: contradicts(observed, input) } : {}) });
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      try { writeFileSync(file, record, { flag: "wx", mode: 0o600 }); }
      catch (error) {
        if (error.code !== "EEXIST") throw error;
        if (readFileSync(file, "utf8") !== record) writeFileSync(`${file}.conflict`, "conflict", { mode: 0o600 });
      }
    });
  } catch { /* An unreadable reservation cannot support a later binding. */ }
}

/** Reject identity fields that contradict the lifecycle event; missing fields do not establish a delayed binding. */
function contradicts(meta, input) {
  if (typeof input.agent_id === "string" && meta.id !== input.agent_id) return true;
  if (Object.hasOwn(meta, "session_id") && meta.session_id !== input.session_id) return true;
  if (Object.hasOwn(meta, "parent_thread_id") && meta.parent_thread_id !== input.session_id) return true;
  if (Object.hasOwn(meta, "cwd") && (typeof meta.cwd !== "string" || tool.projectRoot(meta.cwd) !== tool.projectRoot(input.cwd))) return true;
  if (Object.hasOwn(meta, "source")) {
    const spawn = meta.source?.subagent?.thread_spawn;
    if (!spawn || typeof spawn !== "object" || Array.isArray(spawn) || (Object.hasOwn(spawn, "depth") && spawn.depth !== 1)
      || (Object.hasOwn(spawn, "agent_path") && spawn.agent_path !== meta.agent_path)
      || (Object.hasOwn(spawn, "parent_thread_id") && spawn.parent_thread_id !== input.session_id)) return true;
  }
  return false;
}

/** Verify the host-selected child's complete direct-parent identity at Stop. */
function directChild(meta, input) {
  const child = reviewChild(meta), spawn = meta?.source?.subagent?.thread_spawn;
  return child && UUID.test(input.session_id ?? "") && UUID.test(input.agent_id ?? "")
    && child.thread === input.agent_id && child.thread !== input.session_id
    && meta.session_id === input.session_id && meta.parent_thread_id === input.session_id
    && typeof meta.cwd === "string" && meta.cwd.startsWith("/") && tool.projectRoot(meta.cwd) === tool.projectRoot(input.cwd)
    && meta.agent_path === `/root/${meta.agent_path?.split("/").at(-1)}`
    && spawn && typeof spawn === "object" && !Array.isArray(spawn) && spawn.depth === 1
    && spawn.parent_thread_id === input.session_id && spawn.agent_path === meta.agent_path ? child : undefined;
}

/** Bind only an unchanged reservation from this child's earlier Start. The caller holds the project lock. */
function bindDelayed(meta, input, env) {
  const child = directChild(meta, input);
  if (!child) return;
  const dir = tool.storeDir(input.cwd, env), file = startFile(dir, child.thread);
  if (existsSync(`${file}.conflict`)) return;
  const start = readJson(file);
  if (start.child !== child.thread || start.session !== input.session_id || start.project !== tool.projectRoot(input.cwd)
    || start.conflict || (start.observedPath && start.observedPath !== meta.agent_path) || !Array.isArray(start.candidates)) return;
  const matches = start.candidates.filter(record => record.name === meta.agent_path.slice("/root/".length));
  if (matches.length !== 1) return;
  const saved = matches[0], current = readJson(reservationFile(dir, saved.name));
  if (JSON.stringify(current) !== JSON.stringify(saved) || !eligible(input.cwd, saved, input.session_id, env)) return;
  if (childClaimed(dir, child.thread)) return;
  writeFileSync(bindingOf(input.cwd, child.run, env), JSON.stringify({ thread: child.thread, tip: saved.tip, session: input.session_id, delayed: true }), { flag: "wx", mode: 0o600 });
}
/**
 * The run of a review or QA child of the chief (T483): its task name carries the run (sage_qa_t12_r40), and its agent path
 * is the root thread and that name, so a child of a child never names a run. Its thread id is the session_meta id.
 */
export function reviewChild(meta) {
  const path = agentPathOf(meta), [, role, number, run] = /^sage_([a-z_]+)_t([1-9]\d*)_(r[1-9]\d*)$/.exec(path.at(-1) ?? "") ?? [];
  if (!CHECKERS[role] || path.length !== 2 || path[0] !== "root" || meta.agent_path !== `/root/${path[1]}` || typeof meta.id !== "string" || !meta.id) return undefined;
  return { role: CHECKERS[role], task: `T${number}`, run: run.toUpperCase(), thread: meta.id };
}
const bindingOf = (cwd, run, env) => join(tool.storeDir(cwd, env), "kept", `${run}.child`);
/**
 * At a review or QA child's start (SubagentStart, from the brief hook): the first child of the chief that starts for a
 * running run binds the run to its thread once (R1908-3). A reservation supplies its earlier head; without one, the
 * branch tip at start supplies the head (R1933-1). Only that child's report is kept for the run.
 */
export function bindChild(transcript, cwd, env = process.env, input = {}) {
  try {
    const meta = sessionMeta(transcript), child = reviewChild(meta);
    if (!child || contradicts(meta, input)) return;
    const dir = tool.storeDir(cwd, env);
    tool.withLock(dir, () => {
      const run = tool.logbookView(cwd, env).row(child.run);
      if (!run || run.task !== child.task || run.role !== child.role || run.status !== "running") return;
      const name = meta.agent_path.slice("/root/".length), file = reservationFile(dir, name);
      let tip = branchHead(cwd, child.task, env), reserved = false;
      let brief;
      try { brief = readJson(join(dir, "briefs", `${name}.json`)); } catch {}
      if (brief?.reservation && !existsSync(file)) return;
      if (existsSync(file)) {
        const reservation = readJson(file), start = readJson(startFile(dir, child.thread));
        if (start.conflict || existsSync(`${startFile(dir, child.thread)}.conflict`) || start.observedPath !== meta.agent_path
          || !Array.isArray(start.candidates) || !start.candidates.some(candidate => JSON.stringify(candidate) === JSON.stringify(reservation))
          || !eligible(cwd, reservation, input.session_id, env)) return;
        if (childClaimed(dir, child.thread)) return;
        tip = reservation.tip;
        reserved = true;
      }
      mkdirSync(dirname(bindingOf(cwd, child.run, env)), { recursive: true, mode: 0o700 });
      writeFileSync(bindingOf(cwd, child.run, env), JSON.stringify({ thread: child.thread, tip,
        ...(reserved ? { reserved: true } : {}),
        ...(typeof input.agent_id === "string" && typeof input.session_id === "string" ? { session: input.session_id, eventBound: true } : {}) }), { flag: "wx", mode: 0o600 });
    });
  } catch {}
}
/** The commit at the head of a task's branch in the project's repository, or "" (as the Claude hook reads it). */
function branchHead(cwd, task, env) {
  const branch = tool.logbookView(cwd, env).task(task)?.branch;
  if (!branch) return "";
  const clean = Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith("GIT_")));
  const r = spawnSync("git", ["-C", cwd, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`], { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"], env: clean });
  const sha = String(r.stdout ?? "").trim();
  return r.status === 0 && /^[0-9a-f]{40}$/.test(sha) ? sha : "";
}
/**
 * Keep the bound child's report for its run's verdict (T483). A reserved head must still match at Stop. An older binding
 * without a reservation uses no head when the branch moved, so the report must name the full SHA (R1933-1). A report that
 * is not kept backs no verdict. Return a line for the chief when retention is refused, or undefined.
 */
function keep(meta, text, input, env) {
  const cwd = input.cwd;
  const child = reviewChild(meta);
  if (!child || typeof text !== "string" || typeof cwd !== "string") return undefined;
  try {
    return tool.withLock(tool.storeDir(cwd, env), () => {
      const file = bindingOf(cwd, child.run, env);
      if (!existsSync(file)) bindDelayed(meta, input, env);
      const bound = readJson(file);
      if (bound?.thread !== child.thread || (bound.eventBound && (input.agent_id !== child.thread || input.session_id !== bound.session || contradicts(meta, input)))
        || (bound.delayed && (!directChild(meta, input) || bound.session !== input.session_id
        || existsSync(`${startFile(tool.storeDir(cwd, env), child.thread)}.conflict`)))) return `sage: ${child.run}'s report is not kept: this agent is not the child that started for ${child.run}, so it backs no verdict.`;
      const sha = bound.tip && bound.tip === branchHead(cwd, child.task, env) ? bound.tip : "";
      if ((bound.delayed || bound.reserved) && !sha) return `sage: ${child.run}'s report is not kept: the reviewed head changed.`;
      tool.keepReport(cwd, { role: child.role, task: child.task, run: child.run, sha, text }, env);
      return undefined;
    });
  } catch (error) {
    return error?.code === "ENOENT" ? `sage: ${child.run}'s report is not kept: no child started for ${child.run} while it ran, so it backs no verdict.` : `sage: ${child.run}'s report is not kept: ${error?.message ?? error}`;
  }
  return undefined;
}

export function reportGate(input, env = process.env) {
  const message = input?.last_assistant_message;
  if (input?.hook_event_name !== "SubagentStop" || typeof input.stop_hook_active !== "boolean"
    || !(message === null || typeof message === "string") || typeof input.agent_transcript_path !== "string") return { systemMessage: UNREAD };
  let task, meta;
  try { meta = sessionMeta(input.agent_transcript_path); task = agentPathOf(meta).at(-1) ?? ""; } catch { return { systemMessage: UNREAD }; }
  const missing = sageName(task) ? missingReportFields(message ?? "") : [];
  // A stop that goes through keeps a review's or QA's report in the logbook, for its run's verdict (T483).
  const unkept = !missing.length || input.stop_hook_active ? keep(meta, message, input, env) : undefined;
  if (!missing.length) return unkept ? { systemMessage: unkept } : {};
  if (input.stop_hook_active) return { systemMessage: [`sage: the agent ${task} ended without a full report (no ${missing.join(", ")}). The chief reads it as it is.`, unkept].filter(Boolean).join(" ") };
  return { decision: "block", reason: `sage: your report has no ${missing.join(", ")}. End with the sage report: ${REPORT_FIELDS.join(", ")}, each at the start of a line that is not in a list or a code block, with "none" where a field has nothing.` };
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  let input;
  try { input = JSON.parse(readFileSync(0, "utf8")); } catch { input = undefined; }
  process.stdout.write(JSON.stringify(reportGate(input)));
}
