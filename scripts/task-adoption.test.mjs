import './test-env.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, realpathSync, rmSync, chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { test } from 'node:test';
import { createStateTool } from '../packages/sage-core/state.mjs';

const SHA = '1'.repeat(40), BRANCH = 'sage/t536-adopt';
const tool = createStateTool({ defaultRoot: env => env.SAGE_HOME });
const snapshot = dir => Object.fromEntries(readdirSync(dir, { withFileTypes: true }).map(entry => [entry.name,
  entry.isDirectory() ? snapshot(join(dir, entry.name)) : readFileSync(join(dir, entry.name), 'utf8')]));
function fixture(t, sourceTask = 'T536', branch = BRANCH) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sage-adoption-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'project'); mkdirSync(project);
  const bin = join(root, 'bin'); mkdirSync(bin);
  const fake = join(bin, 'gh');
  writeFileSync(fake, `#!${process.execPath}\nif (process.argv[2] === '--fake-proof') { console.log('FAKE_adoption_gh'); } else if (process.argv.slice(2).join(' ') === 'pr view 362 --json headRefName,isCrossRepository') { console.log(JSON.stringify({headRefName:'${branch}',isCrossRepository:false})); } else { process.exit(1); }\n`);
  chmodSync(fake, 0o755);
  assert.equal(spawnSync(fake, ['--fake-proof'], { encoding: 'utf8' }).stdout.trim(), 'FAKE_adoption_gh');
  const sourceEnv = { ...process.env, SAGE_HOME: join(root, 'claude', 'sage') };
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, SAGE_HOME: join(root, 'codex', 'sage') };
  const command = (e, ...args) => tool.command([...args, '--project', project], e);
  const ok = (...args) => { const r = command(env, ...args); assert.equal(r.code, 0, r.text); return r.text; };
  const no = (...args) => { const r = command(env, ...args); assert.equal(r.code, 1, r.text); return r.text; };
  const source = command(sourceEnv, 'init').text.slice(8), dest = ok('init').slice(8);
  command(sourceEnv, 'task', 'add', '--title', 'Source', '--size', 'small', '--risk', 'auth', '--priority', 'P0');
  const path = join(source, 'tasks.tsv');
  const lines = readFileSync(path, 'utf8').trimEnd().split('\n'), cols = lines[0].split('\t');
  const row = Object.fromEntries(cols.map((key, i) => [key, lines[1].split('\t')[i] ?? '']));
  Object.assign(row, { id: sourceTask, branch: '', pr: '362', round: '4', state: 'reviewing' });
  writeFileSync(path, `${lines[0]}\n${cols.map(key => row[key]).join('\t')}\n`);
  const oldProof = [['checks-pass', '1'], ...['1', '2'].flatMap(cycle => ['review-clean', 'security-clean', 'qa-pass'].map(kind => [kind, cycle]))];
  writeFileSync(join(source, 'ledger.tsv'), `task\tpr\tsha\tkind\tcycle\trun\tat\n${oldProof.map(([kind, cycle]) => `${sourceTask}\t362\t${SHA}\t${kind}\t${cycle}\t\t2026-01-01T00:00:00Z`).join('\n')}\n`);
  ok('task', 'add', '--title', 'Destination', '--size', 'small', '--priority', 'P0');
  const adopt = ['task-adopt', 'T1', '--source-logbook', source, '--source-provider', 'claude', '--source-task', sourceTask, '--pr', '362', '--branch', branch];
  const bytes = dir => Object.fromEntries(readdirSync(dir).filter(n => n.endsWith('.tsv') || n === 'checkout.txt').map(n => [n, readFileSync(join(dir, n), 'utf8')]));
  const task = () => tool.read(dest, 'tasks')[0];
  const sourceOk = (...args) => { const r = command(sourceEnv, ...args); assert.equal(r.code, 0, r.text); return r.text; };
  return { root, project, source, dest, env, ok, no, adopt, bytes, task, sourceOk };
}

