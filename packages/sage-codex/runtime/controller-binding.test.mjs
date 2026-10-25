import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {bindPolicy, bindTask, bindTurnText, checkConfig, resolveControllerBinary, turnOutcome} from './controller-binding.mjs';
import {OWNED_LAUNCH_ARGS} from './controller-process.mjs';

const dir = realpathSync(mkdtempSync(join(tmpdir(), 'sage-binding-')));
test.after(() => rmSync(dir, {recursive: true, force: true}));
const binary = join(dir, 'codex');
writeFileSync(binary, 'synthetic controller bytes'); chmodSync(binary, 0o755);
const digest = createHash('sha256').update('synthetic controller bytes').digest('hex');

test('resolveControllerBinary refuses each bad path with its fixed code', () => {
  mkdirSync(join(dir, 'folder'));
  writeFileSync(join(dir, 'plain'), 'x'); chmodSync(join(dir, 'plain'), 0o644);
  for (const [env, code] of [
    [{}, 'binary-unset'], [{SAGE_CODEX_CONTROLLER_BIN: ''}, 'binary-unset'], [{SAGE_CODEX_CONTROLLER_BIN: 'bin/codex'}, 'binary-relative'],
    [{SAGE_CODEX_CONTROLLER_BIN: join(dir, 'folder')}, 'binary-not-file'],
    [{SAGE_CODEX_CONTROLLER_BIN: join(dir, 'missing')}, 'binary-missing'], [{SAGE_CODEX_CONTROLLER_BIN: join(dir, 'plain')}, 'binary-not-executable'],
    [{SAGE_CODEX_CONTROLLER_BIN: binary, SAGE_CODEX_CONTROLLER_SHA256: 'c'.repeat(64)}, 'binary-hash'],
    [{SAGE_CODEX_CONTROLLER_BIN: binary, SAGE_CODEX_CONTROLLER_SHA256: digest.toUpperCase()}, 'binary-hash'],
  ]) assert.throws(() => resolveControllerBinary(env), error => error.code === code, `${JSON.stringify(env)} gives ${code}`);
});

test('resolveControllerBinary: each refusal says what it found and what to do (R1504-2, R1505-4)', () => {
  const message = env => { try { resolveControllerBinary(env); return 'pass'; } catch (error) { return error.message; } };
  assert.equal(message({}), 'SAGE_CODEX_CONTROLLER_BIN is not set. Set SAGE_CODEX_CONTROLLER_BIN to the absolute path of the built fork binary (codex-rs/target/debug/codex in the fork checkout).');
  assert.equal(message({SAGE_CODEX_CONTROLLER_BIN: join(dir, 'missing')}), `No file is at ${join(dir, 'missing')}. Build the fork binary, or correct SAGE_CODEX_CONTROLLER_BIN.`);
  assert.equal(message({SAGE_CODEX_CONTROLLER_BIN: binary, SAGE_CODEX_CONTROLLER_SHA256: 'c'.repeat(64)}),
    `The binary ${binary} has sha256 ${digest}, but SAGE_CODEX_CONTROLLER_SHA256 is ${'c'.repeat(64)}. Check that this is the binary that you built, then set SAGE_CODEX_CONTROLLER_SHA256 to its hash.`);
});

test('resolveControllerBinary follows a link to the real path, and refuses a file or a folder on it that others can write (R1503-5)', () => {
  symlinkSync(binary, join(dir, 'link'));
  assert.deepEqual(resolveControllerBinary({SAGE_CODEX_CONTROLLER_BIN: join(dir, 'link')}), {path: binary, sha256: digest, expectedSha256: null});
  const open = join(dir, 'open'), sticky = join(dir, 'sticky'), shared = join(dir, 'shared');
  for (const folder of [open, sticky]) { mkdirSync(folder); writeFileSync(join(folder, 'codex'), 'synthetic controller bytes'); chmodSync(join(folder, 'codex'), 0o755); }
  writeFileSync(shared, 'synthetic controller bytes'); chmodSync(shared, 0o757);
  chmodSync(open, 0o777); chmodSync(sticky, 0o1777);
  // The old check looked at the last path part only: a link in a safe folder to a binary in an open folder passed.
  symlinkSync(join(open, 'codex'), join(dir, 'link-to-open'));
  const code = path => { try { resolveControllerBinary({SAGE_CODEX_CONTROLLER_BIN: path}); return 'pass'; } catch (error) { return `${error.code}: ${error.message}`; } };
  assert.equal(code(join(dir, 'link-to-open')), `binary-writable: The folder ${open} is writable by its group or by other users, so another user can replace the binary. Move the binary to a folder that you own, with chmod go-w on each folder.`);
  assert.equal(code(shared), `binary-writable: ${shared} is writable by its group or by other users, so another user can change it. Use a binary that you own, with chmod go-w on it, then start again.`);
  assert.equal(code(join(sticky, 'codex')), 'pass', 'a sticky folder such as /tmp is safe');
  chmodSync(open, 0o755);
});

