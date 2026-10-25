import {createHash} from 'node:crypto';
import {closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync} from 'node:fs';
import {basename, dirname, isAbsolute, join, relative, resolve} from 'node:path';
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

const SHARED_WRITE = 0o022, STICKY = 0o1000;
const BINARY_FIX = 'Set SAGE_CODEX_CONTROLLER_BIN to the absolute path of the built fork binary (codex-rs/target/debug/codex in the fork checkout).';

// Another user can change the binary when its group or other users can write it, or when it belongs to another user.
// The same holds for each folder on its real path, except that a sticky folder (such as /tmp) refuses a rename or a
// removal by a user who does not own the entry. Root may own each of them: root can change any file anyway.
function changeableBy(stat, folder) {
  const uid = process.getuid();
  if (stat.uid !== uid && stat.uid !== 0) return `belongs to another user (uid ${stat.uid})`;
  if ((stat.mode & SHARED_WRITE) && !(folder && (stat.mode & STICKY))) return 'is writable by its group or by other users';
  return null;
}

/**
 * The only reader of the controller path: SAGE_CODEX_CONTROLLER_BIN. No default, no PATH lookup, no other variable.
 * It resolves the real path, refuses a file or a folder on that path that another user can change, and hashes the file.
 */
export function resolveControllerBinary(env) {
  const given = env.SAGE_CODEX_CONTROLLER_BIN;
  const expected = env.SAGE_CODEX_CONTROLLER_SHA256;
  if (typeof given !== 'string' || given === '') throw refuse('binary-unset', `SAGE_CODEX_CONTROLLER_BIN is not set. ${BINARY_FIX}`);
  if (!isAbsolute(given)) throw refuse('binary-relative', `SAGE_CODEX_CONTROLLER_BIN is ${JSON.stringify(given)}, a relative path. ${BINARY_FIX}`);
  if (expected !== undefined && !HASH.test(expected)) throw refuse('binary-hash', `SAGE_CODEX_CONTROLLER_SHA256 is ${JSON.stringify(expected)}, not 64 lowercase hex characters. Set it to the sha256 of the binary, or unset it.`);
  let path;
  try { path = realpathSync(given); } catch { throw refuse('binary-missing', `No file is at ${given}. Build the fork binary, or correct SAGE_CODEX_CONTROLLER_BIN.`); }
  // The real path has no link in it, so the folders below are the ones that the launch goes through.
  const stat = lstatSync(path);
  if (!stat.isFile()) throw refuse('binary-not-file', `${path} is not a regular file. ${BINARY_FIX}`);
  if ((stat.mode & 0o111) === 0) throw refuse('binary-not-executable', `${path} is not executable. Use the built binary, or run chmod u+x on it.`);
  const fileRisk = changeableBy(stat, false);
  if (fileRisk) throw refuse('binary-writable', `${path} ${fileRisk}, so another user can change it. Use a binary that you own, with chmod go-w on it, then start again.`);
  for (let folder = dirname(path); ; folder = dirname(folder)) {
    const folderRisk = changeableBy(statSync(folder), true);
    if (folderRisk) throw refuse('binary-writable', `The folder ${folder} ${folderRisk}, so another user can replace the binary. Move the binary to a folder that you own, with chmod go-w on each folder.`);
    if (folder === dirname(folder)) break;
  }
  // Hash the same file that lstat saw: O_NOFOLLOW refuses a link swapped in after lstat.
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const hash = createHash('sha256');
  try {
    const opened = fstatSync(fd);
    if (opened.ino !== stat.ino || opened.dev !== stat.dev) throw refuse('binary-changed', `${path} changed while the client read it. Start again.`);
    const buffer = Buffer.alloc(1024 * 1024);
    for (let read; (read = readSync(fd, buffer, 0, buffer.length, null)) > 0;) hash.update(buffer.subarray(0, read));
  } finally { closeSync(fd); }
  const digest = hash.digest('hex');
  if (expected !== undefined && expected !== digest) throw refuse('binary-hash', `The binary ${path} has sha256 ${digest}, but SAGE_CODEX_CONTROLLER_SHA256 is ${expected}. Check that this is the binary that you built, then set SAGE_CODEX_CONTROLLER_SHA256 to its hash.`);
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
  if (typeof task !== 'string' || !TASK.test(task)) throw refuse('task', `The task ${JSON.stringify(task)} is not a task id. Give T and digits with no leading zero, for example --task T400.`);
  if (typeof run !== 'string' || !RUN.test(run)) throw refuse('task', `The run ${JSON.stringify(run)} is not a run id. Give R and digits with no leading zero, for example --run R1.`);
  if (!validText(instructions, INSTRUCTION_BYTES)) throw refuse('task', 'The instructions file must have text of 1 byte to 256 KiB, with no NUL. Correct the file that --instructions names.');
  return Object.freeze({project, task, run, instructionsSha256: sha256(instructions)});
}

