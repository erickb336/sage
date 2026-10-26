// Regenerate with: node scripts/fixtures/native-upgrade/generate.mjs
// Uses the unmodified preceding implementation, never reconstructed current rows.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { createHash } from 'node:crypto';
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
  for (const scenario of ['creation', 'review']) {
    const project = join(scratch, `sample-${scenario}`); mkdirSync(project);
    const env = { ...process.env, SAGE_HOME: join(scratch, 'sage') };
    const command = (...args) => { const r = tool.command([...args, '--project', project], env); assert.equal(r.code, 0, r.text); };
    command('init');
    const dir = tool.storeDir(project, env);
    let request, invoke, folder;
    if (scenario === 'creation') {
      request = { owner: 'sample-owner', request: 'd1111111-1111-4111-8111-111111111111', title: 'Created sample', size: 'small', risk: [], add: ['security-review'], why: 'Sample added review' };
      invoke = () => tool.createRequestedTask({ project, ...request }, env);
      folder = 'task-requests';
    } else {
      const git = (...args) => execFileSync('git', ['-C', project, ...args], { env, encoding: 'utf8' }).trim();
      git('init', '--quiet', '-b', 'sample-review');
      git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '--allow-empty', '-m', 'Sample');
      const review = { branch: 'sample-review', sha: git('rev-parse', 'HEAD'), round: 2, cycle: 1 };
      command('task', 'add', '--title', 'Review sample', '--size', 'small', '--priority', 'P1');
      const patchRow = (table, fields) => {
        const path = join(dir, `${table}.tsv`), lines = readFileSync(path, 'utf8').trimEnd().split('\n');
        const cols = lines[0].split('\t'), cells = lines[1].split('\t');
        for (const [key, value] of Object.entries(fields)) cells[cols.indexOf(key)] = value;
        writeFileSync(path, `${lines[0]}\n${cells.join('\t')}\n`);
      };
      patchRow('tasks', { state: 'verified', round: '2', extra: '1', branch: review.branch, pr: '123' });
      command('run', 'add', 'T1', '--role', 'code-reviewer', '--branch', review.branch);
      const text = Object.entries({ STATUS: 'done', RESULT: 'FINDINGS',
        EVIDENCE: JSON.stringify({ commit: review.sha, round: 2, cycle: 1, summary: 'Simulated fixture review' }),
        FINDINGS: JSON.stringify([{ severity: 'medium', summary: 'Sample finding' }]), QUESTIONS: 'none', 'NOT VERIFIED': 'Real review', BRANCH: review.branch
      }).map(([key, value]) => `${key}: ${value}`).join('\n');
      const assignment = 'e1111111-1111-4111-8111-111111111111', reportHash = createHash('sha256').update(text).digest('hex');
      const report = `reports/R1-${assignment}-${reportHash}.md`;
      mkdirSync(join(dir, 'reports'), { recursive: true }); writeFileSync(join(dir, report), text);
      patchRow('runs', { status: 'done', ended: '2026-01-01T00:00:00Z', report });
      request = { task: 'T1', run: 'R1', role: 'code-reviewer', assignment, reportHash, text, review };
      invoke = () => tool.acceptReportedReview({ project, ...request }, env);
      folder = 'reviews';
    }
    const tables = Object.fromEntries(readdirSync(dir).filter(name => name.endsWith('.tsv')).map(name => [name, readFileSync(join(dir, name), 'utf8')]));
    const original = fs.renameSync;
    fs.renameSync = (from, to) => { if (to === join(dir, 'tasks.tsv')) throw Error('Stop after durable intent'); return original(from, to); };
    syncBuiltinESMExports();
    try { assert.throws(invoke, /Stop after durable intent/); }
    finally { fs.renameSync = original; syncBuiltinESMExports(); }
    const pending = readFileSync(join(dir, 'review-pending.json'), 'utf8');
    invoke();
    const name = readdirSync(join(dir, folder))[0], receipt = readFileSync(join(dir, folder, name), 'utf8');
    writeFileSync(join(here, `${scenario}.json`), JSON.stringify({ base, request, tables, pending, receipt, name, folder }, null, 2) + '\n');
    console.log(`Generated ${scenario} pending intent and completed receipt with ${base}`);
  }
  for (const scenario of ['title', 'building', 'briefed']) {
  const project = join(scratch, `sample-${scenario}`); mkdirSync(project);
  const env = { ...process.env, SAGE_HOME: join(scratch, 'sage') };
  for (const args of [['init'], ['task', 'add', '--title', 'Upgrade sample', '--size', 'small', '--priority', 'P1']]) {
    const result = tool.command([...args, '--project', project], env); assert.equal(result.code, 0, result.text);
  }
  const dir = tool.storeDir(project, env);
  if (scenario !== 'title') {
    // Seed a spent task with a prior allowance. The unmodified base writes the operation itself.
    const path = join(dir, 'tasks.tsv'), lines = readFileSync(path, 'utf8').trimEnd().split('\n');
    const cols = lines[0].split('\t'), cells = lines[1].split('\t');
    for (const [key, value] of Object.entries({ state: 'held', hold: 'round', extra: '2', round: '5', pr: '123', branch: 'sample-branch' })) cells[cols.indexOf(key)] = value;
    writeFileSync(path, `${lines[0]}\n${cells.join('\t')}\n`);
  }
  const request = { owner: 'sample-owner', request: 'a1111111-1111-4111-8111-111111111111', task: 'T1',
    version: tool.readTaskSnapshot({ project, task: 'T1' }, env).version,
    changes: scenario === 'title' ? { title: 'Recovered sample' } : { state: scenario } };
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
  writeFileSync(join(here, scenario === 'title' ? 'base.json' : `${scenario}.json`), JSON.stringify({ base, request, tables, pending, receipt, name }, null, 2) + '\n');
  console.log(`Generated ${scenario} pending intent and completed receipt with ${base}`);
  }
} finally { rmSync(scratch, { recursive: true, force: true }); }
