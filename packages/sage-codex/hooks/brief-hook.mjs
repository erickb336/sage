#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BRIEF_FIELDS, briefSections, missingBriefFields } from "sage-core";
import { tool } from "../skills/sage/sage.mjs";
import { bindChild, childTask, keepRunText, sageName, TASK_NAME } from "./report-gate.mjs";
import { TESTED_CODEX } from "./sage-codex-hook.mjs";
import { modeDirectory } from "./hook-state.mjs";

export const BRIEF_LIMIT = 32 * 1024;
const unread = () => ({ systemMessage: `sage: the brief check could not read what Codex sent it, so this agent starts without its brief note. If this comes again, update the sage plugin, and keep Codex in the tested range (${TESTED_CODEX.join(" to ")}).` });
export const NAME_RULE = "sage_, the role with _ for -, the task, and the run, for example sage_implementer_t12_r40";
export const BRIEF_AGE = 30 * 60_000;

const briefFile = (project, task, env) => join(tool.storeDir(project, env), "briefs", `${task}.json`);
const projectNote = (session, task, env) => join(modeDirectory(env), "briefs", `${createHash("sha256").update(JSON.stringify([session, task])).digest("hex")}.json`);

export function briefProject(cwd, session, task, env = process.env) {
  try {
    const project = JSON.parse(readFileSync(projectNote(session, task, env), "utf8"));
    if (typeof project === "string" && isAbsolute(project)) return project;
  } catch {}
  return cwd;
}

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

export function readBrief(project, task, env = process.env) {
  if (!TASK_NAME.test(task)) return null;
  try {
    const record = JSON.parse(readFileSync(briefFile(project, task, env), "utf8"));
    return record?.task === task && typeof record.text === "string" ? { text: record.text, missing: missingBriefFields(record.text), checked: record.checked } : null;
  } catch { return null; }
}

export function briefChecked(project, task, env = process.env, now = Date.now()) {
  const brief = readBrief(project, task, env);
  return !!brief && !brief.missing.length && Number.isFinite(brief.checked) && now - brief.checked <= BRIEF_AGE;
}

function startNote(input, env) {
  if (typeof input.transcript_path !== "string" || typeof input.cwd !== "string") return unread();
  let task;
  try { task = childTask(input.transcript_path); } catch { return unread(); }
  if (!sageName(task)) return {};
  bindChild(input.transcript_path, input.cwd, env);
  const project = briefProject(input.cwd, input.session_id, task, env);
  const standing = tool.command(["standing", `--project=${project}`], env);
  const brief = readBrief(project, task, env);
  const parts = standing.code === 0 ? [`sage: the standing orders of this project, from its logbook. Follow each one.\n\n${standing.text}`] : [];
  if (brief && !brief.missing.length) keepRunText(project, "briefs", task, brief.text, env);
  if (brief && !brief.missing.length) parts.push(`FORBIDDEN, from your checked brief. Never do these:\n${briefSections(brief.text).FORBIDDEN}`, `Your checked brief (${task}), as it was recorded:\n\n${brief.text}`);
  else parts.push("sage: no checked brief for this task.");
  return { hookSpecificOutput: { hookEventName: "SubagentStart", additionalContext: parts.join("\n\n") } };
}

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

export function briefHook(input, env = process.env) {
  if (input?.hook_event_name === "SubagentStart") return startNote(input, env);
  if (input?.hook_event_name === "PostToolUse") return spawnWarning(input, env);
  return unread();
}

export function briefAnswer(input) {
  try { return briefHook(input); } catch { return unread(); }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  let input;
  try { input = JSON.parse(readFileSync(0, "utf8")); } catch {}
  process.stdout.write(JSON.stringify(briefAnswer(input)));
}
