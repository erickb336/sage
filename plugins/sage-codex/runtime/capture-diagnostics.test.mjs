import '../../../scripts/test-env.mjs';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as provider from '../../../plugins/sage-codex/skills/sage/sage.mjs';
import { bindChild, reportGate } from '../../../plugins/sage-codex/hooks/report-gate.mjs';
const { tool } = provider;
const text = 'STATUS done\nRESULT CLEAN\nEVIDENCE private-report-sentinel\nFINDINGS none\nQUESTIONS none\nNOT VERIFIED none\nBRANCH none';
function fixture(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'capture-sample-'))), finalizers = [];
  t.after(async () => { for (const finalize of finalizers) await finalize(); rmSync(dir, { recursive: true, force: true }); });
  const project = join(dir, 'project'); mkdirSync(project);
  const env = { ...process.env, HOME: join(dir, 'home'), CODEX_HOME: join(dir, 'private-env-sentinel'), SAGE_HOME: join(dir, 'sage') };
  const command = (...args) => tool.command([...args, '--project', project], env);
  assert.equal(command('init').code, 0);
  assert.equal(command('task', 'add', '--title', 'Sample', '--size', 'small', '--priority', 'P2').code, 0);
  assert.equal(command('run', 'add', 'T1', '--role', 'code-reviewer').code, 0);
  const transcript = join(dir, 'private-transcript-sentinel');
  const meta = { id: 'private-native-id-sentinel', agent_path: '/root/sage_code_reviewer_t1_r1' };
  const writeMeta = (m = meta) => writeFileSync(transcript, JSON.stringify({ type: 'session_meta', payload: m }) + '\nprivate-content-sentinel\n'); writeMeta();
  const input = { hook_event_name: 'SubagentStop', cwd: project, agent_transcript_path: transcript, stop_hook_active: false, last_assistant_message: text, agent_id: meta.id, session_id: 'private-parent-sentinel' };
  assert.ok(provider.diagnostics, 'the provider exposes the bounded diagnostic control');
  const d = provider.diagnostics;
  const start = () => bindChild(transcript, project, env, input);
  const stop = (fields = {}) => reportGate({ ...input, ...fields }, env);
  const enable = () => d.control(project, 'T1', 'R1', 'start', env);
  const read = () => d.read(project, 'T1', env);
  return { dir, finalizers, project, env, command, transcript, meta, writeMeta, input, d, start, stop, enable, read, file: join(env.SAGE_HOME, 'capture-diagnostics', 'window.json') };
}
test('T54 diagnostics: default off; opt-in keeps sanitized capture outcomes and exposes scoped reads', t => {
  const f = fixture(t); f.start(); assert.deepEqual(f.stop(), {});
  assert.equal(f.read().status, 'disabled'); assert.equal(existsSync(f.file), false);
  f.enable(); f.start(); assert.deepEqual(f.stop(), {});
  const result = f.read(); assert.equal(result.observation, 'observed'); assert.ok(result.records.length >= 2);
  assert.equal(result.records.at(-1).reason, 'DUPLICATE_REPORT');
  assert.match(f.command('task', 'T1').text, /capture diagnostics/);
  const saved = readFileSync(f.file, 'utf8');
  for (const sentinel of ['private-', f.dir, f.transcript, text, 'sha256', 'prompt']) assert.equal(saved.includes(sentinel), false, sentinel);
  assert.equal(statSync(f.file).mode & 0o777, 0o600); assert.equal(statSync(join(f.env.SAGE_HOME, 'capture-diagnostics')).mode & 0o777, 0o700);
});
test('T54 diagnostics: another project/run and unknown identity do not write observations', t => {
  const f = fixture(t); f.enable(); const before = readFileSync(f.file, 'utf8');
  f.writeMeta({ ...f.meta, agent_path: '/root/sage_code_reviewer_t1_r2' }); f.start(); f.stop();
  f.writeMeta({ id: 'parent' }); f.start(); f.stop();
  f.writeMeta(); f.stop({ cwd: f.dir }); f.stop({ agent_transcript_path: null });
  assert.equal(readFileSync(f.file, 'utf8'), before); assert.equal(f.d.read(f.dir, 'T1', f.env).status, 'disabled');
  assert.equal(f.read().observation, 'no_observation');
});
test('T54 diagnostics: no Start still refuses capture and verdict; missing fields remain blocked', t => {
  const f = fixture(t); f.enable(); assert.match(f.stop().systemMessage, /no child started/);
  assert.equal(f.read().records.at(-1).reason, 'MISSING_BINDING');
  f.start(); assert.equal(f.stop({ last_assistant_message: 'STATUS done' }).decision, 'block');
  assert.equal(f.read().records.at(-1).reason, 'INCOMPLETE_REPORT');
  f.command('run', 'done', 'R1', '--status', 'done', '--tokens', '1');
  assert.match(f.command('verdict', 'T1', '--run', 'R1', '--kind', 'review-clean', '--sha', '1'.repeat(40)).text, /no kept report/);
  assert.equal(existsSync(f.file), false); assert.match(f.stop().systemMessage, /ended as done/);
});
test('T54 diagnostics: conflicting child and report retain existing refusal', t => {
  const f = fixture(t); f.enable(); f.start(); assert.deepEqual(f.stop(), {});
  assert.match(f.stop({ last_assistant_message: text + '\nchanged' }).systemMessage, /already has a kept report/);
  assert.equal(f.read().records.at(-1).reason, 'CONFLICTING_REPORT');
  f.writeMeta({ ...f.meta, id: 'another-child' }); assert.match(f.stop().systemMessage, /not the child/);
  assert.equal(f.read().records.at(-1).reason, 'BINDING_MISMATCH');
});
test('T54 diagnostics: both caps preserve the earliest records and signal saturation', t => {
  const f = fixture(t); f.enable(); f.start();
  for (let n = 0; n < 80; n++) f.stop();
  const r = f.read(); assert.equal(r.status, 'saturated'); assert.ok(r.records.length <= 64 && r.records.length > 0);
  assert.equal(r.records[0].event, 'start'); assert.ok(statSync(f.file).size <= 65536);
  const before = readFileSync(f.file, 'utf8'); f.stop(); assert.equal(readFileSync(f.file, 'utf8'), before);
});
test('T54 diagnostics: expiry on read/use and explicit end remove only this window', t => {
  const f = fixture(t); f.enable(); const unrelated = join(f.env.SAGE_HOME, 'keep-me'); writeFileSync(unrelated, 'sample');
  let window = JSON.parse(readFileSync(f.file, 'utf8')); window.expires = 1; writeFileSync(f.file, JSON.stringify(window));
  assert.equal(f.read().status, 'expired'); assert.equal(existsSync(f.file), false);
  f.enable(); window = JSON.parse(readFileSync(f.file, 'utf8')); window.expires = 1; writeFileSync(f.file, JSON.stringify(window));
  f.command('standing'); assert.equal(existsSync(f.file), false);
  f.enable(); assert.throws(() => f.d.control(f.dir, 'T1', 'R1', 'end', f.env));
  assert.equal(existsSync(f.file), true); f.d.control(f.project, 'T1', 'R1', 'end', f.env);
  assert.equal(existsSync(f.file), false); assert.equal(readFileSync(unrelated, 'utf8'), 'sample');
});
test('T54 diagnostics: unreadable storage and write/lock failures never alter capture', t => {
  const f = fixture(t); f.enable(); const before = readFileSync(f.file, 'utf8');
  mkdirSync(join(f.env.SAGE_HOME, 'capture-diagnostics', '.lock'));
  writeFileSync(join(f.env.SAGE_HOME, 'capture-diagnostics', '.lock', 'unknown-owner'), 'sample'); f.start(); assert.deepEqual(f.stop(), {});
  assert.equal(readFileSync(f.file, 'utf8'), before);
  rmSync(join(f.env.SAGE_HOME, 'capture-diagnostics', '.lock'), { recursive: true });
  writeFileSync(f.file, '{invalid private-error-sentinel'); assert.equal(f.read().status, 'unreadable'); assert.deepEqual(f.stop(), {});
  rmSync(f.file); mkdirSync(f.file); assert.deepEqual(f.stop(), {}); assert.equal(f.read().status, 'unreadable');
});
test('T54 diagnostics: field types do not retain values', t => {
  const f = fixture(t); f.enable(); f.start(); f.stop({ last_assistant_message: null, stop_hook_active: true });
  const r = f.read().records.at(-1); assert.equal(r.fields.last_assistant_message, 'null');
  assert.equal(r.fields.transcript_path, 'absent'); assert.equal(r.fields.agent_id, 'valid_type');
});

