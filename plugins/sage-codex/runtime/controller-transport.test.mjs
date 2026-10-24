import test, {beforeEach} from 'node:test';
import assert from 'node:assert/strict';
const module = await import('./controller-transport.mjs').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw error;
});
const {createControllerTransport, OWNED_CONTROLLER_CONFIG} = module;
beforeEach(() => assert.equal(typeof createControllerTransport, 'function', 'controller transport must exist'));

function fixture(options = {}) {
  const sent = [];
  const transport = createControllerTransport({generation: 'connection-1', send: message => sent.push(message), ...options});
  return {sent, transport, reply(id, result) { return transport.receive({id, result}, 'connection-1'); }};
}
async function ready(f) {
  const initialized = f.transport.initialize();
  assert.deepEqual(f.sent[0], {id: 0, method: 'initialize', params: {clientInfo: {name: 'sage_controller', version: '0.1.0'}, capabilities: {experimentalApi: true}}});
  assert.equal(f.sent.length, 1);
  f.reply(0, {userAgent: 'fixture'});
  assert.deepEqual(await initialized, {userAgent: 'fixture'});
  assert.deepEqual(f.sent[1], {method: 'initialized'});
}

test('initialization orders notification after acceptance, and refusal never initializes', async () => {
  await ready(fixture());
  const f = fixture();
  const pending = f.transport.initialize();
  f.transport.receive({id: 0, error: {code: -32602, message: 'refused'}}, 'connection-1');
  await assert.rejects(pending, error => error.code === 'refused' && error.rpcError.code === -32602);
  assert.equal(f.sent.length, 1);
  assert.throws(() => f.transport.startThread(), /not initialized/);
});

test('owned thread start carries instructions, keeps the owner selection, and turns name their exact targets', async () => {
  const f = fixture();
  await ready(f);
  const start = f.transport.startThread({cwd: '/project', ephemeral: true, developerInstructions: 'Chief instructions.'});
  assert.deepEqual(f.sent.at(-1), {id: 1, method: 'thread/start', params: {cwd: '/project', ephemeral: true, developerInstructions: 'Chief instructions.'}});
  f.reply(1, {thread: {id: 'thread-a'}}); await start;
  for (const text of ['first', 'second']) {
    const input = [{type: 'text', text}];
    const turn = f.transport.startTurn({threadId: 'thread-a', input}); input[0].text = 'mutated';
    const request = f.sent.at(-1);
    assert.deepEqual(request.params, {threadId: 'thread-a', input: [{type: 'text', text}]});
    f.reply(request.id, {turn: {id: text}}); assert.deepEqual(await turn, {turn: {id: text}});
  }
  const interrupted = f.transport.interruptTurn({threadId: 'thread-a', turnId: 'second'});
  assert.deepEqual(f.sent.at(-1), {id: 4, method: 'turn/interrupt', params: {threadId: 'thread-a', turnId: 'second'}});
  f.reply(4, {}); assert.deepEqual(await interrupted, {});
  for (const params of [{threadId: 'thread-a'}, {threadId: '', turnId: 'x'}, {threadId: 'thread-a', turnId: 'x', extra: 1}]) assert.throws(() => f.transport.interruptTurn(params));
  assert.equal(f.sent.length, 6);
  assert.deepEqual(OWNED_CONTROLLER_CONFIG, {'agents.enabled': true, 'features.multi_agent': false, 'features.multi_agent_v2': true, 'features.goals': false, web_search: 'disabled', 'features.plugins': false, 'features.apps': false, 'features.remote_plugin': false});
  assert.throws(() => { OWNED_CONTROLLER_CONFIG.web_search = 'live'; }, TypeError);
});

test('developer instructions must be non-empty text of at most 256 KiB with no NUL', async () => {
  const f = fixture(); await ready(f);
  for (const developerInstructions of ['', 'a\0b', 'é'.repeat(128 * 1024 + 1), 7]) assert.throws(() => f.transport.startThread({developerInstructions}), /instructions/);
  assert.equal(f.sent.length, 2);
  const limit = 'a'.repeat(256 * 1024);
  const accepted = f.transport.startThread({developerInstructions: limit});
  assert.equal(f.sent.at(-1).params.developerInstructions.length, 256 * 1024);
  f.reply(1, {}); assert.deepEqual(await accepted, {});
});

