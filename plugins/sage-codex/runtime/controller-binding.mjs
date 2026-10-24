import {createHash} from 'node:crypto';
import {closeSync, constants, fstatSync, lstatSync, openSync, readSync} from 'node:fs';
import {isAbsolute, resolve} from 'node:path';
import {INSTRUCTION_BYTES, OWNED_CONTROLLER_CONFIG, validText} from './controller-transport.mjs';

// The native version that the owned controller was proved against (T391).
export const CONTROLLER_VERSION = '0.160.0';
export const TURN_TEXT_BYTES = 64 * 1024;

const sha256 = value => createHash('sha256').update(value).digest('hex');
const HASH = /^[0-9a-f]{64}$/;
function refuse(code, message) { return Object.assign(new Error(message), {code}); }
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function deepFreeze(value) {
  if (value && typeof value === 'object') { for (const item of Object.values(value)) deepFreeze(item); Object.freeze(value); }
  return value;
}

/** The only reader of the controller path: SAGE_CODEX_CONTROLLER_BIN. No default, no PATH lookup, no other variable. */
export function resolveControllerBinary(env) {
  const path = env.SAGE_CODEX_CONTROLLER_BIN;
  const expected = env.SAGE_CODEX_CONTROLLER_SHA256;
  if (typeof path !== 'string' || path === '') throw refuse('binary-unset', 'SAGE_CODEX_CONTROLLER_BIN is not set');
  if (!isAbsolute(path)) throw refuse('binary-relative', 'SAGE_CODEX_CONTROLLER_BIN must be an absolute path');
  let stat;
  try { stat = lstatSync(path); } catch { stat = undefined; }
  if (!stat?.isFile()) throw refuse('binary-not-file', 'SAGE_CODEX_CONTROLLER_BIN must name a regular file, not a link or a folder');
  if ((stat.mode & 0o111) === 0) throw refuse('binary-not-executable', 'SAGE_CODEX_CONTROLLER_BIN must be executable');
  if (expected !== undefined && !HASH.test(expected)) throw refuse('binary', 'SAGE_CODEX_CONTROLLER_SHA256 must be 64 lowercase hex characters');
  // Hash the same file that lstat saw: O_NOFOLLOW refuses a link swapped in after lstat.
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const hash = createHash('sha256');
  try {
    const opened = fstatSync(fd);
    if (opened.ino !== stat.ino || opened.dev !== stat.dev) throw refuse('binary-not-file', 'SAGE_CODEX_CONTROLLER_BIN changed while it was read');
    const buffer = Buffer.alloc(1024 * 1024);
    for (let read; (read = readSync(fd, buffer, 0, buffer.length, null)) > 0;) hash.update(buffer.subarray(0, read));
  } finally { closeSync(fd); }
  const digest = hash.digest('hex');
  if (expected !== undefined && expected !== digest) throw refuse('binary', 'Controller binary hash does not match SAGE_CODEX_CONTROLLER_SHA256');
  return Object.freeze({path, sha256: digest, expectedSha256: expected ?? null});
}

const TASK = /^T[1-9][0-9]*$/;
const RUN = /^R[1-9][0-9]*$/;
/** Validates the trusted caller's task at the boundary. It keeps the instructions hash, not a copy. */
export function bindTask(input, cwd) {
  if (!input || Object.getPrototypeOf(input) !== Object.prototype) throw refuse('task', 'Task binding must be a plain object');
  const keys = Object.keys(input).sort().join(',');
  if (keys !== 'instructions,project,run,task') throw refuse('task', 'Task binding needs exactly project, task, run and instructions');
  const {project, task, run, instructions} = input;
  if (typeof project !== 'string' || !isAbsolute(project) || resolve(project) !== project) throw refuse('task', 'Project must be a canonical absolute path');
  if (project !== cwd) throw refuse('task', 'Project must be the process cwd');
  if (typeof task !== 'string' || !TASK.test(task)) throw refuse('task', 'Task must be T and digits, with no leading zero');
  if (typeof run !== 'string' || !RUN.test(run)) throw refuse('task', 'Run must be R and digits, with no leading zero');
  if (!validText(instructions, INSTRUCTION_BYTES)) throw refuse('task', 'Instructions must be non-empty text of at most 256 KiB, with no NUL');
  return Object.freeze({project, task, run, instructionsSha256: sha256(instructions)});
}

/** Validates one turn text. It returns the hash that the turn result keeps. */
export function bindTurnText(text) {
  if (!validText(text, TURN_TEXT_BYTES)) throw refuse('turn-text', 'Turn text must be non-empty text of at most 64 KiB, with no NUL');
  return sha256(text);
}

function effective(config, key) {
  let value = config;
  for (const part of key.split('.')) {
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, part)) return undefined;
    value = value[part];
  }
  return value;
}
const camel = value => value.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
// config/read gives sandbox_mode in kebab case; the thread/start reply gives a tagged object in camel case.
const SELECTION = [
  ['model', 'model', value => value],
  ['modelProvider', 'model_provider', value => value],
  ['approvalPolicy', 'approval_policy', value => value],
  ['sandbox', 'sandbox_mode', (value, reply) => (typeof value === 'string' ? {...reply, type: camel(value)} : value)],
];

