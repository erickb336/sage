// Temporary, opt-in observations. The routing key is control data, never an observation.
// The existing Sage logbook key fixes routing without retaining a path or native ID.
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
export const RECORD_LIMIT = 64, BYTE_LIMIT = 65536, WINDOW_MS = 24 * 60 * 60 * 1000;
const TYPES = new Set(['absent', 'null', 'valid_type', 'wrong_type']);
const REASONS = new Set(['BOUND', 'EXISTING_BINDING', 'CONFLICTING_BINDING', 'MISSING_BINDING', 'BINDING_MISMATCH', 'IDENTITY_MISMATCH', 'RUN_MISSING', 'TASK_ROLE_MISMATCH', 'RUN_NOT_RUNNING', 'RETAINED', 'DUPLICATE_REPORT', 'CONFLICTING_REPORT', 'INCOMPLETE_REPORT', 'MISSING_REPORT_TEXT', 'READ_FAILURE', 'WRITE_FAILURE', 'LOCK_FAILURE', 'RETENTION_REFUSED']);
const FIELDS = { cwd: 'string', transcript_path: 'string', agent_transcript_path: 'string', agent_id: 'string', session_id: 'string', last_assistant_message: 'string', stop_hook_active: 'boolean' };
export const fieldStates = input => Object.fromEntries(Object.entries(FIELDS).map(([key, type]) => [key,
  !Object.hasOwn(input, key) ? 'absent' : input[key] === null ? 'null' : typeof input[key] === type ? 'valid_type' : 'wrong_type']));
