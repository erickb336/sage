#!/usr/bin/env node
// The report check of Codex 0.160.0, on SubagentStop. A sage role agent is a child whose task name
// (the last part of its agent path) starts with "sage_", as skills/sage/references/roles.md tells the chief.
// Its first stop without every report field continues it once with the missing fields; the second stop
// goes through with one plain line, as the Claude stop gate. Other agents pass. An input that the gate
// cannot read stops nothing: it gives one plain line, and the gate never reads it as a checked report.
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { REPORT_FIELDS, missingReportFields } from "../core/index.mjs";

const UNREAD = "sage: the report check could not read this agent's stop, so it did not check its report.";

/** The task name of a sage role agent, from the session_meta line that starts a Codex child transcript. */
function sageTask(path) {
  const meta = JSON.parse(readFileSync(path, "utf8").split("\n", 1)[0]);
  if (meta?.type !== "session_meta") throw Error("no session_meta");
  const task = String(meta.payload?.agent_path ?? "").split("/").at(-1);
  return task.startsWith("sage_") ? task : undefined;
}

export function reportGate(input) {
  const message = input?.last_assistant_message;
  if (input?.hook_event_name !== "SubagentStop" || typeof input.stop_hook_active !== "boolean"
    || !(message === null || typeof message === "string") || typeof input.agent_transcript_path !== "string") return { systemMessage: UNREAD };
  let task;
  try { task = sageTask(input.agent_transcript_path); } catch { return { systemMessage: UNREAD }; }
  const missing = task ? missingReportFields(message ?? "") : [];
  if (!missing.length) return {};
  if (input.stop_hook_active) return { systemMessage: `sage: ${task} stopped, and its report still has no ${missing.join(", ")}. Read the report as it is.` };
  return { decision: "block", reason: `sage: your report has no ${missing.join(", ")}. End with the sage report: ${REPORT_FIELDS.join(", ")}, each at the start of a line that is not in a list or a code block, with "none" where a field has nothing.` };
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  let input;
  try { input = JSON.parse(readFileSync(0, "utf8")); } catch { input = undefined; }
  process.stdout.write(JSON.stringify(reportGate(input)));
}
