import {types} from 'node:util';

const MAX_BYTES = 1024 * 1024;
const MAX_DEPTH = 64;
const MAX_CALLS = 1024;
const MAX_ID_BYTES = 4096;
const identity = value => nonempty(value) && Buffer.byteLength(value) <= MAX_ID_BYTES;
const nonempty = value => typeof value === 'string' && value.length > 0;
function record(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError('Expected a plain object');
  return value;
}
function fields(value, required) {
  record(value);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== required.length || keys.some(key => !required.includes(key))) throw new TypeError('Unexpected or missing fields');
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor.enumerable || !('value' in descriptor)) throw new TypeError('Expected data fields');
  }
}
function snapshot(value) {
  // Check depth iteratively before recursive copying. Accessors never supply data.
  const active = new Set();
  const stack = [{value, depth: 0}];
  let budget = 0;
  while (stack.length) {
    const entry = stack.pop(), item = entry.value;
    if (entry.exit) { active.delete(item); continue; }
    budget += 1;
    if (budget > MAX_BYTES) throw new TypeError('JSON data exceeds byte budget');
    if (item === null || typeof item === 'boolean') continue;
    if (typeof item === 'string') {
      budget += Buffer.byteLength(item);
      if (budget > MAX_BYTES) throw new TypeError('JSON data exceeds byte budget');
      continue;
    }
    if (typeof item === 'number' && Number.isFinite(item)) continue;
    if (!item || typeof item !== 'object') throw new TypeError('Expected JSON data');
    if (entry.depth >= MAX_DEPTH || active.has(item)) throw new TypeError('JSON depth or cycle limit');
    const array = Array.isArray(item);
    if (array ? Object.getPrototypeOf(item) !== Array.prototype : ![Object.prototype, null].includes(Object.getPrototypeOf(item))) throw new TypeError('Expected plain JSON data');
    active.add(item); stack.push({value: item, exit: true});
    const keys = Reflect.ownKeys(item).filter(key => !(array && key === 'length'));
    if (array && keys.length !== item.length) throw new TypeError('Expected dense array');
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (typeof key !== 'string' || !descriptor.enumerable || !('value' in descriptor)) throw new TypeError('Expected JSON data properties');
      if (array && !/^(0|[1-9][0-9]*)$/.test(key)) throw new TypeError('Invalid array property');
      budget += Buffer.byteLength(key);
      if (budget > MAX_BYTES) throw new TypeError('JSON data exceeds byte budget');
      stack.push({value: descriptor.value, depth: entry.depth + 1});
    }
  }
  function copy(item) {
    if (!item || typeof item !== 'object') return item;
    return Object.freeze(Array.isArray(item) ? item.map(copy) : Object.fromEntries(Object.entries(item).map(([key, data]) => [key, copy(data)])));
  }
  const result = copy(value);
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_BYTES) throw new TypeError('JSON data exceeds byte limit');
  return result;
}

/** Stages data only. The trusted caller supplies identities; this grants no authority. */
export function createNativeRequestBinding(options) {
  fields(options, ['connectionGeneration', 'threadId', 'turnId', 'assignment', 'namespace', 'tool', 'validateArguments']);
  const {connectionGeneration, threadId, turnId, namespace, tool, validateArguments} = options;
  if (![connectionGeneration, threadId, turnId, namespace, tool].every(identity)) throw new TypeError('Binding identities must be nonempty strings');
  if (typeof validateArguments !== 'function' || types.isAsyncFunction(validateArguments) || types.isGeneratorFunction(validateArguments)) throw new TypeError('A synchronous argument validator is required');
  const assignment = snapshot(options.assignment);
  fields(assignment, ['id', 'task', 'run', 'actor', 'role', 'lead', 'worktree', 'admissionGeneration']);
  if (!['id', 'task', 'run', 'actor', 'role', 'worktree', 'admissionGeneration'].every(key => identity(assignment[key])) || !(identity(assignment.lead) || (assignment.lead === null && assignment.role === 'chief-of-staff'))) throw new TypeError('Invalid trusted assignment');
  let closed = false, validating = false;
  const calls = new Set();
  function close() { closed = true; }
  function stage(...args) {
    if (closed || validating) throw new Error('Binding closed or validating');
    if (args.length !== 2 || typeof args[0] !== 'string') throw new TypeError('Expected event JSON and source generation');
    const [eventJson, sourceGeneration] = args;
    if (sourceGeneration !== connectionGeneration) throw new Error('Foreign connection generation');
    if (Buffer.byteLength(eventJson) > MAX_BYTES) throw new TypeError('Event byte limit exceeded');
    const event = JSON.parse(eventJson);
    const callId = event?.msg?.callId;
    if (!nonempty(callId)) throw new TypeError('Missing call ID');
    if (!identity(callId)) { close(); throw new Error('Call ID byte limit exceeded; binding closed'); }
    if (calls.has(callId)) throw new Error('Consumed call ID');
    if (calls.size === MAX_CALLS) { close(); throw new Error('Call capacity exhausted; binding closed'); }
    calls.add(callId);
    fields(event, ['id', 'msg']);
    fields(event.msg, ['type', 'callId', 'turnId', 'startedAtMs', 'namespace', 'tool', 'arguments']);
    const msg = event.msg;
    if (typeof event.id !== 'string' || msg.type !== 'dynamic_tool_call_request' || msg.turnId !== turnId || msg.namespace !== namespace || msg.tool !== tool || !Number.isSafeInteger(msg.startedAtMs)) throw new TypeError('Native request does not match binding');
    const input = snapshot(record(msg.arguments));
    validating = true;
    try {
      const output = validateArguments(input);
      if (types.isPromise(output)) {
        // Trusted synchronous validators own any asynchronous work they create.
        // Do not observe invalid output through constructor/then/species hooks.
        throw new TypeError('Argument validation must be synchronous');
      }
      const typed = snapshot(record(output));
      if (closed) throw new Error('Binding closed during validation');
      return Object.freeze({version: 1, connectionGeneration, threadId, turnId, assignment,
        eventId: event.id, callId, startedAtMs: msg.startedAtMs, namespace, tool, arguments: typed});
    } finally { validating = false; }
  }
  return Object.freeze({stage, close});
}