test('T54 diagnostics: a preexisting temporary file survives a diagnostic write failure', t => {
  const f = fixture(t); f.enable(); const temporary = join(f.env.SAGE_HOME, 'capture-diagnostics', 'next');
  writeFileSync(temporary, 'unrelated sentinel'); const before = readFileSync(f.file, 'utf8');
  f.start(); assert.deepEqual(f.stop(), {});
  assert.equal(readFileSync(temporary, 'utf8'), 'unrelated sentinel'); assert.equal(readFileSync(f.file, 'utf8'), before);
});
test('T54 diagnostics: wrong field types and conflicting Start binding remain bounded', t => {
  const f = fixture(t); f.enable();
  bindChild(f.transcript, f.project, f.env, { ...f.input, agent_id: 42 });
  let r = f.read().records.at(-1); assert.equal(r.fields.agent_id, 'wrong_type'); assert.equal(r.reason, 'BOUND');
  f.writeMeta({ ...f.meta, id: 'other-sentinel' });
  bindChild(f.transcript, f.project, f.env, { ...f.input, agent_id: 'other-sentinel' });
  r = f.read().records.at(-1); assert.equal(r.reason, 'CONFLICTING_BINDING'); assert.equal(r.binding, 'different');
  assert.equal(readFileSync(f.file, 'utf8').includes('sentinel'), false);
});
test('T54 diagnostics: labeled sample output comes only from a disposable fixture', t => {
  const f = fixture(t); f.enable(); f.stop();
  console.log('SAMPLE DATA ' + JSON.stringify({ sample: true, ...f.read() }));
});