test('adoption preserves source identity, PR and spent rounds without copying source proof', t => {
  const s = fixture(t), before = s.bytes(s.source);
  assert.match(s.no('task', 'T1', 'set', `branch=${BRANCH}`), /not a branch of T1/);
  assert.match(s.ok(...s.adopt), /T1 adopted/);
  assert.equal(s.task().branch, BRANCH); assert.equal(s.task().pr, '362'); assert.equal(s.task().round, '4');
  assert.equal(s.task().risk, 'auth'); assert.equal(s.task().route, 'build,code-review,security-review,qa');
  const adoption = JSON.parse(s.task().adoption);
  assert.equal(adoption.provider, 'claude'); assert.equal(adoption.task, 'T536'); assert.equal(adoption.logbook, s.source);
  assert.equal(adoption.round, 4); assert.match(adoption.digest, /^[a-f0-9]{64}$/);
  assert.deepEqual(s.bytes(s.source), before);
  assert.equal(tool.read(s.dest, 'ledger').length, 0);
  assert.match(s.no('merge-check', '--sha', SHA, '--pr', '362', '--head', BRANCH), /no verdicts/);
  const saved = s.bytes(s.dest);
  assert.match(s.ok(...s.adopt), /already recorded/); assert.deepEqual(s.bytes(s.dest), saved);
  s.ok('task', 'T1', 'set', `branch=${BRANCH}`, 'state=briefed');
  const run = s.ok('run', 'add', 'T1', '--role', 'implementer', '--branch', BRANCH).split(' ')[0];
  assert.deepEqual(tool.captureRunAssignment({ project: s.project, task: 'T1', run, role: 'implementer' }, s.env),
    { task: 'T1', run: 'R1', role: 'implementer', round: 4, taskBranch: 'sage/t536-adopt', runBranch: 'sage/t536-adopt', candidate: '' });
  assert.equal(tool.read(s.dest, 'runs')[0].round, '4'); s.ok('run', 'done', run, '--status', 'done');
  s.ok('task', 'T1', 'set', 'state=building'); s.ok('task', 'T1', 'set', 'state=reviewing');
  s.ok('verdict', 'T1', '--sha', SHA, '--pr', '362', '--kind', 'checks-pass');
  assert.match(s.no('merge-check', '--sha', SHA, '--pr', '362', '--head', BRANCH), /review-clean|clean cycle/);
  for (const cycle of ['1', '2']) {
    for (const [role, kind] of [['code-reviewer', 'review-clean'], ['security-reviewer', 'security-clean'], ['qa', 'qa-pass']]) {
      const id = s.ok('run', 'add', 'T1', '--role', role, '--branch', BRANCH).split(' ')[0];
      s.ok('run', 'done', id, '--status', 'done', '--tokens', '1');
      if (role === 'qa') assert.match(s.no('verdict', 'T1', '--sha', SHA, '--pr', '362', '--kind', 'review-clean', '--cycle', cycle, '--run', id), /code-reviewer|qa/);
      s.ok('verdict', 'T1', '--sha', SHA, '--pr', '362', '--kind', kind, '--cycle', cycle, '--run', id);
    }
    if (cycle === '1') assert.match(s.no('merge-check', '--sha', SHA, '--pr', '362', '--head', BRANCH), /2|cycle/);
  }
  assert.match(s.ok('merge-check', '--sha', SHA, '--pr', '362', '--head', BRANCH), /2 clean cycles/);
  assert.match(s.no('merge-check', '--sha', '2'.repeat(40), '--pr', '362', '--head', BRANCH), /no verdicts/);
  const qa = s.ok('run', 'add', 'T1', '--role', 'qa').split(' ')[0]; s.ok('run', 'done', qa, '--status', 'done', '--tokens', '1');
  s.ok('finding', 'add', 'T1', '--source', 'qa', '--severity', 'high', '--summary', 'New failure', '--run', qa, '--class', 'state-edge');
  s.ok('finding', 'triage', 'T1', 'F-T1-1', 'fix');
  assert.match(s.ok('round', 'T1'), /held: 4 repair rounds/); assert.equal(s.task().round, '4');
  assert.match(s.ok(...s.adopt), /already recorded/); assert.equal(s.task().state, 'held');
  assert.deepEqual(s.bytes(s.source), before);
});

