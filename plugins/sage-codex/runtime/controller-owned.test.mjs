import test from 'node:test';
import assert from 'node:assert/strict';
import {chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {EventEmitter} from 'node:events';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {spawn, spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {PassThrough} from 'node:stream';
import {PASTE_OFF, PASTE_ON, runClient} from './controller-client.mjs';
import {createControllerProcess} from './controller-process.mjs';
import {resolveControllerBinary} from './controller-binding.mjs';

const SYNTHETIC_REPLY = 'Synthetic reply from the local fixture provider.';
const INSTRUCTIONS = 'Synthetic chief instructions.';
const HASH = 'b'.repeat(64);
const DELAY = {startup: 1001, inspection: 1002, stop: 1003, turn: 1004, grace: 1005};

// Part 1: a scripted fake app-server. It replays controller-fixture.json (derived from the U3 transcript): each read
// line goes out when its gate request arrives, and all the lines of one request go out in one read.
const PROJECT = realpathSync(mkdtempSync(join(tmpdir(), 'sage-owned-fake-')));
test.after(() => rmSync(PROJECT, {recursive: true, force: true}));
const FIXTURE = readFileSync(new URL('./controller-fixture.json', import.meta.url), 'utf8');
const load = () => JSON.parse(FIXTURE.replaceAll('{{project}}', PROJECT)).stream;
const THREAD = load().find(entry => entry.after === 'thread/start' && entry.reply).reply.thread.id;
const TURN = load().find(entry => entry.after === 'turn/start' && entry.reply).reply.turn.id;
const isRootTerminal = entry => entry.notification?.method === 'turn/completed';

function fakeChild({edit = stream => stream, onRequest = () => {}, exitOnEnd = true} = {}) {
  const stream = edit(load());
  const child = new EventEmitter();
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter();
  const sent = [], timers = [];
  let launch;
  const close = (code = 0) => {
    if (child.closed) return; child.closed = true;
    for (const name of ['stdin', 'stdout', 'stderr']) child[name].emit('close');
    child.emit('close', code, null);
  };
  const emit = lines => child.stdout.emit('data', Buffer.from(lines.map(line => JSON.stringify(line) + '\n').join('')));
  let turns = 0;
  function flush(request) {
    let ready = stream.filter(entry => entry.after === request.method)
      .map(entry => entry.reply ? {id: request.id, result: entry.reply} : entry.notification ?? entry.request);
    // Each later turn gets its own turn id, as the real controller gives.
    if (request.method === 'turn/start' && ++turns > 1) ready = JSON.parse(JSON.stringify(ready).replaceAll(TURN, `${TURN}-${turns}`));
    if (ready.length) emit(ready);
  }
  child.stdin.end = () => { child.ended = true; sent.push({ended: true}); if (exitOnEnd) queueMicrotask(() => close(0)); };
  child.kill = signal => { sent.push({signal}); return true; };
  child.stdin.write = (line, callback) => {
    const message = JSON.parse(line); sent.push(message); callback();
    if (message.method && onRequest(message, {emit, close}) !== false) queueMicrotask(() => flush(message));
  };
  return {child, sent, close, emit, stream, get launch() { return launch; },
    spawn(executable, args, options) { launch = {executable, args, options}; return child; },
    schedule(callback, delay) { const timer = {callback, delay, cancelled: false}; timers.push(timer); return () => { timer.cancelled = true; }; },
    methods: () => sent.filter(message => message.method).map(message => message.method),
    fire(delay) { const timer = timers.find(x => !x.cancelled && x.delay === delay); assert.ok(timer, `a live timer of ${delay}`); timer.cancelled = true; timer.callback(); },
    timersClear: () => timers.every(timer => timer.cancelled)};
}
function fake({edit, onRequest, exitOnEnd, ...options} = {}) {
  const f = fakeChild({edit, onRequest, exitOnEnd});
  const events = [];
  f.events = events;
  f.owner = createControllerProcess({executable: '/fixture/codex', executableSha256: HASH, cwd: PROJECT, env: {PATH: '/fixture/bin'},
    startupTimeoutMs: DELAY.startup, inspectionTimeoutMs: DELAY.inspection, stopGraceMs: DELAY.stop, turnTimeoutMs: DELAY.turn, interruptGraceMs: DELAY.grace,
    onEvent: event => events.push(event), ...options}, {spawn: f.spawn, schedule: f.schedule});
  return f;
}
async function bound(f) {
  await f.owner.start();
  const result = await f.owner.openThread({project: PROJECT, task: 'T400', run: 'R1461', instructions: INSTRUCTIONS});
  return result;
}
async function reactions() { for (let i = 0; i < 30; i++) await Promise.resolve(); }
const fixtureMethods = stream => stream.filter(entry => entry.notification).map(entry => entry.notification.method);

test('fake 1: the full order binds the policy, runs one turn to completed and keeps every notification in order', async () => {
  const f = fake();
  const opened = await bound(f);
  assert.equal(opened.state, 'bound', JSON.stringify(opened));
  assert.equal(opened.policy.threadId, THREAD);
  assert.deepEqual(opened.policy.selection.approvalPolicy, {value: 'on-request', origin: 'user'});
  assert.deepEqual(opened.policy.selection.model, {value: 'synthetic', origin: 'user'});
  const result = await f.owner.runTurn('Say one synthetic sentence.');
  assert.deepEqual({...result, status: result.status.state}, {state: 'completed', task: 'T400', run: 'R1461', threadId: THREAD, turnId: TURN,
    bindingHash: opened.policy.bindingHash, inputSha256: '354e577748c6f0b5456f8c9461aa3bd778d12fdc6df74e6eda230253ecf2b6d0',
    lastAgentMessage: SYNTHETIC_REPLY, error: null, timedOut: false, eventCount: 15, status: 'ready'});
  assert.deepEqual(f.methods(), ['initialize', 'initialized', 'config/read', 'thread/start', 'turn/start']);
  assert.deepEqual(f.sent.find(message => message.method === 'thread/start').params, {cwd: PROJECT, ephemeral: true, developerInstructions: INSTRUCTIONS});
  assert.deepEqual(f.sent.find(message => message.method === 'turn/start').params, {threadId: THREAD, input: [{type: 'text', text: 'Say one synthetic sentence.'}]});
  // The handler gets every event in order; events() keeps the events of the current turn (R1523-2).
  assert.deepEqual(f.events.map(event => event.method), fixtureMethods(f.stream));
  assert.deepEqual(f.events.map(event => event.seq), f.events.map((_, index) => index + 1));
  const events = f.owner.events();
  assert.deepEqual(events, f.events.filter(event => event.seq > 1));
  assert.ok(Object.isFrozen(events) && Object.isFrozen(events[0]) && Object.isFrozen(events[0].message.params));
  assert.ok(Object.isFrozen(result));
  const stop = await f.owner.stop();
  assert.equal(stop.state, 'stopped'); assert.equal(f.timersClear(), true);
});

const PROJECT_LAYER = {name: {type: 'project', dotCodexFolder: `${PROJECT}/.codex`}, version: 'sha256:project'};
const fromProject = (...keys) => stream => {
  const {origins} = stream.find(entry => entry.after === 'config/read').reply;
  for (const key of keys) origins[key] = PROJECT_LAYER;
  return stream;
};
const SENT = ['initialize', 'initialized', 'config/read'];
// A config/read refusal comes before thread/start, because thread/start starts the MCP servers (R1543-2).
for (const [name, edit, code, sent] of [
  ['fake 2: a user origin for features.multi_agent_v2', stream => { stream.find(entry => entry.after === 'config/read').reply.origins['features.multi_agent_v2.enabled'].name = {type: 'user', file: '/x', profile: null}; return stream; }, 'policy-origin', SENT],
  ['fake 3: cliVersion 0.161.0', stream => { stream.find(entry => entry.after === 'thread/start' && entry.reply).reply.thread.cliVersion = '0.161.0'; return stream; }, 'version', [...SENT, 'thread/start']],
  ['fake 4: a reply model that differs from the effective model', stream => { stream.find(entry => entry.after === 'thread/start' && entry.reply).reply.model = 'other-model'; return stream; }, 'selection-changed', [...SENT, 'thread/start']],
  ['fake 20: a project sandbox key (R1543-2)', fromProject('sandbox_workspace_write.network_access'), 'selection-origin', SENT],
  ['fake 21: a project MCP server (R1543-1, R1544-2, R1546-1)', fromProject('mcp_servers.probe.command', 'mcp_servers.probe.args.0'), 'selection-origin', SENT],
  ['fake 22: a project hook (R1544-2)', fromProject('hooks.SessionStart.0.hooks.0.command'), 'selection-origin', SENT],
  ...['request_permissions_tool', 'exec_permission_approvals', 'write_stdin_approval'].map(feature =>
    [`fake 23: the project approval feature ${feature}`, fromProject(`features.${feature}`), 'selection-origin', SENT]),
  // Each key out of the allow-list of the project (R1563-1, R1564-1, R1564-2).
  ...['shell_environment_policy.set.ZDOTDIR', 'shell_environment_policy.set.PATH', 'allow_login_shell', 'zsh_path', 'agents.reviewer.config_file', 'tools.web_search', 'experimental_use_unified_exec_tool'].map(key =>
    [`fake 28: the project key ${key}`, fromProject(key), 'selection-origin', SENT]),
]) test(`${name} refuses and sends no turn/start`, async () => {
  const f = fake({edit});
  const opened = await bound(f);
  assert.equal(opened.state, 'refused'); assert.equal(opened.code, code);
  assert.equal(opened.status.state, 'stopped');
  await assert.rejects(f.owner.runTurn('Say one synthetic sentence.'), /No bound root thread/);
  assert.equal(f.methods().includes('turn/start'), false);
  assert.deepEqual(f.methods(), sent);
});

test('fake 24: an MCP server or a hook from the project names its entry and says where to move it (R1543-1, R1544-2)', async () => {
  const message = async edit => (await bound(fake({edit, env: {PATH: '/fixture/bin', CODEX_HOME: '/fixture/home'}}))).error.message;
  // An agent may have written the entry, so the owner checks it before moving it (R1565-1); the target is a path (R1554-3).
  const refused = name => `The setting ${name} comes from the project config in ${PROJECT}/.codex. An agent can change project files, so the client takes only the model and text settings (such as model_reasoning_effort) from the project, and every other setting only from your Codex config, a managed config or the launch flags. Check the setting ${name}. If you trust it, move it to your Codex config (/fixture/home/config.toml). If not, remove it. Then start the client again.`;
  assert.equal(await message(fromProject('mcp_servers.probe.command')), refused('mcp_servers.probe'));
  assert.equal(await message(fromProject('hooks.SessionStart.0.hooks.0.command')), refused('hooks.SessionStart'));
  assert.equal(await message(fromProject('features.write_stdin_approval')), refused('features.write_stdin_approval'));
  // The same entries from the user layer pass.
  const user = {name: {type: 'user', file: '/fixture/home/config.toml', profile: null}, version: 'sha256:user'};
  const fromUser = stream => { const {origins} = stream.find(entry => entry.after === 'config/read').reply; origins['mcp_servers.probe.command'] = user; origins['hooks.Stop.0.hooks.0.command'] = user; return stream; };
  assert.equal((await bound(fake({edit: fromUser}))).state, 'bound');
  // The settings of the model's text from the project bind.
  assert.equal((await bound(fake({edit: fromProject('model', 'model_reasoning_effort', 'developer_instructions', 'tui.animations')}))).state, 'bound');
});

// The project files that Codex loads with no config key (R1544-1): a rules file in the .codex folder of the project or
// of a folder above it, and a hooks file. The .codex folder that is CODEX_HOME is the owner's.
test('fake 25: a rules or hooks file in the project or a folder above it refuses before config/read; CODEX_HOME rules pass (R1544-1)', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sage-owned-files-')));
  try {
    const project = join(root, 'work', 'project');
    mkdirSync(project, {recursive: true});
    const put = (path, text = '') => { mkdirSync(join(root, path, '..'), {recursive: true}); writeFileSync(join(root, path), text); };
    const open = async (env = {}) => {
      const f = fakeChild({edit: stream => JSON.parse(JSON.stringify(stream).replaceAll(PROJECT, project))});
      const owner = createControllerProcess({executable: '/fixture/codex', executableSha256: HASH, cwd: project, env: {PATH: '/fixture/bin', ...env},
        startupTimeoutMs: DELAY.startup, inspectionTimeoutMs: DELAY.inspection, stopGraceMs: DELAY.stop}, {spawn: f.spawn, schedule: f.schedule});
      await owner.start();
      const opened = await owner.openThread({project, task: 'T400', run: 'R1461', instructions: INSTRUCTIONS});
      await owner.stop();
      return [opened.state, opened.code ?? null, opened.error?.message.replaceAll(root, '<root>') ?? null, f.methods()];
    };
    const why = 'An agent can change project files, so the client refuses the rules, hooks and agent role files of the project and of each folder above it.';
    // The owner's own rules: CODEX_HOME is the .codex folder above the project, as ~/.codex is above ~/workspace/x.
    put('.codex/rules/user.rules', 'prefix_rule(pattern = ["true"], decision = "allow")\n');
    assert.deepEqual((await open({CODEX_HOME: join(root, '.codex')}))[0], 'bound');
    assert.deepEqual((await open({HOME: root}))[0], 'bound', 'HOME/.codex is CODEX_HOME when CODEX_HOME is not set');
    // With another CODEX_HOME, the same folder is a folder above the project.
    assert.deepEqual(await open({CODEX_HOME: join(root, 'codex-home')}), ['refused', 'project-rules',
      `The rules file <root>/.codex/rules/user.rules is in a folder above the project. A rule can let a command run with no approval or outside the sandbox. ${why} Check the rules. If you trust them, move them to your Codex config (<root>/codex-home/rules/). If not, remove them. Then start the client again.`, ['initialize', 'initialized']]);
    put('work/.codex/rules/parent.rules', 'prefix_rule(pattern = ["sh"], decision = "allow")\n');
    put('work/project/.codex/rules/default.rules', 'prefix_rule(pattern = ["sh"], decision = "allow")\n');
    // The project and a folder above it have their own words (R1554-4).
    const refused = (path, where) => ['refused', 'project-rules', `The rules file <root>/${path} is ${where}. A rule can let a command run with no approval or outside the sandbox. ${why} Check the rules. If you trust them, move them to your Codex config (<root>/.codex/rules/). If not, remove them. Then start the client again.`, ['initialize', 'initialized']];
    assert.deepEqual(await open({CODEX_HOME: join(root, '.codex')}), refused('work/project/.codex/rules/default.rules', 'in the project'));
    rmSync(join(project, '.codex'), {recursive: true});
    assert.deepEqual(await open({CODEX_HOME: join(root, '.codex')}), refused('work/.codex/rules/parent.rules', 'in a folder above the project'));
    // A file that does not end in .rules is not a rules file, as Codex reads them.
    rmSync(join(root, 'work', '.codex', 'rules', 'parent.rules')); put('work/.codex/rules/notes.txt');
    assert.deepEqual((await open({CODEX_HOME: join(root, '.codex')}))[0], 'bound');
    put('work/project/.codex/hooks.json', '{"hooks": {}}');
    assert.deepEqual(await open({CODEX_HOME: join(root, '.codex')}), ['refused', 'project-hooks',
      `The hooks file <root>/work/project/.codex/hooks.json is in the project. A hook runs a command at its event. ${why} Check the hooks. If you trust them, move them to your Codex config (<root>/.codex/hooks.json). If not, remove them. Then start the client again.`, ['initialize', 'initialized']]);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

// Codex reads each .toml file in a .codex/agents folder, also in a folder below it, as an agent role (R1564-1).
test('fake 29: an agent role file in the project or a folder above it refuses before config/read; CODEX_HOME roles pass (R1564-1)', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sage-owned-roles-')));
  try {
    const project = join(root, 'work', 'project');
    mkdirSync(project, {recursive: true});
    const put = (path, text = '') => { mkdirSync(join(root, path, '..'), {recursive: true}); writeFileSync(join(root, path), text); };
    const open = async () => {
      const f = fakeChild({edit: stream => JSON.parse(JSON.stringify(stream).replaceAll(PROJECT, project))});
      const owner = createControllerProcess({executable: '/fixture/codex', executableSha256: HASH, cwd: project, env: {PATH: '/fixture/bin', CODEX_HOME: join(root, '.codex')},
        startupTimeoutMs: DELAY.startup, inspectionTimeoutMs: DELAY.inspection, stopGraceMs: DELAY.stop}, {spawn: f.spawn, schedule: f.schedule});
      await owner.start();
      const opened = await owner.openThread({project, task: 'T400', run: 'R1461', instructions: INSTRUCTIONS});
      await owner.stop();
      return [opened.state, opened.code ?? null, opened.error?.message.replaceAll(root, '<root>') ?? null, f.methods()];
    };
    const role = 'name = "reviewer"\ndescription = "A role"\n';
    // The owner's own roles, and a file that does not end in .toml, pass.
    put('.codex/agents/owner.toml', role); put('work/project/.codex/agents/notes.md');
    assert.equal((await open())[0], 'bound');
    const refused = (path, where) => ['refused', 'project-agents', `The agent role file <root>/${path} is ${where}. A role sets the config of each agent that the chief starts with it: its instructions, model, sandbox and MCP servers. An agent can change project files, so the client refuses the rules, hooks and agent role files of the project and of each folder above it. Check the role. If you trust it, move it to your Codex config (<root>/.codex/agents/). If not, remove it. Then start the client again.`, ['initialize', 'initialized']];
    put('work/project/.codex/agents/team/reviewer.toml', role);
    assert.deepEqual(await open(), refused('work/project/.codex/agents/team/reviewer.toml', 'in the project'));
    rmSync(join(project, '.codex'), {recursive: true});
    put('work/.codex/agents/parent.toml', role);
    assert.deepEqual(await open(), refused('work/.codex/agents/parent.toml', 'in a folder above the project'));
  } finally { rmSync(root, {recursive: true, force: true}); }
});

// A linked worktree takes its hooks from the matching folder of its main checkout.
test('fake 26: a hooks file in the main checkout of a linked worktree refuses (R1544-2)', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sage-owned-worktree-')));
  try {
    const main = join(root, 'main'), project = join(root, 'linked', 'app');
    mkdirSync(join(main, '.git', 'worktrees', 'linked'), {recursive: true}); mkdirSync(join(main, 'app', '.codex'), {recursive: true}); mkdirSync(project, {recursive: true});
    writeFileSync(join(root, 'linked', '.git'), `gitdir: ${join(main, '.git', 'worktrees', 'linked')}\n`);
    writeFileSync(join(main, 'app', '.codex', 'hooks.json'), '{"hooks": {}}');
    const f = fakeChild({edit: stream => JSON.parse(JSON.stringify(stream).replaceAll(PROJECT, project))});
    const owner = createControllerProcess({executable: '/fixture/codex', executableSha256: HASH, cwd: project, env: {PATH: '/fixture/bin', CODEX_HOME: join(root, 'home')}}, {spawn: f.spawn, schedule: f.schedule});
    await owner.start();
    const opened = await owner.openThread({project, task: 'T400', run: 'R1461', instructions: INSTRUCTIONS});
    await owner.stop();
    assert.deepEqual([opened.code, f.methods()], ['project-hooks', ['initialize', 'initialized']]);
    assert.match(opened.error.message, /^The hooks file .*\/main\/app\/\.codex\/hooks\.json is in the main checkout of the project worktree\./);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('fake 5: a turn/completed before the turn/start reply is held and decides after the reply', async () => {
  const f = fake({edit: stream => { const reply = stream.findIndex(entry => entry.after === 'turn/start' && entry.reply); stream.push(...stream.splice(reply, 1)); return stream; }});
  assert.equal((await bound(f)).state, 'bound');
  const result = await f.owner.runTurn('Say one synthetic sentence.');
  assert.equal(result.state, 'completed'); assert.equal(result.turnId, TURN); assert.equal(result.lastAgentMessage, SYNTHETIC_REPLY);
  assert.equal(f.owner.events().at(-1).method, 'turn/completed');
  await f.owner.stop();
});

test('fake 6: a child turn/completed and another turn are kept as events; only the root turn decides', async () => {
  const f = fake({edit: stream => {
    const index = stream.findIndex(isRootTerminal);
    const child = structuredClone(stream[index]); child.notification.params.threadId = 'child-thread'; child.notification.params.turn.status = 'failed';
    const other = structuredClone(stream[index]); other.notification.params.turn.id = 'other-turn'; other.notification.params.turn.status = 'interrupted';
    stream.splice(index, 0, child, other); return stream;
  }});
  assert.equal((await bound(f)).state, 'bound');
  const result = await f.owner.runTurn('Say one synthetic sentence.');
  assert.equal(result.state, 'completed'); assert.equal(result.eventCount, 17);
  assert.deepEqual(f.events.filter(event => event.method === 'turn/completed').map(event => event.message.params.threadId), ['child-thread', THREAD, THREAD]);
  // With a handler, events() keeps no event of another thread: the handler got it (R1580-1).
  assert.deepEqual(f.owner.events().filter(event => event.method === 'turn/completed').map(event => event.message.params.threadId), [THREAD, THREAD]);
  await f.owner.stop();
});

test('fake 7: two terminals for the bound turn give uncertain and fence the process', async () => {
  const f = fake({edit: stream => { const second = structuredClone(stream.find(isRootTerminal)); second.notification.params.turn.status = 'failed'; stream.push(second); return stream; }});
  assert.equal((await bound(f)).state, 'bound');
  const result = await f.owner.runTurn('Say one synthetic sentence.');
  assert.equal(result.state, 'uncertain'); assert.match(result.error.reason, /Conflicting/);
  await assert.rejects(f.owner.runTurn('again'), /fenced/);
  await f.owner.stop();
});

test('fake 8: the process closes during the turn: uncertain, never completed', async () => {
  const f = fake({
    edit: stream => stream.filter(entry => !(entry.after === 'turn/start' && entry.notification && stream.indexOf(entry) > stream.findIndex(x => x.notification?.method === 'turn/started'))),
    onRequest(message, {close}) { if (message.method === 'turn/start') setImmediate(() => close(0)); },
  });
  assert.equal((await bound(f)).state, 'bound');
  const result = await f.owner.runTurn('Say one synthetic sentence.');
  assert.equal(result.state, 'uncertain'); assert.equal(result.lastAgentMessage, null);
  assert.equal(result.error.reason, 'Owned stream closed');
  assert.equal(f.owner.events().at(-1).method, 'turn/started');
  assert.equal((await f.owner.stop()).state, 'stopped');
});

const untilStarted = stream => stream.filter((entry, index) => !(entry.after === 'turn/start' && entry.notification && index > stream.findIndex(x => x.notification?.method === 'turn/started')));
test('fake 9: stop during the turn sends turn/interrupt first, gets interrupted, then runs the stop steps', async () => {
  const f = fake({edit: untilStarted, onRequest(message, {emit}) {
    if (message.method !== 'turn/interrupt') return;
    setImmediate(() => emit([{id: message.id, result: {}}, {method: 'turn/completed', params: {threadId: THREAD, turn: {id: TURN, items: [], status: 'interrupted', error: null}}}]));
  }});
  assert.equal((await bound(f)).state, 'bound');
  const turn = f.owner.runTurn('Say one synthetic sentence.');
  await reactions();
  const stop = f.owner.stop();
  const result = await turn;
  assert.equal(result.state, 'interrupted'); assert.equal(result.timedOut, false);
  assert.deepEqual(f.sent.find(message => message.method === 'turn/interrupt').params, {threadId: THREAD, turnId: TURN});
  const order = f.sent.map(message => message.method ?? (message.ended ? 'stdin-end' : message.signal));
  assert.ok(order.indexOf('turn/interrupt') < order.indexOf('stdin-end'), order.join(' '));
  assert.equal((await stop).state, 'stopped');
  assert.equal(f.timersClear(), true);
});

test('fake 10: the turn deadline sends turn/interrupt; no reply within the grace gives uncertain with timedOut', async () => {
  const f = fake({edit: untilStarted});
  assert.equal((await bound(f)).state, 'bound');
  const turn = f.owner.runTurn('Say one synthetic sentence.');
  await reactions();
  f.fire(DELAY.turn);
  assert.equal(f.methods().at(-1), 'turn/interrupt');
  f.fire(DELAY.grace);
  const result = await turn;
  assert.equal(result.state, 'uncertain'); assert.equal(result.timedOut, true);
  assert.match(result.error.reason, /interrupt grace/);
  assert.equal(result.status.state, 'unresolved');
  await f.owner.stop();
});

test('fake 11: the event limit fences the process and the turn is uncertain', async () => {
  const f = fake({maxEvents: 3});
  assert.equal((await bound(f)).state, 'bound');
  const result = await f.owner.runTurn('Say one synthetic sentence.');
  assert.equal(result.state, 'uncertain'); assert.equal(result.error.reason, 'Event limit exceeded');
  assert.equal(result.status.reason, 'Event limit exceeded');
  // The limit counts from the turn start, and events() keeps the current turn only: its three events.
  assert.deepEqual(f.owner.events().map(event => event.seq), [2, 3, 4]);
  await f.owner.stop();
});

const turnEvents = stream => stream.filter(entry => entry.after === 'turn/start' && !entry.reply).length;
test('fake 14: the event limit counts per turn, so a long session runs on (R1505-5)', async () => {
  const f = fake({maxEvents: turnEvents(load())});
  assert.equal((await bound(f)).state, 'bound');
  for (const text of ['one', 'two', 'three']) assert.equal((await f.owner.runTurn(text)).state, 'completed', text);
  assert.equal(f.owner.status().reason, null);
  await f.owner.stop();
});

// One long valid turn: the model streams its reply as many deltas, more than maxEvents.
const withDeltas = count => stream => {
  const at = stream.findIndex(isRootTerminal);
  const delta = {after: 'turn/start', notification: {method: 'item/agentMessage/delta', params: {threadId: THREAD, turnId: TURN, itemId: 'msg-1', delta: 'word '}}};
  stream.splice(at, 0, ...Array.from({length: count}, () => delta));
  return stream;
};
test('fake 18: deltas do not count toward maxEvents, so a long streamed turn completes; maxEventBytes still bounds the kept events (R1526-1)', async () => {
  const f = fake({edit: withDeltas(500), maxEvents: turnEvents(load())});
  assert.equal((await bound(f)).state, 'bound');
  const result = await f.owner.runTurn('Say a long synthetic text.');
  assert.deepEqual([result.state, result.error], ['completed', null]);
  assert.equal(f.events.filter(event => event.method === 'item/agentMessage/delta').length, 500, 'the handler gets each delta');
  await f.owner.stop();
  // An agent message of the root is kept, so it counts toward maxEventBytes.
  const big = stream => { stream.splice(stream.findIndex(isRootTerminal), 0, {after: 'turn/start', notification: {method: 'item/completed',
    params: {threadId: THREAD, turnId: TURN, item: {type: 'agentMessage', id: 'big', text: 'x'.repeat(100 * 1024)}}}}); return stream; };
  const bytes = fake({edit: big, maxEventBytes: 64 * 1024});
  assert.equal((await bound(bytes)).state, 'bound');
  const fenced = await bytes.owner.runTurn('Say a long synthetic text.');
  assert.deepEqual([fenced.state, fenced.error], ['uncertain', {reason: 'Event limit exceeded'}]);
  await bytes.owner.stop();
});

// A long turn with many patches and much command output: each turn/diff/updated sends the whole diff again. With the
// default limits, 70 MiB of diffs, output deltas and child events in one turn complete, and events() keeps none of
// them, so the memory stays bounded (R1580-1).
test('fake 30: 70 MiB of diffs, output deltas and child events in one turn complete with the default limits (R1580-1)', async () => {
  const piece = 'd'.repeat(1024 * 1024);
  const streamed = stream => {
    const at = stream.findIndex(isRootTerminal);
    const events = Array.from({length: 70}, (_, index) => ({after: 'turn/start', notification: [
      {method: 'turn/diff/updated', params: {threadId: THREAD, turnId: TURN, diff: piece}},
      {method: 'item/commandExecution/outputDelta', params: {threadId: THREAD, turnId: TURN, itemId: 'cmd-1', delta: piece}},
      {method: 'item/completed', params: {threadId: 'child-thread', turnId: 'child-turn', item: {type: 'agentMessage', id: `c-${index}`, text: piece}}},
    ][index % 3]}));
    stream.splice(at, 0, ...events);
    return stream;
  };
  let bytes = 0;
  const f = fake({edit: streamed, onEvent: event => { bytes += JSON.stringify(event.message).length; }});
  assert.equal((await bound(f)).state, 'bound');
  const result = await f.owner.runTurn('Make many patches.');
  assert.deepEqual([result.state, result.error], ['completed', null]);
  assert.ok(bytes > 70 * 1024 * 1024, `the handler got ${bytes} bytes`);
  assert.deepEqual(f.owner.events().filter(event => ['turn/diff/updated', 'item/commandExecution/outputDelta'].includes(event.method) || event.message.params?.threadId === 'child-thread'), []);
  assert.equal(f.owner.status().reason, null);
  await f.owner.stop();
});

// A project config written after config/read and before thread/start can add an MCP server that the check did not
// see: thread/start reads the config again and starts it. The startup event of that server fences the session
// (R1581-1). The owner's servers and the built-in codex_apps pass.
test('fake 31: an MCP startup event for a server that the checked config does not have fences the session (R1581-1)', async () => {
  const startup = (name, after = 'thread/start') => ({after, notification: {method: 'mcpServer/startupStatus/updated', params: {threadId: THREAD, name, status: 'starting', error: null, failureReason: null}}});
  const owner = stream => {
    const read = stream.find(entry => entry.after === 'config/read' && entry.reply).reply;
    read.config.mcp_servers = {docs: {command: '/owner/docs'}}; read.origins['mcp_servers.docs.command'] = read.origins.model;
    return stream;
  };
  const passes = fake({edit: stream => { owner(stream).splice(stream.findIndex(entry => entry.after === 'thread/start'), 0, startup('docs'), startup('codex_apps')); return stream; }});
  assert.equal((await bound(passes)).state, 'bound');
  assert.equal((await passes.owner.runTurn('Say one synthetic sentence.')).state, 'completed');
  await passes.owner.stop();
  const added = fake({edit: stream => { owner(stream).splice(stream.findIndex(isRootTerminal), 0, startup('probe', 'turn/start')); return stream; }});
  assert.equal((await bound(added)).state, 'bound');
  const result = await added.owner.runTurn('Say one synthetic sentence.');
  assert.deepEqual([result.state, result.error], ['uncertain', {reason: 'Unchecked MCP server'}]);
  assert.equal(added.owner.status().reason, 'Unchecked MCP server');
  await added.owner.stop();
  // At thread/start, before its reply: the start of the chief does not bind, and the process stops.
  const early = fake({edit: stream => { stream.splice(stream.findIndex(entry => entry.after === 'thread/start'), 0, startup('probe')); return stream; }});
  await early.owner.start();
  const opened = await early.owner.openThread({project: PROJECT, task: 'T400', run: 'R1461', instructions: INSTRUCTIONS});
  assert.deepEqual([opened.state, opened.status.state, early.owner.status().reason], ['uncertain', 'stopped', 'Unchecked MCP server']);
});

test('fake 27: maxDeltaEvents bounds the count of kept deltas in each turn, as maxEventBytes bounds their bytes (R1544-4)', async () => {
  const f = fake({edit: withDeltas(500), maxDeltaEvents: 500});
  assert.equal((await bound(f)).state, 'bound');
  // The count starts again with each turn.
  for (const turn of [1, 2]) assert.equal((await f.owner.runTurn(`Turn ${turn}.`)).state, 'completed', `turn ${turn}`);
  await f.owner.stop();
  const over = fake({edit: withDeltas(500), maxDeltaEvents: 499});
  assert.equal((await bound(over)).state, 'bound');
  const fenced = await over.owner.runTurn('Say a long synthetic text.');
  assert.deepEqual([fenced.state, fenced.error], ['uncertain', {reason: 'Event limit exceeded'}]);
  assert.equal(over.events.filter(event => event.method === 'item/agentMessage/delta').length, 499);
  await over.owner.stop();
});

test('fake 19: with an onEvent handler, events() keeps the current turn only; the sequence numbers go on (R1523-2)', async () => {
  const f = fake();
  assert.equal((await bound(f)).state, 'bound');
  const perTurn = turnEvents(load());
  await f.owner.runTurn('one');
  const second = await f.owner.runTurn('two');
  const kept = f.owner.events();
  assert.equal(kept.length, perTurn, 'only the events of the second turn');
  assert.deepEqual([kept[0].seq, kept.at(-1).seq, second.eventCount], [1 + perTurn + 1, 1 + 2 * perTurn, 1 + 2 * perTurn]);
  assert.equal(f.events.length, 1 + 2 * perTurn, 'the handler got every event');
  await f.owner.stop();
  // With no handler, events() is the only record, so it keeps every event.
  const plain = fake({onEvent: undefined});
  assert.equal((await bound(plain)).state, 'bound');
  await plain.owner.runTurn('one'); await plain.owner.runTurn('two');
  assert.equal(plain.owner.events().length, 1 + 2 * perTurn);
  await plain.owner.stop();
});

test('fake 15: a second terminal for a turn that ended, in a later read, fences the process (R1502-5)', async () => {
  const f = fake();
  assert.equal((await bound(f)).state, 'bound');
  assert.equal((await f.owner.runTurn('one')).state, 'completed');
  f.emit([{method: 'turn/completed', params: {threadId: THREAD, turn: {id: TURN, items: [], status: 'failed', error: null}}}]);
  assert.equal(f.owner.status().reason, 'A second terminal event came for a turn that had ended');
  await assert.rejects(f.owner.runTurn('two'), /fenced/);
  assert.equal(f.methods().filter(method => method === 'turn/start').length, 1);
  await f.owner.stop();
});

test('fake 16: openThread before start is refused and leaves the one root thread for after start (R1505-3)', async () => {
  const f = fake();
  await assert.rejects(f.owner.openThread({project: PROJECT, task: 'T400', run: 'R1461', instructions: INSTRUCTIONS}), /not ready/);
  assert.equal((await bound(f)).state, 'bound');
  await f.owner.stop();
});

test('fake 17: no thread/start reply within the deadline gives uncertain and stops the process (R1502-3)', async () => {
  const f = fake({onRequest: message => (message.method === 'thread/start' ? false : undefined)});
  await f.owner.start();
  const opening = f.owner.openThread({project: PROJECT, task: 'T400', run: 'R1461', instructions: INSTRUCTIONS});
  await reactions();
  f.fire(DELAY.inspection);
  const opened = await opening;
  assert.deepEqual([opened.state, opened.error.message, opened.status.state], ['uncertain', 'Thread start observation expired; outcome uncertain', 'stopped']);
  assert.equal(f.methods().includes('turn/start'), false);
});

test('fake 12: with an onEvent handler a server request waits for the answer of its id; with none it is refused with -32601', async () => {
  const request = {id: 'server-1', method: 'item/commandExecution/requestApproval', params: {threadId: THREAD, turnId: TURN, itemId: 'cmd-1', command: 'true'}};
  const edit = stream => { stream.splice(stream.findIndex(isRootTerminal), 0, {after: 'turn/start', request}); return stream; };
  const f = fake({edit});
  assert.equal((await bound(f)).state, 'bound');
  assert.equal((await f.owner.runTurn('Say one synthetic sentence.')).state, 'completed');
  assert.deepEqual({...f.events.find(event => event.message.id === 'server-1')}, {seq: 15, kind: 'server-request', method: 'item/commandExecution/requestApproval', message: request});
  assert.equal(f.sent.some(message => message.id === 'server-1'), false, 'the process answers no request by itself');
  assert.equal(f.owner.answer('server-1', {decision: 'accept'}), true);
  assert.equal(f.owner.answer('server-1', {decision: 'accept'}), false, 'one reply for each request');
  assert.deepEqual(f.sent.filter(message => message.id === 'server-1'), [{id: 'server-1', result: {decision: 'accept'}}]);
  await f.owner.stop();
  assert.equal(f.owner.refuse('server-1'), false, 'no reply after a stop');
  const plain = fake({edit, onEvent: undefined});
  assert.equal((await bound(plain)).state, 'bound');
  assert.equal((await plain.owner.runTurn('Say one synthetic sentence.')).state, 'completed');
  assert.deepEqual(plain.sent.find(message => message.id === 'server-1'), {id: 'server-1', error: {code: -32601, message: 'Controller transport does not handle this server request'}});
  assert.deepEqual({...plain.owner.events().find(event => event.message.id === 'server-1')}, {seq: 15, kind: 'server-request-refused', method: 'item/commandExecution/requestApproval', message: request});
  await plain.owner.stop();
});

test('fake 13: one task and one root per process; one turn at a time', async () => {
  const f = fake({edit: untilStarted});
  assert.equal((await bound(f)).state, 'bound');
  await assert.rejects(f.owner.openThread({project: PROJECT, task: 'T401', run: 'R1', instructions: INSTRUCTIONS}), /one task/);
  const turn = f.owner.runTurn('Say one synthetic sentence.');
  await assert.rejects(f.owner.runTurn('a parallel turn'), /already active/);
  await reactions();
  f.emit([{method: 'turn/completed', params: {threadId: THREAD, turn: {id: TURN, items: [], status: 'failed', error: {message: 'synthetic failure'}}}}]);
  assert.deepEqual({state: (await turn).state, error: (await turn).error}, {state: 'failed', error: {message: 'synthetic failure'}});
  await assert.rejects(f.owner.runTurn(''), /a line must be text/);
  const next = f.owner.runTurn('A second turn on the same root.');
  await reactions();
  assert.equal(f.methods().filter(method => method === 'turn/start').length, 2);
  // The second turn starts but gets no terminal. Stop sends turn/interrupt; no terminal within the grace: uncertain.
  const stop = f.owner.stop();
  await reactions();
  assert.equal(f.methods().at(-1), 'turn/interrupt');
  f.fire(DELAY.grace);
  assert.deepEqual({state: (await next).state, error: (await next).error}, {state: 'uncertain', error: {reason: 'No terminal event within the interrupt grace'}});
  assert.equal((await stop).state, 'stopped');
});

test('fake: a bad task binding refuses before thread/start and stops the process', async () => {
  for (const input of [{project: PROJECT, task: 'T0400', run: 'R1', instructions: INSTRUCTIONS}, {project: '/elsewhere', task: 'T1', run: 'R1', instructions: INSTRUCTIONS},
    {project: PROJECT, task: 'T1', run: 'R1', instructions: 'a\0b'}]) {
    const f = fake();
    await f.owner.start();
    const opened = await f.owner.openThread(input);
    assert.equal(opened.state, 'refused'); assert.equal(opened.code, 'task'); assert.equal(opened.status.state, 'stopped');
    assert.deepEqual(f.methods(), ['initialize', 'initialized']);
  }
});

test('fake: a refused turn/start reply gives refused and leaves the root usable', async () => {
  let refuse = true;
  const f = fake({onRequest(message, {emit}) {
    if (message.method !== 'turn/start' || !refuse) return;
    refuse = false;
    setImmediate(() => emit([{id: message.id, error: {code: -32600, message: 'turn refused by the host'}}]));
    return false;
  }});
  assert.equal((await bound(f)).state, 'bound');
  const refused = await f.owner.runTurn('first');
  assert.deepEqual({state: refused.state, error: refused.error}, {state: 'refused', error: {code: -32600, message: 'turn refused by the host'}});
  assert.equal((await f.owner.runTurn('second')).state, 'completed');
  await f.owner.stop();
});

test('fake: a throw from onEvent fences the process and the turn is uncertain', async () => {
  const f = fake({onEvent(event) { if (event.method === 'turn/started') throw new Error('callback failed'); }});
  assert.equal((await bound(f)).state, 'bound');
  const result = await f.owner.runTurn('Say one synthetic sentence.');
  assert.equal(result.state, 'uncertain'); assert.equal(result.error.reason, 'Event callback failed');
  await f.owner.stop();
});

// The terminal client against the same fake. commands.mjs needs the bundled core, so the test loads the built copy.
const {parseCommand} = await import(new URL('../../../plugins/sage-codex/skills/sage/commands.mjs', import.meta.url));
const CLIENT_DIR = realpathSync(mkdtempSync(join(tmpdir(), 'sage-client-')));
test.after(() => rmSync(CLIENT_DIR, {recursive: true, force: true}));
writeFileSync(join(CLIENT_DIR, 'codex'), 'synthetic controller bytes'); chmodSync(join(CLIENT_DIR, 'codex'), 0o755);
writeFileSync(join(CLIENT_DIR, 'chief.md'), INSTRUCTIONS);
const CLIENT_ARGS = ['--project', PROJECT, '--task', 'T400', '--run', 'R1461', '--instructions', join(CLIENT_DIR, 'chief.md')];
const CLIENT_ENV = {SAGE_CODEX_CONTROLLER_BIN: join(CLIENT_DIR, 'codex'), PATH: '/fixture/bin', CODEX_HOME: '/fixture/home'};
const CLIENT_SHA256 = createHash('sha256').update('synthetic controller bytes').digest('hex');
const HEADER = [`[Controller binary: ${join(CLIENT_DIR, 'codex')}, sha256 ${CLIENT_SHA256}.]`,
  '[Warning: SAGE_CODEX_CONTROLLER_SHA256 is not set, so the client did not compare the binary with a known hash. To pin this binary, set it to the hash above.]'];
const READY = ['[Ready: task T400, run R1461. The chief uses your Codex config: model "synthetic", approval "on-request", sandbox "read-only".]',
  '[Type a line and press Enter: the chief gets it as one turn. Ctrl-C clears the line, drops the lines that wait and stops the turn. Ctrl-D stops the controller.]'];
// On a terminal, the last Ready line says that a paste of several lines is one line.
const READY_TTY = '[Type a line and press Enter: the chief gets it as one turn. A paste of several lines is one line. Ctrl-C clears the line, drops the lines that wait and stops the turn. Ctrl-D stops the controller.]';
const STOPPED = '[You stopped the controller. The session ended.]';
// The fixture turn has the real binary's warning notification; the client shows it (R1504-10).
const WARNING = '[Warning from the controller: Model metadata for `synthetic` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.]';
const NEXT = 'Type the next line, or press Ctrl-D to stop the controller.';
/** Starts the client on the fake. The caller writes to `input`; `signal` plays a signal; `code` resolves with the exit code. */
function clientRun({fakeOptions = {}, env = {}, argv = CLIENT_ARGS, tty = false} = {}) {
  const f = fakeChild(fakeOptions);
  let text = '', handler, ended = false;
  // writableLength is the output that waits for the terminal, as a stream gives it; a test can raise it.
  // It says 'drain' when a test emits it, as a stream does when the terminal took all that waited.
  const output = Object.assign(new EventEmitter(), {writableLength: 0, write(chunk) { text += chunk; return true; }});
  // With `tty`, the input is a terminal as the client sees one: it has isTTY, and setRawMode sets isRaw.
  const input = tty ? Object.assign(new PassThrough(), {isTTY: true, isRaw: false, setRawMode(on) { this.isRaw = on; return this; }}) : new PassThrough();
  // An undefined value removes that variable.
  const merged = Object.fromEntries(Object.entries({...CLIENT_ENV, ...env}).filter(([, value]) => value !== undefined));
  const code = runClient({argv, env: merged, input, output, classify: parseCommand,
    onSignal: handle => { handler = handle; }, spawn: f.spawn, schedule: f.schedule});
  code.then(() => { ended = true; });
  // lines() leaves out the switches of bracketed paste mode; text() keeps them.
  const lines = () => text.replaceAll(PASTE_ON, '').replaceAll(PASTE_OFF, '').trimEnd().split('\n');
  return {f, input, output, code, signal: name => handler(name), text: () => text, lines, ended: () => ended};
}
/** Waits, with no clock, until the check passes; a bounded number of event-loop turns, then the test fails. */
async function until(check, what) {
  for (let i = 0; i < 2000; i++) { if (check()) return; await new Promise(resolve => setImmediate(resolve)); }
  assert.fail(`never reached: ${what}`);
}
async function client(lines, fakeOptions, env) {
  const run = clientRun({fakeOptions, env});
  run.input.end(lines.map(line => `${line}\n`).join(''));
  await until(run.ended, 'the client exit');
  return {...run, code: await run.code};
}
// A fake that holds the first turn until turn/interrupt, then ends it as interrupted. Later turns replay the fixture.
function holdFirstTurn({answerInterrupt = true} = {}) {
  let turns = 0;
  const state = {held: false};
  state.options = {onRequest(message, {emit}) {
    if (message.method === 'turn/start' && ++turns === 1) {
      setImmediate(() => { emit([{id: message.id, result: {turn: {id: 'held-turn', status: 'inProgress', items: []}}}]); state.held = true; });
      return false;
    }
    if (message.method === 'turn/interrupt' && answerInterrupt) setImmediate(() => emit([{id: message.id, result: {}},
      {method: 'turn/completed', params: {threadId: THREAD, turn: {id: 'held-turn', items: [], status: 'interrupted', error: null}}}]));
  }};
  return state;
}

test('client: the start lines name the binary and its hash, warn without a pin, and say how to use the client (R1504-7, R1503-5)', async () => {
  const run = await client(['Say one synthetic sentence.']);
  assert.equal(run.code, 0);
  assert.deepEqual(run.lines(), [...HEADER, ...READY, WARNING, `chief> ${SYNTHETIC_REPLY}`, '[Turn completed.]', STOPPED]);
  assert.equal(run.f.launch.options.env.CODEX_HOME, '/fixture/home');
  assert.equal(run.f.launch.args.includes('--owned-controller'), true);
  const pinned = await client([], {}, {SAGE_CODEX_CONTROLLER_SHA256: CLIENT_SHA256});
  assert.deepEqual(pinned.lines(), [HEADER[0], ...READY, STOPPED]);
});

// The fixture gives the same warning at each turn: the client shows it once in the session (R1565-4). A near line
// that means one phrase says "this", not "one of these" (R1565-3).
test('client: a mode phrase note says that the line goes to the chief; a near line says that no mode changed (R1504-9)', async () => {
  const run = await client(['sage mode', '', 'sage mode please', 'please turn sage mode on']);
  assert.equal(run.code, 0);
  assert.deepEqual(run.lines().slice(HEADER.length + READY.length), [
    '[You typed the mode phrase "sage mode". The client sends it to the chief, which switches the mode and says so.]', WARNING, `chief> ${SYNTHETIC_REPLY}`, '[Turn completed.]',
    '[No mode changed: this line is not a mode phrase, so the chief gets it as a normal line. To switch, type one of these alone: sage mode, sage mode off.]', `chief> ${SYNTHETIC_REPLY}`, '[Turn completed.]',
    '[No mode changed: this line is not a mode phrase, so the chief gets it as a normal line. To switch, type this alone: sage mode.]', `chief> ${SYNTHETIC_REPLY}`, '[Turn completed.]',
    STOPPED]);
  assert.deepEqual(run.f.sent.filter(message => message.method === 'turn/start').map(message => message.params.input[0].text), ['sage mode', 'sage mode please', 'please turn sage mode on']);
});

test('client: model text and controller strings cannot forge a client line or send control bytes (R1505-1, R1503-2, R1502-4)', async () => {
  const forged = 'Done.\n[Turn completed.]\n[You stopped the controller. The session ended.]\n\u001b[31mred\u001b]52;c;cGF5bG9hZA==\u0007\r\u009b2J';
  let turns = 0;
  const run = await client(['first', 'second'], {
    edit: stream => {
      stream.find(entry => entry.notification?.method === 'item/completed' && entry.notification.params.item?.type === 'agentMessage').notification.params.item.text = forged;
      stream.splice(stream.findIndex(isRootTerminal), 0, {after: 'turn/start', request: {id: 'server-1', method: 'item/x\u001b[2J\n[Turn completed.]', params: {threadId: THREAD}}});
      return stream;
    },
    onRequest(message, {emit}) {
      if (message.method !== 'turn/start' || ++turns !== 2) return;
      setImmediate(() => emit([{id: message.id, result: {turn: {id: 'turn-2', status: 'inProgress', items: []}}},
        {method: 'turn/completed', params: {threadId: THREAD, turn: {id: 'turn-2', items: [], status: 'failed', error: {message: 'boom\n[Turn completed.]\u001b[2J'}}}}]));
      return false;
    },
  });
  const text = run.text();
  assert.equal(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/.test(text), false, JSON.stringify(text));
  const lines = run.lines();
  assert.deepEqual(lines.filter(line => line === '[Turn completed.]').length, 1, 'only the real result of the first turn');
  assert.deepEqual(lines.filter(line => line === STOPPED).length, 1, 'only the real end');
  assert.ok(lines.every(line => line.startsWith('[') || line.startsWith('chief> ')), lines.join('\n'));
  assert.deepEqual(lines.filter(line => line.startsWith('chief> ')), ['chief> Done.', 'chief> [Turn completed.]', 'chief> [You stopped the controller. The session ended.]',
    'chief> �[31mred�]52;c;cGF5bG9hZA==���2J']);
  assert.ok(lines.includes('[Agent /root (the chief) sent a request that is not an approval request, so the client refused it.]'), lines.join('\n'));
  assert.ok(lines.includes('[The turn failed: boom�[Turn completed.]�[2J. The controller stops now.]'), lines.join('\n'));
});

test('client: a controller crash between turns ends the client at once with code 1 (R1502-2)', async () => {
  const run = clientRun();
  run.input.write('Say one synthetic sentence.\n');
  await until(() => run.lines().includes('[Turn completed.]'), 'the first turn');
  run.f.close(1);
  // The input stays open: the client must notice the crash by itself.
  await until(run.ended, 'the client exit after the crash');
  assert.equal(await run.code, 1);
  assert.equal(run.lines().at(-1), '[The session ended early: the controller process ended by itself. Start the client again.]');
  run.input.end();
});

test('client: a start refusal says what it found and what to do, and starts no controller (R1504-2, R1504-5)', async () => {
  const cases = [
    [{argv: []}, ['[The client did not start: The client needs --project, --task, --run, --instructions.]',
      'Usage: SAGE_CODEX_CONTROLLER_BIN=<fork codex binary> node controller-client.mjs --project <folder> --task <T…> --run <R…> --instructions <file>',
      '  --project       the project folder; the chief works in it', '  --task, --run   the task and run ids, for example T400 and R1', '  --instructions  the file with the chief instructions']],
    [{env: {SAGE_CODEX_CONTROLLER_BIN: undefined}}, ['[The client did not start: SAGE_CODEX_CONTROLLER_BIN is not set. Set SAGE_CODEX_CONTROLLER_BIN to the absolute path of the built fork binary (codex-rs/target/debug/codex in the fork checkout).]']],
    [{argv: CLIENT_ARGS.map(value => (value === PROJECT ? join(CLIENT_DIR, 'nope') : value))}, [`[The client did not start: The project folder ${join(CLIENT_DIR, 'nope')} does not exist. Give an existing folder with --project.]`]],
    [{argv: CLIENT_ARGS.map(value => (value.endsWith('chief.md') ? join(CLIENT_DIR, 'nope.md') : value))}, [`[The client did not start: The instructions file ${join(CLIENT_DIR, 'nope.md')} does not exist. Give the chief instructions file with --instructions.]`]],
    [{argv: CLIENT_ARGS.map(value => (value === 'T400' ? 't400' : value))}, ['[The client did not start: The task "t400" is not a task id. Give T and digits with no leading zero, for example --task T400.]']],
  ];
  for (const [options, expected] of cases) {
    const run = clientRun(options);
    run.input.end();
    await until(run.ended, 'the client exit');
    assert.equal(await run.code, 1);
    assert.deepEqual(run.lines(), expected, JSON.stringify(options));
    assert.equal(run.f.launch, undefined, 'no controller started');
  }
});

// A read of a named pipe waits for a writer, and the old client then never answered (R1566-1). The client runs in its
// own node process here, so a client that waits ends at the deadline of spawnSync, by its handle, and the test fails.
const ONE_CLIENT = `
const {runClient} = await import(process.argv[1]);
const {PassThrough} = await import('node:stream');
let text = '';
const input = new PassThrough(); input.end();
const output = {writableLength: 0, write(chunk) { text += chunk; return true; }, once() {}};
const code = await runClient({argv: JSON.parse(process.argv[2]), env: JSON.parse(process.argv[3]), input, output, classify: () => ({kind: 'line'}),
  spawn: () => { throw new Error('the client started a controller'); }});
process.stdout.write(JSON.stringify({code, text}));
`;
test('client: an instructions file that is a named pipe, a device or a folder refuses at once with its type (R1566-1)', () => {
  const fifo = join(CLIENT_DIR, 'chief.fifo');
  assert.equal(spawnSync('mkfifo', [fifo]).status, 0);
  const url = new URL('./controller-client.mjs', import.meta.url).href;
  for (const [path, kind] of [[fifo, 'a named pipe'], ['/dev/null', 'a device'], [CLIENT_DIR, 'a folder']]) {
    const argv = CLIENT_ARGS.map(value => (value.endsWith('chief.md') ? path : value));
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', ONE_CLIENT, url, JSON.stringify(argv), JSON.stringify(CLIENT_ENV)],
      {encoding: 'utf8', timeout: 20000, killSignal: 'SIGKILL'});
    assert.equal(run.signal, null, `${kind}: the client waited until the deadline`);
    assert.deepEqual(JSON.parse(run.stdout), {code: 1,
      text: `[The client did not start: The instructions file ${path} is ${kind}, not a regular file. Give the chief instructions file with --instructions.]\n`}, kind);
  }
});

test('client: a version refusal shows the found version and the fix, and ends with code 1 (R1504-3)', async () => {
  const run = await client(['Say one synthetic sentence.'], {edit: stream => { stream.find(entry => entry.after === 'thread/start' && entry.reply).reply.thread.cliVersion = '0.161.0'; return stream; }});
  assert.equal(run.code, 1);
  assert.deepEqual(run.lines(), [...HEADER, '[The client did not start the chief: The controller is version 0.161.0, but this client needs 0.160.0. Set SAGE_CODEX_CONTROLLER_BIN to the fork binary of version 0.160.0, then start the client again.]']);
  assert.equal(run.f.methods().includes('turn/start'), false);
});

test('client: each turn result says what happened and what to do next (R1504-4)', async () => {
  let turns = 0;
  const run = clientRun({fakeOptions: {onRequest(message, {emit}) {
    if (message.method !== 'turn/start') return;
    turns += 1;
    if (turns === 1) { setImmediate(() => emit([{id: message.id, result: {turn: {id: 'turn-1', status: 'inProgress', items: []}}},
      {method: 'turn/completed', params: {threadId: THREAD, turn: {id: 'turn-1', items: [], status: 'failed', error: {message: 'synthetic: the model provider returned 500'}}}}])); return false; }
    if (turns === 2) { setImmediate(() => emit([{id: message.id, error: {code: -32600, message: 'synthetic: turn refused by the host'}}])); return false; }
  }}});
  // The owner types each line after the result of the one before, so each result gives the next step.
  const results = () => run.lines().filter(line => /^\[The (turn failed|client did not send|controller refused)/.test(line)).length;
  for (const [index, line] of ['one', 'x'.repeat(64 * 1024 + 1), 'two'].entries()) {
    run.input.write(`${line}\n`);
    await until(() => results() > index, `the result of ${line.slice(0, 5)}`);
  }
  // The last line comes with the end of the input: it runs, then the controller stops.
  run.input.end('three\n');
  assert.equal(await run.code, 0);
  assert.deepEqual(run.lines().slice(HEADER.length + READY.length), [
    '[The turn failed: synthetic: the model provider returned 500. Type the line again to try again, or press Ctrl-D to stop the controller.]',
    '[The client did not send the line: The line has 65537 bytes; a line must be text of 1 to 65536 bytes, with no NUL. Shorten or correct the line, then type it again.]',
    '[The controller refused the turn: synthetic: turn refused by the host. Change the line, then type it again.]',
    WARNING, `chief> ${SYNTHETIC_REPLY}`, '[Turn completed.]', STOPPED]);
});

test('client: Ctrl-C shows a message at once, stops the turn and drops the lines that wait; a line typed after it runs (R1504-6, R1504-1, R1577-1)', async () => {
  const hold = holdFirstTurn({answerInterrupt: false});
  const run = clientRun({fakeOptions: hold.options});
  // A paste of four lines from a pipe during the turn: the four lines wait.
  run.input.write('Wait for an interrupt.\n');
  await until(() => hold.held, 'the held turn');
  run.input.write('l2\nl3\nl4\nl5\n');
  await until(() => run.lines().filter(line => line === '[The chief is on a turn. Your line runs after it.]').length === 4, 'the queued line notes');
  run.signal('SIGINT');
  assert.equal(run.lines().at(-1), '[Stopping the turn... The 4 lines that waited do not run. Press Ctrl-C again to stop the controller.]', 'the message comes before the result');
  run.input.write('Say one synthetic sentence.\nSay it again.\n');
  await until(() => run.lines().filter(line => line === '[The chief is on a turn. Your line runs after it.]').length === 6, 'the lines after Ctrl-C');
  run.f.emit([{method: 'turn/completed', params: {threadId: THREAD, turn: {id: 'held-turn', items: [], status: 'interrupted', error: null}}}]);
  await until(() => run.lines().filter(line => line === '[Turn completed.]').length === 2, 'the two lines after Ctrl-C');
  run.input.end();
  assert.equal(await run.code, 0);
  const waits = '[The chief is on a turn. Your line runs after it.]';
  assert.deepEqual(run.lines().slice(HEADER.length + READY.length), [waits, waits, waits, waits,
    '[Stopping the turn... The 4 lines that waited do not run. Press Ctrl-C again to stop the controller.]', waits, waits,
    // The lines that wait now came after the Ctrl-C, and the client says so, with the count (R1525-3, R1577-2).
    '[You stopped the turn.]', '[The 2 lines that you typed after Ctrl-C start now, one at a time.]',
    WARNING, `chief> ${SYNTHETIC_REPLY}`, '[Turn completed.]', `chief> ${SYNTHETIC_REPLY}`, '[Turn completed.]', STOPPED]);
  assert.deepEqual(run.f.sent.filter(message => message.method === 'turn/start').map(message => message.params.input[0].text),
    ['Wait for an interrupt.', 'Say one synthetic sentence.', 'Say it again.']);
  assert.deepEqual(run.f.sent.filter(message => message.method === 'turn/interrupt').map(message => message.params), [{threadId: THREAD, turnId: 'held-turn'}]);
});

// The terminal keys, as raw mode gives them: each write is one read of the terminal.
test('client: on a terminal, a bracketed paste of five lines is one turn at Enter, with its line ends (R1577-1)', async () => {
  const run = clientRun({tty: true});
  await until(() => run.lines().at(-1) === READY_TTY, 'the Ready lines');
  // The paste comes in three reads, and its end mark is split between two of them.
  for (const chunk of ['\x1b[200~l1\rl2\r\nl3', '\nl4\rl5\x1b[20', '1~', '\r']) run.input.write(chunk);
  await until(() => run.lines().includes('[Turn completed.]'), 'the turn');
  run.input.write('\x04');
  assert.equal(await run.code, 0);
  assert.deepEqual(run.f.sent.filter(message => message.method === 'turn/start').map(message => message.params.input[0].text), ['l1\nl2\nl3\nl4\nl5']);
  // The client turns bracketed paste on before the Ready lines and off before the last line.
  assert.equal(run.text().startsWith(`${HEADER.join('\n')}\n${PASTE_ON}[Ready:`), true, run.text().slice(0, 400));
  assert.equal(run.text().endsWith(`${PASTE_OFF}${STOPPED}\n`), true);
  assert.equal(run.input.isRaw, false, 'line mode is back at the end');
});

test('client: on a terminal, Ctrl-C clears the typed line, so the next Enter sends only the new line; a split key sequence adds no text (R1575-2, R1575-4)', async () => {
  const run = clientRun({tty: true});
  await until(() => run.lines().at(-1) === READY_TTY, 'the Ready lines');
  run.input.write('drop the table');
  run.input.write('\x03');
  // The Up key in two reads, an Escape key alone, then Alt-x in one read: none adds text.
  for (const chunk of ['say', '\x1b', '[A', ' hello\x1b', 'O', 'A', '\x1b', '!\x1bx', '\r']) run.input.write(chunk);
  await until(() => run.lines().includes('[Turn completed.]'), 'the turn');
  assert.deepEqual(run.f.sent.filter(message => message.method === 'turn/start').map(message => message.params.input[0].text), ['say hello!']);
  // A second Ctrl-C on an empty line stops the controller; the Ctrl-C that cleared a line did not.
  run.input.write('\x03');
  await until(() => run.lines().at(-1).startsWith('[No turn is running.'), 'the hint');
  run.input.write('\x03');
  assert.equal(await run.code, 0);
  assert.deepEqual(run.f.sent.filter(message => message.method === 'turn/start').map(message => message.params.input[0].text), ['say hello!']);
  assert.deepEqual(run.lines().slice(HEADER.length + READY.length), ['drop the table', '[You cleared the line. Press Ctrl-C again or Ctrl-D to stop the controller.]',
    'say hello!', WARNING, `chief> ${SYNTHETIC_REPLY}`, '[Turn completed.]', '[No turn is running. Press Ctrl-C again or Ctrl-D to stop the controller.]',
    '[Stopping the controller...]', STOPPED]);
});

test('client: on a terminal, raw mode stays on after Ctrl-D during a turn, and Ctrl-C then still stops the turn (R1577-3)', async () => {
  const hold = holdFirstTurn();
  const run = clientRun({fakeOptions: hold.options, tty: true});
  await until(() => run.lines().at(-1) === READY_TTY, 'the Ready lines');
  run.input.write('Wait for an interrupt.\r');
  await until(() => hold.held, 'the held turn');
  run.input.write('\x04');
  await until(() => run.lines().at(-1).startsWith('[Your input ended.'), 'the end note');
  assert.equal(run.input.isRaw, true, 'the terminal stays raw');
  // Text typed after the end of the input does nothing: no echo, no turn.
  run.input.write('late text\r');
  run.input.write('\x03');
  assert.equal(await run.code, 0);
  assert.deepEqual(run.lines().slice(HEADER.length + READY.length), ['Wait for an interrupt.',
    '[Your input ended. The controller stops after the lines that you typed. Press Ctrl-C to stop the turn now.]',
    '[Stopping the turn... Press Ctrl-C again to stop the controller.]', '[You stopped the turn. The controller stops now.]', STOPPED]);
  assert.equal(run.f.sent.filter(message => message.method === 'turn/start').length, 1);
  assert.equal(run.input.isRaw, false);
});

test('client: an agent message that ends with line ends shows no empty chief line (R1578-1)', async () => {
  const run = await client(['Say one synthetic sentence.'], {edit: stream => {
    const item = stream.find(entry => entry.notification?.method === 'item/completed' && entry.notification.params.item?.type === 'agentMessage');
    item.notification.params.item.text = 'First line.\n\nLast line.\n';
    return stream;
  }});
  assert.equal(run.code, 0);
  assert.deepEqual(run.lines().slice(HEADER.length + READY.length), [WARNING, 'chief> First line.', 'chief> ', 'chief> Last line.', '[Turn completed.]', STOPPED]);
});

test('client: a second Ctrl-C stops the controller, also before the chief is ready; the exit code is 0 (R1504-1)', async () => {
  const hold = holdFirstTurn();
  const run = clientRun({fakeOptions: hold.options});
  run.input.write('Wait for an interrupt.\n');
  await until(() => hold.held, 'the held turn');
  run.signal('SIGINT'); run.signal('SIGINT');
  await until(run.ended, 'the client exit');
  assert.equal(await run.code, 0);
  assert.deepEqual(run.lines().slice(HEADER.length + READY.length), ['[Stopping the turn... Press Ctrl-C again to stop the controller.]', '[Stopping the controller...]',
    '[You stopped the turn. The controller stops now.]', STOPPED]);
  // Before the chief is ready: the config/read reply never comes, and Ctrl-C stops the start.
  const early = clientRun({fakeOptions: {onRequest: message => (message.method === 'config/read' ? false : undefined)}});
  await until(() => early.f.methods().includes('config/read'), 'the config/read request');
  early.signal('SIGINT');
  await until(early.ended, 'the client exit');
  assert.equal(await early.code, 0);
  assert.deepEqual(early.lines(), [...HEADER, '[Stopping the controller...]', STOPPED]);
  early.input.end();
});

test('client: the end of input during a turn says when the controller stops and how to stop the turn now (R1505-2)', async () => {
  const hold = holdFirstTurn();
  const run = clientRun({fakeOptions: hold.options});
  run.input.write('Wait for an interrupt.\n');
  await until(() => hold.held, 'the held turn');
  run.input.end();
  const ended = '[Your input ended. The controller stops after the lines that you typed. Press Ctrl-C to stop the turn now.]';
  await until(() => run.lines().at(-1) === ended, 'the end of input note');
  assert.equal(run.ended(), false, 'the typed line still runs');
  run.signal('SIGINT');
  await until(run.ended, 'the client exit');
  assert.equal(await run.code, 0);
  // No line can be typed after the end of input: the text says that the controller stops (R1525-2).
  assert.deepEqual(run.lines().slice(HEADER.length + READY.length), [ended, '[Stopping the turn... Press Ctrl-C again to stop the controller.]',
    '[You stopped the turn. The controller stops now.]', STOPPED]);
});

test('client: SIGTERM during a turn says that the controller stops now; SIGHUP stops it with code 1 and writes nothing more (R1526-3, R1525-1)', async () => {
  for (const signal of ['SIGTERM', 'SIGHUP']) {
    const hold = holdFirstTurn();
    const run = clientRun({fakeOptions: hold.options});
    run.input.write('Wait for an interrupt.\n');
    await until(() => hold.held, 'the held turn');
    run.signal(signal);
    await until(run.ended, 'the client exit');
    run.input.end();
    assert.deepEqual(run.f.sent.filter(message => message.method === 'turn/interrupt' || message.ended).map(message => message.method ?? 'stdin ended'), ['turn/interrupt', 'stdin ended'], signal);
    if (signal === 'SIGTERM') {
      assert.equal(await run.code, 0);
      assert.deepEqual(run.lines().slice(HEADER.length + READY.length), ['[Stopping the controller...]', '[You stopped the turn. The controller stops now.]', STOPPED]);
    } else {
      // A lost terminal: the client stops the controller, writes to no terminal, and exits with code 1.
      assert.equal(await run.code, 1);
      assert.deepEqual(run.lines().slice(HEADER.length + READY.length), []);
    }
  }
  // At Ready, with no turn, SIGHUP stops the controller too.
  const idle = clientRun();
  await until(() => idle.lines().includes(READY[1]), 'the Ready lines');
  idle.signal('SIGHUP');
  await until(idle.ended, 'the client exit');
  idle.input.end();
  assert.equal(await idle.code, 1);
  assert.deepEqual(idle.f.sent.filter(message => message.ended).length, 1, 'the controller stdin ended');
});

test('client: a user config without model and model_provider starts; the Ready line shows the thread model as the Codex default (R1526-2, R1545-1)', async () => {
  const run = await client(['Say one synthetic sentence.'], {edit: stream => {
    const read = stream.find(entry => entry.after === 'config/read' && entry.reply).reply;
    read.config.model = null; read.config.model_provider = null;
    delete read.origins.model; delete read.origins.model_provider;
    return stream;
  }});
  assert.equal(run.code, 0);
  assert.deepEqual(run.lines(), [...HEADER,
    '[Ready: task T400, run R1461. The chief uses your Codex config: model "synthetic" (the Codex default), approval "on-request", sandbox "read-only".]', READY[1],
    WARNING, `chief> ${SYNTHETIC_REPLY}`, '[Turn completed.]', STOPPED]);
});

test('client: a refused line keeps its fix when another typed line waits (R1546-2)', async () => {
  const run = await client(['x'.repeat(64 * 1024 + 1), 'Say one synthetic sentence.']);
  assert.equal(run.code, 0);
  assert.deepEqual(run.lines().slice(HEADER.length + READY.length), [
    '[The client did not send the line: The line has 65537 bytes; a line must be text of 1 to 65536 bytes, with no NUL. Shorten or correct the line, then type it again.]',
    WARNING, `chief> ${SYNTHETIC_REPLY}`, '[Turn completed.]', STOPPED]);
});

test('client: a controller warning of several lines shows several prefixed lines, with no U+FFFD for the newlines (R1546-3)', async () => {
  const summary = 'Project-local config is disabled in these folders:\n    1. /p/.codex\n       Trust the project to load it.\n';
  const run = await client([], {edit: stream => {
    stream.splice(stream.findIndex(entry => entry.after === 'thread/start'), 0, {after: 'thread/start', notification: {method: 'configWarning', params: {summary, path: '/p/.codex/config.toml'}}},
      {after: 'thread/start', notification: {method: 'warning', params: {message: 'first\r\nsecond'}}});
    return stream;
  }});
  assert.equal(run.code, 0);
  assert.deepEqual(run.lines().slice(HEADER.length, HEADER.length + 5), [
    '[Warning about your Codex config: Project-local config is disabled in these folders:]',
    '[Warning about your Codex config:     1. /p/.codex]',
    '[Warning about your Codex config:        Trust the project to load it. (/p/.codex/config.toml)]',
    '[Warning from the controller: first]', '[Warning from the controller: second]']);
  assert.equal(run.text().includes('�'), false, run.text());
});

test('client: a crash during a turn and at the start give plain words, one wording for each event (R1545-2)', async () => {
  const hold = holdFirstTurn();
  const run = clientRun({fakeOptions: hold.options});
  run.input.write('Wait for an interrupt.\n');
  await until(() => hold.held, 'the held turn');
  run.f.close(1);
  await until(run.ended, 'the client exit');
  run.input.end();
  assert.equal(await run.code, 1);
  assert.deepEqual(run.lines().slice(HEADER.length + READY.length), [
    '[The result of the turn is unknown: the controller process ended by itself. No later line can run. Check the project for changes from this turn. Start the client again.]',
    '[The session ended early: the controller process ended by itself. Start the client again.]']);
  // The controller ends before it answers initialize.
  const early = clientRun({fakeOptions: {onRequest: (message, {close}) => (message.method === 'initialize' ? (queueMicrotask(() => close(1)), false) : undefined)}});
  early.input.end();
  assert.equal(await early.code, 1);
  assert.deepEqual(early.lines(), [...HEADER, '[The controller did not start: the controller process ended by itself. Check that SAGE_CODEX_CONTROLLER_BIN is the fork binary and that your Codex config file loads. Start the client again.]']);
});

test('client: a turn with no controller event for 15 s shows the wait note once; the note goes with the turn (R1545-3)', async () => {
  const hold = holdFirstTurn();
  const run = clientRun({fakeOptions: hold.options});
  run.input.write('Wait for an interrupt.\n');
  await until(() => hold.held, 'the held turn');
  run.f.fire(15000);
  assert.equal(run.lines().at(-1), '[Waiting for the model. Press Ctrl-C to stop the turn.]');
  // Once for each turn: no second wait timer runs in this turn.
  assert.throws(() => run.f.fire(15000), /a live timer of 15000/);
  run.signal('SIGINT');
  await until(() => run.lines().at(-1) === `[You stopped the turn. ${NEXT}]`, 'the stopped turn');
  run.input.end('Say one synthetic sentence.\n');
  assert.equal(await run.code, 0);
  assert.deepEqual(run.lines().filter(line => line.startsWith('[Waiting')).length, 1);
  assert.throws(() => run.f.fire(15000), /a live timer of 15000/, 'the wait ends with its turn');
});

test('client: a terminal that takes no output stops the turn once with a message, and drops output past 8 MiB (R1544-4)', async () => {
  const hold = holdFirstTurn({answerInterrupt: false});
  const run = clientRun({fakeOptions: hold.options});
  run.input.write('Wait for an interrupt.\n');
  await until(() => hold.held, 'the held turn');
  // The terminal stops taking output: more than 8 MiB waits in its queue.
  run.output.writableLength = 8 * 1024 * 1024 + 1;
  run.f.emit([{method: 'item/completed', params: {threadId: THREAD, turnId: 'held-turn', item: {type: 'agentMessage', id: 'm-1', text: 'dropped one'}}},
    {method: 'item/completed', params: {threadId: THREAD, turnId: 'held-turn', item: {type: 'agentMessage', id: 'm-2', text: 'dropped two'}}}]);
  await until(() => run.f.methods().includes('turn/interrupt'), 'the stop of the turn');
  // The terminal takes output again before the turn ends.
  run.output.writableLength = 0;
  run.f.emit([{method: 'turn/completed', params: {threadId: THREAD, turn: {id: 'held-turn', items: [], status: 'interrupted', error: null}}}]);
  await until(() => run.lines().at(-1).startsWith('[The client stopped the turn'), 'the turn result');
  run.input.end();
  assert.equal(await run.code, 0);
  assert.deepEqual(run.lines().slice(HEADER.length + READY.length), [
    '[The terminal takes no output: more than 8 MiB waits for it. The client stopped the turn, and it drops output until the terminal takes output again. If you pressed Ctrl-S, press Ctrl-Q.]',
    `[The client stopped the turn, because the terminal took no output. ${NEXT}]`, STOPPED]);
  assert.deepEqual(run.f.methods().filter(method => method === 'turn/interrupt'), ['turn/interrupt']);
});

// The client reads a terminal on stdin in raw mode, which turns the terminal's own Ctrl-S off: the 8 MiB message then
// says nothing about Ctrl-S or Ctrl-Q (T424 F1).
test('client: in raw mode, the 8 MiB message does not name Ctrl-S or Ctrl-Q (T424 F1)', async () => {
  const hold = holdFirstTurn({answerInterrupt: false});
  const run = clientRun({fakeOptions: hold.options, tty: true});
  await until(() => run.lines().at(-1) === READY_TTY, 'the Ready lines');
  assert.equal(run.input.isRaw, true);
  run.input.write('Wait for an interrupt.\r');
  await until(() => hold.held, 'the held turn');
  run.output.writableLength = 8 * 1024 * 1024 + 1;
  run.f.emit([{method: 'item/completed', params: {threadId: THREAD, turnId: 'held-turn', item: {type: 'agentMessage', id: 'm-1', text: 'dropped one'}}}]);
  await until(() => run.f.methods().includes('turn/interrupt'), 'the stop of the turn');
  run.output.writableLength = 0;
  run.f.emit([{method: 'turn/completed', params: {threadId: THREAD, turn: {id: 'held-turn', items: [], status: 'interrupted', error: null}}}]);
  await until(() => run.lines().at(-1).startsWith('[The client stopped the turn'), 'the turn result');
  run.input.write('\x04');
  assert.equal(await run.code, 0);
  assert.deepEqual(run.lines().slice(HEADER.length + READY.length), ['Wait for an interrupt.',
    '[The terminal takes no output: more than 8 MiB waits for it. The client stopped the turn, and it drops output until the terminal takes output again.]',
    `[The client stopped the turn, because the terminal took no output. ${NEXT}]`, STOPPED]);
});

// The terminal stays paused past the end of the stopped turn and through the next turn. The result lines wait, and
// show when the stream says 'drain'; other output of that time is dropped, and the result says so (R1554-2, R1555-1).
test('client: after the 8 MiB stop, each turn result shows when the terminal takes output again, also when it is still paused at the end of the turn', async () => {
  const hold = holdFirstTurn();
  const run = clientRun({fakeOptions: hold.options});
  run.input.write('Wait for an interrupt.\n');
  await until(() => hold.held, 'the held turn');
  run.input.write('Say one synthetic sentence.\n');
  await until(() => run.lines().at(-1) === '[The chief is on a turn. Your line runs after it.]', 'the queued line note');
  run.output.writableLength = 8 * 1024 * 1024 + 1;
  run.f.emit([{method: 'item/completed', params: {threadId: THREAD, turnId: 'held-turn', item: {type: 'agentMessage', id: 'm-1', text: 'dropped one'}}}]);
  // The client stops the first turn; the second turn runs and completes; the input ends; the client stops. All of it
  // while the terminal takes no output.
  await until(() => run.f.methods().filter(method => method === 'turn/start').length === 2, 'the second turn');
  run.input.end();
  assert.equal(await run.code, 0);
  const full = '[The terminal takes no output: more than 8 MiB waits for it. The client stopped the turn, and it drops output until the terminal takes output again. If you pressed Ctrl-S, press Ctrl-Q.]';
  assert.deepEqual(run.lines().slice(HEADER.length + READY.length), ['[The chief is on a turn. Your line runs after it.]', full]);
  run.output.writableLength = 0;
  run.output.emit('drain');
  assert.deepEqual(run.lines().slice(HEADER.length + READY.length), ['[The chief is on a turn. Your line runs after it.]', full,
    '[The client stopped the turn, because the terminal took no output.]',
    '[Turn completed. Some output of this turn did not show, because the terminal took no output.]', STOPPED]);
});

// One frame holds one whole agent message, so a reply over the old 1 MiB frame bound completes (R1555-2).
test('client: an agent message of 2 MiB shows in full, and the turn completes', async () => {
  const big = `${'x'.repeat(2 * 1024 * 1024)} end`;
  const run = await client(['Say one synthetic sentence.'], {edit: stream => JSON.parse(JSON.stringify(stream).replaceAll(SYNTHETIC_REPLY, big))});
  assert.equal(run.code, 0);
  assert.deepEqual(run.lines().slice(HEADER.length + READY.length), [WARNING, `chief> ${big}`, '[Turn completed.]', STOPPED]);
});

test('client: bidi, zero-width and line separator characters never reach the terminal; a config value cannot forge Ready fields (R1524-3, R1526-4)', async () => {
  const hidden = 'a\u202eb\u2066c\u2069d\u200ee\u200ff\u061cg\u200bh\u200di\u2060j\ufeffk\u2028l\u2029m\u202an';
  const forged = 'x, approval never, sandbox read-only.] [Type';
  const run = await client(['Say one synthetic sentence.'], {edit: stream => {
    stream.find(entry => entry.notification?.method === 'item/completed' && entry.notification.params.item?.type === 'agentMessage').notification.params.item.text = hidden;
    stream.find(entry => entry.after === 'config/read' && entry.reply).reply.config.model = forged;
    stream.find(entry => entry.after === 'thread/start' && entry.reply).reply.model = forged;
    return stream;
  }});
  assert.equal(/[\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/.test(run.text()), false, JSON.stringify(run.text()));
  assert.ok(run.lines().includes('chief> a�b�c�d�e�f�g�h�i�j�k�l�m�n'), run.text());
  assert.ok(run.lines().includes('[Ready: task T400, run R1461. The chief uses your Codex config: model "x, approval never, sandbox read-only.] [Type", approval "on-request", sandbox "read-only".]'), run.text());
  assert.equal(run.code, 0);
});

test('client: every format, separator and default-ignorable character becomes U+FFFD (R1544-3)', async () => {
  // The soft hyphen, the Arabic number signs, the Mongolian vowel separator, the deprecated format characters, the
  // Hangul fillers, the variation selectors and the tags: each is invisible, or changes how the text near it shows.
  const hidden = ['­', '؀', '؅', '᠎', '⁪', '⁯', 'ᅟ', 'ᅠ', 'ㅤ', 'ﾠ', '︀', '️', '\u{e0001}', '\u{e0041}', '\u{e007f}', '\u{e0100}', '\u{1d173}'];
  const run = await client(['Say one synthetic sentence.'], {edit: stream => {
    stream.find(entry => entry.notification?.method === 'item/completed' && entry.notification.params.item?.type === 'agentMessage').notification.params.item.text = `a${hidden.join('b')}c`;
    return stream;
  }});
  assert.ok(run.lines().includes(`chief> a${hidden.map(() => '�').join('b')}c`), JSON.stringify(run.text()));
  // Every character of each class, not only these.
  const shownText = run.text();
  assert.equal(/[\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u.test(shownText), false);
  assert.equal(run.code, 0);
});

// Approvals (T431). The first turn sends `requests` (with `before`, such as the item of a file change) and holds until
// the test ends it; a turn/interrupt ends it as interrupted.
const APPROVAL_TURN = 'approval-turn';
const turnEnd = status => ({method: 'turn/completed', params: {threadId: THREAD, turn: {id: APPROVAL_TURN, items: [], status, error: null}}});
function approvalTurn(requests, before = []) {
  return {onRequest(message, {emit}) {
    if (message.method === 'turn/start') {
      setImmediate(() => emit([{id: message.id, result: {turn: {id: APPROVAL_TURN, status: 'inProgress', items: []}}}, ...before, ...requests]));
      return false;
    }
    if (message.method === 'turn/interrupt') { setImmediate(() => emit([{id: message.id, result: {}}, turnEnd('interrupted')])); return false; }
  }};
}
const ASK = 'Type y to allow it once, or n to refuse it.';
const PASTE_START = '\x1b[200~', PASTE_END = '\x1b[201~';
const CLEARED = '[The client cleared your typed text, because an approval request came. Type it again after you answer.]';
const NOT_SENT = '[Your line did not go to the chief, because an approval request waits. Answer it, then type your line again.]';
const PASTED = '[A pasted line cannot answer an approval request, and it did not go to the chief. Type y or n.]';
const NO_QUESTION = '[No approval request waits, so your line did not go to the chief. To answer the chief, type yes or no.]';
const SETTLED = '[The client dropped the keys that you pressed as the approval request showed. Read it, then type y or n.]';
const refusedBig = (action, why) => `[Agent /root (the chief) asked to ${action}, but ${why}, so the client refused it.]`;
const tooSmall = (action, need, height = 24) => `[Agent /root (the chief) asked to ${action}, but the request needs ${need} rows and your terminal shows ${height}, so the client refused it. Make the terminal window larger to see such a request.]`;
const unread = action => `[Agent /root (the chief) asked to ${action}, but the client cannot read the request, so the client refused it.]`;
const RELATIVE = 'paths: relative to the project folder';
const NOTE = 'note: \\uXXXX is one character, shown as its code.';
/** The client wraps each line of a question block at the terminal width; each wrapped row starts with "  | ". This
 * joins each wrapped row to its line again, so a test can compare whole lines. */
const unwrap = lines => lines.reduce((all, line) => (line.startsWith('  | ') && all.length ? [...all.slice(0, -1), all.at(-1) + line.slice(4)] : [...all, line]), []);
const REFUSAL = {code: -32601, message: 'Controller transport does not handle this server request'};
const replies = (run, ids) => run.f.sent.filter(message => ids.includes(message.id) && !message.method);
const turnTexts = run => run.f.sent.filter(message => message.method === 'turn/start').map(message => message.params.input[0].text);
const shownOf = run => unwrap(run.lines().slice(HEADER.length + READY.length));
/** The rows that the lines take on a terminal `columns` wide, as a terminal draws them: a mark takes no column, each
 * other character 1 (a block of the client has only printable ASCII; the mark rule is for older output). `first`
 * says that a row is the start of a line. */
const terminalRows = (lines, columns) => lines.flatMap(line => {
  const all = [{row: '', first: true}];
  let used = 0;
  for (const char of line) {
    const width = /\p{M}/u.test(char) ? 0 : 1;
    if (used + width > columns) { all.push({row: '', first: false}); used = 0; }
    all.at(-1).row += char; used += width;
  }
  return all;
});
/** The last `rows` rows that the lines take on a terminal `columns` wide. */
const screen = (lines, columns = 80, rows = 24) => terminalRows(lines, columns).map(each => each.row).slice(-rows);
/** Types a line that starts the approval turn, then the answers after the first question shows; ends the turn. A
 * `size` sets the terminal size that the output gives (80 columns and 24 rows when it gives none). */
async function approvalRun(requests, answers, {before = [], size} = {}) {
  const run = clientRun({fakeOptions: approvalTurn(requests, before)});
  Object.assign(run.output, size);
  run.input.write('Do the work.\n');
  await until(() => run.lines().some(line => line.startsWith('[Approval: ') || line.startsWith('[Agent ')), 'the first question');
  run.input.write(answers.map(text => `${text}\n`).join(''));
  await until(() => replies(run, requests.map(request => request.id)).length === requests.length, 'a reply to each request');
  run.f.emit([turnEnd('completed')]);
  await until(() => run.lines().includes('[Turn completed.]'), 'the turn end');
  run.input.end();
  return {...run, code: await run.code, shown: shownOf(run)};
}
const command = (id, params = {}) => ({id, method: 'item/commandExecution/requestApproval', params: {threadId: THREAD, turnId: APPROVAL_TURN, itemId: `item-${id}`,
  startedAtMs: 1, command: 'npm install', cwd: PROJECT, reason: 'needs network',
  // The controller lists a lasting amendment too (T421); the client never offers or sends it.
  availableDecisions: ['accept', {acceptWithExecpolicyAmendment: {execpolicy_amendment: ['npm', 'install']}}, 'cancel'], ...params}});
/** The question block: its first line names the agent and the action; each field is one line; the last line says how to answer. */
const block = (action, fields, agent = '/root (the chief)') => [`[Approval: agent ${agent} asks to ${action}.]`, ...fields.map(field => `  ${field}`), ASK];
const COMMAND_BLOCK = block('run a command', ['command: "npm install"', 'folder: the project folder', 'reason: "needs network"']);
const PATCH = {method: 'item/started', params: {threadId: THREAD, turnId: APPROVAL_TURN, item: {type: 'fileChange', id: 'patch-1', status: 'inProgress',
  changes: [{path: `${PROJECT}/a.txt`, kind: {type: 'add'}, diff: 'a'}, {path: `${PROJECT}/b.txt`, kind: {type: 'add'}, diff: 'b'}]}}};
const permissions = (id, asked, params = {}) => ({id, method: 'item/permissions/requestApproval', params: {threadId: THREAD, turnId: APPROVAL_TURN, itemId: 'perm-1', startedAtMs: 1,
  cwd: PROJECT, reason: 'fetch the docs', permissions: asked, ...params}});
// The MCP tool call that the fork starts before it asks with requestUserInput (core/src/mcp_tool_call.rs).
const MCP_CALL = {method: 'item/started', params: {threadId: THREAD, turnId: APPROVAL_TURN, item: {type: 'mcpToolCall', id: 'call-1', server: 'docs', tool: 'search', status: 'inProgress', arguments: {query: 'dark theme'}}}};
const mcpQuestion = (id, params = {}, question = {}) => ({id, method: 'item/tool/requestUserInput', params: {threadId: THREAD, turnId: APPROVAL_TURN, itemId: 'call-1', isBlocking: true,
  questions: [{id: 'mcp_tool_call_approval_call-1', header: 'Approve app tool call?', question: 'Allow docs to run tool "search"?', isOther: false, isSecret: false,
    options: [{label: 'Allow', description: 'Run the tool and continue.'}, {label: 'Allow for this session', description: 'Remember.'}, {label: 'Cancel', description: 'Cancel this tool call.'}], ...question}], ...params}});
const elicitation = (id, params = {}) => ({id, method: 'mcpServer/elicitation/request', params: {threadId: THREAD, turnId: APPROVAL_TURN, serverName: 'docs',
  mode: 'form', message: 'Allow docs to run tool "search"?', requestedSchema: {type: 'object', properties: {}}, _meta: {codex_approval_kind: 'mcp_tool_call', persist: ['session', 'always'], tool_params: {query: 'dark theme'}}, ...params}});
const KINDS = [
  ['a command', [command('s-1')], COMMAND_BLOCK, {decision: 'accept'}, {decision: 'decline'}],
  ['a file change', [{id: 's-1', method: 'item/fileChange/requestApproval', params: {threadId: THREAD, turnId: APPROVAL_TURN, itemId: 'patch-1', startedAtMs: 1, reason: 'adds two notes', grantRoot: null}}],
    block('change files', ['file: "a.txt" (new)', 'file: "b.txt" (new)', 'reason: "adds two notes"', RELATIVE]), {decision: 'accept'}, {decision: 'decline'}, [PATCH]],
  ['a permission request', [permissions('s-1', {network: {enabled: true}, fileSystem: {read: null, write: ['/tmp/cache']}})],
    block('get network and file access', ['folder: the project folder', 'reason: "fetch the docs"', 'access: the network', 'access: "/tmp/cache" (write)']),
    // Yes grants the asked permissions for this turn only; no grants none.
    {permissions: {network: {enabled: true}, fileSystem: {read: null, write: ['/tmp/cache']}}, scope: 'turn'}, {permissions: {}, scope: 'turn'}],
  // A network approval has no command and no folder: the controller sends the host (R1594-4).
  ['a host connection', [command('s-1', {command: null, cwd: null, reason: 'Network access to "registry.npmjs.org" is blocked by policy.', networkApprovalContext: {host: 'registry.npmjs.org', protocol: 'https'}})],
    block('connect to a host', ['host: "registry.npmjs.org", protocol "https"', 'reason: "Network access to \\"registry.npmjs.org\\" is blocked by policy."']), {decision: 'accept'}, {decision: 'decline'}],
  ['an MCP tool approval form', [elicitation('s-1')], block('use an MCP tool', ['server: "docs"', 'message: "Allow docs to run tool \\"search\\"?"', 'arguments: {"query":"dark theme"}']),
    // No persist value: an accept is for this call only.
    {action: 'accept', content: null, _meta: null}, {action: 'decline', content: null, _meta: null}],
  ['an MCP tool approval question', [mcpQuestion('s-1')], block('use an MCP tool', ['server: "docs"', 'tool: "search"', 'message: "Allow docs to run tool \\"search\\"?"', 'arguments: {"query":"dark theme"}']),
    {answers: {'mcp_tool_call_approval_call-1': {answers: ['Allow']}}}, {answers: {'mcp_tool_call_approval_call-1': {answers: ['Cancel']}}}, [MCP_CALL]],
];
for (const [kind, requests, question, accept, decline, before] of KINDS) {
  for (const [typed, result, said] of [['y', accept, '[You allowed it once.]'], ['N', decline, '[You refused it.]']]) {
    test(`client: ${kind} asks the owner in a question block; ${typed} sends ${typed === 'y' ? 'accept' : 'decline'} only (T431, R1594-4)`, async () => {
      const run = await approvalRun(requests, [typed], {before});
      assert.equal(run.code, 0);
      assert.deepEqual(run.shown, [...question, said, '[Turn completed.]', STOPPED]);
      assert.deepEqual(replies(run, ['s-1']), [{id: 's-1', result}]);
      // The answer is no turn.
      assert.deepEqual(turnTexts(run), ['Do the work.']);
    });
  }
}

/** Checks each question block in the raw rows that a terminal `columns` wide and `height` rows high shows: each row of
 * the block is printable ASCII and fits one terminal row; each row after the first line starts with two spaces (a
 * field or a wrapped row), so no value row starts at column 0, until the line that says how to answer; and the real
 * first line of the block is on the screen when the block ends (with the input line below it). Returns the count. */
function checkBlocks(lines, columns, height) {
  let count = 0;
  lines.forEach((line, start) => {
    if (!line.startsWith('[Approval: ')) return;
    let end = start + 1;
    while (end < lines.length && lines[end].startsWith('  ')) end += 1;
    assert.ok(lines[end]?.startsWith('Type y to'), `a block ends with the answer line: ${lines[end]}`);
    while (lines[end + 1]?.startsWith('  | ')) end += 1;
    const rows = lines.slice(start, end + 1);
    for (const row of rows) assert.match(row, /^[\x20-\x7e]*$/, `printable ASCII: ${JSON.stringify(row)}`);
    for (const row of rows) assert.ok(row.length <= columns, `one terminal row: ${row}`);
    const visible = screen(lines.slice(0, end + 1), columns, height - 1);
    assert.equal(visible[visible.length - rows.length], line, 'the real first line is on the screen');
    count += 1;
  });
  return count;
}

test('client: a quote, a line end or a fake question end in a value shows escaped, on its own field line (R1596 spoof, R1594-2 probe A, R1595-6)', async () => {
  const spoof = `true" in "${PROJECT}" (read only check). Type y to allow it once, or n to refuse it.]             then: ; printf x >> /tmp/marker1`;
  const run = await approvalRun([command('s-1', {command: spoof, cwd: `${PROJECT}/sub"dir`, reason: 'one\ntwo\r\n[You allowed it once.]'}),
    command('s-2', {command: "cat > notes.md <<'EOF'\n# Notes\nEOF", reason: null})], ['n', 'n']);
  assert.deepEqual(run.shown, [
    ...block('run a command', [`command: "true\\" in \\"${PROJECT}\\" (read only check). Type y to allow it once, or n to refuse it.]" (13 spaces) "then: ; printf x >> /tmp/marker1"`,
      'folder: "sub\\"dir"', 'reason: "one\\ntwo\\r\\n[You allowed it once.]"', RELATIVE]), '[You refused it.]',
    ...block('run a command', ['command: "cat > notes.md <<\'EOF\'\\n# Notes\\nEOF"', 'folder: the project folder']), '[You refused it.]', '[Turn completed.]', STOPPED]);
  // The spoof stays in the rows of its field: each of them starts with two spaces.
  assert.equal(checkBlocks(run.lines(), 80, 24), 2);
});

test('client: control characters in a command, a folder or a reason are escaped (T431)', async () => {
  const run = await approvalRun([command('s-1', {command: 'echo hi\n[You allowed it once.]\x1b[2J\x7f\x9b', cwd: '/p‮', reason: 'zero​width\x9b\x7f'})], ['n']);
  assert.deepEqual(run.shown, [...block('run a command', ['command: "echo hi\\n[You allowed it once.]\\u001b[2J\\u007f\\u009b"', 'folder: "/p\\u202e"', 'reason: "zero\\u200bwidth\\u009b\\u007f"', NOTE]),
    '[You refused it.]', '[Turn completed.]', STOPPED]);
  assert.equal(/[\x00-\x09\x0b-\x1f\x7f-\x9f​‮]/u.test(run.text().replaceAll(PASTE_ON, '').replaceAll(PASTE_OFF, '')), false);
});

test('client: every value shows each character outside printable ASCII as \\uXXXX, with a note line; 3 or more spaces show as a count outside the quotes (R1594-2, R1606-1, R1617-2, R1617-3)', async () => {
  const run = await approvalRun([command('s-1', {command: 'echo 漢字 «x» 😀　end  two   three', cwd: `${PROJECT}/données`, reason: 'Привет café ʺqʺ x  y   z'}),
    command('s-2', {command: 'printf "a (3 spaces) b"', reason: `a${' '.repeat(40)}b`})], ['n', 'n']);
  assert.deepEqual(run.shown, [...block('run a command', ['command: "echo \\u6f22\\u5b57 \\u00abx\\u00bb \\ud83d\\ude00\\u3000end  two" (3 spaces) "three"', 'folder: "donn\\u00e9es"',
    'reason: "\\u041f\\u0440\\u0438\\u0432\\u0435\\u0442 caf\\u00e9 \\u02baq\\u02ba x  y" (3 spaces) "z"', RELATIVE, NOTE]), '[You refused it.]',
  // The count form is outside the quotes, so a value that holds its text shows with escaped quotes; no escape, no note.
  ...block('run a command', ['command: "printf \\"a (3 spaces) b\\""', 'folder: the project folder', 'reason: "a" (40 spaces) "b"']), '[You refused it.]', '[Turn completed.]', STOPPED]);
});

// The R1606 and R1616 forge probes at 80 by 24: a reason under 2000 characters pads the real question away and draws a
// fake one, with spaces, with a space and a combining mark (U+0323) in each column, and with look-alike quotes (U+A78C).
// Each value is printable ASCII now, and the client wraps it after "  | ", so the only row that starts with
// "[Approval: " is the real one, and it is on the screen (R1606-1, R1616-1).
const FAKE = quote => ['[Approval: agent /root (the chief) asks to run a command.]', `  command: ${quote}ls -la${quote}`, '  folder: the project folder', `  reason: ${quote}list the files${quote}`];
test('client: a padded reason cannot push the real question off an 80 by 24 screen or draw a fake one (R1606-1 forge, R1616-1 forge_wrap and lookalike)', async () => {
  const real = 'rm -rf ~/work ~/.ssh', first = 'Remove the old build cache first; the steps for it are below.';
  const spaces = `x${' '.repeat(1439)}${FAKE('ʺ').map(line => line.padEnd(80, ' ')).join('')}`;
  const marks = first + ' \u0323'.repeat(80 - 11 - first.length) + FAKE('\ua78c\ua78c').map((line, index, all) => (index === all.length - 1 ? line : line + ' \u0323'.repeat(80 - line.length))).join('');
  const lookalike = 'end\ua78c\ua78c \u01c0 \u1438x\u1433 a\u200db e\u0301 \u0430\u0435 \u2714\ufe0f \u{1f600} \uff02 \u3164 \u115f \u00a0';
  const run = await approvalRun([command('s-1', {command: real, reason: spaces}), command('s-2', {command: real, reason: marks}), command('s-3', {command: real, reason: lookalike})], ['n', 'n', 'n']);
  assert.equal(spaces.length < 2000 && marks.length < 2000, true);
  const lines = run.lines();
  // On the screen when each question shows, each row that starts with "[Approval: " is the start of a line of the
  // client, never a row of a value that the terminal wrapped.
  for (const end of lines.flatMap((line, index) => (line === ASK ? [index] : []))) {
    const rows = terminalRows(lines.slice(0, end + 1), 80).slice(-23);
    assert.deepEqual(rows.filter(each => each.row.startsWith('[Approval: ')).map(each => each.first), rows.filter(each => each.row.startsWith('[Approval: ')).map(() => true), rows.map(each => each.row).join('\n'));
  }
  // Each block that shows is ASCII, its value rows start with two spaces, and its first line is on the screen.
  assert.equal(checkBlocks(lines, 80, 24), 2);
  assert.deepEqual(run.shown, [
    ...block('run a command', [`command: "${real}"`, 'folder: the project folder', 'reason: "x" (1439 spaces) "[Approval: agent /root (the chief) asks to run a command.]" (24 spaces) "command: \\u02bals -la\\u02ba" (63 spaces) "folder: the project folder" (54 spaces) "reason: \\u02balist the files\\u02ba" (54 spaces) ""', NOTE]),
    '[You refused it.]', tooSmall('run a command', 25),
    ...block('run a command', [`command: "${real}"`, 'folder: the project folder', 'reason: "end\\ua78c\\ua78c \\u01c0 \\u1438x\\u1433 a\\u200db e\\u0301 \\u0430\\u0435 \\u2714\\ufe0f \\ud83d\\ude00 \\uff02 \\u3164 \\u115f \\u00a0"', NOTE]),
    // The third n came for the request that the client refused: no question waits for it.
    '[You refused it.]', NO_QUESTION, '[Turn completed.]', STOPPED]);
});

test('client: the client wraps each line of a block at the terminal width, and each wrapped row starts with "  | " (T431, R1616-1)', async () => {
  const run = await approvalRun([command('s-1', {reason: 'abcdefghij'.repeat(6)})], ['n'], {size: {columns: 40, rows: 24}});
  assert.deepEqual(run.lines().slice(HEADER.length + READY.length, HEADER.length + READY.length + 8), [
    '[Approval: agent /root (the chief) asks ', '  | to run a command.]', '  command: "npm install"', '  folder: the project folder',
    '  reason: "abcdefghijabcdefghijabcdefghi', '  | jabcdefghijabcdefghijabcdefghij"', 'Type y to allow it once, or n to refuse ', '  | it.']);
});

test('client: a block fits when its rows, the rows of the note above it and the input line fit the terminal; else it is refused at once, with the rows it needs (R1606-1, R1617-1)', async () => {
  // At 80 by 24: the header, command, folder and answer lines take 4 rows, the note above the block 2 and the input
  // line 1. A reason line of 1296 characters takes 17 rows (80, then 76 for each wrapped row): 24 rows in all.
  const fits = await approvalRun([command('s-1', {reason: 'r'.repeat(1284)})], ['n']);
  assert.equal(fits.lines().filter(line => line.startsWith('  | ')).length, 16);
  assert.deepEqual(fits.shown, [...block('run a command', ['command: "npm install"', 'folder: the project folder', `reason: "${'r'.repeat(1284)}"`]), '[You refused it.]', '[Turn completed.]', STOPPED]);
  const over = await approvalRun([command('s-1', {reason: 'r'.repeat(1285)})], []);
  assert.deepEqual(over.shown, [tooSmall('run a command', 25), '[Turn completed.]', STOPPED]);
  assert.deepEqual(replies(over, ['s-1']), [{id: 's-1', result: {decision: 'decline'}}]);
  // At 200 columns it shows.
  const large = await approvalRun([command('s-1', {reason: 'r'.repeat(1285)})], ['y'], {size: {columns: 200, rows: 24}});
  assert.equal(large.shown.at(-3), '[You allowed it once.]');
});

// R1615-1 and R1616-3 (khitan, cyrillic): letters that a terminal draws 2 columns wide. Each shows as escapes now, 1
// column for each character, so the client counts the rows of the block exactly.
test('client: wide and ambiguous-width letters show as escapes, and the rows of the block count exactly (R1615-1, R1616-3 khitan and cyrillic)', async () => {
  const run = await approvalRun([command('s-1', {command: 'rm -rf ~/work', reason: String.fromCodePoint(0x18B00).repeat(900)}), command('s-2', {command: 'rm -rf ~/work', reason: '\u043e'.repeat(1300)}),
    command('s-3', {command: 'rm -rf ~/work', reason: `${String.fromCodePoint(0x18B00)}\u043e`})], ['n', 'n', 'n']);
  // 900 letters outside the BMP are 10800 characters of escapes: a reason line of 143 rows. 1300 letters: 103 rows.
  assert.deepEqual(run.shown, [tooSmall('run a command', 151), tooSmall('run a command', 111),
    ...block('run a command', ['command: "rm -rf ~/work"', 'folder: the project folder', 'reason: "\\ud822\\udf00\\u043e"', NOTE]), '[You refused it.]', NO_QUESTION, NO_QUESTION, '[Turn completed.]', STOPPED]);
  assert.deepEqual(replies(run, ['s-1', 's-2', 's-3']).map(reply => reply.result.decision), ['decline', 'decline', 'decline']);
});

test('client: each show checks the size again, so a block that no longer fits after a resize is refused at its next show (R1616-2 resize)', async () => {
  const run = clientRun({fakeOptions: approvalTurn([command('s-1', {command: 'rm -rf ~/work', reason: 'z'.repeat(1990)})])});
  Object.assign(run.output, {columns: 80, rows: 40});
  run.input.write('Do the work.\n');
  await until(() => run.lines().includes(ASK), 'the question');
  run.output.rows = 24;
  run.f.emit([{method: 'item/completed', params: {threadId: THREAD, turnId: APPROVAL_TURN, item: {type: 'agentMessage', id: 'm-1', text: 'Working on it.'}}}]);
  await until(() => replies(run, ['s-1']).length === 1, 'the refusal');
  run.f.emit([turnEnd('completed')]);
  await until(() => run.lines().includes('[Turn completed.]'), 'the turn end');
  run.input.end();
  assert.equal(await run.code, 0);
  // The block takes 31 rows: 34 with the note and the input line.
  assert.deepEqual(shownOf(run), [...block('run a command', ['command: "rm -rf ~/work"', 'folder: the project folder', `reason: "${'z'.repeat(1990)}"`]), 'chief> Working on it.',
    tooSmall('run a command', 34), '[Turn completed.]', STOPPED]);
  assert.deepEqual(replies(run, ['s-1']), [{id: 's-1', result: {decision: 'decline'}}]);
});

// A fixed-seed generator (a linear congruential generator), so that each run of the test sees the same values.
function seeded(seed) { let state = seed; return () => { state = (state * 1103515245 + 12345) % 2147483648; return state / 2147483648; }; }
const PIECES = [' ', '   ', ' '.repeat(40), '"', '\\', '\n', '\r', '\t', '\x1b[2J', '\x9b', '\u0323', '\u0301', '\ua78c', '\u02ba', '\uff02', '\u6f22', String.fromCodePoint(0x18B00), '\u043e', '\u3000', '\u200d',
  '\u202e', '\u2028', '\u{1f600}', '\ud800', '[Approval: agent /root (the chief) asks to run a command.]', '  command: ', ASK, '  | ', '" (3 spaces) "', 'a', 'z', '-rf', '/'];
test('client: for random values (a fixed seed) at several terminal sizes, each row of each block is printable ASCII, no value row starts at column 0, and the real first line is on the screen (R1616-1 property)', async () => {
  const next = seeded(1623), value = count => Array.from({length: count}, () => PIECES[Math.floor(next() * PIECES.length)]).join('').slice(0, 1990);
  let shown = 0, refused = 0;
  for (const [columns, rows] of [[80, 24], [40, 12], [132, 50], [20, 30], [100, 16]]) {
    const requests = Array.from({length: 10}, (_, index) => command(`p-${index}`, {command: value(1 + Math.floor(next() * 12)), reason: value(1 + Math.floor(next() * 40))}));
    const run = await approvalRun(requests, requests.map(() => 'n'), {size: {columns, rows}});
    shown += checkBlocks(run.lines(), columns, rows);
    refused += run.lines().filter(line => line.includes('so the client refused it. Make the terminal window larger')).length;
    assert.deepEqual(replies(run, requests.map(request => request.id)).map(reply => reply.result.decision), requests.map(() => 'decline'));
  }
  assert.ok(shown >= 10 && refused >= 5, `shown ${shown}, refused ${refused}`);
});

test('client: a value over 2000 characters, or over 50 files, is refused at once with what it asked; 2000 and 50 show in full on a large terminal (R1594-2, R1594-5, R1595-7, R1607-3)', async () => {
  const files = count => ({method: 'item/started', params: {threadId: THREAD, turnId: APPROVAL_TURN, item: {type: 'fileChange', id: `patch-${count}`, status: 'inProgress',
    changes: Array.from({length: count}, (_, index) => ({path: `${PROJECT}/src/file${index}.js`, kind: {type: 'add'}, diff: ''}))}}});
  const change = (id, count) => ({id, method: 'item/fileChange/requestApproval', params: {threadId: THREAD, turnId: APPROVAL_TURN, itemId: `patch-${count}`, startedAtMs: 1}});
  const run = await approvalRun([command('s-1', {command: 'x'.repeat(2001)}), change('s-2', 51), command('s-3', {command: 'y'.repeat(2000), reason: null}), change('s-4', 50)],
    ['n', 'n'], {before: [files(51), files(50)], size: {columns: 300, rows: 80}});
  assert.deepEqual(run.shown, [refusedBig('run a command', 'a value in the request is over 2000 characters'), refusedBig('change files', 'the request lists more than 50 items'),
    ...block('run a command', [`command: "${'y'.repeat(2000)}"`, 'folder: the project folder']), '[You refused it.]',
    ...block('change files', [...Array.from({length: 50}, (_, index) => `file: "src/file${index}.js" (new)`), RELATIVE]), '[You refused it.]', '[Turn completed.]', STOPPED]);
  assert.deepEqual(replies(run, ['s-1', 's-2']), [{id: 's-1', error: REFUSAL}, {id: 's-2', error: REFUSAL}]);
});

test('client: a folder inside the project shows relative to it, and one outside it (after .. parts) absolute (R1595-7)', async () => {
  const run = await approvalRun([command('s-1', {cwd: `${PROJECT}/packages/web/theme`, reason: null}), command('s-2', {cwd: `${PROJECT}/../elsewhere`, reason: null}),
    command('s-3', {cwd: `${PROJECT}/a/../..`, reason: null}), command('s-4', {cwd: `${PROJECT}x`, reason: null})], ['n', 'n', 'n', 'n']);
  const parent = join(PROJECT, '..');
  assert.deepEqual(run.shown.filter(line => line.startsWith('  folder: ')), ['  folder: "packages/web/theme"', `  folder: "${join(parent, 'elsewhere')}"`, `  folder: "${parent}"`, `  folder: "${PROJECT}x"`]);
});

test('client: the project folder shows by its name, and a block with a relative path ends with a line that says what it is relative to (R1607-2)', async () => {
  const run = await approvalRun([command('s-1', {cwd: `${PROJECT}/packages/web`, reason: null}), command('s-2', {cwd: `${PROJECT}/..`, reason: null})], ['n', 'n']);
  assert.deepEqual(run.shown, [...block('run a command', ['command: "npm install"', 'folder: "packages/web"', RELATIVE]), '[You refused it.]',
    ...block('run a command', ['command: "npm install"', `folder: "${join(PROJECT, '..')}"`]), '[You refused it.]', '[Turn completed.]', STOPPED]);
});

test('client: a path in the project that a link takes out of it shows the link target, also a target that does not exist yet (R1606-5, R1615-3)', async () => {
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'sage-link-target-')));
  try {
    symlinkSync(outside, join(PROJECT, 'linked-out'));
    // A link to a file outside the project that does not exist yet (R1615-3).
    symlinkSync(join(outside, 'missing.txt'), join(PROJECT, 'dangling'));
    mkdirSync(join(PROJECT, 'inner'), {recursive: true}); symlinkSync(join(PROJECT, 'inner'), join(PROJECT, 'linked-in'));
    const patch = {method: 'item/started', params: {threadId: THREAD, turnId: APPROVAL_TURN, item: {type: 'fileChange', id: 'patch-links', status: 'inProgress',
      changes: [{path: `${PROJECT}/linked-out/new.txt`, kind: {type: 'add'}, diff: 'a'}, {path: `${PROJECT}/linked-in/a.txt`, kind: {type: 'update', move_path: null}, diff: 'b'},
        {path: `${PROJECT}/dangling`, kind: {type: 'add'}, diff: 'c'}]}}};
    const run = await approvalRun([{id: 's-1', method: 'item/fileChange/requestApproval', params: {threadId: THREAD, turnId: APPROVAL_TURN, itemId: 'patch-links', startedAtMs: 1}},
      command('s-2', {cwd: `${PROJECT}/linked-out`, reason: null})], ['n', 'n'], {before: [patch]});
    assert.deepEqual(run.shown, [...block('change files', [`file: "linked-out/new.txt" (a link to "${outside}/new.txt", which does not exist yet) (new)`, 'file: "linked-in/a.txt" (change)',
      `file: "dangling" (a link to "${outside}/missing.txt", which does not exist yet) (new)`, RELATIVE]), '[You refused it.]',
      ...block('run a command', ['command: "npm install"', `folder: "linked-out" (a link to "${outside}")`, RELATIVE]), '[You refused it.]', '[Turn completed.]', STOPPED]);
  } finally {
    for (const name of ['linked-out', 'linked-in', 'inner', 'dangling']) rmSync(join(PROJECT, name), {recursive: true, force: true});
    rmSync(outside, {recursive: true, force: true});
  }
});

const change = (id, itemId, params = {}) => ({id, method: 'item/fileChange/requestApproval', params: {threadId: THREAD, turnId: APPROVAL_TURN, itemId, startedAtMs: 1, ...params}});
const started = (id, changes) => ({method: 'item/started', params: {threadId: THREAD, turnId: APPROVAL_TURN, item: {type: 'fileChange', id, status: 'inProgress', changes}}});

test('client: a file change shows each move target under its file, and counts it in the 50 items (R1605-1 probe 1)', async () => {
  const home = join(PROJECT, '..', 'home-r1605', '.zshrc');
  const moves = Array.from({length: 25}, (_, index) => ({path: `${PROJECT}/m${index}.txt`, kind: {type: 'update', move_path: `${PROJECT}/n${index}.txt`}, diff: ''}));
  const run = await approvalRun([change('s-1', 'patch-move'), change('s-2', 'patch-many')], ['y'],
    {before: [started('patch-move', [{path: `${PROJECT}/notes.md`, kind: {type: 'update', move_path: home}, diff: '-a\n+b'}, {path: `${PROJECT}/b.txt`, kind: {type: 'update', move_path: null}, diff: ''}]),
      started('patch-many', [...moves, {path: `${PROJECT}/last.txt`, kind: {type: 'add'}, diff: ''}])]});
  assert.deepEqual(run.shown, [...block('change files', ['file: "notes.md" (change)', `moves to: "${join(PROJECT, '..', 'home-r1605', '.zshrc')}"`, 'file: "b.txt" (change)', RELATIVE]),
    refusedBig('change files', 'the request lists more than 50 items'), ...block('change files', ['file: "notes.md" (change)', `moves to: "${home}"`, 'file: "b.txt" (change)', RELATIVE]),
    '[You allowed it once.]', '[Turn completed.]', STOPPED]);
  assert.deepEqual(replies(run, ['s-1', 's-2']), [{id: 's-2', error: REFUSAL}, {id: 's-1', result: {decision: 'accept'}}]);
});

test('client: a file change with no started fileChange item, with no changes or with a grant root is refused at once (R1605-2 probe 2)', async () => {
  // A change kind that the client does not know, or a move on a new file, cannot be read (R1617-5).
  const run = await approvalRun([change('s-1', 'patch-none'), change('s-2', 'patch-empty'), change('s-3', 'patch-1', {grantRoot: '/'}),
    change('s-4', 'patch-bad'), change('s-5', 'patch-kind'), change('s-6', 'patch-add-move')], [], {before: [started('patch-empty', []), PATCH,
    started('patch-bad', [{path: `${PROJECT}/a.txt`, kind: {type: 'update', move_path: 7}}]), started('patch-kind', [{path: `${PROJECT}/a.txt`, kind: {type: 'rename'}}]),
    started('patch-add-move', [{path: `${PROJECT}/a.txt`, kind: {type: 'add', move_path: `${PROJECT}/b.txt`}}])]});
  const unknown = '[Agent /root (the chief) asked to change files, but the client does not know which files, so the client refused it.]';
  assert.deepEqual(run.shown, [unknown, unknown, unread('change files'), unread('change files'), unread('change files'), unread('change files'), '[Turn completed.]', STOPPED]);
  assert.deepEqual(replies(run, ['s-1', 's-2', 's-3', 's-4', 's-5', 's-6']).map(reply => reply.error), [REFUSAL, REFUSAL, REFUSAL, REFUSAL, REFUSAL, REFUSAL]);
});

test('client: a permission request shows each entry: its path or a plain name, and its access; a legacy root that repeats an entry shows once (R1594-3, R1593-1, R1593-2, R1607-6)', async () => {
  const asked = {network: null, fileSystem: {read: null, write: ['/tmp/cache', `${PROJECT}/out`], entries: [
    {path: {type: 'special', value: {kind: 'root'}}, access: 'write'}, {path: {type: 'path', path: '/tmp/cache'}, access: 'write'},
    {path: {type: 'glob_pattern', pattern: '**/*.env'}, access: 'deny'}, {path: {type: 'special', value: {kind: 'minimal'}}, access: 'read'},
    {path: {type: 'special', value: {kind: 'tmpdir'}}, access: 'read'}, {path: {type: 'special', value: {kind: 'project_roots', subpath: 'docs'}}, access: 'read'},
    {path: {type: 'special', value: {kind: 'project_roots'}}, access: 'write'}, {path: {type: 'special', value: {kind: 'slash_tmp'}}, access: 'write'},
    {path: {type: 'special', value: {kind: 'unknown', path: ':future', subpath: 'x'}}, access: 'read'}]}};
  const run = await approvalRun([permissions('s-1', asked, {cwd: `${PROJECT}/web`}), permissions('s-2', {network: {enabled: true}})], ['y', 'n']);
  assert.deepEqual(run.shown, [...block('get file access', ['folder: "web"', 'reason: "fetch the docs"', 'access: the whole disk (write)', 'access: "/tmp/cache" (write)',
    'access: the files that match "**/*.env" (deny)', 'access: the system files that every command needs (read)', 'access: your temporary folder (read)',
    'access: "web/docs" (read)', 'access: "web" (write)', 'access: "/tmp" (write)', 'access: an unknown special path ":future", subpath "x" (read)', 'access: "out" (write)', RELATIVE]),
  '[You allowed it once.]', ...block('get network access', ['folder: the project folder', 'reason: "fetch the docs"', 'access: the network']), '[You refused it.]', '[Turn completed.]', STOPPED]);
  // y grants what the block showed, for this turn only.
  assert.deepEqual(replies(run, ['s-1']), [{id: 's-1', result: {permissions: {fileSystem: asked.fileSystem}, scope: 'turn'}}]);
  assert.equal(run.shown.some(line => line.includes('more')), false);
});

test('client: a permission entry or a path list that the client cannot read refuses the request; it never grants it (R1594-3, R1607-4)', async () => {
  const run = await approvalRun([permissions('s-1', {fileSystem: {entries: [{path: {type: 'special', value: {kind: 'root'}}, access: 'all'}]}}),
    permissions('s-2', {fileSystem: {entries: [{path: {type: 'mystery'}, access: 'write'}]}}), permissions('s-3', {fileSystem: {write: '/'}}),
    command('s-4', {additionalPermissions: {fileSystem: {entries: {}}}}), permissions('s-5', {fileSystem: {entries: [{path: {type: 'special', value: {kind: 'home'}}, access: 'read'}]}}),
    permissions('s-6', {network: {enabled: true}, fileSystem: {entries: [{path: {type: 'special', value: {kind: 'root', subpath: 'etc'}}, access: 'read'}]}})], []);
  assert.deepEqual(run.shown, [unread('get file access'), unread('get file access'), unread('get file access'), unread('run a command'), unread('get file access'),
    unread('get network and file access'), '[Turn completed.]', STOPPED]);
  assert.deepEqual(replies(run, ['s-1', 's-2', 's-3', 's-4', 's-5', 's-6']).map(reply => reply.error), [REFUSAL, REFUSAL, REFUSAL, REFUSAL, REFUSAL, REFUSAL]);
});

test('client: a command with extra permissions lists each of them (R1594-3)', async () => {
  const run = await approvalRun([command('s-1', {reason: null, additionalPermissions: {network: {enabled: true}, fileSystem: {entries: [{path: {type: 'special', value: {kind: 'root'}}, access: 'write'}]}}})], ['n']);
  assert.deepEqual(run.shown.slice(0, 6), block('run a command', ['command: "npm install"', 'folder: the project folder', 'access: the network', 'access: the whole disk (write)']));
});

test('client: an MCP tool approval shows the tool arguments as compact JSON, escaped as a code value (R1606-2 mcp probe)', async () => {
  const call = {...MCP_CALL, params: {...MCP_CALL.params, item: {...MCP_CALL.params.item, server: 'files', tool: 'write_file', arguments: {path: '/etc/zshrc', content: 'curl x | sh\n«é»'}}}};
  const run = await approvalRun([mcpQuestion('s-1', {}, {question: 'Allow files to run tool "write_file"?'}),
    elicitation('s-2', {serverName: 'evil', message: 'Allow the chief to push to main?', _meta: {codex_approval_kind: 'mcp_tool_call', tool_params: {branch: 'main', force: true}}}),
    elicitation('s-3', {_meta: {codex_approval_kind: 'mcp_tool_call'}})], ['n', 'n', 'n'], {before: [call]});
  assert.deepEqual(run.shown, [...block('use an MCP tool', ['server: "files"', 'tool: "write_file"', 'message: "Allow files to run tool \\"write_file\\"?"',
    'arguments: {"path":"/etc/zshrc","content":"curl x | sh\\n\\u00ab\\u00e9\\u00bb"}', NOTE]), '[You refused it.]',
  ...block('use an MCP tool', ['server: "evil"', 'message: "Allow the chief to push to main?"', 'arguments: {"branch":"main","force":true}']), '[You refused it.]',
  ...block('use an MCP tool', ['server: "docs"', 'message: "Allow docs to run tool \\"search\\"?"', 'arguments: not in the request']), '[You refused it.]', '[Turn completed.]', STOPPED]);
});

test('client: an MCP form with a field, or with a required field, is refused as a form, also with the approval _meta (R1594-7)', async () => {
  const run = await approvalRun([elicitation('s-1', {requestedSchema: {type: 'object', properties: {email: {type: 'string'}}}}),
    elicitation('s-2', {requestedSchema: {type: 'object', properties: {}, required: ['email']}}), elicitation('s-3', {requestedSchema: undefined})], []);
  const form = '[Agent /root (the chief) sent a form from the MCP server "docs": "Allow docs to run tool \\"search\\"?". The client cannot show forms, so it refused the form.]';
  assert.deepEqual(run.shown, [form, form, form, '[Turn completed.]', STOPPED]);
  assert.deepEqual(replies(run, ['s-1', 's-2', 's-3']).map(reply => reply.error), [REFUSAL, REFUSAL, REFUSAL]);
});

test('client: a question with the MCP approval id but no MCP tool call of that id in that thread, or with no Allow option, is refused as a question (R1594-6, R1595-8, R1605-3 D2)', async () => {
  const other = {...MCP_CALL, params: {...MCP_CALL.params, threadId: 'child-thread-9', item: {...MCP_CALL.params.item, id: 'call-2'}}};
  const run = await approvalRun([mcpQuestion('s-1', {itemId: 'call-9'}, {id: 'mcp_tool_call_approval_call-9'}), mcpQuestion('s-2', {itemId: 'call-2'}, {id: 'mcp_tool_call_approval_call-2'}),
    mcpQuestion('s-3', {}, {id: 'mcp_tool_call_approval_other'}), mcpQuestion('s-4', {}, {options: [{label: 'Allow for this session'}, {label: 'Cancel'}]})], [], {before: [MCP_CALL, other]});
  const asked = '[Agent /root (the chief) asked you a question: "Allow docs to run tool \\"search\\"?". The client cannot show questions, so it refused it. The agent goes on without your answer.]';
  assert.deepEqual(run.shown, [asked, asked, asked, asked, '[Turn completed.]', STOPPED]);
});

test('client: a malformed approval request, a form, a question and an unknown request are refused with a line, at once (T431, R1595-8, R1607-4)', async () => {
  const long = 'q'.repeat(2100);
  const run = await approvalRun([
    command('s-1', {command: undefined}),
    elicitation('s-2', {message: 'Your e-mail?', _meta: null}),
    {id: 's-3', method: 'item/tool/requestUserInput', params: {threadId: THREAD, turnId: APPROVAL_TURN, itemId: 'q-1', isBlocking: true, questions: [{id: 'colour', header: 'Colour', question: 'Which "colour"?\n', options: null}]}},
    {id: 's-4', method: 'item/tool/requestUserInput', params: {threadId: THREAD, turnId: APPROVAL_TURN, itemId: 'q-2', isBlocking: true, questions: [{id: 'a', question: long}]}},
    {id: 's-5', method: 'item/tool/call', params: {threadId: THREAD, tool: 'write'}},
  ], []);
  assert.equal(run.code, 0);
  assert.deepEqual(run.shown, [
    unread('run a command'),
    '[Agent /root (the chief) sent a form from the MCP server "docs": "Your e-mail?". The client cannot show forms, so it refused the form.]',
    '[Agent /root (the chief) asked you a question: "Which \\"colour\\"?\\n". The client cannot show questions, so it refused it. The agent goes on without your answer.]',
    `[Agent /root (the chief) asked you a question: "${'q'.repeat(1999)}… (cut at 2000 characters). The client cannot show questions, so it refused it. The agent goes on without your answer.]`,
    '[Agent /root (the chief) sent a request that is not an approval request, so the client refused it.]',
    '[Turn completed.]', STOPPED]);
  // The controller reads an error reply as a refusal.
  assert.deepEqual(replies(run, ['s-1', 's-2', 's-3', 's-4', 's-5']), ['s-1', 's-2', 's-3', 's-4', 's-5'].map(id => ({id, error: REFUSAL})));
});

test('client: y and n in any case answer; any other line says that it did not go to the chief and shows the question again (T431, R1595-2 other_text)', async () => {
  const run = await approvalRun([command('s-1'), command('s-2'), command('s-3')], ['maybe', 'Skip the install and use the cache instead.', '', 'YES', 'No', ' y ']);
  assert.deepEqual(run.shown, [...COMMAND_BLOCK, NOT_SENT, ...COMMAND_BLOCK, NOT_SENT, ...COMMAND_BLOCK, NOT_SENT, ...COMMAND_BLOCK, '[You allowed it once.]',
    ...COMMAND_BLOCK, '[You refused it.]', ...COMMAND_BLOCK, '[You allowed it once.]', '[Turn completed.]', STOPPED]);
  assert.deepEqual(replies(run, ['s-1', 's-2', 's-3']).map(message => [message.id, message.result.decision]), [['s-1', 'accept'], ['s-2', 'decline'], ['s-3', 'accept']]);
  assert.deepEqual(turnTexts(run), ['Do the work.']);
});

test('client: two requests wait in order and show one at a time (T431)', async () => {
  const second = command('s-2', {command: 'rm -rf build', reason: 'clean the build'});
  const run = await approvalRun([command('s-1'), second], ['n', 'y']);
  assert.deepEqual(run.shown, [...COMMAND_BLOCK, '[You refused it.]', ...block('run a command', ['command: "rm -rf build"', 'folder: the project folder', 'reason: "clean the build"']),
    '[You allowed it once.]', '[Turn completed.]', STOPPED]);
  assert.deepEqual(replies(run, ['s-1', 's-2']), [{id: 's-1', result: {decision: 'decline'}}, {id: 's-2', result: {decision: 'accept'}}]);
});

/** A run on a terminal (raw mode): `type(text)` is one terminal read. The client drops terminal input for 300 ms after
 * a question first shows; `settle()` ends that time on the fake clock, and runs what the client does then. */
async function terminalRun(requests) {
  const run = clientRun({tty: true, fakeOptions: approvalTurn(requests)});
  await until(() => run.lines().includes(READY_TTY), 'the Ready lines');
  const turns = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); };
  const type = async text => { run.input.write(text); await turns(); };
  const settle = async () => { run.f.fire(300); await turns(); };
  const shown = () => unwrap(run.lines().slice(run.lines().indexOf(READY_TTY) + 1));
  return {...run, type, settle, shown};
}

test('client: on a terminal, text typed before the question shows is cleared, with a note, and never answers it (R1595-1 typing, R1594-1 probe B)', async () => {
  const run = await terminalRun([]);
  await run.type('Do the work.\r');
  await until(() => run.f.sent.some(message => message.method === 'turn/start'), 'the turn');
  // The request comes while the owner types, before Enter.
  await run.type('Add a dar');
  run.f.emit([command('s-1')]);
  await until(() => run.lines().includes(ASK), 'the question');
  await run.settle();
  await run.type('k theme\r');
  // A y typed before other output and the question again never answers it.
  await run.type('y');
  run.f.emit([{method: 'item/completed', params: {threadId: THREAD, turnId: APPROVAL_TURN, item: {type: 'agentMessage', id: 'm-1', text: 'Note.'}}}]);
  await until(() => run.lines().filter(line => line === CLEARED).length === 2, 'the question again');
  await run.type('\r');
  assert.deepEqual(replies(run, ['s-1']), []);
  await run.type('n\r');
  run.f.emit([turnEnd('completed')]);
  await until(() => run.lines().includes('[Turn completed.]'), 'the turn end');
  await run.type('\x04');
  assert.equal(await run.code, 0);
  assert.deepEqual(replies(run, ['s-1']), [{id: 's-1', result: {decision: 'decline'}}]);
  assert.deepEqual(turnTexts(run), ['Do the work.']);
  assert.deepEqual(run.shown(), ['Do the work.', 'Add a dar', CLEARED, ...COMMAND_BLOCK, 'k theme', NOT_SENT, ...COMMAND_BLOCK,
    'ychief> Note.', '', CLEARED, ...COMMAND_BLOCK, '', NOT_SENT, ...COMMAND_BLOCK, 'n', '[You refused it.]', '[Turn completed.]', STOPPED]);
});

test('client: on a terminal, input in the first 300 ms after a question shows is dropped, with a note if it had text; Ctrl-C still refuses (R1606-4 race)', async () => {
  const run = await terminalRun([command('s-1'), command('s-2', {command: 'make'})]);
  await run.type('Do the work.\r');
  await until(() => run.lines().includes(ASK), 'the question');
  // A y that waited in the terminal input comes in a read just after the question shows.
  await run.type('y\r');
  assert.deepEqual(replies(run, ['s-1']), []);
  await run.settle();
  await run.type('y\r');
  await until(() => replies(run, ['s-1']).length === 1, 'the answer');
  // The second question: no text in its first 300 ms gives no note; a Ctrl-C in them refuses it.
  await run.type('\x03');
  await until(() => replies(run, ['s-2']).length === 1, 'the refusal');
  await until(() => run.lines().some(line => line.startsWith('[You stopped the turn.')), 'the stopped turn');
  await run.settle();
  await run.type('\x04');
  assert.equal(await run.code, 0);
  assert.deepEqual(replies(run, ['s-1', 's-2']).map(reply => reply.result.decision), ['accept', 'decline']);
  assert.deepEqual(run.shown(), ['Do the work.', ...COMMAND_BLOCK, SETTLED, ...COMMAND_BLOCK, 'y', '[You allowed it once.]',
    ...block('run a command', ['command: "make"', 'folder: the project folder', 'reason: "needs network"']), '[You pressed Ctrl-C, so the client refused the approval request.]',
    '[Stopping the turn... Press Ctrl-C again to stop the controller.]', `[You stopped the turn. ${NEXT}]`, STOPPED]);
});

test('client: on a terminal, a second y in the same read never answers the next question (R1594-1 probe B2, R1596 double)', async () => {
  const run = await terminalRun([command('s-1'), command('s-2', {command: 'make'})]);
  await run.type('Do the work.\r');
  await until(() => run.lines().includes(ASK), 'the question');
  await run.settle();
  await run.type('y\ry\r');
  await until(() => replies(run, ['s-1']).length === 1, 'the first reply');
  assert.deepEqual(replies(run, ['s-2']), []);
  await run.settle();
  await run.type('n\r');
  run.f.emit([turnEnd('completed')]);
  await until(() => run.lines().includes('[Turn completed.]'), 'the turn end');
  // A lone y after the last answer goes nowhere (R1595-4).
  await run.type('y\r');
  await run.type('\x04');
  assert.equal(await run.code, 0);
  assert.deepEqual(replies(run, ['s-1', 's-2']).map(reply => reply.result.decision), ['accept', 'decline']);
  assert.deepEqual(turnTexts(run), ['Do the work.']);
  const second = block('run a command', ['command: "make"', 'folder: the project folder', 'reason: "needs network"']);
  assert.deepEqual(run.shown(), ['Do the work.', ...COMMAND_BLOCK, 'y', '[You allowed it once.]', ...second, SETTLED, ...second,
    'n', '[You refused it.]', '[Turn completed.]', 'y', NO_QUESTION, STOPPED]);
});

test('client: on a terminal, a y inside a paste never answers, with or without an Enter in the paste, and the note says so (R1595-1, R1596 pasteEnter and pasteOut, R1607-5)', async () => {
  const run = await terminalRun([command('s-1')]);
  await run.type('Do the work.\r');
  await until(() => run.lines().includes(ASK), 'the question');
  await run.settle();
  await run.type(`${PASTE_START}y\r${PASTE_END}`);
  await run.type('\r');
  await run.type(`${PASTE_START}y${PASTE_END}\r`);
  assert.deepEqual(replies(run, ['s-1']), []);
  await run.type('n\r');
  run.f.emit([turnEnd('completed')]);
  await until(() => run.lines().includes('[Turn completed.]'), 'the turn end');
  await run.type('\x04');
  assert.equal(await run.code, 0);
  assert.deepEqual(replies(run, ['s-1']), [{id: 's-1', result: {decision: 'decline'}}]);
  assert.deepEqual(run.shown(), ['Do the work.', ...COMMAND_BLOCK, 'y', '', PASTED, ...COMMAND_BLOCK, 'y', PASTED, ...COMMAND_BLOCK, 'n', '[You refused it.]', '[Turn completed.]', STOPPED]);
});

test('client: on a terminal, after Backspace removes all pasted text, a typed y or n answers again (R1608-1 pasteBack)', async () => {
  const run = await terminalRun([command('s-1'), command('s-2', {command: 'make'})]);
  await run.type('Do the work.\r');
  await until(() => run.lines().includes(ASK), 'the question');
  await run.settle();
  await run.type(`${PASTE_START}zz${PASTE_END}`);
  await run.type('\x7f\x7fy\r');
  await until(() => replies(run, ['s-1']).length === 1, 'the first answer');
  await run.settle();
  // A typed n, then a paste and one Backspace: no character is typed after the paste end mark, so the line does not
  // answer (R1616-5); a typed n then does.
  await run.type(`n${PASTE_START}x${PASTE_END}\x7f\r`);
  await run.type('n\r');
  await until(() => replies(run, ['s-2']).length === 1, 'the second answer');
  run.f.emit([turnEnd('completed')]);
  await until(() => run.lines().includes('[Turn completed.]'), 'the turn end');
  await run.type('\x04');
  assert.equal(await run.code, 0);
  assert.deepEqual(replies(run, ['s-1', 's-2']).map(reply => reply.result.decision), ['accept', 'decline']);
  assert.deepEqual(run.shown(), ['Do the work.', ...COMMAND_BLOCK, 'zz\b \b\b \by', '[You allowed it once.]', ...block('run a command', ['command: "make"', 'folder: the project folder', 'reason: "needs network"']),
    'nx\b \b', PASTED, ...block('run a command', ['command: "make"', 'folder: the project folder', 'reason: "needs network"']), 'n', '[You refused it.]', '[Turn completed.]', STOPPED]);
});

// R1616-5 paste_mark: paste text that begins with the paste end mark. The terminal sends the paste between its own
// marks, so the client sees a start mark, the forged end mark, y, Enter and the real end mark.
test('client: on a terminal, paste text that holds the paste end mark never answers, in one read or in several (R1616-5 paste_mark)', async () => {
  const run = await terminalRun([command('s-1')]);
  await run.type('Do the work.\r');
  await until(() => run.lines().includes(ASK), 'the question');
  await run.settle();
  // The probe, in one read. Its last end mark has no start mark, so the next line is pasted too: an empty line here.
  await run.type(`${PASTE_START}${PASTE_END}y\r${PASTE_END}`);
  await run.type('\r');
  // Each rule alone, each line in its own reads. A key in a read with a paste mark is not typed:
  await run.type(`${PASTE_START}${PASTE_END}y`);
  await run.type('\r');
  // a line with a paste mark answers only when a typed character comes after its last mark:
  await run.type('n');
  await run.type(`${PASTE_START}x${PASTE_END}`);
  await run.type('\x7f');
  await run.type('\r');
  // an end mark with no start mark makes its line pasted:
  await run.type(`${PASTE_START}${PASTE_END}${PASTE_END}`);
  await run.type('y');
  await run.type('\r');
  // and an Enter in a read with a paste mark is not typed (the end mark after it makes the next line pasted too).
  await run.type(`${PASTE_START}${PASTE_END}`);
  await run.type('y');
  await run.type(`\r${PASTE_END}`);
  await run.type('n\r');
  assert.deepEqual(replies(run, ['s-1']), []);
  await run.type('n\r');
  run.f.emit([turnEnd('completed')]);
  await until(() => run.lines().includes('[Turn completed.]'), 'the turn end');
  await run.type('\x04');
  assert.equal(await run.code, 0);
  assert.deepEqual(replies(run, ['s-1']), [{id: 's-1', result: {decision: 'decline'}}]);
  assert.deepEqual(run.shown(), ['Do the work.', ...COMMAND_BLOCK, ...['y', '', 'y', 'nx\b \b', 'y', 'y', 'n'].flatMap(line => [line, PASTED, ...COMMAND_BLOCK]),
    'n', '[You refused it.]', '[Turn completed.]', STOPPED]);
});

test('client: on a terminal, the 300 ms timer ends with the session, so no line shows after the last line (R1615-2)', async () => {
  const run = await terminalRun([command('s-1')]);
  await run.type('Do the work.\r');
  await until(() => run.lines().includes(ASK), 'the question');
  // A key in the 300 ms would give the note at their end.
  await run.type('y');
  run.signal('SIGTERM');
  assert.equal(await run.code, 0);
  let fired = true;
  try { run.f.fire(300); } catch { fired = false; }
  assert.equal(fired, false, 'no 300 ms timer is live after the session');
  assert.equal(run.lines().at(-1), STOPPED);
});

test('client: on a terminal, a Ctrl-C in the rest of a read that the question drops still refuses the request and stops the turn (R1605-3 E2)', async () => {
  const run = await terminalRun([command('s-1')]);
  await run.type('Do the work.\r');
  await until(() => run.lines().includes(ASK), 'the question');
  await run.settle();
  // The line shows the question again, which drops the rest of this read; the Ctrl-C in it still acts.
  await run.type('maybe\rmore text\x03');
  await until(() => replies(run, ['s-1']).length === 1, 'the refusal');
  await until(() => run.lines().some(line => line.startsWith('[You stopped the turn.')), 'the stopped turn');
  await run.type('\x04');
  assert.equal(await run.code, 0);
  assert.deepEqual(replies(run, ['s-1']), [{id: 's-1', result: {decision: 'decline'}}]);
  assert.deepEqual(run.shown(), ['Do the work.', ...COMMAND_BLOCK, 'maybe', NOT_SENT, ...COMMAND_BLOCK, '[You pressed Ctrl-C, so the client refused the approval request.]',
    '[Stopping the turn... Press Ctrl-C again to stop the controller.]', `[You stopped the turn. ${NEXT}]`, STOPPED]);
});

test('client: chief text while a question waits shows the question again after it, so the next yes answers the question on screen (R1595-1 chief_after_question)', async () => {
  const run = clientRun({fakeOptions: approvalTurn([{method: 'item/started', params: {threadId: THREAD, turnId: APPROVAL_TURN, item: {type: 'subAgentActivity', id: 'call-spawn', kind: 'started',
    agentThreadId: 'child-thread-1', agentPath: '/root/lead_t1/implementer'}}}, command('s-1', {threadId: 'child-thread-1', turnId: 'child-turn', command: 'rm -rf dist', reason: 'clean the old build'})])});
  run.input.write('Plan the theme.\n');
  await until(() => run.lines().includes(ASK), 'the question');
  run.f.emit([{method: 'item/completed', params: {threadId: THREAD, turnId: APPROVAL_TURN, item: {type: 'agentMessage', id: 'm-1', text: 'I have a plan with three steps.\nShall I start the build now? Answer yes or no.'}}},
    {method: 'warning', params: {message: 'A synthetic warning.'}}]);
  await until(() => run.lines().filter(line => line === ASK).length === 2, 'the question again');
  run.input.write('yes\n');
  await until(() => replies(run, ['s-1']).length === 1, 'the reply');
  run.f.emit([turnEnd('completed')]);
  await until(() => run.lines().includes('[Turn completed.]'), 'the turn end');
  run.input.end();
  assert.equal(await run.code, 0);
  const question = block('run a command', ['command: "rm -rf dist"', 'folder: the project folder', 'reason: "clean the old build"'], '/root/lead_t1/implementer');
  assert.deepEqual(shownOf(run), [...question, 'chief> I have a plan with three steps.', 'chief> Shall I start the build now? Answer yes or no.', '[Warning from the controller: A synthetic warning.]',
    ...question, '[You allowed it once.]', '[Turn completed.]', STOPPED]);
});

test('client: a lone y or n when no question waits never goes to the chief: typed early, after the answer, or after the controller closed the request; a yes or a no goes to the chief (R1595-4, R1596-2, R1596 typeahead, R1607-1 yes_to_chief)', async () => {
  // The first turn asks; each later turn completes at once.
  let turns = 0;
  const run = clientRun({fakeOptions: {onRequest(message, {emit}) {
    if (message.method !== 'turn/start') return;
    const first = ++turns === 1, id = first ? APPROVAL_TURN : `later-turn-${turns}`;
    setImmediate(() => emit([{id: message.id, result: {turn: {id, status: 'inProgress', items: []}}},
      ...(first ? [command('s-1')] : [{method: 'turn/completed', params: {threadId: THREAD, turn: {id, items: [], status: 'completed', error: null}}}])]));
    return false;
  }}});
  run.input.write('Do the work.\ny\n');
  await until(() => run.lines().includes(ASK), 'the question');
  run.f.emit([{method: 'serverRequest/resolved', params: {threadId: THREAD, requestId: 's-1'}}]);
  await until(() => run.lines().some(line => line.startsWith('[The controller closed')), 'the close');
  run.input.write('Y\n n \nyes\n');
  await until(() => run.lines().includes('[The chief is on a turn. Your line runs after it.]'), 'the waiting line');
  run.f.emit([turnEnd('completed')]);
  await until(() => turnTexts(run).length === 2, 'the second turn');
  await until(() => run.lines().filter(line => line === '[Turn completed.]').length === 2, 'the second turn end');
  run.input.write(' NO \n');
  await until(() => turnTexts(run).length === 3, 'the third turn');
  run.input.end();
  await run.code;
  assert.deepEqual(turnTexts(run), ['Do the work.', 'yes', ' NO ']);
  assert.deepEqual(shownOf(run).slice(0, 10), [NO_QUESTION, ...COMMAND_BLOCK, '[The controller closed the approval request of agent /root (the chief) before you answered.]', NO_QUESTION, NO_QUESTION,
    '[The chief is on a turn. Your line runs after it.]']);
  assert.deepEqual(replies(run, ['s-1']), []);
});

test('client: Ctrl-C while a request waits sends decline and stops the turn as before (T431)', async () => {
  const run = clientRun({fakeOptions: approvalTurn([command('s-1')])});
  run.input.write('Do the work.\n');
  await until(() => run.lines().includes(ASK), 'the question');
  run.signal('SIGINT');
  await until(() => run.lines().some(line => line.startsWith('[You stopped the turn.')), 'the stopped turn');
  run.input.end();
  assert.equal(await run.code, 0);
  assert.deepEqual(shownOf(run), [...COMMAND_BLOCK, '[You pressed Ctrl-C, so the client refused the approval request.]',
    '[Stopping the turn... Press Ctrl-C again to stop the controller.]', `[You stopped the turn. ${NEXT}]`, STOPPED]);
  assert.deepEqual(replies(run, ['s-1']), [{id: 's-1', result: {decision: 'decline'}}]);
  assert.deepEqual(run.f.sent.filter(message => message.method === 'turn/interrupt').map(message => message.params), [{threadId: THREAD, turnId: APPROVAL_TURN}]);
});

test('client: a child named by thread/started or by a subAgentActivity item asks under its agent path; the first name stays; an unknown thread is never the chief (T431, R1598-K3, R1605-3 A7, R1607-6)', async () => {
  const run = clientRun();
  await until(() => run.lines().includes(READY[1]), 'the Ready lines');
  run.f.emit([{method: 'thread/started', params: {thread: {id: 'child-thread-1', parentThreadId: THREAD, agentNickname: 'Ada', agentRole: 'implementer',
    source: {subAgent: {thread_spawn: {parent_thread_id: THREAD, depth: 2, agent_path: '/root/lead_t1/implementer', agent_nickname: 'Ada', agent_role: 'implementer'}}}}}},
  // The pinned binary gives no thread/started for a child: the subAgentActivity item on the root thread names it (T441).
  {method: 'item/started', params: {threadId: THREAD, turnId: 'root-turn', item: {type: 'subAgentActivity', id: 'call-spawn', kind: 'started', agentThreadId: 'child-thread-2', agentPath: '/root/probe_child'}}},
  // No item renames the chief, and no later item renames a named child.
  {method: 'item/started', params: {threadId: THREAD, turnId: 'root-turn', item: {type: 'subAgentActivity', id: 'call-x', kind: 'started', agentThreadId: THREAD, agentPath: '/root/fake'}}},
  {method: 'item/started', params: {threadId: THREAD, turnId: 'root-turn', item: {type: 'subAgentActivity', id: 'call-y', kind: 'started', agentThreadId: 'child-thread-1', agentPath: '/root (the chief)'}}},
  command('s-1', {threadId: 'child-thread-1', turnId: 'child-turn', reason: null}), command('s-2', {threadId: 'child-thread-2', turnId: 'child-turn', reason: null}),
  command('s-3', {threadId: 'child-thread-3', turnId: 'child-turn', reason: null}), command('s-4', {threadId: THREAD, reason: null}), command('s-5', {threadId: undefined, reason: null})]);
  for (const id of ['s-1', 's-2', 's-3', 's-4', 's-5']) {
    await until(() => run.lines().filter(line => line === ASK).length === Number(id.at(-1)), `the question ${id}`);
    run.input.write('y\n');
  }
  await until(() => replies(run, ['s-5']).length === 1, 'the last reply');
  run.input.end();
  assert.equal(await run.code, 0);
  assert.deepEqual(shownOf(run).filter(line => line.startsWith('[Approval: ')), ['/root/lead_t1/implementer', '/root/probe_child', '(unknown child child-thread-3)', '/root (the chief)',
    '(an unknown agent with no thread id)'].map(agent => `[Approval: agent ${agent} asks to run a command.]`));
  assert.deepEqual(replies(run, ['s-1', 's-2', 's-3', 's-4', 's-5']).map(reply => reply.result.decision), ['accept', 'accept', 'accept', 'accept', 'accept']);
  assert.equal(run.f.sent.some(message => message.method === 'turn/start'), false);
});

test('client: the end of input refuses a request that waits; a request that the controller closes shows the next one (T431)', async () => {
  const run = clientRun({fakeOptions: approvalTurn([command('s-1'), command('s-2', {command: 'make'})])});
  run.input.write('Do the work.\n');
  await until(() => run.lines().includes(ASK), 'the first question');
  run.f.emit([{method: 'serverRequest/resolved', params: {threadId: THREAD, requestId: 's-1'}}]);
  const second = block('run a command', ['command: "make"', 'folder: the project folder', 'reason: "needs network"']);
  await until(() => run.lines().includes('  command: "make"'), 'the second question');
  run.input.end();
  await until(() => replies(run, ['s-2']).length === 1, 'the refusal at the end of input');
  run.f.emit([turnEnd('completed')]);
  assert.equal(await run.code, 0);
  assert.deepEqual(shownOf(run), [...COMMAND_BLOCK,
    '[The controller closed the approval request of agent /root (the chief) before you answered.]', ...second,
    '[Your input ended, so the client refused the approval request.]',
    '[Your input ended. The controller stops after the lines that you typed. Press Ctrl-C to stop the turn now.]',
    '[Turn completed.]', STOPPED]);
  assert.deepEqual(replies(run, ['s-1', 's-2']), [{id: 's-2', result: {decision: 'decline'}}]);
});

test('client: a request after the end of input shows no question, only the refusal line (R1593-4)', async () => {
  const run = clientRun({fakeOptions: approvalTurn([])});
  run.input.write('Do the work.\n');
  await until(() => run.f.sent.some(message => message.method === 'turn/start'), 'the turn');
  run.input.end();
  await until(() => run.lines().some(line => line.startsWith('[Your input ended.')), 'the end');
  run.f.emit([command('s-9')]);
  await until(() => replies(run, ['s-9']).length === 1, 'the reply');
  run.f.emit([turnEnd('completed')]);
  assert.equal(await run.code, 0);
  assert.deepEqual(shownOf(run), ['[Your input ended. The controller stops after the lines that you typed. Press Ctrl-C to stop the turn now.]',
    '[Your input ended, so the client refused the approval request of agent /root (the chief).]', '[Turn completed.]', STOPPED]);
  assert.deepEqual(replies(run, ['s-9']), [{id: 's-9', result: {decision: 'decline'}}]);
});

test('client: SIGTERM refuses each request that waits, and a crash drops them, so a later y sends nothing (R1593-5, R1593-6)', async () => {
  const stopped = clientRun({fakeOptions: approvalTurn([command('s-1'), command('s-2')])});
  stopped.input.write('Do the work.\n');
  await until(() => stopped.lines().includes(ASK), 'the question');
  stopped.signal('SIGTERM');
  stopped.input.end();
  assert.equal(await stopped.code, 0);
  assert.deepEqual(shownOf(stopped).slice(COMMAND_BLOCK.length, COMMAND_BLOCK.length + 2), ['[The controller stops, so the client refused the 2 approval requests.]', '[Stopping the controller...]']);
  assert.deepEqual(replies(stopped, ['s-1', 's-2']), [{id: 's-1', result: {decision: 'decline'}}, {id: 's-2', result: {decision: 'decline'}}]);
  const crashed = clientRun({fakeOptions: approvalTurn([command('s-1')])});
  crashed.input.write('Do the work.\n');
  await until(() => crashed.lines().includes(ASK), 'the question');
  crashed.f.close(1);
  await until(() => crashed.lines().some(line => line.startsWith('[The result of the turn is unknown')), 'the crash');
  crashed.input.write('y\n');
  crashed.input.end();
  assert.equal(await crashed.code, 1);
  assert.deepEqual(replies(crashed, ['s-1']), []);
  assert.equal(crashed.lines().includes('[You allowed it once.]'), false);
  // After the fence no reply can go out, so the question never shows again.
  assert.equal(crashed.lines().filter(line => line === ASK).length, 1);
});

// Part 2: one gated test against the real fork binary. It runs only when SAGE_CODEX_CONTROLLER_BIN is set.
const REAL =process.env.SAGE_CODEX_CONTROLLER_BIN ? false : 'SAGE_CODEX_CONTROLLER_BIN is not set; the real controller test is skipped';

function sse(events) {
  return events.map(event => `event: ${event.type}\n` + (Object.keys(event).length === 1 ? '\n' : `data: ${JSON.stringify(event)}\n\n`)).join('');
}
const created = {type: 'response.created', response: {id: 'resp-1'}};
const message = {type: 'response.output_item.done', item: {type: 'message', role: 'assistant', id: 'msg-1', content: [{type: 'output_text', text: SYNTHETIC_REPLY}]}};
const completed = {type: 'response.completed', response: {id: 'resp-1', usage: {input_tokens: 0, input_tokens_details: null, output_tokens: 0, output_tokens_details: null, total_tokens: 0}}};

// `projectConfig` is the text of the project's .codex/config.toml; the user config then trusts the project, so the
// controller loads that layer. `files` maps a path under the fixture root to its text. CODEX_HOME is the .codex folder
// above the project, as ~/.codex is above ~/workspace/<project>, and it holds a rules file of the owner.
// `approval` is the owner's approval policy; `reply(index, marker)` gives the SSE body of each model request.
async function realFixture({hold = false, projectConfig, files = {}, approval = 'never', reply} = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sage-owned-')));
  const home = join(root, '.codex'), project = join(root, 'work', 'project'), bin = join(root, 'bin'), userHome = join(root, 'home');
  for (const dir of [join(home, 'rules'), project, bin, userHome]) mkdirSync(dir, {recursive: true});
  writeFileSync(join(home, 'rules', 'owner.rules'), 'prefix_rule(pattern = ["sage-fixture-never-run"], decision = "forbidden")\n');
  // A command in a project file touches this marker if it runs.
  const marker = join(root, 'marker'), marked = text => text.replaceAll('{{marker}}', marker);
  for (const [path, text] of Object.entries(files)) { mkdirSync(join(root, path, '..'), {recursive: true}); writeFileSync(join(root, path), marked(text)); }
  // The controller may look for process tools: only refusing fakes are on PATH.
  for (const name of ['ps', 'pgrep', 'kill', 'launchctl']) { writeFileSync(join(bin, name), '#!/bin/sh\nexit 1\n'); chmodSync(join(bin, name), 0o755); }
  const requests = [], held = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      requests.push({method: request.method, url: request.url, body});
      if (request.method !== 'POST' || request.url !== '/v1/responses') { response.writeHead(404, {'content-type': 'application/json'}).end('{}'); return; }
      response.writeHead(200, {'content-type': 'text/event-stream'});
      if (hold) { response.write(sse([created])); held.push(response); return; }
      response.end(reply ? reply(requests.filter(seen => seen.url === '/v1/responses').length - 1, marker, project) : sse([created, message, completed]));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const {port} = server.address();
  assert.ok(port !== 4173 && port !== 43123, 'the loopback provider never uses a reserved port');
  const url = `http://127.0.0.1:${port}`;
  writeFileSync(join(home, 'config.toml'), `model = "synthetic"
model_provider = "synthetic"
approval_policy = "${approval}"
sandbox_mode = "read-only"
chatgpt_base_url = "${url}/backend-api/"
[model_providers.synthetic]
name = "Synthetic local fixture"
base_url = "${url}/v1"
wire_api = "responses"
requires_openai_auth = false
request_max_retries = 0
stream_max_retries = 0
supports_websockets = false
[analytics]
enabled = false
[feedback]
enabled = false
${projectConfig === undefined ? '' : `[projects."${project}"]\ntrust_level = "trusted"\n`}`);
  if (projectConfig !== undefined) { mkdirSync(join(project, '.codex'), {recursive: true}); writeFileSync(join(project, '.codex', 'config.toml'), marked(projectConfig)); }
  writeFileSync(join(home, 'auth.json'), JSON.stringify({auth_mode: 'apikey', OPENAI_API_KEY: 'synthetic-api-key'}));
  const binary = resolveControllerBinary(process.env);
  const events = [];
  const env = {PATH: `${bin}:/usr/bin:/bin`, HOME: userHome, TMPDIR: root, CODEX_HOME: home, CODEX_AUTHAPI_BASE_URL: url,
    CODEX_APP_SERVER_DISABLE_MANAGED_CONFIG: '1', CODEX_APP_SERVER_MANAGED_CONFIG_PATH: join(home, 'managed_config.toml'),
    NO_PROXY: '*', no_proxy: '*', RUST_LOG: 'warn', DO_NOT_TRACK: '1'};
  // The test keeps the handle of the real controller process, to see its exit by that handle, and the method of each
  // request that the wrapper sends to it.
  const children = [], sent = [];
  const owner = createControllerProcess({
    executable: binary.path, executableSha256: binary.sha256, cwd: project, env,
    startupTimeoutMs: 60000, inspectionTimeoutMs: 30000, stopGraceMs: 5000, turnTimeoutMs: 60000, interruptGraceMs: 10000,
    onEvent: event => events.push(event),
  }, {spawn: (...launch) => {
    const child = spawn(...launch);
    children.push(child);
    const write = child.stdin.write.bind(child.stdin);
    child.stdin.write = (chunk, ...rest) => { const {method} = JSON.parse(chunk); if (method) sent.push(method); return write(chunk, ...rest); };
    return child;
  }});
  async function close() {
    for (const response of held) response.end();
    await new Promise(resolve => server.close(resolve));
    server.closeAllConnections?.();
    rmSync(root, {recursive: true, force: true});
  }
  return {root, home, project, marker, binary, env, owner, requests, events, held, children, sent, close};
}
function filesUnder(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, {withFileTypes: true}).flatMap(entry => entry.isDirectory() ? filesUnder(join(dir, entry.name)) : [join(dir, entry.name)]);
}
function saveEvidence(name, value) {
  const dir = process.env.SAGE_CODEX_CONTROLLER_EVIDENCE;
  if (dir) writeFileSync(join(dir, `${name}.json`), JSON.stringify(value, null, 2) + '\n');
}

test('real owned controller: policy binding, one completed turn, ephemeral root, clean stop', {skip: REAL, timeout: 180000}, async () => {
  const f = await realFixture();
  try {
    await f.owner.start();
    const inspection = await f.owner.inspect();
    const bound = await f.owner.openThread({project: f.project, task: 'T400', run: 'R1461', instructions: 'Synthetic owned controller test. Reply in one sentence.'});
    saveEvidence('real-completed-binding', {binary: f.binary, inspection, bound});
    assert.equal(bound.state, 'bound', JSON.stringify(bound));
    assert.equal(bound.policy.cliVersion, '0.160.0');
    assert.equal(bound.policy.binary.sha256, f.binary.sha256);
    // The real origins format: a dotted path, and a structured feature records its switch at `.enabled`.
    for (const key of ['agents.enabled', 'features.multi_agent', 'features.multi_agent_v2.enabled', 'features.goals', 'web_search', 'features.plugins', 'features.apps', 'features.remote_plugin'])
      assert.equal(inspection.origins[key]?.name?.type, 'sessionFlags', key);
    // The owner's own approval and sandbox setting is the one the root thread carries.
    assert.deepEqual(bound.policy.selection.approvalPolicy, {value: 'never', origin: 'user'});
    assert.equal(bound.policy.selection.sandbox.value.type, 'readOnly');
    assert.equal(bound.policy.selection.sandbox.origin, 'user');
    const result = await f.owner.runTurn('Say one synthetic sentence.');
    const posts = f.requests.filter(request => request.method === 'POST' && request.url === '/v1/responses');
    const tools = posts.map(post => (JSON.parse(post.body).tools ?? []).map(tool => tool.name ?? tool.type));
    // Every tool name in the request, also the ones inside a namespace such as collaboration.
    const names = JSON.stringify(posts.map(post => JSON.parse(post.body).tools ?? [])).match(/"name":"[^"]*"/g) ?? [];
    saveEvidence('real-completed-turn', {result, tools, names, requests: f.requests.map(({method, url}) => ({method, url})), events: f.owner.events()});
    // The launch profile turns off multi-agent v1 and goals (T391-NOTE-1): none of their tools reaches the model.
    for (const tool of ['send_input', 'resume_agent', 'create_goal', 'get_goal', 'update_goal']) assert.equal(names.includes(`"name":"${tool}"`), false, tool);
    assert.ok(names.includes('"name":"exec_command"'), names.join(' '));
    assert.equal(result.state, 'completed', JSON.stringify(result));
    assert.equal(result.lastAgentMessage, SYNTHETIC_REPLY);
    assert.equal(result.bindingHash, bound.policy.bindingHash);
    assert.equal(posts.length, 1);
    assert.deepEqual(f.owner.events().map(event => event.method).filter(method => method === 'turn/completed'), ['turn/completed']);
    assert.deepEqual(filesUnder(join(f.home, 'sessions')).filter(file => file.includes('rollout-')), []);
    const stopped = await f.owner.stop();
    assert.equal(stopped.state, 'stopped'); assert.equal(stopped.exitCode, 0);
  } finally { await f.owner.stop(); await f.close(); }
});

test('real owned controller: interrupt of an active root turn gives interrupted', {skip: REAL, timeout: 180000}, async () => {
  const f = await realFixture({hold: true});
  try {
    await f.owner.start();
    const bound = await f.owner.openThread({project: f.project, task: 'T400', run: 'R1461', instructions: 'Synthetic owned controller test. Reply in one sentence.'});
    assert.equal(bound.state, 'bound', JSON.stringify(bound));
    const turn = f.owner.runTurn('Say one synthetic sentence.');
    const started = await new Promise((resolve, reject) => {
      const poll = setInterval(() => {
        if (f.held.length && f.events.some(event => event.method === 'turn/started')) { clearInterval(poll); resolve(true); }
      }, 20);
      turn.then(value => { clearInterval(poll); reject(new Error(`The turn ended before it started: ${JSON.stringify(value)}`)); });
    });
    assert.equal(started, true);
    const interrupted = await f.owner.interrupt();
    saveEvidence('real-interrupt', {result: interrupted, events: f.owner.events()});
    assert.equal(interrupted.state, 'interrupted', JSON.stringify(interrupted));
    assert.equal(interrupted.timedOut, false);
    assert.equal(await turn, interrupted);
    const stopped = await f.owner.stop();
    assert.equal(stopped.state, 'stopped'); assert.equal(stopped.exitCode, 0);
  } finally { await f.owner.stop(); await f.close(); }
});

test('real owned controller: a project config that widens the sandbox or moves approvals is refused before any turn (R1524-1, R1524-2)', {skip: REAL, timeout: 180000}, async () => {
  const found = {};
  for (const [name, text] of [['widen', '[sandbox_workspace_write]\nnetwork_access = true\n'], ['reviewer', 'approvals_reviewer = "auto_review"\n']]) {
    const f = await realFixture({projectConfig: text});
    try {
      await f.owner.start();
      const opened = await f.owner.openThread({project: f.project, task: 'T400', run: 'R1461', instructions: 'Synthetic owned controller test.'});
      // The message names the project folder, which differs in each run.
      found[name] = [opened.state, opened.code, opened.error.message.replaceAll(f.project, '<project>').replaceAll(f.root, '<root>'), opened.status.state,
        f.requests.filter(request => request.url === '/v1/responses').length];
    } finally { await f.owner.stop(); await f.close(); }
  }
  saveEvidence('real-project-layer', found);
  const refused = key => ['refused', 'selection-origin', `The setting ${key} comes from the project config in <project>/.codex. An agent can change project files, so the client takes only the model and text settings (such as model_reasoning_effort) from the project, and every other setting only from your Codex config, a managed config or the launch flags. Check the setting ${key}. If you trust it, move it to your Codex config (<root>/.codex/config.toml). If not, remove it. Then start the client again.`, 'stopped', 0];
  assert.deepEqual(found, {widen: refused('sandbox_workspace_write.network_access'), reviewer: refused('approvals_reviewer')});
});

// Each project way to start a program or to change approvals refuses before thread/start: thread/start starts the MCP
// servers, and the rules and hooks files have no config key (R1543-1, R1543-2, R1544-1, R1544-2, R1546-1).
test('real owned controller: a project MCP server, hook, approval feature, rules file, parent rules file, hooks file, shell environment, login shell or agent role file refuses before thread/start', {skip: REAL, timeout: 300000}, async () => {
  const allow = 'prefix_rule(pattern = ["sh"], decision = "allow")\n';
  const variants = {
    mcp: {projectConfig: '[mcp_servers.probe]\ncommand = "/usr/bin/touch"\nargs = ["{{marker}}"]\n'},
    hook: {projectConfig: '[[hooks.SessionStart]]\n[[hooks.SessionStart.hooks]]\ntype = "command"\ncommand = "/usr/bin/touch {{marker}}"\n'},
    feature: {projectConfig: '[features]\nrequest_permissions_tool = true\n'},
    rules: {projectConfig: '', files: {'work/project/.codex/rules/default.rules': allow}},
    parentRules: {files: {'work/.codex/rules/parent.rules': allow}},
    hooksFile: {projectConfig: '', files: {'work/project/.codex/hooks.json': JSON.stringify({hooks: {SessionStart: [{hooks: [{type: 'command', command: '/usr/bin/touch {{marker}}'}]}]}})}},
    // The R1563 probe: zsh read the .zshenv of a project ZDOTDIR outside the sandbox (R1563-1).
    zdotdir: {projectConfig: '[shell_environment_policy.set]\nZDOTDIR = "{{marker}}-zdot"\n', files: {'marker-zdot/.zshenv': '/usr/bin/touch {{marker}}\n'}},
    loginShell: {projectConfig: 'allow_login_shell = true\n'},
    // An empty list replaces the owner's list, and config/read gives it no origin; the project layer shows it (R1575-1).
    emptyLists: {projectConfig: '[shell_environment_policy]\ninclude_only = []\nexclude = []\n'},
    roleFile: {projectConfig: '', files: {'work/project/.codex/agents/reviewer.toml': 'name = "reviewer"\ndescription = "A synthetic role"\ndeveloper_instructions = "Synthetic."\n'}},
  };
  const found = {};
  for (const [name, options] of Object.entries(variants)) {
    const f = await realFixture(options);
    try {
      await f.owner.start();
      const opened = await f.owner.openThread({project: f.project, task: 'T400', run: 'R1461', instructions: 'Synthetic owned controller test.'});
      found[name] = {state: opened.state, code: opened.code ?? null, message: opened.error?.message.replaceAll(f.root, '<root>') ?? null, status: opened.status?.state ?? null,
        sent: [...f.sent], marker: existsSync(f.marker), posts: f.requests.filter(request => request.url === '/v1/responses').length};
    } finally { await f.owner.stop(); await f.close(); }
  }
  saveEvidence('real-project-programs', found);
  const config = ['initialize', 'initialized', 'config/read'], files = ['initialize', 'initialized'];
  const origin = name => `The setting ${name} comes from the project config in <root>/work/project/.codex. An agent can change project files, so the client takes only the model and text settings (such as model_reasoning_effort) from the project, and every other setting only from your Codex config, a managed config or the launch flags. Check the setting ${name}. If you trust it, move it to your Codex config (<root>/.codex/config.toml). If not, remove it. Then start the client again.`;
  const why = 'An agent can change project files, so the client refuses the rules, hooks and agent role files of the project and of each folder above it.';
  const rules = (path, where) => `The rules file <root>/${path} is ${where}. A rule can let a command run with no approval or outside the sandbox. ${why} Check the rules. If you trust them, move them to your Codex config (<root>/.codex/rules/). If not, remove them. Then start the client again.`;
  const refused = (code, message, sent) => ({state: 'refused', code, message, status: 'stopped', sent, marker: false, posts: 0});
  assert.deepEqual(found, {
    mcp: refused('selection-origin', origin('mcp_servers.probe'), config),
    hook: refused('selection-origin', origin('hooks.SessionStart'), config),
    feature: refused('selection-origin', origin('features.request_permissions_tool'), config),
    rules: refused('project-rules', rules('work/project/.codex/rules/default.rules', 'in the project'), files),
    parentRules: refused('project-rules', rules('work/.codex/rules/parent.rules', 'in a folder above the project'), files),
    hooksFile: refused('project-hooks', `The hooks file <root>/work/project/.codex/hooks.json is in the project. A hook runs a command at its event. ${why} Check the hooks. If you trust them, move them to your Codex config (<root>/.codex/hooks.json). If not, remove them. Then start the client again.`, files),
    zdotdir: refused('selection-origin', origin('shell_environment_policy.set.ZDOTDIR'), config),
    loginShell: refused('selection-origin', origin('allow_login_shell'), config),
    emptyLists: refused('selection-origin', origin('shell_environment_policy.include_only'), config),
    roleFile: refused('project-agents', `The agent role file <root>/work/project/.codex/agents/reviewer.toml is in the project. A role sets the config of each agent that the chief starts with it: its instructions, model, sandbox and MCP servers. ${why} Check the role. If you trust it, move it to your Codex config (<root>/.codex/agents/). If not, remove it. Then start the client again.`, files),
  });
});

// A setting of the model's text from the project binds, as the real config/read reports it (R1563-1).
test('real owned controller: a project config with only allowed keys binds', {skip: REAL, timeout: 180000}, async () => {
  const f = await realFixture({projectConfig: 'model_reasoning_effort = "low"\nmodel_verbosity = "low"\ndeveloper_instructions = "Synthetic project text."\n'});
  try {
    await f.owner.start();
    const opened = await f.owner.openThread({project: f.project, task: 'T400', run: 'R1461', instructions: 'Synthetic owned controller test.'});
    saveEvidence('real-project-allowed', {state: opened.state, code: opened.code ?? null, message: opened.error?.message ?? null, sent: [...f.sent]});
    assert.equal(opened.state, 'bound', opened.error?.message);
    assert.deepEqual(f.sent, ['initialize', 'initialized', 'config/read', 'thread/start']);
  } finally { await f.owner.stop(); await f.close(); }
});

// A killed client closes the pipe to the controller's stdin, and nothing else ends the controller then, because it
// runs in its own process group. So this case closes that stdin during a held turn and sees the exit by the handle.
test('real owned controller: a closed stdin during a held turn ends the controller by itself (R1523-3)', {skip: REAL, timeout: 180000}, async () => {
  const f = await realFixture({hold: true});
  try {
    await f.owner.start();
    assert.equal((await f.owner.openThread({project: f.project, task: 'T400', run: 'R1461', instructions: 'Synthetic owned controller test.'})).state, 'bound');
    const turn = f.owner.runTurn('Say one synthetic sentence.');
    for (let i = 0; i < 1500 && !(f.held.length && f.events.some(event => event.method === 'turn/started')); i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(f.held.length, 'the provider holds the turn');
    const [child] = f.children;
    child.stdin.end();
    // A bounded count of short waits for the exit event of this handle; the finally block stops it if it stays.
    for (let i = 0; i < 1500 && child.exitCode === null && child.signalCode === null; i++) await new Promise(resolve => setTimeout(resolve, 20));
    const exit = {code: child.exitCode, signal: child.signalCode};
    const result = await turn;
    saveEvidence('real-stdin-closed', {exit, result, pid: child.pid, status: f.owner.status()});
    assert.deepEqual(exit, {code: 0, signal: null});
    assert.deepEqual(f.owner.status().signals, [], 'the controller ended with no signal from the wrapper');
    assert.equal(result.state, 'uncertain');
  } finally { await f.owner.stop(); await f.close(); }
});

test('real owned controller: the terminal client runs two typed lines as two turns', {skip: REAL, timeout: 180000}, async () => {
  const f = await realFixture();
  try {
    writeFileSync(join(f.root, 'chief.md'), 'Synthetic owned controller test. Reply in one sentence.');
    let text = '';
    const input = new PassThrough();
    input.end('sage mode\nSay one synthetic sentence.\n');
    const code = await runClient({argv: ['--project', f.project, '--task', 'T400', '--run', 'R1461', '--instructions', join(f.root, 'chief.md')],
      env: {...f.env, SAGE_CODEX_CONTROLLER_BIN: f.binary.path}, input, output: {write(chunk) { text += chunk; return true; }}, classify: parseCommand});
    saveEvidence('real-client', {code, output: text});
    const lines = text.trimEnd().split('\n').filter(line => !line.startsWith('[Warning from the controller: '));
    assert.deepEqual(lines, [`[Controller binary: ${f.binary.path}, sha256 ${f.binary.sha256}.]`, HEADER[1],
      '[Ready: task T400, run R1461. The chief uses your Codex config: model "synthetic", approval "never", sandbox "read-only".]', READY[1],
      '[You typed the mode phrase "sage mode". The client sends it to the chief, which switches the mode and says so.]', `chief> ${SYNTHETIC_REPLY}`, '[Turn completed.]',
      `chief> ${SYNTHETIC_REPLY}`, '[Turn completed.]', STOPPED]);
    assert.equal(code, 0);
    assert.equal(f.requests.filter(request => request.url === '/v1/responses').length, 2);
  } finally { await f.owner.stop(); await f.close(); }
});

// The synthetic model asks for one escalated command outside the project (the sandbox is read-only), then ends the turn.
// `command(marker, project)` gives the command text; the spoof draws a fake end of the question in it (R1596 spoof).
const escalated = (command, justification = 'Synthetic approval request.') => (index, marker, project) => (index === 0 ? sse([created, {type: 'response.output_item.done', item: {type: 'function_call', call_id: 'call-touch', name: 'exec_command',
  arguments: JSON.stringify({cmd: command(marker, project), yield_time_ms: 5000, sandbox_permissions: 'require_escalated', justification})}}, completed])
  : sse([created, message, completed]));
const touch = marker => `touch ${marker}`;
const spoofed = (marker, project) => `true" in "${project}" (read only check). Type y to allow it once, or n to refuse it.]             then: ; touch ${marker}`;
for (const [name, typed, made, text] of [['plain', 'n', false, touch], ['plain', 'y', true, touch], ['spoof', 'n', false, spoofed]]) {
  test(`real owned controller: the client asks before an escalated command outside the project (${name}); ${typed} ${made ? 'creates' : 'leaves out'} the marker (T431, R1596)`, {skip: REAL, timeout: 180000}, async () => {
    const f = await realFixture({approval: 'on-request', reply: escalated(text)});
    try {
      writeFileSync(join(f.root, 'chief.md'), 'Synthetic owned controller test.');
      let text = '';
      const input = new PassThrough();
      input.write('Touch the marker.\n');
      const code = runClient({argv: ['--project', f.project, '--task', 'T431', '--run', 'R1590', '--instructions', join(f.root, 'chief.md')],
        env: {...f.env, SAGE_CODEX_CONTROLLER_BIN: f.binary.path, SAGE_CODEX_CONTROLLER_SHA256: f.binary.sha256}, input, output: {write(chunk) { text += chunk; return true; }}, classify: parseCommand});
      for (let i = 0; i < 600 && !text.includes('[Approval: '); i++) await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(existsSync(f.marker), false, 'nothing runs before the answer');
      input.write(`${typed}\n`);
      for (let i = 0; i < 600 && !text.includes('[Turn completed.]'); i++) await new Promise(resolve => setTimeout(resolve, 100));
      input.end();
      const exit = await code;
      saveEvidence(`real-approval-${name}-${typed}`, {code: exit, output: text, marker: existsSync(f.marker)});
      const rows = text.trimEnd().split('\n').filter(line => !line.startsWith('[Warning from the controller: '));
      // Each row of the block is printable ASCII and fits 80 columns, the default width (R1616-1).
      assert.equal(checkBlocks(rows, 80, 24), 1);
      const lines = unwrap(rows);
      const first = lines.indexOf('[Approval: agent /root (the chief) asks to run a command.]');
      const [, shown, ...rest] = lines.slice(first, first + 5);
      // The controller runs the command through the shell: the command field is that text as JSON, with each run of 3
      // or more spaces as its count outside the quotes; the spoof's run of 13 spaces reads back exactly (R1606-1, R1617-3).
      const command = JSON.parse(shown.replace(/^  command: /, '').replace(/" \((\d+) spaces\) "/g, (_, count) => ' '.repeat(Number(count))));
      assert.match(command, /^\/bin\/zsh -lc '.*'$/s);
      assert.ok(command.includes(name === 'spoof' ? spoofed(f.marker, f.project) : touch(f.marker)), command);
      if (name === 'spoof') assert.ok(shown.includes('refuse it.]" (13 spaces) "then:'), shown);
      assert.deepEqual(rest, ['  folder: the project folder', '  reason: "Synthetic approval request."', ASK]);
      // Only the last line of the block says how to answer: the spoof stays inside its field line.
      assert.equal(lines.filter(line => line.includes('Type y to allow it once')).length, name === 'spoof' ? 2 : 1);
      assert.equal(lines.filter(line => line === ASK).length, 1);
      assert.deepEqual(lines.slice(first + 5), [made ? '[You allowed it once.]' : '[You refused it.]', `chief> ${SYNTHETIC_REPLY}`, '[Turn completed.]', STOPPED]);
      assert.equal(exit, 0);
      assert.equal(existsSync(f.marker), made);
      // The model gets the result of the command: the second request carries the output of the call.
      const bodies = f.requests.filter(request => request.url === '/v1/responses').map(request => JSON.parse(request.body));
      assert.equal(bodies.length, 2);
      assert.ok(bodies[1].input.some(item => item.type === 'function_call_output' && item.call_id === 'call-touch'), JSON.stringify(bodies[1].input));
    } finally { await f.owner.stop(); await f.close(); }
  });
}

// R1616 on the real binary: a padded reason that draws a fake block under the real one, with spaces or with
// look-alike quotes (U+A78C). At 80 by 24 the block shows as rows of printable ASCII with its first line on the screen,
// or the client refuses it at once; n leaves the marker out (R1616-1).
const PADDED = quote => FAKE(quote).map(line => line.padEnd(80, ' ')).join('');
for (const [name, why] of [['spaces', `list the files"${' '.repeat(1425)}${PADDED('"')}`], ['look-alike quotes', `list the files${PADDED('\ua78c\ua78c')}`]]) {
  test(`real owned controller: a padded reason that draws a fake block (${name}) shows only rows of printable ASCII at 80 by 24; n leaves out the marker (T431, R1616-1)`, {skip: REAL, timeout: 180000}, async () => {
    const f = await realFixture({approval: 'on-request', reply: escalated(touch, why)});
    try {
      writeFileSync(join(f.root, 'chief.md'), 'Synthetic owned controller test.');
      let text = '';
      const input = new PassThrough();
      input.write('Touch the marker.\n');
      const code = runClient({argv: ['--project', f.project, '--task', 'T431', '--run', 'R1623', '--instructions', join(f.root, 'chief.md')],
        env: {...f.env, SAGE_CODEX_CONTROLLER_BIN: f.binary.path, SAGE_CODEX_CONTROLLER_SHA256: f.binary.sha256}, input,
        output: {columns: 80, rows: 24, write(chunk) { text += chunk; return true; }}, classify: parseCommand});
      for (let i = 0; i < 600 && !/\[Approval: |so the client refused it/.test(text); i++) await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(existsSync(f.marker), false, 'nothing runs before the answer');
      input.write('n\n');
      for (let i = 0; i < 600 && !text.includes('[Turn completed.]'); i++) await new Promise(resolve => setTimeout(resolve, 100));
      input.end();
      const exit = await code;
      saveEvidence(`real-approval-padded-${name.replace(/ /g, '-')}`, {code: exit, output: text, marker: existsSync(f.marker)});
      const rows = text.trimEnd().split('\n').filter(line => !line.startsWith('[Warning from the controller: '));
      const refused = rows.filter(row => row.includes('so the client refused it. Make the terminal window larger')).length;
      assert.equal(checkBlocks(rows, 80, 24) + refused, 1);
      assert.equal(exit, 0);
      assert.equal(existsSync(f.marker), false);
    } finally { await f.owner.stop(); await f.close(); }
  });
}

// Part 3: real signals. The built client runs as its own process, on a fake controller script that replays the
// fixture. Node's default for SIGINT ends that script, as the fork's stdio mode does. The test signals only the
// process group of the client that it spawned, and stops only that client, by its own handle.
const FAKE_CONTROLLER = `#!${process.execPath}
'use strict';
const {readFileSync, writeFileSync} = require('node:fs');
const {createInterface} = require('node:readline');
const marks = process.env.FAKE_MARKS;
const mark = name => writeFileSync(marks + '/' + name, '');
process.on('exit', code => writeFileSync(marks + '/exited', String(code)));
const stream = JSON.parse(readFileSync(process.env.FAKE_FIXTURE, 'utf8').replaceAll('{{project}}', process.env.FAKE_PROJECT)).stream;
const thread = stream.find(entry => entry.after === 'thread/start' && entry.reply).reply.thread.id;
const send = lines => process.stdout.write(lines.map(line => JSON.stringify(line) + '\\n').join(''));
let turns = 0;
const reader = createInterface({input: process.stdin});
reader.on('line', line => {
  const message = JSON.parse(line);
  if (!message.method) return;
  // The mark of each turn holds the text of its line.
  if (message.method === 'turn/start') writeFileSync(marks + '/turn-' + ++turns, message.params.input[0].text);
  if (message.method === 'turn/start' && turns === 1 && process.env.FAKE_BIG) {
    // One agent message larger than the buffer of a terminal, then the end of the turn.
    const id = 'big-turn';
    send([{id: message.id, result: {turn: {id, status: 'inProgress', items: []}}},
      {method: 'item/completed', params: {threadId: thread, turnId: id, item: {type: 'agentMessage', id: 'big', text: 'x'.repeat(Number(process.env.FAKE_BIG))}}},
      {method: 'turn/completed', params: {threadId: thread, turn: {id, items: [], status: 'completed', error: null}}}]);
    return;
  }
  if (message.method === 'turn/start' && turns > 1) {
    // Each later turn gets its own turn id, as the real controller gives.
    const turn = stream.find(entry => entry.after === 'turn/start' && entry.reply).reply.turn.id;
    send(JSON.parse(JSON.stringify(stream.filter(entry => entry.after === 'turn/start')).replaceAll(turn, turn + '-' + turns))
      .map(entry => (entry.reply ? {id: message.id, result: entry.reply} : entry.notification ?? entry.request)));
    return;
  }
  if (message.method === 'turn/start') {
    mark('turn-started');
    send([{id: message.id, result: {turn: {id: 'held-turn', status: 'inProgress', items: []}}}]);
    return;
  }
  if (message.method === 'turn/interrupt') {
    mark('interrupt');
    send([{id: message.id, result: {}}, {method: 'turn/completed', params: {threadId: thread, turn: {id: 'held-turn', items: [], status: 'interrupted', error: null}}}]);
    return;
  }
  send(stream.filter(entry => entry.after === message.method).map(entry => (entry.reply ? {id: message.id, result: entry.reply} : entry.notification ?? entry.request)));
});
reader.on('close', () => process.exit(0));
`;
async function signalFixture({pty, script = PTY, mark = 'turn-started', pump = true, env = {}} = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sage-signal-')));
  const project = join(root, 'project'), marks = join(root, 'marks');
  mkdirSync(project); mkdirSync(marks);
  writeFileSync(join(root, 'codex'), FAKE_CONTROLLER); chmodSync(join(root, 'codex'), 0o755);
  writeFileSync(join(root, 'chief.md'), INSTRUCTIONS);
  const clientPath = fileURLToPath(new URL('../../../plugins/sage-codex/runtime/controller-client.mjs', import.meta.url));
  const command = [process.execPath, clientPath, '--project', project, '--task', 'T400', '--run', 'R1461', '--instructions', join(root, 'chief.md')];
  // detached: the client leads its own process group, as a job in a terminal does. With `pty`, the Python helper
  // runs the client on a pseudo terminal, types the `pty` text when it is not empty, waits for the `mark` (reading the
  // terminal only with `pump`), and closes the terminal.
  const [file, ...args] = pty === undefined ? command : ['python3', '-I', '-c', script, pty, join(marks, mark), pump ? '1' : '0', ...command];
  const client = spawn(file, args, {
    detached: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: {PATH: process.env.PATH, SAGE_CODEX_CONTROLLER_BIN: join(root, 'codex'), FAKE_FIXTURE: fileURLToPath(new URL('./controller-fixture.json', import.meta.url)), FAKE_PROJECT: project, FAKE_MARKS: marks, ...env},
  });
  let out = '', code;
  client.stdout.on('data', chunk => { out += chunk; });
  const exited = new Promise(resolve => client.on('close', value => { code = value; resolve(value); }));
  // Polls for a marker; the bound is a count of short waits, not a time assertion.
  const waitFor = async (check, what) => {
    for (let i = 0; i < 1500; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
    assert.fail(`never reached: ${what}; output: ${out}`);
  };
  const marked = name => existsSync(join(marks, name));
  async function close() {
    if (code === undefined) { client.kill('SIGKILL'); await exited; }
    rmSync(root, {recursive: true, force: true});
  }
  return {client, exited, waitFor, marked, marks, out: () => out, done: () => code !== undefined, close};
}

test('signal: a real SIGINT to the client process group stops the turn, and the controller stays ready (R1504-1, R1502-1)', {timeout: 120000}, async () => {
  const s = await signalFixture();
  try {
    s.client.stdin.write('Wait for an interrupt.\n');
    await s.waitFor(() => s.marked('turn-started'), 'the held turn');
    // A terminal sends Ctrl-C to each process of the foreground process group.
    process.kill(-s.client.pid, 'SIGINT');
    await s.waitFor(() => s.marked('interrupt') || s.done(), 'the interrupt or the client exit');
    await s.waitFor(() => s.out().includes('[You stopped the turn.') || s.done(), 'the turn result');
    if (!s.done()) s.client.stdin.write('Say one synthetic sentence.\n');
    await s.waitFor(() => s.out().includes('[Turn completed.]') || s.done(), 'the next turn');
    s.client.stdin.end();
    const code = await s.exited;
    assert.deepEqual(s.out().trimEnd().split('\n').slice(HEADER.length + READY.length), ['[Stopping the turn... Press Ctrl-C again to stop the controller.]',
      `[You stopped the turn. ${NEXT}]`, WARNING, `chief> ${SYNTHETIC_REPLY}`, '[Turn completed.]', STOPPED], s.out());
    assert.equal(code, 0);
    assert.equal(readFileSync(join(s.marks, 'exited'), 'utf8'), '0', 'the controller ended by its own exit, after the client stopped it');
  } finally { await s.close(); }
});

test('signal: two Ctrl-C stop the controller, and the client exits with code 0 while its input is still open', {timeout: 120000}, async () => {
  const s = await signalFixture();
  try {
    s.client.stdin.write('Wait for an interrupt.\n');
    await s.waitFor(() => s.marked('turn-started'), 'the held turn');
    process.kill(-s.client.pid, 'SIGINT');
    await s.waitFor(() => s.out().includes('[Stopping the turn...') || s.done(), 'the first Ctrl-C note');
    process.kill(-s.client.pid, 'SIGINT');
    await s.waitFor(s.done, 'the client exit with its input open');
    assert.equal(await s.exited, 0);
    assert.equal(s.out().trimEnd().split('\n').at(-1), STOPPED);
    await s.waitFor(() => s.marked('exited'), 'the controller exit');
  } finally { await s.close(); }
});

// A real terminal: Python's pty.fork runs the client on a pseudo terminal, waits for the Ready lines (and for a mark
// when it types a line), then closes the terminal, as the owner who closes the window does. It waits a bounded count
// of short steps for the client, and stops only its own child, by its pid from fork, if the client stays up.
const PTY = `
import json, os, pty, select, signal, sys, time
line, mark, pumping, args = sys.argv[1], sys.argv[2], sys.argv[3] == '1', sys.argv[4:]
pid, fd = pty.fork()
if pid == 0:
    os.execv(args[0], args)
out = bytearray()
def pump():
    if select.select([fd], [], [], 0.02)[0]:
        try:
            out.extend(os.read(fd, 4096))
        except OSError:
            pass
for _ in range(1500):
    if b'[Type a line' in out:
        break
    pump()
ready = b'[Type a line' in out
if ready and line:
    os.write(fd, line.encode() + b'\\n')
    for _ in range(1500):
        if os.path.exists(mark):
            break
        if pumping:
            pump()
        else:
            time.sleep(0.02)
marked = os.path.exists(mark)
os.close(fd)
code = None
for _ in range(1500):
    done, status = os.waitpid(pid, os.WNOHANG)
    if done:
        code = os.waitstatus_to_exitcode(status)
        break
    time.sleep(0.02)
killed = code is None
if killed:
    os.kill(pid, signal.SIGKILL)
    code = os.waitstatus_to_exitcode(os.waitpid(pid, 0)[1])
print(json.dumps({'ready': ready, 'marked': marked, 'code': code, 'killed': killed}))
`;
async function closedTerminal(line, options) {
  const s = await signalFixture({pty: line, ...options});
  try {
    const code = await s.exited;
    return {...JSON.parse(s.out()), helperCode: code, controllerExit: s.marked('exited') ? readFileSync(join(s.marks, 'exited'), 'utf8') : null};
  } finally { await s.close(); }
}
const PYTHON = spawnSync('python3', ['-I', '-c', 'import pty'], {stdio: 'ignore'}).status === 0 ? false : 'python3 with the pty module is not on PATH';

test('pty: closing the terminal at Ready stops the client with code 1 and ends the controller (R1525-1)', {skip: PYTHON, timeout: 120000}, async () => {
  assert.deepEqual(await closedTerminal(''), {ready: true, marked: false, code: 1, killed: false, helperCode: 0, controllerExit: '0'});
});

test('pty: closing the terminal during a turn stops the client with code 1 and ends the controller (R1525-1, R1526-3)', {skip: PYTHON, timeout: 120000}, async () => {
  assert.deepEqual(await closedTerminal('Wait for an interrupt.'), {ready: true, marked: true, code: 1, killed: false, helperCode: 0, controllerExit: '0'});
});

// The terminal takes no output while the chief writes more than its buffer. A blocking write would stop the client
// there, so it would never read the second line: the client writes to its terminal without blocking (R1543-3).
test('pty: a terminal that takes no output does not stop the client; it runs the next line, and a close then stops it (R1543-3)', {skip: PYTHON, timeout: 120000}, async () => {
  assert.deepEqual(await closedTerminal('Write a long text.\nSay one synthetic sentence.', {mark: 'turn-2', pump: false, env: {FAKE_BIG: String(512 * 1024)}}),
    {ready: true, marked: true, code: 1, killed: false, helperCode: 0, controllerExit: '0'});
});

// The owner pastes into a terminal of 80 columns, as a terminal app gives a paste: in pieces, with the echo read
// meanwhile. Each step types its keys and waits a bounded count of short reads for its text; at the end the helper
// waits for the client's exit, and stops only its own child, by its pid from fork, if the client stays up.
const PASTE = `
import fcntl, json, os, pty, select, struct, sys, termios, time
steps, args = json.loads(sys.argv[1]), sys.argv[4:]
pid, fd = pty.fork()
if pid == 0:
    os.execv(args[0], args)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 80, 0, 0))
out = bytearray()
def pump():
    if select.select([fd], [], [], 0.02)[0]:
        try:
            out.extend(os.read(fd, 65536))
        except OSError:
            pass
def wait(text):
    for _ in range(500):
        if os.path.exists(sys.argv[2]) if text == '' else text.encode() in out:
            return True
        pump()
    return False
seen = [wait('[Type a line')]
for keys, text in steps:
    data, sent = keys.encode(), 0
    for _ in range(20000):
        if sent >= len(data):
            break
        if select.select([], [fd], [], 0.02)[1]:
            sent += os.write(fd, data[sent:sent + 1024])
        pump()
    seen.append(wait(text))
code = None
for _ in range(500):
    done, status = os.waitpid(pid, os.WNOHANG)
    if done:
        code = os.waitstatus_to_exitcode(status)
        break
    pump()
killed = code is None
if killed:
    os.kill(pid, 9)
    code = os.waitstatus_to_exitcode(os.waitpid(pid, 0)[1])
os.close(fd)
plain = out.replace(b'\\x1b[?2004h', b'').replace(b'\\x1b[?2004l', b'')
print(json.dumps({'seen': seen, 'code': code, 'killed': killed, 'escape': b'\\x1b' in plain, 'paste': [out.count(b'\\x1b[?2004h'), out.count(b'\\x1b[?2004l')]}))
`;
// A terminal in line mode keeps at most 1024 bytes of one line on macOS (MAX_CANON), so these lines never reached the
// client before it read the terminal raw (R1554-1).
test('pty: a pasted line of 3000 bytes and one of 60000 bytes each run as one turn with the full text; Ctrl-C and Ctrl-D still work', {skip: PYTHON, timeout: 120000}, async () => {
  const first = `${'é'.repeat(700)}${'a'.repeat(1600)}`, second = `${'w'.repeat(59998)}é`;
  assert.deepEqual([Buffer.byteLength(first), Buffer.byteLength(second)], [3000, 60000]);
  // In the first line, the owner presses Left (a key sequence that the client ignores), then types two letters and
  // removes them with Backspace.
  // Each step types its keys, then waits for its text in the terminal ('' waits for the mark of the first turn).
  const steps = [[`${first.slice(0, 700)}\x1b[Dxy\x7f\x7f${first.slice(700)}\r`, ''], ['\x03', '[You stopped the turn.'],
    [`${second}\r`, '[Turn completed.]'], ['\x03', '[No turn is running.'], ['\x04', '[You stopped the controller. The session ended.]']];
  const s = await signalFixture({pty: JSON.stringify(steps), script: PASTE, mark: 'turn-1'});
  try {
    assert.equal(await s.exited, 0);
    assert.deepEqual(JSON.parse(s.out()), {seen: [true, true, true, true, true, true], code: 0, killed: false, escape: false, paste: [1, 1]});
    assert.deepEqual(readdirSync(s.marks).filter(name => name.startsWith('turn-')).sort(), ['turn-1', 'turn-2', 'turn-started']);
    assert.equal(readFileSync(join(s.marks, 'turn-1'), 'utf8'), first);
    assert.equal(readFileSync(join(s.marks, 'turn-2'), 'utf8'), second);
    assert.equal(readFileSync(join(s.marks, 'exited'), 'utf8'), '0', 'the controller ended by its own exit');
  } finally { await s.close(); }
});

// The owner pastes five lines into a real terminal that brackets the paste, then presses Enter: one turn with the
// five lines (R1577-1). Then Ctrl-C clears a typed line (R1575-2), and an ESC in one read and "[A" in the next add
// no text (R1575-4). The step with keys 'q7\x1b' waits for the echo of q7, so the ESC came in that read.
test('pty: a bracketed paste of five lines is one turn; Ctrl-C clears a typed line; a split key sequence adds nothing', {skip: PYTHON, timeout: 120000}, async () => {
  const steps = [['\x1b[200~l1\rl2\rl3\rl4\rl5\x1b[201~\r', ''], ['\x03', '[You stopped the turn.'], ['drop the table', 'drop the table'],
    ['\x03', '[You cleared the line.'], ['q7\x1b', 'q7'], ['[Ak\r', '[Turn completed.]'], ['\x04', '[You stopped the controller. The session ended.]']];
  const s = await signalFixture({pty: JSON.stringify(steps), script: PASTE, mark: 'turn-1'});
  try {
    assert.equal(await s.exited, 0);
    assert.deepEqual(JSON.parse(s.out()), {seen: [true, true, true, true, true, true, true, true], code: 0, killed: false, escape: false, paste: [1, 1]});
    assert.deepEqual(readdirSync(s.marks).filter(name => name.startsWith('turn-')).sort(), ['turn-1', 'turn-2', 'turn-started']);
    assert.equal(readFileSync(join(s.marks, 'turn-1'), 'utf8'), 'l1\nl2\nl3\nl4\nl5');
    assert.equal(readFileSync(join(s.marks, 'turn-2'), 'utf8'), 'q7k');
  } finally { await s.close(); }
});
