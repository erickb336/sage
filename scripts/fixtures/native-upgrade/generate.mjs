// Regenerate with: node scripts/fixtures/native-upgrade/generate.mjs
// Uses the unmodified preceding implementation, never reconstructed current rows.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const base = '9bf43dea015c470e2688ff8a886f4315a5e19a71';
const here = dirname(fileURLToPath(import.meta.url)), repo = resolve(here, '../../..');
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'sage-upgrade-generator-')));
try {
  const files = execFileSync('git', ['-C', repo, 'ls-tree', '-r', '--name-only', base, 'packages/sage-core'], { encoding: 'utf8' }).trim().split('\n');
  for (const file of files) {
    const target = join(scratch, file); mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, execFileSync('git', ['-C', repo, 'show', `${base}:${file}`]));
  }
  const { createStateTool } = await import(pathToFileURL(join(scratch, 'packages/sage-core/state.mjs')));
  const tool = createStateTool({ defaultRoot: env => env.SAGE_HOME });
  const project = join(scratch, 'sample-project'); mkdirSync(project);
  const env = { ...process.env, SAGE_HOME: join(scratch, 'sage') };
  for (const args of [['init'], ['task', 'add', '--title', 'Upgrade sample', '--size', 'small', '--priority', 'P1']]) {
    const result = tool.command([...args, '--project', project], env); assert.equal(result.code, 0, result.text);
  }
  const dir = tool.storeDir(project, env);
  const request = { owner: 'sample-owner', request: 'a1111111-1111-4111-8111-111111111111', task: 'T1',
    version: tool.readTaskSnapshot({ project, task: 'T1' }, env).version, changes: { title: 'Recovered sample' } };
  const tables = Object.fromEntries(readdirSync(dir).filter(name => name.endsWith('.tsv')).map(name => [name, readFileSync(join(dir, name), 'utf8')]));
  const coordination = {
    decide(digest) { return { digest, accepted: true, reason: '' }; },
    acknowledge(digest, receiptHash) { return { digest, receiptHash }; },
    release(digest, receiptHash) { return { digest, receiptHash }; },
    history() { throw Error('No earlier receipt'); },
  };
  assert.throws(() => tool.updateRequestedTask({ project, ...request }, env, {
    ...coordination, decide() { throw Error('Stop after durable intent'); },
  }));
  const pending = readFileSync(join(dir, 'review-pending.json'), 'utf8');
  tool.updateRequestedTask({ project, ...request }, env, coordination);
  const name = readdirSync(join(dir, 'task-updates'))[0];
  const receipt = readFileSync(join(dir, 'task-updates', name), 'utf8');
  writeFileSync(join(here, 'base.json'), JSON.stringify({ base, request, tables, pending, receipt, name }, null, 2) + '\n');
  console.log(`Generated original pending intent and completed receipt with ${base}`);
} finally { rmSync(scratch, { recursive: true, force: true }); }
