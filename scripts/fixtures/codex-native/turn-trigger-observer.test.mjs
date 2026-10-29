import '../../test-env.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectFixture } from '../../../packages/sage-codex/hooks/turn-trigger-observer.mjs';

const command = fileURLToPath(new URL('../../../packages/sage-codex/hooks/turn-trigger-observer.mjs', import.meta.url));
const session = '11111111-1111-4111-8111-111111111111';
const turn = '22222222-2222-4222-8222-222222222222';
const other = '33333333-3333-4333-8333-333333333333';
const line = (type, payload) => ({ timestamp: '2026-10-28T00:00:00.000Z', type, payload });
const unavailable = reason => ({ status: 'unavailable', reason });
const success = { status: 'observed', trigger: 'user', matches: { session: true, root: true, project: true, turn: true, attribution: true } };

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'sage-trigger-sample-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'sample.jsonl');
  const rows = [line('session_meta', { id: session, session_id: session, cwd: root, cli_version: '0.164.0', source: 'cli' }),
    line('event_msg', { type: 'task_started', turn_id: turn, root_turn_id: turn, model_context_window: 1000, collaboration_mode_kind: 'default',
      turn_attribution: { turn_id: turn, turn_trigger: 'user', root_turn_id: turn, parent_turn_id: null, initiating_agent_path: null } })];
  const callback = { hook_event_name: 'UserPromptSubmit', session_id: session, turn_id: turn, cwd: root,
    transcript_path: file, prompt: 'SAMPLE DATA: never returned', model: 'sample', permission_mode: 'default' };
  const options = { fixtureRoot: root, project: root };
  const write = () => fs.writeFileSync(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  write();
  const inspect = (io, now) => inspectFixture(callback, options, io, now);
  return { root, file, rows, callback, options, write, inspect };
}

test('synthetic root start gives only a fixed trigger and agreement flags', t => {
  const f = fixture(t);
  assert.deepEqual(f.inspect(), success);
});

test('T90 regression: fork ordinal excludes inherited history', t => {
  const f = fixture(t); f.rows[0].payload.forked_from_ordinal_exclusive = 1; f.write();
  assert.deepEqual(f.inspect(), unavailable('unsupported_layout'));
});

test('T90 regression: preceding terminal root must agree', t => {
  const f = fixture(t);
  f.rows.splice(1, 0, line('event_msg', { type: 'task_complete', turn_id: other, root_turn_id: turn })); f.write();
  assert.deepEqual(f.inspect(), unavailable('identity_mismatch'));
});

test('T90 regression: duplicate paginated ordinals refuse', t => {
  const f = fixture(t); f.rows[0].payload.history_mode = 'paginated';
  f.rows[0].ordinal = 0; f.rows[1].ordinal = 0; f.write();
  assert.deepEqual(f.inspect(), unavailable('unsupported_layout'));
});

for (const placement of ['before', 'after']) {
  for (const root of [undefined, null, turn]) test(`repair context control: ${placement}, root ${root}`, t => {
    const f = fixture(t);
    f.rows.splice(placement === 'before' ? 1 : 2, 0, line('turn_context', { turn_id: turn, root_turn_id: root, cwd: f.root }));
    f.write();
    assert.deepEqual(f.inspect(), success);
  });
  for (const field of ['root_turn_id', 'cwd']) test(`repair context contradiction: ${field} ${placement} start`, t => {
    const f = fixture(t);
    const context = { turn_id: turn, root_turn_id: turn, cwd: f.root };
    context[field] = field === 'cwd' ? '/sample-other' : other;
    f.rows.splice(placement === 'before' ? 1 : 2, 0, line('turn_context', context)); f.write();
    assert.deepEqual(f.inspect(), unavailable('identity_mismatch'));
  });
}

test('repair context control: an earlier turn can have a different project', t => {
  const f = fixture(t);
  f.rows.splice(1, 0, line('turn_context', { turn_id: other, root_turn_id: other, cwd: '/sample-earlier' })); f.write();
  assert.deepEqual(f.inspect(), success);
});

for (const cut of [false, true]) {
  function earlierTerminal(f, duplicates = []) {
    const previous = structuredClone(f.rows[1]);
    previous.payload.turn_id = other; previous.payload.root_turn_id = other;
    previous.payload.turn_attribution.turn_id = other; previous.payload.turn_attribution.root_turn_id = other;
    const prefix = cut ? [previous, line('response_item', { type: 'message', content: 'SAMPLE '.repeat(50000) })] : [];
    f.rows.splice(1, 0, ...prefix, line('event_msg', { type: 'task_complete', turn_id: other }),
      ...duplicates.map(type => line('event_msg', { type, turn_id: other, reason: 'interrupted' })));
  }
  test(`repair terminal control: one preceding terminal, cut ${cut}`, t => {
    const f = fixture(t); earlierTerminal(f); f.write();
    assert.deepEqual(f.inspect(), success);
  });
  for (const terminal of ['task_complete', 'turn_aborted', 'turn_suspended']) {
    test(`T90 terminal conflict (unverified suspension is unsupported): ${terminal}, cut ${cut}`, t => {
      const f = fixture(t); earlierTerminal(f, [terminal]); f.write();
      assert.deepEqual(f.inspect(), unavailable(terminal === 'turn_suspended' ? 'unsupported_layout' : 'terminal_evidence'));
    });
  }
}

