import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as identity from './identity.mjs';

const session = '11111111-1111-4111-8111-111111111111';
const turn = '22222222-2222-4222-8222-222222222222';
const child = '33333333-3333-4333-8333-333333333333';
const other = '44444444-4444-4444-8444-444444444444';
const message = 'Continue the fixed task.';
const expected = { session, actor: session, parent: null, path: '/root', turn, call: 'followup_1',
  target: '/root/worker', taskHash: createHash('sha256').update(message).digest('hex') };
const response = payload => ({ type: 'response_item', metadata: { client_authored: false },
  payload: { ...payload, internal_chat_message_metadata_passthrough: { turn_id: turn } } });
const rows = () => [
  { type: 'session_meta', payload: { id: session, session_id: session, cli_version: '0.160.0' } },
  { type: 'event_msg', payload: { type: 'task_started', turn_id: turn } },
  { type: 'turn_context', payload: { turn_id: turn } },
  response({ type: 'function_call', namespace: 'collaboration', name: 'followup_task', call_id: expected.call,
    arguments: JSON.stringify({ target: expected.target, message }) }),
  response({ type: 'function_call_output', id: 'fco_fixed', call_id: expected.call, output: '' }),
];
function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sage-followup-reader-'))), path = join(root, 'native.jsonl');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const save = value => writeFileSync(path, value.map(row => JSON.stringify(row)).join('\n') + '\n');
  save(rows());
  return { root, path, save, read: (match = expected) => identity.readNativeFollowup(path, { sessionsDir: root }, match) };
}

test('native follow-up receipt proves an exact root or child dispatch and remains readable after later turns', t => {
  const f = fixture(t), receipt = f.read();
  assert.deepEqual({ ...receipt, evidenceHash: undefined }, { call: expected.call, turn, target: expected.target,
    taskHash: expected.taskHash, resultMessage: 'fco_fixed', evidenceHash: undefined });
  assert.match(receipt.evidenceHash, /^[0-9a-f]{64}$/);
  assert.deepEqual(f.read(), receipt);
  const history = rows();
  history.push({ type: 'event_msg', payload: { type: 'task_complete', turn_id: turn } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: other } },
    { type: 'turn_context', payload: { turn_id: other } });
  f.save(history); assert.deepEqual(f.read(), receipt);
  const nested = rows(); nested[0].payload = { ...nested[0].payload, id: child, parent_thread_id: session, agent_path: '/root/lead' };
  f.save(nested);
  assert.equal(f.read({ ...expected, actor: child, parent: session, path: '/root/lead' }).resultMessage, 'fco_fixed');
  nested[0].payload.parent_thread_id = child; f.save(nested);
  assert.throws(() => f.read({ ...expected, actor: child, parent: child, path: '/root/lead' }), /follow-up evidence is unavailable/);
});

test('native follow-up receipt rejects altered identity message target and native provenance', t => {
  const f = fixture(t); assert.equal(f.read().resultMessage, 'fco_fixed');
  for (const patch of [{ session: other }, { actor: other }, { turn: other }, { call: 'other' }, { target: 'worker' },
    { taskHash: '0'.repeat(64) }, { parent: child }, { path: '/root/lead' }, { extra: true }])
    assert.throws(() => f.read({ ...expected, ...patch }), /follow-up evidence is unavailable/);
  for (const mutate of [r => r[0].payload.cli_version = 'unknown', r => r[0].payload.agent_path = '/root',
    r => r[3].metadata.client_authored = true, r => delete r[4].metadata,
    r => r[3].payload.name = 'send_message', r => r[3].payload.namespace = 'functions',
    r => r[3].payload.arguments = JSON.stringify({ target: expected.target, message: 'different' }),
    r => r[3].payload.arguments = JSON.stringify({ target: expected.target, message, extra: true }),
    r => r[4].payload.internal_chat_message_metadata_passthrough.turn_id = other,
    r => r[4].payload.id = 'untrusted', r => r.splice(2, 1), r => r.push(structuredClone(r[0]))]) {
    const value = rows(); mutate(value); f.save(value);
    assert.throws(() => f.read(), /follow-up evidence is unavailable/);
  }
});

test('native follow-up receipt distinguishes pending calls from success and refuses duplicate or late results', t => {
  const f = fixture(t); assert.equal(f.read().resultMessage, 'fco_fixed');
  f.save(rows().slice(0, -1)); assert.equal(f.read(), null);
  for (const mutate of [r => r[4].payload.output = 'failed', r => r[4].payload.output = null,
    r => r.push(structuredClone(r[3])), r => r.push(structuredClone(r[4])),
    r => r.splice(3, 0, structuredClone(r[4])), r => r.splice(4, 0, { type: 'event_msg', payload: { type: 'task_complete', turn_id: turn } }),
    r => r.splice(4, 0, { type: 'event_msg', payload: { type: 'task_started', turn_id: other } }),
    r => r.splice(3, 1)]) {
    const value = rows(); mutate(value); f.save(value);
    assert.throws(() => f.read(), /follow-up evidence is unavailable/);
  }
});

test('native follow-up receipt refuses linked incomplete and out-of-root transcripts', t => {
  const f = fixture(t); assert.equal(f.read().resultMessage, 'fco_fixed');
  const link = join(f.root, 'linked.jsonl'); symlinkSync(f.path, link);
  assert.throws(() => identity.readNativeFollowup(link, { sessionsDir: f.root }, expected), /follow-up evidence is unavailable/);
  assert.throws(() => identity.readNativeFollowup(f.path, { sessionsDir: join(f.root, 'elsewhere') }, expected), /follow-up evidence is unavailable/);
  writeFileSync(f.path, JSON.stringify(rows()[0])); assert.throws(() => f.read(), /follow-up evidence is unavailable/);
});

test('native follow-up pending evidence cannot revive an ended or superseded sender turn', t => {
  const f = fixture(t); assert.equal(f.read().resultMessage, 'fco_fixed');
  f.save(rows().slice(0, -1)); assert.equal(f.read(), null);
  for (const tail of [
    [{ type: 'event_msg', payload: { type: 'task_complete', turn_id: turn } }],
    [{ type: 'event_msg', payload: { type: 'task_started', turn_id: other } }, { type: 'turn_context', payload: { turn_id: other } }],
  ]) {
    f.save([...rows().slice(0, -1), ...tail]);
    assert.throws(() => f.read(), /follow-up evidence is unavailable/);
  }
});
