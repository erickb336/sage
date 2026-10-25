import {spawn as nativeSpawn} from 'node:child_process';
import {realpathSync} from 'node:fs';
import {isAbsolute} from 'node:path';
import {createControllerTransport, OWNED_CONTROLLER_CONFIG} from './controller-transport.mjs';
import {bindPolicy, bindTask, bindTurnText, checkConfig, codexHome, projectTrustFlags, turnOutcome} from './controller-binding.mjs';

// Limits bound one wire frame and retained stderr bytes, not total process output.
// One frame can hold one whole agent message, so the frame bound is the event bound of a turn (maxEventBytes).
const DEFAULT_FRAME_BYTES = 64 * 1024 * 1024;
const DEFAULT_DIAGNOSTIC_BYTES = 16 * 1024;
function positive(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`Invalid ${name}`);
  return value;
}
// The streamed pieces of one item, such as item/agentMessage/delta and item/commandExecution/outputDelta.
const DELTA = /^item\/.+(\/d|D)elta$/;
export const defaultSchedule = (callback, delay) => { const timer = setTimeout(callback, delay); return () => clearTimeout(timer); };
export const OWNED_LAUNCH_ARGS = Object.freeze(['app-server', '--stdio', '--owned-controller', '--strict-config',
  ...Object.entries(OWNED_CONTROLLER_CONFIG).flatMap(([key, value]) => ['-c', `${key}=${JSON.stringify(value)}`])]);

/**
 * Trusted launch inputs only. One process launches the owned controller entry, binds one task to one root thread
 * after the policy check, and runs one turn at a time. It keeps every notification and refused server request, and
 * gives each turn an honest terminal result: EOF, a crash, a fence or a timeout never count as completed.
 */
