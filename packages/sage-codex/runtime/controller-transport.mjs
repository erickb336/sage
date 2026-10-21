import {isAbsolute} from 'node:path';

// These are launch requirements, not evidence that an external process applied them.
export const REQUIRED_CONTROLLER_CONFIG = Object.freeze({
  'agents.enabled': false,
  'features.multi_agent': false,
  'features.multi_agent_v2': false,
  'features.goals': false,
  web_search: 'disabled',
  'features.plugins': false,
  'features.apps': false,
  'features.remote_plugin': false,
});

function snapshot(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object' || seen.has(value)) throw new TypeError('Expected acyclic JSON data');
  const array = Array.isArray(value);
  if (array && Object.getPrototypeOf(value) !== Array.prototype) throw new TypeError('Expected a JSON array');
  if (!array && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new TypeError('Expected a JSON object');
  seen.add(value);
  const copy = array ? [] : Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (array && key === 'length') continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !descriptor.enumerable || !('value' in descriptor)) throw new TypeError('Expected JSON data properties');
    if (array && !/^(0|[1-9][0-9]*)$/.test(key)) throw new TypeError('Expected JSON array indices');
    Object.defineProperty(copy, key, {value: snapshot(descriptor.value, seen), enumerable: true});
  }
  if (array && Object.keys(copy).length !== value.length) throw new TypeError('Expected a dense JSON array');
  seen.delete(value);
  // Return ordinary JSON objects while retaining own __proto__ as data.
  return Object.freeze(array ? copy : Object.fromEntries(Object.entries(copy)));
}
function object(value, allowed) {
  const result = snapshot(value);
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new TypeError('Expected parameters');
  if (Object.keys(result).some(key => !allowed.includes(key))) throw new TypeError('Unsupported parameter');
  return result;
}
const nonempty = value => typeof value === 'string' && value.length > 0;
const validId = value => typeof value === 'string' || Number.isSafeInteger(value);
const owns = (value, key) => Object.hasOwn(value, key);
function uncertain(reason) { return Object.assign(new Error(`Connection closed; outcome uncertain: ${reason}`), {code: 'uncertain'}); }

