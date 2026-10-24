// Disposable test worker. Hooks only its own Node fs bindings before importing core.
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {join, resolve} from 'node:path';
const [entry, root, setting, name] = process.argv.slice(2);
const native = {openSync: fs.openSync, readSync: fs.readSync, readFileSync: fs.readFileSync, renameSync: fs.renameSync, writeSync: fs.writeSync};
const descriptors = new Set();
let paused = false, announcedLock = false;
const announce = event => native.writeSync(1, JSON.stringify({worker: name, event}) + '\n');
fs.openSync = function(path, ...rest) {
  const fd = native.openSync(path, ...rest);
  if (resolve(String(path)) === join(root, 'config.json')) descriptors.add(fd);
  return fd;
};
fs.readFileSync = function(fd, ...rest) {
  const data = native.readFileSync(fd, ...rest);
  if (descriptors.has(fd) && !paused) {
    paused = true;
    announce('config-read');
    native.readSync(3, Buffer.alloc(1), 0, 1, null);
  }
  return data;
};
fs.renameSync = function(from, to) {
  if (String(to) === join(root, '.lock') && !announcedLock) { announcedLock = true; announce('lock-attempt'); }
  return native.renameSync(from, to);
};
syncBuiltinESMExports();
try {
  const {createStateTool} = await import(entry);
  const tool = createStateTool({defaultRoot: () => root});
  const output = tool.sage(['config', setting], {...process.env, SAGE_HOME: root});
  announce('complete');
  native.writeSync(1, JSON.stringify({output}) + '\n');
} catch (error) {
  native.writeSync(2, String(error.stack) + '\n');
  process.exitCode = 1;
}
