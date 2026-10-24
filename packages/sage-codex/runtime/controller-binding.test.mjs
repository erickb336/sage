import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {bindPolicy, bindTask, bindTurnText, resolveControllerBinary, turnOutcome} from './controller-binding.mjs';
import {OWNED_LAUNCH_ARGS} from './controller-process.mjs';

const dir = realpathSync(mkdtempSync(join(tmpdir(), 'sage-binding-')));
test.after(() => rmSync(dir, {recursive: true, force: true}));
const binary = join(dir, 'codex');
writeFileSync(binary, 'synthetic controller bytes'); chmodSync(binary, 0o755);
const digest = createHash('sha256').update('synthetic controller bytes').digest('hex');

test('resolveControllerBinary refuses each bad path with its fixed code', () => {
  mkdirSync(join(dir, 'folder'));
  symlinkSync(binary, join(dir, 'link'));
  writeFileSync(join(dir, 'plain'), 'x'); chmodSync(join(dir, 'plain'), 0o644);
  for (const [env, code] of [
    [{}, 'binary-unset'], [{SAGE_CODEX_CONTROLLER_BIN: ''}, 'binary-unset'], [{SAGE_CODEX_CONTROLLER_BIN: 'bin/codex'}, 'binary-relative'],
    [{SAGE_CODEX_CONTROLLER_BIN: join(dir, 'folder')}, 'binary-not-file'], [{SAGE_CODEX_CONTROLLER_BIN: join(dir, 'link')}, 'binary-not-file'],
    [{SAGE_CODEX_CONTROLLER_BIN: join(dir, 'missing')}, 'binary-not-file'], [{SAGE_CODEX_CONTROLLER_BIN: join(dir, 'plain')}, 'binary-not-executable'],
    [{SAGE_CODEX_CONTROLLER_BIN: binary, SAGE_CODEX_CONTROLLER_SHA256: 'c'.repeat(64)}, 'binary'],
    [{SAGE_CODEX_CONTROLLER_BIN: binary, SAGE_CODEX_CONTROLLER_SHA256: digest.toUpperCase()}, 'binary'],
  ]) assert.throws(() => resolveControllerBinary(env), error => error.code === code, `${JSON.stringify(env)} gives ${code}`);
});

test('resolveControllerBinary returns the path and the file hash, and reads only its two variables', () => {
  const reads = [];
  const env = new Proxy({SAGE_CODEX_CONTROLLER_BIN: binary, SAGE_CODEX_BIN: '/other/codex', PATH: dir}, {get(target, key) { reads.push(key); return target[key]; }});
  assert.deepEqual(resolveControllerBinary(env), {path: binary, sha256: digest, expectedSha256: null});
  assert.deepEqual(reads, ['SAGE_CODEX_CONTROLLER_BIN', 'SAGE_CODEX_CONTROLLER_SHA256']);
  assert.deepEqual(resolveControllerBinary({SAGE_CODEX_CONTROLLER_BIN: binary, SAGE_CODEX_CONTROLLER_SHA256: digest}), {path: binary, sha256: digest, expectedSha256: digest});
  // SAGE_CODEX_BIN and PATH alone never select a controller.
  assert.throws(() => resolveControllerBinary({SAGE_CODEX_BIN: binary, PATH: dir}), error => error.code === 'binary-unset');
});

const valid = {project: '/work/project', task: 'T400', run: 'R1461', instructions: 'Chief instructions.'};
test('bindTask refuses each bad field and keeps the instructions hash, not a copy', () => {
  for (const change of [{project: 'work/project'}, {project: '/work/project/'}, {project: '/work/../work/project'}, {project: '/other'},
    {task: 'T0400'}, {task: 't400'}, {task: 'T'}, {run: 'R01'}, {run: 'R1x'}, {instructions: ''}, {instructions: 'a\0b'},
    {instructions: 'a'.repeat(256 * 1024 + 1)}, {extra: 1}]) assert.throws(() => bindTask({...valid, ...change}, '/work/project'), error => error.code === 'task', JSON.stringify(change).slice(0, 80));
  assert.throws(() => bindTask(Object.create(valid), '/work/project'), error => error.code === 'task');
  const record = bindTask(valid, '/work/project');
  assert.deepEqual(record, {project: '/work/project', task: 'T400', run: 'R1461', instructionsSha256: createHash('sha256').update('Chief instructions.').digest('hex')});
  assert.ok(Object.isFrozen(record));
  assert.equal(JSON.stringify(record).includes('Chief instructions.'), false);
});

test('bindTurnText gives the hash of a valid text and refuses empty, NUL and over 64 KiB', () => {
  assert.equal(bindTurnText('hello'), createHash('sha256').update('hello').digest('hex'));
  assert.equal(bindTurnText('a'.repeat(64 * 1024)).length, 64);
  for (const text of ['', 'a\0', 'a'.repeat(64 * 1024 + 1), 5]) assert.throws(() => bindTurnText(text), error => error.code === 'turn-text');
});

