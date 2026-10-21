import {spawn as nativeSpawn} from 'node:child_process';
import {isAbsolute} from 'node:path';
import {createControllerTransport, REQUIRED_CONTROLLER_CONFIG} from './controller-transport.mjs';

// Limits bound one wire frame and retained stderr bytes, not total process output.
const DEFAULT_FRAME_BYTES = 1024 * 1024;
const DEFAULT_DIAGNOSTIC_BYTES = 16 * 1024;
function positive(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`Invalid ${name}`);
  return value;
}
const defaultSchedule = (callback, delay) => { const timer = setTimeout(callback, delay); return () => clearTimeout(timer); };

/** Trusted launch inputs only. This owner exposes no model work or effect API. */
export function createControllerProcess(options, {spawn = nativeSpawn, schedule = defaultSchedule} = {}) {
  if (!options || Object.getPrototypeOf(options) !== Object.prototype) throw new TypeError('Trusted launch options required');
  const allowed = ['executable', 'cwd', 'env', 'startupTimeoutMs', 'inspectionTimeoutMs', 'stopGraceMs', 'maxFrameBytes', 'maxDiagnosticBytes'];
  for (const key of Reflect.ownKeys(options)) {
    const descriptor = Object.getOwnPropertyDescriptor(options, key);
    if (!allowed.includes(key) || !('value' in descriptor)) throw new TypeError('Unsupported launch option');
  }
  const {executable, cwd, env, startupTimeoutMs = 10000, inspectionTimeoutMs = 10000, stopGraceMs = 1000,
    maxFrameBytes = DEFAULT_FRAME_BYTES, maxDiagnosticBytes = DEFAULT_DIAGNOSTIC_BYTES} = options;
  if (typeof executable !== 'string' || !isAbsolute(executable) || typeof cwd !== 'string' || !isAbsolute(cwd)) throw new TypeError('Trusted absolute executable and canonical cwd required');
  if (!env || Object.getPrototypeOf(env) !== Object.prototype) throw new TypeError('Explicit trusted environment required');
  const environment = {};
  for (const key of Reflect.ownKeys(env)) {
    const descriptor = Object.getOwnPropertyDescriptor(env, key);
    if (typeof key !== 'string' || !('value' in descriptor) || typeof descriptor.value !== 'string') throw new TypeError('Environment must contain string data');
    Object.defineProperty(environment, key, {value: descriptor.value, enumerable: true});
  }
  Object.freeze(environment);
  for (const [name, value] of Object.entries({startupTimeoutMs, inspectionTimeoutMs, stopGraceMs, maxFrameBytes, maxDiagnosticBytes})) positive(value, name);
  if (typeof spawn !== 'function' || typeof schedule !== 'function') throw new TypeError('Invalid process dependencies');
  let child, connection, attempted = false, fenced = false, childClosed = false, exitCode = null, exitSignal = null;
  let phase = 'idle', stopPromise, inspectionPromise, diagnosticBytes = 0, diagnosticsTruncated = false;
  const streamClosures = new Set(), observations = new Set(), signals = [];
  let buffered = Buffer.alloc(0);
  const decoder = new TextDecoder('utf-8', {fatal: true});
  let text = '';
  function status() {
    return Object.freeze({state: phase, processClosed: childClosed, streamsClosed: streamClosures.size === 3,
      exitCode, exitSignal, diagnosticBytes, diagnosticsTruncated, signals: Object.freeze([...signals])});
  }
  function terminal() { return childClosed && streamClosures.size === 3; }
  function notify() {
    if (terminal()) phase = 'stopped';
    for (const observe of [...observations]) observe();
  }
  function fence(reason) {
    fenced = true;
    connection?.disconnect(reason);
    if (!terminal()) phase = 'unresolved';
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
  function parse(chunk) {
    if (fenced) return;
    try {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      // Split bytes before decoding so frame limits count UTF-8 bytes.
      let offset = 0;
      while (offset < bytes.length) {
        const newline = bytes.indexOf(10, offset);
        const end = newline === -1 ? bytes.length : newline;
        const segment = bytes.subarray(offset, end);
        if (buffered.length + segment.length > maxFrameBytes) throw new Error('Frame byte limit exceeded');
        buffered = Buffer.concat([buffered, segment]);
        text += decoder.decode(segment, {stream: true});
        if (newline === -1) break;
        text += decoder.decode();
        connection.receive(text, 'owned-process');
        buffered = Buffer.alloc(0); text = '';
        offset = newline + 1;
      }
    } catch { fence('Invalid or oversized protocol frame'); }
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
        const args = ['app-server', '--stdio', '--strict-config'];
        for (const [key, value] of Object.entries(REQUIRED_CONTROLLER_CONFIG)) args.push('-c', `${key}=${JSON.stringify(value)}`);
        child = spawn(executable, args, {cwd, env: environment, shell: false, stdio: ['pipe', 'pipe', 'pipe']});
        connection = createControllerTransport({generation: 'owned-process', send: write, inspectionCwd: cwd});
        child.on('error', () => fence('Owned process error'));
        child.on('close', (code, signal) => { childClosed = true; exitCode = code; exitSignal = signal; fence('Owned process closed'); notify(); });
        for (const [name, stream] of [['stdin', child.stdin], ['stdout', child.stdout], ['stderr', child.stderr]]) {
          stream.on('error', () => fence('Owned stream error'));
          stream.on('close', () => { streamClosures.add(name); if (!fenced) fence('Owned stream closed'); notify(); });
        }
        child.stdout.on('data', parse);
        child.stdout.on('end', () => {
          try { decoder.decode(); if (buffered.length) throw new Error('Incomplete frame'); }
          catch { fence('Incomplete protocol stream'); }
          fence('Protocol stream ended');
        });
        child.stderr.on('data', chunk => {
          const length = Buffer.byteLength(chunk);
          diagnosticsTruncated ||= diagnosticBytes + length > maxDiagnosticBytes;
          diagnosticBytes = Math.min(maxDiagnosticBytes, diagnosticBytes + length);
          // No stderr text is exposed: it can contain profile paths or credentials.
        });
        let cancel;
        const deadline = new Promise((_, reject) => { cancel = schedule(() => { fence('Startup observation expired'); reject(new Error('Startup observation expired')); }, startupTimeoutMs); });
        try { await Promise.race([connection.initialize(), deadline]); }
        finally { cancel(); }
        if (fenced) throw new Error('Startup fenced');
        phase = 'ready'; return status();
      } catch (error) { fence('Startup failed'); throw error; }
    })();
  }
  function inspect() {
    if (phase !== 'ready' || fenced) return Promise.reject(new Error('Process not ready for inspection'));
    if (inspectionPromise) return inspectionPromise;
    inspectionPromise = (async () => {
      let cancel;
      const deadline = new Promise((_, reject) => {
        cancel = schedule(() => {
          fence('Inspection observation expired');
          reject(Object.assign(new Error('Inspection observation expired; outcome uncertain'), {code: 'uncertain'}));
        }, inspectionTimeoutMs);
      });
      try { return await Promise.race([connection.readConfiguration(), deadline]); }
      finally { cancel(); inspectionPromise = undefined; }
    })();
    return inspectionPromise;
  }
  function stop() {
    if (stopPromise) return stopPromise;
    fence('Stop requested');
    if (!child) { phase = 'stopped'; stopPromise = Promise.resolve(status()); return stopPromise; }
    stopPromise = (async () => {
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
  return Object.freeze({start, inspect, stop, status});
}
