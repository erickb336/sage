#!/usr/bin/env node
// The brief check of Codex (T462, form A of T463). Before each spawn the chief or a lead runs the sage MCP tool `brief`:
// it checks the brief's fields with core's BRIEF_FIELDS and keeps the brief in the project's logbook by task name
// (briefs/<task name>.json), with the time of the check when no field is missing. The gate reads that record before a
// spawn (T950): a sage spawn with no brief checked in the last BRIEF_AGE does not start. This hook reads the same record.
// No hook changes the spawn message, because with a real model the message is encrypted:
//   - SubagentStart, for a sage child (task name sage_..., from the first line of its transcript, as the report gate
//     reads it): a developer note with the project's standing orders, the FORBIDDEN field of the checked brief and the
//     brief itself, or one line that no checked brief is on record.
//   - PostToolUse of spawn_agent: when no checked brief is on record for the task name, a warning to the chief or the
//     lead that names the missing fields and gives the next steps. In sage mode the gate refuses such a spawn first.
// The project is the brief tool's project for this session and task name (briefProject), else the folder that Codex
// gives the hook (cwd), as for the state tool's --project.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BRIEF_FIELDS, briefSections, missingBriefFields } from "sage-core";
import { tool } from "../skills/sage/sage.mjs";
import { bindChild, childTask, sageName, TASK_NAME } from "./report-gate.mjs";
import { TESTED_CODEX } from "./sage-codex-hook.mjs";
import { modeDirectory } from "./hook-state.mjs";

/** The largest brief, as core's brief reader: 32 KiB. */
export const BRIEF_LIMIT = 32 * 1024;
// A function, not a constant: the gate imports this file while sage-codex-hook.mjs may still load (it imports
// start-mark.mjs, which imports the gate), so TESTED_CODEX is read only when a hook runs.
const unread = () => ({ systemMessage: `sage: the brief check could not read what Codex sent it, so this agent starts without its brief note. If this comes again, update the sage plugin, and keep Codex in the tested range (${TESTED_CODEX.join(" to ")}).` });
export const NAME_RULE = "sage_, the role with _ for -, the task, and the run, for example sage_implementer_t12_r40";
/**
 * How long a checked brief lets a spawn of its task name start (T950): 30 minutes. A time, not one use, because Codex
 * can refuse a spawn after the gate passed it (its thread limit), and the chief's and the lead's steps then spawn again
 * with the same task name.
 */
export const BRIEF_AGE = 30 * 60_000;

const briefFile = (project, task, env) => join(tool.storeDir(project, env), "briefs", `${task}.json`);
/**
 * The note of the project of a session's last brief check of a task name (F-T950-1), in the mode folder. The brief tool
 * keeps the record in its project's logbook, and the session's folder may be outside that project. Codex gives every
 * thread of a session, and the sage server, the root's session id.
 */
const projectNote = (session, task, env) => join(modeDirectory(env), "briefs", `${createHash("sha256").update(JSON.stringify([session, task])).digest("hex")}.json`);

/** The project whose logbook holds the brief of this session's task name: the brief tool's project, else the session's folder. */
export function briefProject(cwd, session, task, env = process.env) {
  try {
    const project = JSON.parse(readFileSync(projectNote(session, task, env), "utf8"));
    if (typeof project === "string" && isAbsolute(project)) return project;
  } catch { /* No check of this session: its folder. */ }
  return cwd;
}

/**
 * Check a brief and keep it by task name, with the time of the check when no field is missing, and for a session, the
 * note of its project. It returns the missing fields, and throws without the project's logbook.
 */
export function recordBrief(project, task, text, env = process.env, session) {
  if (!TASK_NAME.test(task)) throw Error(`"${task}" is not a sage task name: ${NAME_RULE}`);
  if (Buffer.byteLength(text, "utf8") > BRIEF_LIMIT) throw Error("the brief is over 32 KiB");
  const file = briefFile(project, task, env), missing = missingBriefFields(text);
  if (!existsSync(dirname(file))) throw Error(`no logbook for the project ${project}. Run init first.`);
  writeFileSync(`${file}.${process.pid}.tmp`, `${JSON.stringify({ task, text, ...(missing.length ? {} : { checked: Date.now() }) })}\n`, { mode: 0o600 });
  renameSync(`${file}.${process.pid}.tmp`, file);
  if (typeof session === "string" && session) {
    const note = projectNote(session, task, env);
    mkdirSync(dirname(note), { recursive: true, mode: 0o700 });
    writeFileSync(note, JSON.stringify(project), { mode: 0o600 });
  }
  return missing;
}

