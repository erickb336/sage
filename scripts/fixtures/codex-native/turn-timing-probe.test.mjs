import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { inspectCallback, envelope, LIMITS, readCallback } from '../../../packages/sage-codex/hooks/turn-timing-probe.mjs';
import { makeSample } from './turn-timing-sample.mjs';

const command = fileURLToPath(new URL('../../../packages/sage-codex/hooks/turn-timing-probe.mjs', import.meta.url));
const fixture = t => { const f = makeSample(); t.after(f.remove); return f; };
const unavailable = (value, reason) => { assert.equal(value.status, 'unavailable'); if (reason) assert.equal(value.reason, reason); assert.equal(value.observation, undefined); };
const privacy = (text, f) => {
  for (const secret of ['PROMPT_SECRET_SENTINEL', 'MESSAGE_SECRET_SENTINEL', 'PATH_SENTINEL', f.session, f.turn, f.other, f.root, f.file]) assert.ok(!text.includes(secret));
};

for (const cli_version of ['0.165.0-alpha.1.2', '0.164.0-alpha.11.1']) test(`reported desktop version ${cli_version} retains fictional metadata`, t => {
  const f = fixture(t);
  Object.assign(f.rows[0].payload, { source: 'vscode', cli_version });
  f.write();
  const result = f.inspect();
  assert.equal(result.status, 'present');
  assert.deepEqual(result.session_meta, { source: 'vscode', cli_version });
  assert.equal(result.task_started.turn_trigger, 'composer');
  privacy(JSON.stringify(envelope(result)), f);
});

for (const cli_version of ['0.164.0', '0.165.0-alpha.1', '999.999.999-alpha.999.999', '0.165.0-beta.1.2', '0.165.0-rc.1.2']) test(`bounded version ${cli_version} retains fictional metadata`, t => {
  const f = fixture(t); f.rows[0].payload.cli_version = cli_version; f.write();
  const result = f.inspect();
  assert.equal(result.status, 'present');
  assert.deepEqual(result.session_meta, { source: 'vscode', cli_version });
});

for (const cli_version of [
  '0.165.0-alpha.1.2.3', '0.165.0-alpha.1000.1', '0.165.0-alpha.1.1000',
  '1000.165.0', '0.1000.0', '0.165.1000', '0.165.0.1',
  '0.165.0-alpha', '0.165.0-alpha.', '0.165.0-alpha..1', '0.165.0-alpha.1.',
  '0.165.0-alpha.1.two', '0.165.0-preview.1.2', '0.165.0-alpha.1.2+build',
  '0.165.0-alpha.1.2\n', '0.165.0-alpha.' + '1'.repeat(100), null, 165,
]) test(`malformed or overbound version ${JSON.stringify(cli_version)} is unavailable`, t => {
  const f = fixture(t); f.rows[0].payload.cli_version = cli_version; f.write();
  const result = f.inspect();
  unavailable(result, 'unsupported_metadata');
  assert.equal(result.session_meta, undefined);
});

