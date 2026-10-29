#!/usr/bin/env node
// Inactive, synthetic-only observation. No mode, authorization, home discovery or capture.
// Layout: openai/codex@6aaac694803004a63c6f393d153c96d22521a6b9.
import * as fs from 'node:fs';
import { isAbsolute, normalize, parse, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';

const FILE_LIMIT = 256 * 1024;
const HEADER_LIMIT = 16 * 1024;
const CALLBACK_LIMIT = 64 * 1024;
const DEADLINE_MS = 1800;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const pathValue = value => typeof value === 'string' && value.length <= 4096 && isAbsolute(value)
  && normalize(value) === value && !/\p{Cc}/u.test(value);
const unavailable = reason => ({ status: 'unavailable', reason });
class Refusal extends Error { constructor(reason) { super(); this.reason = reason; } }
const refuse = reason => { throw new Refusal(reason); };

// Validate only the seven retained non-lifecycle event variants, against the pinned
// protocol.rs definitions. Serde Option permits absence/null; a defaulted Vec permits
// absence but not null. Do not infer evidence from these discarded message contents.
const textValue = value => typeof value === 'string';
const integer = value => Number.isInteger(value) && value >= -(2 ** 63) && value < 2 ** 63;
const unsigned = value => Number.isInteger(value) && value >= 0 && value < 2 ** 64;
const uint32 = value => unsigned(value) && value <= 0xffffffff;
const boolean = value => typeof value === 'boolean';
const optional = check => value => value == null || check(value);
const defaulted = check => value => value === undefined || check(value);
const array = check => value => Array.isArray(value) && value.every(check);
const shape = fields => value => object(value) && Object.entries(fields).every(([key, check]) => check(value[key]));
const choice = values => value => values.includes(value);
const strings = array(textValue);
const details = defaulted(array(optional(choice(['auto', 'low', 'high', 'original']))));
const usage = shape({ input_tokens: integer, cached_input_tokens: integer, cache_write_input_tokens: defaulted(integer),
  output_tokens: integer, reasoning_output_tokens: integer, total_tokens: integer });
const window = shape({ used_percent: Number.isFinite, window_minutes: optional(integer), resets_at: optional(integer) });
const hook = shape({
  turn_id: optional(textValue),
  run: shape({ id: textValue, event_name: choice(['pre_tool_use', 'permission_request', 'post_tool_use', 'pre_compact',
    'post_compact', 'session_start', 'session_end', 'user_prompt_submit', 'subagent_start', 'subagent_stop', 'stop',
    'interrupt', 'pre_model_request', 'post_model_request']), handler_type: choice(['command', 'mcp_tool', 'prompt', 'agent']),
  execution_mode: choice(['sync', 'async']), scope: choice(['thread', 'turn']), source_path: pathValue,
  source: defaulted(choice(['system', 'user', 'project', 'mdm', 'session_flags', 'plugin', 'cloud_requirements',
    'cloud_managed_config', 'legacy_managed_config_file', 'legacy_managed_config_mdm', 'unknown'])),
  display_order: integer, status: choice(['running', 'completed', 'failed', 'blocked', 'stopped']),
  status_message: optional(textValue), started_at: integer, completed_at: optional(integer), duration_ms: optional(integer),
  entries: array(shape({ kind: choice(['warning', 'stop', 'feedback', 'context', 'error']), text: textValue })) }),
});
const question = shape({ title: textValue, options: optional(strings) });
const eventPayloads = {
  user_message: shape({ message: textValue, client_id: optional(textValue), images: optional(strings),
    image_details: details, file_ids: optional(strings), file_id_details: details,
    image_order: defaulted(array(choice(['inline', 'file']))), local_images: defaulted(strings), local_image_details: details,
    audio: optional(strings), local_audio: defaulted(strings), text_elements: defaulted(array(shape({
      byte_range: shape({ start: unsigned, end: unsigned }), placeholder: optional(textValue),
    }))) }),
  agent_message: shape({ message: textValue, phase: optional(choice(['commentary', 'partial_answer', 'final_answer'])),
    memory_citation: optional(shape({ entries: array(shape({ path: textValue, lineStart: uint32, lineEnd: uint32, note: textValue })),
      rolloutIds: strings })), delivery: optional(choice(['async'])),
    questions: optional(array(value => question(value) && Object.keys(value).every(key => ['title', 'options'].includes(key)))) }),
  agent_reasoning: shape({ text: textValue }),
  agent_reasoning_raw_content: shape({ text: textValue }),
  token_count: shape({ info: optional(shape({ total_token_usage: usage, last_token_usage: usage, model_context_window: optional(integer) })),
    rate_limits: optional(shape({ limit_id: optional(textValue), limit_name: optional(textValue), normal_model_slug: optional(textValue),
      primary: optional(window), secondary: optional(window),
      credits: optional(shape({ has_credits: boolean, unlimited: boolean, balance: optional(textValue) })),
      individual_limit: optional(shape({ limit: textValue, used: textValue, remaining_percent: value => integer(value)
        && value >= -2147483648 && value <= 2147483647, resets_at: integer })),
      spend_control_reached: optional(boolean), plan_type: optional(textValue),
      rate_limit_reached_type: optional(choice(['rate_limit_reached', 'workspace_owner_credits_depleted',
        'workspace_member_credits_depleted', 'workspace_owner_usage_limit_reached', 'workspace_member_usage_limit_reached'])) })) }),
  hook_started: hook,
  hook_completed: hook,
};

// JSON.parse alone silently accepts duplicate keys. Reject those, invalid UTF-8 and deep nesting.
function json(bytes, reason) {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const value = JSON.parse(text);
    const stack = [];
    for (let i = 0; i < text.length; i++) {
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
        if (stack.length > 32) refuse(reason);
      } else if (char === '}' || char === ']') stack.pop();
      else if (char === ',' && stack.at(-1)?.keys) stack.at(-1).key = true;
    }
    return value;
  } catch { refuse(reason); }
}

