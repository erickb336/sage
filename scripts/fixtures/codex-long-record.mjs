import "../test-env.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { appendFileSync, mkdtempSync, readSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readRecord, callInRecord, autopilotSwitch, onCanCount, turnAborted, RECORD_BUDGET } from "../../plugins/sage-codex/hooks/owner-record.mjs";
import { handle } from "../../plugins/sage-codex/hooks/sage-codex-hook.mjs";

const scratch = mkdtempSync(join(tmpdir(), "sage-long-record-"));
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));
const meta = { type: "session_meta", payload: { cli_version: "0.167.0" } };
const line = (entry) => JSON.stringify(entry) + "\n";
const started = (turn, trigger = "composer") => ({ type: "event_msg", payload: { type: "task_started", turn_id: turn, turn_attribution: { turn_trigger: trigger } } });
const owner = (turn, text) => ({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }], internal_chat_message_metadata_passthrough: { turn_id: turn, content_item_metadata: [{ provenance: { type: "user" } }] } } });
const call = (id) => ({ type: "response_item", payload: { type: "function_call", call_id: id } });
let files = 0;
const fileOf = (...entries) => { const file = join(scratch, `${++files}.jsonl`); writeFileSync(file, entries.map(line).join("")); return file; };

test("T1069: a complete history beyond 64 MiB retains the final call", () => {
  const file = join(scratch, "large.jsonl");
  writeFileSync(file, line(meta));
  const filler = line({ type: "response_item", payload: { type: "function_call_output", output: "x".repeat(1024 * 1024) } });
  for (let i = 0; i < 70; i++) appendFileSync(file, filler);
  appendFileSync(file, line({ type: "response_item", payload: { type: "function_call", call_id: "last-call", arguments: "{}" } }));
  const start = performance.now();
  const record = readRecord(file);
  assert.equal(record.refused, undefined);
  assert.equal(record.lines, 72);
  assert.equal(callInRecord(record, "last-call", 71), true);
  console.log(JSON.stringify({ bytes: statSync(file).size, elapsedMs: performance.now() - start, peakRssKiB: process.resourceUsage().maxRSS }));
});

test("T1069: chunks preserve UTF-8, ordering, last metadata, and call positions", () => {
  const file = fileOf(meta, started("turn", "queue"), owner("turn", "autopilot on"), meta, started("turn"), owner("turn", "autopilot on"), call("é🐸"), call("é🐸"));
  for (const chunk of [1, 2, 7, 65536]) {
    const record = readRecord(file, { budget: { chunk } });
    assert.equal(record.refused, undefined);
    assert.equal(onCanCount(record, "turn"), false);
    assert.equal(autopilotSwitch(record, { lines: 0, sage: true }, "turn").on, false, "first opener remains before last metadata");
    assert.equal(callInRecord(record, "é🐸", 7), true);
    assert.equal(callInRecord(record, "é🐸", 8), false);
  }
  const lateTrigger = fileOf(meta, started("turn", "queue"), owner("turn", "autopilot on"), started("turn"));
  assert.equal(autopilotSwitch(readRecord(lateTrigger), { lines: 0, sage: true }, "turn").on, true, "last trigger wins");
});

test("T1069: captured endpoints exclude appends and refuse short reads", () => {
  const file = fileOf(meta, call("before"));
  let reads = 0;
  const snapshot = readRecord(file, { read: (...args) => {
    const n = readSync(...args);
    if (++reads === 1) appendFileSync(file, line(call("after")));
    return n;
  } });
  assert.equal(callInRecord(snapshot, "before", 0), true);
  assert.equal(callInRecord(snapshot, "after", 0), false);
  assert.equal(callInRecord(readRecord(file), "after", 0), true);
  reads = 0;
  const short = readRecord(file, { read: (...args) => {
    const n = readSync(...args);
    if (++reads === 1) truncateSync(file, 0);
    return n;
  } });
  assert.match(short.refused, /short read before the captured endpoint/);
});

test("T1069: incomplete endpoints retry before parsing, and every completed line validates", () => {
  const file = fileOf(meta);
  appendFileSync(file, "{bad");
  const positions = [], pauses = [];
  const record = readRecord(file, { pause: (ms) => pauses.push(ms), read: (...args) => { positions.push(args[4]); return readSync(...args); } });
  assert.match(record.refused, /last line is incomplete/);
  assert.deepEqual(pauses, [50, 50, 50]);
  assert.deepEqual(positions, Array(4).fill(statSync(file).size - 1));
  appendFileSync(file, "\n");
  assert.match(readRecord(file).refused, /line 2 is not JSON/);
  assert.match(readRecord(fileOf(meta, { type: "world_state", payload: null })).refused, /unknown type/);
  assert.match(readRecord(fileOf({ ...meta, payload: { cli_version: "0.1.0" } }, meta)).refused, /0.1.0/);
});

