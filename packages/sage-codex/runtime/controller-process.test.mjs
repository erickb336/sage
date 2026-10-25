import test, {beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
const api = await import('./controller-process.mjs').catch(error => { if (error.code === 'ERR_MODULE_NOT_FOUND') return {}; throw error; });
beforeEach(() => assert.equal(typeof api.createControllerProcess, 'function'));
const HASH = 'a'.repeat(64);
function fixture({auto = true, blocked = false} = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter();
  const sent = [], signals = [], timers = [];
  let spawnCount = 0, launch;
  child.stdin.end = () => { child.ended = true; };
  child.kill = signal => { signals.push(signal); return true; };
  child.stdin.write = (line, callback) => {
    const message = JSON.parse(line); sent.push(message);
    if (!(blocked && message.method === 'initialized')) callback();
    if (auto && message.method === 'initialize') queueMicrotask(() => child.stdout.emit('data', Buffer.from(JSON.stringify({id: message.id, result: {userAgent: 'fixture'}}) + '\n')));
    if (auto && message.method === 'config/read') queueMicrotask(() => child.stdout.emit('data', Buffer.from(JSON.stringify({id: message.id, result: {config: {model: 'selected'}}}) + '\n')));
  };
  const env = {PATH: '/fixture/bin', CODEX_HOME: '/fixture/home'};
  const owner = api.createControllerProcess({executable: '/fixture/codex', executableSha256: HASH, cwd: '/fixture/project', env, maxFrameBytes: 256, maxDiagnosticBytes: 8}, {
    spawn(executable, args, options) { spawnCount++; launch = {executable, args, options}; return child; },
    schedule(callback) { const timer = {callback, cancelled: false}; timers.push(timer); return () => { timer.cancelled = true; }; },
  });
  env.CODEX_HOME = 'changed';
  return {owner, child, sent, signals, timers, get launch() { return launch; }, get spawnCount() { return spawnCount; },
    close() { for (const stream of [child.stdin, child.stdout, child.stderr]) stream.emit('close'); child.emit('close', 0, null); },
    tick() { const timer = timers.find(x => !x.cancelled); assert.ok(timer); timer.cancelled = true; timer.callback(); },
  };
}
async function reactions() { for (let i = 0; i < 20; i++) await Promise.resolve(); }

test('owned startup launches only the owned entry and inspects the fixed cwd', async () => {
  const f = fixture(); await f.owner.start();
  assert.deepEqual(await f.owner.inspect(), {config: {model: 'selected'}});
  assert.equal(f.launch.executable, '/fixture/codex');
  assert.equal(f.launch.options.shell, false); assert.equal(f.launch.options.cwd, '/fixture/project');
  // Its own process group, so that a terminal Ctrl-C reaches the client only (R1504-1, R1502-1).
  assert.equal(f.launch.options.detached, true);
  assert.equal(f.launch.options.env.CODEX_HOME, '/fixture/home');
  assert.deepEqual(f.launch.args, ['app-server', '--stdio', '--owned-controller', '--strict-config',
    '-c', 'agents.enabled=true', '-c', 'features.multi_agent=false', '-c', 'features.multi_agent_v2=true', '-c', 'features.goals=false',
    '-c', 'web_search="disabled"', '-c', 'features.plugins=false', '-c', 'features.apps=false', '-c', 'features.remote_plugin=false']);
  assert.deepEqual(f.sent.at(-1).params, {cwd: '/fixture/project', includeLayers: true});
  assert.deepEqual(Object.keys(f.owner).sort(), ['events', 'fenced', 'inspect', 'interrupt', 'openThread', 'runTurn', 'start', 'status', 'stop']);
  await assert.rejects(f.owner.runTurn('no thread yet'), /No bound root thread/);
  assert.throws(() => f.owner.start(), /already/);
  const stop = f.owner.stop(); f.close(); assert.equal((await stop).state, 'stopped');
  assert.equal(f.timers.every(timer => timer.cancelled), true);
});

test('UTF-8 frames split across chunks and multiple lines retain protocol meaning', async () => {
  const f = fixture({auto: false}); const start = f.owner.start();
  const bytes = Buffer.from('{"id":0,"result":{"userAgent":"é"}}\n{"method":"notice","params":{}}\n');
  const split = bytes.indexOf(0xc3) + 1;
  f.child.stdout.emit('data', bytes.subarray(0, split)); f.child.stdout.emit('data', bytes.subarray(split));
  await start;
  const inspection = f.owner.inspect();
  f.child.stdout.emit('data', Buffer.from('{"id":1,"result":{"config":{}}}\n'));
  assert.deepEqual(await inspection, {config: {}});
  const stop = f.owner.stop(); f.close(); await stop;
});

for (const [name, bytes] of [['invalid UTF8', Buffer.from([0xff])], ['malformed', Buffer.from('{bad}\n')], ['oversize', Buffer.alloc(257, 97)]]) {
  test(`${name} fences startup and keeps owner for cleanup`, async () => {
    const f = fixture({auto: false}); const start = f.owner.start(); const rejected = assert.rejects(start);
    f.child.stdout.emit('data', bytes); await rejected;
    await assert.rejects(f.owner.inspect()); assert.equal(f.spawnCount, 1);
    const stop = f.owner.stop(); f.close(); assert.equal((await stop).state, 'stopped');
  });
}

test('startup deadline settles blocked notification while stop retains unresolved writer ownership', async () => {
  const f = fixture({blocked: true}); const start = f.owner.start(); const rejected = assert.rejects(start);
  await reactions(); f.tick(); await rejected;
  const stop = f.owner.stop(); await reactions();
  assert.equal(f.child.ended, true);
  f.tick(); await reactions(); assert.deepEqual(f.signals, ['SIGTERM']);
  f.tick(); await reactions(); assert.deepEqual(f.signals, ['SIGTERM', 'SIGKILL']);
  f.tick(); await reactions(); assert.equal((await stop).state, 'unresolved');
  assert.equal(f.owner.stop(), stop); assert.throws(() => f.owner.start(), /already/);
  f.close(); assert.equal(f.owner.status().state, 'stopped');
  assert.equal((await stop).state, 'unresolved');
});

test('child error is not termination; diagnostics are bounded and closure needs streams', async () => {
  const f = fixture(); await f.owner.start();
  f.child.stderr.emit('data', Buffer.from('abcdefghijklmnop'));
  f.child.emit('error', Error('owned handle error'));
  assert.notEqual(f.owner.status().state, 'stopped');
  assert.equal(f.owner.status().diagnosticBytes, 8); assert.equal(f.owner.status().diagnosticsTruncated, true);
  const stop = f.owner.stop(); f.child.emit('close', 1, null);
  assert.notEqual(f.owner.status().state, 'stopped');
  for (const stream of [f.child.stdin, f.child.stdout, f.child.stderr]) stream.emit('close');
  assert.equal((await stop).state, 'stopped');
});

test('early child closure refuses startup and stop before start never launches', async () => {
  const f = fixture({auto: false}); const start = f.owner.start(); const rejected = assert.rejects(start);
  f.close(); await rejected; assert.equal((await f.owner.stop()).state, 'stopped');
  const idle = fixture(); const stop = idle.owner.stop(); assert.equal((await stop).state, 'stopped'); assert.equal(idle.spawnCount, 0);
  assert.throws(() => idle.owner.start(), /already|stopped/);
});


test('stream errors and incomplete UTF-8 fence pending requests without claiming closure', async () => {
  for (const kind of ['error', 'incomplete']) {
    const f = fixture({auto: false}); const start = f.owner.start(); const rejected = assert.rejects(start);
    if (kind === 'error') f.child.stdout.emit('error', Error('broken stream'));
    else { f.child.stdout.emit('data', Buffer.from([0xc3])); f.child.stdout.emit('end'); }
    await rejected;
    assert.equal(f.owner.status().state, 'unresolved');
    const stop = f.owner.stop(); f.close(); assert.equal((await stop).state, 'stopped');
    assert.equal(f.timers.every(timer => timer.cancelled), true);
  }
});

test('stop settles pending inspection before child closure and disposes observation timers', async () => {
  const f = fixture(); await f.owner.start();
  // Suppress the inspection response while retaining successful startup.
  f.child.stdin.write = (_line, callback) => callback();
  const inspection = f.owner.inspect(); const rejected = assert.rejects(inspection);
  const stop = f.owner.stop(); await rejected;
  assert.equal(f.owner.status().state, 'unresolved');
  f.close(); assert.equal((await stop).state, 'stopped');
  assert.equal(f.timers.every(timer => timer.cancelled), true);
});

test('trusted launch rejects arbitrary arguments and getters before spawning', () => {
  const valid = {executable: '/fixture/codex', executableSha256: HASH, cwd: '/fixture/project', env: {PATH: '/fixture/bin'}};
  assert.equal(typeof api.createControllerProcess(valid).start, 'function');
  for (const extra of [{args: ['--other']}, {selectedConfig: {}}, {shell: true}, {executableSha256: 'abc'}, {executableSha256: undefined},
    {onEvent: 'log'}, {maxEvents: 0}, {maxEventBytes: -1}, {turnTimeoutMs: 1.5}, {interruptGraceMs: 0}]) assert.throws(() => api.createControllerProcess({...valid, ...extra}));
  let reads = 0;
  const getter = Object.defineProperty({...valid}, 'cwd', {get() { reads++; return '/fixture/project'; }});
  assert.throws(() => api.createControllerProcess(getter)); assert.equal(reads, 0);
});

test('synchronous spawn failure retains owner and never retries', async () => {
  let calls = 0;
  const owner = api.createControllerProcess({executable: '/fixture/codex', executableSha256: HASH, cwd: '/fixture/project', env: {}}, {spawn() { calls++; throw Error('launch refused'); }});
  await assert.rejects(owner.start(), /launch refused/);
  assert.throws(() => owner.start(), /already/);
  assert.equal((await owner.stop()).state, 'stopped'); assert.equal(calls, 1);
});


test('complete stdout end settles inspection before stream or process closure', async () => {
  const f = fixture(); await f.owner.start();
  f.child.stdin.write = (_line, callback) => callback();
  const inspection = f.owner.inspect(); const rejected = assert.rejects(inspection);
  f.child.stdout.emit('end'); await rejected;
  assert.equal(f.owner.status().state, 'unresolved'); assert.equal(f.owner.status().processClosed, false);
  const stop = f.owner.stop(); f.close(); assert.equal((await stop).state, 'stopped');
});

test('writer callback failure fences further requests and preserves cleanup ownership', async () => {
  const f = fixture(); await f.owner.start();
  f.child.stdin.write = (_line, callback) => callback(Error('write refused'));
  await assert.rejects(f.owner.inspect()); assert.equal(f.owner.status().state, 'unresolved');
  await assert.rejects(f.owner.inspect(), /not ready/);
  const stop = f.owner.stop(); f.close(); assert.equal((await stop).state, 'stopped');
});

test('inspection has one bounded observation and timeout retains owned handle', async () => {
  const f = fixture(); await f.owner.start();
  f.child.stdin.write = (_line, callback) => callback();
  const inspection = f.owner.inspect(); const rejected = assert.rejects(inspection, error => error.code === 'uncertain');
  assert.equal(f.owner.inspect(), inspection);
  f.tick(); await rejected;
  assert.equal(f.owner.status().state, 'unresolved'); assert.equal(f.owner.status().processClosed, false);
  await assert.rejects(f.owner.inspect(), /not ready/);
  const stop = f.owner.stop(); f.close(); await stop;
  assert.equal(f.timers.every(timer => timer.cancelled), true);
});
