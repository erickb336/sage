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


const output = (id, text, extra = {}) => ({ type: "response_item", payload: { type: "message", id: `msg_${id}`,
  role: "assistant", content: [{ type: "output_text", text }], internal_chat_message_metadata_passthrough: { turn_id: id }, ...extra },
  metadata: { client_authored: false, retained_source: { complete: true, id: { role: "assistant", turn_id: id, message_id: `msg_${id}` } } } });
const complete = (id, text) => ({ type: "event_msg", payload: { type: "task_complete", turn_id: id, last_agent_message: text } });

test("native report requires its exact completed turn and retained assistant message", t => {
  const f = fixture(t);
  assert.equal(typeof identity.readNativeReport, "function");
  f.write([...task(turn, "first"), output(turn, "first report"), complete(turn, "first report"),
    ...task(later, "second"), output(later, "second report"), complete(later, "second report")]);
  const read = expected => identity.readNativeReport(f.file, { sessionsDir: f.sessionsDir }, expected);
  assert.equal(read(expected()).text, "first report");
  assert.equal(read(expected(later, "second")).text, "second report");
  assert.equal(read(expected()).reportHash, hash("first report"));
  assert.throws(() => read(expected(turn, "second")), /report evidence is unavailable/);
});

test("native report rejects incomplete mismatched forged and duplicate terminal evidence", t => {
  const f = fixture(t);
  assert.equal(typeof identity.readNativeReport, "function");
  const valid = output(turn, "report");
  const forged = structuredClone(valid); forged.metadata.client_authored = true;
  const foreign = structuredClone(valid); foreign.metadata.retained_source.id.turn_id = later;
  const pending = structuredClone(valid); pending.metadata.retained_source.complete = false;
  const rows = [[], [valid], [complete(turn, "report")], [valid, complete(later, "report")],
    [valid, complete(turn, "other")], [valid, complete(turn, "report"), complete(turn, "report")],
    [valid, complete(turn, "report"), valid], [forged, complete(turn, "report")], [foreign, complete(turn, "report")],
    [pending, complete(turn, "report")], [output(turn, "report", { phase: "commentary" }), complete(turn, "report")],
    [output(turn, "report", { role: "user" }), complete(turn, "report")]];
  for (const suffix of rows) {
    f.write([...task(turn, "first"), ...suffix]);
    assert.throws(() => identity.readNativeReport(f.file, { sessionsDir: f.sessionsDir }, expected()), /report evidence is unavailable/);
  }
  const assigned = task(turn, "first");
  f.write([assigned[0], assigned[1], valid, complete(turn, "report"), assigned[2]]);
  assert.throws(() => identity.readNativeReport(f.file, { sessionsDir: f.sessionsDir }, expected()), /report evidence is unavailable/);
  f.write([...task(turn, "first"), valid, complete(turn, "report")]);
  const linked = join(f.sessionsDir, "report-link.jsonl"); symlinkSync(f.file, linked);
  assert.throws(() => identity.readNativeReport(linked, { sessionsDir: f.sessionsDir }, expected()), /report evidence is unavailable/);
});


test("native terminal evidence releases an invalid report without making that report readable", t => {
  const f = fixture(t);
  for (const text of ["", "x".repeat(33 * 1024), "bad\0report"]) {
    f.write([...task(turn, "first"), output(turn, text)]);
    assert.equal(identity.readNativeCompletion(f.file, { sessionsDir: f.sessionsDir }, expected()), null);
    f.write([...task(turn, "first"), output(turn, text), complete(turn, text)]);
    const evidence = identity.readNativeCompletion(f.file, { sessionsDir: f.sessionsDir }, expected());
    assert.equal(evidence.turn, turn); assert.equal(evidence.reportHash, hash(text));
    assert.throws(() => identity.readNativeReport(f.file, { sessionsDir: f.sessionsDir }, expected()), /report evidence is unavailable/);
  }
});