/** Pure. Returns the frozen policy record with its binding hash, or throws a refusal with a fixed code. */
export function bindPolicy({binary, args, initialize, config: read, thread: reply, task}) {
  const config = read?.config, origins = read?.origins;
  if (!config || typeof config !== 'object' || !origins || typeof origins !== 'object') throw refuse('policy-missing', 'config/read gave no config or origins');
  for (const [key, required] of Object.entries(OWNED_CONTROLLER_CONFIG)) {
    // A structured feature (such as features.multi_agent_v2) can be a table: its switch and origin are at `.enabled`.
    const switchKey = Object.hasOwn(origins, `${key}.enabled`) ? `${key}.enabled` : key;
    const value = effective(config, switchKey) ?? effective(config, key);
    if (value === undefined || !Object.hasOwn(origins, switchKey)) throw refuse('policy-missing', `Owned key ${key} is missing from config/read`);
    if (origins[switchKey]?.name?.type !== 'sessionFlags') throw refuse('policy-origin', `Owned key ${key} comes from another layer`);
    if (value !== required) throw refuse('policy-value', `Owned key ${key} has another value`);
  }
  const thread = reply?.thread;
  if (thread?.cliVersion !== CONTROLLER_VERSION) throw refuse('version', `The controller is not version ${CONTROLLER_VERSION}`);
  if (thread.ephemeral !== true) throw refuse('not-ephemeral', 'The root thread is not ephemeral');
  if (thread.parentThreadId !== null) throw refuse('not-root', 'The thread is not a root');
  if (thread.cwd !== task.project) throw refuse('cwd', 'The thread cwd is not the bound project');
  if (typeof thread.id !== 'string' || thread.id === '') throw refuse('not-root', 'The thread has no id');
  const selection = {};
  for (const [name, key, expect] of SELECTION) {
    const observed = reply[name];
    const configured = effective(config, key);
    if (configured === undefined) { selection[name] = {value: observed ?? null, origin: 'default'}; continue; }
    if (canonical(expect(configured, observed)) !== canonical(observed)) throw refuse('selection-changed', `The thread ${name} is not the configured ${key}`);
    selection[name] = {value: observed, origin: origins[key]?.name?.type ?? 'unknown'};
  }
  if (!HASH.test(binary?.sha256 ?? '')) throw refuse('binary', 'The binary hash is missing');
  if (binary.expectedSha256 && binary.expectedSha256 !== binary.sha256) throw refuse('binary', 'Controller binary hash does not match SAGE_CODEX_CONTROLLER_SHA256');
  const record = {
    binary: {path: binary.path, sha256: binary.sha256}, args: [...args], cliVersion: thread.cliVersion,
    userAgent: initialize?.userAgent ?? null, selection, multiAgentMode: reply.multiAgentMode ?? null,
    threadId: thread.id, project: task.project, task: task.task, run: task.run, instructionsSha256: task.instructionsSha256,
  };
  return deepFreeze({...record, bindingHash: sha256(canonical(record))});
}

function agentText(items) {
  const messages = Array.isArray(items) ? items.filter(item => item?.type === 'agentMessage' && typeof item.text === 'string') : [];
  return messages.length ? messages.at(-1).text : null;
}
const TERMINAL = {completed: 'completed', interrupted: 'interrupted', failed: 'failed'};

/**
 * Pure reducer for the terminal result of one bound turn. The state starts as {threadId}. Messages:
 * {type: 'reply', turnId}, {type: 'refused', error}, {type: 'event', event}, {type: 'deadline'} and {type: 'lost', reason}.
 * The state has `result` (null until decided). A turn/start reply is never a completion.
 */
export function turnOutcome(state, message) {
  const next = {held: [], turnId: null, result: null, error: null, lastAgentMessage: null, itemAgentMessage: null, timedOut: false, terminals: 0, ...state};
  const decide = (result, error = next.error) => Object.freeze({...next, result, error});
  switch (message.type) {
    case 'reply': {
      if (next.turnId !== null || next.result) return Object.freeze(next);
      let current = Object.freeze({...next, turnId: message.turnId, held: []});
      for (const event of next.held) current = turnOutcome(current, {type: 'event', event});
      return current;
    }
    case 'refused': return next.result ? Object.freeze(next) : decide('refused', {code: message.error?.code ?? null, message: message.error?.message ?? null});
    case 'deadline': return Object.freeze({...next, timedOut: true});
    case 'lost': return next.result ? Object.freeze(next) : decide('uncertain', {reason: message.reason});
    case 'event': break;
    default: throw new TypeError('Unknown turn message');
  }
  const {method, params} = message.event.message;
  if (params?.threadId !== next.threadId) return Object.freeze(next);
  if (next.turnId === null) return Object.freeze({...next, held: [...next.held, message.event]});
  if (method === 'item/completed' && params.turnId === next.turnId && params.item?.type === 'agentMessage' && typeof params.item.text === 'string')
    return Object.freeze({...next, itemAgentMessage: params.item.text, lastAgentMessage: next.result ? next.lastAgentMessage : params.item.text});
  if (method !== 'turn/completed' || params.turn?.id !== next.turnId) return Object.freeze(next);
  next.terminals += 1;
  if (next.terminals > 1) return decide('uncertain', {reason: 'Conflicting terminal events for the bound turn'});
  const result = TERMINAL[params.turn.status] ?? 'uncertain';
  next.lastAgentMessage = agentText(params.turn.items) ?? next.itemAgentMessage;
  return decide(result, result === 'failed' ? (params.turn.error ?? null) : result === 'uncertain' ? {reason: `Unknown turn status ${String(params.turn.status)}`} : null);
}
