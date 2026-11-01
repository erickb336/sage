import './test-env.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs, { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { sage as claude, mergeCheck } from '../plugins/sage/skills/sage/sage.mjs';
import { tool } from '../plugins/sage-codex/skills/sage/sage.mjs';

const codex = tool.sage, SHA = 'a'.repeat(40), MARKER = 'review-pending.json';
const STUCK = 'This command changed nothing. This project cannot save changes; other projects work. Tell the owner. The owner restores the folder that `sage logbook` prints from a backup; rows newer than the backup are lost. Do not remove review-pending.json alone: a half-published update then keeps mixed tables.';

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
function stopAt(t, dir, step, after, folder = 'usage-requests') {
  const method = ['intent', 'receipt'].includes(step) ? 'linkSync' : step === 'clear' ? 'unlinkSync' : 'renameSync';
  const original = fs[method]; let hit = false;
  t.mock.method(fs, method, (...args) => {
    const to = String(args[method === 'unlinkSync' ? 0 : 1]);
    const matches = step === 'receipt' ? to.startsWith(join(dir, folder) + '/')
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

for (const [change, value] of [['schema', 99], ['hash', '0'.repeat(64)]]) test(`T578 a saved change with a bad ${change} cannot finish: it stops only its project`, t => {
  const f = fixture(t, ['one', 'two']), { one, two } = f;
  savedUsage(t, one);
  const file = join(one.dir, MARKER), record = JSON.parse(readFileSync(file, 'utf8'));
  if (change === 'schema') record.value.schema = value; else record.hash = value;
  const bytes = JSON.stringify(record) + '\n';
  writeFileSync(file, bytes);
  const before = tables(one.dir);
  assert.throws(() => one.run(claude, 'task', 'add', '--priority', 'P2', '--title', 'Stopped', '--size', 'tiny'), { message: STUCK });
  assert.equal(readFileSync(file, 'utf8'), bytes);
  assert.deepEqual(tables(one.dir), before);
  assert.match(two.run(claude, 'task', 'add', '--priority', 'P2', '--title', 'Goes on', '--size', 'tiny'), /T2/);
});

function passing(f) {
  f.run(claude, 'verdict', 'T1', '--kind', 'checks-pass', '--sha', SHA);
}

/** Open of one file fails with EACCES, as a folder with the wrong permissions does for any user. */
function denyOpen(t, file) {
  const { openSync: original } = fs;
  t.mock.method(fs, 'openSync', (...args) => {
    if (args[0] === file) throw Object.assign(Error('Injected denial'), { code: 'EACCES', path: file });
    return original(...args);
  });
  syncBuiltinESMExports();
  return () => { t.mock.restoreAll(); syncBuiltinESMExports(); };
}

test('T578 the merge check skips another project that holds a saved change, with a note', t => {
  const f = fixture(t, ['one', 'two']), { env, one, two } = f;
  passing(one);
  savedUsage(t, two);
  const before = readFileSync(join(two.dir, MARKER), 'utf8');
  const verdict = mergeCheck(SHA, env, { project: one.project });
  assert.equal(verdict.ok, true, verdict.reason);
  assert.match(verdict.reason, new RegExp(`Skipped .*${basename(two.dir)}: a saved change is incomplete there`));
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
  assert.match(other.reason, new RegExp(`Skipped ${basename(two.dir)}: a saved change is incomplete there`));
  const own = mergeCheck(SHA, env, { project: two.project });
  assert.equal(own.ok, false);
  assert.equal(own.reason, `the merge check refuses this merge: ${STUCK}`);
});

test('T578 a saved change that names the commit refuses the merge with no ledger row, also with bad bytes', t => {
  const f = fixture(t, ['one', 'two']), { env, one, two } = f;
  passing(one);
  for (const marker of [JSON.stringify({ value: { note: SHA } }), Buffer.concat([Buffer.from([0xff]), Buffer.from(SHA)])]) {
    writeFileSync(join(two.dir, MARKER), marker);
    assert.equal(tool.read(two.dir, 'ledger').length, 0);
    const verdict = mergeCheck(SHA, env, { project: one.project });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.reason, `the merge check refuses this merge: Project ${basename(two.dir)} holds a saved change that names ${SHA.slice(0, 7)}. It is incomplete. Any write in that project finishes it or says what to do. Then check again.`);
  }
});

test('T578 a marker of another project that the check cannot read refuses the merge, and it names the file', t => {
  const f = fixture(t, ['one', 'two']), { env, one, two } = f;
  passing(one);
  savedUsage(t, two);
  const denied = denyOpen(t, join(two.dir, MARKER));
  const verdict = mergeCheck(SHA, env, { project: one.project });
  denied();
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /^the merge check cannot read .*review-pending\.json \(EACCES\), so it refuses every merge\./);
});

test('T578 the merge note names the project, not its path', t => {
  const f = fixture(t, ['one', 'two']), { env, one, two } = f;
  passing(one);
  savedUsage(t, two);
  const { reason } = mergeCheck(SHA, env, { project: one.project });
  assert.ok(reason.endsWith(`Skipped ${basename(two.dir)}: a saved change is incomplete there, and it has no row for this commit. Any write there finishes it or says what to do.`), reason);
  assert.equal(reason.includes(two.dir), false);
});

test('T578 a read asks for any write, and the CLI prints the short line with no stack', t => {
  const { env, one } = fixture(t);
  savedUsage(t, one);
  const asked = tool.command(['status', '--project', one.project], env);
  assert.deepEqual(asked, { code: 1, text: 'sage: A saved change is incomplete. Any write in this project finishes it or says what to do. Then run this command again.' });
  one.run(claude, 'init');
  assert.equal(existsSync(join(one.dir, MARKER)), false);
  assert.equal(row(one.dir, 'runs', 'R1').tokens, '50');
  writeFileSync(join(one.dir, MARKER), '{}');
  const stuck = tool.command(['task', 'add', '--priority', 'P2', '--title', 'Stopped', '--size', 'tiny', '--project', one.project], env);
  assert.deepEqual(stuck, { code: 1, text: `sage: ${STUCK}` });
  // The line sends the owner to this command, so it must work with the stuck marker.
  for (const provider of [claude, codex]) assert.equal(one.run(provider, 'logbook').replace(/^logbook /, '').trim(), one.dir);
});

test('T578 a file error while a saved change finishes keeps the change, and the command can run again', t => {
  const { one } = fixture(t);
  savedUsage(t, one);
  const stop = stopAt(t, one.dir, 'runs', false);
  assert.throws(() => one.run(claude, 'init'), { message: 'A saved change (request R1) did not finish because of a file error (EIO). The saved change stays. Run the command again. If it repeats, check the logbook folder permissions.' });
  stop();
  assert.equal(existsSync(join(one.dir, MARKER)), true);
  one.run(claude, 'init');
  assert.equal(existsSync(join(one.dir, MARKER)), false);
  assert.equal(row(one.dir, 'runs', 'R1').tokens, '50');
});

for (const [name, request] of [['control characters', 'R1\u001b[2J'], ['an over-long id', `R${'1'.repeat(5000)}`]]) test(`T578 a file error prints no request with ${name}`, t => {
  const { one } = fixture(t), file = join(one.dir, MARKER);
  savedUsage(t, one);
  const record = JSON.parse(readFileSync(file, 'utf8'));
  record.value.receipt.reference.run = request;
  record.hash = createHash('sha256').update(JSON.stringify(record.value)).digest('hex');
  writeFileSync(file, JSON.stringify(record) + '\n');
  const denied = denyOpen(t, join(one.dir, 'runs.tsv'));
  assert.throws(() => one.run(claude, 'init'), { message: 'A saved change did not finish because of a file error (EACCES). The saved change stays. Run the command again. If it repeats, check the logbook folder permissions.' });
  denied();
});

// A stop during the settle itself: the next writer starts the settle again from the marker.
for (const step of ['runs', 'decisions', 'receipt', 'clear']) for (const after of [false, true]) test(`T578 a settle stopped ${after ? 'after' : 'before'} ${step}: the next write finishes the saved change`, t => {
  const { one } = fixture(t);
  savedUsage(t, one);
  const stop = stopAt(t, one.dir, step, after);
  assert.throws(() => one.run(claude, 'task', 'add', '--priority', 'P2', '--title', 'Second', '--size', 'tiny'), /file error \(EIO\)/);
  stop();
  one.run(codex, 'task', 'add', '--priority', 'P2', '--title', 'Third', '--size', 'tiny');
  assert.equal(existsSync(join(one.dir, MARKER)), false);
  assert.equal(row(one.dir, 'runs', 'R1').tokens, '50');
  assert.equal(tool.read(one.dir, 'decisions').filter(line => line.decision === 'R1 usage measured').length, 1);
  assert.equal(readdirSync(join(one.dir, 'usage-requests')).length, 1);
  assert.equal(row(one.dir, 'tasks', 'T2').title, 'Third');
});

const REQUEST = '00000000-0000-4000-8000-000000000578', UPDATES = 'task-updates';
const receipts = dir => existsSync(join(dir, UPDATES)) ? readdirSync(join(dir, UPDATES)).length : 0;
function update(env, one, changes, callbacks) {
  const { version } = tool.readTaskSnapshot({ project: one.project, task: 'T1' }, env);
  return tool.updateRequestedTask({ project: one.project, owner: 'chief', request: REQUEST, task: 'T1', version, changes }, env, callbacks);
}
const answer = accepted => ({ voids: 0, decide: digest => ({ digest, accepted, reason: accepted ? '' : 'No' }),
  acknowledge: (digest, receiptHash) => ({ digest, receiptHash }), release: (digest, receiptHash) => ({ digest, receiptHash }),
  void() { this.voids += 1; }, history() { throw Error('No history here'); } });
const uncertain = { code: 'uncertain-outcome' };
/** T1 held with a running lead: an update to briefed changes tasks, runs and decisions. */
function held(t) {
  const { env, one } = fixture(t);
  one.run(codex, 'run', 'add', 'T1', '--role', 'lead');
  for (const state of ['briefed', 'building', 'held']) one.run(codex, 'task', 'T1', 'set', `state=${state}`);
  return { env, one };
}

for (const step of ['tasks', 'runs', 'decisions', 'clear']) for (const after of [false, true]) test(`T578 a rollback stopped ${after ? 'after' : 'before'} ${step}: the next write restores the before tables`, t => {
  const { env, one } = held(t), before = tables(one.dir);
  const first = stopAt(t, one.dir, 'receipt', false, UPDATES);
  assert.throws(() => update(env, one, { state: 'briefed' }, answer(true)), uncertain);
  first();
  assert.equal(existsSync(join(one.dir, MARKER)), true);
  tables(one.dir).forEach((text, index) => assert.notEqual(text, before[index]));
  const second = stopAt(t, one.dir, step, after, UPDATES);
  assert.throws(() => one.run(claude, 'init'), /file error \(EIO\)/);
  second();
  assert.equal(existsSync(join(one.dir, MARKER)), !(step === 'clear' && after));
  one.run(claude, 'init');
  assert.equal(existsSync(join(one.dir, MARKER)), false);
  assert.deepEqual(tables(one.dir), before);
  assert.equal(receipts(one.dir), 0);
});

// The first stop leaves the update on some tables only, and the settle that undoes it stops too.
for (const [first, second] of [['runs', 'tasks'], ['decisions', 'runs']]) test(`T578 a settle stopped at ${second}, after a stop at ${first} left mixed tables: the next write restores the before tables`, t => {
  const { env, one } = held(t), before = tables(one.dir);
  const publish = stopAt(t, one.dir, first, false, UPDATES);
  assert.throws(() => update(env, one, { state: 'briefed' }, answer(true)), uncertain);
  publish();
  const same = dir => tables(dir).filter((text, index) => text === before[index]).length;
  assert.equal(same(one.dir), first === 'runs' ? 2 : 1, 'the first stop left mixed tables');
  const settle = stopAt(t, one.dir, second, false, UPDATES);
  assert.throws(() => one.run(claude, 'init'), /file error \(EIO\)/);
  settle();
  assert.notEqual(same(one.dir), 3, 'the stopped settle left the tables mixed');
  one.run(codex, 'init');
  assert.equal(existsSync(join(one.dir, MARKER)), false);
  assert.deepEqual(tables(one.dir), before);
  assert.equal(receipts(one.dir), 0);
});

for (const after of [false, true]) test(`T578 a roll forward stopped ${after ? 'after' : 'before'} clear: the update stays`, t => {
  const { env, one } = fixture(t);
  const first = stopAt(t, one.dir, 'clear', false, UPDATES);
  assert.throws(() => update(env, one, { title: 'New' }, answer(true)), uncertain);
  first();
  assert.equal(receipts(one.dir), 1);
  const second = stopAt(t, one.dir, 'clear', after, UPDATES);
  assert.throws(() => one.run(claude, 'task', 'add', '--priority', 'P2', '--title', 'Second', '--size', 'tiny'), /file error \(EIO\)/);
  second();
  one.run(claude, 'init');
  assert.equal(existsSync(join(one.dir, MARKER)), false);
  assert.equal(row(one.dir, 'tasks', 'T1').title, 'New');
  assert.equal(receipts(one.dir), 1);
});

for (const [step, after] of [['intent', false], ['intent', true], ['clear', false], ['clear', true]]) test(`T578 a rejected update stopped ${after ? 'after' : 'before'} ${step} leaves no receipt, and a retry gets a fresh answer`, t => {
  const { env, one } = fixture(t), before = tables(one.dir), no = answer(false);
  const stop = stopAt(t, one.dir, step, after, UPDATES);
  assert.throws(() => update(env, one, { title: 'New' }, no), uncertain);
  stop();
  assert.equal(no.voids, 0);
  one.run(claude, 'init');
  assert.equal(existsSync(join(one.dir, MARKER)), false);
  assert.deepEqual(tables(one.dir), before);
  assert.equal(receipts(one.dir), 0);
  assert.equal(update(env, one, { title: 'New' }, answer(true)).decision, 'task-updated');
  assert.equal(row(one.dir, 'tasks', 'T1').title, 'New');
});

test('T578 a file error before a task update stays an uncertain outcome, and a stuck change reads as in Claude', t => {
  const { env, one } = fixture(t);
  savedUsage(t, one);
  const input = { project: one.project, owner: 'chief', request: '00000000-0000-4000-8000-000000000578', task: 'T1', version: '0'.repeat(64), changes: { title: 'New' } };
  const callbacks = Object.fromEntries(['decide', 'acknowledge', 'release', 'void', 'history'].map(name => [name, () => {}]));
  const stop = stopAt(t, one.dir, 'runs', false);
  assert.throws(() => tool.updateRequestedTask(input, env, callbacks), { code: 'uncertain-outcome' });
  stop();
  writeFileSync(join(one.dir, MARKER), '{}');
  assert.throws(() => tool.updateRequestedTask(input, env, callbacks), { code: 'stuck-write', message: STUCK });
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