test('repair terminal conflict: a terminated preceding turn cannot restart', t => {
  const f = fixture(t);
  const previous = structuredClone(f.rows[1]);
  previous.payload.turn_id = other; previous.payload.root_turn_id = other;
  previous.payload.turn_attribution.turn_id = other; previous.payload.turn_attribution.root_turn_id = other;
  f.rows.splice(1, 0, line('event_msg', { type: 'task_complete', turn_id: other }), previous,
    line('event_msg', { type: 'task_complete', turn_id: other })); f.write();
  assert.deepEqual(f.inspect(), unavailable('conflicting_start'));
});

// All payloads are made-up data with the field shapes from the pinned public protocol.
const tokenUsage = { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0, total_tokens: 2 };
const hookRun = { id: 'SAMPLE', event_name: 'user_prompt_submit', handler_type: 'command', execution_mode: 'sync', scope: 'turn',
  source_path: '/sample/hook', display_order: 0, status: 'running', started_at: 0, entries: [{ kind: 'context', text: 'SAMPLE' }] };
const eventControls = [
  { type: 'user_message', message: 'SAMPLE DATA', images: null, local_images: [],
    image_details: [null, 'original'], text_elements: [{ byte_range: { start: 0, end: 6 }, placeholder: null }] },
  { type: 'agent_message', message: 'SAMPLE DATA', phase: 'commentary', delivery: 'async',
    memory_citation: { entries: [{ path: 'SAMPLE', lineStart: 1, lineEnd: 1, note: 'SAMPLE' }], rolloutIds: [] },
    questions: [{ title: 'SAMPLE', options: ['SAMPLE'] }] },
  { type: 'agent_reasoning', text: 'SAMPLE DATA' },
  { type: 'agent_reasoning_raw_content', text: 'SAMPLE DATA' },
  { type: 'token_count', info: { total_token_usage: tokenUsage, last_token_usage: tokenUsage, model_context_window: null },
    rate_limits: { primary: { used_percent: 1, window_minutes: null, resets_at: null }, credits: { has_credits: true, unlimited: false } } },
  { type: 'hook_started', turn_id: turn, run: hookRun },
  { type: 'hook_completed', turn_id: turn, run: { ...hookRun, status: 'completed' } },
];
for (const control of eventControls) for (const placement of ['before', 'after']) {
  test(`repair event control: ${control.type} ${placement} start`, t => {
    const f = fixture(t); f.rows.splice(placement === 'before' ? 1 : 2, 0, line('event_msg', control)); f.write();
    assert.deepEqual(f.inspect(), success);
  });
}
const malformedEvents = [
  ['array event type', { type: ['user_message'], message: 'SAMPLE DATA' }],
  ['numeric user message', { type: 'user_message', message: 123, images: null, local_images: [] }],
  ['missing user message', { type: 'user_message' }],
  ['null user message', { type: 'user_message', message: null }],
  ['non-string image', { ...eventControls[0], images: [123] }],
  ['null defaulted array', { ...eventControls[0], local_images: null }],
  ['unknown image detail', { ...eventControls[0], image_details: ['future'] }],
  ['invalid text element', { ...eventControls[0], text_elements: [{ byte_range: { start: '0', end: 1 } }] }],
  ['numeric agent message', { type: 'agent_message', message: 123 }],
  ['unknown message phase', { ...eventControls[1], phase: 'future' }],
  ['invalid citation', { ...eventControls[1], memory_citation: { entries: [], rolloutIds: [123] } }],
  ['invalid question', { ...eventControls[1], questions: [{ title: 123 }] }],
  ['numeric reasoning', { type: 'agent_reasoning', text: 123 }],
  ['missing raw reasoning', { type: 'agent_reasoning_raw_content' }],
  ['invalid token info', { type: 'token_count', info: 123 }],
  ['invalid usage', { type: 'token_count', info: { total_token_usage: { ...tokenUsage, input_tokens: '1' }, last_token_usage: tokenUsage } }],
  ['invalid rate window', { type: 'token_count', rate_limits: { primary: { used_percent: '1' } } }],
  ['missing hook run', { type: 'hook_started', turn_id: turn }],
  ['invalid hook run', { type: 'hook_completed', turn_id: turn, run: {} }],
  ['invalid hook entry', { type: 'hook_started', turn_id: turn, run: { ...hookRun, entries: [{ kind: 'context', text: 123 }] } }],
];
for (const [name, payload] of malformedEvents) for (const placement of ['before', 'after']) {
  test(`T90 revised opaque-content contract retains historical payload: ${name} ${placement} start`, t => {
    const f = fixture(t); f.rows.splice(placement === 'before' ? 1 : 2, 0, line('event_msg', payload)); f.write();
    assert.deepEqual(f.inspect(), name === 'array event type' ? unavailable('unsupported_layout') : success);
  });
}

