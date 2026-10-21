import test, {beforeEach} from 'node:test';
import assert from 'node:assert/strict';
const api = await import('./native-request-binding.mjs').catch(error => { if (error.code === 'ERR_MODULE_NOT_FOUND') return {}; throw error; });
beforeEach(() => assert.equal(typeof api.createNativeRequestBinding, 'function'));
const assignment = () => ({id: 'assignment-1', task: 'T31', run: 'R227', actor: 'actor-1', role: 'implementer', lead: 'lead-1', worktree: '/fixture/worktree', admissionGeneration: 'admission-1'});
function strict(args) {
  assert.deepEqual(Object.keys(args).sort(), ['operation', 'value']);
  assert.equal(args.operation, 'fixture-read'); assert.equal(typeof args.value, 'string');
  return {operation: args.operation, value: args.value};
}
const options = extra => ({connectionGeneration: 'connection-1', threadId: 'thread-1', turnId: 'turn-1', assignment: assignment(), namespace: 'sage_fixture', tool: 'request', validateArguments: strict, ...extra});
const event = (callId = 'call-1', extra = {}) => ({id: '', msg: {type: 'dynamic_tool_call_request', callId, turnId: 'turn-1', startedAtMs: 123, namespace: 'sage_fixture', tool: 'request', arguments: {operation: 'fixture-read', value: 'sample'}, ...extra}});
const stage = (binding, value) => binding.stage(JSON.stringify(value), 'connection-1');

test('exact native shape stages immutable data without granting authority', () => {
  const received = [], binding = api.createNativeRequestBinding(options());
  received.push(stage(binding, event()));
  assert.deepEqual(received, [{version: 1, connectionGeneration: 'connection-1', threadId: 'thread-1', turnId: 'turn-1', assignment: assignment(), eventId: '', callId: 'call-1', startedAtMs: 123, namespace: 'sage_fixture', tool: 'request', arguments: {operation: 'fixture-read', value: 'sample'}}]);
  assert.deepEqual(Object.keys(binding).sort(), ['close', 'stage']);
  assert.throws(() => { received[0].arguments.value = 'changed'; }, TypeError);
});

test('wrong generation cannot burn current call identity; wrong turn and tool cannot reach downstream', () => {
  const binding = api.createNativeRequestBinding(options()), received = [];
  assert.throws(() => binding.stage(JSON.stringify(event()), 'stale'));
  received.push(stage(binding, event()));
  for (const extra of [{turnId: 'foreign'}, {namespace: 'other'}, {tool: 'other'}]) assert.throws(() => received.push(stage(binding, event(JSON.stringify(extra), extra))));
  assert.equal(received.length, 1);
  received.push(stage(binding, event('next'))); assert.equal(received.length, 2);
});

test('forged identities and malformed envelopes refuse before fake downstream', () => {
  const received = [], binding = api.createNativeRequestBinding(options());
  const invalid = [ {...event('extra'), threadId: 'forged'}, event('msg-extra', {actor: 'forged'}), {id: 'x', msg: {callId: 'missing'}}, event('wrongtype', {type: 'other'}), event('fraction', {startedAtMs: 1.5}), event('nullargs', {arguments: null}), event('arrayargs', {arguments: []}) ];
  for (const value of invalid) assert.throws(() => received.push(stage(binding, value)));
  for (const key of ['actor', 'task', 'threadId', 'cwd', 'role']) assert.throws(() => received.push(stage(binding, event(key, {arguments: {operation: 'fixture-read', value: 'sample', [key]: 'forged'}}))));
  assert.equal(received.length, 0); received.push(stage(binding, event('valid'))); assert.equal(received[0].assignment.actor, 'actor-1');
});

test('identified invalid and throwing calls remain consumed while distinct calls succeed', () => {
  const binding = api.createNativeRequestBinding(options());
  assert.throws(() => stage(binding, event('invalid', {turnId: 'wrong'})));
  assert.throws(() => stage(binding, event('invalid')));
  assert.throws(() => stage(binding, event('throw', {arguments: {}})));
  assert.throws(() => stage(binding, event('throw')));
  assert.equal(stage(binding, event('good')).callId, 'good');
  assert.throws(() => stage(binding, event('good')));
});

test('wire boundary requires strings and exact arguments without invoking accessors', () => {
  const binding = api.createNativeRequestBinding(options()); let reads = 0;
  const object = Object.defineProperty({}, 'msg', {get() { reads++; return {}; }});
  for (const value of [object, Buffer.from('{}'), undefined, 3]) assert.throws(() => binding.stage(value, 'connection-1'));
  assert.equal(reads, 0);
  assert.throws(() => binding.stage('{', 'connection-1'));
  assert.throws(() => binding.stage('{"id":"x","msg":{"callId":"infinite","startedAtMs":1e999}}', 'connection-1'));
  assert.throws(() => binding.stage(JSON.stringify(event()), 'connection-1', 'extra'));
  assert.equal(stage(binding, event()).eventId, '');
});

test('caller context and validator output cannot change staged data', () => {
  const context = assignment(), output = {nested: {value: 'typed'}};
  const binding = api.createNativeRequestBinding(options({assignment: context, validateArguments(args) { assert.equal(Object.isFrozen(args), true); return output; }}));
  context.actor = 'changed';
  const staged = stage(binding, event()); output.nested.value = 'changed';
  assert.equal(staged.assignment.actor, 'actor-1'); assert.deepEqual(staged.arguments, {nested: {value: 'typed'}});
  assert.throws(() => { staged.assignment.actor = 'changed'; }, TypeError);
});

