import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { exactPhrase, PHRASES, switchModes } from "sage-core";

export const RECORD_LIMIT = 64 * 1024 * 1024;
export const RECORD_VERSION = /^(?:0\.(?:16[4-9]|1[7-9]\d|[2-9]\d\d|[1-9]\d{3,})|[1-9]\d*\.(?:0|[1-9]\d*))\.(?:0|[1-9]\d*)(?:-[a-z]+(?:\.(?:0|[1-9]\d*))+)?$/;
export const RECORD_RANGE = "0.164 and later";
const TYPES = new Set(["session_meta", "response_item", "event_msg", "turn_context", "compacted", "world_state", "token_usage_record", "inter_agent_communication_metadata"]);
const interAgent = (p) => Object.keys(p).join() === "trigger_turn" && p.trigger_turn === false;
const PERSON = new Set(["user", "exec", "composer"]);
const RETRIES = 3;
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

const refusal = (cause, step, detail) => ({ refused: `${cause}. ${step}${detail ? ` (${detail})` : ""}` });
const IN_GITHUB = "The owner merges the pull request in GitHub";
const UNREAD = (detail) => refusal("sage cannot read Codex's record of this session", "Ask for the merge again. If it refuses again, the owner merges the pull request in GitHub", detail);
const FORM = (detail) => refusal("sage does not know the form of Codex's record of this session", IN_GITHUB, detail);
const RESUME = "Resume the session, then the owner turns autopilot on again. Or the owner merges the pull request in GitHub";
export const NEW_ON = "as a new message while Codex is idle (press Esc first if Codex is busy)";

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

const IMAGE_TAG = /^(?:<image name=\[Image #\d+\](?: path=".*")?>|<\/image>)$/s;

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

export const callInRecord = (record, callId, from) =>
  record.entries.some((entry, i) => i >= from && entry.type === "response_item" && /call$/.test(entry.payload.type) && entry.payload.call_id === callId);

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

export function onCanCount(record, turn) {
  const { trigger, opener } = turnsOf(record);
  return !opener.has(turn) && (!trigger.has(turn) || PERSON.has(trigger.get(turn)));
}

export function autopilotSwitch(record, mark, onTurn) {
  if (!isObject(mark)) return refusal("sage saved no note when this session started, so it cannot tell which of the owner's switches are from this start", RESUME);
  const from = mark.lines;
  if (!Number.isInteger(from) || from < 0 || from > record.lines) return refusal("sage's note of this session start does not match Codex's record of this session", RESUME);
  const { trigger, opener, start } = turnsOf(record);
  const state = mark.sage === true ? { sage: true } : {};
  let counted = false, countedTurn;
  for (let i = start; i < record.entries.length; i++) {
    const message = userMessage(record.entries[i]);
    if (message === null) continue;
    const { text } = message;
    const change = PHRASES[exactPhrase(text)];
    if (!message.owner && change?.autopilot !== false) continue;
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

export const turnAborted = (record, turn) =>
  record.entries.some((entry) => entry.type === "event_msg" && entry.payload.type === "turn_aborted" && entry.payload.turn_id === turn);