const cases = [
  ['callback child', f => { f.callback.agent_id = other; }, 'child_evidence'],
  ['callback null child field', f => { f.callback.agent_type = null; }, 'child_evidence'],
  ['wrong callback event', f => { f.callback.hook_event_name = 'SessionStart'; }, 'invalid_callback'],
  ['missing callback turn', f => { delete f.callback.turn_id; }, 'invalid_callback'],
  ['unknown callback layout', f => { f.callback.future = true; }, 'unsupported_layout'],
  ['oversized callback', f => { f.callback.prompt = 'x'.repeat(65536); }, 'callback_too_large'],
  ['wrong callback project', f => { f.callback.cwd = '/sample-other'; }, 'identity_mismatch'],
  ['missing boundary', f => { delete f.options.fixtureRoot; }, 'invalid_boundary'],
  ['filesystem root boundary', f => { f.options.fixtureRoot = '/'; }, 'invalid_boundary'],
  ['outside selected path', f => { f.callback.transcript_path = '/sample-outside.jsonl'; }, 'path_boundary'],
  ['noncanonical path', f => { f.callback.transcript_path = f.root + '/../sample'; }, 'invalid_callback'],
  ['root session mismatch', f => { f.rows[0].payload.session_id = other; }, 'identity_mismatch'],
  ['header thread mismatch', f => { f.rows[0].payload.id = other; }, 'identity_mismatch'],
  ['header project mismatch', f => { f.rows[0].payload.cwd = '/other'; }, 'identity_mismatch'],
  ['missing root identity', f => { delete f.rows[0].payload.session_id; }, 'unsupported_layout'],
  ['child parent', f => { f.rows[0].payload.parent_thread_id = other; }, 'child_evidence'],
  ['child path', f => { f.rows[0].payload.agent_path = '/root/child'; }, 'child_evidence'],
  ['review source', f => { f.rows[0].payload.source = { subagent: 'review' }; }, 'child_evidence'],
  ['child thread source', f => { f.rows[0].payload.thread_source = 'subagent'; }, 'child_evidence'],
  ['unknown source', f => { f.rows[0].payload.source = 'unknown'; }, 'unsupported_layout'],
  ['inherited history', f => { f.rows[0].payload.history_base = {}; }, 'unsupported_layout'],
  ['fork metadata', f => { f.rows[0].payload.forked_from_id = other; }, 'unsupported_layout'],
  ['absent attribution', f => { delete f.rows[1].payload.turn_attribution; }, 'missing_attribution'],
  ['missing lineage', f => { delete f.rows[1].payload.turn_attribution.parent_turn_id; }, 'unsupported_layout'],
  ['missing trigger', f => { delete f.rows[1].payload.turn_attribution.turn_trigger; }, 'unsupported_trigger'],
  ['arbitrary trigger', f => { f.rows[1].payload.turn_attribution.turn_trigger = 'SECRET sample'; }, 'unsupported_trigger'],
  ['attribution mismatch', f => { f.rows[1].payload.turn_attribution.turn_id = other; }, 'identity_mismatch'],
  ['event root mismatch', f => { f.rows[1].payload.root_turn_id = other; }, 'identity_mismatch'],
  ['attribution root mismatch', f => { f.rows[1].payload.turn_attribution.root_turn_id = other; }, 'identity_mismatch'],
  ['delegated attribution', f => { f.rows[1].payload.turn_attribution.initiating_agent_path = '/root/child'; }, 'child_evidence'],
  ['parent turn', f => { f.rows[1].payload.turn_attribution.parent_turn_id = other; }, 'child_evidence'],
  ['event turn mismatch', f => { f.rows[1].payload.turn_id = other; }, 'identity_mismatch'],
  ['duplicate start', f => { f.rows.push(structuredClone(f.rows[1])); }, 'conflicting_start'],
  ['later different start', f => { f.rows.push(line('event_msg', { type: 'task_started', turn_id: other })); }, 'conflicting_start'],
  ['completed turn', f => { f.rows.push(line('event_msg', { type: 'task_complete', turn_id: turn })); }, 'terminal_evidence'],
  ['interrupted turn', f => { f.rows.push(line('event_msg', { type: 'turn_aborted', turn_id: turn })); }, 'terminal_evidence'],
  ['unattributed terminal', f => { f.rows.push(line('event_msg', { type: 'turn_aborted' })); }, 'terminal_evidence'],
  ['conflicting terminal', f => { f.rows.push(line('event_msg', { type: 'task_complete', turn_id: other })); }, 'terminal_evidence'],
  ['terminal before start', f => { f.rows.splice(1, 0, line('event_msg', { type: 'task_complete', turn_id: turn })); }, 'terminal_evidence'],
  ['wrong context turn', f => { f.rows.push(line('turn_context', { turn_id: other, cwd: f.root })); }, 'identity_mismatch'],
  ['wrong context project', f => { f.rows.push(line('turn_context', { turn_id: turn, cwd: '/other' })); }, 'identity_mismatch'],
  ['unsupported start alias', f => { f.rows[1].payload.type = 'turn_started'; }, 'unsupported_layout'],
  ['unknown record', f => { f.rows.push(line('future', {})); }, 'unsupported_layout'],
  ['unknown event', f => { f.rows.push(line('event_msg', { type: 'future' })); }, 'unsupported_layout'],
  ['unknown response', f => { f.rows.push(line('response_item', { type: 'future' })); }, 'unsupported_layout'],
  ['second header', f => { f.rows.push(structuredClone(f.rows[0])); }, 'unsupported_layout'],
  ['oversized header', f => { f.rows[0].payload.base_instructions = 'x'.repeat(16384); }, 'header_bound'],
  ['too many records', f => { for (let i = 0; i < 2048; i++) f.rows.push({ timestamp: '', type: 'response_item', payload: { type: 'message' } }); }, 'record_bound'],
];
for (const [name, mutate, reason] of cases) test(`synthetic refusal: ${name}`, t => {
  const f = fixture(t); mutate(f); f.write();
  assert.deepEqual(f.inspect(), unavailable(reason));
});