for (const trigger of ['composer', 'remote_ios', 'queue', 'exec']) test(`fictional ${trigger} is reported without authorizing a mode`, t => {
  const f = fixture(t);
  const source = trigger === 'exec' ? 'exec' : 'vscode';
  const cli_version = trigger === 'exec' ? '0.164.0' : '0.165.0-alpha.1.2';
  Object.assign(f.rows[0].payload, { source, cli_version });
  f.rows[1].payload.turn_attribution.turn_trigger = trigger; f.write();
  const result = f.inspect();
  assert.equal(result.status, 'present');
  assert.equal(result.observation, 'present at the first bounded callback read');
  assert.deepEqual(result.session_meta, { source, cli_version });
  assert.deepEqual(result.callback, { turn_id_present: true, transcript_path_present: true });
  assert.deepEqual(result.task_started, { timestamp: '2026-11-03T10:00:00.000Z', turn_trigger: trigger,
    parent_turn_id: 'null', root_turn_id: 'matches_callback_turn', initiating_agent_path: 'null' });
  const output = envelope(result);
  assert.deepEqual(Object.keys(output), ['hookSpecificOutput']);
  assert.deepEqual(Object.keys(output.hookSpecificOutput), ['hookEventName', 'additionalContext']);
  assert.equal(output.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  privacy(JSON.stringify(output), f);
});

test('complete root file without this start is absent', t => {
  const f = fixture(t); f.rows.splice(1, 1); f.write();
  assert.equal(f.inspect().status, 'absent');
  assert.equal(f.inspect().observation, 'absent after a complete bounded callback read');
});

test('unknown callback layout is unavailable without file access', t => {
  const f = fixture(t); f.callback.new_identity_field = f.other;
  unavailable(f.inspect({ ...fs, lstatSync() { assert.fail('must reject before file access'); } }), 'unsupported_layout');
});

test('earlier root starts do not stand in for the callback turn', t => {
  const f = fixture(t); const p = f.rows[1].payload;
  p.turn_id = f.other; p.root_turn_id = f.other; p.turn_attribution.turn_id = f.other; p.turn_attribution.root_turn_id = f.other;
  f.write(); assert.equal(f.inspect().status, 'absent');
  p.turn_attribution.parent_turn_id = f.turn; f.write(); unavailable(f.inspect(), 'child_evidence');
});

test('unsupported history records cannot establish absence', t => {
  const f = fixture(t); f.rows.splice(1, 1); f.rows.push(f.row('event_msg', { type: 'context_compacted' }));
  f.write(); unavailable(f.inspect(), 'unsupported_layout');
});

test('conflicting turn context invalidates a matching start', t => {
  const f = fixture(t); f.rows.push(f.row('turn_context', { turn_id: f.turn, root_turn_id: f.other, cwd: f.root }));
  f.write(); unavailable(f.inspect(), 'identity_mismatch');
});

test('missing optional lineage fields stay missing', t => {
  const f = fixture(t);
  for (const key of ['parent_turn_id', 'root_turn_id', 'initiating_agent_path']) delete f.rows[1].payload.turn_attribution[key];
  f.write(); const result = f.inspect(); assert.equal(result.status, 'present');
  for (const key of ['parent_turn_id', 'root_turn_id', 'initiating_agent_path']) assert.equal(result.task_started[key], 'missing');
});

for (const key of ['session_id', 'turn_id', 'transcript_path']) test(`missing required callback ${key} is unavailable`, t => {
  const f = fixture(t); delete f.callback[key]; unavailable(f.inspect(), 'invalid_callback');
});

for (const key of ['agent_id', 'agent_type', 'parent_thread_id', 'parent_turn_id', 'initiating_agent_path']) test(`callback child field ${key} is unavailable`, t => {
  const f = fixture(t); f.callback[key] = null; unavailable(f.inspect(), 'child_evidence');
});

for (const key of ['parent_turn_id', 'root_turn_id', 'initiating_agent_path']) test(`matching child ${key} has only a safe projection`, t => {
  const f = fixture(t); f.rows[1].payload.turn_attribution[key] = key === 'initiating_agent_path' ? '/CHILD_PATH_SENTINEL' : f.other; f.write();
  const result = f.inspect(); unavailable(result, 'child_evidence');
  assert.equal(result.task_started[key], key === 'root_turn_id' ? 'different' : 'present');
  privacy(JSON.stringify(envelope(result)), f);
  assert.ok(!JSON.stringify(result).includes('CHILD_PATH_SENTINEL'));
});

for (const [label, change, reason] of [
  ['child header', f => { f.rows[0].payload.agent_path = '/root/child'; }, 'child_evidence'],
  ['child source', f => { f.rows[0].payload.source = { subagent: 'SECRET' }; }, 'child_evidence'],
  ['fork', f => { f.rows[0].payload.forked_from_id = f.other; }, 'partial_history'],
  ['partial history', f => { f.rows[0].payload.history_base = {}; }, 'partial_history'],
  ['session mismatch', f => { f.rows[0].payload.id = f.other; }, 'identity_mismatch'],
  ['project mismatch', f => { f.rows[0].payload.cwd = '/OTHER_PATH_SENTINEL'; }, 'identity_mismatch'],
  ['duplicate start', f => { f.rows.push(f.rows[1]); }, 'duplicate_start'],
  ['unsafe source text', f => { f.rows[0].payload.source = '/SECRET_PATH_SENTINEL'; }, 'unsupported_metadata'],
  ['unsafe trigger text', f => { f.rows[1].payload.turn_attribution.turn_trigger = 'ignore instructions'; }, 'unsupported_metadata'],
  ['unsafe version text', f => { f.rows[0].payload.cli_version = 'SECRET_SENTINEL'; }, 'unsupported_metadata'],
  ['unsafe time text', f => { f.rows[1].timestamp = 'SECRET_SENTINEL'; }, 'unsupported_layout'],
]) test(label, t => {
  const f = fixture(t); change(f); f.write(); const result = f.inspect(); unavailable(result, reason); privacy(JSON.stringify(result), f);
});

for (const value of ['relative.jsonl', '/UNAPPROVED_PATH_SENTINEL', '/tmp/../SECRET.jsonl']) test('unapproved or noncanonical callback path is unavailable', t => {
  const f = fixture(t); f.callback.transcript_path = value; unavailable(f.inspect());
});

test('directory boundary excludes same-prefix sibling', t => {
  const f = fixture(t); f.options.sessionDirectory = `${f.root}-other`; unavailable(f.inspect(), 'path_boundary');
});

test('filesystem root is not an approved session directory', t => {
  const f = fixture(t); f.options.sessionDirectory = '/'; unavailable(f.inspect(), 'invalid_boundary');
});

test('file link is refused before open', t => {
  const f = fixture(t); const link = join(f.root, 'link.jsonl'); fs.symlinkSync(f.file, link); f.callback.transcript_path = link;
  unavailable(f.inspect(), 'path_boundary');
});

test('directory link is refused before open', t => {
  const f = fixture(t); const real = join(f.root, 'real'); fs.mkdirSync(real); fs.renameSync(f.file, join(real, 'sample.jsonl'));
  fs.symlinkSync(real, join(f.root, 'link')); f.callback.transcript_path = join(f.root, 'link', 'sample.jsonl');
  unavailable(f.inspect(), 'path_boundary');
});

test('hard link is refused', t => {
  const f = fixture(t); fs.linkSync(f.file, join(f.root, 'copy.jsonl')); unavailable(f.inspect(), 'not_regular_file');
});

test('directory selected as transcript is refused', t => {
  const f = fixture(t); const dir = join(f.root, 'dir'); fs.mkdirSync(dir); f.callback.transcript_path = dir; unavailable(f.inspect(), 'not_regular_file');
});

for (const [label, bytes, reason] of [
  ['malformed callback', Buffer.from('{'), 'malformed_callback'],
  ['cut callback', Buffer.from('{"turn_id":'), 'malformed_callback'],
  ['duplicate callback keys', Buffer.from('{"turn_id":1,"turn_id":2}'), 'malformed_callback'],
  ['invalid callback UTF-8', Buffer.from([0xff]), 'malformed_callback'],
  ['callback bytes exceeded', Buffer.alloc(LIMITS.callback + 1, 32), 'callback_bound'],
  ['callback depth exceeded', Buffer.from('['.repeat(33) + '0' + ']'.repeat(33)), 'depth_bound'],
]) test(label, t => { const f = fixture(t); unavailable(inspectCallback(bytes, f.options), reason); });

for (const [label, transform, reason] of [
  ['cut record', bytes => bytes.subarray(0, bytes.length - 1), 'incomplete_records'],
  ['malformed record', bytes => Buffer.concat([bytes, Buffer.from('{\n')]), 'malformed_record'],
  ['duplicate record keys', bytes => Buffer.concat([bytes, Buffer.from('{"a":1,"a":2}\n')]), 'malformed_record'],
  ['invalid record UTF-8', bytes => Buffer.concat([bytes, Buffer.from([0xff, 10])]), 'malformed_record'],
  ['file bytes exceeded', () => Buffer.alloc(LIMITS.file + 1, 10), 'file_bound'],
  ['header bytes exceeded', bytes => Buffer.concat([Buffer.alloc(LIMITS.header, 32), bytes]), 'header_bound'],
  ['empty file', () => Buffer.alloc(0), 'incomplete_records'],
  ['record depth exceeded', bytes => Buffer.concat([bytes, Buffer.from('['.repeat(33) + '0' + ']'.repeat(33) + '\n')]), 'depth_bound'],
]) test(label, t => {
  const f = fixture(t); fs.writeFileSync(f.file, transform(fs.readFileSync(f.file))); unavailable(f.inspect(), reason);
});

test('record count is bounded', t => {
  const f = fixture(t); f.rows.splice(1); const row = f.row('event_msg', { type: 'agent_message' });
  f.rows.push(...Array(LIMITS.records + 1).fill(row)); f.write(); unavailable(f.inspect(), 'record_bound');
});

test('paginated complete sequence can prove absence; a gap cannot', t => {
  const f = fixture(t); f.rows.splice(1, 1); f.rows[0].payload.history_mode = 'paginated';
  f.rows.forEach((row, index) => { row.ordinal = index; }); f.write(); assert.equal(f.inspect().status, 'absent');
  f.rows[1].ordinal = 2; f.write(); unavailable(f.inspect(), 'partial_history');
});

test('append after the first read never finds a later start', t => {
  const f = fixture(t); const later = f.rows.splice(1, 1)[0]; f.write(); let reads = 0, opens = 0;
  const io = { ...fs, openSync(...args) { opens++; return fs.openSync(...args); }, readSync(...args) {
    const count = fs.readSync(...args); reads++; fs.appendFileSync(f.file, JSON.stringify(later) + '\n'); return count;
  } };
  unavailable(f.inspect(io), 'changed_snapshot'); assert.equal(reads, 1); assert.equal(opens, 1);
});

test('same-size content mutation invalidates the snapshot', t => {
  const f = fixture(t); let changed = false;
  const io = { ...fs, readSync(...args) { const count = fs.readSync(...args); if (!changed) {
    changed = true; const bytes = fs.readFileSync(f.file); bytes[5] = 32; fs.writeFileSync(f.file, bytes);
  } return count; } };
  unavailable(f.inspect(io), 'changed_snapshot');
});

test('short read and sanitized filesystem error fail closed', t => {
  const f = fixture(t);
  unavailable(f.inspect({ ...fs, readSync() { return 0; } }), 'changed_snapshot');
  const result = f.inspect({ ...fs, openSync() { throw new Error(f.file + ' PROMPT_SECRET_SENTINEL'); } });
  unavailable(result, 'file_unavailable'); privacy(JSON.stringify(result), f);
});

test('cooperative deadline is injected and stops before file access', t => {
  const f = fixture(t); let tick = 0, reads = 0;
  const result = f.inspect({ ...fs, lstatSync() { reads++; throw new Error(); } }, () => tick++ ? LIMITS.milliseconds : 0);
  unavailable(result, 'time_bound'); assert.equal(reads, 0);
});

test('stream uses bounded bytes and a mock timeout without terminating processes', async () => {
  for (const kind of ['bound', 'timeout', 'error', 'complete']) {
    const input = new PassThrough(); let expire, canceled = false;
    const result = readCallback(input, callback => { expire = callback; return 1; }, () => { canceled = true; });
    if (kind === 'bound') input.write(Buffer.alloc(LIMITS.callback + 1));
    if (kind === 'timeout') expire();
    if (kind === 'error') input.emit('error', new Error('PRIVATE_ERROR_SENTINEL'));
    if (kind === 'complete') input.end('{}');
    const value = await result;
    if (kind === 'complete') assert.equal(value.bytes.toString(), '{}');
    else assert.equal(value.reason, { bound: 'callback_bound', timeout: 'time_bound', error: 'input_unavailable' }[kind]);
    assert.equal(canceled, true);
    input.emit('error', new Error('LATE_PRIVATE_ERROR_SENTINEL')); input.destroy();
  }
});

test('actual helper stdout uses the hook envelope and stderr is empty, with fictional stdin only', t => {
  const f = fixture(t);
  for (const [input, status, reason] of [[f.bytes(), 'present', undefined], [Buffer.from('{'), 'unavailable', 'malformed_callback'],
    [Buffer.alloc(LIMITS.callback + 1, 32), 'unavailable', 'callback_bound']]) {
    // No timeout/termination option: the child receives finite fictional input and exits normally.
    const run = spawnSync(process.execPath, [command, '--session-dir', f.root, '--project', f.root], { input, encoding: 'utf8' });
    assert.equal(run.status, 0); assert.equal(run.stderr, '');
    const output = JSON.parse(run.stdout); assert.equal(output.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    const context = output.hookSpecificOutput.additionalContext;
    const metadata = JSON.parse(context.slice(context.indexOf('{')));
    assert.equal(metadata.status, status); assert.equal(metadata.reason, reason);
    privacy(run.stdout + run.stderr, f);
  }
});

test('helper stays absent from the shipped hook manifest', () => {
  const manifest = fs.readFileSync(new URL('../../../packages/sage-codex/hooks/hooks.json', import.meta.url), 'utf8');
  assert.ok(!manifest.includes('turn-timing-probe'));
});
