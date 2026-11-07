// The owner's autopilot switch, read from Codex's record of the session (the rollout file at transcript_path), for the
// Codex autopilot (T663). Ported from the T662 proof (gate-lib.mjs). It reads only: no write and no saved state.
//
// It fails closed. Each case below refuses (readRecord gives { refused }), so autopilot counts as off:
//   - no record path, a read error, or a record over 64 MiB;
//   - a last line that is still partial after 3 re-reads (Codex writes the record in the background);
//   - a line that is not JSON, or not an object with a known top-level type and an object payload;
//   - no session_meta line, or a session_meta whose cli_version is not 0.164 to 0.166 in the strict form;
//   - a boundary (from) that is not a line count of the record.
// Only the autopilot switches count. Sage mode comes from the mode file, not from here.
//   - The owner's message: a user message whose every content item has provenance user (Codex marks hook text, goal
//     text and its own context as harness or tool). Its text is a switch only when it is exactly one phrase (core's
//     exactPhrase and PHRASES).
//   - On counts only in a turn that a person started (turn trigger user in the TUI, exec for codex exec). Input from
//     codex queue also has provenance user, but its turn trigger is queue: there on counts for nothing.
//   - Off counts from any owner message, in any turn. The off form of the mode phrase turns autopilot off too.
//   - Only messages after the boundary count: the later of the last session_meta line and the start mark (from, a
//     line count). A resume writes no session_meta, so the start mark keeps an earlier on from counting.
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { exactPhrase, PHRASES } from "../core/index.mjs";

/** The largest record that the reader reads (the proof read 50 MB in 116 to 145 ms). */
export const RECORD_LIMIT = 64 * 1024 * 1024;
/** The Codex versions whose record format the reader knows: 0.164 to 0.166, with an optional pre-release (0.166.0-alpha.6). */
export const RECORD_VERSION = /^0\.16[4-6]\.(?:0|[1-9]\d*)(?:-[a-z]+\.(?:0|[1-9]\d*))?$/;
/** The top-level line types of Codex 0.164.0 records. Any other type refuses. */
const TYPES = new Set(["session_meta", "response_item", "event_msg", "turn_context", "compacted", "world_state", "token_usage_record"]);
/** The turn triggers of a turn that a person started. */
const PERSON = new Set(["user", "exec"]);
const RETRIES = 3;
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** The bytes of the file, or { refused }. */
function readBytes(path) {
  let fd;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    if (size > RECORD_LIMIT) return { refused: "the record is over 64 MiB" };
    const bytes = Buffer.alloc(size);
    let read = 0;
    for (let n; read < size && (n = readSync(fd, bytes, read, size - read, read)) > 0;) read += n;
    return { bytes: bytes.subarray(0, read) };
  } catch (error) {
    return { refused: `the record cannot be read (${error.code ?? error.message})` };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Codex's record at path: { entries, lines } (each line parsed, in order), or { refused: reason }. pause(ms) waits
 * before a re-read; a test replaces it.
 */
export function readRecord(path, { pause = sleep } = {}) {
  if (typeof path !== "string" || !path) return { refused: "the session has no record path" };
  let read;
  for (let attempt = 0; ; attempt++) {
    read = readBytes(path);
    if (read.refused || read.bytes.length === 0 || read.bytes.at(-1) === 10) break;
    if (attempt === RETRIES) return { refused: "the record ends in a partial line" };
    pause(50);
  }
  if (read.refused) return read;
  const lines = read.bytes.length ? read.bytes.toString("utf8").slice(0, -1).split("\n") : [];
  const entries = [];
  for (const [i, line] of lines.entries()) {
    let entry;
    try { entry = JSON.parse(line); } catch { return { refused: `line ${i + 1} of the record is not JSON` }; }
    if (!isObject(entry) || !TYPES.has(entry.type) || !isObject(entry.payload)) return { refused: `line ${i + 1} of the record has an unknown type` };
    if (entry.type === "session_meta" && !RECORD_VERSION.test(String(entry.payload.cli_version))) {
      return { refused: `the record is from Codex ${entry.payload.cli_version}, and sage reads only the records of Codex 0.164 to 0.166` };
    }
    entries.push(entry);
  }
  if (!entries.some((entry) => entry.type === "session_meta")) return { refused: "the record has no session_meta line" };
  return { entries, lines: entries.length };
}

/** The text of an owner's message, or null for any other line. */
function ownerText(entry) {
  const p = entry.payload;
  if (entry.type !== "response_item" || p.type !== "message" || p.role !== "user" || !Array.isArray(p.content)) return null;
  const meta = p.internal_chat_message_metadata_passthrough?.content_item_metadata;
  if (!Array.isArray(meta) || !meta.length || !meta.every((item) => item?.provenance?.type === "user")) return null;
  if (!p.content.every((item) => item?.type === "input_text" && typeof item.text === "string")) return null;
  return p.content.map((item) => item.text).join("");
}

/**
 * The latest autopilot switch of the owner after the boundary: { on: true }, or { on: false, reason }. from is the
 * start mark's line count (0 for none); the boundary is the later of it and the last session_meta line.
 */
export function autopilotSwitch(record, from) {
  if (!Number.isInteger(from) || from < 0 || from > record.lines) return { on: false, reason: "the start mark does not fit the record" };
  const trigger = new Map();
  let start = from;
  record.entries.forEach((entry, i) => {
    if (entry.type === "session_meta") start = Math.max(start, i + 1);
    if (entry.type === "event_msg" && entry.payload.type === "task_started") trigger.set(entry.payload.turn_id, entry.payload.turn_attribution?.turn_trigger);
  });
  let on = null;
  for (const entry of record.entries.slice(start)) {
    const text = ownerText(entry);
    const change = text === null ? undefined : PHRASES[exactPhrase(text)];
    if (change?.autopilot === false) on = false;
    else if (change?.autopilot === true && PERSON.has(trigger.get(entry.payload.internal_chat_message_metadata_passthrough.turn_id))) on = true;
  }
  if (on) return { on: true };
  return { on: false, reason: on === false ? "the owner's latest autopilot switch is off" : "the owner has not turned autopilot on since this session started" };
}

/** Whether the record has Codex's turn_aborted event for the turn: the owner pressed Esc in it. */
export const turnAborted = (record, turn) =>
  record.entries.some((entry) => entry.type === "event_msg" && entry.payload.type === "turn_aborted" && entry.payload.turn_id === turn);