test('recorded version and request text do not assert runtime version or initial input', t => {
  const f = fixture(t);
  f.rows[0].payload.cli_version = 'SAMPLE unknown recorded version';
  f.rows.push(line('event_msg', { type: 'user_message', message: 'SAMPLE steering text' }));
  f.rows.push(line('response_item', { type: 'message', content: [{ type: 'input_text', text: 'SAMPLE private text' }] }));
  f.callback.prompt = 'SAMPLE steering'; f.write();
  assert.deepEqual(f.inspect(), success);
});

test('a complete earlier turn does not change the matching current-turn classification', t => {
  const f = fixture(t);
  const previous = structuredClone(f.rows[1]);
  previous.payload.turn_id = other; previous.payload.root_turn_id = other;
  previous.payload.turn_attribution.turn_id = other; previous.payload.turn_attribution.root_turn_id = other;
  f.rows.splice(1, 0, previous, line('event_msg', { type: 'task_complete', turn_id: other })); f.write();
  assert.deepEqual(f.inspect(), success);
  f.rows.splice(2, 1); f.write();
  assert.deepEqual(f.inspect(), unavailable('conflicting_start'));
});

test('a complete matching start must be present', t => {
  const f = fixture(t); f.rows.splice(1, 1, line('event_msg', { type: 'user_message', message: 'SAMPLE' })); f.write();
  assert.deepEqual(f.inspect(), unavailable('missing_start'));
});

for (const [name, data, reason] of [
  ['unfinished final record', f => fs.readFileSync(f.file).subarray(0, -1), 'incomplete_section'],
  ['malformed record', f => Buffer.concat([fs.readFileSync(f.file), Buffer.from('{bad}\n')]), 'malformed_record'],
  ['invalid UTF-8', f => Buffer.concat([fs.readFileSync(f.file), Buffer.from([255, 10])]), 'malformed_record'],
  ['duplicate key', f => fs.readFileSync(f.file, 'utf8').replace('"turn_trigger":"user"', '"turn_trigger":"other","turn_trigger":"user"'), 'malformed_record'],
  ['escaped duplicate key', f => fs.readFileSync(f.file, 'utf8').replace('"turn_trigger":"user"', '"turn_\\u0074rigger":"other","turn_trigger":"user"'), 'malformed_record'],
  ['excessive depth', f => fs.readFileSync(f.file, 'utf8') + '['.repeat(33) + '0' + ']'.repeat(33) + '\n', 'malformed_record'],
]) test(`synthetic refusal: ${name}`, t => {
  const f = fixture(t); fs.writeFileSync(f.file, data(f));
  assert.deepEqual(f.inspect(), unavailable(reason));
});

test('only a bounded header and contiguous complete tail are read from a large sample', t => {
  const f = fixture(t);
  const filler = line('response_item', { type: 'message', content: 'SAMPLE '.repeat(50000) });
  f.rows.splice(1, 0, filler); f.write();
  let bytes = 0;
  const io = { ...fs, readSync(...args) { const n = fs.readSync(...args); bytes += n; return n; } };
  assert.deepEqual(f.inspect(io), success);
  assert.ok(bytes <= 262144, `${bytes} bytes`);
  f.rows.push(filler); f.write();
  assert.deepEqual(f.inspect(), unavailable('tail_bound'));
});

