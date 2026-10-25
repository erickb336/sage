import {createHash} from 'node:crypto';
import {closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync, realpathSync, statSync} from 'node:fs';
import {dirname, isAbsolute, join, resolve} from 'node:path';
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
function requireOwner(key, origin, home) {
  if (OWNER_LAYERS.has(origin?.name?.type)) return;
  // config/read names a list item by its index (sandbox_workspace_write.writable_roots.0); the owner edits the list.
  const name = key.replace(/(\.[0-9]+)+$/, '');
  throw refuse('selection-origin', `The setting ${name} comes from ${layer(origin)}. The client takes each setting only from your Codex config, a managed config or the launch flags, because an agent can change the other layers. ${checkIt(`the setting ${name}`, 'it', 'config.toml', home)}`);
}

/**
 * Pure. The launch flag that marks the project folder and each folder above it, up to the filesystem root, as
 * untrusted: `-c projects={ "<folder>"={ trust_level="untrusted" }, ... }`. Codex then disables each project layer at
 * each config load, also the load at thread/start, so a project file that an agent writes at any time does not load.
 * A session flag is above the owner's own config, so it wins over a trust entry there. Each folder needs its own key,
 * because Codex gives each folder from the project root to the cwd its own trust decision, and a trusted folder above
 * the project would stay loaded. The inline table keeps each path one key: a dotted key splits a path at each dot.
 * A JSON string is a TOML basic string, except DEL, which TOML wants escaped.
 * Each spelling of the project gets its keys: the canonical one first (the cwd, as realpath(3) gives it, which is the
 * spelling that Codex looks up), then the spelling that the owner typed, when its letter case or Unicode form differs,
 * then each owner trust key that `otherSpellings` gives.
 */
export function projectTrustFlags(...spellings) {
  const keys = trustFolders(spellings).map(folder => `${JSON.stringify(folder).replaceAll('\x7f', '\\u007f')}={ trust_level="untrusted" }`);
  return ['-c', `projects={ ${keys.join(', ')} }`];
}
function trustFolders(spellings) {
  const folders = [];
  for (const project of spellings) {
    if (typeof project !== 'string' || !isAbsolute(project) || !project.isWellFormed()) throw refuse('project-path', `The project path ${JSON.stringify(project)} is not valid Unicode, so the client cannot write it in a Codex setting. Rename the folder to a valid name, or use another project folder, ${RESTART}.`);
    for (let folder = project; ; folder = dirname(folder)) {
      if (!folders.includes(folder)) folders.push(folder);
      if (folder === dirname(folder)) break;
    }
  }
  return folders;
}
// Letter case and Unicode form, folded. It can fold more than the file system does (ß and ss): an extra untrusted key
// names no folder of the project, so it changes nothing.
const fold = value => value.normalize('NFC').toUpperCase().toLowerCase().normalize('NFC');

/**
 * Pure. The keys of the owner's projects tables (the owner layers of the config/read reply) that name a folder of the
 * flag (the project, or a folder above it) in other letter case or Unicode form, and that the flag does not name. An
 * agent can rename a project folder to that spelling at thread/start, on a file system that ignores letter case and
 * Unicode form; Codex then looks up the new canonical spelling, and the owner's trust entry for it would apply (R1611-1).
 * So these keys go in the flag too.
 */
export function otherSpellings(read, spellings) {
  const flagged = trustFolders(spellings), folded = new Set(flagged.map(fold));
  const keys = (Array.isArray(read?.layers) ? read.layers : []).filter(item => OWNER_LAYERS.has(item?.name?.type))
    .flatMap(item => (item.config?.projects && typeof item.config.projects === 'object' ? Object.keys(item.config.projects) : []));
  return [...new Set(keys)].filter(key => !flagged.includes(key) && folded.has(fold(key)));
}
const FORK = `Use the fork binary of version ${CONTROLLER_VERSION}, ${RESTART}`;
// config/read gives a key that no layer sets as null with no origin: the controller uses its default.
function configured(config, origins, key) {
  const value = effective(config, key);
  return value === null && !origins[key] ? undefined : value;
}

