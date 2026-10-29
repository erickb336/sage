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
  const path = join(root, 'sample.jsonl');
  const row = (type, payload) => ({ timestamp: '2026-10-28T00:00:00.000Z', type, payload });
  const rows = [row('session_meta', { id: session, session_id: session, cwd: root, cli_version: '0.164.0', source: 'cli' }),
    row('event_msg', { type: 'task_started', turn_id: turn, root_turn_id: turn, model_context_window: 1000, collaboration_mode_kind: 'default',
      turn_attribution: { turn_id: turn, root_turn_id: turn, turn_trigger: 'user', parent_turn_id: null, initiating_agent_path: null } })];
  const callback = { hook_event_name: 'UserPromptSubmit', session_id: session, turn_id: turn, cwd: root,
    transcript_path: path, prompt: 'SAMPLE DATA', model: 'sample', permission_mode: 'default' };
  const command = fileURLToPath(new URL('../../../packages/sage-codex/hooks/turn-trigger-observer.mjs', import.meta.url));
  for (const terminal of [false, true]) {
    if (terminal) rows.push(row('event_msg', { type: 'task_complete', turn_id: turn }));
    writeFileSync(path, rows.map(value => JSON.stringify(value)).join('\n') + '\n');
    const result = spawnSync(process.execPath, [command, '--synthetic-root', root, '--project', root], {
      input: JSON.stringify(callback), encoding: 'utf8', timeout: 2000,
    });
    assert.equal(result.status, 0, result.stderr);
    const observed = JSON.parse(result.stdout);
    assert.equal(observed.status, terminal ? 'unavailable' : 'observed');
    console.log(`SAMPLE DATA — ${terminal ? 'completed turn' : 'root start'}: ${JSON.stringify(observed)}`);
  }
} finally { rmSync(root, { recursive: true, force: true }); }
