import test from 'node:test';
import assert from 'node:assert/strict';
import {chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {EventEmitter} from 'node:events';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {PassThrough} from 'node:stream';
import {runClient} from './controller-client.mjs';
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
  // The limit counts from the turn start: the one event before the turn plus the three of the turn are kept.
  assert.equal(f.owner.events().length, 1 + 3);
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
const READY = ['[Ready: task T400, run R1461. The chief uses your Codex config: model synthetic, approval on-request, sandbox read-only.]',
  '[Type a line and press Enter: the chief gets it as one turn. Ctrl-C stops the turn. Ctrl-D stops the controller.]'];
const STOPPED = '[You stopped the controller. The session ended.]';
// The fixture turn has the real binary's warning notification; the client shows it (R1504-10).
const WARNING = '[Warning from the controller: Model metadata for `synthetic` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.]';
const NEXT = 'Type the next line, or press Ctrl-D to stop the controller.';
/** Starts the client on the fake. The caller writes to `input`; `signal` plays a signal; `code` resolves with the exit code. */
function clientRun({fakeOptions = {}, env = {}, argv = CLIENT_ARGS} = {}) {
  const f = fakeChild(fakeOptions);
  let text = '', handler, ended = false;
  const output = {write(chunk) { text += chunk; return true; }};
  const input = new PassThrough();
  // An undefined value removes that variable.
  const merged = Object.fromEntries(Object.entries({...CLIENT_ENV, ...env}).filter(([, value]) => value !== undefined));
  const code = runClient({argv, env: merged, input, output, classify: parseCommand,
    onSignal: handle => { handler = handle; }, spawn: f.spawn, schedule: f.schedule});
  code.then(() => { ended = true; });
  return {f, input, code, signal: name => handler(name), text: () => text, lines: () => text.trimEnd().split('\n'), ended: () => ended};
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

test('client: a mode phrase note says that the line goes to the chief; a near line says that no mode changed (R1504-9)', async () => {
  const run = await client(['sage mode', '', 'sage mode please']);
  assert.equal(run.code, 0);
  assert.deepEqual(run.lines().slice(HEADER.length + READY.length), [
    '[You typed the mode phrase "sage mode". The client sends it to the chief, which switches the mode and says so.]', WARNING, `chief> ${SYNTHETIC_REPLY}`, '[Turn completed.]',
    '[No mode changed: this line is not a mode phrase, so the chief gets it as a normal line. To switch, type one of these alone: sage mode, sage mode off.]', WARNING, `chief> ${SYNTHETIC_REPLY}`, '[Turn completed.]',
    STOPPED]);
  assert.deepEqual(run.f.sent.filter(message => message.method === 'turn/start').map(message => message.params.input[0].text), ['sage mode', 'sage mode please']);
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
  assert.ok(lines.includes('[The controller sent the request item/x�[2J�[Turn completed.]. This client answers no requests, so it refused.]'));
  assert.ok(lines.includes('[The turn failed: boom�[Turn completed.]�[2J. Type the line again to try again, or press Ctrl-D to stop the controller.]'));
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

test('client: a version refusal shows the found version and the fix, and ends with code 1 (R1504-3)', async () => {
  const run = await client(['Say one synthetic sentence.'], {edit: stream => { stream.find(entry => entry.after === 'thread/start' && entry.reply).reply.thread.cliVersion = '0.161.0'; return stream; }});
  assert.equal(run.code, 1);
  assert.deepEqual(run.lines(), [...HEADER, '[The client did not start the chief: The controller is version 0.161.0, but this client needs 0.160.0. Set SAGE_CODEX_CONTROLLER_BIN to the fork binary of version 0.160.0, then start the client again.]']);
  assert.equal(run.f.methods().includes('turn/start'), false);
});

test('client: each turn result says what happened and what to do next (R1504-4)', async () => {
  let turns = 0;
  const run = await client(['one', 'x'.repeat(64 * 1024 + 1), 'two', 'three'], {onRequest(message, {emit}) {
    if (message.method !== 'turn/start') return;
    turns += 1;
    if (turns === 1) { setImmediate(() => emit([{id: message.id, result: {turn: {id: 'turn-1', status: 'inProgress', items: []}}},
      {method: 'turn/completed', params: {threadId: THREAD, turn: {id: 'turn-1', items: [], status: 'failed', error: {message: 'synthetic: the model provider returned 500'}}}}])); return false; }
    if (turns === 2) { setImmediate(() => emit([{id: message.id, error: {code: -32600, message: 'synthetic: turn refused by the host'}}])); return false; }
  }});
  assert.equal(run.code, 0);
  assert.deepEqual(run.lines().slice(HEADER.length + READY.length), [
    '[The turn failed: synthetic: the model provider returned 500. Type the line again to try again, or press Ctrl-D to stop the controller.]',
    '[The client did not send the line: The line has 65537 bytes; a line must be text of 1 to 65536 bytes, with no NUL. Shorten or correct the line, then type it again.]',
    '[The controller refused the turn: synthetic: turn refused by the host. Change the line, then type it again.]',
    WARNING, `chief> ${SYNTHETIC_REPLY}`, '[Turn completed.]', STOPPED]);
});

test('client: Ctrl-C shows a message at once and stops the turn; a line typed during the turn waits, then runs (R1504-6, R1504-1)', async () => {
  const hold = holdFirstTurn();
  const run = clientRun({fakeOptions: hold.options});
  run.input.write('Wait for an interrupt.\n');
  await until(() => hold.held, 'the held turn');
  run.input.write('Say one synthetic sentence.\n');
  await until(() => run.lines().at(-1) === '[The chief is on a turn. Your line runs after it.]', 'the queued line note');
  run.signal('SIGINT');
  assert.equal(run.lines().at(-1), '[Stopping the turn... Press Ctrl-C again to stop the controller.]', 'the message comes before the result');
  await until(() => run.lines().includes('[Turn completed.]'), 'the queued line');
  run.input.end();
  assert.equal(await run.code, 0);
  assert.deepEqual(run.lines().slice(HEADER.length + READY.length), ['[The chief is on a turn. Your line runs after it.]',
    '[Stopping the turn... Press Ctrl-C again to stop the controller.]', `[You stopped the turn. ${NEXT}]`, WARNING, `chief> ${SYNTHETIC_REPLY}`, '[Turn completed.]', STOPPED]);
  assert.deepEqual(run.f.sent.filter(message => message.method === 'turn/interrupt').map(message => message.params), [{threadId: THREAD, turnId: 'held-turn'}]);
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
    `[You stopped the turn. ${NEXT}]`, STOPPED]);
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
  assert.deepEqual(run.lines().slice(HEADER.length + READY.length), [ended, '[Stopping the turn... Press Ctrl-C again to stop the controller.]', `[You stopped the turn. ${NEXT}]`, STOPPED]);
});

test('client: an approval request names the command and says that it did not run; a warning is shown (R1504-8, R1504-10)', async () => {
  const run = await client(['run ls'], {edit: stream => {
    const at = stream.findIndex(isRootTerminal);
    stream.splice(at, 0, {after: 'turn/start', request: {id: 'server-1', method: 'item/commandExecution/requestApproval', params: {threadId: THREAD, turnId: TURN, itemId: 'cmd-1', command: 'ls -la'}}});
    return stream;
  }});
  assert.equal(run.code, 0);
  assert.deepEqual(run.lines().slice(HEADER.length + READY.length), [WARNING, `chief> ${SYNTHETIC_REPLY}`,
    '[The chief asked to run a command: ls -la. This client cannot ask you yet, so it refused, and the command did not run.]', '[Turn completed.]', STOPPED]);
});

// Part 2: one gated test against the real fork binary. It runs only when SAGE_CODEX_CONTROLLER_BIN is set.
const REAL =process.env.SAGE_CODEX_CONTROLLER_BIN ? false : 'SAGE_CODEX_CONTROLLER_BIN is not set; the real controller test is skipped';

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
  const env = {PATH: `${bin}:/usr/bin:/bin`, HOME: userHome, TMPDIR: root, CODEX_HOME: home, CODEX_AUTHAPI_BASE_URL: url,
    CODEX_APP_SERVER_DISABLE_MANAGED_CONFIG: '1', CODEX_APP_SERVER_MANAGED_CONFIG_PATH: join(home, 'managed_config.toml'),
    NO_PROXY: '*', no_proxy: '*', RUST_LOG: 'warn', DO_NOT_TRACK: '1'};
  const owner = createControllerProcess({
    executable: binary.path, executableSha256: binary.sha256, cwd: project, env,
    startupTimeoutMs: 60000, inspectionTimeoutMs: 30000, stopGraceMs: 5000, turnTimeoutMs: 60000, interruptGraceMs: 10000,
    onEvent: event => events.push(event),
  });
  async function close() {
    for (const response of held) response.end();
    await new Promise(resolve => server.close(resolve));
    server.closeAllConnections?.();
    rmSync(root, {recursive: true, force: true});
  }
  return {root, home, project, binary, env, owner, requests, events, held, close};
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
      '[Ready: task T400, run R1461. The chief uses your Codex config: model synthetic, approval never, sandbox read-only.]', READY[1],
      '[You typed the mode phrase "sage mode". The client sends it to the chief, which switches the mode and says so.]', `chief> ${SYNTHETIC_REPLY}`, '[Turn completed.]',
      `chief> ${SYNTHETIC_REPLY}`, '[Turn completed.]', STOPPED]);
    assert.equal(code, 0);
    assert.equal(f.requests.filter(request => request.url === '/v1/responses').length, 2);
  } finally { await f.owner.stop(); await f.close(); }
});

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
  if (message.method === 'turn/start' && ++turns > 1) {
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
async function signalFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sage-signal-')));
  const project = join(root, 'project'), marks = join(root, 'marks');
  mkdirSync(project); mkdirSync(marks);
  writeFileSync(join(root, 'codex'), FAKE_CONTROLLER); chmodSync(join(root, 'codex'), 0o755);
  writeFileSync(join(root, 'chief.md'), INSTRUCTIONS);
  const clientPath = fileURLToPath(new URL('../../../plugins/sage-codex/runtime/controller-client.mjs', import.meta.url));
  // detached: the client leads its own process group, as a job in a terminal does.
  const client = spawn(process.execPath, [clientPath, '--project', project, '--task', 'T400', '--run', 'R1461', '--instructions', join(root, 'chief.md')], {
    detached: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: {PATH: process.env.PATH, SAGE_CODEX_CONTROLLER_BIN: join(root, 'codex'), FAKE_FIXTURE: fileURLToPath(new URL('./controller-fixture.json', import.meta.url)), FAKE_PROJECT: project, FAKE_MARKS: marks},
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

test('signal: when the client dies, the controller in its own process group ends too', {timeout: 120000}, async () => {
  const s = await signalFixture();
  try {
    s.client.stdin.write('Wait for an interrupt.\n');
    await s.waitFor(() => s.marked('turn-started'), 'the held turn');
    s.client.kill('SIGKILL');
    await s.exited;
    // The closed stdin pipe ends the controller: no orphan stays.
    await s.waitFor(() => s.marked('exited'), 'the controller exit');
    assert.equal(readFileSync(join(s.marks, 'exited'), 'utf8'), '0');
  } finally { await s.close(); }
});