const sessionFlags = {name: {type: 'sessionFlags'}, version: 'sha256:x'};
const user = {name: {type: 'user', file: '/home/config.toml', profile: null}, version: 'sha256:y'};
function observed() {
  return {
    binary: {path: '/bin/codex', sha256: digest}, args: OWNED_LAUNCH_ARGS, initialize: {userAgent: 'sage_controller/0.160.0'},
    config: {
      config: {model: 'gpt-x', model_provider: 'openai', approval_policy: 'on-request', sandbox_mode: 'workspace-write', web_search: 'disabled', agents: {enabled: true},
        features: {multi_agent: false, multi_agent_v2: true, goals: false, plugins: false, apps: false, remote_plugin: false}},
      origins: {'agents.enabled': sessionFlags, 'features.multi_agent': sessionFlags, 'features.multi_agent_v2.enabled': sessionFlags, 'features.goals': sessionFlags,
        web_search: sessionFlags, 'features.plugins': sessionFlags, 'features.apps': sessionFlags, 'features.remote_plugin': sessionFlags,
        model: user, model_provider: user, approval_policy: user, sandbox_mode: user},
    },
    thread: {thread: {id: 'root-1', cliVersion: '0.160.0', ephemeral: true, parentThreadId: null, cwd: '/work/project'},
      model: 'gpt-x', modelProvider: 'openai', approvalPolicy: 'on-request', sandbox: {type: 'workspaceWrite', writableRoots: ['/work/project'], networkAccess: false}, multiAgentMode: 'explicitRequestOnly'},
    task: bindTask(valid, '/work/project'),
  };
}
const refusalCode = (edit) => { const value = observed(); edit(value); try { bindPolicy(value); return 'pass'; } catch (error) { return error.code; } };

test('bindPolicy passes the owned profile and records the owner selection with its origins and one binding hash', () => {
  const policy = bindPolicy(observed());
  assert.deepEqual(policy.selection, {model: {value: 'gpt-x', origin: 'user'}, modelProvider: {value: 'openai', origin: 'user'},
    approvalPolicy: {value: 'on-request', origin: 'user'}, sandbox: {value: {type: 'workspaceWrite', writableRoots: ['/work/project'], networkAccess: false}, origin: 'user'}});
  assert.equal(policy.threadId, 'root-1'); assert.equal(policy.cliVersion, '0.160.0'); assert.equal(policy.multiAgentMode, 'explicitRequestOnly');
  assert.deepEqual(policy.binary, {path: '/bin/codex', sha256: digest}); assert.deepEqual(policy.args, [...OWNED_LAUNCH_ARGS]);
  assert.match(policy.bindingHash, /^[0-9a-f]{64}$/);
  assert.equal(bindPolicy(observed()).bindingHash, policy.bindingHash);
  assert.equal(refusalCode(() => {}), 'pass');
  const other = observed(); other.thread.thread.id = 'root-2';
  assert.notEqual(bindPolicy(other).bindingHash, policy.bindingHash);
  assert.ok(Object.isFrozen(policy) && Object.isFrozen(policy.selection.sandbox.value));
});

test('bindPolicy: one case for each refusal row', () => {
  const rows = [
    ['an owned value differs', value => { value.config.config.features.goals = true; }, 'policy-value'],
    ['an owned value comes from a managed layer', value => { value.config.origins['features.apps'] = {name: {type: 'system', file: '/etc/codex/managed_config.toml'}}; }, 'policy-origin'],
    ['the v2 switch comes from the user layer', value => { value.config.origins['features.multi_agent_v2.enabled'] = user; }, 'policy-origin'],
    ['an owned key is missing from config', value => { delete value.config.config.web_search; }, 'policy-missing'],
    ['an owned key is missing from origins', value => { delete value.config.origins['agents.enabled']; }, 'policy-missing'],
    ['no origins at all', value => { delete value.config.origins; }, 'policy-missing'],
    ['cliVersion 0.161.0', value => { value.thread.thread.cliVersion = '0.161.0'; }, 'version'],
    ['not ephemeral', value => { value.thread.thread.ephemeral = false; }, 'not-ephemeral'],
    ['a child thread', value => { value.thread.thread.parentThreadId = 'parent'; }, 'not-root'],
    ['another cwd', value => { value.thread.thread.cwd = '/elsewhere'; }, 'cwd'],
    ['another model', value => { value.thread.model = 'gpt-y'; }, 'selection-changed'],
    ['another provider', value => { value.thread.modelProvider = 'other'; }, 'selection-changed'],
    ['another approval policy', value => { value.thread.approvalPolicy = 'never'; }, 'selection-changed'],
    ['another sandbox', value => { value.thread.sandbox = {type: 'dangerFullAccess'}; }, 'selection-changed'],
    ['no sandbox in the reply', value => { delete value.thread.sandbox; }, 'selection-changed'],
    ['an expected hash that differs', value => { value.binary.expectedSha256 = 'c'.repeat(64); }, 'binary'],
    ['no binary hash', value => { delete value.binary.sha256; }, 'binary'],
  ];
  for (const [name, edit, code] of rows) assert.equal(refusalCode(edit), code, name);
  // Passing variants: the v2 switch as a table, an absent selection key kept with the default origin, and a matching hash.
  assert.equal(refusalCode(value => { value.config.config.features.multi_agent_v2 = {enabled: true, subagent_usage_hint_text: 'keep'}; }), 'pass');
  assert.equal(refusalCode(value => { value.config.config.features.multi_agent_v2 = {enabled: false}; }), 'policy-value');
  assert.equal(refusalCode(value => { value.binary.expectedSha256 = digest; }), 'pass');
  const value = observed(); delete value.config.config.approval_policy; delete value.config.origins.approval_policy; value.thread.approvalPolicy = 'never';
  assert.deepEqual(bindPolicy(value).selection.approvalPolicy, {value: 'never', origin: 'default'});
});

