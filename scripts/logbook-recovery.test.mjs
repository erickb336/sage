import './test-env.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs, { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { test } from 'node:test';
import { sage as claude, mergeCheck } from '../plugins/sage/skills/sage/sage.mjs';
import { tool } from '../plugins/sage-codex/skills/sage/sage.mjs';

const codex = tool.sage, SHA = 'a'.repeat(40), MARKER = 'review-pending.json';
const STUCK = 'This command changed nothing. This project cannot save changes; other projects work. Tell the owner. There are two ways out. With a backup: the owner restores the folder that `sage logbook` prints; rows newer than the backup are lost. With no backup: after the owner accepts the loss of this saved change, the chief, or the owner in a terminal, runs `sage logbook repair --accept-change-loss yes --project <the project>`; it keeps the file, and a half-published update keeps mixed tables. Do not remove review-pending.json by hand.';

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

/** Every file of a logbook folder and its bytes, folders by name. */
const snapshot = dir => Object.fromEntries(readdirSync(dir, { withFileTypes: true, recursive: true })
  .map(entry => join(entry.parentPath, entry.name))
  .map(file => [file, fs.statSync(file).isDirectory() ? 'folder' : readFileSync(file, 'utf8')]));
const REPAIR = ['logbook', 'repair', '--accept-change-loss', 'yes'];
const lostFiles = dir => readdirSync(dir).filter(name => name.startsWith(`${MARKER}.lost-`)).sort();
/** A saved usage change that cannot finish: its hash no longer matches. The tables are at their "before" text. */
function stuck(t, f) {
  savedUsage(t, f);
  const file = join(f.dir, MARKER), record = JSON.parse(readFileSync(file, 'utf8'));
  record.hash = '0'.repeat(64);
  writeFileSync(file, JSON.stringify(record) + '\n');
  return file;
}

for (const [name, provider] of [['Claude', claude], ['Codex', codex]]) {
  test(`T593 ${name}: after the owner accepts the loss, the marker is kept, the decision names it, and the next write works`, t => {
    const { one } = fixture(t), file = stuck(t, one), bytes = readFileSync(file, 'utf8');
    assert.throws(() => one.run(provider, 'task', 'add', '--priority', 'P2', '--title', 'Stopped', '--size', 'tiny'), { message: STUCK });
    const out = one.run(provider, ...REPAIR), kept = `${file}.lost-1`;
    assert.equal(out, `The saved change (request R1) is lost: ${MARKER} moved to ${kept}, and the decision is in decisions.tsv. A half-published update can leave mixed tables, where some tables hold the change and others do not. Sage does not repair them, so read the rows of the last work. The logbook check passes, and writes work again. The check reads each table alone, so it cannot show that the tables agree.`);
    assert.equal(existsSync(file), false);
    assert.equal(readFileSync(kept, 'utf8'), bytes);
    const { decision, why, task } = tool.read(one.dir, 'decisions').at(-1);
    assert.deepEqual({ decision, why, task }, { decision: `saved change (request R1) moved aside to ${kept}`, why: 'the owner accepts the loss of this saved change', task: '' });
    assert.equal(row(one.dir, 'runs', 'R1').tokens, '', 'the lost change stays lost');
    assert.match(one.run(provider, 'task', 'add', '--priority', 'P2', '--title', 'Saves again', '--size', 'tiny'), /T2/);
    assert.equal(row(one.dir, 'tasks', 'T2').title, 'Saves again');
  });

  test(`T593 ${name}: the repair refuses a healthy logbook and a change that can finish, and it changes no file`, t => {
    const { one } = fixture(t), before = snapshot(one.dir);
    assert.throws(() => one.run(provider, ...REPAIR), { message: 'This logbook has no saved change, so there is nothing to repair. Nothing changed.' });
    assert.deepEqual(snapshot(one.dir), before);
    savedUsage(t, one);
    const saved = snapshot(one.dir);
    assert.ok(Object.keys(saved).some(file => file.endsWith(MARKER)), 'the saved change is there');
    assert.throws(() => one.run(provider, ...REPAIR), { message: 'This saved change can finish, so it needs no repair: any write in this project finishes it. Nothing changed.' });
    assert.deepEqual(snapshot(one.dir), saved);
    one.run(provider, 'init');
    assert.equal(row(one.dir, 'runs', 'R1').tokens, '50', 'the refused repair kept the change, and a write finishes it');
  });
}