test('mixed ID types and reordered responses settle only their exact requests', async () => {
  const f = fixture({initialRequestId: '0'});
  const init = f.transport.initialize(); f.reply('0', {}); await init;
  const first = f.transport.startThread(); const second = f.transport.startThread();
  assert.equal(f.sent.at(-2).id, 0); assert.equal(f.sent.at(-1).id, 1);
  f.reply(1, {thread: {id: 'second'}}); f.reply(0, {thread: {id: 'first'}});
  assert.deepEqual(await Promise.all([first, second]), [{thread: {id: 'first'}}, {thread: {id: 'second'}}]);
});

for (const [name, invalid, generation] of [
  ['unknown', {id: '1', result: {}}, 'connection-1'],
  ['stale', {id: 1, result: {}}, 'old-connection'],
  ['malformed', {id: 1, result: {}, error: {code: 1, message: 'bad'}}, 'connection-1'],
  ['invalid error', {id: 1, error: {message: 'bad'}}, 'connection-1'],
  ['invalid JSON', '{', 'connection-1'],
]) test(`${name} input closes pending work as uncertain without replay`, async () => {
  const f = fixture(); await ready(f);
  const first = f.transport.startThread(); const second = f.transport.startThread();
  const checks = [first, second].map(p => assert.rejects(p, e => e.code === 'uncertain'));
  assert.throws(() => f.transport.receive(invalid, generation));
  await Promise.all(checks);
  assert.throws(() => f.transport.startThread(), /closed/);
  assert.equal(f.sent.length, 4);
});

test('duplicate reply closes remaining work; notifications are immutable observations', async () => {
  const f = fixture(); await ready(f);
  const first = f.transport.startThread(); f.reply(1, {thread: {id: 'a'}}); await first;
  const next = f.transport.startThread(); const check = assert.rejects(next, e => e.code === 'uncertain');
  const notification = {method: 'turn/completed', params: {turn: {id: 'x'}}};
  const observed = f.transport.receive(notification, 'connection-1');
  notification.params.turn.id = 'changed';
  assert.deepEqual(observed, {kind: 'observation', notification: {method: 'turn/completed', params: {turn: {id: 'x'}}}});
  assert.throws(() => { observed.notification.params.turn.id = 'changed'; }, TypeError);
  assert.throws(() => f.reply(1, {})); await check;
});

test('server requests receive protocol refusal and cannot execute effects', async () => {
  const f = fixture(); await ready(f);
  assert.deepEqual(f.transport.receive({id: 0, method: 'item/tool/call', params: {tool: 'write'}}, 'connection-1'),
    {kind: 'server-request-refused', method: 'item/tool/call', request: {id: 0, method: 'item/tool/call', params: {tool: 'write'}}});
  assert.deepEqual(f.sent.at(-1), {id: 0, error: {code: -32601, message: 'Controller transport does not handle server requests'}});
  const start = f.transport.startThread(); f.reply(1, {thread: {id: 'safe'}}); await start;
});

test('caller overrides and non-JSON input fail before send, with valid paired control', async () => {
  const f = fixture(); await ready(f);
  for (const params of [{environments: []}, {config: {}}, {dynamicTools: []}, {model: 'other'}, {sandbox: 'danger-full-access'}, {approvalPolicy: 'never'}]) assert.throws(() => f.transport.startThread(params));
  assert.equal(f.transport.resumeThread, undefined);
  for (const params of [{threadId: 'a', input: [], environments: []}, {threadId: 'a', input: [{type: 'image', imageUrl: 'x'}]}, {threadId: 'a', input: [{type: 'text', text: undefined}]}]) assert.throws(() => f.transport.startTurn(params));
  assert.equal(f.sent.length, 2);
  const accepted = f.transport.startThread(); f.reply(1, {}); assert.deepEqual(await accepted, {});
});

