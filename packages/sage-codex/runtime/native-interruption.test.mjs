import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as identity from './identity.mjs';
const session = '11111111-1111-4111-8111-111111111111';
const child = '22222222-2222-4222-8222-222222222222';
const turn = '33333333-3333-4333-8333-333333333333';
const later = '44444444-4444-4444-8444-444444444444';
const task = 'Fixed interruption fixture';
const expected = { session, child, parent: session, path: '/root/worker', author: '/root', turn,
  taskHash: createHash('sha256').update(task).digest('hex') };
const event = payload => ({ type: 'event_msg', payload });
const records = () => [
  { type: 'session_meta', payload: { id: child, session_id: session, parent_thread_id: session, agent_path: '/root/worker', cli_version: '0.160.0' } },
  event({ type: 'task_started', turn_id: turn }),
  { type: 'turn_context', payload: { turn_id: turn } },
  { type: 'response_item', payload: { type: 'agent_message', id: 'amsg_fixture', author: '/root', recipient: '/root/worker', content: [{ type: 'encrypted_content', encrypted_content: task }] } },
  event({ type: 'turn_aborted', turn_id: turn, reason: 'interrupted', started_at: 1, completed_at: 2, duration_ms: 1000 }),
];
function fixture(t) {
  assert.equal(typeof identity.readNativeInterruption, 'function');
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'sage-interruption-'))), file = join(dir, 'child.jsonl');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const save = rows => writeFileSync(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  save(records());
  return { dir, file, save, read: (value = expected) => identity.readNativeInterruption(file, { sessionsDir: dir }, value) };
}
test('native interruption verifies one exact assigned turn and preserves evidence across later turns', t => {
  const f = fixture(t), before = readFileSync(f.file, 'utf8'), receipt = f.read();
  assert.deepEqual({ ...receipt, evidenceHash: undefined }, { session, child, turn, message: 'amsg_fixture', taskHash: expected.taskHash, reason: 'interrupted', evidenceHash: undefined });
  assert.match(receipt.evidenceHash, /^[0-9a-f]{64}$/);
  assert.deepEqual(f.read(), receipt);
  assert.equal(readFileSync(f.file, 'utf8'), before);
  f.save([...records(), event({ type: 'task_started', turn_id: later }), { type: 'turn_context', payload: { turn_id: later } }]);
  assert.deepEqual(f.read(), receipt);
  assert.throws(() => f.read({ ...expected, turn: later }), /interruption evidence is unavailable/);
});
test('native interruption distinguishes unfinished work from an unsupported or conflicting terminal event', t => {
  const f = fixture(t);
  f.save(records().slice(0, -1)); assert.equal(f.read(), null);
  for (const mutate of [
    rows => rows[4].payload.reason = 'replaced', rows => rows[4].payload.reason = 'budget_limited',
    rows => rows[4].payload.reason = 'review_ended', rows => rows[4].payload.turn_id = null,
    rows => rows[4].payload.turn_id = later, rows => rows.push(structuredClone(rows[4])),
    rows => rows.splice(3, 0, rows.pop()),
    rows => rows.push(event({ type: 'task_complete', turn_id: turn })),
    rows => rows.splice(4, 0, event({ type: 'task_complete', turn_id: turn })),
    rows => rows.push({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [] } }),
    rows => rows.splice(4, 0, event({ type: 'task_started', turn_id: later })),
    rows => { rows.pop(); rows.push(event({ type: 'task_started', turn_id: later })); },
  ]) {
    const rows = records(); mutate(rows); f.save(rows);
    assert.throws(() => f.read(), /interruption evidence is unavailable/);
  }
});
test('native interruption refuses changed identity task delivery and unsafe transcript paths', t => {
  const f = fixture(t);
  for (const patch of [{ session: later }, { child: later }, { parent: later }, { path: '/root/other' },
    { author: '/root/other' }, { taskHash: '0'.repeat(64) }, { extra: true }])
    assert.throws(() => f.read({ ...expected, ...patch }), /interruption evidence is unavailable/);
  for (const mutate of [rows => rows[0].payload.cli_version = '0.0.0', rows => rows[3].payload.author = '/root/other',
    rows => rows.splice(4, 0, structuredClone(rows[3]))]) {
    const rows = records(); mutate(rows); f.save(rows); assert.throws(() => f.read(), /interruption evidence is unavailable/);
  }
  f.save(records());
  const link = join(f.dir, 'linked.jsonl'); symlinkSync(f.file, link);
  assert.throws(() => identity.readNativeInterruption(link, { sessionsDir: f.dir }, expected), /interruption evidence is unavailable/);
  writeFileSync(f.file, readFileSync(f.file, 'utf8').trimEnd());
  assert.throws(() => f.read(), /interruption evidence is unavailable/);
});