test('T593 the repair refuses a coordinated update that can finish, with no change', t => {
  const { env, one } = held(t);
  const stop = stopAt(t, one.dir, 'receipt', false, UPDATES);
  assert.throws(() => update(env, one, { state: 'briefed' }, answer(true)), uncertain);
  stop();
  const saved = snapshot(one.dir);
  assert.throws(() => one.run(claude, ...REPAIR), /This saved change can finish/);
  assert.deepEqual(snapshot(one.dir), saved);
});

test('T593 a file error is no stuck change: the repair moves nothing, and the line says to run again', t => {
  const { one } = fixture(t);
  const file = stuck(t, one), saved = snapshot(one.dir);
  const denied = denyOpen(t, file);
  assert.throws(() => one.run(claude, ...REPAIR), /did not finish because of a file error \(EACCES\)/);
  denied();
  assert.deepEqual(snapshot(one.dir), saved);
});

test('T593 two repairs in a row keep two files, and each decision names its own', t => {
  const { one } = fixture(t), file = stuck(t, one);
  one.run(claude, ...REPAIR);
  writeFileSync(file, 'second damaged marker');
  one.run(codex, ...REPAIR);
  assert.deepEqual(lostFiles(one.dir), [`${MARKER}.lost-1`, `${MARKER}.lost-2`]);
  assert.equal(readFileSync(`${file}.lost-2`, 'utf8'), 'second damaged marker');
  assert.notEqual(readFileSync(`${file}.lost-1`, 'utf8'), 'second damaged marker');
  assert.deepEqual(tool.read(one.dir, 'decisions').filter(line => line.why.startsWith('the owner')).map(line => line.decision),
    [`saved change (request R1) moved aside to ${file}.lost-1`, `saved change moved aside to ${file}.lost-2`]);
});

test('T593 the decision comes before the move: a move that fails leaves the marker, and the repair can run again', t => {
  const { one } = fixture(t), file = stuck(t, one), { renameSync: original } = fs;
  t.mock.method(fs, 'renameSync', (...args) => {
    if (args[0] === file) throw Object.assign(Error('Injected stop'), { code: 'EIO' });
    return original(...args);
  });
  syncBuiltinESMExports();
  assert.throws(() => one.run(claude, ...REPAIR), /Injected stop/);
  t.mock.restoreAll(); syncBuiltinESMExports();
  assert.equal(existsSync(file), true);
  assert.equal(tool.read(one.dir, 'decisions').at(-1).decision, `saved change (request R1) moved aside to ${file}.lost-1`);
  one.run(claude, ...REPAIR);
  assert.deepEqual(lostFiles(one.dir), [`${MARKER}.lost-1`]);
});

const MARKERS = {
  'a folder': file => mkdirSync(file),
  'a link': file => { writeFileSync(`${file}.target`, 'kept'); symlinkSync(`${file}.target`, file); },
  'bytes that are not UTF-8': file => writeFileSync(file, Buffer.from([0xff, 0xfe])),
};
for (const [name, damage] of Object.entries(MARKERS)) test(`T593 the repair moves aside a marker that is ${name}, and never follows it`, t => {
  const { one } = fixture(t), file = join(one.dir, MARKER);
  damage(file);
  one.run(claude, ...REPAIR);
  assert.equal(existsSync(file), false);
  assert.deepEqual(lostFiles(one.dir), [`${MARKER}.lost-1`]);
  assert.match(one.run(claude, 'task', 'add', '--priority', 'P2', '--title', 'Saves again', '--size', 'tiny'), /T2/);
});