export function createControllerProcess(options, {spawn = nativeSpawn, schedule = defaultSchedule} = {}) {
  if (!options || Object.getPrototypeOf(options) !== Object.prototype) throw new TypeError('Trusted launch options required');
  const allowed = ['executable', 'executableSha256', 'cwd', 'env', 'startupTimeoutMs', 'inspectionTimeoutMs', 'stopGraceMs', 'maxFrameBytes', 'maxDiagnosticBytes',
    'turnTimeoutMs', 'interruptGraceMs', 'maxEvents', 'maxDeltaEvents', 'maxEventBytes', 'onEvent'];
  for (const key of Reflect.ownKeys(options)) {
    const descriptor = Object.getOwnPropertyDescriptor(options, key);
    if (!allowed.includes(key) || !('value' in descriptor)) throw new TypeError('Unsupported launch option');
  }
  const {executable, executableSha256, cwd, env, startupTimeoutMs = 10000, inspectionTimeoutMs = 10000, stopGraceMs = 1000,
    maxFrameBytes = DEFAULT_FRAME_BYTES, maxDiagnosticBytes = DEFAULT_DIAGNOSTIC_BYTES,
    turnTimeoutMs = 2 * 60 * 60 * 1000, interruptGraceMs = 10000, maxEvents = 20000, maxDeltaEvents = 1000000, maxEventBytes = 64 * 1024 * 1024, onEvent} = options;
  if (typeof executable !== 'string' || !isAbsolute(executable) || typeof cwd !== 'string' || !isAbsolute(cwd)) throw new TypeError('Trusted absolute executable and canonical cwd required');
  if (typeof executableSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(executableSha256)) throw new TypeError('Executable sha256 required');
  if (onEvent !== undefined && typeof onEvent !== 'function') throw new TypeError('Invalid event callback');
  if (!env || Object.getPrototypeOf(env) !== Object.prototype) throw new TypeError('Explicit trusted environment required');
  const environment = {};
  for (const key of Reflect.ownKeys(env)) {
    const descriptor = Object.getOwnPropertyDescriptor(env, key);
    if (typeof key !== 'string' || !('value' in descriptor) || typeof descriptor.value !== 'string') throw new TypeError('Environment must contain string data');
    Object.defineProperty(environment, key, {value: descriptor.value, enumerable: true});
  }
  Object.freeze(environment);
  for (const [name, value] of Object.entries({startupTimeoutMs, inspectionTimeoutMs, stopGraceMs, maxFrameBytes, maxDiagnosticBytes,
    turnTimeoutMs, interruptGraceMs, maxEvents, maxDeltaEvents, maxEventBytes})) positive(value, name);
  if (typeof spawn !== 'function' || typeof schedule !== 'function') throw new TypeError('Invalid process dependencies');
  // The controller loads no project layer of the cwd (projectTrustFlags); the binding record keeps these arguments.
  const launchArgs = Object.freeze([...OWNED_LAUNCH_ARGS, ...projectTrustFlags(cwd)]);
  let child, connection, attempted = false, fenced = false, fenceReason = null, childClosed = false, exitCode = null, exitSignal = null;
  let phase = 'idle', stopPromise, inspectionPromise, diagnosticBytes = 0, diagnosticsTruncated = false;
  let initialized = null, threadRequested = false, binding = null, turn = null;
  const streamClosures = new Set(), observations = new Set(), signals = [], events = [], settledTurns = new Set();
  // The event limits count from the start of the current turn, so a long session never reaches them.
  let windowEvents = 0, windowDeltas = 0, windowBytes = 0, sequence = 0;
  let resolveFenced;
  const fencedPromise = new Promise(resolve => { resolveFenced = resolve; });
  // The bytes of the frame that is not complete yet. Only its count is kept: a copy of each piece would cost the
  // square of a large frame.
  let frameBytes = 0;
  const decoder = new TextDecoder('utf-8', {fatal: true});
  let text = '';
  function status() {
    return Object.freeze({state: phase, processClosed: childClosed, streamsClosed: streamClosures.size === 3,
      exitCode, exitSignal, reason: fenceReason, diagnosticBytes, diagnosticsTruncated, signals: Object.freeze([...signals])});
  }
  function terminal() { return childClosed && streamClosures.size === 3; }
  function notify() {
    if (terminal()) phase = 'stopped';
    for (const observe of [...observations]) observe();
  }
  function fence(reason) {
    fenced = true;
    fenceReason ??= reason;
    resolveFenced(fenceReason);
    connection?.disconnect(reason);
    if (!terminal()) phase = 'unresolved';
    if (turn) { advance(turn, {type: 'lost', reason: fenceReason}); settle(); }
  }
  function waitBounded(milliseconds) {
    if (terminal()) return Promise.resolve(true);
    return new Promise(resolve => {
      let done = false;
      const finish = value => { if (done) return; done = true; cancel(); observations.delete(observe); resolve(value); };
      const observe = () => { if (terminal()) finish(true); };
      let cancel = () => {};
      observations.add(observe);
      cancel = schedule(() => finish(false), milliseconds);
      observe();
    });
  }
  /** Races one request with a deadline; at the deadline the process fences and the result is uncertain. */
  async function bounded(promise, milliseconds, reason) {
    let cancel;
    const deadline = new Promise((_, reject) => {
      // Reject first, so that the race gives this reason and not the closed connection that the fence causes.
      cancel = schedule(() => { reject(Object.assign(new Error(`${reason}; outcome uncertain`), {code: 'uncertain'})); fence(reason); }, milliseconds);
    });
    try { return await Promise.race([promise, deadline]); } finally { cancel(); }
  }
  function advance(current, message) { current.state = turnOutcome(current.state, message); }
  // Decide only after a whole read, so that conflicting terminals in one read give uncertain.
  function settle() {
    if (!turn?.state.result) return;
    const current = turn;
    turn = null;
    for (const cancel of current.cancels) cancel();
    if (current.state.result === 'uncertain' && !fenced) fence('Turn outcome uncertain');
    const {result, turnId, lastAgentMessage, error, timedOut} = current.state;
    if (turnId) settledTurns.add(turnId);
    current.resolve(Object.freeze({state: result, task: binding.task, run: binding.run, threadId: binding.threadId, turnId,
      bindingHash: binding.bindingHash, inputSha256: current.inputSha256, lastAgentMessage, error, timedOut,
      eventCount: sequence, status: status()}));
  }
  function observe(received, bytes) {
    if (received.kind === 'reply') return;
    const notification = received.kind === 'observation';
    const message = notification ? received.notification : received.request;
    const params = message.params;
    // A streamed piece (a delta), a new copy of the whole diff (turn/diff/updated, after each patch) and each event of
    // another thread than the bound root (a child agent) can pass 64 MiB in one long valid turn (R1580-1). With an
    // onEvent handler, events() does not keep them, so they cost no memory: only maxDeltaEvents counts them.
    // maxEvents and maxEventBytes bound the events that events() keeps.
    const passed = notification && (DELTA.test(message.method) || message.method === 'turn/diff/updated'
      || (binding !== null && typeof params?.threadId === 'string' && params.threadId !== binding.threadId));
    if (passed ? windowDeltas >= maxDeltaEvents : windowEvents >= maxEvents || windowBytes + bytes > maxEventBytes) { fence('Event limit exceeded'); return; }
    if (passed) windowDeltas += 1; else { windowEvents += 1; windowBytes += bytes; }
    const event = Object.freeze({seq: ++sequence, kind: notification ? 'notification' : 'server-request-refused', method: message.method, message});
    if (!(passed && onEvent)) events.push(event);
    if (onEvent) { try { onEvent(event); } catch { fence('Event callback failed'); return; } }
    // A terminal for a turn whose result was given already: the earlier result may be wrong, so no later turn runs.
    if (message.method === 'turn/completed' && binding && params?.threadId === binding.threadId && settledTurns.has(params.turn?.id)) {
      fence('A second terminal event came for a turn that had ended');
      return;
    }
    if (turn) advance(turn, {type: 'event', event});
  }
  function parse(chunk) {
    if (fenced) return;
    try {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      // Split bytes before decoding so frame limits count UTF-8 bytes.
      let offset = 0;
      while (offset < bytes.length && !fenced) {
        const newline = bytes.indexOf(10, offset);
        const end = newline === -1 ? bytes.length : newline;
        const segment = bytes.subarray(offset, end);
        if (frameBytes + segment.length > maxFrameBytes) throw new Error('Frame byte limit exceeded');
        frameBytes += segment.length;
        text += decoder.decode(segment, {stream: true});
        if (newline === -1) break;
        text += decoder.decode();
        const length = frameBytes;
        frameBytes = 0;
        const line = text; text = '';
        observe(connection.receive(line, 'owned-process'), length);
        offset = newline + 1;
      }
    } catch { fence('Invalid or oversized protocol frame'); }
    settle();
  }
  function write(message) {
    if (fenced) return Promise.reject(new Error('Process requests fenced'));
    return new Promise((resolve, reject) => {
      try { child.stdin.write(JSON.stringify(message) + '\n', error => {
        if (error) { fence('Owned writer failed'); reject(error); } else resolve();
      }); }
      catch (error) { fence('Owned writer failed'); reject(error); }
    });
  }
  function start() {
    if (attempted || fenced) throw new Error('Process already started or stopped');
    attempted = true; phase = 'starting';
    return (async () => {
      try {
        // Its own process group: a Ctrl-C in the owner's terminal reaches the client only, and the client decides.
        // The controller still ends with the client: its stdin closes then, and stop() ends it on every client path.
        child = spawn(executable, [...launchArgs], {cwd, env: environment, shell: false, detached: true, stdio: ['pipe', 'pipe', 'pipe']});
        connection = createControllerTransport({generation: 'owned-process', send: write, inspectionCwd: cwd});
        child.on('error', () => fence('Owned process error'));
        child.on('close', (code, signal) => { childClosed = true; exitCode = code; exitSignal = signal; fence('Owned process closed'); notify(); });
        for (const [name, stream] of [['stdin', child.stdin], ['stdout', child.stdout], ['stderr', child.stderr]]) {
          stream.on('error', () => fence('Owned stream error'));
          stream.on('close', () => { streamClosures.add(name); if (!fenced) fence('Owned stream closed'); notify(); });
        }
        child.stdout.on('data', parse);
        child.stdout.on('end', () => {
          try { decoder.decode(); if (frameBytes) throw new Error('Incomplete frame'); }
          catch { fence('Incomplete protocol stream'); }
          fence('Protocol stream ended');
        });
        child.stderr.on('data', chunk => {
          const length = Buffer.byteLength(chunk);
          diagnosticsTruncated ||= diagnosticBytes + length > maxDiagnosticBytes;
          diagnosticBytes = Math.min(maxDiagnosticBytes, diagnosticBytes + length);
          // No stderr text is exposed: it can contain profile paths or credentials.
        });
        initialized = await bounded(connection.initialize(), startupTimeoutMs, 'Startup observation expired');
        if (fenced) throw new Error('Startup fenced');
        phase = 'ready'; return status();
      } catch (error) { fence('Startup failed'); throw error; }
    })();
  }
  function inspect() {
    if (phase !== 'ready' || fenced) return Promise.reject(new Error('Process not ready for inspection'));
    if (inspectionPromise) return inspectionPromise;
    inspectionPromise = bounded(connection.readConfiguration(), inspectionTimeoutMs, 'Inspection observation expired')
      .finally(() => { inspectionPromise = undefined; });
    return inspectionPromise;
  }
  /**
   * Binds one task to one root thread. The check of config/read runs before thread/start, because thread/start starts
   * the MCP servers. No turn can start unless the effective policy passed.
   */
  async function openThread(input) {
    if (threadRequested) throw new Error('This process already bound its one task and root thread');
    if (phase !== 'ready' || fenced || stopPromise) throw new Error('Process not ready for a thread');
    threadRequested = true;
    try {
      const task = bindTask(input, cwd);
      if (realpathSync(task.project) !== task.project) throw Object.assign(new Error('Project must be its own real path'), {code: 'task'});
      const config = await inspect();
      checkConfig(config, codexHome(environment));
      const thread = await bounded(connection.startThread({cwd, ephemeral: true, developerInstructions: input.instructions}), inspectionTimeoutMs, 'Thread start observation expired');
      binding = bindPolicy({binary: {path: executable, sha256: executableSha256}, args: launchArgs, initialize: initialized, config, thread, task});
      return Object.freeze({state: 'bound', policy: binding});
    } catch (error) {
      const state = error.code === 'uncertain' ? 'uncertain' : 'refused';
      const code = error.rpcError ? 'rpc' : (error.code ?? 'refused');
      const detail = Object.freeze(error.rpcError ? {...error.rpcError} : {message: error.message});
      return Object.freeze({state, code, error: detail, status: await stop()});
    }
  }
  function requestInterrupt(current) {
    if (current.interruptRequested) return;
    current.interruptRequested = true;
    current.cancels.push(schedule(() => { if (turn !== current) return; advance(current, {type: 'lost', reason: 'No terminal event within the interrupt grace'}); settle(); }, interruptGraceMs));
    if (current.state.turnId) sendInterrupt(current);
  }
  function sendInterrupt(current) {
    // The grace timer decides the outcome; an interrupt refusal or a closed connection changes nothing here.
    try { connection.interruptTurn({threadId: binding.threadId, turnId: current.state.turnId}).catch(() => {}); } catch { /* fenced */ }
  }
  /** Runs one turn on the bound root thread. Resolves with the frozen terminal result. */
  function runTurn(text) {
    if (!binding) return Promise.reject(new Error('No bound root thread'));
    if (turn) return Promise.reject(new Error('A turn is already active'));
    if (fenced || stopPromise) return Promise.reject(new Error('Process fenced; no new turn'));
    let inputSha256;
    try { inputSha256 = bindTurnText(text); } catch (error) { return Promise.reject(error); }
    const current = {state: Object.freeze({threadId: binding.threadId}), inputSha256, cancels: [], interruptRequested: false};
    windowEvents = 0; windowDeltas = 0; windowBytes = 0;
    // With an onEvent handler the caller keeps what it needs, so events() keeps the current turn only.
    if (onEvent) events.length = 0;
    const promise = new Promise(resolve => { current.resolve = resolve; });
    current.promise = promise;
    turn = current;
    current.cancels.push(schedule(() => { if (turn !== current) return; advance(current, {type: 'deadline'}); requestInterrupt(current); }, turnTimeoutMs));
    let pending;
    try { pending = connection.startTurn({threadId: binding.threadId, input: [{type: 'text', text}]}); }
    catch (error) { advance(current, {type: 'lost', reason: error.message}); settle(); return promise; }
    pending.then(reply => {
      if (turn !== current) return;
      const turnId = reply?.turn?.id;
      if (typeof turnId !== 'string' || turnId === '') advance(current, {type: 'lost', reason: 'The turn/start reply has no turn id'});
      else {
        advance(current, {type: 'reply', turnId});
        if (current.interruptRequested) sendInterrupt(current);
      }
      settle();
    }, error => {
      if (turn !== current) return;
      advance(current, error.code === 'refused' ? {type: 'refused', error: error.rpcError} : {type: 'lost', reason: error.message});
      settle();
    });
    return promise;
  }
  /** Asks the active turn to stop. Resolves with that turn's result: interrupted, or uncertain after the grace. */
  function interrupt() {
    if (!turn) return Promise.reject(new Error('No active turn'));
    const current = turn;
    requestInterrupt(current);
    return current.promise;
  }
  function stop() {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      // EOF alone gives no terminal event, so an active turn is interrupted first.
      if (turn) { const current = turn; requestInterrupt(current); await current.promise; }
      fence('Stop requested');
      if (!child) { phase = 'stopped'; return status(); }
      try { child.stdin.end(); } catch { /* Owned handle remains unresolved until observed. */ }
      for (const signal of ['SIGTERM', 'SIGKILL']) {
        if (await waitBounded(stopGraceMs)) return status();
        try { signals.push(signal); child.kill(signal); } catch { /* Signal failure is not terminal. */ }
      }
      await waitBounded(stopGraceMs);
      if (!terminal()) phase = 'unresolved';
      return status();
    })();
    return stopPromise;
  }
  function eventsCopy() { return Object.freeze([...events]); }
  /** Resolves with the first fence reason: a stop, a crash, a fenced turn or a protocol fault. */
  function fencedReason() { return fencedPromise; }
  return Object.freeze({start, inspect, openThread, runTurn, interrupt, stop, status, events: eventsCopy, fenced: fencedReason});
}
