import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { exactPhrase, PHRASES, switchModes } from "sage-core";

export const RECORD_BUDGET = Object.freeze({ chunk: 64 * 1024, entry: 64 * 1024 * 1024, values: 16 * 1024 * 1024, facts: 200_000, milliseconds: 6000 });
export const RECORD_VERSION = /^(?:0\.(?:16[4-9]|1[7-9]\d|[2-9]\d\d|[1-9]\d{3,})|[1-9]\d*\.(?:0|[1-9]\d*))\.(?:0|[1-9]\d*)(?:-[a-z]+(?:\.(?:0|[1-9]\d*))+)?$/;
export const RECORD_RANGE = "0.164 and later";
const TYPES = new Set(["session_meta", "response_item", "event_msg", "turn_context", "compacted", "world_state", "token_usage_record", "inter_agent_communication_metadata"]);
const interAgent = (p) => Object.keys(p).join() === "trigger_turn" && p.trigger_turn === false;
const PERSON = new Set(["user", "exec", "composer"]);
const RETRIES = 3;
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const detached = (value) => typeof value === "string" ? Buffer.from(value, "utf16le").toString("utf16le")
  : value && typeof value === "object" ? JSON.parse(JSON.stringify(value)) : value;

const refusal = (cause, step, detail) => ({ refused: `${cause}. ${step}${detail ? ` (${detail})` : ""}` });
const IN_GITHUB = "The owner merges the pull request in GitHub";
const UNREAD = (detail) => refusal("sage cannot read Codex's record of this session", "Ask for the merge again. If it refuses again, the owner merges the pull request in GitHub", detail);
const FORM = (detail) => refusal("sage does not know the form of Codex's record of this session", IN_GITHUB, detail);
const RESUME = "Resume the session, then the owner turns autopilot on again. Or the owner merges the pull request in GitHub";
export const NEW_ON = "as a new message while Codex is idle (press Esc first if Codex is busy)";

const RESOURCE = (detail) => refusal("Codex's record exceeds sage's safe reading budget", "Start a new session, or the owner merges the pull request in GitHub", detail);

