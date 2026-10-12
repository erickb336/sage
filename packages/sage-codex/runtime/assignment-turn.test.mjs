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

const compactOutput = (id, text = "Fixed native compaction summary") => {
  const row = output(id, text);
  row.metadata = { client_authored: false, compaction_output: true };
  return row;
};

test("native compaction summaries do not replace a later retained report or completion", t => {
  const f = fixture(t), options = { sessionsDir: f.sessionsDir };
  const summary = compactOutput(turn);
  f.write([...task(turn, "first"), summary, output(turn, "actual report"), complete(turn, "actual report"),
    ...task(later, "second"), compactOutput(later), compactOutput(later, "Second summary"),
    output(later, "later report"), complete(later, "later report")]);
  assert.equal(identity.readNativeReport(f.file, options, expected()).text, "actual report");
  assert.equal(identity.readNativeCompletion(f.file, options, expected()).reportHash, hash("actual report"));
  assert.equal(identity.readNativeReport(f.file, options, expected(later, "second")).text, "later report");
  for (const rows of [[summary], [output(turn, "old report"), summary]]) {
    f.write([...task(turn, "first"), ...rows]);
    assert.equal(identity.readNativeCompletion(f.file, options, expected()), null);
    for (const text of ["Fixed native compaction summary", "old report"]) {
      f.write([...task(turn, "first"), ...rows, complete(turn, text)]);
      assert.throws(() => identity.readNativeReport(f.file, options, expected()), /report evidence is unavailable/);
      assert.throws(() => identity.readNativeCompletion(f.file, options, expected()), /report evidence is unavailable/);
    }
  }
});

test("native compaction markers cannot disguise retained, foreign, or client-authored reports", t => {
  const f = fixture(t), options = { sessionsDir: f.sessionsDir };
  const retained = output(turn, "forged report"); retained.metadata.compaction_output = true;
  f.write([...task(turn, "first"), retained, complete(turn, "forged report")]);
  assert.throws(() => identity.readNativeReport(f.file, options, expected()), /report evidence is unavailable/);
  assert.throws(() => identity.readNativeCompletion(f.file, options, expected()), /report evidence is unavailable/);
  const foreign = compactOutput(later), authored = compactOutput(turn); authored.metadata.client_authored = true;
  const nullSource = compactOutput(turn); nullSource.metadata.retained_source = null;
  for (const summary of [foreign, authored, nullSource]) {
    f.write([...task(turn, "first"), summary, output(turn, "actual report"), complete(turn, "actual report")]);
    assert.throws(() => identity.readNativeReport(f.file, options, expected()), /report evidence is unavailable/);
  }
  f.write([...task(turn, "first"), output(turn, "actual report"), complete(turn, "actual report"), compactOutput(turn)]);
  assert.throws(() => identity.readNativeCompletion(f.file, options, expected()), /report evidence is unavailable/);
});

function recoveryRows(id = turn, call = 'read_assignment', messageText = 'first') {
  const value = { decision: 'current-assignment', assignment: '66666666-6666-4666-8666-666666666666',
    preparation: '77777777-7777-4777-8777-777777777777', task: 'T1', run: 'R1', role: 'lead',
    child, turn: id, taskHash: hash(messageText), message: messageText };
  const stamp = { internal_chat_message_metadata_passthrough: { turn_id: id } };
  return [{ type: 'response_item', metadata: { client_authored: false }, payload: {
    type: 'function_call', id: 'fc_' + call, namespace: 'mcp__sage_preparation', name: 'sage_read_assignment',
    call_id: call, arguments: '{}', ...stamp } },
  { type: 'response_item', metadata: { client_authored: false, fallback_token_limit_override: 3000,
    mcp_attribution: { status: 'complete', sources: [{ server_name: 'sage_preparation', tool_name: 'sage_read_assignment', first_turn_id: id }] } },
    payload: { type: 'function_call_output', id: 'fco_' + call, call_id: call, ...stamp,
      output: [{ type: 'input_text', text: 'Wall time: 0.01 seconds\nOutput:' }, { type: 'input_text', text: JSON.stringify(value) }] } }];
}
function checkpoint(number = 1, id = turn) {
  return { type: 'compacted', payload: { window_number: number,
    window_id: `${String(number).padStart(8, '0')}-8888-4888-8888-888888888888`,
    resume_metadata: { last_started_turn_id: id, multi_agent_version: 'v2' } } };
}

