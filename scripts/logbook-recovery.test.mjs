import './test-env.mjs';
import assert from 'node:assert/strict';
import fs, { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { sage as claude, mergeCheck } from '../plugins/sage/skills/sage/sage.mjs';
import { tool } from '../plugins/sage-codex/skills/sage/sage.mjs';

const codex = tool.sage, SHA = 'a'.repeat(40), MARKER = 'review-pending.json';

function fixture(t, names = ['one']) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'sage-recovery-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const env = { ...process.env, SAGE_HOME: join(base, 'home'), SAGE_TEST_PIDS: '{}' };
  const projects = Object.fromEntries(names.map(name => {
    const project = join(base, name); mkdirSync(project);
    const run = (provider, ...args) => provider([...args, '--project', project], env);
    const dir = run(codex, 'init').replace(/^logbook /, '');
    run(codex, 'task', 'add', '--priority', 'P2', '--title', `Task of ${name}`, '--size', 'tiny');
    return [name, { project, run, dir }];
  }));
  return { env, ...projects };
}
const usage = ['--tokens', '50', '--usage-source', 'export', '--usage-evidence', 'pages/R1.json'];
const tables = dir => ['tasks', 'runs', 'decisions'].map(table => readFileSync(join(dir, `${table}.tsv`), 'utf8'));
const row = (dir, table, id) => tool.read(dir, table).find(value => value.id === id);

/** Stop one write at a file step: before or after the file call of that step, as a crash there would. */
function stopAt(t, dir, step, after) {
  const method = ['intent', 'receipt'].includes(step) ? 'linkSync' : step === 'clear' ? 'unlinkSync' : 'renameSync';
  const original = fs[method]; let hit = false;
  t.mock.method(fs, method, (...args) => {
    const to = String(args[method === 'unlinkSync' ? 0 : 1]);
    const matches = step === 'receipt' ? to.startsWith(join(dir, 'usage-requests') + '/')
      : to === join(dir, ['intent', 'clear'].includes(step) ? MARKER : `${step}.tsv`);
    if (!hit && matches) {
      hit = true;
      if (after) original(...args);
      throw Object.assign(Error('Injected stop'), { code: 'EIO' });
    }
    return original(...args);
  });
  syncBuiltinESMExports();
  return () => { t.mock.restoreAll(); syncBuiltinESMExports(); assert.equal(hit, true, `the write reached ${step}`); };
}

const STEPS = [['intent', false], ['intent', true], ['runs', false], ['runs', true], ['decisions', false], ['decisions', true],
  ['receipt', false], ['receipt', true], ['clear', false], ['clear', true]];
for (const [starter, settler, name] of [[claude, codex, 'Claude to Codex'], [codex, claude, 'Codex to Claude']]) {
  for (const [step, after] of STEPS) test(`T578 usage write stopped ${after ? 'after' : 'before'} ${step} settles from the other provider: ${name}`, t => {
    const { one: { dir, run } } = fixture(t);
    run(starter, 'run', 'add', 'T1', '--role', 'qa');
    run(starter, 'run', 'done', 'R1', '--status', 'blocked');
    const stop = stopAt(t, dir, step, after);
    assert.throws(() => run(starter, 'run', 'usage', 'R1', ...usage), /Injected stop/);
    stop();
    run(settler, 'task', 'add', '--priority', 'P2', '--title', 'The other provider', '--size', 'tiny');
    assert.equal(existsSync(join(dir, MARKER)), false);
    assert.equal(row(dir, 'tasks', 'T2').title, 'The other provider');
    // The marker holds the whole receipt, so each stop after the marker rolls forward. Before the marker nothing happened.
    assert.equal(row(dir, 'runs', 'R1').tokens, step === 'intent' && !after ? '' : '50');
    run(settler, 'run', 'usage', 'R1', ...usage);
    assert.equal(row(dir, 'runs', 'R1').tokens, '50');
    assert.equal(tool.read(dir, 'decisions').filter(line => line.decision === 'R1 usage measured').length, 1);
  });
}