test('disconnect and a failed send settle uncertain and do not retry', async () => {
  const f = fixture(); await ready(f);
  const pending = f.transport.startThread(); const check = assert.rejects(pending, e => e.code === 'uncertain');
  f.transport.disconnect(); await check; assert.equal(f.sent.length, 3);
  let sends = 0;
  const broken = createControllerTransport({generation: 'g', send() { sends++; throw Error('write failed'); }});
  await assert.rejects(broken.initialize(), e => e.code === 'uncertain'); assert.equal(sends, 1);
});


test('synchronous replies are owned before send and response data cannot be changed', async () => {
  let transport;
  const sent = [];
  transport = createControllerTransport({generation: 'sync', send(message) {
    sent.push(message);
    if (message.method === 'initialize') transport.receive({id: message.id, result: {}}, 'sync');
    if (message.method === 'thread/start') {
      const result = {thread: {id: 'original'}};
      transport.receive({id: message.id, result}, 'sync'); result.thread.id = 'changed';
    }
  }});
  await transport.initialize();
  assert.deepEqual(await transport.startThread(), {thread: {id: 'original'}});
  assert.deepEqual(sent.map(x => x.method), ['initialize', 'initialized', 'thread/start']);
});

test('async send rejection and initialized notification rejection stay uncertain', async () => {
  const broken = createControllerTransport({generation: 'g', send: () => Promise.reject(Error('rejected write'))});
  await assert.rejects(broken.initialize(), e => e.code === 'uncertain');
  let transport;
  transport = createControllerTransport({generation: 'g', send(message) {
    if (message.method === 'initialize') transport.receive({id: message.id, result: {}}, 'g');
    else return Promise.reject(Error('notification failed'));
  }});
  await assert.rejects(transport.initialize(), e => e.code === 'uncertain');
  assert.throws(() => transport.startThread(), /closed/);
});

test('JSON boundary refuses getters, prototypes, holes and cycles without invoking getters', async () => {
  const f = fixture(); await ready(f);
  let reads = 0;
  const getter = Object.defineProperty({}, 'cwd', {enumerable: true, get() { reads++; return '/project'; }});
  const cycle = {}; cycle.cwd = cycle;
  for (const value of [getter, Object.create({cwd: '/project'}), cycle]) assert.throws(() => f.transport.startThread(value));
  assert.throws(() => f.transport.startTurn({threadId: 't', input: Array(1)}));
  assert.equal(reads, 0); assert.equal(f.sent.length, 2);
  const accepted = f.transport.startThread({cwd: '/project'}); f.reply(1, {}); assert.deepEqual(await accepted, {});
});


test('negative integer request IDs remain distinct from strings and server requests', async () => {
  const f = fixture({initialRequestId: -1});
  const init = f.transport.initialize();
  assert.equal(f.sent[0].id, -1);
  f.reply(-1, {}); await init;
  assert.deepEqual(f.transport.receive({id: -1, method: 'item/tool/call', params: {}}, 'connection-1'),
    {kind: 'server-request-refused', method: 'item/tool/call', request: {id: -1, method: 'item/tool/call', params: {}}});
  assert.deepEqual(f.sent.at(-1), {id: -1, error: {code: -32601, message: 'Controller transport does not handle server requests'}});
  const pending = f.transport.startThread();
  assert.equal(f.sent.at(-1).id, 0);
  f.reply(0, {thread: {id: 'negative-control'}});
  assert.deepEqual(await pending, {thread: {id: 'negative-control'}});
  const string = fixture({initialRequestId: '-1'});
  const stringInit = string.transport.initialize();
  assert.equal(string.sent[0].id, '-1');
  const rejected = assert.rejects(stringInit, error => error.code === 'uncertain');
  assert.throws(() => string.reply(-1, {}));
  await rejected;
});

