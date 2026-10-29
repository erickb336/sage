// SAMPLE DATA ONLY. This demonstration creates and removes its own fixture directory.
import { mkdtempSync, realpathSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'sage-trigger-sample-')));
try {
  const session = '11111111-1111-4111-8111-111111111111';
  const turn = '22222222-2222-4222-8222-222222222222';
  const other = '33333333-3333-4333-8333-333333333333';
  const path = join(root, 'sample.jsonl');
  const row = (type, payload) => ({ timestamp: '2026-10-28T00:00:00.000Z', type, payload });
  const rows = [row('session_meta', { id: session, session_id: session, cwd: root, cli_version: '0.164.0', source: 'cli' }),
    row('event_msg', { type: 'task_started', turn_id: turn, root_turn_id: turn, model_context_window: 1000, collaboration_mode_kind: 'default',
      turn_attribution: { turn_id: turn, root_turn_id: turn, turn_trigger: 'user', parent_turn_id: null, initiating_agent_path: null } })];
  const callback = { hook_event_name: 'UserPromptSubmit', session_id: session, turn_id: turn, cwd: root,
    transcript_path: path, prompt: 'SAMPLE DATA', model: 'sample', permission_mode: 'default' };
  const command = fileURLToPath(new URL('../../../packages/sage-codex/hooks/turn-trigger-observer.mjs', import.meta.url));
  const samples = [
    ['root start', rows, { status: 'observed', trigger: 'user',
      matches: { session: true, root: true, project: true, turn: true, attribution: true } }],
    ['completed turn', [...rows, row('event_msg', { type: 'task_complete', turn_id: turn })],
      { status: 'unavailable', reason: 'terminal_evidence' }],
    ['conflicting context root', [...rows, row('turn_context', { turn_id: turn, root_turn_id: other, cwd: root })],
      { status: 'unavailable', reason: 'identity_mismatch' }],
    ['duplicate preceding terminal', [rows[0], ...[1, 2].map(() => row('event_msg', { type: 'task_complete', turn_id: other })), rows[1]],
      { status: 'unavailable', reason: 'terminal_evidence' }],
    ['malformed user event', [...rows, row('event_msg', { type: 'user_message', message: 123, images: null, local_images: [] })],
      { status: 'unavailable', reason: 'unsupported_layout' }],
  ];
  for (const [name, records, expected] of samples) {
    writeFileSync(path, records.map(value => JSON.stringify(value)).join('\n') + '\n');
    const result = spawnSync(process.execPath, [command, '--synthetic-root', root, '--project', root], {
      input: JSON.stringify(callback), encoding: 'utf8', timeout: 2000,
    });
    assert.equal(result.status, 0, result.stderr);
    const observed = JSON.parse(result.stdout);
    assert.deepEqual(observed, expected);
    console.log(`SAMPLE DATA — ${name}: ${JSON.stringify(observed)}`);
  }
} finally { rmSync(root, { recursive: true, force: true }); }
