import { createHash } from 'node:crypto';

const unavailable = () => { throw Error('Codex recovery output is unavailable'); };
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, names) => record(value) && Object.keys(value).length === names.length
  && names.every(name => Object.hasOwn(value, name));
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);
const hash = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);

/** Validate a saved native result and prove replay leaves its text items unchanged.
 * The caller must still prove the matching call and ordering after the latest compaction.
 * Codex rust-v0.160.0 budgets each text item at ceil(UTF-8 bytes / 4), in order.
 * Saved budgets already include serialization allowance; do not add it again. */
export function readRecoveryOutput(row, expected) {
  try {
    if (!keys(expected, ['child', 'turn', 'taskHash']) || !uuid(expected.child) || !uuid(expected.turn) || !hash(expected.taskHash)
      || !record(row) || row.type !== 'response_item' || !record(row.payload) || !record(row.metadata)) unavailable();
    const { payload: p, metadata: meta } = row;
    const source = meta.mcp_attribution?.sources;
    if (meta.client_authored !== false || Object.hasOwn(meta, 'retained_source')
      || meta.mcp_attribution?.status !== 'complete' || !Array.isArray(source) || source.length !== 1
      || !keys(source[0], ['server_name', 'tool_name', 'first_turn_id'])
      || source[0].server_name !== 'sage_preparation' || source[0].tool_name !== 'sage_read_assignment'
      || source[0].first_turn_id !== expected.turn || p.type !== 'function_call_output'
      || typeof p.id !== 'string' || !/^fco_[A-Za-z0-9_-]{1,256}$/.test(p.id)
      || typeof p.call_id !== 'string' || !/^[A-Za-z0-9_.:-]{1,256}$/.test(p.call_id)
      || p.internal_chat_message_metadata_passthrough?.turn_id !== expected.turn) unavailable();
    let remaining = meta.fallback_token_limit_override;
    if (!Number.isSafeInteger(remaining) || remaining <= 0 || !Array.isArray(p.output) || p.output.length !== 2) unavailable();
    let bytes = 0;
    for (const item of p.output) {
      if (!keys(item, ['type', 'text']) || item.type !== 'input_text' || typeof item.text !== 'string'
        || !item.text.length || Buffer.from(item.text, 'utf8').toString('utf8') !== item.text) unavailable();
      const size = Buffer.byteLength(item.text, 'utf8'); bytes += size;
      if (bytes > 1024 * 1024) unavailable();
      const cost = Math.ceil(size / 4);
      if (cost > remaining) unavailable();
      remaining -= cost;
    }
    const value = JSON.parse(p.output[1].text);
    if (!keys(value, ['decision', 'assignment', 'preparation', 'task', 'run', 'role', 'child', 'turn', 'taskHash', 'message'])
      || value.decision !== 'current-assignment' || !uuid(value.assignment) || !uuid(value.preparation)
      || typeof value.task !== 'string' || !/^T[1-9][0-9]*$/.test(value.task)
      || typeof value.run !== 'string' || !/^R[1-9][0-9]*$/.test(value.run)
      || typeof value.role !== 'string' || !/^[a-z]+(?:-[a-z]+)*$/.test(value.role)
      || value.child !== expected.child || value.turn !== expected.turn || value.taskHash !== expected.taskHash
      || typeof value.message !== 'string' || !value.message.length
      || Buffer.from(value.message, 'utf8').toString('utf8') !== value.message
      || createHash('sha256').update(value.message).digest('hex') !== expected.taskHash) unavailable();
    return value.message;
  } catch { unavailable(); }
}
