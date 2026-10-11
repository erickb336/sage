import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as identity from './identity.mjs';

const session = '11111111-1111-4111-8111-111111111111';
const child = '22222222-2222-4222-8222-222222222222';
const turn = '33333333-3333-4333-8333-333333333333';
const later = '44444444-4444-4444-8444-444444444444';
const hash = text => createHash('sha256').update(text).digest('hex');
const metadata = { id: child, session_id: session, parent_thread_id: session, agent_path: '/root/worker', cli_version: '0.160.0' };
const message = (text, id) => ({ type: 'response_item', payload: { type: 'agent_message', id,
  author: '/root', recipient: '/root/worker', content: [ { type: 'input_text', text: 'Native task header' }, { type: 'encrypted_content', encrypted_content: text } ] } });
const task = (id, text) => [ { type: 'event_msg', payload: { type: 'task_started', turn_id: id } },
  { type: 'turn_context', payload: { turn_id: id } }, message(text, `amsg_${id}`) ];
const expected = (id = turn, text = 'first') => ({ session, child, parent: session, path: '/root/worker', author: '/root', turn: id, taskHash: hash(text) });
function fixture(t) {
  assert.equal(typeof identity.readAssignmentTurn, 'function');
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sage-assignment-turn-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sessionsDir = join(root, 'sessions'); mkdirSync(sessionsDir);
  const file = join(sessionsDir, 'child.jsonl');
  const write = (rows, header = metadata) => writeFileSync(file, [{ type: 'session_meta', payload: header }, ...rows].map(row => JSON.stringify(row) + '\n').join(''));
  return { root, file, sessionsDir, write, read: (wanted = expected(), path = file) => identity.readAssignmentTurn(path, { sessionsDir }, wanted) };
}

test('assignment evidence binds initial and follow-up messages to their exact child turns', t => {
  const f = fixture(t); f.write([...task(turn, 'first'), ...task(later, 'second')]);
  assert.deepEqual(f.read(), { session, child, turn, message: `amsg_${turn}`, taskHash: hash('first') });
  assert.equal(f.read(expected(later, 'second')).turn, later);
  assert.throws(() => f.read(expected(turn, 'second')), /assignment evidence is unavailable/);
});

test('assignment evidence rejects another transcript, sender, recipient, or runtime', t => {
  const f = fixture(t);
  for (const change of [{ id: session }, { session_id: child }, { parent_thread_id: child }, { agent_path: '/root/other' }, { cli_version: '0.159.2' }]) {
    f.write(task(turn, 'first'), { ...metadata, ...change }); assert.throws(() => f.read(), /assignment evidence is unavailable/);
  }
  for (const change of [{ author: '/root/other' }, { recipient: '/root/other' }]) {
    const rows = task(turn, 'first'); Object.assign(rows[2].payload, change);
    f.write(rows); assert.throws(() => f.read(), /assignment evidence is unavailable/);
  }
});

test('assignment evidence rejects reused messages, missing context and conflicting turns', t => {
  const f = fixture(t);
  for (const rows of [task(turn, 'other'), [...task(turn, 'first'), ...task(later, 'first')],
    [message('first', 'amsg_orphan')], [task(turn, 'first')[0], message('first', 'amsg_orphan')],
    [task(turn, 'first')[0], { type: 'turn_context', payload: { turn_id: later } }, message('first', 'amsg_wrong')]]) {
    f.write(rows); assert.throws(() => f.read(), /assignment evidence is unavailable/);
  }
});

test('assignment evidence refuses linked, partial, malformed and oversized transcript snapshots', t => {
  const f = fixture(t); f.write(task(turn, 'first'));
  const linked = join(f.sessionsDir, 'linked.jsonl'); symlinkSync(f.file, linked);
  assert.throws(() => f.read(expected(), linked), /assignment evidence is unavailable/);
  const complete = [{ type: 'session_meta', payload: metadata }, ...task(turn, 'first')].map(row => JSON.stringify(row) + '\n').join('');
  for (const bytes of [complete + '{', complete + 'not json\n', '{}', 'not json\n', Buffer.from([0xff, 10]), ' '.repeat(16 * 1024 * 1024 + 1)]) {
    writeFileSync(f.file, bytes); assert.throws(() => f.read(), /assignment evidence is unavailable/);
  }
});


test('assignment evidence ignores result notifications without accepting them as task delivery', t => {
  const f = fixture(t);
  const notification = { type: 'response_item', payload: { type: 'agent_message', id: 'amsg_result',
    author: '/root/worker/reviewer', recipient: '/root/worker', content: [{ type: 'input_text',
      text: 'Message Type: FINAL_ANSWER\nTask name: /root/worker\nSender: /root/worker/reviewer\nPayload:\nreview complete' }] } };
  f.write([...task(turn, 'first'), notification]);
  assert.equal(f.read().taskHash, hash('first'));
  const forged = structuredClone(notification);
  forged.payload.author = '/root'; forged.payload.content[0].text = 'first';
  f.write([task(turn, 'first')[0], task(turn, 'first')[1], forged]);
  assert.throws(() => f.read(), /assignment evidence is unavailable/);
  const malformed = message('first', 'amsg_malformed');
  malformed.payload.content.push({ type: 'encrypted_content', encrypted_content: 'first' });
  f.write([...task(turn, 'first'), malformed]);
  assert.throws(() => f.read(), /assignment evidence is unavailable/);
});
