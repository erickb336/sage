import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const child = '22222222-2222-4222-8222-222222222222';
const turn = '33333333-3333-4333-8333-333333333333';
const text = 'Saved role and task';
const hash = value => createHash('sha256').update(value).digest('hex');
const expected = { child, turn, taskHash: hash(text) };
function fixture(message = text) {
  const value = { decision: 'current-assignment', assignment: '44444444-4444-4444-8444-444444444444',
    preparation: '55555555-5555-4555-8555-555555555555', task: 'T1', run: 'R1', role: 'lead',
    child, turn, taskHash: hash(message), message };
  const output = [{ type: 'input_text', text: 'Wall time: 0.01 seconds\nOutput:' }, { type: 'input_text', text: JSON.stringify(value) }];
  const budget = output.reduce((sum, item) => sum + Math.ceil(Buffer.byteLength(item.text) / 4), 0);
  const row = { type: 'response_item', metadata: { client_authored: false, fallback_token_limit_override: budget,
    mcp_attribution: { status: 'complete', sources: [{ server_name: 'sage_preparation', tool_name: 'sage_read_assignment', first_turn_id: turn }] } },
    payload: { type: 'function_call_output', id: 'fco_recovery', call_id: 'recovery', output,
      internal_chat_message_metadata_passthrough: { turn_id: turn } } };
  return { row, value, budget };
}
function nativeCall() {
  return { type: 'response_item', metadata: { client_authored: false }, payload: {
    type: 'function_call', namespace: 'mcp__sage_preparation', name: 'sage_read_assignment',
    call_id: 'recovery', arguments: '{}', internal_chat_message_metadata_passthrough: { turn_id: turn } } };
}
const load = async () => {
  const { readRecoveryOutput } = await import('./recovery-output.mjs');
  return (row, target, call = nativeCall()) => readRecoveryOutput(row, target, call);
};

test('recovery output accepts an exact native assignment only when every text item fits replay', async () => {
  const read = await load(), { row, budget } = fixture();
  assert.equal(read(row, expected), text);
  row.metadata.fallback_token_limit_override = budget - 1;
  assert.throws(() => read(row, expected), /recovery output is unavailable/);
  row.metadata.fallback_token_limit_override = budget + 1;
  assert.equal(read(row, expected), text);
});

test('recovery output uses UTF-8 and rounds each content item independently', async () => {
  const read = await load();
  for (const message of ['é漢🙂', 'a'.repeat(4001)]) {
    const { row, budget } = fixture(message), target = { ...expected, taskHash: hash(message) };
    assert.equal(read(row, target), message);
    row.metadata.fallback_token_limit_override = budget - 1;
    assert.throws(() => read(row, target));
  }
  const { row } = fixture();
  row.payload.output[0].text = 'x';
  if (Buffer.byteLength(row.payload.output[1].text) % 4 === 0) row.payload.output[1].text += ' ';
  const byteTotal = row.payload.output.reduce((sum, item) => sum + Buffer.byteLength(item.text), 0);
  const itemCost = row.payload.output.reduce((sum, item) => sum + Math.ceil(Buffer.byteLength(item.text) / 4), 0);
  assert(itemCost > Math.ceil(byteTotal / 4));
  row.metadata.fallback_token_limit_override = itemCost;
  assert.equal(read(row, expected), text);
  row.metadata.fallback_token_limit_override = Math.ceil(byteTotal / 4);
  assert.throws(() => read(row, expected));
});

test('recovery output refuses missing budgets, foreign provenance, unsupported shapes and private errors', async () => {
  const read = await load();
  const changes = [
    r => { delete r.metadata.fallback_token_limit_override; },
    r => { r.metadata.fallback_token_limit_override = 0; },
    r => { r.metadata.fallback_token_limit_override = 1.5; },
    r => { r.metadata.fallback_token_limit_override = Number.MAX_SAFE_INTEGER + 1; },
    r => { r.metadata.client_authored = true; },
    r => { r.payload.internal_chat_message_metadata_passthrough.turn_id = child; },
    r => { r.payload.output = JSON.stringify(fixture().value); },
    r => { r.payload.output[0] = { type: 'input_image', image: 'private' }; },
    r => { r.payload.output[0].text = ''; },
    r => { r.payload.output[0].text = '\ud800'; },
    r => { r.payload.output[0].extra = 'private'; },
    r => { r.metadata.retained_source = null; },
  ];
  for (const change of changes) {
    const { row } = fixture(); change(row);
    assert.throws(() => read(row, expected), { message: 'Codex recovery output is unavailable' });
  }
});

test('recovery output refuses changed or shortened assignments even when the result fits its budget', async () => {
  const read = await load();
  for (const changes of [{ message: 'shortened' }, { taskHash: '0'.repeat(64) }, { child: turn }, { turn: child },
    { decision: 'error' }, { extra: 'private' }, { assignment: 'invalid' }, { task: '' }]) {
    const { row, value } = fixture();
    row.payload.output[1].text = JSON.stringify({ ...value, ...changes });
    row.metadata.fallback_token_limit_override = 3000;
    assert.throws(() => read(row, expected), { message: 'Codex recovery output is unavailable' });
  }
  const { row, value } = fixture();
  row.payload.output[1].text = JSON.stringify({ ...value, message: 'shortened', taskHash: hash('shortened') });
  row.metadata.fallback_token_limit_override = 3000;
  assert.throws(() => read(row, expected));
  assert.equal(read(fixture().row, expected), text);
});


test('recovery output requires the exact native reader call, not cumulative MCP attribution', async () => {
  const read = await load(), { row } = fixture();
  delete row.metadata.mcp_attribution;
  assert.equal(read(row, expected), text);
  row.metadata.mcp_attribution = { status: 'complete', sources: [
    { server_name: 'another_server', tool_name: 'another_tool', first_turn_id: child },
    { server_name: 'sage_preparation', tool_name: 'sage_read_assignment', first_turn_id: child }] };
  assert.equal(read(row, expected), text, 'cumulative sources do not identify this call');
  for (const change of [c => { c.metadata.client_authored = true; },
    c => { c.metadata.retained_source = null; }, c => { c.type = 'event_msg'; },
    c => { c.payload.namespace = 'other'; }, c => { c.payload.name = 'other'; },
    c => { c.payload.call_id = 'other'; }, c => { c.payload.type = 'function_call_output'; },
    c => { c.payload.arguments = '{"task":"T2"}'; }, c => { c.payload.arguments = 'null'; },
    c => { c.payload.internal_chat_message_metadata_passthrough.turn_id = child; }]) {
    const call = nativeCall(); change(call);
    assert.throws(() => read(row, expected, call), { message: 'Codex recovery output is unavailable' });
  }
  assert.throws(() => read(row, expected, null));
});
