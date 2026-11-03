#!/usr/bin/env node
// Optional, inactive UserPromptSubmit observation. No manifest entry, capture file or mode decision.
import * as fs from 'node:fs';
import { isAbsolute, normalize, parse, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

export const LIMITS = Object.freeze({ callback: 65536, header: 16384, file: 262144, records: 2048, depth: 32, milliseconds: 1800 });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const pathValue = value => typeof value === 'string' && value.length <= 4096 && isAbsolute(value)
  && normalize(value) === value && !/[\p{Cc}\p{Cf}]/u.test(value);
const token = value => typeof value === 'string' && /^[a-z][a-z0-9_]{0,31}$/.test(value);
// Three release numbers; alpha, beta or rc can have one or two numbers. Each number has at most three digits.
const version = value => typeof value === 'string' && /^\d{1,3}\.\d{1,3}\.\d{1,3}(?:-(?:alpha|beta|rc)(?:\.\d{1,3}){1,2})?(?![\s\S])/.test(value);
const timestamp = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(value) && Number.isFinite(Date.parse(value));
class Refusal extends Error { constructor(reason) { super(); this.reason = reason; } }
const refuse = reason => { throw new Refusal(reason); };
const presence = (value, key) => !Object.hasOwn(value, key) ? 'missing' : value[key] === null ? 'null' : 'present';
const sameNode = (a, b) => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode;
const sameFile = (a, b) => sameNode(a, b) && a.size === b.size && a.nlink === b.nlink
  && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;

// Reject duplicate keys, invalid UTF-8 and excessive depth, even in discarded message fields.
function json(bytes, reason, checkTime) {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const value = JSON.parse(text);
    const stack = [];
    for (let i = 0; i < text.length; i++) {
      if ((i & 1023) === 0) checkTime();
      const char = text[i];
      if (char === '"') {
        const start = i++;
        while (text[i] !== '"') { if (text[i] === '\\') i++; i++; }
        const top = stack.at(-1);
        if (top?.key) {
          const key = JSON.parse(text.slice(start, i + 1));
          if (top.keys.has(key)) refuse(reason);
          top.keys.add(key); top.key = false;
        }
      } else if (char === '{' || char === '[') {
        stack.push(char === '{' ? { key: true, keys: new Set() } : {});
        if (stack.length > LIMITS.depth) refuse('depth_bound');
      } else if (char === '}' || char === ']') stack.pop();
      else if (char === ',' && stack.at(-1)?.keys) stack.at(-1).key = true;
    }
    checkTime();
    return value;
  } catch (error) { if (error instanceof Refusal) throw error; refuse(reason); }
}

function callbackFields(callback, options) {
  if (!object(options) || !pathValue(options.sessionDirectory) || options.sessionDirectory === parse(options.sessionDirectory).root
    || !pathValue(options.project)) refuse('invalid_boundary');
  if (!object(callback) || callback.hook_event_name !== 'UserPromptSubmit' || !uuid(callback.session_id)
    || !uuid(callback.turn_id) || !pathValue(callback.transcript_path) || !pathValue(callback.cwd)) refuse('invalid_callback');
  if (['agent_id', 'agent_type', 'parent_thread_id', 'parent_turn_id', 'initiating_agent_path'].some(key => Object.hasOwn(callback, key))) refuse('child_evidence');
  const keys = ['hook_event_name', 'session_id', 'turn_id', 'cwd', 'transcript_path', 'prompt', 'model', 'permission_mode'];
  if (Object.keys(callback).some(key => !keys.includes(key))) refuse('unsupported_layout');
  if (callback.cwd !== options.project) refuse('identity_mismatch');
  const child = relative(options.sessionDirectory, callback.transcript_path);
  if (!child || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) refuse('path_boundary');
}

