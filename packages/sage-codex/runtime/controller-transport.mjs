import {isAbsolute} from 'node:path';

// The owned launch profile. These are launch requirements; bindPolicy checks that the process applied them.
// The owner's hooks stay as configured (owner decision Q3, 2026-10-24).
export const OWNED_CONTROLLER_CONFIG = Object.freeze({
  'agents.enabled': true,
  'features.multi_agent': false,
  'features.multi_agent_v2': true,
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
export const INSTRUCTION_BYTES = 256 * 1024;
export const validText = (value, limit) => nonempty(value) && !value.includes('\0') && Buffer.byteLength(value) <= limit;
function uncertain(reason) { return Object.assign(new Error(`Connection closed; outcome uncertain: ${reason}`), {code: 'uncertain'}); }

/** Owns one already-established connection. It never sends a model, provider, approval, sandbox or tool selection. */
export function createControllerTransport({generation, send, initialRequestId = 0, inspectionCwd}) {
  if (!nonempty(generation) || typeof send !== 'function' || !validId(initialRequestId)) throw new TypeError('Invalid connection configuration');
  if (inspectionCwd !== undefined && (!nonempty(inspectionCwd) || !isAbsolute(inspectionCwd))) throw new TypeError('Invalid inspection cwd');
  const pending = new Map();
  // The ids of the server requests that wait for one reply.
  const serverRequests = new Set();
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
    const input = object(params, ['cwd', 'ephemeral', 'developerInstructions']);
    if (owns(input, 'cwd') && !nonempty(input.cwd)) throw new TypeError('Invalid cwd');
    if (owns(input, 'ephemeral') && typeof input.ephemeral !== 'boolean') throw new TypeError('Invalid ephemeral flag');
    if (owns(input, 'developerInstructions') && !validText(input.developerInstructions, INSTRUCTION_BYTES)) throw new TypeError('Invalid developer instructions');
    // No environments key: an empty list disables the tools, so the thread keeps the default environment under the
    // owner's own sandbox and approval setting (owner decision Q1, 2026-10-24).
    return request('thread/start', input);
  }
  function startTurn(params) {
    requireReady();
    const input = object(params, ['threadId', 'input']);
    if (!nonempty(input.threadId) || !Array.isArray(input.input)) throw new TypeError('Invalid turn input');
    for (const item of input.input) {
      object(item, ['type', 'text']);
      if (item.type !== 'text' || typeof item.text !== 'string') throw new TypeError('Only text input is supported');
    }
    return request('turn/start', input);
  }
  function interruptTurn(params) {
    requireReady();
    const input = object(params, ['threadId', 'turnId']);
    if (!nonempty(input.threadId) || !nonempty(input.turnId)) throw new TypeError('Invalid interrupt target');
    return request('turn/interrupt', input);
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
          if (!validId(message.id) || serverRequests.has(message.id)) throw new Error('Invalid server request ID');
          serverRequests.add(message.id);
          return Object.freeze({kind: 'server-request', method: message.method, request: message});
        }
        // The controller closed a request (its turn ended, or it took a reply): no later reply goes out for it.
        if (message.method === 'serverRequest/resolved') serverRequests.delete(message.params?.requestId);
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
  /** Replies once to a server request that waits. Returns false when the request does not wait or the connection is closed. */
  function reply(id, message) {
    if (closed || !serverRequests.delete(id)) return false;
    transmit({id, ...message});
    return !closed;
  }
  const answer = (id, result) => reply(id, {result});
  // The controller reads an error reply as a refusal (a decline).
  const refuse = id => reply(id, {error: {code: -32601, message: 'Controller transport does not handle this server request'}});
  return Object.freeze({initialize, startThread, startTurn, interruptTurn, readConfiguration, receive, answer, refuse, disconnect});
}