function savedUsage(t, f) {
  const { dir, run } = f;
  run(codex, 'run', 'add', 'T1', '--role', 'qa');
  run(codex, 'run', 'done', 'R1', '--status', 'blocked');
  const stop = stopAt(t, dir, 'runs', false);
  assert.throws(() => run(codex, 'run', 'usage', 'R1', ...usage), /Injected stop/);
  stop();
}

test('T578 a read with no lock shows a saved change and never settles it', t => {
  const { one } = fixture(t);
  savedUsage(t, one);
  const before = readFileSync(join(one.dir, MARKER), 'utf8');
  assert.throws(() => one.run(claude, 'status'), /saved change is incomplete/);
  assert.equal(readFileSync(join(one.dir, MARKER), 'utf8'), before);
});

for (const [change, value] of [['schema', 99], ['hash', '0'.repeat(64)]]) test(`T578 a saved change with a bad ${change} cannot finish: it names the request and stops only its project`, t => {
  const f = fixture(t, ['one', 'two']), { one, two } = f;
  savedUsage(t, one);
  const file = join(one.dir, MARKER), record = JSON.parse(readFileSync(file, 'utf8'));
  if (change === 'schema') record.value.schema = value; else record.hash = value;
  const bytes = JSON.stringify(record) + '\n';
  writeFileSync(file, bytes);
  const before = tables(one.dir);
  assert.throws(() => one.run(claude, 'task', 'add', '--priority', 'P2', '--title', 'Stopped', '--size', 'tiny'), /saved change \(request R1\) cannot finish/);
  assert.equal(readFileSync(file, 'utf8'), bytes);
  assert.deepEqual(tables(one.dir), before);
  assert.match(two.run(claude, 'task', 'add', '--priority', 'P2', '--title', 'Goes on', '--size', 'tiny'), /T2/);
});

function passing(f) {
  f.run(claude, 'verdict', 'T1', '--kind', 'checks-pass', '--sha', SHA);
}

test('T578 the merge check skips another project that holds a saved change, with a note', t => {
  const f = fixture(t, ['one', 'two']), { env, one, two } = f;
  passing(one);
  savedUsage(t, two);
  const before = readFileSync(join(two.dir, MARKER), 'utf8');
  const verdict = mergeCheck(SHA, env, { project: one.project });
  assert.equal(verdict.ok, true, verdict.reason);
  assert.match(verdict.reason, new RegExp(`Skipped .*${basename(two.dir)}: a saved change waits there`));
  assert.equal(readFileSync(join(two.dir, MARKER), 'utf8'), before, 'the merge check of a project settles only that project');
});

test('T578 a damaged saved change of another project does not stop this merge', t => {
  const f = fixture(t, ['one', 'two']), { env, one, two } = f;
  passing(one);
  writeFileSync(join(two.dir, MARKER), '{}');
  assert.equal(mergeCheck(SHA, env, { project: one.project }).ok, true);
  const own = mergeCheck(SHA, env, { project: two.project });
  assert.equal(own.ok, false);
  assert.match(own.reason, /refuses this merge: A saved change \(request unknown\) cannot finish/);
});

test('T578 the merge check settles its own project first', t => {
  const f = fixture(t, ['one']), { env, one } = f;
  passing(one);
  savedUsage(t, one);
  const verdict = mergeCheck(SHA, env, { project: one.project });
  assert.equal(verdict.ok, true, verdict.reason);
  assert.equal(existsSync(join(one.dir, MARKER)), false);
  assert.equal(row(one.dir, 'runs', 'R1').tokens, '50');
});

test('T578 a read-only merge check never settles, and it counts a saved change that names the commit', t => {
  const f = fixture(t, ['one', 'two']), { env, one, two } = f;
  passing(one); passing(two);
  savedUsage(t, two);
  const before = readFileSync(join(two.dir, MARKER), 'utf8');
  for (const options of [{ readOnly: true }, { project: one.project }]) {
    const verdict = mergeCheck(SHA, env, options);
    assert.equal(verdict.ok, false);
    assert.match(verdict.reason, new RegExp(`refuses this merge: .*${basename(two.dir)} holds a saved change that names ${SHA.slice(0, 7)}`));
  }
  assert.equal(readFileSync(join(two.dir, MARKER), 'utf8'), before);
  assert.deepEqual(readdirSync(two.dir).filter(name => name === '.lock'), []);
});