/** Validates one turn text. It returns the hash that the turn result keeps. */
export function bindTurnText(text) {
  if (!validText(text, TURN_TEXT_BYTES)) {
    const found = typeof text !== 'string' ? 'is not text' : text.includes('\0') ? 'has a NUL character' : `has ${Buffer.byteLength(text)} bytes`;
    throw refuse('turn-text', `The line ${found}; a line must be text of 1 to ${TURN_TEXT_BYTES} bytes, with no NUL.`);
  }
  return sha256(text);
}

// The layers that the agents of a session cannot write. The project layer (.codex/ in the project) is not one of them.
const OWNER_LAYERS = new Set(['user', 'sessionFlags', 'mdm', 'system', 'enterpriseManaged', 'legacyManagedConfigTomlFromFile', 'legacyManagedConfigTomlFromMdm']);
function layer(origin) {
  const name = origin?.name ?? {};
  if (name.type === 'user') return `your Codex config (${name.file}${name.profile ? `, profile ${name.profile}` : ''})`;
  if (name.type === 'project') return `the project config in ${name.dotCodexFolder}`;
  if (name.type === 'sessionFlags') return 'the launch flags';
  return `the ${String(name.type ?? 'unknown')} config layer${name.file ? ` (${name.file})` : ''}`;
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
// The sandbox and the approval policy are the owner's: each must be set, in a layer that an agent cannot write.
const SELECTION = [
  ['model', 'model', value => value, false],
  ['modelProvider', 'model_provider', value => value, false],
  ['approvalPolicy', 'approval_policy', value => value, true],
  ['sandbox', 'sandbox_mode', (value, reply) => (typeof value === 'string' ? {...reply, type: camel(value)} : value), true],
];
const RESTART = 'then start the client again';
// The owner's Codex folder: CODEX_HOME, or ~/.codex. A refusal that says to move a setting or a file names its path there.
export const codexHome = env => env.CODEX_HOME || (env.HOME ? join(env.HOME, '.codex') : '');
const homePath = (home, name) => (home ? join(home, name) : `${name} in your Codex folder`);
// An agent may have written the setting or the file, so the owner checks it before moving it.
const checkIt = (what, it, target, home) => `Check ${what}. If you trust ${it}, move ${it} to your Codex config (${homePath(home, target)}). If not, remove ${it}. Then start the client again.`;
const EXAMPLE = {approval_policy: '"on-request"', sandbox_mode: '"read-only"'};
// The only settings that a layer an agent can write (the project) may set. Each changes only the text work of the
// model: none runs a program, names a path, changes the environment, adds a tool or a role, or changes approvals.
// controller.md gives the reason for each. A name that ends in a dot allows each key of that table.
const PROJECT_ALLOWED = ['model', 'model_reasoning_effort', 'model_reasoning_summary', 'model_verbosity', 'personality',
  'developer_instructions', 'file_opener', 'history.persistence', 'history.max_bytes', 'tui.'];
const projectAllowed = key => PROJECT_ALLOWED.some(name => key === name || (name.endsWith('.') && key.startsWith(name)));
// Each key path that one layer sets, from the layer's own config tree: a table with keys goes on to each key; an
// empty table, a list (empty or not) and a value are one path each. A list replaces the list of a lower layer, so
// an empty list from the project can clear an owner list, and then config/read names no origin for it (R1575-1).
// An empty table merges nothing, so one on the way to an allowed key passes (a [tui] header with no keys).
function checkLayer(value, path, origin, home) {
  const table = value !== null && typeof value === 'object' && !Array.isArray(value);
  if (table && Object.keys(value).length) { for (const [key, item] of Object.entries(value)) checkLayer(item, `${path}.${key}`, origin, home); return; }
  if (projectAllowed(path) || (table && PROJECT_ALLOWED.some(name => name.startsWith(`${path}.`)))) return;
  requireOwner(path, origin, home);
}
// An MCP server or a hook event is one entry of its table, so the message names the entry, not one of its fields.
const ENTRIES = new Set(['mcp_servers', 'hooks']);
function requireOwner(key, origin, home) {
  if (OWNER_LAYERS.has(origin?.name?.type)) return;
  // config/read names a list item by its index (sandbox_workspace_write.writable_roots.0); the owner edits the list.
  const [table, entry] = key.split('.');
  const name = ENTRIES.has(table) && entry ? `${table}.${entry}` : key.replace(/(\.[0-9]+)+$/, '');
  throw refuse('selection-origin', `The setting ${name} comes from ${layer(origin)}. An agent can change project files, so the client takes only the model and text settings (such as model_reasoning_effort) from the project, and every other setting only from your Codex config, a managed config or the launch flags. ${checkIt(`the setting ${name}`, 'it', 'config.toml', home)}`);
}
const FORK = `Use the fork binary of version ${CONTROLLER_VERSION}, ${RESTART}`;
// config/read gives a key that no layer sets as null with no origin: the controller uses its default.
function configured(config, origins, key) {
  const value = effective(config, key);
  return value === null && !origins[key] ? undefined : value;
}

/**
 * Pure. Checks the config/read reply before thread/start, because thread/start already starts the MCP servers: each
 * owned launch key has its value from the launch flags, and each layer that is not the owner's sets only the keys
 * that PROJECT_ALLOWED names. The origins of the merged config are a second check. Returns the config and its
 * origins, or throws a refusal with a fixed code.
 */
export function checkConfig(read, home = '') {
  const config = read?.config, origins = read?.origins, layers = read?.layers;
  if (!config || typeof config !== 'object' || !origins || typeof origins !== 'object' || !Array.isArray(layers)) throw refuse('policy-missing', `The controller gave no config layers. ${FORK}.`);
  for (const [key, required] of Object.entries(OWNED_CONTROLLER_CONFIG)) {
    // A structured feature (such as features.multi_agent_v2) can be a table: its switch and origin are at `.enabled`.
    const switchKey = Object.hasOwn(origins, `${key}.enabled`) ? `${key}.enabled` : key;
    const value = effective(config, switchKey) ?? effective(config, key);
    if (value === undefined || !Object.hasOwn(origins, switchKey)) throw refuse('policy-missing', `The controller did not report the setting ${key}. ${FORK}.`);
    if (origins[switchKey]?.name?.type !== 'sessionFlags') throw refuse('policy-origin', `The setting ${key} comes from ${layer(origins[switchKey])}, not from the launch flags of the client. Remove ${key} from there, ${RESTART}.`);
    if (value !== required) throw refuse('policy-value', `The setting ${key} is ${JSON.stringify(value)}, but the client needs ${JSON.stringify(required)}. ${FORK}.`);
  }
  for (const item of layers) if (!OWNER_LAYERS.has(item?.name?.type)) for (const [key, value] of Object.entries(item.config ?? {})) checkLayer(value, key, item, home);
  for (const [key, origin] of Object.entries(origins)) if (!projectAllowed(key)) requireOwner(key, origin, home);
  // Each missing key in one refusal, so that the owner fixes them all before one restart.
  const missing = SELECTION.filter(([, key, , owned]) => owned && configured(config, origins, key) === undefined).map(([, key]) => key);
  if (missing.length) throw refuse('selection-missing', `Your Codex config does not set ${missing.join(' and ')}. Set ${missing.length > 1 ? 'them' : 'it'} in your Codex config (${homePath(home, 'config.toml')}), for example ${missing.map(key => `${key} = ${EXAMPLE[key]}`).join(' and ')}, ${RESTART}.`);
  for (const [, key, , owned] of SELECTION) if (owned) requireOwner(key, origins[key], home);
  return {config, origins};
}

/** Pure. Returns the frozen policy record with its binding hash, or throws a refusal with a fixed code. */
export function bindPolicy({binary, args, initialize, config: read, thread: reply, task}) {
  const {config, origins} = checkConfig(read);
  const thread = reply?.thread;
  if (thread?.cliVersion !== CONTROLLER_VERSION) throw refuse('version', `The controller is version ${String(thread?.cliVersion ?? 'unknown')}, but this client needs ${CONTROLLER_VERSION}. Set SAGE_CODEX_CONTROLLER_BIN to the fork binary of version ${CONTROLLER_VERSION}, ${RESTART}.`);
  const mismatch = `The controller does not behave as the fork of version ${CONTROLLER_VERSION}: ${FORK}.`;
  if (thread.ephemeral !== true) throw refuse('not-ephemeral', `The chief's thread is not ephemeral. ${mismatch}`);
  if (thread.parentThreadId !== null) throw refuse('not-root', `The chief's thread is not a root thread. ${mismatch}`);
  if (thread.cwd !== task.project) throw refuse('cwd', `The chief's thread runs in ${String(thread.cwd)}, not in the project ${task.project}. ${mismatch}`);
  if (typeof thread.id !== 'string' || thread.id === '') throw refuse('not-root', `The chief's thread has no id. ${mismatch}`);
  const selection = {};
  for (const [name, key, expect] of SELECTION) {
    const observed = reply[name];
    const value = configured(config, origins, key);
    if (value === undefined) { selection[name] = {value: observed ?? null, origin: 'default'}; continue; }
    if (canonical(expect(value, observed)) !== canonical(observed)) throw refuse('selection-changed', `The chief's thread has ${name} ${JSON.stringify(observed)}, but your config sets ${key} to ${JSON.stringify(value)}. ${mismatch}`);
    selection[name] = {value: observed, origin: origins[key]?.name?.type ?? 'unknown'};
  }
  if (!HASH.test(binary?.sha256 ?? '')) throw refuse('binary', 'The binary hash is missing.');
  if (binary.expectedSha256 && binary.expectedSha256 !== binary.sha256) throw refuse('binary', 'The binary hash does not match SAGE_CODEX_CONTROLLER_SHA256.');
  const record = {
    binary: {path: binary.path, sha256: binary.sha256}, args: [...args], cliVersion: thread.cliVersion,
    userAgent: initialize?.userAgent ?? null, selection, multiAgentMode: reply.multiAgentMode ?? null,
    threadId: thread.id, project: task.project, task: task.task, run: task.run, instructionsSha256: task.instructionsSha256,
  };
  return deepFreeze({...record, bindingHash: sha256(canonical(record))});
}

const realOrNull = path => { try { return realpathSync(path); } catch { return null; } };
function upward(folder) { const folders = [folder]; while (folder !== dirname(folder)) folders.push(folder = dirname(folder)); return folders; }
// A linked Git worktree takes its hooks from the matching folder of its main checkout. That checkout is the folder
// above the common git folder that holds worktrees/<name>, which the .git file of the worktree names.
function mainCheckoutFolders(project) {
  const folders = upward(project);
  const checkout = folders.find(folder => existsSync(join(folder, '.git')));
  let gitDir;
  try { gitDir = realpathSync(resolve(checkout, /^gitdir: (.+)$/m.exec(readFileSync(join(checkout, '.git'), 'utf8'))[1].trim())); } catch { return []; }
  if (basename(dirname(gitDir)) !== 'worktrees') return [];
  const main = dirname(dirname(dirname(gitDir)));
  return folders.slice(0, folders.indexOf(checkout) + 1).map(folder => join(main, relative(checkout, folder)));
}

/**
 * Refuses the project files that Codex loads with no config key, so config/read never shows them: a rules file
 * (.codex/rules/*.rules) can let a command run with no approval or outside the sandbox, and a hooks file
 * (.codex/hooks.json) runs commands at hook events, and an agent role file (.codex/agents/**.toml) sets the config of
 * the agents that start with that role. Codex loads them from the .codex folder of each folder from the
 * project root down to the cwd, and the hooks of a linked worktree from its main checkout; the check covers each
 * folder up to the filesystem root. The .codex folder that is CODEX_HOME holds the owner's own rules and hooks.
 */
export function checkProjectFiles(project, env) {
  const home = codexHome(env), realHome = realOrNull(home);
  const why = 'An agent can change project files, so the client refuses the rules, hooks and agent role files of the project and of each folder above it.';
  const above = upward(project);
  for (const folder of new Set([...above, ...mainCheckoutFolders(project)])) {
    const dotCodex = join(folder, '.codex');
    if (realHome && realOrNull(dotCodex) === realHome) continue;
    const where = folder === project ? 'in the project' : above.includes(folder) ? 'in a folder above the project' : 'in the main checkout of the project worktree';
    let rules = [];
    try { rules = readdirSync(join(dotCodex, 'rules')).filter(name => name.endsWith('.rules')).sort(); }
    catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw refuse('project-files', `The client cannot read ${join(dotCodex, 'rules')} (${error.code}), so it cannot check it for rules files. Make the folder readable, or remove it, ${RESTART}.`); }
    if (rules.length) throw refuse('project-rules', `The rules file ${join(dotCodex, 'rules', rules[0])} is ${where}. A rule can let a command run with no approval or outside the sandbox. ${why} ${checkIt('the rules', 'them', 'rules/', home)}`);
    if (existsSync(join(dotCodex, 'hooks.json'))) throw refuse('project-hooks', `The hooks file ${join(dotCodex, 'hooks.json')} is ${where}. A hook runs a command at its event. ${why} ${checkIt('the hooks', 'them', 'hooks.json', home)}`);
    const role = roleFile(join(dotCodex, 'agents'));
    if (role) throw refuse('project-agents', `The agent role file ${role} is ${where}. A role sets the config of each agent that the chief starts with it: its instructions, model, sandbox and MCP servers. ${why} ${checkIt('the role', 'it', 'agents/', home)}`);
  }
}
// Codex reads each .toml file in the agents folder and in each folder below it as an agent role. A link to a folder
// counts as a folder; `seen` stops a walk that comes back to a folder. A link that points to itself, or a loop of
// links, cannot be read, so it refuses with the fix, as each other error does; a missing folder or a dead link passes.
function roleFile(folder, seen = new Set()) {
  const unreadable = error => refuse('project-files', `The client cannot read ${folder} (${error.code === 'ELOOP' ? 'a loop of links' : error.code}), so it cannot check it for agent role files. Make the folder readable, or remove it, ${RESTART}.`);
  let real, entries;
  try { real = realpathSync(folder); } catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null; throw unreadable(error); }
  if (seen.has(real)) return null;
  seen.add(real);
  try { entries = readdirSync(folder, {withFileTypes: true}).sort((a, b) => (a.name < b.name ? -1 : 1)); }
  catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null; throw unreadable(error); }
  for (const entry of entries) {
    const path = join(folder, entry.name);
    if (entry.name.endsWith('.toml')) return path;
    if (entry.isDirectory() || entry.isSymbolicLink()) { const found = roleFile(path, seen); if (found) return found; }
  }
  return null;
}

function agentText(items) {
  const messages = Array.isArray(items) ? items.filter(item => item?.type === 'agentMessage' && typeof item.text === 'string') : [];
  return messages.length ? messages.at(-1).text : null;
}
// A Map, not an object literal: a status such as "constructor" or "__proto__" must not find a prototype member.
const TERMINAL = new Map([['completed', 'completed'], ['interrupted', 'interrupted'], ['failed', 'failed']]);

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
  const result = TERMINAL.get(params.turn.status) ?? 'uncertain';
  next.lastAgentMessage = agentText(params.turn.items) ?? next.itemAgentMessage;
  return decide(result, result === 'failed' ? (params.turn.error ?? null) : result === 'uncertain' ? {reason: `Unknown turn status ${String(params.turn.status)}`} : null);
}