test('symlinks, linked files and directories are refused before any data read', t => {
  const f = fixture(t);
  const alias = join(f.root, 'alias.jsonl'); fs.symlinkSync(f.file, alias);
  f.callback.transcript_path = alias;
  assert.deepEqual(f.inspect(), unavailable('path_boundary'));
  fs.unlinkSync(alias); fs.linkSync(f.file, alias);
  assert.deepEqual(f.inspect(), unavailable('not_regular_file'));
  fs.unlinkSync(alias); fs.mkdirSync(alias);
  assert.deepEqual(f.inspect(), unavailable('not_regular_file'));
  fs.rmdirSync(alias); fs.symlinkSync(f.root, alias);
  f.callback.transcript_path = join(alias, 'sample.jsonl');
  assert.deepEqual(f.inspect(), unavailable('path_boundary'));
});

for (const kind of ['replace', 'truncate', 'append', 'overwrite']) test(`snapshot changes refuse: ${kind}`, t => {
  const f = fixture(t); let changed = false;
  const io = { ...fs, readSync(...args) {
    const n = fs.readSync(...args);
    if (!changed) {
      changed = true;
      if (kind === 'replace') { fs.renameSync(f.file, f.file + '.old'); fs.writeFileSync(f.file, 'SAMPLE replacement'); }
      if (kind === 'truncate') fs.truncateSync(f.file, 1);
      if (kind === 'append') fs.appendFileSync(f.file, '\n');
      if (kind === 'overwrite') { const fd = fs.openSync(f.file, 'r+'); fs.writeSync(fd, 'X', 0); fs.closeSync(fd); }
    }
    return n;
  } };
  assert.deepEqual(f.inspect(io), unavailable('changed_snapshot'));
});

test('a replaced ancestor is refused after open and before file data is read', t => {
  const f = fixture(t); const dir = join(f.root, 'nested'); fs.mkdirSync(dir);
  const path = join(dir, 'sample.jsonl'); fs.renameSync(f.file, path); f.callback.transcript_path = path;
  let reads = 0;
  const io = { ...fs, openSync(...args) {
    const fd = fs.openSync(...args); fs.renameSync(dir, dir + '-old'); fs.mkdirSync(dir);
    fs.writeFileSync(path, 'SAMPLE replacement'); return fd;
  }, readSync(...args) { reads++; return fs.readSync(...args); } };
  assert.deepEqual(f.inspect(io), unavailable('changed_snapshot'));
  assert.equal(reads, 0);
});

test('deadline produces a fixed refusal', t => {
  const f = fixture(t); let time = 0;
  assert.deepEqual(f.inspect(fs, () => { time += 900; return time; }), unavailable('time_bound'));
});

test('inactive command accepts callback JSON and returns no source text or file details', t => {
  const f = fixture(t);
  const args = [command, '--synthetic-root', f.root, '--project', f.root];
  const result = spawnSync(process.execPath, args, { input: JSON.stringify(f.callback), encoding: 'utf8', timeout: 2500 });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), success);
  assert.equal(result.stderr, '');
  const bad = spawnSync(process.execPath, args, { input: '{"prompt":0,"prompt":1}', encoding: 'utf8', timeout: 2500 });
  assert.deepEqual(JSON.parse(bad.stdout), unavailable('invalid_callback'));
  const large = spawnSync(process.execPath, args, { input: 'x'.repeat(65537), encoding: 'utf8', timeout: 2500 });
  assert.deepEqual(JSON.parse(large.stdout), unavailable('callback_too_large'));
});

test('inactive command times out an unfinished callback', async t => {
  const f = fixture(t);
  const child = spawn(process.execPath, [command, '--synthetic-root', f.root, '--project', f.root]);
  t.after(() => child.kill());
  let output = ''; child.stdout.on('data', data => { output += data; });
  child.stdin.write('{');
  const status = await new Promise(resolve => child.once('exit', resolve));
  assert.equal(status, 0);
  assert.deepEqual(JSON.parse(output), unavailable('time_bound'));
});