test("T1069: entry, retained-value, cardinality and cooperative deadline limits refuse explicitly", () => {
  const file = fileOf(meta, call("x".repeat(1000)));
  assert.match(readRecord(file, { budget: { entry: 500 } }).refused, /entry exceeds 500 bytes/);
  assert.match(readRecord(file, { budget: { values: 500 } }).refused, /projection exceeds 500 value bytes/);
  assert.match(readRecord(file, { budget: { facts: 0 } }).refused, /projection exceeds 0 facts/);
  let clock = 0;
  assert.match(readRecord(file, { now: () => ++clock, budget: { milliseconds: 2 } }).refused, /scan deadline/);
  assert.equal(callInRecord(readRecord(file), "x".repeat(1000), 0), true);
});

test("T1069: activation preserves the reader cause and does not change saved mode or turn", () => {
  const file = fileOf(meta, { type: "new_record_type", payload: {} });
  const state = { sage: true, autopilot: false, onTurn: "earlier" };
  const output = handle({ hook_event_name: "UserPromptSubmit", session_id: "synthetic", prompt: "autopilot on", turn_id: "new", transcript_path: file }, state);
  assert.match(output.hookSpecificOutput.additionalContext, /line 2 has an unknown type/);
  assert.doesNotMatch(output.hookSpecificOutput.additionalContext, /did not start a new turn|send .*alone/);
  assert.deepEqual(state, { sage: true, autopilot: false, onTurn: "earlier" });
});

test("T1069: approximately 190 MB and the largest supported entry succeed with bounded facts", () => {
  const file = fileOf(meta, started("on"), owner("on", "autopilot on"));
  const prefix = '{"type":"response_item","payload":{"type":"function_call_output","output":"';
  const suffix = '"}}';
  const largest = prefix + "x".repeat(RECORD_BUDGET.entry - prefix.length - suffix.length) + suffix + "\n";
  appendFileSync(file, largest);
  const filler = line({ type: "response_item", payload: { type: "function_call_output", output: "x".repeat(1024 * 1024) } });
  for (let i = 0; i < 117; i++) appendFileSync(file, filler);
  appendFileSync(file, line(call("last")));
  for (let i = 0; i < 3; i++) {
    const measured = spawnSync(process.execPath, [fileURLToPath(new URL("./codex-record-measure.mjs", import.meta.url)), file], { env: process.env, encoding: "utf8" });
    assert.equal(measured.status, 0, measured.stderr);
    console.log(`isolated reader ${measured.stdout.trim()}`);
  }
  const measurements = [];
  for (let i = 0; i < 3; i++) {
    const start = performance.now();
    const record = readRecord(file);
    assert.equal(record.refused, undefined);
    assert.equal(autopilotSwitch(record, { lines: 0, sage: true }, "on").on, true);
    assert.equal(callInRecord(record, "last", 0), true);
    measurements.push(performance.now() - start);
  }
  console.log(JSON.stringify({ bytes: statSync(file).size, largestEntryBytes: RECORD_BUDGET.entry, runs: 3, elapsedMs: measurements, peakRssKiB: process.resourceUsage().maxRSS, budget: RECORD_BUDGET }));
  appendFileSync(file, line({ type: "event_msg", payload: { type: "turn_aborted", turn_id: "on" } }));
  assert.equal(turnAborted(readRecord(file), "on"), true);
  appendFileSync(file, line(owner("on", "autopilot off")));
  assert.equal(autopilotSwitch(readRecord(file), { lines: 0, sage: true }, "on").on, false);
  const oversized = fileOf(meta);
  appendFileSync(oversized, largest.slice(0, -1) + " \n");
  assert.match(readRecord(oversized).refused, /entry exceeds 67108864 bytes/);
});

test("T1069: dense retained facts succeed below the budget and never silently evict evidence", () => {
  const file = fileOf(meta, call("first"));
  for (let i = 0; i < 20; i++) {
    let batch = "";
    for (let j = 0; j < 5000; j++) batch += line(started(`turn-${i * 5000 + j}`));
    appendFileSync(file, batch);
  }
  const start = performance.now(), record = readRecord(file);
  assert.equal(record.refused, undefined);
  assert.equal(onCanCount(record, "turn-99999"), true);
  assert.equal(callInRecord(record, "first", 0), true);
  assert.match(readRecord(file, { budget: { facts: 100_000 } }).refused, /projection exceeds 100000 facts/);
  console.log(JSON.stringify({ denseBytes: statSync(file).size, facts: 100001, elapsedMs: performance.now() - start, peakRssKiB: process.resourceUsage().maxRSS }));
});