function callbackFields(callback, options) {
  if (!object(options) || !pathValue(options.fixtureRoot) || options.fixtureRoot === parse(options.fixtureRoot).root
    || !pathValue(options.project)) refuse('invalid_boundary');
  if (!object(callback) || callback.hook_event_name !== 'UserPromptSubmit'
    || !uuid(callback.session_id) || !uuid(callback.turn_id) || !pathValue(callback.cwd)
    || !pathValue(callback.transcript_path) || typeof callback.prompt !== 'string'
    || typeof callback.model !== 'string' || typeof callback.permission_mode !== 'string') refuse('invalid_callback');
  if ('agent_id' in callback || 'agent_type' in callback) refuse('child_evidence');
  const keys = ['hook_event_name', 'session_id', 'turn_id', 'cwd', 'transcript_path', 'prompt', 'model', 'permission_mode'];
  if (Object.keys(callback).some(key => !keys.includes(key))) refuse('unsupported_layout');
  if (Buffer.byteLength(JSON.stringify(callback)) > CALLBACK_LIMIT) refuse('callback_too_large');
  if (callback.cwd !== options.project) refuse('identity_mismatch');
  const child = relative(options.fixtureRoot, callback.transcript_path);
  if (!child || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) refuse('path_boundary');
}

const sameNode = (a, b) => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode;
const sameFile = (a, b) => sameNode(a, b) && a.size === b.size && a.nlink === b.nlink
  && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;