/** Owns one already-established connection. No spawning, effects or task acceptance. */
export function createControllerTransport({generation, send, profile = {}, initialRequestId = 0, inspectionCwd}) {
  if (!nonempty(generation) || typeof send !== 'function' || !validId(initialRequestId)) throw new TypeError('Invalid connection configuration');
  if (inspectionCwd !== undefined && (!nonempty(inspectionCwd) || !isAbsolute(inspectionCwd))) throw new TypeError('Invalid inspection cwd');
  const selected = object(profile, ['model', 'approvalPolicy', 'sandbox']);
  if (owns(selected, 'model') && !nonempty(selected.model)) throw new TypeError('Invalid model');
  if (owns(selected, 'approvalPolicy') && !['untrusted', 'on-failure', 'on-request', 'never'].includes(selected.approvalPolicy)) throw new TypeError('Invalid approval policy');
  if (owns(selected, 'sandbox') && !['read-only', 'workspace-write', 'danger-full-access'].includes(selected.sandbox)) throw new TypeError('Invalid sandbox');
  const pending = new Map();
  let resolveClosed;
  const connectionClosed = new Promise(resolve => { resolveClosed = resolve; });
  let closed = false, initializing = false, initialized = false;
  let nextId = initialRequestId;
  function disconnect(reason = 'disconnected') {
    closed = true;
    const error = uncertain(String(reason));
    resolveClosed(error);
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
  }
  function transmit(message) {
    try {
      const completion = send(snapshot(message));
      return Promise.resolve(completion).catch(error => { disconnect(error?.message ?? 'send failed'); });
    } catch (error) { disconnect(error?.message ?? 'send failed'); }
  }
  function request(method, params) {
    if (closed) throw uncertain('closed');
    const id = nextId;
    nextId = typeof id === 'string' ? 0 : id + 1;
    if (!validId(nextId)) throw new Error('Request ID range exhausted');
    const message = snapshot({id, method, params});
    return new Promise((resolve, reject) => {
      pending.set(id, {resolve, reject});
      transmit(message);
    });
  }
  function requireReady() {
    if (closed) throw uncertain('closed');
    if (!initialized) throw new Error('Connection not initialized');
  }
  async function initialize() {
    if (initializing || initialized) throw new Error('Initialization already requested');
    initializing = true;
    const result = await request('initialize', {clientInfo: {name: 'sage_controller', version: '0.1.0'}, capabilities: {experimentalApi: true}});
    if (closed) throw uncertain('closed during initialization');
    await Promise.race([
      transmit({method: 'initialized'}),
      connectionClosed.then(error => { throw error; }),
    ]);
    if (closed) throw uncertain('initialized notification failed');
    initialized = true;
    return result;
  }
  function readConfiguration(...args) {
    requireReady();
    if (args.length || inspectionCwd === undefined) throw new Error('Fixed inspection cwd required; no arguments allowed');
    return request('config/read', {cwd: inspectionCwd, includeLayers: true});
  }
  function startThread(params = {}) {
    requireReady();
    const input = object(params, ['cwd', 'ephemeral']);
    if (owns(input, 'cwd') && !nonempty(input.cwd)) throw new TypeError('Invalid cwd');
    if (owns(input, 'ephemeral') && typeof input.ephemeral !== 'boolean') throw new TypeError('Invalid ephemeral flag');
    return request('thread/start', {...selected, ...input, environments: []});
  }
  function resumeThread(params) {
    requireReady();
    const input = object(params, ['threadId']);
    if (!nonempty(input.threadId)) throw new TypeError('Invalid thread ID');
    return request('thread/resume', {...selected, ...input});
  }
  function startTurn(params) {
    requireReady();
    const input = object(params, ['threadId', 'input']);
    if (!nonempty(input.threadId) || !Array.isArray(input.input)) throw new TypeError('Invalid turn input');
    for (const item of input.input) {
      object(item, ['type', 'text']);
      if (item.type !== 'text' || typeof item.text !== 'string') throw new TypeError('Only text input is supported');
    }
    return request('turn/start', {...input, environments: []});
  }
  function receive(raw, sourceGeneration) {
    try {
      if (closed || sourceGeneration !== generation) throw new Error('Closed or stale connection');
      const message = snapshot(typeof raw === 'string' ? JSON.parse(raw) : raw);
      if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('Malformed message');
      if (owns(message, 'method')) {
        object(message, owns(message, 'id') ? ['method', 'params', 'id'] : ['method', 'params', 'emittedAtMs']);
        if (owns(message, 'emittedAtMs') && !Number.isSafeInteger(message.emittedAtMs)) throw new Error('Invalid notification timestamp');
        if (!nonempty(message.method) || (owns(message, 'params') && (!message.params || typeof message.params !== 'object' || Array.isArray(message.params)))) throw new Error('Malformed method message');
        if (owns(message, 'id')) {
          if (!validId(message.id)) throw new Error('Invalid server request ID');
          transmit({id: message.id, error: {code: -32601, message: 'Controller transport does not handle server requests'}});
          if (closed) throw new Error('Server refusal send failed');
          return Object.freeze({kind: 'server-request-refused'});
        }
        return Object.freeze({kind: 'observation', notification: message});
      }
      object(message, ['id', 'result', 'error']);
      if (!owns(message, 'id') || !validId(message.id) || owns(message, 'result') === owns(message, 'error')) throw new Error('Malformed reply');
      if (owns(message, 'error')) {
        const error = object(message.error, ['code', 'message', 'data']);
        if (!Number.isInteger(error.code) || typeof error.message !== 'string') throw new Error('Malformed RPC error');
      }
      const entry = pending.get(message.id);
      if (!entry) throw new Error('Unknown or duplicate reply');
      pending.delete(message.id);
      if (owns(message, 'error')) entry.reject(Object.assign(new Error(message.error.message), {code: 'refused', rpcError: message.error}));
      else entry.resolve(message.result);
      return Object.freeze({kind: 'reply'});
    } catch (error) {
      disconnect(error.message);
      throw uncertain(error.message);
    }
  }
  return Object.freeze({initialize, startThread, resumeThread, startTurn, readConfiguration, receive, disconnect});
}