// One complete prefix, fixed by the first selected-file stat. No tail search or second read.
function withSnapshot(path, io, checkTime, inspect) {
  const ancestors = [];
  let cursor = parse(path).root;
  const parts = path.slice(cursor.length).split(sep);
  if (parts.length > 128) refuse('path_boundary');
  for (const component of parts) {
    checkTime(); cursor = resolve(cursor, component);
    const stat = io.lstatSync(cursor, { bigint: true });
    if (stat.isSymbolicLink() || (cursor !== path && !stat.isDirectory())) refuse('path_boundary');
    ancestors.push([cursor, stat]);
  }
  const selected = ancestors.at(-1)[1];
  if (!selected.isFile() || selected.nlink !== 1n) refuse('not_regular_file');
  if (selected.size < 1n) refuse('incomplete_records');
  if (selected.size > BigInt(LIMITS.file)) refuse('file_bound');
  let fd;
  try {
    checkTime();
    fd = io.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stable = () => {
      checkTime();
      for (const [name, before] of ancestors) {
        checkTime();
        const after = io.lstatSync(name, { bigint: true });
        if (!sameNode(before, after) || after.isSymbolicLink()) refuse('changed_snapshot');
      }
      if (!sameFile(selected, io.fstatSync(fd, { bigint: true }))
        || !sameFile(selected, io.lstatSync(path, { bigint: true }))) refuse('changed_snapshot');
    };
    stable();
    const bytes = Buffer.alloc(Number(selected.size));
    let used = 0;
    while (used < bytes.length) {
      checkTime();
      const count = io.readSync(fd, bytes, used, Math.min(16384, bytes.length - used), used);
      if (!Number.isInteger(count) || count < 1 || count > Math.min(16384, bytes.length - used)) refuse('changed_snapshot');
      used += count;
    }
    stable();
    if (bytes.at(-1) !== 10) refuse('incomplete_records');
    const result = inspect(bytes);
    stable();
    return result;
  } finally { if (fd !== undefined) io.closeSync(fd); }
}

function classify(bytes, callback, options, checkTime, result) {
  const first = bytes.indexOf(10);
  if (first < 0 || first + 1 > LIMITS.header) refuse('header_bound');
  const header = json(bytes.subarray(0, first), 'malformed_record', checkTime);
  if (!object(header) || header.type !== 'session_meta' || !object(header.payload) || !timestamp(header.timestamp)) refuse('unsupported_layout');
  const meta = header.payload;
  if (meta.parent_thread_id != null || meta.agent_path != null && meta.agent_path !== '/root'
    || meta.agent_role != null || meta.agent_type != null || meta.agent_nickname != null
    || meta.parent_turn_id != null || meta.initiating_agent_path != null
    || meta.subagent_history_start_ordinal != null || object(meta.source) || meta.source === 'subagent'
    || meta.thread_source != null && meta.thread_source !== 'user') refuse('child_evidence');
  if (meta.history_base != null || meta.forked_from_id != null || meta.forked_from_ordinal_exclusive != null) refuse('partial_history');
  if (!uuid(meta.id) || meta.id !== callback.session_id || meta.session_id !== undefined && meta.session_id !== callback.session_id
    || meta.cwd !== options.project) refuse('identity_mismatch');
  if (!token(meta.source) || !version(meta.cli_version)) refuse('unsupported_metadata');
  const paginated = meta.history_mode === 'paginated';
  if (meta.history_mode !== undefined && meta.history_mode !== 'legacy' && !paginated) refuse('partial_history');
  if (paginated ? header.ordinal !== 0 : Object.hasOwn(header, 'ordinal')) refuse('partial_history');
  result.session_meta = { source: meta.source, cli_version: meta.cli_version };
  const starts = new Set();
  const events = new Set(['task_started', 'task_complete', 'turn_aborted', 'user_message', 'agent_message',
    'agent_reasoning', 'agent_reasoning_raw_content', 'token_count', 'hook_started', 'hook_completed']);
  const responses = new Set(['message', 'reasoning', 'function_call', 'function_call_output', 'custom_tool_call', 'custom_tool_call_output']);
  let count = 0, offset = first + 1, matched = false;
  while (offset < bytes.length) {
    checkTime();
    if (++count > LIMITS.records) refuse('record_bound');
    const end = bytes.indexOf(10, offset);
    const row = json(bytes.subarray(offset, end), 'malformed_record', checkTime);
    offset = end + 1;
    if (!object(row) || !object(row.payload) || !timestamp(row.timestamp)) refuse('unsupported_layout');
    if (paginated ? row.ordinal !== count : Object.hasOwn(row, 'ordinal')) refuse('partial_history');
    if (!['event_msg', 'response_item', 'turn_context'].includes(row.type)) refuse('unsupported_layout');
    const p = row.payload;
    if (p.parent_thread_id != null || p.agent_path != null && p.agent_path !== '/root'
      || p.parent_turn_id != null || p.initiating_agent_path != null) refuse('child_evidence');
    if (row.type === 'event_msg' && !events.has(p.type) || row.type === 'response_item' && !responses.has(p.type)) refuse('unsupported_layout');
    if (row.type === 'turn_context' || row.type === 'event_msg' && ['task_complete', 'turn_aborted'].includes(p.type)) {
      if (!uuid(p.turn_id) || p.root_turn_id != null && p.root_turn_id !== p.turn_id
        || p.turn_id === callback.turn_id && p.cwd !== undefined && p.cwd !== options.project) refuse('identity_mismatch');
    }
    if (row.type !== 'event_msg' || p.type !== 'task_started') continue;
    if (!uuid(p.turn_id)) refuse('unsupported_layout');
    if (starts.has(p.turn_id)) refuse('duplicate_start');
    starts.add(p.turn_id);
    const a = p.turn_attribution;
    if (!object(a) || a.turn_id !== p.turn_id || !token(a.turn_trigger)) refuse('unsupported_metadata');
    if (Object.hasOwn(a, 'root_turn_id') && !uuid(a.root_turn_id)
      || Object.hasOwn(p, 'root_turn_id') && !uuid(p.root_turn_id)
      || a.parent_turn_id != null && !uuid(a.parent_turn_id)
      || a.initiating_agent_path != null && !pathValue(a.initiating_agent_path)) refuse('unsupported_metadata');
    if (p.turn_id === callback.turn_id) {
      matched = true;
      result.task_started = {
      timestamp: row.timestamp, turn_trigger: a.turn_trigger,
      parent_turn_id: presence(a, 'parent_turn_id'),
      root_turn_id: !Object.hasOwn(a, 'root_turn_id') ? 'missing' : a.root_turn_id === callback.turn_id ? 'matches_callback_turn' : 'different',
      initiating_agent_path: presence(a, 'initiating_agent_path'),
      };
    }
    if (a.parent_turn_id != null || a.initiating_agent_path != null
      || a.root_turn_id !== undefined && a.root_turn_id !== p.turn_id
      || p.root_turn_id !== undefined && p.root_turn_id !== p.turn_id) refuse('child_evidence');
  }
  result.status = matched ? 'present' : 'absent';
  result.observation = matched ? 'present at the first bounded callback read' : 'absent after a complete bounded callback read';
  return result;
}

