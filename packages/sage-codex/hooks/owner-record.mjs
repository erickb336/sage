// The owner's autopilot switch, read from Codex's record of the session (the rollout file at transcript_path), for the
// Codex autopilot (T663). Ported from the T662 proof (gate-lib.mjs). It reads only: no write and no saved state.
//
// It fails closed. Each case below refuses (readRecord or autopilotSwitch gives { refused }), so autopilot counts as off.
// A refusal is a plain cause and one next step, then a short technical detail in brackets:
//   - no record path, a read error, or a record over 64 MiB;
//   - a last line that is still partial after 3 re-reads (Codex writes the record in the background);
//   - a line that is not JSON, or not an object with a known top-level type and an object payload, or an
//     inter_agent_communication_metadata line whose payload is not only { trigger_turn: boolean };
//   - no session_meta line, or a session_meta whose cli_version is not 0.164 or later in the strict form;
//   - no start mark, or a start mark whose line count does not fit the record.
// The owner's switches replay with core's own mode rules (switchModes), so the reader agrees with core: an on counts
// only while sage mode is on at that point, and the off form of the mode phrase ends autopilot.
//   - A message's text is the text that the sage hook gets: its text items joined, without Codex's tags around an
//     image (<image name=[Image #1] path="…"> and </image>, real records of Codex 0.164 and 0.166) and without an item
//     of another kind than the user's text (Codex's note for an image that it could not read).
//   - An off (the off phrase, or the off form of the mode phrase) counts from any user message, whatever its metadata,
//     and from Codex's UserMessage event too: a missed off is a safety failure, and an extra off only makes merges wait.
//   - Every other switch counts only from the owner's message: a user message with one metadata item for each content
//     item, each with provenance user (Codex marks hook text, goal text and its own context as harness or tool). The
//     mode phrase counts also with an image, as the hook counts it; the on phrase counts only alone, with no image.
//   - The replay starts at the last session_meta line with both modes off, as a new mode file does (a fork's record
//     starts fresh: proof case 5b). A resume writes no session_meta, so sage mode carries over a resume, as the
//     session's mode file does.
//   - An on counts only after the start mark (proof case 5c: a resume must not count an earlier on), and only in a turn
//     that a person started: turn trigger user in the TUI, exec for codex exec, and composer for a message typed in the
//     desktop app (F-T677-12: its send path sets turnTrigger ?? "composer"; a queued message is composer_queue or
//     composer_queue_run_now, an automation automation_cron_* or automation_heartbeat_*, and Codex's own turns name
//     theirs, such as queue, goal, guardian_review or memory_consolidation). A client that sends no trigger gets none,
//     and its on counts for nothing. Input from codex queue also has provenance user, but its turn trigger is queue:
//     there an on counts for nothing. The trigger is the client's word: an agent that runs codex exec on purpose could
//     give it (F-T663-3, a documented limit of the guide).
//   - An on counts only from the message that starts its turn, as in Claude, where a message sent while Claude works
//     never turns autopilot on: the turn's first user message that is not Codex's own context (provenance harness,
//     such as the environment context), or its first message of another agent. A message that joins a running turn
//     (turn/steer, the app's Enter while Codex works, or turn/start while a turn runs, as the app's queue run now) gets
//     that turn's id and no trigger of its own (F-T677-13, F-T677-15; R2721's record of the desktop binary
//     0.167.0-alpha.3.2). A subagent's report can start a main-thread turn with the trigger of the turn before it (a
//     wake: Codex keeps the earlier turn's settings), so an on that joins that turn counts for nothing (F-T677-31). A
//     message with no turn id starts no turn.
//   - The on that counts must also be the on that turned autopilot on in the mode file: the mode hook saves the turn of
//     each on that it accepts (onTurn), and the latest on that counts here must be in that turn (owner decision
//     2026-11-08, F-T677-33). An off from another thread (a fork, a subagent's thread, a side conversation) reaches only
//     the mode files, not this record. So after it, only a new on that starts its own turn turns autopilot on again: an
//     on that joins a running turn, waits in a queue or comes with an image does not count here.
// A resume by a newer Codex writes no version into the record (R2690 proof: 0.166.0-alpha.6 resumed a 0.164.0 record
// with no new session_meta), so the gate also checks the version of the Codex that runs (gate-hook.mjs).
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { exactPhrase, PHRASES, switchModes } from "sage-core";