test('T593 a table that the stuck change left damaged still fails the check: writes stop, and the table repair is the way on', t => {
  const { one } = fixture(t);
  savedUsage(t, one);
  writeFileSync(join(one.dir, 'runs.tsv'), ''); // neither its before nor its after text
  assert.throws(() => one.run(claude, 'init'), { message: STUCK });
  const out = one.run(claude, ...REPAIR);
  assert.match(out, /The saved change \(request R1\) is lost: .* The logbook check fails, so writes still stop: \S+runs\.tsv is empty \(0 bytes\).*logbook repair --accept-loss runs /);
  assert.throws(() => one.run(claude, 'task', 'add', '--priority', 'P2', '--title', 'Stopped', '--size', 'tiny'), /runs\.tsv is empty/);
  one.run(claude, 'logbook', 'repair', '--accept-loss', 'runs');
  assert.match(one.run(claude, 'task', 'add', '--priority', 'P2', '--title', 'Saves again', '--size', 'tiny'), /T2/);
});

test('T593 mixed tables that are each whole stay as they are: the repair says so, and it does not restore them', t => {
  const { env, one } = held(t), before = tables(one.dir);
  const publish = stopAt(t, one.dir, 'runs', false, UPDATES);
  assert.throws(() => update(env, one, { state: 'briefed' }, answer(true)), uncertain);
  publish();
  const mixed = tables(one.dir);
  assert.notEqual(mixed[0], before[0], 'tasks hold the change');
  assert.equal(mixed[1], before[1], 'runs do not');
  const file = join(one.dir, MARKER), record = JSON.parse(readFileSync(file, 'utf8'));
  record.hash = '0'.repeat(64);
  writeFileSync(file, JSON.stringify(record) + '\n');
  const out = one.run(claude, ...REPAIR);
  assert.match(out, /A half-published update can leave mixed tables/);
  assert.match(out, /The check reads each table alone, so it cannot show that the tables agree\.$/);
  assert.equal(tables(one.dir)[0], mixed[0]);
  assert.equal(tables(one.dir)[1], mixed[1]);
});

test('T593 a stuck change with a damaged decisions table: the repair refuses with the command that takes both, and that command works', t => {
  const { one } = fixture(t), file = stuck(t, one), decisions = join(one.dir, 'decisions.tsv');
  writeFileSync(decisions, '');
  const saved = snapshot(one.dir);
  assert.throws(() => one.run(claude, ...REPAIR), /The repair records its decision first, and decisions\.tsv fails the logbook check: .* Nothing changed\. If the owner accepts the loss of those rows too, run: sage logbook repair --accept-change-loss yes --accept-loss decisions --project <the project>\.$/);
  assert.deepEqual(snapshot(one.dir), saved);
  assert.throws(() => one.run(claude, 'logbook', 'repair', '--accept-loss', 'decisions'), { message: STUCK });
  const out = one.run(claude, ...REPAIR, '--accept-loss', 'decisions');
  assert.match(out, /^decisions\.tsv started again without rows; its old file is \S+decisions\.tsv\.lost-1\. The decision is in decisions\.tsv\. The saved change \(request R1\) is lost: /);
  assert.deepEqual(lostFiles(one.dir), [`${MARKER}.lost-1`]);
  assert.deepEqual(tool.read(one.dir, 'decisions').map(line => line.why), ['the user accepts the loss of its rows', 'the owner accepts the loss of this saved change']);
  assert.equal(existsSync(file), false);
  assert.match(one.run(claude, 'task', 'add', '--priority', 'P2', '--title', 'Saves again', '--size', 'tiny'), /T2/);
});