/** Only the explicit metadata projection can leave this boundary. Errors never include input or paths. */
export function inspectCallback(bytes, options, io = fs, now = () => performance.now(), started = now()) {
  const result = { status: 'unavailable', callback: { turn_id_present: false, transcript_path_present: false } };
  const checkTime = () => { if (now() - started >= LIMITS.milliseconds) refuse('time_bound'); };
  try {
    checkTime();
    if (!Buffer.isBuffer(bytes) || bytes.length > LIMITS.callback) refuse('callback_bound');
    const callback = json(bytes, 'malformed_callback', checkTime);
    result.callback = { turn_id_present: object(callback) && Object.hasOwn(callback, 'turn_id'), transcript_path_present: object(callback) && Object.hasOwn(callback, 'transcript_path') };
    callbackFields(callback, options);
    return withSnapshot(callback.transcript_path, io, checkTime, data => classify(data, callback, options, checkTime, result));
  } catch (error) {
    // Preserve safe field projections, but never a success claim from a snapshot that changed later.
    delete result.observation;
    return { ...result, status: 'unavailable', reason: error instanceof Refusal ? error.reason : 'file_unavailable' };
  }
}

export const envelope = result => ({ hookSpecificOutput: {
  hookEventName: 'UserPromptSubmit',
  additionalContext: `Codex turn timing metadata (observation only; no mode authorization; native authenticity and exact dispatch timing unverified): ${JSON.stringify(result)}`,
} });

// The host's two-second command timeout supplies the hard wall limit. Sync filesystem calls cannot be interrupted here.
export function readCallback(input, schedule = setTimeout, cancel = clearTimeout) {
  return new Promise(resolveInput => {
    let size = 0, chunks = [], timer, settled = false;
    const finish = value => {
      if (settled) return;
      settled = true; cancel(timer); input.pause();
      input.removeListener('data', data); input.removeListener('end', end);
      chunks = []; resolveInput(value);
    };
    const data = chunk => { size += chunk.length; if (size > LIMITS.callback) finish({ reason: 'callback_bound' }); else chunks.push(Buffer.from(chunk)); };
    const end = () => finish({ bytes: Buffer.concat(chunks) });
    const error = () => finish({ reason: 'input_unavailable' });
    // Keep the error listener until exit, so a late pipe error cannot print private diagnostics.
    input.on('data', data); input.once('end', end); input.on('error', error);
    timer = schedule(() => finish({ reason: 'time_bound' }), LIMITS.milliseconds);
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.stdout.on('error', () => {}); // A closed host pipe must not print a stack or path.
  const started = performance.now();
  let result = { status: 'unavailable', reason: 'invalid_arguments' };
  if (process.argv.length === 6 && process.argv[2] === '--session-dir' && process.argv[4] === '--project') {
    const input = await readCallback(process.stdin);
    result = input.reason ? { status: 'unavailable', reason: input.reason }
      : inspectCallback(input.bytes, { sessionDirectory: process.argv[3], project: process.argv[5] }, fs, () => performance.now(), started);
  }
  process.stdout.write(`${JSON.stringify(envelope(result))}\n`);
}