test('T48: one explicit approval grants adopted round five, never round six', t => {
  const s = fixture(t);
  s.ok(...s.adopt);
  for (const state of ['briefed', 'building', 'reviewing']) s.ok('task', 'T1', 'set', `state=${state}`);
  const run = s.ok('run', 'add', 'T1', '--role', 'qa').split(' ')[0];
  s.ok('run', 'done', run, '--status', 'done', '--tokens', '1');
  s.ok('finding', 'add', 'T1', '--source', 'qa', '--severity', 'medium', '--summary', 'Repair needed', '--run', run, '--class', 'state-edge');
  s.ok('finding', 'triage', 'T1', 'F-T1-1', 'fix');
  assert.match(s.ok('round', 'T1'), /held: 4 repair rounds/);
  let before = s.bytes(s.dest);
  assert.match(s.no('task', 'T1', 'set', 'state=building'), /approval/);
  assert.deepEqual(s.bytes(s.dest), before);
  const question = 'Approve one more repair round for T1 after 4 spent rounds and limit 3?';
  s.ok('gate', 'add', 'T1', '--question', question, '--options', 'approve|decline', '--recommend', 'approve');
  before = s.bytes(s.dest);
  assert.match(s.no('task', 'T1', 'set', 'state=building', 'approval=G1'), /approval/);
  assert.deepEqual(s.bytes(s.dest), before);
  s.ok('gate', 'answer', 'G1', '--option', '1');
  s.ok('task', 'T1', 'set', 'state=building', 'approval=G1');
  assert.equal(s.task().extra, '2');
  assert.equal(s.task().round, '4');
  before = s.bytes(s.dest);
  s.no('task', 'T1', 'set', 'state=building', 'approval=G1');
  assert.deepEqual(s.bytes(s.dest), before, 'a replay adds nothing');
  s.ok('task', 'T1', 'set', 'state=reviewing');
  assert.match(s.ok('round', 'T1'), /repairing · round 5 of 5/);
  s.ok('task', 'T1', 'set', 'state=reviewing');
  assert.match(s.ok('round', 'T1'), /held: 5 repair rounds/);
  before = s.bytes(s.dest);
  s.no('task', 'T1', 'set', 'state=briefed', 'approval=G1');
  assert.deepEqual(s.bytes(s.dest), before);
  assert.equal(s.task().pr, '362'); assert.equal(s.task().branch, BRANCH);
  assert.equal(JSON.parse(s.task().adoption).round, 4);
  assert.match(s.ok('config'), /max_rounds=3/);
});

test('T48: invalid approvals refuse the whole update; legacy allowances still count', t => {
  const s = fixture(t);
  s.ok(...s.adopt);
  const file = join(s.dest, 'tasks.tsv');
  const set = patch => {
    const [head] = readFileSync(file, 'utf8').split('\n');
    const row = { ...s.task(), ...patch };
    writeFileSync(file, `${head}\n${head.split('\t').map(key => row[key] ?? '').join('\t')}\n`);
  };
  set({ state: 'held', hold: 'round' });
  s.ok('task', 'add', '--title', 'Unrelated', '--size', 'small', '--priority', 'P1');
  const question = 'Approve one more repair round for T1 after 4 spent rounds and limit 3?';
  for (const [task, text, options, answer] of [
    ['T1', question, 'approve|decline', '2'],
    ['T2', question, 'approve|decline', '1'],
    ['T1', question.replace('4 spent', '3 spent'), 'approve|decline', '1'],
    ['T1', 'Please continue', 'approve|decline', '1'],
    ['T1', question, 'yes|no', '1'],
  ]) {
    const gate = s.ok('gate', 'add', task, '--question', text, '--options', options, '--recommend', options.split('|')[0]).split(' ')[0];
    s.ok('gate', 'answer', gate, '--option', answer);
    const before = snapshot(s.dest);
    assert.match(s.no('task', 'T1', 'set', 'title=Must not change', 'state=briefed', `approval=${gate}`), /approval/);
    assert.deepEqual(snapshot(s.dest), before);
  }
  for (const approval of ['', 'true', 'G999', 'G1,G2']) {
    const before = snapshot(s.dest);
    s.no('task', 'T1', 'set', 'state=building', `approval=${approval}`);
    assert.deepEqual(snapshot(s.dest), before);
  }
  // Simulate a saved allowance from the older tool, which had no approval record.
  const [head, first, other] = readFileSync(file, 'utf8').trimEnd().split('\n');
  const cells = first.split('\t'), cols = head.split('\t');
  cells[cols.indexOf('state')] = 'reviewing'; cells[cols.indexOf('hold')] = ''; cells[cols.indexOf('extra')] = '2';
  writeFileSync(file, `${head}\n${cells.join('\t')}\n${other}\n`);
  const run = s.ok('run', 'add', 'T1', '--role', 'qa').split(' ')[0];
  s.ok('run', 'done', run, '--status', 'done', '--tokens', '1');
  s.ok('finding', 'add', 'T1', '--source', 'qa', '--severity', 'medium', '--summary', 'Legacy repair', '--run', run, '--class', 'other');
  s.ok('finding', 'triage', 'T1', 'F-T1-1', 'fix');
  assert.match(s.ok('round', 'T1'), /round 5 of 5/);
  assert.equal(tool.read(s.dest, 'tasks')[1].round, '0');
  assert.equal(tool.read(s.dest, 'tasks')[1].extra, '');
});