// R847/R850/R851 reproductions remain visible under the adopted T90 contract.
// These are deliberately nonconforming message payloads; none supplies diagnostic evidence.
for (const placement of ['before', 'after']) {
  const opaqueRows = [
    ['response role/content', line('response_item', { type: 'message', role: 123, content: 123 })],
    ['function arguments', line('response_item', { type: 'function_call', name: 'SAMPLE', call_id: 'SAMPLE', arguments: 123 })],
    ['context model', line('turn_context', { turn_id: turn, model: 123 })],
    ['context realtime', line('turn_context', { turn_id: turn, realtime_active: 'yes' })],
    ['context plugin IDs', line('turn_context', { turn_id: turn, disabled_plugin_ids: [123] })],
  ];
  for (const [name, row] of opaqueRows) test(`T90 revised opaque-content contract: historical ${name} ${placement}`, t => {
    const f = fixture(t); const record = structuredClone(row);
    if (record.type === 'turn_context') record.payload.cwd = f.root;
    f.rows.splice(placement === 'before' ? 1 : 2, 0, record); f.write();
    assert.deepEqual(f.inspect(), success);
  });
}
for (const [field, value] of [['model_context_window', 'invalid'], ['trace_id', 123], ['started_at', { bad: true }]]) {
  test(`T90 revised opaque-content contract: historical start ${field}`, t => {
    const f = fixture(t); f.rows[1].payload[field] = value; f.write();
    assert.deepEqual(f.inspect(), success);
  });
}
test('T90 revised opaque-content contract: historical terminal message', t => {
  const f = fixture(t);
  f.rows.splice(1, 0, line('event_msg', { type: 'task_complete', turn_id: other, last_agent_message: 123 })); f.write();
  assert.deepEqual(f.inspect(), success);
});
test('T90 revised opaque-content contract: callback content and recorded version are unused', t => {
  const f = fixture(t); f.callback.prompt = { sample: true }; f.callback.model = 123; delete f.callback.permission_mode;
  delete f.rows[0].payload.cli_version; f.write();
  assert.deepEqual(f.inspect(), success);
});
for (const type of ['message', 'reasoning', 'function_call', 'function_call_output', 'custom_tool_call', 'custom_tool_call_output']) {
  test(`T90 opaque response discriminator control: ${type}`, t => {
    const f = fixture(t); f.rows.push({ ...line('response_item', { type, content: { sample: true } }), metadata: [123, null] }); f.write();
    assert.deepEqual(f.inspect(), success);
  });
}
for (const mode of [undefined, 'legacy', 'paginated']) test(`T90 history control: ${mode}`, t => {
  const f = fixture(t); f.rows[0].payload.history_mode = mode;
  if (mode === 'paginated') f.rows.forEach((row, i) => { row.ordinal = i; }); f.write();
  assert.deepEqual(f.inspect(), success);
});
for (const mode of [null, 1, [], {}, 'future', 'Paginated']) test(`T90 unsupported history mode: ${JSON.stringify(mode)}`, t => {
  const f = fixture(t); f.rows[0].payload.history_mode = mode; f.write();
  assert.deepEqual(f.inspect(), unavailable('unsupported_layout'));
});
for (const mode of [undefined, 'legacy']) for (const where of [0, 1, 2]) {
  test(`T90 legacy refuses declared ordinal: ${mode}, row ${where}`, t => {
    const f = fixture(t); f.rows[0].payload.history_mode = mode;
    f.rows.push(line('response_item', { type: 'message' })); f.rows[where].ordinal = 0; f.write();
    assert.deepEqual(f.inspect(), unavailable('unsupported_layout'));
  });
}
for (const placement of ['header', 'before', 'start', 'after']) {
  for (const value of [undefined, null, '1', true, [], {}, -1, 0.5, 18446744073709551616]) {
    test(`T90 paginated ordinal type/range: ${placement} ${JSON.stringify(value)}`, t => {
      const f = fixture(t); f.rows[0].payload.history_mode = 'paginated';
      f.rows.splice(1, 0, line('event_msg', { type: 'user_message' }));
      f.rows.push(line('response_item', { type: 'message' }));
      f.rows.forEach((row, i) => { row.ordinal = i; });
      f.rows[['header', 'before', 'start', 'after'].indexOf(placement)].ordinal = value; f.write();
      assert.deepEqual(f.inspect(), unavailable('unsupported_layout'));
    });
  }
  if (placement !== 'header') for (const shift of [-1, 1]) {
    test(`T90 paginated duplicate/gap: ${placement}, shift ${shift}`, t => {
      const f = fixture(t); f.rows[0].payload.history_mode = 'paginated';
      f.rows.splice(1, 0, line('event_msg', { type: 'user_message' }));
      f.rows.push(line('response_item', { type: 'message' }));
      f.rows.forEach((row, i) => { row.ordinal = i; });
      f.rows[['header', 'before', 'start', 'after'].indexOf(placement)].ordinal += shift; f.write();
      assert.deepEqual(f.inspect(), unavailable('unsupported_layout'));
    });
  }
}
for (const token of ['-0', '1.0', '1e0', '1.0000000000000001', '18446744073709551616']) {
  test(`T90 ordinals use exact unsigned integer tokens: ${token}`, t => {
    const f = fixture(t); f.rows[0].payload.history_mode = 'paginated';
    f.rows.forEach((row, i) => { row.ordinal = i; }); f.write();
    fs.writeFileSync(f.file, fs.readFileSync(f.file, 'utf8').replace('"ordinal":1', `"ordinal":${token}`));
    assert.deepEqual(f.inspect(), unavailable('unsupported_layout'));
  });
}
for (const [first, next, expected] of [
  ['5', '6', success],
  ['9007199254740992', '9007199254740993', success],
  ['18446744073709551614', '18446744073709551615', success],
  ['9007199254740992', '9007199254740992', unavailable('unsupported_layout')],
  ['9007199254740992', '9007199254740994', unavailable('unsupported_layout')],
  ['18446744073709551615', '18446744073709551616', unavailable('unsupported_layout')],
  ['0', '1', unavailable('unsupported_layout')],
]) test(`T90 cut permits header-tail gap with exact consecutive u64: ${first}, ${next}`, t => {
  const f = fixture(t); f.rows[0].payload.history_mode = 'paginated'; f.rows[0].ordinal = 0;
  f.rows.splice(1, 0, { ...line('response_item', { type: 'message', content: 'SAMPLE '.repeat(50000) }), ordinal: 1 });
  f.rows[2].ordinal = 'FIRST'; f.rows.push({ ...line('response_item', { type: 'message' }), ordinal: 'NEXT' }); f.write();
  fs.writeFileSync(f.file, fs.readFileSync(f.file, 'utf8').replace('"ordinal":"FIRST"', `"ordinal":${first}`).replace('"ordinal":"NEXT"', `"ordinal":${next}`));
  assert.deepEqual(f.inspect(), expected);
});
for (const type of ['task_complete', 'turn_aborted']) {
  for (const root of [undefined, null, other, turn, 123, {}]) test(`T90 preceding terminal root: ${type} ${JSON.stringify(root)}`, t => {
    const f = fixture(t); f.rows.splice(1, 0, line('event_msg', { type, turn_id: other, root_turn_id: root })); f.write();
    assert.deepEqual(f.inspect(), root == null || root === other ? success : unavailable('identity_mismatch'));
  });
}
for (const placement of ['before', 'after']) test(`T90 unverified turn_suspended refuses: ${placement}`, t => {
  const f = fixture(t); f.rows.splice(placement === 'before' ? 1 : 2, 0, line('event_msg', { type: 'turn_suspended', turn_id: other })); f.write();
  assert.deepEqual(f.inspect(), unavailable('unsupported_layout'));
});
for (const field of ['parent_thread_id', 'agent_path', 'agent_role', 'agent_type', 'agent_nickname', 'subagent_history_start_ordinal',
  'thread_source', 'history_base', 'forked_from_id', 'forked_from_ordinal_exclusive']) {
  for (const value of [false, 0, '', [], {}]) test(`T90 lineage/history exclusion: ${field} ${JSON.stringify(value)}`, t => {
    const f = fixture(t); f.rows[0].payload[field] = value; f.write();
    const reason = ['history_base', 'forked_from_id', 'forked_from_ordinal_exclusive'].includes(field) ? 'unsupported_layout' : 'child_evidence';
    assert.deepEqual(f.inspect(), unavailable(reason));
  });
}
for (const trigger of [undefined, null, 'internal']) test(`T90 only matching start classifies trigger: earlier ${trigger}`, t => {
  const f = fixture(t); const previous = structuredClone(f.rows[1]);
  previous.payload.turn_id = other; previous.payload.root_turn_id = other;
  previous.payload.turn_attribution = { turn_id: other, root_turn_id: other, turn_trigger: trigger, parent_turn_id: null, initiating_agent_path: null };
  f.rows.splice(1, 0, previous, line('event_msg', { type: 'task_complete', turn_id: other })); f.write();
  assert.deepEqual(f.inspect(), success);
});
for (const placement of ['before', 'after']) for (const field of ['turn_id', 'cwd', 'root_turn_id']) {
  for (const value of [undefined, null, 123, {}]) test(`T90 context identities: ${field} ${JSON.stringify(value)} ${placement}`, t => {
    const f = fixture(t); const context = { turn_id: turn, root_turn_id: turn, cwd: f.root }; context[field] = value;
    f.rows.splice(placement === 'before' ? 1 : 2, 0, line('turn_context', context)); f.write();
    assert.deepEqual(f.inspect(), field === 'root_turn_id' && value == null ? success : unavailable('identity_mismatch'));
  });
}
test('T90 context cannot follow its terminated turn', t => {
  const f = fixture(t); f.rows.splice(1, 0, line('event_msg', { type: 'task_complete', turn_id: other }),
    line('turn_context', { turn_id: other, cwd: f.root })); f.write();
  assert.deepEqual(f.inspect(), unavailable('identity_mismatch'));
});

