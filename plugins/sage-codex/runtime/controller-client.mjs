#!/usr/bin/env node
import {closeSync, constants, existsSync, fstatSync, openSync, readFileSync, readlinkSync, realpathSync, statSync, writeSync} from 'node:fs';
import {basename, dirname, relative, resolve, sep} from 'node:path';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {bindTask, resolveControllerBinary} from './controller-binding.mjs';
import {createControllerProcess, defaultSchedule} from './controller-process.mjs';

const USAGE = [
  'Usage: SAGE_CODEX_CONTROLLER_BIN=<fork codex binary> node controller-client.mjs --project <folder> --task <T…> --run <R…> --instructions <file>',
  '  --project       the project folder; the chief works in it',
  '  --task, --run   the task and run ids, for example T400 and R1',
  '  --instructions  the file with the chief instructions',
];
const FLAGS = ['--project', '--task', '--run', '--instructions'];
// On a terminal, a paste of several lines is one line too: the owner presses Enter after it.
const howTo = terminal => `[Type a line and press Enter: the chief gets it as one turn.${terminal ? ' A paste of several lines is one line.' : ''} Ctrl-C clears the line, drops the lines that wait and stops the turn. Ctrl-D stops the controller.]`;
const NEXT = 'Type the next line, or press Ctrl-D to stop the controller.';
const RESTART = 'Start the client again.';
const WAITING = '[Waiting for the model. Press Ctrl-C to stop the turn.]';
// A turn with no event from the controller for this long shows WAITING, once.
const WAIT_MS = 15000;
// The output that may wait for a terminal that takes none (a paused or a stopped terminal). Past it, the client
// stops the turn and drops output until the terminal takes it again, so its memory stays bounded. The client's own
// result lines wait and show when the terminal takes output again, so each turn still shows how it ended.
const TERMINAL_QUEUE_BYTES = 8 * 1024 * 1024;
// In raw mode (a terminal on stdin) the terminal's own Ctrl-S is off, so only a pipe on stdin gets the Ctrl-Q hint.
const fullText = raw =>`[The terminal takes no output: more than 8 MiB waits for it. The client stopped the turn, and it drops output until the terminal takes output again.${raw ? '' : ' If you pressed Ctrl-S, press Ctrl-Q.'}]`;

// Controller text never reaches the terminal raw. Each of these characters becomes U+FFFD: the controls (C0, C1 and
// the newline too), the format characters (bidi controls, zero-width characters, tags, the soft hyphen), the line and
// paragraph separators, and every default-ignorable character (variation selectors, Hangul fillers). So the text
// cannot move the cursor, write the clipboard (OSC 52), hide or reorder what the owner sees, or start a line like the
// client's.
const CONTROL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/gu;
export const oneLine = text => String(text).replace(CONTROL, '�');