/**
 * Pure. Checks the config/read reply before thread/start, because thread/start already starts the MCP servers: each
 * owned launch key has its value from the launch flags, no project layer is enabled, and each setting of the merged
 * config comes from a layer that an agent cannot write. Returns the config, its origins and the .codex folder of each
 * disabled project layer, or throws a refusal with a fixed code.
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
  // The launch flag marks the project untrusted, so each project layer is disabled. A managed config (above the
  // launch flags) can mark it trusted again; no trust entry of the owner did so in a probe (R1612-1).
  const projects = layers.filter(item => item?.name?.type === 'project');
  const enabled = projects.find(item => !item.disabledReason);
  if (enabled) throw refuse('project-trusted', `The controller loads the project config in ${enabled.name.dotCodexFolder}, although the client marks the project as untrusted. An agent can change that config. A managed config (/etc/codex/managed_config.toml, or one from your organization) can mark the project as trusted. Ask your administrator to remove that trust entry, ${RESTART}. If you have no managed config, look for a trust entry for this folder in your Codex config (${homePath(home, 'config.toml')}).`);
  for (const [key, origin] of Object.entries(origins)) requireOwner(key, origin, home);
  // Each missing key in one refusal, so that the owner fixes them all before one restart.
  const missing = SELECTION.filter(([, key, , owned]) => owned && configured(config, origins, key) === undefined).map(([, key]) => key);
  if (missing.length) throw refuse('selection-missing', `Your Codex config does not set ${missing.join(' and ')}. Set ${missing.length > 1 ? 'them' : 'it'} in your Codex config (${homePath(home, 'config.toml')}), for example ${missing.map(key => `${key} = ${EXAMPLE[key]}`).join(' and ')}, ${RESTART}.`);
  for (const [, key, , owned] of SELECTION) if (owned) requireOwner(key, origins[key], home);
  return {config, origins, projectFolders: projects.map(item => item.name.dotCodexFolder)};
}

// The project files of plain Codex (core/src/agents_md.rs). The project root is the nearest folder, from the cwd up,
// that has one of the owner's project_root_markers (default .git); a marker counts only when it is there, with links
// followed. With no root, or an empty marker list, only the cwd. In each folder from the root down to the cwd, the
// first name that is a regular file (links followed): AGENTS.override.md, AGENTS.md, then the owner's
// project_doc_fallback_filenames as written. All files together have at most project_doc_max_bytes (default 32 KiB).
const DOC_NAMES = ['AGENTS.override.md', 'AGENTS.md'];
const ROOT_MARKERS = ['.git'];
export const PROJECT_DOC_BYTES = 32 * 1024;
const KINDS = [['isDirectory', 'a folder'], ['isFIFO', 'a named pipe'], ['isSocket', 'a socket'], ['isCharacterDevice', 'a device'], ['isBlockDevice', 'a device']];
// The classes of the client's terminal filter (controller-client.mjs), except the line end and the tab.
const HIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/gu;
// An end mark of the section: "<", spaces, "/", spaces, INSTRUCTIONS, then anything up to ">". It is found in a folded
// copy of the text: each character in NFKD with no combining marks, in upper case. So a full-width form, other letter
// case and a dotted capital I match too (R1611-3). The lookahead keeps one mark from hiding the next one.
const END_MARK = /<(?=\s*\/\s*INSTRUCTIONS[^>]*>)/g;
function escapeEndMarks(text) {
  let folded = '';
  const from = [];
  for (let index = 0; index < text.length;) {
    const character = String.fromCodePoint(text.codePointAt(index));
    const form = character.normalize('NFKD').replace(/\p{M}/gu, '').toUpperCase();
    folded += form;
    for (let unit = 0; unit < form.length; unit++) from.push(index);
    index += character.length;
  }
  const starts = new Set([...folded.matchAll(END_MARK)].map(match => from[match.index]));
  let out = '', last = 0;
  for (const start of [...starts].sort((a, b) => a - b)) {
    out += `${text.slice(last, start)}&lt;`;
    last = start + String.fromCodePoint(text.codePointAt(start)).length;
  }
  return out + text.slice(last);
}
// The client writes each hidden character but the line end and the tab as U+FFFD, and the < of each end mark as &lt;,
// so that neither a file nor the project path can end the section (R1601-2, R1611-2).
const escape = text => escapeEndMarks(text.replace(HIDDEN, character => (character === '\n' || character === '\t' ? character : '�')));
const section = (project, texts) => `\n\n# AGENTS.md instructions for ${escape(project)}\n\n<INSTRUCTIONS>\n${texts.join('\n\n')}\n</INSTRUCTIONS>\n`;
// A marker counts when it is there; an error (a dead link too) counts as no marker, as in Codex.
const there = path => { try { statSync(path); return true; } catch { return false; } };
function docFolders(project, markers) {
  const chain = [];
  for (let folder = project; ; folder = dirname(folder)) {
    chain.unshift(folder);
    if (markers.some(marker => there(join(folder, marker)))) return chain;
    if (folder === dirname(folder)) return [project];
  }
}
// The first name that is a regular file. A name that is missing, or that is not a regular file (a folder, a named pipe
// or a dead link), gives the next name. Another error gives the path, so that its read gives a notice.
function docPath(folder, names) {
  for (const name of names) {
    const path = join(folder, name);
    try { if (statSync(path).isFile()) return path; } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') return path; }
  }
  return null;
}
// The candidate names, as in Codex: an empty name is skipped; a name with path syntax is skipped with a notice.
function docNames(fallback, notices) {
  const names = [...DOC_NAMES];
  for (const name of Array.isArray(fallback) ? fallback : []) {
    if (typeof name !== 'string' || name === '' || names.includes(name)) continue;
    if (name === '.' || name === '..' || /[/\0]/.test(name)) notices.push(`[The client ignores the name ${JSON.stringify(name)} in project_doc_fallback_filenames: it is not a file name.]`);
    else names.push(name);
  }
  return names;
}
// Reads at most `limit` + 1 bytes of one file, with no wait: a named pipe or a device is refused by the type of the
// open file. Returns {bytes}, or {why, fix} for a file that the chief does not get.
function readDoc(path, limit) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile()) return {why: `it is ${KINDS.find(([test]) => stat[test]())?.[1] ?? 'a special file'}, not a regular file`, fix: 'make it a regular file'};
    const buffer = Buffer.alloc(limit + 1);
    let size = 0;
    for (let read; size < buffer.length && (read = readSync(fd, buffer, size, buffer.length - size, null)) > 0;) size += read;
    return {bytes: buffer.subarray(0, size)};
  } catch (error) {
    // A file that went away after its check is no file, as in Codex.
    if (error.code === 'ENOENT') return {bytes: Buffer.alloc(0)};
    if (error.code === 'EACCES' || error.code === 'EPERM') return {why: 'you have no permission to read it', fix: `give yourself read permission (for example chmod u+r ${path})`};
    return {why: `the client cannot read it (error ${error.code})`, fix: 'make it readable'};
  } finally { if (fd !== undefined) closeSync(fd); }
}

/**
 * Codex does not load the project files (AGENTS.md) of an untrusted project, so the wrapper reads them once, after the
 * check of config/read, and adds them to the chief instructions in the form that Codex gives them. The thread/start
 * request has no field for the user-role project text that Codex sends, so they go in a marked developer section.
 * Each file keeps its line ends and tabs; each other hidden character becomes U+FFFD. A file that breaks a rule is left
 * out, with a notice. Returns {instructions, notices}.
 */