const root = 'root-1', bound = 'turn-1';
const event = (method, params) => ({seq: 1, kind: 'notification', method, message: {method, params}});
const done = (status, extra = {}) => event('turn/completed', {threadId: root, turn: {id: bound, status, items: [], error: null, ...extra}});
const run = (...messages) => messages.reduce((state, message) => turnOutcome(state, message), {threadId: root});
const reply = {type: 'reply', turnId: bound};

test('turnOutcome: one case for each row of the terminal table', () => {
  const agent = {type: 'agentMessage', id: 'm', text: 'final words'};
  assert.equal(run(reply).result, null, 'a turn/start acknowledgement is never a completion');
  assert.deepEqual([run(reply, {type: 'event', event: done('completed', {items: [agent]})})].map(s => [s.result, s.lastAgentMessage]), [['completed', 'final words']]);
  assert.equal(run(reply, {type: 'event', event: done('interrupted')}).result, 'interrupted');
  const failed = run(reply, {type: 'event', event: done('failed', {error: {message: 'model failed'}})});
  assert.deepEqual([failed.result, failed.error], ['failed', {message: 'model failed'}]);
  const early = run({type: 'event', event: done('completed')});
  assert.equal(early.result, null, 'held before the reply');
  assert.equal(turnOutcome(early, reply).result, 'completed');
  const child = run(reply, {type: 'event', event: event('turn/completed', {threadId: 'child', turn: {id: bound, status: 'completed'}})},
    {type: 'event', event: event('turn/completed', {threadId: root, turn: {id: 'other', status: 'completed'}})});
  assert.equal(child.result, null, 'a child or another turn is an event only');
  const twice = run(reply, {type: 'event', event: done('completed')}, {type: 'event', event: done('completed')});
  assert.deepEqual([twice.result, twice.error.reason], ['uncertain', 'Conflicting terminal events for the bound turn']);
  const refused = run({type: 'refused', error: {code: -32600, message: 'no'}});
  assert.deepEqual([refused.result, refused.error], ['refused', {code: -32600, message: 'no'}]);
  for (const reason of ['Owned process closed', 'Invalid or oversized protocol frame', 'Event limit exceeded']) {
    const lost = run(reply, {type: 'lost', reason});
    assert.deepEqual([lost.result, lost.error], ['uncertain', {reason}]);
  }
  const timed = run(reply, {type: 'deadline'});
  assert.deepEqual([timed.result, timed.timedOut], [null, true]);
  assert.deepEqual([turnOutcome(timed, {type: 'event', event: done('interrupted')})].map(s => [s.result, s.timedOut]), [['interrupted', true]]);
  assert.deepEqual([turnOutcome(timed, {type: 'lost', reason: 'No terminal event within the interrupt grace'})].map(s => [s.result, s.timedOut]), [['uncertain', true]]);
  assert.equal(run(reply, {type: 'event', event: done('completed')}, {type: 'lost', reason: 'Owned process closed'}).result, 'completed', 'a loss after the terminal changes nothing');
  assert.equal(run(reply, {type: 'event', event: done('inProgress')}).result, 'uncertain');
});

test('turnOutcome: the last agent message falls back to item/completed of the bound turn only', () => {
  const item = (threadId, turnId, text) => ({type: 'event', event: event('item/completed', {threadId, turnId, item: {type: 'agentMessage', id: 'i', text}})});
  const state = run(reply, item(root, bound, 'root text'), item('child', bound, 'child text'), item(root, 'other', 'other text'), {type: 'event', event: done('completed')});
  assert.deepEqual([state.result, state.lastAgentMessage], ['completed', 'root text']);
  assert.equal(run(reply, {type: 'event', event: done('completed')}).lastAgentMessage, null);
});
