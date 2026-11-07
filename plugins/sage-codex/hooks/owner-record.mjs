// The owner's autopilot switch, read from Codex's record of the session (the rollout file at transcript_path), for the
// Codex autopilot (T663). Ported from the T662 proof (gate-lib.mjs). It reads only: no write and no saved state.
//
// It fails closed. Each case below refuses (readRecord or autopilotSwitch gives { refused }), so autopilot counts as off:
//   - no record path, a read error, or a record over 64 MiB;
//   - a last line that is still partial after 3 re-reads (Codex writes the record in the background);
//   - a line that is not JSON, or not an object with a known top-level type and an object payload;
//   - no session_meta line, or a session_meta whose cli_version is not 0.164 to 0.166 in the strict form;
//   - no start mark, or a start mark whose line count does not fit the record.
// The owner's switches replay with core's own mode rules (switchModes), so the reader agrees with core: an on counts
// only while sage mode is on at that point, and the off form of the mode phrase ends autopilot.
//   - The owner's message: a user message with one metadata item for each content item, each with provenance user
//     (Codex marks hook text, goal text and its own context as harness or tool), and only text items.
//   - The replay starts at the last session_meta line with both modes off, as a new mode file does (a fork's record
//     starts fresh: proof case 5b). A resume writes no session_meta, so sage mode carries over a resume, as the
//     session's mode file does.
//   - An on counts only after the start mark (proof case 5c: a resume must not count an earlier on), and only in a turn
//     that a person started (turn trigger user in the TUI, exec for codex exec). Input from codex queue also has
//     provenance user, but its turn trigger is queue: there an on counts for nothing. Every other switch counts.
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { exactPhrase, PHRASES, switchModes } from "../core/index.mjs";

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
    if (size > RECORD_LIMIT) return { refused: "Codex's session record is over 64 MiB" };
    const bytes = Buffer.alloc(size);
    let read = 0;
    for (let n; read < size && (n = readSync(fd, bytes, read, size - read, read)) > 0;) read += n;
    return { bytes: bytes.subarray(0, read) };
  } catch (error) {
    return { refused: `Codex's session record cannot be read (${error.code ?? error.message})` };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Codex's record at path: { entries, lines } (each line parsed, in order), or { refused: reason }. pause(ms) waits
 * before a re-read; a test replaces it.
 */
export function readRecord(path, { pause = sleep } = {}) {
  if (typeof path !== "string" || !path) return { refused: "Codex gave no path to its session record" };
  let read;
  for (let attempt = 0; ; attempt++) {
    read = readBytes(path);
    if (read.refused || read.bytes.length === 0 || read.bytes.at(-1) === 10) break;
    if (attempt === RETRIES) return { refused: "Codex's session record ends in a partial line" };
    pause(50);
  }
  if (read.refused) return read;
  const lines = read.bytes.length ? read.bytes.toString("utf8").slice(0, -1).split("\n") : [];
  const entries = [];
  for (const [i, line] of lines.entries()) {
    let entry;
    try { entry = JSON.parse(line); } catch { return { refused: `line ${i + 1} of Codex's session record is not JSON` }; }
    if (!isObject(entry) || !TYPES.has(entry.type) || !isObject(entry.payload)) return { refused: `line ${i + 1} of Codex's session record has an unknown type` };
    if (entry.type === "session_meta" && !RECORD_VERSION.test(String(entry.payload.cli_version))) {
      return { refused: `Codex's session record is from Codex ${entry.payload.cli_version}, and sage reads only the session records of Codex 0.164 to 0.166` };
    }
    entries.push(entry);
  }
  if (!entries.some((entry) => entry.type === "session_meta")) return { refused: "Codex's session record has no session_meta line" };
  return { entries, lines: entries.length };
}

/** The text of an owner's message, or null for any other line. */
function ownerText(entry) {
  const p = entry.payload;
  if (entry.type !== "response_item" || p.type !== "message" || p.role !== "user" || !Array.isArray(p.content) || !p.content.length) return null;
  const meta = p.internal_chat_message_metadata_passthrough?.content_item_metadata;
  if (!Array.isArray(meta) || meta.length !== p.content.length || !meta.every((item) => item?.provenance?.type === "user")) return null;
  if (!p.content.every((item) => item?.type === "input_text" && typeof item.text === "string")) return null;
  return p.content.map((item) => item.text).join("");
}

/**
 * The owner's autopilot switch now, with core's mode rules: { on: true }, { on: false, reason }, or { refused } when
 * the reader cannot prove it. mark is the session's start mark as start-mark.mjs saves it ({ lines, ... }). It is
 * required: a missing mark refuses, because without it an on from before a resume would count (proof case 5c).
 */
export function autopilotSwitch(record, mark) {
  if (!isObject(mark)) return { refused: "sage saved no note when this session started, so it cannot tell which switches of the owner are from this start" };
  const from = mark.lines;
  if (!Number.isInteger(from) || from < 0 || from > record.lines) return { refused: "sage's note of this session start does not fit Codex's session record" };
  const trigger = new Map();
  let start = 0;
  record.entries.forEach((entry, i) => {
    if (entry.type === "session_meta") start = i + 1;
    if (entry.type === "event_msg" && entry.payload.type === "task_started") trigger.set(entry.payload.turn_id, entry.payload.turn_attribution?.turn_trigger);
  });
  const state = {};
  let counted = false;
  for (let i = start; i < record.entries.length; i++) {
    const text = ownerText(record.entries[i]);
    if (text === null) continue;
    const turn = record.entries[i].payload.internal_chat_message_metadata_passthrough.turn_id;
    if (PHRASES[exactPhrase(text)]?.autopilot === true && (i < from || !PERSON.has(trigger.get(turn)))) continue;
    switchModes({ owner: true, text, all: text }, state, { autopilotOn: () => "" });
    counted ||= state.autopilot === true;
  }
  if (state.autopilot === true) return { on: true };
  return { on: false, reason: counted ? "the owner's latest autopilot switch is off" : "the owner has not turned autopilot on, with sage mode on, since this session started" };
}

/** Whether the record has Codex's turn_aborted event for the turn: the owner pressed Esc in it. */
export const turnAborted = (record, turn) =>
  record.entries.some((entry) => entry.type === "event_msg" && entry.payload.type === "turn_aborted" && entry.payload.turn_id === turn);