export function projectInstructions(project, read, instructions, home = '') {
  const config = read?.config ?? {}, origins = read?.origins ?? {};
  const max = configured(config, origins, 'project_doc_max_bytes');
  const limit = Number.isSafeInteger(max) && max >= 0 ? max : PROJECT_DOC_BYTES;
  const texts = [], notices = [];
  // A limit of 0 turns the project files off, as in Codex.
  if (!limit) return {instructions, notices};
  const names = docNames(configured(config, origins, 'project_doc_fallback_filenames'), notices);
  // An empty list is a list: it keeps the walk in the cwd. A value that is not a list of names gives the default, as in Codex.
  const given = configured(config, origins, 'project_root_markers');
  const markers = Array.isArray(given) && given.every(marker => typeof marker === 'string') ? given : ROOT_MARKERS;
  let left = limit;
  for (const folder of docFolders(project, markers)) {
    const path = docPath(folder, names);
    if (!path) continue;
    const leave = (why, fix) => notices.push(`[The session starts without the project file ${path}: ${why}. To give it to the chief, ${fix}, then start the client again.]`);
    const file = readDoc(path, Math.min(left, INSTRUCTION_BYTES));
    if (file.why) { leave(file.why, file.fix); continue; }
    const {bytes} = file;
    if (bytes.length > left) { leave(`with it, the project files have more than ${limit} bytes (project_doc_max_bytes)`, `shorten it, or raise project_doc_max_bytes in your Codex config (${homePath(home, 'config.toml')})`); continue; }
    if (bytes.includes(0)) { leave('it has a NUL character', 'remove the NUL character'); continue; }
    const text = bytes.toString('utf8');
    if (!text.trim()) continue;
    const clean = escape(text.replaceAll('\r\n', '\n').replace(/\n+$/, ''));
    if (Buffer.byteLength(instructions + section(project, [...texts, clean])) > INSTRUCTION_BYTES) { leave('with it, the chief instructions have more than 256 KiB', 'shorten it, or shorten the file that --instructions names'); continue; }
    texts.push(clean);
    left -= bytes.length;
  }
  return {instructions: texts.length ? instructions + section(project, texts) : instructions, notices};
}

/**
 * The notice for the .codex folders of the disabled project layers, or none. The controller's own warning says to
 * trust the project; under sage a trust entry changes nothing, so the client shows this notice instead. A folder that
 * holds only skills (and dot files) loses nothing under sage, so it is not named (R1602-1).
 */
export function settingsNotice(folders) {
  const named = folders.filter(folder => { try { return readdirSync(folder).some(name => name !== 'skills' && !name.startsWith('.')); } catch { return true; } });
  if (!named.length) return [];
  const list = named.length > 1 ? `${named.slice(0, -1).join(', ')} and ${named.at(-1)}` : named[0];
  return [`[This project has Codex settings in ${list}. They do not load under sage: the project config, rules, hooks and agent roles. Skills still load.]`];
}

/** Pure. Returns the frozen policy record with its binding hash, or throws a refusal with a fixed code. */
export function bindPolicy({binary, args, initialize, config: read, thread: reply, task}) {
  const {config, origins, projectFolders} = checkConfig(read);
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
    // The .codex folders whose settings did not load (each project layer is disabled).
    projectFolders,
  };
  return deepFreeze({...record, bindingHash: sha256(canonical(record))});
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
