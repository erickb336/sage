#!/usr/bin/env node
// The brief check of Codex (T462, form A of T463). Before each spawn the chief runs the sage MCP tool `brief`:
// it checks the brief's fields with core's BRIEF_FIELDS and keeps the brief in the project's logbook by task name
// (briefs/<task name>.json). This hook reads that record. It never blocks a spawn and never changes the spawn message,
// because with a real model the message is encrypted:
//   - SubagentStart, for a sage child (task name sage_..., from the first line of its transcript, as the report gate
//     reads it): a developer note with the project's standing orders, the FORBIDDEN field of the checked brief and the
//     brief itself, or one line that no checked brief is on record.
//   - PostToolUse of spawn_agent: when no checked brief is on record for the task name, a warning to the chief that
//     names the missing fields and says to run the brief check.
// The project is the folder that Codex gives the hook (cwd), as for the state tool's --project.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BRIEF_FIELDS, briefSections, missingBriefFields } from "sage-core";
import { tool } from "../skills/sage/sage.mjs";
import { bindChild, childTask, noteStart, reserveReview, sageName, TASK_NAME } from "./report-gate.mjs";
import { TESTED_CODEX } from "./sage-codex-hook.mjs";

/** The largest brief, as core's brief reader: 32 KiB. */
export const BRIEF_LIMIT = 32 * 1024;
const UNREAD = `sage: the brief check could not read what Codex sent it, so this agent starts without its brief note. If this comes again, update the sage plugin, and keep Codex in the tested range (${TESTED_CODEX.join(" to ")}).`;
export const NAME_RULE = "sage_, the role with _ for -, the task, and the run, for example sage_implementer_t12_r40";

const briefFile = (project, task, env) => join(tool.storeDir(project, env), "briefs", `${task}.json`);

/** Check a brief and keep it by task name. It returns the missing fields, and throws without the project's logbook. */
export function recordBrief(project, task, text, env = process.env, session) {
  if (!TASK_NAME.test(task)) throw Error(`"${task}" is not a sage task name: ${NAME_RULE}`);
  if (Buffer.byteLength(text, "utf8") > BRIEF_LIMIT) throw Error("the brief is over 32 KiB");
  const file = briefFile(project, task, env);
  if (!existsSync(dirname(file))) throw Error(`no logbook for the project ${project}. Run init first.`);
  const missing = missingBriefFields(text);
  return tool.withLock(tool.storeDir(project, env), () => {
    const reservation = `${file.slice(0, -5)}.reservation.json`;
    let prior;
    if (existsSync(reservation)) {
      prior = JSON.parse(readFileSync(reservation, "utf8"));
      if (missing.length || prior.session !== session || prior.brief !== createHash("sha256").update(text).digest("hex")) {
        throw Error(`${task} already has a different review reservation`);
      }
    }
    const reservationId = !missing.length ? reserveReview(project, task, text, session, env) : undefined;
    if (prior && reservationId !== prior.id) throw Error(`${task} no longer has an eligible review reservation`);
    writeFileSync(`${file}.${process.pid}.tmp`, `${JSON.stringify({ task, text, ...(reservationId ? { reservation: reservationId } : {}) })}\n`, { mode: 0o600 });
    renameSync(`${file}.${process.pid}.tmp`, file);
    return missing;
  });
}

/** The brief on record for a task name, with its missing fields, or null for none or a record that it cannot read. */
export function readBrief(project, task, env = process.env) {
  if (!TASK_NAME.test(task)) return null;
  try {
    const record = JSON.parse(readFileSync(briefFile(project, task, env), "utf8"));
    return record?.task === task && typeof record.text === "string" ? { text: record.text, missing: missingBriefFields(record.text) } : null;
  } catch { return null; }
}

/** The note for a sage child at its start: the standing orders, the FORBIDDEN field and the checked brief, or the no-brief line. */
function startNote(input, env) {
  if (typeof input.transcript_path !== "string" || typeof input.cwd !== "string") return { systemMessage: UNREAD };
  let task;
  try { task = childTask(input.transcript_path); } catch { return { systemMessage: UNREAD }; }
  if (!sageName(task)) return {};
  bindChild(input.transcript_path, input.cwd, env, input); // a review or QA child of the chief: its run's report is its own (T483)
  const standing = tool.command(["standing", `--project=${input.cwd}`], env);
  const brief = readBrief(input.cwd, task, env);
  const parts = standing.code === 0 ? [`sage: the standing orders of this project, from its logbook. Follow each one.\n\n${standing.text}`] : [];
  if (brief && !brief.missing.length) parts.push(`FORBIDDEN, from your checked brief. Never do these:\n${briefSections(brief.text).FORBIDDEN}`, `Your checked brief (${task}), as the chief recorded it:\n\n${brief.text}`);
  else parts.push("sage: no checked brief for this task.");
  return { hookSpecificOutput: { hookEventName: "SubagentStart", additionalContext: parts.join("\n\n") } };
}

/** The warning to the chief after a spawn of a sage child with no checked brief on record. */
function spawnWarning(input, env) {
  const task = typeof input.tool_input?.task_name === "string" ? input.tool_input.task_name.split("/").at(-1) : "";
  if (!/spawn_agent$/.test(String(input.tool_name)) || !sageName(task) || typeof input.cwd !== "string") return {};
  const brief = readBrief(input.cwd, task, env);
  if (brief && !brief.missing.length) return {};
  const missing = brief ? `the recorded brief has no ${brief.missing.join(", ")}` : `no brief is on record, so ${BRIEF_FIELDS.join(", ")} are not checked`;
  return { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: `sage: ${task} started with no checked brief: ${missing}. Run the brief check: the sage tool \`brief\` with this task name and the whole brief, fix each missing field, then send the agent the fixed brief with \`send_message\`.` } };
}

/** The hook's answer to one SubagentStart or PostToolUse event. env names the logbook (CODEX_HOME or SAGE_HOME), for tests. */
export function briefHook(input, env = process.env) {
  if (input?.hook_event_name === "SubagentStart") { noteStart(input, env); return startNote(input, env); }
  if (input?.hook_event_name === "PostToolUse") return spawnWarning(input, env);
  return { systemMessage: UNREAD };
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  let output;
  try { output = briefHook(JSON.parse(readFileSync(0, "utf8"))); } catch { output = { systemMessage: UNREAD }; }
  process.stdout.write(JSON.stringify(output));
}