test('inconsistent mappings and conflicting adoption refuse before any destination table changes', t => {
  const s = fixture(t);
  for (const [flag, value] of [['--source-task', 'T483'], ['--pr', '356'], ['--branch', 'sage/t483-other'], ['--branch', 'sage/t536-wrong-head'], ['--source-provider', '../bad']]) {
    const args = [...s.adopt]; args[args.indexOf(flag) + 1] = value;
    const before = s.bytes(s.dest); s.no(...args); assert.deepEqual(s.bytes(s.dest), before);
  }
  s.ok(...s.adopt);
  for (const field of ['pr=356', 'branch=sage/t536-another']) {
    const saved = s.bytes(s.dest); assert.match(s.no('task', 'T1', 'set', field), /adoption/); assert.deepEqual(s.bytes(s.dest), saved);
  }
  const args = [...s.adopt]; args[args.indexOf('--branch') + 1] = 'sage/t536-other';
  const before = s.bytes(s.dest); assert.match(s.no(...args), /adoption/); assert.deepEqual(s.bytes(s.dest), before);
});

test('adoption refuses another task claim and another project', t => {
  const s = fixture(t);
  s.ok('task', 'add', '--title', 'Other', '--size', 'tiny', '--priority', 'P1'); s.ok('task', 'T2', 'set', 'pr=362');
  let before = s.bytes(s.dest); assert.match(s.no(...s.adopt), /T2|claimed/); assert.deepEqual(s.bytes(s.dest), before);
  writeFileSync(join(s.source, 'checkout.txt'), `${join(s.root, 'other-project')}\n`);
  before = s.bytes(s.dest); assert.match(s.no(...s.adopt), /project/); assert.deepEqual(s.bytes(s.dest), before);
});

test('adoption refuses destination ownership by task number without any mutation', t => {
  const s = fixture(t, 'T2', 'sage/t2-existing');
  s.ok('task', 'add', '--title', 'Unrelated destination task', '--size', 'tiny', '--priority', 'P1');
  const other = tool.read(s.dest, 'tasks').find(task => task.id === 'T2');
  assert.equal(other.pr, ''); assert.equal(other.branch, '');
  assert.deepEqual(tool.read(s.dest, 'runs'), []);
  const destination = snapshot(s.dest), source = snapshot(s.source);
  const result = tool.command([...s.adopt, '--project', s.project], s.env);
  assert.deepEqual(snapshot(s.dest), destination, `refused adoption must leave every destination file unchanged: ${result.text}`);
  assert.deepEqual(snapshot(s.source), source);
  assert.equal(result.code, 1, result.text);
  assert.match(result.text, /T2 already claimed this PR or branch/);
});