// The plain words for each reason that the controller process gives, so that one event has one wording.
const ENDED = 'the controller process ended by itself';
const REASONS = new Map([
  ['Owned process closed', ENDED], ['Owned stream closed', ENDED], ['Owned stream error', ENDED], ['Protocol stream ended', ENDED],
  ['Incomplete protocol stream', ENDED], ['Owned writer failed', ENDED], ['Startup failed', 'the controller did not start'],
  ['Owned process error', 'the controller process could not run'],
  ['Startup observation expired', 'the controller did not answer the start in time'],
  ['Inspection observation expired', 'the controller did not send its config in time'],
  ['Thread start observation expired', 'the controller did not start the chief in time'],
  ['Turn outcome uncertain', 'a turn result is unknown'],
  ['Event limit exceeded', 'the controller sent more events in one turn than the client keeps'],
  ['Event callback failed', 'the client could not show an event'],
  ['A second terminal event came for a turn that had ended', 'the controller sent a second result for a turn that had ended'],
  ['Invalid or oversized protocol frame', 'the controller sent a message that the client cannot read'],
  ['No terminal event within the interrupt grace', 'the controller did not end the turn after the client stopped it'],
  ['The turn/start reply has no turn id', 'the controller gave the turn no id'],
  ['Unchecked MCP server', 'the controller started an MCP server that is not in the config that the client checked (an agent may have added it to a .codex/config.toml file after the check); check the project config'],
]);
// A terminal in line mode keeps at most MAX_CANON bytes of one line (1024 on macOS), so a longer typed or pasted
// line never reaches the client. So on a terminal the client reads each key (raw mode) and keeps the line itself:
// Enter sends the line, Backspace removes the last character, Ctrl-C clears the line and is the same as SIGINT, and
// Ctrl-D on an empty line ends the input. It echoes only printable text and tabs; a key sequence (such as an arrow)
// and each other control character are ignored. Node's readline in terminal mode does this too, but it draws the
// line again at each wrap of the terminal width, so a paste of 12000 bytes into 80 columns takes minutes.
// Bracketed paste mode: the terminal puts PASTE_START and PASTE_END around a paste, and its line ends between them
// stay in the line as \n, so a paste of several lines is one turn at Enter (R1577-1).
export const PASTE_ON = '\x1b[?2004h', PASTE_OFF = '\x1b[?2004l';
const PASTE_START = '\x1b[200~', PASTE_END = '\x1b[201~';
// One key sequence (CSI, SS3, or Alt and a key), or one character.
const TOKEN = /\x1b(?:\[[0-?]*[ -/]*[@-~]|O.|.)?|./gsu;
// The start of a key sequence at the end of a read: its rest comes in the next read (R1575-4).
const PARTIAL = /\x1b(?:\[[0-?]*[ -/]*|O)?$/u;
// `line(text, pasted)` gets each line; `pasted` says that the line may hold text of a paste, so it cannot answer an
// approval request. Pasted text is the text between the paste marks and each key in a read that holds a paste mark: a
// terminal sends a paste in one burst, so a key in that read is not typed. Backspace can remove pasted text again
// (R1608-1). A line with a paste mark is pasted until a typed character comes after its last mark, and an end mark with
// no start mark before it (paste text that holds the end mark) makes the whole line pasted (R1616-5). `clear()` clears
// the typed line and drops the rest of the current read (only paste marks and Ctrl-C still act in it); it returns true
// when the typed line had text. `hold()` drops each later read in the same
// way until `release()`, which returns true when a dropped read had text.
function readTerminal(input, write, {line, interrupt, end}) {
  let text = '', afterReturn = false, pasting = false, pending = '', ended = false, dropping = false, held = false, heldText = false;
  // The index in `text` of the first pasted character, or -1; a paste mark with no typed character after it; an end mark
  // with no start mark; a paste mark in the current read.
  let firstPasted = -1, afterMark = false, forged = false, marked = false;
  const add = key => {
    const typed = !pasting && !marked;
    if (typed) afterMark = false; else if (firstPasted < 0) firstPasted = text.length;
    text += key;
  };
  const reset = () => { text = ''; firstPasted = -1; afterMark = false; forged = false; };
  input.setRawMode(true);
  input.setEncoding('utf8');
  write(PASTE_ON);
  input.on('data', chunk => {
    dropping = false;
    // An Escape key alone at the end of a read, with no sequence after it, is the Escape key only.
    let all = pending === '\x1b' && !/^[[O]/u.test(chunk) ? chunk : pending + chunk;
    pending = PARTIAL.exec(all)?.[0] ?? '';
    all = all.slice(0, all.length - pending.length);
    marked = all.includes(PASTE_START) || all.includes(PASTE_END);
    let echo = '';
    const show = () => { if (echo) write(echo); echo = ''; };
    for (const [key] of all.matchAll(TOKEN)) {
      if (key.startsWith('\x1b')) {
        if (key === PASTE_START || key === PASTE_END) { if (key === PASTE_END && !pasting) forged = true; pasting = key === PASTE_START; afterMark = true; }
        continue;
      }
      // Raw mode stays on until the client ends, so after the end of input Ctrl-C still stops the turn (R1577-3).
      if (ended) { if (key === '\x03') interrupt(false); continue; }
      const printable = key === '\t' || oneLine(key) === key;
      if (dropping || held) { if (key === '\x03' && !pasting) interrupt(false); else if (held && printable) heldText = true; continue; }
      // A paste can give \r\n: one line end.
      if (key === '\n' && afterReturn) { afterReturn = false; continue; }
      afterReturn = key === '\r';
      if (key === '\r' || key === '\n') {
        echo += '\n';
        if (pasting) { add('\n'); continue; }
        show(); const done = text, fromPaste = firstPasted >= 0 || afterMark || forged || marked; reset(); line(done, fromPaste);
      } else if (printable) { add(key); echo += key; }
      // A control character in a paste is text of the paste, not a key: the client drops it.
      else if (pasting) continue;
      // Ctrl-C clears the line, so that the next Enter never sends the cleared text (R1575-2).
      else if (key === '\x03') { const cleared = text !== ''; reset(); if (cleared) echo += '\n'; show(); interrupt(cleared); }
      else if (key === '\x04') { if (!text) { show(); ended = true; end(); } }
      else if (key === '\x7f' || key === '\b') {
        if (text) { text = text.replace(/.$/su, ''); echo += '\b \b'; if (text.length <= firstPasted) firstPasted = -1; }
      }
    }
    show();
  });
  return {
    clear() { const had = text !== ''; reset(); dropping = true; return had; },
    hold() { held = true; },
    release() { const had = heldText; held = false; heldText = false; return had; },
  };
}
// The process gives a lost request as "Connection closed; outcome uncertain: <reason>" or "<reason>; outcome uncertain".
const plain = text => {
  const reason = String(text).replace(/^Connection closed; outcome uncertain: /, '').replace(/; outcome uncertain$/, '');
  return REASONS.get(reason) ?? reason;
};

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const [flag, value] = [argv[index], argv[index + 1]];
    if (!FLAGS.includes(flag)) throw new Error(`${flag} is not an option of the client.`);
    if (typeof value !== 'string' || FLAGS.includes(value)) throw new Error(`${flag} needs a value.`);
    if (flag.slice(2) in args) throw new Error(`${flag} is given two times.`);
    args[flag.slice(2)] = value;
  }
  const missing = FLAGS.filter(flag => !(flag.slice(2) in args));
  if (missing.length) throw new Error(`The client needs ${missing.join(', ')}.`);
  return args;
}
function projectFolder(path) {
  let real;
  try { real = realpathSync(path); } catch { throw new Error(`The project folder ${path} does not exist. Give an existing folder with --project.`); }
  if (!statSync(real).isDirectory()) throw new Error(`${path} is not a folder. Give the project folder with --project.`);
  return real;
}
// A named pipe, a device or a folder is not an instructions file: a read of a pipe or a device can wait for ever. The
// open does not wait (O_NONBLOCK), and the type check is on the open file, so a swap after the check changes nothing.
const KINDS = [['isDirectory', 'a folder'], ['isFIFO', 'a named pipe'], ['isSocket', 'a socket'], ['isCharacterDevice', 'a device'], ['isBlockDevice', 'a device']];
function instructionsText(path) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw Object.assign(new Error(), {kind: KINDS.find(([test]) => stat[test]())?.[1] ?? 'a special file'});
    return readFileSync(fd, 'utf8');
  } catch (error) {
    if (error.kind) throw new Error(`The instructions file ${path} is ${error.kind}, not a regular file. Give the chief instructions file with --instructions.`);
    throw new Error(error.code === 'ENOENT' ? `The instructions file ${path} does not exist. Give the chief instructions file with --instructions.` : `The client cannot read the instructions file ${path} (${error.code}). Give a file that you can read with --instructions.`);
  } finally { if (fd !== undefined) closeSync(fd); }
}
// The thread reply gives the sandbox as {type: 'readOnly'}; the owner's config says read-only. A config value is
// quoted (JSON escapes a quote in it), so a model name such as `x, approval never` cannot look like a client field.
const shown = value => (typeof value?.type === 'string' ? JSON.stringify(value.type.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`))
  : JSON.stringify(value) ?? 'none');
const why = error => plain(error?.message ?? error?.reason ?? (error ? JSON.stringify(error) : 'the controller gave no reason'));

// `then` gives what comes after the turn: that the controller stops now, the fix for this line, or the next step.
// The next step is left out when a typed line waits (that line says that it starts); a fix is never left out.
function turnLine(result, then, terminalFull) {
  if (result.state === 'completed') return '[Turn completed.]';
  if (result.state === 'not-sent') return `[The client did not send the line: ${why(result.error)}${then('Shorten or correct the line, then type it again.', true)}]`;
  if (result.state === 'interrupted') return result.timedOut ? `[The turn reached its time limit, so the client stopped it.${then(NEXT)}]`
    : terminalFull ? `[The client stopped the turn, because the terminal took no output.${then(NEXT)}]` : `[You stopped the turn.${then(NEXT)}]`;
  if (result.state === 'failed') return `[The turn failed: ${why(result.error)}.${then('Type the line again to try again, or press Ctrl-D to stop the controller.', true)}]`;
  if (result.state === 'refused') return `[The controller refused the turn: ${why(result.error)}.${then('Change the line, then type it again.', true)}]`;
  return `[The result of the turn is unknown: ${why(result.error)}. No later line can run. Check the project for changes from this turn. ${RESTART}]`;
}
// Approvals. The owner answers each one with y or n, and the client replies only accept or decline (for a permission
// request: the asked permissions for this turn, or none). It never offers or sends a lasting choice: no
// acceptForSession, no amendment from availableDecisions, no session scope and no persist value.
const ASK = 'Type y to allow it once, or n to refuse it.';
const YES = new Set(['y', 'yes']), NO = new Set(['n', 'no']);
const CLEARED = '[The client cleared your typed text, because an approval request came. Type it again after you answer.]';
const NOT_SENT = '[Your line did not go to the chief, because an approval request waits. Answer it, then type your line again.]';
const PASTED = '[A pasted line cannot answer an approval request, and it did not go to the chief. Type y or n.]';
const NO_QUESTION = '[No approval request waits, so your line did not go to the chief. To answer the chief, type yes or no.]';
// Terminal input in the first SETTLE_MS after a question first shows is dropped, so a key that the owner pressed
// before the question came never answers it (R1606-4).
const SETTLE_MS = 300;
const SETTLED = '[The client dropped the keys that you pressed as the approval request showed. Read it, then type y or n.]';
const isText = value => typeof value === 'string' && value !== '';
// The shown values. Every value is JSON with each character outside printable ASCII (0x20 to 0x7E) as \uXXXX (a
// surrogate pair as two escapes), so each shown character is 1 column and no value can hold a line end, a look-alike
// letter or a wide or zero-width character. A run of 3 or more spaces shows as its count outside the quotes:
// "a" (40 spaces) "b". Inside a JSON string a quote has a backslash, so a value cannot hold that form.
const units = text => text.replace(/[^\x20-\x7e]/g, unit => `\\u${unit.charCodeAt(0).toString(16).padStart(4, '0')}`);
const spaced = text => text.replace(/ {3,}/g, run => `" (${run.length} spaces) "`);
const asCode = text => spaced(units(JSON.stringify(String(text))));
// An agent name or a thread id shows with no quotes, escaped as in a JSON string.
const asName = text => units(JSON.stringify(String(text)).slice(1, -1));
// A shown escape: \u after an odd count of backslashes. A block with one gets the note line.
const ESCAPE = /(?:^|[^\\])(?:\\\\)*\\u[0-9a-f]{4}/;
const NOTE = ['note', '\\uXXXX is one character, shown as its code.'];
// A value over LIMIT characters, or a request with over MAX_ITEMS files, moves or access items, is not shown: the
// client refuses it with the reason.
const LIMIT = 2000, MAX_ITEMS = 50;
const TOO_LONG = {why: `a value in the request is over ${LIMIT} characters`}, TOO_MANY = {why: `the request lists more than ${MAX_ITEMS} items`};
const long = value => { const text = String(value); if (text.length > LIMIT) throw TOO_LONG; return text; };
const code = value => asCode(long(value));
const json = value => (value == null ? 'not in the request' : spaced(units(long(JSON.stringify(value)))));
const cut = text => (text.length > LIMIT ? `${text.slice(0, LIMIT)}… (cut at ${LIMIT} characters)` : text);
// The client wraps each line of a question block itself, at the terminal width: the first row starts as the line does,
// and each later row starts with GUTTER. Each character is 1 column, so the rows are exact, and no value row starts at
// column 0 or with a field name.
const GUTTER = '  | ';
const wrapped = (line, columns) => {
  const width = Math.max(columns, GUTTER.length + 1), rows = [line.slice(0, width)];
  for (let at = width; at < line.length; at += width - GUTTER.length) rows.push(GUTTER + line.slice(at, at + width - GUTTER.length));
  return rows;
};
// The real path of a path that may not exist yet: the real path of its longest existing part, then the rest. A link
// whose target does not exist is followed too (at most 40 links, as the system follows).
function realOf(full, links = 0) {
  for (let head = full, rest = []; ;) {
    try { return resolve(realpathSync(head), ...rest); } catch {
      let target;
      try { target = readlinkSync(head); } catch { /* Not a link. */ }
      if (target !== undefined && links < 40) return realOf(resolve(dirname(head), target, ...rest), links + 1);
      if (dirname(head) === head) return full;
      rest.unshift(basename(head)); head = dirname(head);
    }
  }
}
// The paths of one request. A path inside the project shows relative to it, and the block then ends with a line that
// says so; the project folder itself shows as "the project folder"; a path outside it, after its `..` parts resolve, is
// absolute. A path inside the project that a link takes out of it shows the link target too (R1606-5).
function pathsOf(project) {
  const inside = path => path === project || path.startsWith(`${project}${sep}`);
  let relativeShown = false;
  const show = (path, base = project) => {
    const full = resolve(base, long(path));
    if (full === project) return 'the project folder';
    if (!inside(full)) return code(full);
    relativeShown = true;
    const real = realOf(full);
    return `${code(relative(project, full))}${inside(real) ? '' : ` (a link to ${code(real)}${existsSync(real) ? '' : ', which does not exist yet'})`}`;
  };
  return {show, footer: () => (relativeShown ? [['paths', 'relative to the project folder']] : [])};
}
// A list of paths: null or missing is none; anything else that is not a list of paths cannot be read (undefined).
const pathList = value => (value == null ? [] : Array.isArray(value) && value.every(isText) ? value : undefined);
const SPECIAL = {root: 'the whole disk', minimal: 'the system files that every command needs', tmpdir: 'your temporary folder'};
// A special path of the fork (FileSystemSpecialPath): the project roots and /tmp are paths, the others plain names.
function target(path, paths, cwd) {
  if (path?.type === 'path' && isText(path.path)) return paths.show(path.path);
  if (path?.type === 'glob_pattern' && isText(path.pattern)) return `the files that match ${code(path.pattern)}`;
  const value = path?.type === 'special' ? path.value : undefined, subpath = value?.subpath;
  if (subpath != null && !isText(subpath)) return undefined;
  if (value?.kind === 'project_roots' || value?.kind === 'current_working_directory') return paths.show(subpath ?? '.', cwd);
  if (value?.kind === 'slash_tmp') return paths.show('/tmp');
  if (value?.kind === 'unknown' && isText(value.path)) return `an unknown special path ${code(value.path)}${subpath ? `, subpath ${code(subpath)}` : ''}`;
  return Object.hasOwn(SPECIAL, value?.kind ?? '') && subpath == null ? SPECIAL[value.kind] : undefined;
}
// The access items of a permission profile, each as "<target> (<access>)"; undefined when one cannot be read. A legacy
// read or write root that only repeats an entry shows once.
function accessItems(profile, paths, cwd) {
  const fileSystem = profile?.fileSystem ?? {};
  const entries = fileSystem.entries == null ? [] : fileSystem.entries, read = pathList(fileSystem.read), write = pathList(fileSystem.write);
  if (!Array.isArray(entries) || !read || !write) return undefined;
  if (entries.length + read.length + write.length > MAX_ITEMS) throw TOO_MANY;
  const items = profile?.network?.enabled === true ? ['the network'] : [];
  for (const entry of entries) {
    const shown = target(entry?.path, paths, cwd);
    if (!shown || !['read', 'write', 'deny'].includes(entry.access)) return undefined;
    items.push(`${shown} (${entry.access})`);
  }
  items.push(...read.map(path => `${paths.show(path)} (read)`), ...write.map(path => `${paths.show(path)} (write)`));
  return [...new Set(items)];
}
// The action of an approval request, for its question and for each line that refuses it.
function actionOf(method, params) {
  if (method === 'item/commandExecution/requestApproval') {
    return params.networkApprovalContext != null ? 'connect to a host' : params.kind === 'writeStdin' ? 'send input to a running command' : 'run a command';
  }
  if (method === 'item/fileChange/requestApproval') return 'change files';
  if (method === 'item/permissions/requestApproval') {
    const fileSystem = params.permissions?.fileSystem ?? {};
    const kinds = [params.permissions?.network?.enabled === true && 'network',
      ['read', 'write', 'entries'].some(key => (Array.isArray(fileSystem[key]) ? fileSystem[key].length : fileSystem[key] != null)) && 'file'];
    return `get ${kinds.filter(Boolean).join(' and ') || 'extra'} access`;
  }
  return 'use an MCP tool';
}
const DECISION = {accept: {decision: 'accept'}, decline: {decision: 'decline'}};
// The question id that the controller gives an MCP tool approval through requestUserInput, and its one-time option.
// The fork makes it as `mcp_tool_call_approval_<call id>` (core/src/mcp_tool_call.rs), after the mcpToolCall item of
// that call id started, and sends the request with that call id as its itemId.
const MCP_APPROVAL = 'mcp_tool_call_approval_', MCP_ALLOW = 'Allow', MCP_CANCEL = 'Cancel';
const emptySchema = schema => schema?.type === 'object' && schema.properties && typeof schema.properties === 'object'
  && !Object.keys(schema.properties).length && (schema.required == null || (Array.isArray(schema.required) && !schema.required.length));
/**
 * What one server request asks, as `{action, fields, accept, decline}`: the action and the fields of the question
 * block, and the two replies. `{refused}` is a request that the client refuses with that line. Null is an approval
 * request that the client cannot read. It throws TOO_LONG or TOO_MANY for a request too long to show.
 */
// The kinds of a file change (PatchChangeKind of the fork).
const CHANGE = {add: 'new', delete: 'delete', update: 'change'};
function approvalOf(method, params, {files, calls, project}) {
  const action = actionOf(method, params), paths = pathsOf(project);
  const reason = isText(params.reason) ? [['reason', code(params.reason)]] : [];
  const items = (name, list) => list.map(item => [name, item]);
  // The fields end with the line on relative paths, so `shown` is called after the fields are made.
  const shown = (fields, accept = DECISION.accept, decline = DECISION.decline) => ({action, fields: [...fields, ...paths.footer()], accept, decline});
  if (method === 'item/commandExecution/requestApproval') {
    const cwd = isText(params.cwd) ? resolve(project, params.cwd) : project;
    const access = accessItems(params.additionalPermissions, paths, cwd), host = params.networkApprovalContext;
    if (!access) return null;
    if (host != null) {
      if (!isText(host.host) || !isText(host.protocol)) return null;
      const command = isText(params.command) ? [['command', code(params.command)]] : [];
      const folder = isText(params.cwd) ? [['folder', paths.show(params.cwd)]] : [];
      return shown([['host', `${code(host.host)}, protocol ${code(host.protocol)}`], ...command, ...folder, ...reason, ...items('access', access)]);
    }
    if (!isText(params.command) || !isText(params.cwd)) return null;
    return shown([['command', code(params.command)], ['folder', paths.show(params.cwd)], ...reason, ...items('access', access)]);
  }
  if (method === 'item/fileChange/requestApproval') {
    // The files come from the fileChange item of item/started: with no such item, the client cannot say what y allows.
    const changes = files.get(params.itemId);
    if (!changes?.length) return {refused: 'asked to change files, but the client does not know which files, so the client refused it'};
    if (params.grantRoot != null || !changes.every(change => isText(change?.path) && Object.hasOwn(CHANGE, change.kind?.type ?? '')
      && (change.kind.move_path == null || (change.kind.type === 'update' && isText(change.kind.move_path))))) return null;
    if (changes.reduce((count, change) => count + (change.kind.move_path == null ? 1 : 2), 0) > MAX_ITEMS) throw TOO_MANY;
    // Each file shows its kind of change, and a move shows its target under its file.
    const fields = changes.flatMap(change => [['file', `${paths.show(change.path)} (${CHANGE[change.kind.type]})`],
      ...(change.kind.move_path == null ? [] : [['moves to', paths.show(change.kind.move_path)]])]);
    return shown([...fields, ...reason]);
  }
  if (method === 'item/permissions/requestApproval') {
    if (!isText(params.cwd)) return null;
    const access = accessItems(params.permissions, paths, resolve(project, params.cwd));
    if (!access?.length) return null;
    const asked = Object.fromEntries(['network', 'fileSystem'].filter(key => params.permissions[key]).map(key => [key, params.permissions[key]]));
    return shown([['folder', paths.show(params.cwd)], ...reason, ...items('access', access)], {permissions: asked, scope: 'turn'}, {permissions: {}, scope: 'turn'});
  }
  if (method === 'mcpServer/elicitation/request') {
    // A tool approval asks only yes or no: a schema with a field is a form.
    if (params.mode !== 'form' || params._meta?.codex_approval_kind !== 'mcp_tool_call' || !emptySchema(params.requestedSchema)) {
      return {refused: `sent a form from the MCP server ${cut(asCode(params.serverName))}: ${cut(asCode(params.message))}. The client cannot show forms, so it refused the form`};
    }
    const reply = choice => ({action: choice, content: null, _meta: null});
    // The fork puts the tool arguments in _meta.tool_params.
    return shown([['server', code(params.serverName)], ['message', code(params.message)], ['arguments', json(params._meta.tool_params)]], reply('accept'), reply('decline'));
  }
  if (method === 'item/tool/requestUserInput') {
    const questions = Array.isArray(params.questions) ? params.questions : [];
    const [question] = questions;
    const call = calls.get(params.itemId);
    if (questions.length !== 1 || call?.threadId !== params.threadId || question?.id !== `${MCP_APPROVAL}${params.itemId}`
      || !question.options?.some?.(option => option.label === MCP_ALLOW)) {
      // The question text shows cut at LIMIT characters, so a long question still shows what it asked.
      const text = cut(questions.map(each => asCode(each?.question ?? '')).join(', '));
      return {refused: `asked you ${questions.length === 1 ? 'a question' : `${questions.length} questions`}: ${text}. The client cannot show questions, so it refused ${questions.length === 1 ? 'it' : 'them'}. The agent goes on without your answer`};
    }
    const reply = label => ({answers: {[question.id]: {answers: [label]}}});
    return shown([['server', code(call.server)], ['tool', code(call.tool)], ['message', code(question.question)], ['arguments', json(call.arguments)]],
      reply(MCP_ALLOW), reply(MCP_CANCEL));
  }
  return {refused: 'sent a request that is not an approval request, so the client refused it'};
}
// The agent of a thread: the chief for the root thread, else its agent path (from thread/started or an item).
function agentPathOf(params) {
  const thread = params.thread, spawn = thread?.source?.subAgent?.thread_spawn;
  if (isText(thread?.id) && isText(spawn?.agent_path ?? thread.agentNickname)) return [thread.id, spawn?.agent_path ?? thread.agentNickname];
  if (isText(params.item?.agentThreadId) && isText(params.item.agentPath)) return [params.item.agentThreadId, params.item.agentPath];
  return null;
}

/**
 * The owner's terminal client. Each typed line is one turn on the chief's thread, run one at a time; a line typed
 * during a turn waits. `classify` (commands.mjs) labels the mode phrases; the line itself goes to the chief unchanged.
 * `onSignal` gets the handler for SIGINT, SIGTERM and SIGHUP; SIGHUP means that the terminal is lost (the entry also
 * gives it for an EIO or EPIPE on the terminal). Returns the exit code: 0 only after a stop that the owner asked for
 * (end of input, Ctrl-C or SIGTERM), 1 after a refusal, a crash, an unknown turn result or a lost terminal.
 */
export async function runClient({argv, env, input, output, classify, onSignal = () => {}, spawn, schedule}) {
  // The stop: end of input, a second Ctrl-C, SIGTERM, or a lost terminal (SIGHUP). Each wakes the loop below.
  let ready = false, stopAsked = false, inputEnded = false, turnActive = false, hinted = false, wake = () => {};
  // After the terminal is lost, a write gives EIO or EPIPE, so the client writes nothing more.
  let terminalLost = false, terminalFull = false, fullStop = false, dropped = false, owner;
  // The client's result lines that wait while the terminal takes no output (`keep`); other output is dropped then.
  const held = [];
  const write = (text, keep = false) => {
    if (terminalLost) return;
    if ((output.writableLength ?? 0) > TERMINAL_QUEUE_BYTES) {
      if (keep) held.push(text); else dropped = true;
      if (terminalFull) return;
      terminalFull = true;
      output.write(`${fullText(input.isRaw)}\n`);
      // The stream says 'drain' when the terminal took all that waited: the held lines show then.
      output.once?.('drain', () => write(''));
      if (turnActive && !fullStop) { fullStop = true; owner.interrupt().catch(() => {}); }
      return;
    }
    terminalFull = false;
    const all = held.splice(0).join('') + text;
    if (all) output.write(all);
  };
  // After any other output while an approval request waits (a chief line, a child line, a notice), its question block
  // shows again, so that the question is the last text on the screen when the owner answers.
  let blockLast = false, reshow = false;
  const printed = () => {
    blockLast = false;
    if (!questions.length || reshow) return;
    reshow = true;
    queueMicrotask(() => { reshow = false; if (questions.length && !blockLast) ask(); });
  };
  const say = (...lines) => { for (const line of lines) { write(`${oneLine(line)}\n`); printed(); } };
  const tell = line => { write(`${oneLine(line)}\n`, true); printed(); };
  // The line ends at the end of a message give no empty chief line (R1578-1).
  const chief = text => { for (const line of String(text).replace(/(\r?\n)+$/, '').split(/\r?\n/)) write(`chief> ${oneLine(line)}\n`); printed(); };
  // A controller text of several lines gives several lines, each with the prefix, so no line of it looks like the client's.
  const framed = (prefix, text, suffix) => {
    const lines = String(text).split(/\r?\n/).filter(line => line.trim());
    if (!lines.length) lines.push('');
    lines.forEach((line, index) => say(`[${prefix}${line}${index === lines.length - 1 ? suffix : ''}]`));
  };
  // While a turn runs, each controller event starts the wait again; after WAIT_MS with no event, the client says so once.
  const timer = schedule ?? defaultSchedule;
  let cancelWait = () => {}, waited = false;
  // While an approval request waits for the owner, the turn waits for the owner, not for the model.
  const questions = [];
  const awaitModel = () => { cancelWait(); cancelWait = waited || questions.length ? () => {} : timer(() => { waited = true; say(WAITING); }, WAIT_MS); };
  let args, binary, project, instructions;
  try {
    args = parseArgs(argv);
    binary = resolveControllerBinary(env);
    project = projectFolder(args.project);
    instructions = instructionsText(args.instructions);
    bindTask({project, task: args.task, run: args.run, instructions}, project);
  } catch (error) {
    say(`[The client did not start: ${error.message}]`);
    if (!args) say(...USAGE);
    return 1;
  }
  say(`[Controller binary: ${binary.path}, sha256 ${binary.sha256}.]`);
  if (!binary.expectedSha256) say('[Warning: SAGE_CODEX_CONTROLLER_SHA256 is not set, so the client did not compare the binary with a known hash. To pin this binary, set it to the hash above.]');

  let rootThread = null;
  const warned = new Set();
  const warnOnce = (...parts) => { const key = parts.join('\0'); if (!warned.has(key)) { warned.add(key); framed(...parts); } };
  // `questions` holds the approval requests that wait for the owner, in order; the first one shows. `agents` names
  // each child thread, and `files` keeps the changes of each file change item until its end.
  // `calls` keeps the server, tool and arguments of each mcpToolCall item until its end. A thread with no known name is
  // never the chief. An agent name and a thread id show escaped, with no quotes.
  const agents = new Map(), files = new Map(), calls = new Map();
  const agent = threadId => (isText(threadId) && threadId === rootThread ? '/root (the chief)' : agents.has(threadId) ? asName(agents.get(threadId))
    : isText(threadId) ? `(unknown child ${asName(threadId)})` : '(an unknown agent with no thread id)');
  // The reader of a terminal on stdin; it clears the typed line when a question shows.
  let terminal = null, cancelSettle = () => {};
  // Each show of a question checks that it fits the terminal at its size then. The block, the note above it (its rows
  // are kept free on each show) and the input line below it must fit the rows of the terminal, so the real first line
  // of the block is on the screen when the owner answers, and no value can push it off and draw a fake one (R1606-1,
  // R1616-2). A block that does not fit is refused at once. Each show clears the typed line and drops the rest of the
  // current terminal read, so no text typed or pasted before the question can answer it. The first show of a question
  // also drops the terminal input of the next SETTLE_MS, with a note if it had text.
  const ask = () => {
    if (!questions.length) return;
    cancelWait();
    const [question] = questions;
    const columns = output.columns > 0 ? output.columns : 80, height = output.rows > 0 ? output.rows : 24;
    const rows = question.block.flatMap(line => wrapped(line, columns)), need = rows.length + Math.ceil(CLEARED.length / columns) + 1;
    if (need > height) {
      answer(false, `[Agent ${question.name} asked to ${question.action}, but the request needs ${need} rows and your terminal shows ${height}, so the client refused it. Make the terminal window larger to see such a request.]`);
      return;
    }
    const cleared = terminal?.clear() ?? false;
    if (cleared) write('\n');
    for (const row of [...(cleared ? [CLEARED] : []), ...rows]) write(`${row}\n`);
    blockLast = true;
    if (terminal && !question.shown) {
      cancelSettle(); terminal.hold();
      cancelSettle = timer(() => { cancelSettle = () => {}; if (terminal.release()) say(SETTLED); }, SETTLE_MS);
    }
    question.shown = true;
  };
  function answer(allow, said = allow ? '[You allowed it once.]' : '[You refused it.]') {
    const question = questions.shift();
    owner.answer(question.id, allow ? question.accept : question.decline);
    say(said);
    if (questions.length) ask(); else if (turnActive) awaitModel();
  }
  // Ctrl-C, the end of input and a stop refuse each request that waits.
  const declineAll = cause => {
    const waiting = questions.splice(0);
    for (const question of waiting) owner.answer(question.id, question.decline);
    if (waiting.length) say(`[${cause}, so the client refused ${waiting.length === 1 ? 'the approval request' : `the ${waiting.length} approval requests`}.]`);
  };
  function serverRequest({id, method, params = {}}) {
    const name = agent(params.threadId);
    const tooBig = why => { owner.refuse(id); say(`[Agent ${name} asked to ${actionOf(method, params)}, but ${why}, so the client refused it.]`); };
    let found;
    try { found = approvalOf(method, params, {files, calls, project}); } catch (error) {
      if (error !== TOO_LONG && error !== TOO_MANY) throw error;
      tooBig(error.why);
      return;
    }
    if (!found || found.refused) {
      owner.refuse(id);
      say(found ? `[Agent ${name} ${found.refused}.]` : `[Agent ${name} asked to ${actionOf(method, params)}, but the client cannot read the request, so the client refused it.]`);
      return;
    }
    // After the end of input or a stop, no answer can come: the client refuses the request and shows no question.
    if (stopAsked || inputEnded) {
      owner.answer(id, found.decline);
      say(`[${stopAsked ? 'The controller stops' : 'Your input ended'}, so the client refused the approval request of agent ${name}.]`);
      return;
    }
    // Every line of the block is printable ASCII. A block with an escape says what an escape is.
    const fields = found.fields.some(([, value]) => ESCAPE.test(value)) || ESCAPE.test(name) ? [...found.fields, NOTE] : found.fields;
    const block = [`[Approval: agent ${name} asks to ${found.action}.]`, ...fields.map(([field, value]) => `  ${field}: ${value}`), ASK];
    questions.push({id, name, action: found.action, block, accept: found.accept, decline: found.decline});
    if (questions.length === 1) ask();
  }
  owner = createControllerProcess({executable: binary.path, executableSha256: binary.sha256, cwd: project,
    env: Object.fromEntries(Object.entries(env).filter(([, value]) => typeof value === 'string')),
    onEvent(event) {
      if (turnActive) awaitModel();
      const params = event.message.params ?? {};
      const named = agentPathOf(params);
      // The first name of a thread stays; no event renames the chief.
      if (named && named[0] !== rootThread && !agents.has(named[0])) agents.set(...named);
      const item = params.item;
      if (event.method === 'item/started' && item?.type === 'fileChange') files.set(item.id, Array.isArray(item.changes) ? item.changes : []);
      if (event.method === 'item/started' && item?.type === 'mcpToolCall' && isText(item.id)) calls.set(item.id, {threadId: params.threadId, server: item.server, tool: item.tool, arguments: item.arguments});
      if (event.method === 'item/completed') { files.delete(item?.id); calls.delete(item?.id); }
      if (event.kind === 'server-request') serverRequest(event.message);
      // The controller closed a request that waits (its turn ended): the next one shows.
      else if (event.method === 'serverRequest/resolved') {
        const index = questions.findIndex(question => question.id === params.requestId);
        if (index !== -1) {
          questions.splice(index, 1);
          say(`[The controller closed the approval request of agent ${agent(params.threadId)} before you answered.]`);
          if (index === 0) ask();
        }
      }
      // The controller can give the same warning at each turn; the client shows each warning once in a session.
      else if (event.method === 'warning' && typeof params.message === 'string') warnOnce('Warning from the controller: ', params.message, '');
      else if (event.method === 'configWarning' && typeof params.summary === 'string') warnOnce('Warning about your Codex config: ', params.summary, params.path ? ` (${params.path})` : '');
      else if (event.method === 'item/completed' && params.threadId === rootThread && params.item?.type === 'agentMessage') chief(params.item.text);
    }}, {spawn, schedule});

  const queue = [];
  const requestStop = () => {
    if (stopAsked) return;
    stopAsked = true;
    declineAll('The controller stops');
    say('[Stopping the controller...]');
    owner.stop();
    wake();
  };
  // After the turn: the controller stops now, the fix for the line, a typed line waits, or the owner types the next line.
  const then = (hint, fix = false) => (stopAsked || (inputEnded && !queue.length) ? ' The controller stops now.' : fix || !queue.length ? ` ${hint}` : '');
  // Ctrl-C clears the typed line (`cleared`) and drops the lines that wait; the first one also stops the turn. A
  // Ctrl-C that clears a typed line never stops the controller: a later Ctrl-C on an empty line does that.
  const onSignalOrKey = (signal, cleared = false) => {
    if (signal === 'SIGHUP') { terminalLost = true; requestStop(); return; }
    if (signal === 'SIGINT') declineAll('You pressed Ctrl-C');
    if (signal !== 'SIGINT' || !ready || (hinted && !cleared)) { requestStop(); return; }
    const waited = queue.splice(0).length;
    const dropped = waited === 1 ? ' The line that waited does not run.' : waited ? ` The ${waited} lines that waited do not run.` : '';
    const again = turnActive ? 'Press Ctrl-C again to stop the controller.' : 'Press Ctrl-C again or Ctrl-D to stop the controller.';
    if (turnActive && !hinted) { hinted = true; say(`[Stopping the turn...${dropped} ${again}]`); owner.interrupt().catch(() => {}); return; }
    hinted = true;
    say(`[${cleared ? 'You cleared the line.' : 'No turn is running.'}${dropped} ${again}]`);
  };
  onSignal(onSignalOrKey);

  async function session() {
    try { await owner.start(); } catch (error) {
      if (!stopAsked) say(`[The controller did not start: ${plain(owner.status().reason ?? error.message)}. Check that SAGE_CODEX_CONTROLLER_BIN is the fork binary and that your Codex config file loads. ${RESTART}]`);
      return 'refused';
    }
    const opened = await owner.openThread({project, task: args.task, run: args.run, instructions});
    if (opened.state !== 'bound') {
      if (!stopAsked) say(opened.code === 'rpc' ? `[The controller refused to start the chief: ${why(opened.error)}. ${RESTART}]`
        : opened.state === 'uncertain' ? `[The start of the chief has an unknown result: ${why(opened.error)}. ${RESTART}]`
          : `[The client did not start the chief: ${why(opened.error)}]`);
      return 'refused';
    }
    rootThread = opened.policy.threadId;
    const {model, approvalPolicy, sandbox} = opened.policy.selection;
    const line = (text, pasted = false) => {
      if (stopAsked) return;
      const word = text.trim().toLowerCase();
      // While an approval request waits, a typed y, yes, n or no is its answer (text from a paste never is); any other
      // line is no turn, and the question shows again.
      if (questions.length) {
        if (pasted) say(PASTED); else if (YES.has(word) || NO.has(word)) { answer(YES.has(word)); return; } else say(NOT_SENT);
        ask();
        return;
      }
      if (!word) return;
      // A lone y or n with no question is an answer that came late (or early): it never goes to the chief. A yes or a
      // no goes to the chief, which may have asked it.
      if (word === 'y' || word === 'n') { say(NO_QUESTION); return; }
      if (turnActive) say('[The chief is on a turn. Your line runs after it.]');
      queue.push(text); wake();
    };
    const end = () => {
      inputEnded = true;
      declineAll('Your input ended');
      // The lines already typed still run, then the controller stops. A pipe's end can come in any read, so the end
      // of input never stops a turn by itself: Ctrl-C does that.
      if (turnActive && !stopAsked) say('[Your input ended. The controller stops after the lines that you typed. Press Ctrl-C to stop the turn now.]');
      wake();
    };
    if (input.isTTY) terminal = readTerminal(input, write, {line, end, interrupt: cleared => onSignalOrKey('SIGINT', cleared)});
    else createInterface({input, crlfDelay: Infinity, terminal: false}).on('line', line).on('close', end);
    // The terminal is raw before the Ready lines, so the terminal never echoes the start of a paste that comes at once.
    say(`[Ready: task ${args.task}, run ${args.run}. The chief uses your Codex config: model ${shown(model.value)}${model.origin === 'default' ? ' (the Codex default)' : ''}, approval ${shown(approvalPolicy.value)}, sandbox ${shown(sandbox.value)}.]`, howTo(input.isTTY));
    ready = true;
    // After a fence no reply can go out, so the requests that wait are dropped.
    owner.fenced().then(() => { questions.length = 0; wake(); });
    for (;;) {
      if (stopAsked) break;
      // The controller fenced between turns (a crash, or a protocol fault): no line can run any more.
      if (owner.status().reason) break;
      if (queue.length) {
        const text = queue.shift();
        hinted = false; turnActive = true; waited = false; fullStop = false; dropped = false;
        const command = classify({text});
        if (command.kind === 'phrase') say(`[You typed the mode phrase "${command.phrase}". The client sends it to the chief, which switches the mode and says so.]`);
        if (command.kind === 'near') say(`[No mode changed: this line is not a mode phrase, so the chief gets it as a normal line. To switch, type ${command.phrases.length > 1 ? 'one of these' : 'this'} alone: ${command.phrases.join(', ')}.]`);
        awaitModel();
        const result = await owner.runTurn(text).catch(error => ({state: 'not-sent', error}));
        turnActive = false; cancelWait();
        const ended = turnLine(result, then, fullStop);
        tell(dropped && !fullStop ? ended.replace(/]$/, ' Some output of this turn did not show, because the terminal took no output.]') : ended);
        // Ctrl-C dropped the lines that waited, so each line that waits now came after it; the client says that it starts.
        if (hinted && result.state === 'interrupted' && queue.length && !stopAsked) tell(queue.length === 1 ? '[The line that you typed after Ctrl-C starts now.]' : `[The ${queue.length} lines that you typed after Ctrl-C start now, one at a time.]`);
        continue;
      }
      if (inputEnded) break;
      await new Promise(resolve => { wake = resolve; });
    }
    if (queue.length) tell(`[${queue.length} typed line${queue.length === 1 ? '' : 's'} did not run.]`);
    return 'session';
  }
  // stop() runs on every path, so the controller never outlives the client.
  const outcome = await session().catch(error => { say(`[The client failed: ${error.message}]`); return 'failed'; });
  // No timer of the session prints after its last line (R1615-2).
  cancelSettle(); cancelWait();
  // An open input keeps the process alive after a stop by Ctrl-C or a signal, so the client releases it, and gives
  // the terminal back its line mode, with bracketed paste off.
  if (input.isRaw) { write(PASTE_OFF, true); input.setRawMode(false); }
  input.destroy?.();
  const status = await owner.stop();
  const clean = !terminalLost && (stopAsked || inputEnded) && status.state === 'stopped' && status.reason === 'Stop requested';
  if (status.state !== 'stopped') tell('[The controller did not stop after SIGTERM and SIGKILL. Find its codex app-server process and stop it.]');
  else if (clean) tell('[You stopped the controller. The session ended.]');
  else if (outcome !== 'refused') tell(`[The session ended early: ${plain(status.reason)}. ${RESTART}]`);
  return clean ? 0 : 1;
}

let entryPath;
try { if (process.argv[1]) entryPath = realpathSync(process.argv[1]); } catch { /* No filesystem entry path. */ }
if (entryPath === fileURLToPath(import.meta.url)) {
  // commands.mjs needs the bundled core, so the client runs from the built plugin.
  const {parseCommand} = await import('../skills/sage/commands.mjs');
  // After the terminal closes (macOS), two terminal calls wait for ever, and then no signal handler runs: a blocking
  // write, and the open that node does when it first uses process.stderr. So the client opens stderr now (it writes
  // there only a crash message, so an error on stderr is no loss), and it writes to the terminal without blocking:
  // such a write then fails at once with EIO.
  process.stderr.on('error', () => {});
  if (process.stdout.isTTY) process.stdout._handle.setBlocking(false);
  // A lost terminal: SIGHUP, or an EIO or EPIPE on it. The client stops the controller, and its exit code is 1 also
  // when the loss shows only in its last write.
  let handle = () => {}, lost = false;
  const loseTerminal = () => { lost = true; handle('SIGHUP'); };
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => handle(signal));
  process.on('SIGHUP', loseTerminal);
  for (const stream of [process.stdin, process.stdout]) stream.on('error', error => {
    if (error.code !== 'EIO' && error.code !== 'EPIPE') throw error;
    loseTerminal();
  });
  // A crash ends the process before the client gives the terminal back: node then resets raw mode, and this turns
  // bracketed paste off, so that the shell after it does not get the paste marks.
  process.on('exit', () => {
    if (lost) process.exitCode = 1;
    else if (process.stdin.isRaw) try { writeSync(process.stdout.fd, PASTE_OFF); } catch { /* The terminal is gone. */ }
  });
  runClient({argv: process.argv.slice(2), env: process.env, input: process.stdin, output: process.stdout, classify: parseCommand,
    onSignal: handler => { handle = handler; }})
    .then(code => { process.exitCode = code; }, error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