test('T54 diagnostics: expired temporary leftovers are pruned and scoped CLI reports expiry', t => {
  const f = fixture(t); f.enable(); f.start();
  const window = JSON.parse(readFileSync(f.file, 'utf8')); window.expires = 1;
  writeFileSync(f.file, JSON.stringify(window));
  const temporary = join(f.env.SAGE_HOME, 'capture-diagnostics', 'next'); writeFileSync(temporary, JSON.stringify(window), { mode: 0o600 });
  assert.match(f.command('task', 'T1').text, /"status":"expired"/);
  assert.equal(existsSync(f.file), false); assert.equal(existsSync(temporary), false);
});


// R792/R793: these commands run the real CLI with disposable project selection.
const cliPath = fileURLToPath(new URL('../../../plugins/sage-codex/skills/sage/sage.mjs', import.meta.url));
function cli(f, args, selection = 'explicit') {
  const env = { ...f.env }; delete env.SAGE_PROJECT;
  if (selection === 'environment') env.SAGE_PROJECT = f.project;
  const result = spawnSync(process.execPath, [cliPath, ...args,
    ...(selection === 'explicit' ? ['--project', f.project] : selection === 'equals' ? [`--project=${f.project}`] : [])],
  { env, cwd: selection === 'cwd' ? f.project : f.dir, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
for (const selection of ['explicit', 'equals', 'environment', 'cwd']) test(`T54 cleanup regression: CLI completion selects ${selection}`, t => {
  const f = fixture(t); f.enable(); f.start();
  const unrelated = join(f.env.SAGE_HOME, 'keep-me'); writeFileSync(unrelated, 'sample unrelated data');
  assert.match(cli(f, ['run', 'done', 'R1', '--status', 'done', '--tokens', '1'], selection), /R1 done/);
  assert.equal(existsSync(f.file), false, 'completion removes the selected window immediately');
  assert.match(cli(f, ['task', 'T1']), /"status":"disabled"/);
  assert.equal(readFileSync(unrelated, 'utf8'), 'sample unrelated data');
});
test('T54 cleanup regression: another project completion preserves the selected window', t => {
  const f = fixture(t); f.enable(); f.start();
  const other = join(f.dir, 'other'); mkdirSync(other);
  for (const args of [['init'], ['task', 'add', '--title', 'Other', '--size', 'small', '--priority', 'P2'],
    ['run', 'add', 'T1', '--role', 'code-reviewer'], ['run', 'done', 'R1', '--status', 'done', '--tokens', '1']]) {
    assert.equal(tool.command([...args, '--project', other], f.env).code, 0);
  }
  const before = readFileSync(f.file, 'utf8');
  assert.match(cli(f, ['board', 'T1', '--view', 'task']), /"status":"active"/);
  assert.equal(readFileSync(f.file, 'utf8'), before);
});

async function writer(t, f, abandon = false) {
  const folder = join(f.env.SAGE_HOME, 'capture-diagnostics'), release = join(f.dir, 'release-writer');
  const source = join(f.dir, 'sample-writer.mjs');
  writeFileSync(source, `import { tool } from ${JSON.stringify(new URL('../../../plugins/sage-codex/skills/sage/sage.mjs', import.meta.url).href)};
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
tool.withLock(${JSON.stringify(folder)}, () => {
  // Exercise the original bare lock and the shared owner-aware replacement.
  mkdirSync(join(${JSON.stringify(folder)}, 'lock'));
  writeFileSync(join(${JSON.stringify(folder)}, 'next'), readFileSync(${JSON.stringify(f.file)}), { mode: 0o600 });
  process.send('locked');
  if (${abandon}) process.exit(0);
  while (!existsSync(${JSON.stringify(release)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  renameSync(join(${JSON.stringify(folder)}, 'next'), ${JSON.stringify(f.file)});
  rmdirSync(join(${JSON.stringify(folder)}, 'lock'));
});`);
  const child = spawn(process.execPath, [source], { env: f.env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const ended = new Promise(resolve => child.once('exit', resolve));
  f.finalizers.push(async () => { if (child.exitCode === null) writeFileSync(release, 'release'); await ended; });
  await new Promise((resolve, reject) => { child.once('message', resolve); child.once('error', reject); });
  return { child, ended, release, lock: join(folder, '.lock'), temporary: join(folder, 'next') };
}
test('T54 cleanup regression: live writer completion is retried on the next supported use', async t => {
  const f = fixture(t); f.enable(); f.start();
  const pending = f.d.begin(f.project, { task: 'T1', run: 'R1' }, f.input, 'stop', f.env);
  const w = await writer(t, f);
  assert.match(cli(f, ['run', 'done', 'R1', '--status', 'done', '--tokens', '1']), /R1 done/);
  assert.equal(existsSync(w.lock), true, 'completion never unlocks a live writer');
  writeFileSync(w.release, 'release'); assert.equal(await w.ended, 0);
  assert.match(cli(f, ['task', 'T1']), /"status":"disabled"/);
  assert.equal(existsSync(f.file), false, 'next supported use removes a completed window');
  assert.equal(existsSync(w.temporary), false);
  pending.finish(); assert.equal(existsSync(f.file), false, 'an earlier observation cannot resurrect a completed window');
});
for (const terminal of ['completed', 'expired']) test(`T54 cleanup regression: abandoned writer ${terminal} window is removed on next use`, async t => {
  const f = fixture(t); f.enable(); f.start();
  if (terminal === 'expired') {
    const data = JSON.parse(readFileSync(f.file, 'utf8')); data.expires = 1; writeFileSync(f.file, JSON.stringify(data));
  }
  const w = await writer(t, f, true); assert.equal(await w.ended, 0);
  const previous = process.env.SAGE_TEST_PIDS;
  process.env.SAGE_TEST_PIDS = JSON.stringify({ [w.child.pid]: null });
  t.after(() => { if (previous === undefined) delete process.env.SAGE_TEST_PIDS; else process.env.SAGE_TEST_PIDS = previous; });
  if (terminal === 'completed') assert.equal(f.command('run', 'done', 'R1', '--status', 'done', '--tokens', '1').code, 0);
  assert.equal(f.command('standing').code, 0);
  assert.equal(existsSync(f.file), false, 'supported use recovers the abandoned lock and removes observations');
  assert.equal(existsSync(w.temporary), false);
  assert.equal(existsSync(w.lock), false);
  assert.equal(f.read().status, 'disabled');
});
test('T54 cleanup regression: a pending observation cannot resurrect an expired window', t => {
  const f = fixture(t); f.enable();
  const pending = f.d.begin(f.project, { task: 'T1', run: 'R1' }, f.input, 'stop', f.env);
  const data = JSON.parse(readFileSync(f.file, 'utf8')); data.expires = 1; writeFileSync(f.file, JSON.stringify(data));
  assert.match(cli(f, ['task', 'T1']), /"status":"expired"/);
  pending.finish(); assert.equal(existsSync(f.file), false);
});
