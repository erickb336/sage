#!/usr/bin/env node
// The report check of Codex, on SubagentStop. A sage role agent is a child whose task name (the last part of
// its agent path) starts with "sage_" in any letter case, as skills/sage/references/roles.md tells the chief.
// Its first stop without every report field continues it once with the missing fields; the second stop
// goes through with one plain line, as the Claude stop gate. Other agents pass. An input that the gate
// cannot read stops nothing: it gives one plain line, and the gate never reads it as a checked report.
import { closeSync, openSync, readFileSync, readSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { REPORT_FIELDS, missingReportFields } from "../core/index.mjs";

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

export function reportGate(input) {
  const message = input?.last_assistant_message;
  if (input?.hook_event_name !== "SubagentStop" || typeof input.stop_hook_active !== "boolean"
    || !(message === null || typeof message === "string") || typeof input.agent_transcript_path !== "string") return { systemMessage: UNREAD };
  let task;
  try { task = childTask(input.agent_transcript_path); } catch { return { systemMessage: UNREAD }; }
  const missing = sageName(task) ? missingReportFields(message ?? "") : [];
  if (!missing.length) return {};
  if (input.stop_hook_active) return { systemMessage: `sage: the agent ${task} ended without a full report (no ${missing.join(", ")}). The chief reads it as it is.` };
  return { decision: "block", reason: `sage: your report has no ${missing.join(", ")}. End with the sage report: ${REPORT_FIELDS.join(", ")}, each at the start of a line that is not in a list or a code block, with "none" where a field has nothing.` };
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  let input;
  try { input = JSON.parse(readFileSync(0, "utf8")); } catch { input = undefined; }
  process.stdout.write(JSON.stringify(reportGate(input)));
}