const LINKED = (real, setting = 'SAGE_HOME') => `This logbook is reached through a link, so its saved change may finish from the real folder ${real}. Nothing changed. Run sage on a path with no link: put the folder back in place of the link, or set ${setting} to the real folder's parent. Then any write finishes the change or says what to do.`;
test('T593 a SAGE_HOME path through a link: the repair refuses, and the change that reads as stuck finishes from the real path', t => {
  const { env, one } = fixture(t);
  savedUsage(t, one);
  const link = `${env.SAGE_HOME}-link`, linked = { ...env, SAGE_HOME: link }, saved = snapshot(one.dir);
  symlinkSync(env.SAGE_HOME, link);
  const write = ['init', '--project', one.project];
  assert.throws(() => claude(write, linked), { message: STUCK });
  assert.throws(() => claude([...REPAIR, '--project', one.project], linked), { message: LINKED(one.dir) });
  assert.deepEqual(snapshot(one.dir), saved);
  assert.deepEqual(lostFiles(one.dir), []);
  claude(write, env);
  assert.equal(row(one.dir, 'runs', 'R1').tokens, '50', 'the real path finishes the change');
  assert.equal(existsSync(join(one.dir, MARKER)), false);
});

test('T593 a logbook moved behind a link: the repair refuses also with the table form, and from the real folder a stuck change still has its repair', t => {
  const { env, one } = fixture(t), file = stuck(t, one), bytes = readFileSync(file, 'utf8'), moved = `${one.dir}-moved`;
  fs.renameSync(one.dir, moved); symlinkSync(moved, one.dir);
  writeFileSync(join(moved, 'decisions.tsv'), '');
  const saved = snapshot(moved);
  for (const args of [REPAIR, [...REPAIR, '--accept-loss', 'decisions']]) assert.throws(() => codex([...args, '--project', one.project], env), { message: LINKED(moved) });
  assert.deepEqual(snapshot(moved), saved);
  rmSync(one.dir); fs.renameSync(moved, one.dir);
  assert.match(one.run(codex, ...REPAIR, '--accept-loss', 'decisions'), /The saved change \(request R1\) is lost: .*The logbook check passes/);
  assert.equal(readFileSync(`${file}.lost-1`, 'utf8'), bytes);
});

/**
 * A shared logbook as sage link makes it: the first checkout's --separate, a clone's --to, and each provider with its own
 * root and no SAGE_HOME, as in production. T1 is on the first checkout. The clone has no logbook of its own.
 */
function linkedProjects(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'sage-linked-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const env = { ...process.env, HOME: join(base, 'home'), CLAUDE_CONFIG_DIR: join(base, 'claude'), CODEX_HOME: join(base, 'codex'), SAGE_SHARED_HOME: join(base, 'shared'), SAGE_TEST_PIDS: '{}' };
  delete env.SAGE_HOME;
  const gitEnv = { ...env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };
  const git = (...args) => execFileSync('git', args, { cwd: base, env: gitEnv, stdio: 'ignore' });
  const first = join(base, 'first'), second = join(base, 'second');
  git('init', '-q', '-b', 'main', first);
  git('-C', first, 'commit', '-q', '--allow-empty', '-m', 'first');
  git('clone', '-q', first, second);
  const checkout = project => ({ project, env, run: (provider, ...args) => provider([...args, '--project', project], env) });
  const one = checkout(first), two = checkout(second);
  one.run(codex, 'link', '--separate');
  const dir = one.run(codex, 'logbook');
  two.run(claude, 'link', '--to', basename(dir));
  one.run(codex, 'task', 'add', '--priority', 'P2', '--title', 'Task of the project', '--size', 'tiny');
  Object.assign(one, { dir }); Object.assign(two, { dir });
  const logbooks = root => existsSync(root) ? readdirSync(root).filter(name => existsSync(join(root, name, 'tasks.tsv'))) : [];
  const providerLogbooks = () => [...logbooks(join(env.CLAUDE_CONFIG_DIR, 'sage')), ...logbooks(join(env.CODEX_HOME, 'sage'))];
  return { base, env, shared: env.SAGE_SHARED_HOME, dir, one, two, providerLogbooks };
}