test('resolveControllerBinary refuses group write and another owner on the file and on each folder of its path (R1523-1, R1524-4)', () => {
  const group = join(dir, 'group'), groupFile = join(dir, 'group-file');
  mkdirSync(group); writeFileSync(join(group, 'codex'), 'synthetic controller bytes'); chmodSync(join(group, 'codex'), 0o755);
  writeFileSync(groupFile, 'synthetic controller bytes');
  const code = path => { try { resolveControllerBinary({SAGE_CODEX_CONTROLLER_BIN: path}); return 'pass'; } catch (error) { return `${error.code}: ${error.message}`; } };
  // The old check read only the others-write bit: a file or a folder with group write (staff on macOS) passed.
  chmodSync(groupFile, 0o775); chmodSync(group, 0o775);
  assert.equal(code(groupFile), `binary-writable: ${groupFile} is writable by its group or by other users, so another user can change it. Use a binary that you own, with chmod go-w on it, then start again.`);
  assert.equal(code(join(group, 'codex')), `binary-writable: The folder ${group} is writable by its group or by other users, so another user can replace the binary. Move the binary to a folder that you own, with chmod go-w on each folder.`);
  chmodSync(group, 0o755);
  assert.equal(code(join(group, 'codex')), 'pass');
  // Another owner: the test cannot chown, so the process plays a user who owns none of these files. The real
  // uid of this test owns them, and it is not root.
  const owner = process.getuid();
  assert.notEqual(owner, 0, 'the test runs as a normal user');
  const getuid = process.getuid;
  process.getuid = () => owner + 1;
  try {
    assert.equal(code(binary), `binary-writable: ${binary} belongs to another user (uid ${owner}), so another user can change it. Use a binary that you own, with chmod go-w on it, then start again.`);
  } finally { process.getuid = getuid; }
  assert.equal(code(binary), 'pass');
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
  const value = observed(); delete value.config.config.model; delete value.config.origins.model; value.thread.model = 'gpt-default';
  assert.deepEqual(bindPolicy(value).selection.model, {value: 'gpt-default', origin: 'default'});
});

test('bindPolicy takes the sandbox and the approval policy only from a layer that an agent cannot write, and never as a default (R1503-4)', () => {
  const project = {name: {type: 'project', dotCodexFolder: '/work/project/.codex'}, version: 'sha256:p'};
  // The process checks the config with the owner's Codex folder before thread/start; bindPolicy checks it again.
  const refusal = edit => { const value = observed(); edit(value); try { checkConfig(value.config, '/home/.codex'); bindPolicy(value); return 'pass'; } catch (error) { return `${error.code}: ${error.message}`; } };
  assert.equal(refusal(value => { value.config.origins.sandbox_mode = project; }),
    'selection-origin: The setting sandbox_mode comes from the project config in /work/project/.codex. An agent can change project files, so the client takes the sandbox, approval, MCP server and hook settings only from your Codex config, a managed config or the launch flags. Check the setting sandbox_mode. If you trust it, move it to your Codex config (/home/.codex/config.toml). If not, remove it. Then start the client again.');
  assert.match(refusal(value => { value.config.origins.approval_policy = project; }), /^selection-origin: The setting approval_policy comes from the project config/);
  assert.match(refusal(value => { value.config.origins.approval_policy = {name: {type: 'packagedDefaults', file: '/opt/codex/defaults.toml'}}; }), /^selection-origin: .*packagedDefaults config layer \(\/opt\/codex\/defaults.toml\)/);
  const example = {approval_policy: 'approval_policy = "on-request"', sandbox_mode: 'sandbox_mode = "read-only"'};
  for (const key of ['approval_policy', 'sandbox_mode']) {
    assert.equal(refusal(value => { delete value.config.config[key]; delete value.config.origins[key]; }),
      `selection-missing: Your Codex config does not set ${key}. Set it in your Codex config (/home/.codex/config.toml), for example ${example[key]}, then start the client again.`);
    // config/read gives a key that no layer sets as null, with no origin (R1526-2).
    assert.equal(refusal(value => { value.config.config[key] = null; delete value.config.origins[key]; }),
      `selection-missing: Your Codex config does not set ${key}. Set it in your Codex config (/home/.codex/config.toml), for example ${example[key]}, then start the client again.`);
  }
  // A config that sets neither gets one refusal that names both, so one restart fixes it (R1565-2).
  assert.equal(refusal(value => { for (const key of ['approval_policy', 'sandbox_mode']) { value.config.config[key] = null; delete value.config.origins[key]; } }),
    'selection-missing: Your Codex config does not set approval_policy and sandbox_mode. Set them in your Codex config (/home/.codex/config.toml), for example approval_policy = "on-request" and sandbox_mode = "read-only", then start the client again.');
  // The owner's layers pass: user (above), a managed file, and the launch flags.
  assert.equal(refusal(value => { value.config.origins.sandbox_mode = {name: {type: 'system', file: '/etc/codex/managed_config.toml'}}; }), 'pass');
  assert.equal(refusal(value => { value.config.origins.approval_policy = sessionFlags; }), 'pass');
  // The model may come from the project layer: the decision covers the sandbox and the approval policy only.
  assert.equal(refusal(value => { value.config.origins.model = project; }), 'pass');
});