/** The brief on record for a task name, with its missing fields and the time of its check, or null for none or a record that it cannot read. */
export function readBrief(project, task, env = process.env) {
  if (!TASK_NAME.test(task)) return null;
  try {
    const record = JSON.parse(readFileSync(briefFile(project, task, env), "utf8"));
    return record?.task === task && typeof record.text === "string" ? { text: record.text, missing: missingBriefFields(record.text), checked: record.checked } : null;
  } catch { return null; }
}

/** Whether the brief of this task name was checked with every field in the last BRIEF_AGE: the gate's test before a sage spawn (T950). */
export function briefChecked(project, task, env = process.env, now = Date.now()) {
  const brief = readBrief(project, task, env);
  return !!brief && !brief.missing.length && Number.isFinite(brief.checked) && now - brief.checked <= BRIEF_AGE;
}

/** The note for a sage child at its start: the standing orders, the FORBIDDEN field and the checked brief, or the no-brief line. */
function startNote(input, env) {
  if (typeof input.transcript_path !== "string" || typeof input.cwd !== "string") return unread();
  let task;
  try { task = childTask(input.transcript_path); } catch { return unread(); }
  if (!sageName(task)) return {};
  bindChild(input.transcript_path, input.cwd, env); // a report child of the chief or a lead: only its own report is retained
  const project = briefProject(input.cwd, input.session_id, task, env);
  const standing = tool.command(["standing", `--project=${project}`], env);
  const brief = readBrief(project, task, env);
  const parts = standing.code === 0 ? [`sage: the standing orders of this project, from its logbook. Follow each one.\n\n${standing.text}`] : [];
  if (brief && !brief.missing.length) parts.push(`FORBIDDEN, from your checked brief. Never do these:\n${briefSections(brief.text).FORBIDDEN}`, `Your checked brief (${task}), as it was recorded:\n\n${brief.text}`);
  else parts.push("sage: no checked brief for this task.");
  return { hookSpecificOutput: { hookEventName: "SubagentStart", additionalContext: parts.join("\n\n") } };
}

/**
 * The warning after a spawn of a sage child with no checked brief on record. The chief sends the fixed brief. A spawner with
 * an agent_id is a lead, and the gate refuses its messages, so its way out is a fresh agent on a new run.
 */
function spawnWarning(input, env) {
  const task = typeof input.tool_input?.task_name === "string" ? input.tool_input.task_name.split("/").at(-1) : "";
  if (!/spawn_agent$/.test(String(input.tool_name)) || !sageName(task) || typeof input.cwd !== "string") return {};
  const brief = readBrief(briefProject(input.cwd, input.session_id, task, env), task, env);
  if (brief && !brief.missing.length) return {};
  const missing = brief ? `the recorded brief has no ${brief.missing.join(", ")}` : `no brief is on record, so ${BRIEF_FIELDS.join(", ")} are not checked`;
  const next = Object.hasOwn(input, "agent_id")
    ? "A lead sends no message, so this agent stays without the note. Stop it with `interrupt_agent`, end its run as failed with the sage tool `run_done`, add a new run with `run_add`, run the sage tool `brief` with the new run's task name and the whole brief, fix each missing field, then spawn the new agent."
    : "Run the brief check: the sage tool `brief` with this task name and the whole brief, fix each missing field, then send the agent the fixed brief with `send_message`.";
  return { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: `sage: ${task} started with no checked brief: ${missing}. ${next}` } };
}

/** The hook's answer to one SubagentStart or PostToolUse event. env names the logbook (CODEX_HOME or SAGE_HOME), for tests. */
export function briefHook(input, env = process.env) {
  if (input?.hook_event_name === "SubagentStart") return startNote(input, env);
  if (input?.hook_event_name === "PostToolUse") return spawnWarning(input, env);
  return unread();
}

/** The hook's answer to one parsed event (undefined for an input that is not JSON), also when the hook fails. */
export function briefAnswer(input) {
  try { return briefHook(input); } catch { return unread(); }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  let input;
  try { input = JSON.parse(readFileSync(0, "utf8")); } catch { /* unread */ }
  process.stdout.write(JSON.stringify(briefAnswer(input)));
}