for (const [name, provider] of [['Claude', claude], ['Codex', codex]]) {
  test(`T593 ${name}: a linked project repairs its shared logbook, and every checkout of that logbook saves again`, t => {
    const { dir, one, two, shared, providerLogbooks } = linkedProjects(t), file = stuck(t, one), bytes = readFileSync(file, 'utf8');
    assert.equal(dirname(dir), shared, 'the logbook is in the shared root');
    assert.equal(two.run(provider, 'logbook'), dir, 'the clone finds the same logbook');
    assert.throws(() => two.run(provider, 'task', 'add', '--priority', 'P2', '--title', 'Stopped', '--size', 'tiny'), { message: STUCK });
    const out = two.run(provider, ...REPAIR), kept = `${file}.lost-1`;
    assert.match(out, /^The saved change \(request R1\) is lost: .*The logbook check passes, and writes work again\./);
    assert.equal(existsSync(file), false);
    assert.equal(readFileSync(kept, 'utf8'), bytes);
    const { decision, why } = tool.read(dir, 'decisions').at(-1);
    assert.deepEqual({ decision, why }, { decision: `saved change (request R1) moved aside to ${kept}`, why: 'the owner accepts the loss of this saved change' });
    assert.deepEqual(providerLogbooks(), [], 'the repair wrote no logbook in a provider root');
    assert.match(two.run(provider, 'task', 'add', '--priority', 'P2', '--title', 'From the clone', '--size', 'tiny'), /T2/);
    assert.match(one.run(provider, 'task', 'add', '--priority', 'P2', '--title', 'From the first checkout', '--size', 'tiny'), /T3/);
    assert.deepEqual(tool.read(dir, 'tasks').map(task => task.title), ['Task of the project', 'From the clone', 'From the first checkout']);
  });
}

test('T593 a path to a linked checkout through a link is no link to the logbook: the repair works', t => {
  const { base, dir, env, one } = linkedProjects(t), file = stuck(t, one), link = join(base, 'first-link');
  symlinkSync(one.project, link);
  assert.match(claude([...REPAIR, '--project', link], env), /The saved change \(request R1\) is lost: .*The logbook check passes/);
  assert.deepEqual(lostFiles(dir), [`${MARKER}.lost-1`]);
  assert.equal(existsSync(file), false);
});

test('T593 a linked project: the repair refuses a change that can finish, and a write from the other checkout finishes it', t => {
  const { dir, one, two, shared } = linkedProjects(t);
  savedUsage(t, one);
  const saved = snapshot(shared);
  assert.throws(() => two.run(claude, ...REPAIR), { message: 'This saved change can finish, so it needs no repair: any write in this project finishes it. Nothing changed.' });
  assert.deepEqual(snapshot(shared), saved);
  two.run(claude, 'task', 'add', '--priority', 'P2', '--title', 'Finishes it', '--size', 'tiny');
  assert.equal(row(dir, 'runs', 'R1').tokens, '50', 'the refused repair kept the change, and a write finishes it');
  assert.equal(existsSync(join(dir, MARKER)), false);
});

test('T593 a shared root reached through a link: the repair refuses, and the setting that the line names finishes the change', t => {
  const { base, dir, env, one, two, shared } = linkedProjects(t);
  savedUsage(t, one);
  const link = join(base, 'shared-link'), linked = { ...env, SAGE_SHARED_HOME: link }, write = ['task', 'add', '--priority', 'P2', '--title', 'Saved', '--size', 'tiny', '--project', two.project], saved = snapshot(shared);
  symlinkSync(shared, link);
  assert.throws(() => claude(write, linked), { message: STUCK });
  assert.throws(() => claude([...REPAIR, '--project', two.project], linked), { message: LINKED(dir, 'SAGE_SHARED_HOME') });
  assert.deepEqual(snapshot(shared), saved);
  claude(write, { ...env, SAGE_SHARED_HOME: realpathSync(link) });
  assert.equal(row(dir, 'runs', 'R1').tokens, '50', 'the real path finishes the change');
  assert.equal(existsSync(join(dir, MARKER)), false);
});