/** The largest record that the reader reads (the proof read 50 MB in 116 to 145 ms). */
export const RECORD_LIMIT = 64 * 1024 * 1024;
/**
 * The Codex versions whose record the reader reads: 0.164 or later (0.164 to 0.199, 0.200 and up, or 1.0 and up), with
 * an optional pre-release of one or more numbers (0.166.0-alpha.6, the desktop app's 0.167.0-alpha.3.2). sage was
 * tested with 0.164 to 0.167; a later Codex reads too, because the reader refuses any line form that it does not know
 * (owner decision 2026-11-10, T951; it replaces the upper bound of F-T677-16).
 */
export const RECORD_VERSION = /^(?:0\.(?:16[4-9]|1[7-9]\d|[2-9]\d\d|[1-9]\d{3,})|[1-9]\d*\.(?:0|[1-9]\d*))\.(?:0|[1-9]\d*)(?:-[a-z]+(?:\.(?:0|[1-9]\d*))+)?$/;
/** The same range, for the owner. */
export const RECORD_RANGE = "0.164 and later";
/**
 * The top-level line types of Codex 0.164.0 records. Any other type refuses. A multi-agent v2 message between threads
 * (a subagent's report) comes with an inter_agent_communication_metadata line whose payload is only
 * { trigger_turn: false } (F-T677-30, real records of 0.164.0 and 0.167.0-alpha.3.2); any other payload refuses. It
 * is no user message, so it never counts as the owner's. Codex sends a subagent's report with trigger_turn false
 * (completion.rs); true comes only from a message to the main thread, which the gate blocks (F-T677-31).
 */
const TYPES = new Set(["session_meta", "response_item", "event_msg", "turn_context", "compacted", "world_state", "token_usage_record", "inter_agent_communication_metadata"]);
const interAgent = (p) => Object.keys(p).join() === "trigger_turn" && p.trigger_turn === false;
/** The turn triggers of a turn that a person started: the TUI, codex exec, and the desktop app's composer. */
const PERSON = new Set(["user", "exec", "composer"]);
const RETRIES = 3;
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

// The refusals, for the agent and the owner: a plain cause, one next step, then a short technical detail in brackets.
const refusal = (cause, step, detail) => ({ refused: `${cause}. ${step}${detail ? ` (${detail})` : ""}` });
const IN_GITHUB = "The owner merges the pull request in GitHub";
const UNREAD = (detail) => refusal("sage cannot read Codex's record of this session", "Ask for the merge again. If it refuses again, the owner merges the pull request in GitHub", detail);
const FORM = (detail) => refusal("sage does not know the form of Codex's record of this session", IN_GITHUB, detail);
const RESUME = "Resume the session, then the owner turns autopilot on again. Or the owner merges the pull request in GitHub";
/** When the owner's "autopilot on" counts, for the texts of the mode hook and the gate. */
export const NEW_ON = "as a new message while Codex is idle (press Esc first if Codex is busy)";

