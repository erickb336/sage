// SAMPLE DATA ONLY. All identifiers, paths, messages and times below are fictional.
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectCallback, envelope } from '../../../packages/sage-codex/hooks/turn-timing-probe.mjs';

export function makeSample() {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'sage-timing-fiction-')));
  const session = '11111111-1111-4111-8111-111111111111';
  const turn = '22222222-2222-4222-8222-222222222222';
  const other = '33333333-3333-4333-8333-333333333333';
  const file = join(root, 'PATH_SENTINEL.jsonl');
  const row = (type, payload) => ({ timestamp: '2026-11-03T10:00:00.000Z', type, payload });
  const rows = [row('session_meta', { id: session, session_id: session, cwd: root, source: 'vscode', cli_version: '0.165.0-alpha.1.2' }),
    row('event_msg', { type: 'task_started', turn_id: turn, root_turn_id: turn,
      turn_attribution: { turn_id: turn, root_turn_id: turn, turn_trigger: 'composer', parent_turn_id: null, initiating_agent_path: null } }),
    row('response_item', { type: 'message', content: 'MESSAGE_SECRET_SENTINEL' })];
  const callback = { hook_event_name: 'UserPromptSubmit', session_id: session, turn_id: turn,
    transcript_path: file, cwd: root, prompt: 'PROMPT_SECRET_SENTINEL', model: 'sample', permission_mode: 'default' };
  const options = { sessionDirectory: root, project: root };
  const write = () => fs.writeFileSync(file, rows.map(value => JSON.stringify(value)).join('\n') + '\n');
  const bytes = () => Buffer.from(JSON.stringify(callback));
  const inspect = (io, now) => inspectCallback(bytes(), options, io, now);
  const remove = () => fs.rmSync(root, { recursive: true, force: true });
  write();
  return { root, file, session, turn, other, row, rows, callback, options, write, bytes, inspect, remove };
}

// A complete fictional earlier turn followed by an ordinary or queued callback.
export function makeOrdinaryHistory(historyMode = 'legacy', trigger = 'composer') {
  const f = makeSample();
  const current = structuredClone(f.rows[1]);
  current.payload.turn_attribution.turn_trigger = trigger;
  const earlier = f.rows[1].payload;
  earlier.turn_id = f.other; earlier.root_turn_id = f.other;
  earlier.turn_attribution.turn_id = f.other; earlier.turn_attribution.root_turn_id = f.other;
  f.rows[0].payload.history_mode = historyMode;
  f.rows.push(
    f.row('world_state', { full: true, state: { sample: 'MESSAGE_SECRET_SENTINEL' } }),
    f.row('turn_context', { turn_id: f.other, root_turn_id: f.other, cwd: f.root }),
    f.row('event_msg', { type: 'thread_settings_applied', thread_id: f.session,
      thread_settings: { model: 'sample', cwd: f.root, sample: 'MESSAGE_SECRET_SENTINEL' } }),
    f.row('event_msg', { type: 'item_completed', thread_id: f.session, turn_id: f.other,
      item: historyMode === 'legacy'
        ? { type: 'Plan', id: 'fictional-item', text: 'MESSAGE_SECRET_SENTINEL' }
        : { type: 'UserMessage', id: 'fictional-item', content: [] }, completed_at_ms: 0 }),
    f.row('event_msg', { type: 'task_complete', turn_id: f.other }), current);
  const write = f.write;
  f.write = () => {
    if (historyMode === 'paginated') f.rows.forEach((row, ordinal) => { row.ordinal = ordinal; });
    write();
  };
  f.write();
  return f;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const sample = makeSample();
  try {
    console.log('SAMPLE DATA ONLY: no native callback or session was read. Interactive CLI metadata is unknown.');
    for (const trigger of ['composer', 'remote_ios', 'queue', 'exec']) {
      sample.rows[1].payload.turn_attribution.turn_trigger = trigger;
      sample.rows[0].payload.source = trigger === 'exec' ? 'exec' : 'vscode';
      sample.rows[0].payload.cli_version = trigger === 'exec' ? '0.164.0' : '0.165.0-alpha.1.2';
      sample.write();
      console.log(JSON.stringify({ sample: trigger, ...envelope(sample.inspect()) }));
    }
    sample.rows.splice(1, 1); sample.write();
    console.log(JSON.stringify({ sample: 'complete without matching start', ...envelope(sample.inspect()) }));
    fs.appendFileSync(sample.file, '{');
    console.log(JSON.stringify({ sample: 'incomplete final record', ...envelope(sample.inspect()) }));
  } finally { sample.remove(); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const mode of ['legacy', 'paginated']) for (const trigger of ['composer', 'queue']) {
    const sample = makeOrdinaryHistory(mode, trigger);
    try {
      console.log(JSON.stringify({ sample: `${mode} ordinary history / ${trigger}`, ...envelope(sample.inspect()) }));
      sample.rows.pop(); sample.write();
      console.log(JSON.stringify({ sample: `${mode} ordinary history / ${trigger} / no matching start`, ...envelope(sample.inspect()) }));
    } finally { sample.remove(); }
  }
}
