import test from 'node:test';
import assert from 'node:assert/strict';
import {chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {EventEmitter} from 'node:events';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
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
  function flush(request) {
    const ready = stream.filter(entry => entry.after === request.method)
      .map(entry => entry.reply ? {id: request.id, result: entry.reply} : entry.notification ?? entry.request);
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
  assert.deepEqual(opened.policy.selection.approvalPolicy, {value: 'on-request', origin: 'default'});
  assert.deepEqual(opened.policy.selection.model, {value: 'synthetic', origin: 'user'});
  const result = await f.owner.runTurn('Say one synthetic sentence.');
  assert.deepEqual({...result, status: result.status.state}, {state: 'completed', task: 'T400', run: 'R1461', threadId: THREAD, turnId: TURN,
    bindingHash: opened.policy.bindingHash, inputSha256: '354e577748c6f0b5456f8c9461aa3bd778d12fdc6df74e6eda230253ecf2b6d0',
    lastAgentMessage: SYNTHETIC_REPLY, error: null, timedOut: false, eventCount: 15, status: 'ready'});
  assert.deepEqual(f.methods(), ['initialize', 'initialized', 'config/read', 'thread/start', 'turn/start']);
  assert.deepEqual(f.sent.find(message => message.method === 'thread/start').params, {cwd: PROJECT, ephemeral: true, developerInstructions: INSTRUCTIONS});
  assert.deepEqual(f.sent.find(message => message.method === 'turn/start').params, {threadId: THREAD, input: [{type: 'text', text: 'Say one synthetic sentence.'}]});
  const events = f.owner.events();
  assert.deepEqual(events.map(event => event.method), fixtureMethods(f.stream));
  assert.deepEqual(events.map(event => event.seq), events.map((_, index) => index + 1));
  assert.deepEqual(f.events, [...events]);
  assert.ok(Object.isFrozen(events) && Object.isFrozen(events[0]) && Object.isFrozen(events[0].message.params));
  assert.ok(Object.isFrozen(result));
  const stop = await f.owner.stop();
  assert.equal(stop.state, 'stopped'); assert.equal(f.timersClear(), true);
});

for (const [name, edit, code] of [
  ['fake 2: a user origin for features.multi_agent_v2', stream => { stream.find(entry => entry.after === 'config/read').reply.origins['features.multi_agent_v2.enabled'].name = {type: 'user', file: '/x', profile: null}; return stream; }, 'policy-origin'],
  ['fake 3: cliVersion 0.161.0', stream => { stream.find(entry => entry.after === 'thread/start' && entry.reply).reply.thread.cliVersion = '0.161.0'; return stream; }, 'version'],
  ['fake 4: a reply model that differs from the effective model', stream => { stream.find(entry => entry.after === 'thread/start' && entry.reply).reply.model = 'other-model'; return stream; }, 'selection-changed'],
]) test(`${name} refuses and sends no turn/start`, async () => {
  const f = fake({edit});
  const opened = await bound(f);
  assert.equal(opened.state, 'refused'); assert.equal(opened.code, code);
  assert.equal(opened.status.state, 'stopped');
  await assert.rejects(f.owner.runTurn('Say one synthetic sentence.'), /No bound root thread/);
  assert.equal(f.methods().includes('turn/start'), false);
  assert.deepEqual(f.methods(), ['initialize', 'initialized', 'config/read', 'thread/start']);
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
  assert.deepEqual(f.owner.events().filter(event => event.method === 'turn/completed').map(event => event.message.params.threadId), ['child-thread', THREAD, THREAD]);
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
  assert.equal(f.owner.events().length, 3);
  await f.owner.stop();
});

