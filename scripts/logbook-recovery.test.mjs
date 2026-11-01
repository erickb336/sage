import './test-env.mjs';
import assert from 'node:assert/strict';
import fs, { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
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

const DAMAGE = {
  'text with no fields': file => writeFileSync(file, '{}'),
  'text that is not JSON': file => writeFileSync(file, 'not json'),
  'bytes that are not UTF-8': file => writeFileSync(file, Buffer.from([0xff, 0xfe, 0x7b])),
  'a folder': file => mkdirSync(file),
  'a link to a file that names the commit': file => {
    writeFileSync(`${file}.target`, SHA);
    symlinkSync(`${file}.target`, file);
  },
  'a size over the limit': file => { writeFileSync(file, ''); truncateSync(file, 65 * 1024 * 1024); },
};
for (const [name, damage] of Object.entries(DAMAGE)) test(`T578 a saved change that is ${name} stops only its own project`, t => {
  const f = fixture(t, ['one', 'two']), { env, one, two } = f;
  passing(one);
  damage(join(two.dir, MARKER));
  const other = mergeCheck(SHA, env, { project: one.project });
  assert.equal(other.ok, true, other.reason);
  assert.match(other.reason, new RegExp(`Skipped ${basename(two.dir)}: a saved change waits there`));
  const own = mergeCheck(SHA, env, { project: two.project });
  assert.equal(own.ok, false);
  assert.equal(own.reason, 'the merge check refuses this merge: A saved change cannot finish, and sage cannot read its request. The saved change or its receipt is damaged, or a table has neither its before nor its after text. The saved change stays in review-pending.json, and sage does not delete it. Writes and merges of this project stop. Other projects continue. Next step for the owner: run sage logbook in this project to find the folder, repair that file or the table, then run this command again.');
});

test('T578 a saved change that names the commit refuses the merge with no ledger row, also with bad bytes', t => {
  const f = fixture(t, ['one', 'two']), { env, one, two } = f;
  passing(one);
  for (const marker of [JSON.stringify({ value: { note: SHA } }), Buffer.concat([Buffer.from([0xff]), Buffer.from(SHA)])]) {
    writeFileSync(join(two.dir, MARKER), marker);
    assert.equal(tool.read(two.dir, 'ledger').length, 0);
    const verdict = mergeCheck(SHA, env, { project: one.project });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.reason, `the merge check refuses this merge: Project ${basename(two.dir)} holds a saved change that names ${SHA.slice(0, 7)}. Run sage init in that project to finish the change, then check again.`);
  }
});

test('T578 the merge note names the project, not its path, and asks for nothing', t => {
  const f = fixture(t, ['one', 'two']), { env, one, two } = f;
  passing(one);
  savedUsage(t, two);
  const { reason } = mergeCheck(SHA, env, { project: one.project });
  assert.ok(reason.endsWith(`Skipped ${basename(two.dir)}: a saved change waits there, and it has no row for this commit. No action is needed. Any write there finishes the change.`), reason);
  assert.equal(reason.includes(two.dir), false);
});

test('T578 the refusals name a command that finishes the change, and the CLI prints no stack', t => {
  const { env, one } = fixture(t);
  savedUsage(t, one);
  const asked = tool.command(['status', '--project', one.project], env);
  assert.deepEqual(asked, { code: 1, text: 'sage: A saved change is incomplete. Run any write command in this project, such as sage init, to finish it. Then run this command again.' });
  one.run(claude, 'init');
  assert.equal(existsSync(join(one.dir, MARKER)), false);
  assert.equal(row(one.dir, 'runs', 'R1').tokens, '50');
  writeFileSync(join(one.dir, MARKER), '{}');
  const stuck = tool.command(['task', 'add', '--priority', 'P2', '--title', 'Stopped', '--size', 'tiny', '--project', one.project], env);
  assert.equal(stuck.code, 1);
  assert.match(stuck.text, /^sage: A saved change cannot finish, /);
  assert.doesNotMatch(stuck.text, /\n\s+at /);
  assert.equal(tool.command(['logbook', '--project', one.project], env).text, one.dir, 'the refusal sends the owner to this command');
});

test('T578 a file error while a saved change finishes keeps the change, and the command can run again', t => {
  const { one } = fixture(t);
  savedUsage(t, one);
  const stop = stopAt(t, one.dir, 'runs', false);
  assert.throws(() => one.run(claude, 'init'), /^Error: A saved change \(request R1\) did not finish because of a file error \(EIO\)\. The saved change stays\. Run the command again\.$/);
  stop();
  assert.equal(existsSync(join(one.dir, MARKER)), true);
  one.run(claude, 'init');
  assert.equal(existsSync(join(one.dir, MARKER)), false);
  assert.equal(row(one.dir, 'runs', 'R1').tokens, '50');
});

test('T578 a file error before a task update stays an uncertain outcome, and damage stays invalid state', t => {
  const { env, one } = fixture(t);
  savedUsage(t, one);
  const input = { project: one.project, owner: 'chief', request: '00000000-0000-4000-8000-000000000578', task: 'T1', version: '0'.repeat(64), changes: { title: 'New' } };
  const callbacks = Object.fromEntries(['decide', 'acknowledge', 'release', 'void', 'history'].map(name => [name, () => {}]));
  const stop = stopAt(t, one.dir, 'runs', false);
  assert.throws(() => tool.updateRequestedTask(input, env, callbacks), { code: 'uncertain-outcome' });
  stop();
  writeFileSync(join(one.dir, MARKER), '{}');
  assert.throws(() => tool.updateRequestedTask(input, env, callbacks), { code: 'invalid-state' });
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