function snapshot(path, io, checkTime) {
  const ancestors = [];
  let cursor = parse(path).root;
  for (const component of path.slice(cursor.length).split(sep)) {
    checkTime();
    cursor = resolve(cursor, component);
    const stat = io.lstatSync(cursor, { bigint: true });
    if (stat.isSymbolicLink() || (cursor !== path && !stat.isDirectory())) refuse('path_boundary');
    ancestors.push([cursor, stat]);
  }
  const selected = ancestors.at(-1)[1];
  if (!selected.isFile() || selected.nlink !== 1n) refuse('not_regular_file');
  let fd;
  try {
    fd = io.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const original = io.fstatSync(fd, { bigint: true });
    const stable = () => {
      checkTime();
      for (const [name, before] of ancestors) {
        const after = io.lstatSync(name, { bigint: true });
        if (!sameNode(before, after) || after.isSymbolicLink()) refuse('changed_snapshot');
      }
      if (!sameFile(original, io.fstatSync(fd, { bigint: true }))
        || !sameFile(original, io.lstatSync(path, { bigint: true }))) refuse('changed_snapshot');
    };
    if (!original.isFile() || !sameFile(original, selected) || original.nlink !== 1n) refuse('changed_snapshot');
    stable(); // Recheck every ancestor after open, before reading any file data.
    if (original.size < 1n || original.size > BigInt(Number.MAX_SAFE_INTEGER)) refuse('incomplete_section');
    const size = Number(original.size);
    const header = Buffer.alloc(HEADER_LIMIT);
    let used = 0;
    // Stop exactly at the first newline: the header consumes only its own byte budget.
    while (used < Math.min(HEADER_LIMIT, size)) {
      checkTime();
      if (io.readSync(fd, header, used, 1, used) !== 1) refuse('changed_snapshot');
      if (header[used++] === 10) break;
    }
    stable();
    if (!used || header[used - 1] !== 10) refuse('header_bound');
    const start = Math.max(used, size - (FILE_LIMIT - used));
    const tail = Buffer.alloc(size - start);
    let read = 0;
    while (read < tail.length) {
      checkTime();
      const count = io.readSync(fd, tail, read, tail.length - read, start + read);
      if (!count) refuse('changed_snapshot');
      read += count;
    }
    stable();
    if (!tail.length || tail.at(-1) !== 10) refuse('incomplete_section');
    // A tail cut can intersect a record. Drop it; never reconstruct across the unread gap.
    const offset = start === used ? 0 : tail.indexOf(10) + 1;
    if (offset === 0 && start !== used) refuse('tail_bound');
    return { header: header.subarray(0, used - 1), tail: tail.subarray(offset), cut: start !== used };
  } finally { if (fd !== undefined) io.closeSync(fd); }
}

function classify(data, callback, options, checkTime) {
  const header = json(data.header, 'malformed_record');
  if (!object(header) || header.type !== 'session_meta' || typeof header.timestamp !== 'string' || !object(header.payload)) refuse('unsupported_layout');
  const meta = header.payload;
  if (!uuid(meta.id) || !uuid(meta.session_id) || !pathValue(meta.cwd)
    || typeof meta.cli_version !== 'string' || !meta.cli_version || meta.cli_version.length > 128) refuse('unsupported_layout');
  if (meta.parent_thread_id != null || meta.agent_path != null && meta.agent_path !== '/root'
    || meta.agent_role != null || meta.agent_type != null || meta.agent_nickname != null
    || meta.subagent_history_start_ordinal != null || object(meta.source)
    || meta.thread_source != null && meta.thread_source !== 'user') refuse('child_evidence');
  if (meta.source !== 'cli' || meta.history_base != null || meta.forked_from_id != null) refuse('unsupported_layout');
  if (meta.id !== callback.session_id || meta.session_id !== callback.session_id || meta.cwd !== options.project) refuse('identity_mismatch');

  let matched;
  let activeTurn;
  const seenTurns = new Set();
  let count = 0;
  const terminals = new Set(['task_complete', 'turn_aborted', 'turn_suspended']);
  const responses = new Set(['message', 'reasoning', 'function_call', 'function_call_output', 'custom_tool_call', 'custom_tool_call_output']);
  for (const bytes of splitLines(data.tail)) {
    checkTime();
    if (++count > 2048) refuse('record_bound');
    const row = json(bytes, 'malformed_record');
    if (!object(row) || !object(row.payload) || typeof row.timestamp !== 'string') refuse('unsupported_layout');
    const p = row.payload;
    if (row.type === 'event_msg') {
      if (typeof p.type !== 'string') refuse('unsupported_layout');
      if (p.type === 'task_started') {
        if (!uuid(p.turn_id)) refuse('unsupported_layout');
        if (matched || activeTurn || seenTurns.has(p.turn_id)) refuse('conflicting_start');
        activeTurn = p.turn_id;
        seenTurns.add(p.turn_id);
        const a = p.turn_attribution;
        if (!object(a)) refuse('missing_attribution');
        if (!uuid(a.turn_id) || !uuid(a.root_turn_id) || !uuid(p.root_turn_id)
          || !Object.hasOwn(a, 'parent_turn_id') || !Object.hasOwn(a, 'initiating_agent_path')) refuse('unsupported_layout');
        if (a.parent_turn_id !== null || a.initiating_agent_path !== null) refuse('child_evidence');
        if (a.turn_id !== p.turn_id || a.root_turn_id !== p.turn_id || p.root_turn_id !== p.turn_id) refuse('identity_mismatch');
        if (a.turn_trigger !== 'user') refuse('unsupported_trigger');
        if (p.turn_id === callback.turn_id) matched = true;
      } else if (terminals.has(p.type)) {
        if (!uuid(p.turn_id) || matched || p.turn_id === callback.turn_id
          || activeTurn && p.turn_id !== activeTurn || !activeTurn && seenTurns.has(p.turn_id)) refuse('terminal_evidence');
        seenTurns.add(p.turn_id); // A start can be outside the tail; its terminal still counts.
        activeTurn = undefined;
      } else if (!Object.hasOwn(eventPayloads, p.type) || !eventPayloads[p.type](p)) refuse('unsupported_layout');
    } else if (row.type === 'turn_context') {
      if (!uuid(p.turn_id) || activeTurn && p.turn_id !== activeTurn
        || p.root_turn_id != null && p.root_turn_id !== p.turn_id
        || p.turn_id === callback.turn_id && p.cwd !== options.project) refuse('identity_mismatch');
    } else if (row.type !== 'response_item' || !responses.has(p.type)) refuse('unsupported_layout');
  }
  if (!matched) refuse(data.cut ? 'tail_bound' : 'missing_start');
  checkTime();
  return { status: 'observed', trigger: 'user', matches: { session: true, root: true, project: true, turn: true, attribution: true } };
}