test('fake 12: a server request is refused with -32601 and kept as an event', async () => {
  const request = {id: 'server-1', method: 'item/commandExecution/requestApproval', params: {threadId: THREAD, turnId: TURN, itemId: 'cmd-1', command: 'true'}};
  const f = fake({edit: stream => { stream.splice(stream.findIndex(isRootTerminal), 0, {after: 'turn/start', request}); return stream; }});
  assert.equal((await bound(f)).state, 'bound');
  const result = await f.owner.runTurn('Say one synthetic sentence.');
  assert.equal(result.state, 'completed');
  assert.deepEqual(f.sent.find(message => message.id === 'server-1'), {id: 'server-1', error: {code: -32601, message: 'Controller transport does not handle server requests'}});
  const kept = f.owner.events().find(event => event.kind === 'server-request-refused');
  assert.deepEqual({...kept}, {seq: 15, kind: 'server-request-refused', method: 'item/commandExecution/requestApproval', message: request});
  await f.owner.stop();
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
  await assert.rejects(f.owner.runTurn(''), /Turn text/);
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

// Part 2: one gated test against the real fork binary. It runs only when SAGE_CODEX_CONTROLLER_BIN is set.
const REAL = process.env.SAGE_CODEX_CONTROLLER_BIN ? false : 'SAGE_CODEX_CONTROLLER_BIN is not set; the real controller test is skipped';

function sse(events) {
  return events.map(event => `event: ${event.type}\n` + (Object.keys(event).length === 1 ? '\n' : `data: ${JSON.stringify(event)}\n\n`)).join('');
}
const created = {type: 'response.created', response: {id: 'resp-1'}};
const message = {type: 'response.output_item.done', item: {type: 'message', role: 'assistant', id: 'msg-1', content: [{type: 'output_text', text: SYNTHETIC_REPLY}]}};
const completed = {type: 'response.completed', response: {id: 'resp-1', usage: {input_tokens: 0, input_tokens_details: null, output_tokens: 0, output_tokens_details: null, total_tokens: 0}}};

async function realFixture({hold = false} = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sage-owned-')));
  const home = join(root, 'codex-home'), project = join(root, 'project'), bin = join(root, 'bin'), userHome = join(root, 'home');
  for (const dir of [home, project, bin, userHome]) mkdirSync(dir);
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
      response.end(sse([created, message, completed]));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const {port} = server.address();
  assert.ok(port !== 4173 && port !== 43123, 'the loopback provider never uses a reserved port');
  const url = `http://127.0.0.1:${port}`;
  writeFileSync(join(home, 'config.toml'), `model = "synthetic"
model_provider = "synthetic"
approval_policy = "never"
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
`);
  writeFileSync(join(home, 'auth.json'), JSON.stringify({auth_mode: 'apikey', OPENAI_API_KEY: 'synthetic-api-key'}));
  const binary = resolveControllerBinary(process.env);
  const events = [];
  const owner = createControllerProcess({
    executable: binary.path, executableSha256: binary.sha256, cwd: project,
    env: {PATH: `${bin}:/usr/bin:/bin`, HOME: userHome, TMPDIR: root, CODEX_HOME: home, CODEX_AUTHAPI_BASE_URL: url,
      CODEX_APP_SERVER_DISABLE_MANAGED_CONFIG: '1', CODEX_APP_SERVER_MANAGED_CONFIG_PATH: join(home, 'managed_config.toml'),
      NO_PROXY: '*', no_proxy: '*', RUST_LOG: 'warn', DO_NOT_TRACK: '1'},
    startupTimeoutMs: 60000, inspectionTimeoutMs: 30000, stopGraceMs: 5000, turnTimeoutMs: 60000, interruptGraceMs: 10000,
    onEvent: event => events.push(event),
  });
  async function close() {
    for (const response of held) response.end();
    await new Promise(resolve => server.close(resolve));
    server.closeAllConnections?.();
    rmSync(root, {recursive: true, force: true});
  }
  return {root, home, project, binary, owner, requests, events, held, close};
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
    saveEvidence('real-completed-turn', {result, tools, requests: f.requests.map(({method, url}) => ({method, url})), events: f.owner.events()});
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
