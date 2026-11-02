// The chief's row in chiefs.tsv depends on this fact: a Claude resume keeps one
// session id. The test runs the real CLI in a scratch home against a fake API,
// so it runs only on request: set SAGE_PROBE_CLAUDE=1 on a machine with the CLI.
// CI has no CLI, so a plain run skips it.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { probeResume } from './probe-claude-resume.mjs';

test('a Claude resume keeps one session id', { skip: process.env.SAGE_PROBE_CLAUDE !== '1' }, async () => {
  const result = await probeResume();
  assert.equal(result.live, true, result.reason);
  assert.deepEqual(result.starts.slice(0, 4), ['startup', 'resume', 'resume', 'resume']);
  assert.equal(result.resumedIds.length, 1);
  assert.equal(new Set(result.replies).size, 1);
  assert.equal(result.replies[0], result.resumedIds[0]);
  assert.equal(result.clearedIds.length > 0, true);
});
