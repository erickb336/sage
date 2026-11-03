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
  const rows = [row('session_meta', { id: session, session_id: session, cwd: root, source: 'cli', cli_version: '0.164.0' }),
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const sample = makeSample();
  try {
    console.log('SAMPLE DATA ONLY: no native callback or session was read.');
    for (const trigger of ['composer', 'remote_ios', 'queue', 'exec']) {
      sample.rows[1].payload.turn_attribution.turn_trigger = trigger;
      sample.rows[0].payload.source = trigger === 'exec' ? 'exec' : 'cli';
      sample.write();
      console.log(JSON.stringify({ sample: trigger, ...envelope(sample.inspect()) }));
    }
    sample.rows.splice(1, 1); sample.write();
    console.log(JSON.stringify({ sample: 'complete without matching start', ...envelope(sample.inspect()) }));
    fs.appendFileSync(sample.file, '{');
    console.log(JSON.stringify({ sample: 'incomplete final record', ...envelope(sample.inspect()) }));
  } finally { sample.remove(); }
}