test('adoption refuses source run-only ownership without any mutation', t => {
  const s = fixture(t);
  s.sourceOk('task', 'add', '--title', 'Other source task', '--size', 'small', '--priority', 'P1');
  const run = s.sourceOk('run', 'add', 'T537', '--role', 'implementer', '--branch', BRANCH).split(' ')[0];
  s.sourceOk('run', 'done', run, '--status', 'done', '--tokens', '1');
  const other = tool.read(s.source, 'tasks').find(task => task.id === 'T537');
  assert.equal(other.pr, ''); assert.equal(other.branch, '');
  const destination = snapshot(s.dest), source = snapshot(dirname(s.source));
  const result = tool.command([...s.adopt, '--project', s.project], s.env);
  assert.deepEqual(snapshot(s.dest), destination, `refused adoption must leave every destination file unchanged: ${result.text}`);
  assert.deepEqual(snapshot(dirname(s.source)), source);
  assert.equal(result.code, 1, result.text);
  assert.match(result.text, /T537 also claims the source PR or branch/);
});

test('adoption preserves the source configured cycle minimum and stronger destination requirements', t => {
  const s = fixture(t), sourceConfig = join(dirname(s.source), 'config.json');
  writeFileSync(sourceConfig, JSON.stringify({ 'cycles.risk': 3 }));
  const source = snapshot(dirname(s.source));
  s.ok(...s.adopt);
  assert.deepEqual(snapshot(dirname(s.source)), source);
  s.ok('task', 'T1', 'set', 'state=briefed');
  s.ok('task', 'T1', 'set', 'state=building'); s.ok('task', 'T1', 'set', 'state=reviewing');
  s.ok('verdict', 'T1', '--sha', SHA, '--pr', '362', '--kind', 'checks-pass');
  const cycle = number => {
    for (const [role, kind] of [['code-reviewer', 'review-clean'], ['security-reviewer', 'security-clean'], ['qa', 'qa-pass']]) {
      const id = s.ok('run', 'add', 'T1', '--role', role, '--branch', BRANCH).split(' ')[0];
      s.ok('run', 'done', id, '--status', 'done', '--tokens', '1');
      s.ok('verdict', 'T1', '--sha', SHA, '--pr', '362', '--kind', kind, '--cycle', String(number), '--run', id);
    }
  };
  const merge = ['merge-check', '--sha', SHA, '--pr', '362', '--head', BRANCH];
  cycle(1); cycle(2);
  assert.match(s.no(...merge), /3|cycle/);
  assert.equal(JSON.parse(s.task().adoption).cycles, 3);
  const saved = snapshot(s.dest);
  writeFileSync(sourceConfig, JSON.stringify({ 'cycles.risk': 2 }));
  assert.match(s.ok(...s.adopt), /already recorded/);
  assert.deepEqual(snapshot(s.dest), saved);
  assert.match(s.no(...merge), /3|cycle/);
  cycle(3); assert.match(s.ok(...merge), /3 clean cycles/);
  writeFileSync(join(dirname(s.dest), 'config.json'), JSON.stringify({ 'cycles.risk': 4 }));
  assert.match(s.no(...merge), /4|cycle/);
  cycle(4); assert.match(s.ok(...merge), /4 clean cycles/);
});

test('an ended blocked preparation does not prevent adoption or become review proof', t => {
  const s = fixture(t);
  const run = s.ok('run', 'add', 'T1', '--role', 'implementer', '--branch', BRANCH).split(' ')[0];
  const before = s.bytes(s.dest);
  assert.match(s.no(...s.adopt), /only ended blocked or failed runs/); assert.deepEqual(s.bytes(s.dest), before);
  s.ok('run', 'done', run, '--status', 'blocked');
  assert.match(s.ok(...s.adopt), /T1 adopted/);
  assert.equal(tool.read(s.dest, 'runs')[0].status, 'blocked');
  assert.equal(s.task().round, '4');
  assert.match(s.no('verdict', 'T1', '--sha', SHA, '--pr', '362', '--kind', 'review-clean', '--run', run), /fresh done code-reviewer/);
  assert.equal(tool.read(s.dest, 'ledger').length, 0);
});