/** The bytes of the file, or { refused }. */
function readBytes(path) {
  let fd;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    if (size > RECORD_LIMIT) return refusal("Codex's record of this session is too long for sage to read", "Start a new session for autopilot, or the owner merges the pull request in GitHub", "over 64 MiB");
    const bytes = Buffer.alloc(size);
    let read = 0;
    for (let n; read < size && (n = readSync(fd, bytes, read, size - read, read)) > 0;) read += n;
    return { bytes: bytes.subarray(0, read) };
  } catch (error) {
    return UNREAD(error.code ?? error.message);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Codex's record at path: { entries, lines } (each line parsed, in order), or { refused: reason }. pause(ms) waits
 * before a re-read; a test replaces it.
 */
export function readRecord(path, { pause = sleep } = {}) {
  if (typeof path !== "string" || !path) return refusal("Codex keeps no record of this session, so sage cannot read the owner's autopilot switch", IN_GITHUB);
  let read;
  for (let attempt = 0; ; attempt++) {
    read = readBytes(path);
    if (read.refused || read.bytes.length === 0 || read.bytes.at(-1) === 10) break;
    if (attempt === RETRIES) return refusal("Codex is still writing its record of this session", "Ask for the merge again in a moment", "the last line is incomplete");
    pause(50);
  }
  if (read.refused) return read;
  const lines = read.bytes.length ? read.bytes.toString("utf8").slice(0, -1).split("\n") : [];
  const entries = [];
  for (const [i, line] of lines.entries()) {
    let entry;
    try { entry = JSON.parse(line); } catch { return FORM(`line ${i + 1} is not JSON`); }
    if (!isObject(entry) || !TYPES.has(entry.type) || !isObject(entry.payload)) return FORM(`line ${i + 1} has an unknown type`);
    if (entry.type === "inter_agent_communication_metadata" && !interAgent(entry.payload)) return FORM(`line ${i + 1} has an unknown payload`);
    if (entry.type === "session_meta" && !RECORD_VERSION.test(String(entry.payload.cli_version))) {
      return refusal(`this session runs Codex ${entry.payload.cli_version}, and sage reads the records of Codex ${RECORD_RANGE} only`, "Start a new session with Codex 0.164 or later, or the owner merges the pull request in GitHub");
    }
    entries.push(entry);
  }
  if (!entries.some((entry) => entry.type === "session_meta")) return FORM("no session_meta line");
  return { entries, lines: entries.length };
}

/** Codex's own text items around an image in a user message. */
const IMAGE_TAG = /^(?:<image name=\[Image #\d+\](?: path=".*")?>|<\/image>)$/s;

/**
 * A user message: { text, owner, textOnly }, or null for any other line. text is the text that the hook gets (see the
 * top of this file); owner says whether it is the owner's message; textOnly whether it holds only the owner's text.
 * Codex's UserMessage event gives the hook's text too, so it counts as a user message that is not the owner's.
 */
function userMessage(entry) {
  const p = entry.payload;
  if (entry.type === "event_msg" && p.type === "item_completed" && p.item?.type === "UserMessage" && Array.isArray(p.item.content)) {
    return { text: p.item.content.filter((item) => item?.type === "text" && typeof item.text === "string").map((item) => item.text).join(""), owner: false };
  }
  if (entry.type !== "response_item" || p.type !== "message" || p.role !== "user" || !Array.isArray(p.content)) return null;
  const { content_item_metadata: meta, content_item_kinds: kinds } = p.internal_chat_message_metadata_passthrough ?? {};
  const text = (item) => item?.type === "input_text" && typeof item.text === "string" && !IMAGE_TAG.test(item.text);
  return {
    text: p.content.filter((item, i) => text(item) && [undefined, "user.text"].includes(Array.isArray(kinds) ? kinds[i] : undefined)).map((item) => item.text).join(""),
    owner: p.content.length > 0 && Array.isArray(meta) && meta.length === p.content.length && meta.every((item) => item?.provenance?.type === "user"),
    textOnly: p.content.every(text),
  };
}

/** Whether Codex's record has the tool call callId (a function call of the model) at or after line from. */
export const callInRecord = (record, callId, from) =>
  record.entries.some((entry, i) => i >= from && entry.type === "response_item" && /call$/.test(entry.payload.type) && entry.payload.call_id === callId);

/**
 * The record's turns: trigger (each turn's id: the trigger of its task_started line), opener (each turn's id: the line
 * of the message that started it: a user message that is not Codex's own context, or another agent's message), and
 * start (the line after the last session_meta line).
 */
function turnsOf(record) {
  const trigger = new Map(), opener = new Map();
  let start = 0;
  record.entries.forEach((entry, i) => {
    const p = entry.payload;
    if (entry.type === "session_meta") start = i + 1;
    if (entry.type === "event_msg" && p.type === "task_started") trigger.set(p.turn_id, p.turn_attribution?.turn_trigger);
    const user = p.type === "message" && p.role === "user";
    if (entry.type !== "response_item" || !(user || p.type === "agent_message")) return;
    const { turn_id: turn, content_item_metadata: meta } = p.internal_chat_message_metadata_passthrough ?? {};
    const context = user && Array.isArray(meta) && meta.length > 0 && meta.every((item) => item?.provenance?.type === "harness");
    if (typeof turn === "string" && !context && !opener.has(turn)) opener.set(turn, i);
  });
  return { trigger, opener, start };
}

/**
 * Whether an on that the owner sends now in the turn can count, for the mode hook, which runs before Codex records the
 * message: no message has started the turn yet, and its task_started line, if Codex wrote it, names a person's trigger.
 */
export function onCanCount(record, turn) {
  const { trigger, opener } = turnsOf(record);
  return !opener.has(turn) && (!trigger.has(turn) || PERSON.has(trigger.get(turn)));
}

/**
 * The owner's autopilot switch now, with core's mode rules: { on: true }, { on: false, reason }, or { refused } when
 * the reader cannot prove it. mark is the session's start mark as start-mark.mjs saves it ({ lines, ... }). It is
 * required: a missing mark refuses, because without it an on from before a resume would count (proof case 5c).
 * onTurn is the turn of the on that the mode file saved: autopilot is on only when the latest on that counts is in it.
 */
export function autopilotSwitch(record, mark, onTurn) {
  if (!isObject(mark)) return refusal("sage saved no note when this session started, so it cannot tell which of the owner's switches are from this start", RESUME);
  const from = mark.lines;
  if (!Number.isInteger(from) || from < 0 || from > record.lines) return refusal("sage's note of this session start does not match Codex's record of this session", RESUME);
  const { trigger, opener, start } = turnsOf(record);
  const state = {};
  let counted = false, countedTurn;
  for (let i = start; i < record.entries.length; i++) {
    const message = userMessage(record.entries[i]);
    if (message === null) continue;
    const { text } = message;
    const change = PHRASES[exactPhrase(text)];
    if (!message.owner && change?.autopilot !== false) continue; // only an off counts from any user message
    const turn = record.entries[i].payload.internal_chat_message_metadata_passthrough?.turn_id;
    if (change?.autopilot === true && (!message.textOnly || i < from || !PERSON.has(trigger.get(turn)) || opener.get(turn) !== i)) continue;
    switchModes({ owner: true, text, all: text }, state, { autopilotOn: () => "" });
    counted ||= state.autopilot === true;
    if (change?.autopilot === true && state.autopilot === true) countedTurn = turn;
  }
  if (state.autopilot === true && countedTurn === onTurn) return { on: true };
  if (state.autopilot === true) return { on: false, reason: `the owner's latest "autopilot on" did not count, because only an on that is the whole message and starts a new turn counts` };
  return { on: false, reason: counted ? "the owner's latest autopilot switch is off" : "the owner has not turned autopilot on, with sage mode on, since this session started" };
}

/** Whether the record has Codex's turn_aborted event for the turn: the owner pressed Esc in it. */
export const turnAborted = (record, turn) =>
  record.entries.some((entry) => entry.type === "event_msg" && entry.payload.type === "turn_aborted" && entry.payload.turn_id === turn);