function* splitLines(bytes) {
  let start = 0;
  for (let end = 0; end < bytes.length; end++) if (bytes[end] === 10) {
    yield bytes.subarray(start, end); start = end + 1;
  }
}

/** Testable synchronous boundary. The command runs this inside a timed thread. */
export function inspectFixture(callback, options, io = fs, now = () => performance.now()) {
  const start = now();
  const checkTime = () => { if (now() - start >= DEADLINE_MS) refuse('time_bound'); };
  try {
    callbackFields(callback, options);
    const data = snapshot(callback.transcript_path, io, checkTime);
    return classify(data, callback, options, checkTime);
  } catch (error) { return unavailable(error instanceof Refusal ? error.reason : 'file_unavailable'); }
}

function command() {
  const started = performance.now();
  let finished = false;
  const finish = result => {
    if (finished) return;
    if (performance.now() - started >= DEADLINE_MS) result = unavailable('time_bound');
    finished = true;
    process.stdout.write(JSON.stringify(result) + '\n', () => process.exit(0));
  };
  const timer = setTimeout(() => finish(unavailable('time_bound')), DEADLINE_MS);
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== '--synthetic-root' || args[2] !== '--project') return finish(unavailable('invalid_boundary'));
  const chunks = [];
  let length = 0;
  process.stdin.on('data', chunk => {
    length += chunk.length;
    if (length > CALLBACK_LIMIT) finish(unavailable('callback_too_large'));
    else chunks.push(chunk);
  });
  process.stdin.on('error', () => finish(unavailable('invalid_callback')));
  process.stdin.on('end', () => {
    if (finished) return;
    let callback;
    try { callback = json(Buffer.concat(chunks), 'invalid_callback'); }
    catch { return finish(unavailable('invalid_callback')); }
    const thread = new Worker(new URL(import.meta.url), { workerData: { callback, options: { fixtureRoot: args[1], project: args[3] } } });
    thread.once('message', result => { clearTimeout(timer); finish(result); });
    thread.once('error', () => finish(unavailable('file_unavailable')));
    thread.once('exit', () => { if (!finished) finish(unavailable('file_unavailable')); });
  });
}

if (!isMainThread) parentPort.postMessage(inspectFixture(workerData.callback, workerData.options));
else if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) command();
