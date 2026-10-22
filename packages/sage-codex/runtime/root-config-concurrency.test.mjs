import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync, realpathSync, writeFileSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

// Resolve core from this checkout, including detached-main checks. Never use a package alias.
const coreEntry = new URL('../../sage-core/index.mjs', import.meta.url).href;
const workerFile = fileURLToPath(new URL('./root-config-concurrency-worker.mjs', import.meta.url));
function worker(root, setting, name) {
  const child = spawn(process.execPath, [workerFile, coreEntry, root, setting, name], {
    cwd: root, shell: false, stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
    env: {...process.env, NODE_TEST_CONTEXT: 'child-v8', SAGE_TEST_PIDS: '{}', SAGE_TEST_MACHINE_ID: '', SAGE_HOME: root},
  });
  const events = [], observers = new Set();
  let buffer = '', stderr = '', terminal = false;
  const notify = () => { for (const observer of [...observers]) observer(); };
  child.stdout.on('data', chunk => {
    buffer += chunk;
    while (buffer.includes('\n')) {
      const index = buffer.indexOf('\n'); events.push(JSON.parse(buffer.slice(0, index))); buffer = buffer.slice(index + 1);
      notify();
    }
  });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const closed = new Promise(resolve => child.on('close', (code, signal) => { terminal = true; notify(); resolve({code, signal, stderr}); }));
  child.on('error', error => { stderr += String(error); });
  child.stdio[3].on('error', () => {}); // A worker may close after a failure before cleanup releases its barrier.
  return {
    child, closed,
    waitFor(kinds) {
      return new Promise((resolve, reject) => {
        const observe = () => {
          const found = events.find(record => kinds.includes(record.event));
          if (found) { observers.delete(observe); resolve(found.event); }
          else if (terminal) { observers.delete(observe); reject(Error(`Worker closed before ${kinds.join('/')}: ${stderr}`)); }
        };
        observers.add(observe); observe();
      });
    },
    release() { if (!child.stdio[3].destroyed) child.stdio[3].write(Buffer.from([1])); },
    async settle() {
      if (terminal) return closed;
      if (!child.stdio[3].destroyed) child.stdio[3].end(Buffer.from([1]));
      // Runaway cleanup guard only. It never counts as successful test evidence.
      const timer = setTimeout(() => { if (!terminal) child.kill('SIGKILL'); }, 5000);
      try { return await closed; } finally { clearTimeout(timer); }
    },
  };
}

test('independent concurrent root config updates preserve both settings and unknown keys', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sage-root-config-')));
  writeFileSync(join(root, 'config.json'), JSON.stringify({max_rounds: 3, arena: 3, future_key: {preserved: true}}));
  writeFileSync(join(root, 'projects.made'), '');
  const workers = [];
  let watchdog, stopping = false;
  const active = () => { if (stopping) throw Error('Worker sequence cancelled during cleanup'); };
  const expired = new Promise((_, reject) => { watchdog = setTimeout(() => reject(Error('Runaway worker watchdog; no correctness timing claim')), 30000); });
  try {
    await Promise.race([(async () => {
      const first = worker(root, 'max_rounds=5', 'first'); workers.push(first);
      await first.waitFor(['config-read']);
      active();
      const second = worker(root, 'arena=4', 'second'); workers.push(second);
      await second.waitFor(['lock-attempt', 'config-read']);
      active();
      first.release();
      assert.deepEqual(await first.closed, {code: 0, signal: null, stderr: ''});
      await second.waitFor(['config-read']);
      active();
      second.release();
      assert.deepEqual(await second.closed, {code: 0, signal: null, stderr: ''});
      assert.deepEqual(JSON.parse(readFileSync(join(root, 'config.json'), 'utf8')), {max_rounds: 5, arena: 4, future_key: {preserved: true}});
    })(), expired]);
  } finally {
    stopping = true;
    clearTimeout(watchdog);
    for (const owned of workers) owned.release();
    await Promise.all(workers.map(owned => owned.settle()));
    rmSync(root, {recursive: true, force: true});
  }
});