for (const field of ['session_id', 'turn_id', 'cwd', 'transcript_path']) {
  for (const value of [undefined, null, 123, {}]) test(`T90 callback required identity: ${field} ${JSON.stringify(value)}`, t => {
    const f = fixture(t); f.callback[field] = value;
    assert.deepEqual(f.inspect(), unavailable('invalid_callback'));
  });
}
for (const field of ['id', 'session_id', 'cwd', 'source']) {
  for (const value of [undefined, null, 123]) test(`T90 header required identity/source: ${field} ${JSON.stringify(value)}`, t => {
    const f = fixture(t); f.rows[0].payload[field] = value; f.write();
    assert.deepEqual(f.inspect(), unavailable('unsupported_layout'));
  });
}
for (const field of ['turn_id', 'root_turn_id']) for (const value of [undefined, null, 123, {}]) {
  test(`T90 start required identity: ${field} ${JSON.stringify(value)}`, t => {
    const f = fixture(t); f.rows[1].payload[field] = value; f.write();
    assert.deepEqual(f.inspect(), unavailable('unsupported_layout'));
  });
  test(`T90 attribution required identity: ${field} ${JSON.stringify(value)}`, t => {
    const f = fixture(t); f.rows[1].payload.turn_attribution[field] = value; f.write();
    assert.deepEqual(f.inspect(), unavailable('unsupported_layout'));
  });
}
for (const field of ['parent_turn_id', 'initiating_agent_path']) for (const value of [undefined, 123, {}, '']) {
  test(`T90 attribution exclusion: ${field} ${JSON.stringify(value)}`, t => {
    const f = fixture(t); f.rows[1].payload.turn_attribution[field] = value; f.write();
    assert.deepEqual(f.inspect(), unavailable(value === undefined ? 'unsupported_layout' : 'child_evidence'));
  });
}
for (const trigger of [null, 123, {}, [], false]) test(`T90 matching literal trigger: ${JSON.stringify(trigger)}`, t => {
  const f = fixture(t); f.rows[1].payload.turn_attribution.turn_trigger = trigger; f.write();
  assert.deepEqual(f.inspect(), unavailable('unsupported_trigger'));
});
for (const placement of ['before', 'after']) {
  for (const type of ['task_complete', 'turn_aborted']) for (const id of [undefined, null, 123, {}]) {
    test(`T90 terminal required turn: ${type} ${JSON.stringify(id)} ${placement}`, t => {
      const f = fixture(t); f.rows.splice(placement === 'before' ? 1 : 2, 0, line('event_msg', { type, turn_id: id })); f.write();
      assert.deepEqual(f.inspect(), unavailable('terminal_evidence'));
    });
  }
  for (const row of [line('future', {}), line('event_msg', { type: 'future' }), line('response_item', { type: 'future' }),
    line('event_msg', { type: 123 }), line('response_item', { type: ['message'] }), line('response_item', null),
    { ...line('event_msg', { type: 'user_message' }), timestamp: null }]) {
    test(`T90 unsupported envelope/discriminator ${JSON.stringify(row)} ${placement}`, t => {
      const f = fixture(t); f.rows.splice(placement === 'before' ? 1 : 2, 0, row); f.write();
      assert.deepEqual(f.inspect(), unavailable('unsupported_layout'));
    });
  }
}
test('T90 valid root exclusions can be absent or null', t => {
  const f = fixture(t);
  Object.assign(f.rows[0].payload, { parent_thread_id: null, agent_path: '/root', agent_role: null, agent_type: null,
    agent_nickname: null, subagent_history_start_ordinal: null, thread_source: 'user', history_base: null,
    forked_from_id: null, forked_from_ordinal_exclusive: null }); f.write();
  assert.deepEqual(f.inspect(), success);
});
test('T90 opaque nested ordinal is not a record ordinal', t => {
  const f = fixture(t); f.rows[0].payload.history_mode = 'paginated';
  f.rows.forEach((row, i) => { row.ordinal = i; });
  f.rows[1].payload.model_settings = { ordinal: 'ignored', content: 123 }; f.write();
  assert.deepEqual(f.inspect(), success);
});
test('T90 duplicate keys remain malformed within opaque content', t => {
  const f = fixture(t);
  fs.appendFileSync(f.file, '{"timestamp":"SAMPLE","type":"response_item","payload":{"type":"message","content":{"x":1,"x":2}}}\n');
  assert.deepEqual(f.inspect(), unavailable('malformed_record'));
});
for (const depth of [29, 30]) test(`T90 opaque content depth: ${depth}`, t => {
  const f = fixture(t); let content = 0;
  for (let i = 0; i < depth; i++) content = [content];
  f.rows.push(line('response_item', { type: 'message', content })); f.write();
  assert.deepEqual(f.inspect(), success);
});
test('T90 opaque content still refuses excessive depth', t => {
  const f = fixture(t); let content = 0;
  for (let i = 0; i < 31; i++) content = [content];
  f.rows.push(line('response_item', { type: 'message', content })); f.write();
  assert.deepEqual(f.inspect(), unavailable('malformed_record'));
});