const COMPARE = new Set(['same', 'different', 'unknown']);
export const compare = (a, b) => a === undefined || b === undefined ? 'unknown' : a === b ? 'same' : 'different';
function sanitized(record, sequence) {
  if (!['start', 'stop'].includes(record?.event) || !REASONS.has(record.reason)) throw Error('invalid observation');
  return { sequence, event: record.event, fields: Object.fromEntries(Object.keys(FIELDS).map(k => [k, TYPES.has(record.fields?.[k]) ? record.fields[k] : 'absent'])),
    metadata: 'valid_type', association: 'same', child: COMPARE.has(record.child) ? record.child : 'unknown',
    parent: COMPARE.has(record.parent) ? record.parent : 'unknown', project: COMPARE.has(record.project) ? record.project : 'unknown',
    binding: ['created', 'same', 'different', 'missing', 'unknown'].includes(record.binding) ? record.binding : 'unknown',
    run_state: ['running', 'not_running', 'missing', 'unknown'].includes(record.run_state) ? record.run_state : 'unknown',
    retention: ['kept', 'refused', 'not_attempted'].includes(record.retention) ? record.retention : 'not_attempted', reason: record.reason };
}
export function createCaptureDiagnostics(tool) {
  const folder = env => join(tool.sageRoot(env), 'capture-diagnostics');
  const file = env => join(folder(env), 'window.json');
  const scope = (project, env) => basename(tool.storeDir(project, env));
  const failure = status => ({ status, observation: 'no_observation', records: [] });
  function safeFolder(env) {
    const st = lstatSync(folder(env));
    if (!st.isDirectory() || (st.mode & 0o077) || (process.getuid && st.uid !== process.getuid())) throw Error('unsafe storage');
  }
  function load(env, name = "window.json") {
    try { safeFolder(env); } catch (e) { if (e.code === 'ENOENT') return undefined; throw e; }
    let fd;
    try {
      fd = openSync(join(folder(env), name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const st = fstatSync(fd);
      if (!st.isFile() || st.size > BYTE_LIMIT || (st.mode & 0o077) || (process.getuid && st.uid !== process.getuid())) throw Error('unsafe window');
      const data = JSON.parse(readFileSync(fd, 'utf8'));
      if (data.version !== 1 || typeof data.scope !== 'string' || !/^[a-z0-9-]+-[a-f0-9]{6}$/.test(data.scope) || !/^T[1-9]\d*$/.test(data.task) || !/^R[1-9]\d*$/.test(data.run)
        || !Number.isSafeInteger(data.expires) || !Array.isArray(data.records) || data.records.length > RECORD_LIMIT || typeof data.saturated !== 'boolean') throw Error('invalid window');
      // Reconstruct every public record, even after disk damage. Never echo arbitrary stored fields.
      data.records = data.records.map((r, i) => sanitized(r, i + 1));
      return data;
    } catch (e) { if (e.code === 'ENOENT') return undefined; throw e; }
    finally { if (fd !== undefined) closeSync(fd); }
  }
  function locked(env, fn) {
    safeFolder(env);
    const lock = join(folder(env), 'lock'); mkdirSync(lock, { mode: 0o700 });
    try { return fn(); } finally { rmdirSync(lock); }
  }
  function remove(env) {
    const current = load(env);
    try {
      const temporary = load(env, 'next');
      if (temporary && current && temporary.scope === current.scope && temporary.task === current.task && temporary.run === current.run && temporary.expires === current.expires) unlinkSync(join(folder(env), 'next'));
    } catch { /* An unrelated or unreadable file is not ours to delete. */ }
    unlinkSync(file(env));
  }
  function save(env, data) {
    const bytes = JSON.stringify(data);
    if (Buffer.byteLength(bytes) > BYTE_LIMIT) throw Error('window too large');
    // The temporary copy and the prior copy together must fit the byte cap.
    const prior = lstatSync(file(env), { throwIfNoEntry: false })?.size ?? 0;
    if (prior + Buffer.byteLength(bytes) > BYTE_LIMIT) return false;
    const temporary = join(folder(env), 'next');
    let fd;
    try { fd = openSync(temporary, 'wx', 0o600); writeFileSync(fd, bytes); renameSync(temporary, file(env)); }
    finally { if (fd !== undefined) { closeSync(fd); try { unlinkSync(temporary); } catch {} } }
    return true;
  }
  function prune(env = process.env) {
    try {
      try {
        const temporary = load(env, 'next');
        if (temporary && temporary.expires <= Date.now()) locked(env, () => {
          const current = load(env, 'next');
          if (current && current.expires <= Date.now()) unlinkSync(join(folder(env), 'next'));
        });
      } catch { /* Preserve unrelated files. */ }
      const data = load(env);
      if (data && data.expires <= Date.now()) return locked(env, () => {
        const current = load(env);
        if (current && current.expires <= Date.now()) { remove(env); return { status: 'expired', scope: current.scope, task: current.task }; }
      });
    } catch { return { status: 'unreadable' }; }
  }
  function control(project, task, run, action, env = process.env) {
    if (!['start', 'end'].includes(action) || !/^T[1-9]\d*$/.test(task) || !/^R[1-9]\d*$/.test(run)) throw Error('invalid diagnostic control');
    prune(env);
    const wanted = scope(project, env);
    if (action === 'start') {
      const row = tool.logbookView(project, env).row(run);
      if (!row || row.task !== task || row.status !== 'running') throw Error('diagnostics need a running run of the selected task');
      mkdirSync(folder(env), { recursive: true, mode: 0o700 });
    }
    if (action === 'end' && !load(env)) return failure('disabled');
    return locked(env, () => {
      const current = load(env);
      if (current && (current.scope !== wanted || current.task !== task || current.run !== run)) throw Error('another diagnostic window is active');
      if (action === 'end') { if (current) remove(env); return failure('disabled'); }
      if (!current) save(env, { version: 1, scope: wanted, task, run, expires: Date.now() + WINDOW_MS, saturated: false, records: [] });
      return read(project, task, env);
    });
  }
  function read(project, task, env = process.env, prior) {
    const pruned = prior ?? prune(env);
    if (pruned) return failure(pruned.status === 'expired' && (pruned.scope !== scope(project, env) || pruned.task !== task) ? 'disabled' : pruned.status);
    try {
      const data = load(env);
      if (!data || data.scope !== scope(project, env) || data.task !== task) return failure('disabled');
      return { status: data.saturated ? 'saturated' : 'active', observation: data.records.length ? 'observed' : 'no_observation', records: data.records };
    } catch { return failure('unreadable'); }
  }
  function begin(project, child, input, event, env = process.env) {
    prune(env);
    try {
      const data = load(env);
      if (!data || !child || data.scope !== scope(project, env) || data.task !== child.task || data.run !== child.run) return undefined;
      const record = { event, fields: fieldStates(input), reason: 'RETENTION_REFUSED' };
      return { record, finish() {
        try { locked(env, () => {
          const current = load(env);
          if (!current || current.expires <= Date.now() || current.scope !== data.scope || current.task !== data.task || current.run !== data.run || current.expires !== data.expires || current.saturated) return;
          const next = sanitized(record, current.records.length + 1);
          const updated = { ...current, records: [...current.records, next] };
          updated.saturated = updated.records.length >= RECORD_LIMIT;
          if (updated.records.length > RECORD_LIMIT || !save(env, updated)) {
            // One bounded flag replaces no earlier observation. Reserve room for it on every write.
            current.saturated = true; save(env, current);
          }
        }); } catch { /* Observations never change capture. */ }
      } };
    } catch { return undefined; }
  }
  function complete(project, run, env = process.env) {
    try { locked(env, () => { const data = load(env); if (data && data.scope === scope(project, env) && data.run === run) remove(env); }); } catch {}
  }
  return { control, read, begin, prune, complete };
}