function scan(path, project, { read, now, deadline, budget }) {
  let fd;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const bytes = Buffer.alloc(budget.chunk);
    if (size) {
      if (read(fd, bytes, 0, 1, size - 1) !== 1) return UNREAD("short read before the captured endpoint");
      if (bytes[0] !== 10) return { incomplete: true };
    }
    let offset = 0, length = 0, parts = [], lines = 0;
    while (offset < size) {
      if (now() >= deadline) return RESOURCE("scan deadline");
      const n = read(fd, bytes, 0, Math.min(bytes.length, size - offset), offset);
      if (n <= 0) return UNREAD("short read before the captured endpoint");
      offset += n;
      let from = 0;
      for (let end; from < n; from = end + 1) {
        end = bytes.indexOf(10, from);
        if (end < 0 || end >= n) end = n;
        const piece = bytes.subarray(from, end);
        length += piece.length;
        if (length > budget.entry) return RESOURCE(`entry exceeds ${budget.entry} bytes`);
        if (end === n) {
          parts.push(Buffer.from(piece));
          break;
        }
        if (now() >= deadline) return RESOURCE("scan deadline");
        const line = parts.length ? Buffer.concat([...parts, piece], length) : piece;
        let entry;
        try { entry = JSON.parse(line.toString("utf8")); } catch { return FORM(`line ${lines + 1} is not JSON`); }
        if (!isObject(entry) || !TYPES.has(entry.type) || !isObject(entry.payload)) return FORM(`line ${lines + 1} has an unknown type`);
        if (entry.type === "inter_agent_communication_metadata" && !interAgent(entry.payload)) return FORM(`line ${lines + 1} has an unknown payload`);
        if (entry.type === "session_meta" && !RECORD_VERSION.test(String(entry.payload.cli_version))) {
          return refusal(`this session runs Codex ${entry.payload.cli_version}, and sage reads the records of Codex ${RECORD_RANGE} only`, "Start a new session with Codex 0.164 or later, or the owner merges the pull request in GitHub");
        }
        const failed = project(entry, lines++);
        if (failed) return failed;
        if (now() >= deadline) return RESOURCE("scan deadline");
        parts = [];
        length = 0;
      }
    }
    return { lines };
  } catch (error) {
    return UNREAD(error.code ?? error.message);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function readRecord(path, { pause = sleep, read = readSync, now = () => performance.now(), budget: overrides = {} } = {}) {
  if (typeof path !== "string" || !path) return refusal("Codex keeps no record of this session, so sage cannot read the owner's autopilot switch", IN_GITHUB);
  const budget = { ...RECORD_BUDGET, ...overrides };
  const deadline = now() + budget.milliseconds;
  for (let attempt = 0; ; attempt++) {
    const record = { trigger: new Map(), opener: new Map(), calls: new Map(), aborted: new Set(), switches: [], start: 0 };
    let values = 0, facts = 0;
    const retain = (...items) => {
      const bytes = items.reduce((sum, item) => sum + (typeof item === "string" ? item.length * 2 : isObject(item) || Array.isArray(item) ? JSON.stringify(item).length * 2 : 8), 64);
      if (facts + 1 > budget.facts) return RESOURCE(`projection exceeds ${budget.facts} facts`);
      if (values + bytes > budget.values) return RESOURCE(`projection exceeds ${budget.values} value bytes`);
      facts++;
      values += bytes;
    };
    const project = (entry, i) => {
      const p = entry.payload;
      if (entry.type === "session_meta") record.start = i + 1;
      if (entry.type === "event_msg" && p.type === "task_started") {
        if (!record.trigger.has(p.turn_id)) { const failed = retain(p.turn_id); if (failed) return failed; }
        record.trigger.set(detached(p.turn_id), PERSON.has(p.turn_attribution?.turn_trigger));
      }
      if (entry.type === "event_msg" && p.type === "turn_aborted" && !record.aborted.has(p.turn_id)) {
        const failed = retain(p.turn_id); if (failed) return failed;
        record.aborted.add(detached(p.turn_id));
      }
      if (entry.type === "response_item" && /call$/.test(p.type)) {
        if (!record.calls.has(p.call_id)) { const failed = retain(p.call_id); if (failed) return failed; }
        record.calls.set(detached(p.call_id), i);
      }
      const user = p.type === "message" && p.role === "user";
      const { turn_id: turn, content_item_metadata: meta } = p.internal_chat_message_metadata_passthrough ?? {};
      const context = user && Array.isArray(meta) && meta.length > 0 && meta.every((item) => item?.provenance?.type === "harness");
      if (entry.type === "response_item" && (user || p.type === "agent_message") && typeof turn === "string" && !context && !record.opener.has(turn)) {
        const failed = retain(turn); if (failed) return failed;
        record.opener.set(detached(turn), i);
      }
      const message = userMessage(entry);
      const phrase = message && exactPhrase(message.text);
      if (phrase && (message.owner || PHRASES[phrase]?.autopilot === false)) {
        const failed = retain(phrase, turn); if (failed) return failed;
        record.switches.push({ i, turn: detached(turn), phrase, textOnly: message.textOnly });
      }
    };
    const result = scan(path, project, { read, now, deadline, budget });
    if (!result.incomplete) {
      if (result.refused) return result;
      if (!record.start) return FORM("no session_meta line");
      return { ...record, lines: result.lines };
    }
    if (attempt === RETRIES) return refusal("Codex is still writing its record of this session", "Ask for the merge again in a moment", "the last line is incomplete");
    pause(50);
  }
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
  record.calls.has(callId) && record.calls.get(callId) >= from;

export function onCanCount(record, turn) {
  const { trigger, opener } = record;
  return !opener.has(turn) && (!trigger.has(turn) || trigger.get(turn));
}

export function autopilotSwitch(record, mark, onTurn) {
  if (!isObject(mark)) return refusal("sage saved no note when this session started, so it cannot tell which of the owner's switches are from this start", RESUME);
  const from = mark.lines;
  if (!Number.isInteger(from) || from < 0 || from > record.lines) return refusal("sage's note of this session start does not match Codex's record of this session", RESUME);
  const { trigger, opener, start } = record;
  const state = mark.sage === true ? { sage: true } : {};
  let counted = false, countedTurn;
  for (const { i, turn, phrase: text, textOnly } of record.switches) {
    if (i < start) continue;
    const change = PHRASES[text];
    if (change?.autopilot === true && (!textOnly || i < from || !trigger.get(turn) || opener.get(turn) !== i)) continue;
    switchModes({ owner: true, text, all: text }, state, { autopilotOn: () => "" });
    counted ||= state.autopilot === true;
    if (change?.autopilot === true && state.autopilot === true) countedTurn = turn;
  }
  if (state.autopilot === true && countedTurn === onTurn) return { on: true };
  if (state.autopilot === true) return { on: false, reason: `the owner's latest "autopilot on" did not count, because only an on that is the whole message and starts a new turn counts` };
  return { on: false, reason: counted ? "the owner's latest autopilot switch is off" : "the owner has not turned autopilot on, with sage mode on, since this session started" };
}

export const turnAborted = (record, turn) =>
  record.aborted.has(turn);