/** Write the saved change again with these changes, with a hash that matches. */
function rewrite(file, change) {
  const { value } = JSON.parse(readFileSync(file, 'utf8'));
  change(value);
  writeFileSync(file, JSON.stringify({ value, hash: createHash('sha256').update(JSON.stringify(value)).digest('hex') }) + '\n');
}

for (const [name, provider] of [['Claude', claude], ['Codex', codex]]) test(`T593 ${name}: a saved change of a newer schema refuses with the plugin update, and it changes no file`, t => {
  const { one } = fixture(t);
  savedUsage(t, one);
  const file = join(one.dir, MARKER);
  rewrite(file, value => { value.schema = 9; });
  const saved = snapshot(one.dir);
  assert.throws(() => one.run(provider, 'init'), { message: STUCK });
  assert.throws(() => one.run(provider, ...REPAIR), { message: 'This saved change has schema 9, and this version of sage knows schemas up to 8: a newer sage wrote it and may finish it. Nothing changed. Update the sage plugin and restart this session. Then any write finishes the change or says what to do.' });
  assert.deepEqual(snapshot(one.dir), saved);
});

for (const [name, schema] of [['an older unknown schema', 1], ['a schema that is text', '9'], ['no schema', undefined]]) test(`T593 a whole marker with ${name} is damaged, not newer: the repair moves it aside`, t => {
  const { one } = fixture(t);
  savedUsage(t, one);
  rewrite(join(one.dir, MARKER), value => { value.schema = schema; });
  assert.match(one.run(claude, ...REPAIR), /The logbook check passes/);
  assert.deepEqual(lostFiles(one.dir), [`${MARKER}.lost-1`]);
});

test('T593 a table with columns of a newer sage: the repair refuses with the plugin update, also when decisions.tsv is the one that is fine', t => {
  const { one } = fixture(t);
  stuck(t, one);
  const runs = join(one.dir, 'runs.tsv');
  writeFileSync(runs, readFileSync(runs, 'utf8').replace('\n', '\tnewer\n'));
  const saved = snapshot(one.dir);
  assert.throws(() => one.run(claude, ...REPAIR), { message: `${runs} has columns that this version of sage does not know (newer): a newer sage wrote this logbook, and a write of this version would lose them. Update the sage plugin and restart this session. Nothing changed; status, logbook, standing and merge-check still work.` });
  assert.deepEqual(snapshot(one.dir), saved);
});

/** A stuck saved change, and one receipt of a whole earlier update, under task-updates. */
function stuckWithReceipt(t) {
  const { env, one } = fixture(t);
  update(env, one, { title: 'First' }, answer(true));
  stuck(t, one);
  const [name] = readdirSync(join(one.dir, UPDATES));
  return { one, receipt: join(one.dir, UPDATES, name) };
}
const BACKUP = 'A receipt in task-updates fails its check, so writes would still stop after this repair. Nothing changed. Only a backup helps here: the owner restores the folder that `sage logbook` prints; rows newer than the backup are lost.';
test('T593 a damaged receipt: the repair refuses before the move, because the next write could not work', t => {
  const { one, receipt } = stuckWithReceipt(t);
  writeFileSync(receipt, 'damaged');
  const saved = snapshot(one.dir);
  assert.throws(() => one.run(claude, ...REPAIR), { message: BACKUP });
  assert.deepEqual(snapshot(one.dir), saved);
});