test('initialization waits for successful notification delivery before accepting work', async () => {
  let finishSend;
  const notificationSent = new Promise(resolve => { finishSend = resolve; });
  const sent = [];
  const transport = createControllerTransport({generation: 'g', send(message) {
    sent.push(message);
    if (message.method === 'initialized') return notificationSent;
  }});
  let settled = false;
  const initialized = transport.initialize().then(result => { settled = true; return result; });
  transport.receive({id: 0, result: {userAgent: 'fixture'}}, 'g');
  await Promise.resolve();
  assert.deepEqual(sent.at(-1), {method: 'initialized'});
  assert.equal(settled, false);
  assert.throws(() => transport.startThread(), /not initialized/);
  finishSend();
  assert.deepEqual(await initialized, {userAgent: 'fixture'});
  assert.equal(settled, true);
  const started = transport.startThread();
  assert.deepEqual(sent.at(-1), {id: 1, method: 'thread/start', params: {}});
  transport.receive({id: 1, result: {thread: {id: 'ready'}}}, 'g');
  assert.deepEqual(await started, {thread: {id: 'ready'}});
});


test('native timestamped notifications remain immutable observations without settling pending work', async () => {
  const f = fixture(); await ready(f);
  const pending = f.transport.startThread();
  let settled = false;
  const result = pending.then(value => { settled = true; return value; });
  const native = {method: 'remoteControl/status/changed', params: {status: 'disabled', serverName: 'fixture-host.example', installationId: 'fixture-installation', environmentId: null}, emittedAtMs: 1792540800000};
  const observation = f.transport.receive(native, 'connection-1');
  native.params.serverName = 'changed';
  assert.deepEqual(observation, {kind: 'observation', notification: {method: 'remoteControl/status/changed', params: {status: 'disabled', serverName: 'fixture-host.example', installationId: 'fixture-installation', environmentId: null}, emittedAtMs: 1792540800000}});
  assert.throws(() => { observation.notification.emittedAtMs = 0; }, TypeError);
  await Promise.resolve(); assert.equal(settled, false);
  f.reply(1, {thread: {id: 'fixture-session'}});
  assert.deepEqual(await result, {thread: {id: 'fixture-session'}});
});

for (const emittedAtMs of [null, '1792540800000', 1.5, 9007199254740992]) {
  test(`invalid notification timestamp ${String(emittedAtMs)} closes pending work as uncertain`, async () => {
    const f = fixture(); await ready(f);
    const pending = f.transport.startThread();
    const check = assert.rejects(pending, error => error.code === 'uncertain');
    assert.throws(() => f.transport.receive({method: 'thread/started', params: {}, emittedAtMs}, 'connection-1'), /timestamp/);
    await check;
    assert.throws(() => f.transport.startThread(), /closed/);
  });
}

test('disconnect settles initialization before a blocked notification writer finishes', async () => {
  let finishSend;
  const notificationSend = new Promise(resolve => { finishSend = resolve; });
  const sent = [];
  const transport = createControllerTransport({generation: 'g', send(message) {
    sent.push(message);
    if (message.method === 'initialized') return notificationSend;
  }});
  let outcome = 'pending';
  const initialized = transport.initialize().then(
    () => { outcome = 'fulfilled'; },
    error => { outcome = error.code; },
  );
  transport.receive({id: 0, result: {}}, 'g');
  await Promise.resolve();
  assert.deepEqual(sent.at(-1), {method: 'initialized'});
  transport.disconnect('owned connection terminated');
  try {
    // Drain the promise reactions, without resolving the controlled writer or using a clock.
    for (let index = 0; index < 10; index++) await Promise.resolve();
    assert.equal(outcome, 'uncertain');
    assert.throws(() => transport.startThread(), /closed/);
  } finally {
    finishSend();
    await initialized;
  }
});

test('configuration read uses immutable fixed inspection cwd and rejects caller arguments', async () => {
  const f = fixture({inspectionCwd: '/fixture/project'}); await ready(f);
  assert.throws(() => f.transport.readConfiguration({cwd: '/other'}));
  const read = f.transport.readConfiguration();
  assert.deepEqual(f.sent.at(-1), {id: 1, method: 'config/read', params: {cwd: '/fixture/project', includeLayers: true}});
  f.reply(1, {config: {model: 'selected'}}); assert.deepEqual(await read, {config: {model: 'selected'}});
  const unavailable = fixture(); await ready(unavailable); assert.throws(() => unavailable.transport.readConfiguration(), /inspection/);
});