test('bindPolicy: a model and a provider that no layer sets are the default, as config/read gives them: null with no origin (R1526-2)', () => {
  const value = observed();
  value.config.config.model = null; value.config.config.model_provider = null;
  delete value.config.origins.model; delete value.config.origins.model_provider;
  value.thread.model = 'gpt-default'; value.thread.modelProvider = 'openai';
  const {selection} = bindPolicy(value);
  assert.deepEqual([selection.model, selection.modelProvider], [{value: 'gpt-default', origin: 'default'}, {value: 'openai', origin: 'default'}]);
});

test('bindPolicy refuses each key that changes the sandbox or the approval route from a project layer (R1524-1, R1524-2)', () => {
  const project = {name: {type: 'project', dotCodexFolder: '/work/project/.codex'}, version: 'sha256:p'};
  const refusal = (key, origin = project) => { const value = observed(); value.config.origins[key] = origin; try { bindPolicy(value); return 'pass'; } catch (error) { return `${error.code}: ${error.message}`; } };
  const refused = name => `selection-origin: The setting ${name} comes from the project config in /work/project/.codex. An agent can change project files, so the client takes the sandbox, approval, MCP server and hook settings only from your Codex config, a managed config or the launch flags. Check the setting ${name}. If you trust it, move it to your Codex config (config.toml in your Codex folder). If not, remove it. Then start the client again.`;
  // The keys as the real config/read names them: a list item has its index.
  for (const [key, name] of [['sandbox_workspace_write.network_access', 'sandbox_workspace_write.network_access'],
    ['sandbox_workspace_write.writable_roots.0', 'sandbox_workspace_write.writable_roots'], ['sandbox_workspace_write.exclude_slash_tmp', 'sandbox_workspace_write.exclude_slash_tmp'],
    ['approvals_reviewer', 'approvals_reviewer'], ['auto_review.policy', 'auto_review.policy'], ['default_permissions', 'default_permissions'],
    ['permissions.workspace.filesystem.write.0', 'permissions.workspace.filesystem.write']]) {
    assert.equal(refusal(key), refused(name), key);
    assert.equal(refusal(key, user), 'pass', `${key} from the user layer`);
  }
  // A key that only shares the start of a name is not one of them.
  assert.equal(refusal('sandbox_mode_note'), 'pass');
  assert.equal(refusal('model_reasoning_effort'), 'pass');
});

test('bindPolicy: a version or a policy refusal names what it found and what to change (R1504-3)', () => {
  const message = edit => { const value = observed(); edit(value); try { bindPolicy(value); return 'pass'; } catch (error) { return error.message; } };
  assert.equal(message(value => { value.thread.thread.cliVersion = '0.161.0'; }),
    'The controller is version 0.161.0, but this client needs 0.160.0. Set SAGE_CODEX_CONTROLLER_BIN to the fork binary of version 0.160.0, then start the client again.');
  assert.equal(message(value => { value.config.origins['features.multi_agent_v2.enabled'] = user; }),
    'The setting features.multi_agent_v2 comes from your Codex config (/home/config.toml), not from the launch flags of the client. Remove features.multi_agent_v2 from there, then start the client again.');
  assert.equal(message(value => { value.config.config.features.goals = true; }),
    'The setting features.goals is true, but the client needs false. Use the fork binary of version 0.160.0, then start the client again.');
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

test('turnOutcome: a status that names an Object prototype member gives uncertain, never a non-string result (R1503-1)', () => {
  for (const status of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    const state = run(reply, {type: 'event', event: done(status)});
    assert.deepEqual([state.result, state.error], ['uncertain', {reason: `Unknown turn status ${status}`}], status);
  }
});

test('turnOutcome: the last agent message falls back to item/completed of the bound turn only', () => {
  const item = (threadId, turnId, text) => ({type: 'event', event: event('item/completed', {threadId, turnId, item: {type: 'agentMessage', id: 'i', text}})});
  const state = run(reply, item(root, bound, 'root text'), item('child', bound, 'child text'), item(root, 'other', 'other text'), {type: 'event', event: done('completed')});
  assert.deepEqual([state.result, state.lastAgentMessage], ['completed', 'root text']);
  assert.equal(run(reply, {type: 'event', event: done('completed')}).lastAgentMessage, null);
});