test('T593 a receipt with a good hash that fails its check: the repair refuses before the move, with no error of another kind', t => {
  const { one, receipt } = stuckWithReceipt(t);
  rewrite(receipt, value => { value.intent.proposal = {}; });
  const saved = snapshot(one.dir);
  assert.throws(() => one.run(claude, ...REPAIR), { message: BACKUP });
  assert.deepEqual(snapshot(one.dir), saved);
});

test('T593 a whole receipt does not stop the repair', t => {
  const { one } = stuckWithReceipt(t);
  assert.match(one.run(claude, ...REPAIR), /The logbook check passes/);
});

test('T593 the flag takes only yes, and the repair still needs a named form', t => {
  const { one } = fixture(t), file = stuck(t, one), saved = snapshot(one.dir);
  assert.throws(() => one.run(claude, 'logbook', 'repair', '--accept-change-loss', 'no'), { message: '--accept-change-loss takes only yes. Run it only after the owner accepts the loss of the saved change.' });
  assert.throws(() => one.run(claude, 'logbook', 'repair'), /logbook repair needs --accept-loss/);
  assert.deepEqual(snapshot(one.dir), saved);
  assert.equal(existsSync(file), true);
});

test('T593 after a repair, the merge check of the project works again', t => {
  const f = fixture(t), { env, one } = f;
  passing(one);
  stuck(t, one);
  assert.equal(mergeCheck(SHA, env, { project: one.project }).reason, `the merge check refuses this merge: ${STUCK}`);
  one.run(claude, ...REPAIR);
  const verdict = mergeCheck(SHA, env, { project: one.project });
  assert.equal(verdict.ok, true, verdict.reason);
});

function passing(f) {
  f.run(claude, 'verdict', 'T1', '--kind', 'checks-pass', '--sha', SHA);
}

const namedIn = dir => `the merge check refuses this merge: Project ${basename(dir)} holds an incomplete saved change, and its ledger or that change names ${SHA.slice(0, 7)}. Any write in that project finishes it or says what to do. Then check again.`;

/** Open of one file fails with EACCES, as a folder with the wrong permissions does for any user, or with another file error. */
function denyOpen(t, file, code = 'EACCES') {
  const { openSync: original } = fs;
  t.mock.method(fs, 'openSync', (...args) => {
    if (args[0] === file) throw Object.assign(Error('Injected denial'), { code, path: file });
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
    assert.equal(verdict.reason, namedIn(two.dir));
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

for (const code of ['EIO', 'EMFILE', 'ESTALE']) test(`T578 ${code} on a marker never says to remove it, and its path prints with no hidden character`, t => {
  const { env, one } = fixture(t);
  passing(one);
  const folder = 'two\x07-abc123', marker = join(env.SAGE_HOME, folder, MARKER);
  mkdirSync(join(env.SAGE_HOME, folder));
  writeFileSync(marker, '{}');
  const denied = denyOpen(t, marker, code);
  const verdict = mergeCheck(SHA, env, { project: one.project });
  denied();
  const shown = join(env.SAGE_HOME, 'two\\x07-abc123', MARKER);
  assert.deepEqual(verdict, { ok: false, reason: `the merge check cannot read ${shown} (${code}), so it refuses every merge. Ask the user to fix ${shown}.` });
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

test('T578 a read-only merge check never settles, and it counts a project with the commit only in its ledger', t => {
  const f = fixture(t, ['one', 'two']), { env, one, two } = f;
  passing(one); passing(two);
  savedUsage(t, two);
  const before = readFileSync(join(two.dir, MARKER), 'utf8');
  assert.equal(before.includes(SHA), false);
  for (const options of [{ readOnly: true }, { project: one.project }]) {
    const verdict = mergeCheck(SHA, env, options);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.reason, namedIn(two.dir));
  }
  assert.equal(readFileSync(join(two.dir, MARKER), 'utf8'), before);
  assert.deepEqual(readdirSync(two.dir).filter(name => name === '.lock'), []);
});