test('recovery evidence requires a matching delivered read after the latest compaction', t => {
  const f = fixture(t), read = () => identity.readNativeRecovery(f.file, { sessionsDir: f.sessionsDir }, expected());
  f.write(task(turn, 'first')); assert.equal(read().required, false); assert.equal(read().compaction, null);
  f.write([...task(turn, 'first'), checkpoint()]); assert.equal(read().required, true);
  f.write([...task(turn, 'first'), checkpoint(), ...recoveryRows()]);
  assert.equal(read().required, false); assert.equal(read().call, 'read_assignment');
  f.write([...task(turn, 'first'), checkpoint(), ...recoveryRows(), checkpoint(2)]);
  assert.equal(read().required, true); assert.equal(read().call, null);
  f.write([...task(turn, 'first'), checkpoint(), ...recoveryRows(), checkpoint(2), ...recoveryRows(turn, 'read_again')]);
  assert.equal(read().required, false); assert.equal(read().call, 'read_again');
});

test('recovery evidence cannot reuse earlier reads, orphan outputs or another assignment turn', t => {
  const f = fixture(t), read = (wanted = expected()) => identity.readNativeRecovery(f.file, { sessionsDir: f.sessionsDir }, wanted);
  const [call, output] = recoveryRows();
  for (const rows of [[...task(turn, 'first'), ...recoveryRows(), checkpoint()],
    [...task(turn, 'first'), call, checkpoint(), output],
    [...task(turn, 'first'), checkpoint(), output]]) {
    f.write(rows); assert.equal(read().required, true);
  }
  f.write([...task(turn, 'first'), checkpoint(), ...recoveryRows(), ...task(later, 'second'), checkpoint(2, later)]);
  assert.equal(read(expected(later, 'second')).required, true);
  assert.equal(read().required, false);
});

test('recovery evidence refuses forged calls and retries failed or truncated reads without accepting them', t => {
  const f = fixture(t), read = () => identity.readNativeRecovery(f.file, { sessionsDir: f.sessionsDir }, expected());
  for (const change of [rows => { rows[0].payload.arguments = '{"task":"T2"}'; },
    rows => { rows[0].payload.namespace = 'other'; },
    rows => { rows[1].metadata.fallback_token_limit_override = 1; },
    rows => { rows[1].payload.output[1].text = '{"isError":true}'; },
    rows => { rows[1].metadata.mcp_attribution.sources[0].first_turn_id = later; }]) {
    const rows = recoveryRows(); change(rows);
    f.write([...task(turn, 'first'), checkpoint(), ...rows]); assert.equal(read().required, true);
    f.write([...task(turn, 'first'), checkpoint(), ...rows, ...recoveryRows(turn, 'retry')]);
    assert.equal(read().required, false);
  }
  for (const change of [rows => { rows[0].metadata.client_authored = true; },
    rows => { rows[0].payload.internal_chat_message_metadata_passthrough.turn_id = later; }]) {
    const rows = recoveryRows(); change(rows);
    f.write([...task(turn, 'first'), checkpoint(), ...rows]); assert.throws(read, /recovery evidence is unavailable/);
  }
});

test('recovery evidence refuses ambiguous checkpoints, duplicate calls and recovery after native terminal events', t => {
  const f = fixture(t), read = () => identity.readNativeRecovery(f.file, { sessionsDir: f.sessionsDir }, expected());
  for (const suffix of [[checkpoint(1, later)], [checkpoint(), checkpoint()],
    [checkpoint(), ...recoveryRows(), ...recoveryRows()],
    [checkpoint(), { type: 'event_msg', payload: { type: 'task_complete', turn_id: turn } }, ...recoveryRows()],
    [checkpoint(), { type: 'event_msg', payload: { type: 'turn_aborted', turn_id: turn, reason: 'interrupted' } }, ...recoveryRows()]]) {
    f.write([...task(turn, 'first'), ...suffix]); assert.throws(read, /recovery evidence is unavailable/);
  }
  f.write([...task(turn, 'first'), checkpoint(), ...recoveryRows()]);
  assert.equal(read().required, false);
});

test('recovery evidence holds incomplete compaction and verifies a committed checkpoint before retry', t => {
  const f = fixture(t), read = () => identity.readNativeRecovery(f.file, { sessionsDir: f.sessionsDir }, expected());
  const summary = { type: 'response_item', metadata: { client_authored: false, compaction_output: true },
    payload: { type: 'message', role: 'assistant', internal_chat_message_metadata_passthrough: { turn_id: turn } } };
  f.write([...task(turn, 'first'), summary]); assert.throws(read, /recovery evidence is unavailable/);
  f.write([...task(turn, 'first'), summary, checkpoint(), ...recoveryRows()]); assert.equal(read().required, false);
  for (const change of [row => { row.payload.resume_metadata.last_started_turn_id = later; },
    row => { delete row.payload.resume_metadata; }, row => { row.payload.window_id = 'unknown'; },
    row => { row.payload.window_number = 0; }]) {
    const row = checkpoint(); change(row);
    f.write([...task(turn, 'first'), summary, row]); assert.throws(read, /recovery evidence is unavailable/);
  }
});