test('constructor and validator output reject accessors, prototypes, cycles and invalid data', () => {
  let reads = 0;
  const getter = Object.defineProperty(assignment(), 'actor', {enumerable: true, get() { reads++; return 'forged'; }});
  assert.throws(() => api.createNativeRequestBinding(options({assignment: getter})));
  assert.throws(() => api.createNativeRequestBinding(options({assignment: Object.create(assignment())})));
  assert.throws(() => api.createNativeRequestBinding(options({validateArguments: undefined})));
  const cycle = {}; cycle.self = cycle;
  for (const output of [undefined, true, Infinity, {value: NaN}, cycle, new Date(), Object.defineProperty({}, 'x', {enumerable: true, get() { reads++; return 'x'; }})]) {
    const binding = api.createNativeRequestBinding(options({validateArguments: () => output})); assert.throws(() => stage(binding, event()));
  }
  assert.equal(reads, 0);
  assert.equal(stage(api.createNativeRequestBinding(options()), event()).arguments.value, 'sample');
});

test('reentrant validation cannot stage and close during validation invalidates outer result', () => {
  let binding, calls = 0;
  binding = api.createNativeRequestBinding(options({validateArguments(args) { calls++; assert.throws(() => stage(binding, event('inner'))); return strict(args); }}));
  assert.equal(stage(binding, event()).callId, 'call-1'); assert.equal(calls, 1);
  let closing;
  closing = api.createNativeRequestBinding(options({validateArguments(args) { closing.close(); return strict(args); }}));
  assert.throws(() => stage(closing, event())); closing.close(); assert.throws(() => stage(closing, event('next')));
});

test('async validators and invalid asynchronous output refuse under the synchronous contract', async () => {
  let invoked = 0, thenCalls = 0;
  assert.throws(() => api.createNativeRequestBinding(options({validateArguments: async () => { invoked++; return {}; }})));
  assert.equal(invoked, 0);
  for (const make of [() => { const output = Promise.reject(Error('test-owned rejection')); output.catch(() => {}); return output; }, () => ({then() { thenCalls++; }}), () => Object.defineProperty({}, 'then', {get() { thenCalls++; return () => {}; }})]) {
    const binding = api.createNativeRequestBinding(options({validateArguments: make})); assert.throws(() => stage(binding, event()));
  }
  await Promise.resolve(); assert.equal(thenCalls, 0);
});

test('byte, depth and consumed-call bounds refuse without evicting replay history', () => {
  const binding = api.createNativeRequestBinding(options());
  assert.throws(() => binding.stage(' '.repeat(1024 * 1024 + 1), 'connection-1'));
  let deep = {}; for (let i = 0; i < 65; i++) deep = {nested: deep};
  assert.throws(() => stage(binding, event('deep', {arguments: deep})));
  assert.throws(() => stage(binding, event('deep')));
  assert.equal(stage(binding, event('valid')).callId, 'valid');
  const full = api.createNativeRequestBinding(options());
  for (let i = 0; i < 1024; i++) assert.equal(stage(full, event(String(i))).callId, String(i));
  assert.throws(() => stage(full, event('overflow'))); assert.throws(() => stage(full, event('new')));
  assert.throws(() => stage(full, event('0')));
});


test('retained identity bytes are capped independently of request bytes', () => {
  const binding = api.createNativeRequestBinding(options());
  assert.throws(() => stage(binding, event('x'.repeat(4097))), /byte limit/);
  assert.throws(() => stage(binding, event('next')), /closed/);
  assert.throws(() => api.createNativeRequestBinding(options({threadId: 'x'.repeat(4097)})));
  const valid = api.createNativeRequestBinding(options());
  assert.equal(stage(valid, event('x'.repeat(4096))).callId.length, 4096);
});


test('canonical chief role permits null lead and oversized typed strings refuse before delivery', () => {
  const chief = {...assignment(), role: 'chief-of-staff', lead: null};
  assert.equal(stage(api.createNativeRequestBinding(options({assignment: chief})), event()).assignment.role, 'chief-of-staff');
  assert.throws(() => api.createNativeRequestBinding(options({assignment: {...chief, role: 'chief'}})));
  const received = [];
  const oversized = api.createNativeRequestBinding(options({validateArguments: () => ({value: 'x'.repeat(1024 * 1024 + 1)})}));
  assert.throws(() => received.push(stage(oversized, event())), /byte budget/);
  assert.equal(received.length, 0);
  received.push(stage(api.createNativeRequestBinding(options()), event()));
  assert.equal(received[0].arguments.value, 'sample');
});


test('Promise refusal does not read own constructor accessors on test-owned fixtures', () => {
  for (const rejected of [false, true]) {
    const output = rejected ? Promise.reject(Error('test-owned rejection')) : Promise.resolve('sample');
    // The test owns this rejection before it installs hostile properties.
    output.catch(() => {});
    let reads = 0;
    Object.defineProperty(output, 'constructor', {get() { reads++; throw Error('constructor hook'); }});
    const binding = api.createNativeRequestBinding(options({validateArguments: () => output}));
    const delivered = [];
    assert.throws(() => delivered.push(stage(binding, event())));
    assert.equal(reads, 0); assert.equal(delivered.length, 0);
  }
});

test('Promise refusal does not read subclass species on test-owned fixtures', () => {
  for (const rejected of [false, true]) {
    class FixturePromise extends Promise {}
    const output = rejected ? FixturePromise.reject(Error('test-owned subclass rejection')) : FixturePromise.resolve('sample');
    // Attach the fixture handler before making species hostile.
    output.catch(() => {});
    let reads = 0;
    Object.defineProperty(FixturePromise, Symbol.species, {get() { reads++; throw Error('species hook'); }});
    const binding = api.createNativeRequestBinding(options({validateArguments: () => output}));
    const delivered = [];
    assert.throws(() => delivered.push(stage(binding, event())));
    assert.equal(reads, 0); assert.equal(delivered.length, 0);
  }
});
