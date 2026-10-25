#!/usr/bin/env node
import {closeSync, constants, fstatSync, openSync, readFileSync, realpathSync, statSync, writeSync} from 'node:fs';
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
function readTerminal(input, write, {line, interrupt, end}) {
  let text = '', afterReturn = false, pasting = false, pending = '', ended = false;
  input.setRawMode(true);
  input.setEncoding('utf8');
  write(PASTE_ON);
  input.on('data', chunk => {
    // An Escape key alone at the end of a read, with no sequence after it, is the Escape key only.
    let all = pending === '\x1b' && !/^[[O]/u.test(chunk) ? chunk : pending + chunk;
    pending = PARTIAL.exec(all)?.[0] ?? '';
    all = all.slice(0, all.length - pending.length);
    let echo = '';
    const show = () => { if (echo) write(echo); echo = ''; };
    for (const [key] of all.matchAll(TOKEN)) {
      if (key.startsWith('\x1b')) { if (key === PASTE_START) pasting = true; else if (key === PASTE_END) pasting = false; continue; }
      // Raw mode stays on until the client ends, so after the end of input Ctrl-C still stops the turn (R1577-3).
      if (ended) { if (key === '\x03') interrupt(false); continue; }
      // A paste can give \r\n: one line end.
      if (key === '\n' && afterReturn) { afterReturn = false; continue; }
      afterReturn = key === '\r';
      if (key === '\r' || key === '\n') {
        echo += '\n';
        if (pasting) { text += '\n'; continue; }
        show(); const done = text; text = ''; line(done);
      } else if (key === '\t' || oneLine(key) === key) { text += key; echo += key; }
      // A control character in a paste is text of the paste, not a key: the client drops it.
      else if (pasting) continue;
      // Ctrl-C clears the line, so that the next Enter never sends the cleared text (R1575-2).
      else if (key === '\x03') { const cleared = text !== ''; text = ''; if (cleared) echo += '\n'; show(); interrupt(cleared); }
      else if (key === '\x04') { if (!text) { show(); ended = true; end(); } }
      else if (key === '\x7f' || key === '\b') { if (text) { text = text.replace(/.$/su, ''); echo += '\b \b'; } }
    }
    show();
  });
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
const isText = value => typeof value === 'string' && value !== '';
const listed = paths => paths.slice(0, 3).map(path => `"${path}"`).join(', ') + (paths.length > 3 ? ` and ${paths.length - 3} more` : '');
const pathsOf = value => (Array.isArray(value) ? value.filter(isText) : []);
function permissionWords(profile) {
  const words = profile?.network?.enabled ? ['network access'] : [];
  for (const mode of ['read', 'write']) if (pathsOf(profile?.fileSystem?.[mode]).length) words.push(`${mode} access to ${listed(pathsOf(profile.fileSystem[mode]))}`);
  if (profile?.fileSystem?.entries?.length) words.push('more file access');
  return words.join(' and ');
}
const DECISION = {accept: {decision: 'accept'}, decline: {decision: 'decline'}};
// The question id that the controller gives an MCP tool approval through requestUserInput, and its one-time option.
const MCP_APPROVAL = 'mcp_tool_call_approval', MCP_ALLOW = 'Allow', MCP_CANCEL = 'Cancel';
/**
 * What one server request asks, as `{what, accept, decline}` (the two replies). `{refused}` is a request that is not an
 * approval: the client refuses it with a line. Null is an approval request that the client cannot read.
 */
function approvalOf(method, params, files) {
  const reason = isText(params.reason) ? ` (${params.reason})` : '';
  if (method === 'item/commandExecution/requestApproval') {
    if (!isText(params.command) || !isText(params.cwd)) return null;
    const more = permissionWords(params.additionalPermissions);
    const verb = params.kind === 'writeStdin' ? 'send input to the running command' : 'run';
    return {what: `asks to ${verb} "${params.command}" in "${params.cwd}"${more ? ` with ${more}` : ''}${reason}`, ...DECISION};
  }
  if (method === 'item/fileChange/requestApproval') {
    const paths = files.get(params.itemId) ?? [];
    return {what: `asks to change ${paths.length === 1 ? 'the file ' : paths.length ? `${paths.length} files: ` : 'files'}${listed(paths)}${reason}`, ...DECISION};
  }
  if (method === 'item/permissions/requestApproval') {
    const words = permissionWords(params.permissions);
    if (!words || !isText(params.cwd)) return null;
    const asked = Object.fromEntries(['network', 'fileSystem'].filter(key => params.permissions[key]).map(key => [key, params.permissions[key]]));
    return {what: `asks for ${words} in "${params.cwd}"${reason}`, accept: {permissions: asked, scope: 'turn'}, decline: {permissions: {}, scope: 'turn'}};
  }
  if (method === 'mcpServer/elicitation/request') {
    if (params.mode !== 'form' || params._meta?.codex_approval_kind !== 'mcp_tool_call') return {refused: `sent a form from the MCP server "${params.serverName}": "${params.message}". The client cannot show forms, so it refused the form`};
    const reply = action => ({action, content: null, _meta: null});
    return {what: `asks to use a tool of the MCP server "${params.serverName}": "${params.message}"`, accept: reply('accept'), decline: reply('decline')};
  }
  if (method === 'item/tool/requestUserInput') {
    const questions = Array.isArray(params.questions) ? params.questions : [];
    const [question] = questions;
    if (questions.length !== 1 || !question?.id?.startsWith?.(MCP_APPROVAL) || !question.options?.some?.(option => option.label === MCP_ALLOW)) {
      return {refused: `asked you ${questions.length === 1 ? `a question: "${question?.question}"` : `${questions.length} questions`}. The client cannot answer questions, so it refused ${questions.length === 1 ? 'the question' : 'them'}`};
    }
    const reply = label => ({answers: {[question.id]: {answers: [label]}}});
    return {what: `asks to use an MCP tool: "${question.question}"`, accept: reply(MCP_ALLOW), decline: reply(MCP_CANCEL)};
  }
  return {refused: `sent the request ${method}. The client answers only approval requests, so it refused it`};
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
  const say = (...lines) => { for (const line of lines) write(`${oneLine(line)}\n`); };
  const tell = line => write(`${oneLine(line)}\n`, true);
  // The line ends at the end of a message give no empty chief line (R1578-1).
  const chief = text => { for (const line of String(text).replace(/(\r?\n)+$/, '').split(/\r?\n/)) write(`chief> ${oneLine(line)}\n`); };
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
  // each child thread, and `files` keeps the paths of each file change item until its end.
  const agents = new Map(), files = new Map();
  const agent = threadId => (threadId === rootThread ? '/root (the chief)' : agents.get(threadId) ?? `with thread id ${threadId}`);
  const ask = () => { if (!questions.length) return; cancelWait(); say(questions[0].line); };
  const answer = allow => {
    const question = questions.shift();
    owner.answer(question.id, allow ? question.accept : question.decline);
    say(allow ? '[You allowed it once.]' : '[You refused it.]');
    if (questions.length) ask(); else if (turnActive) awaitModel();
  };
  // Ctrl-C, the end of input and a stop refuse each request that waits.
  const declineAll = cause => {
    const waiting = questions.splice(0);
    for (const question of waiting) owner.answer(question.id, question.decline);
    if (waiting.length) say(`[${cause}, so the client refused ${waiting.length === 1 ? 'the approval request' : `the ${waiting.length} approval requests`}.]`);
  };
  function serverRequest({id, method, params = {}}) {
    const name = agent(params.threadId);
    const found = approvalOf(method, params, files);
    if (!found || found.refused) {
      owner.refuse(id);
      say(found ? `[Agent ${name} ${found.refused}.]` : `[Agent ${name} sent an approval request (${method}) that the client cannot read, so the client refused it.]`);
      return;
    }
    questions.push({id, threadId: params.threadId, line: `[Approval: agent ${name} ${found.what}. ${ASK}]`, accept: found.accept, decline: found.decline});
    if (questions.length === 1) ask();
    if (stopAsked || inputEnded) declineAll(stopAsked ? 'The controller stops' : 'Your input ended');
  }
  owner = createControllerProcess({executable: binary.path, executableSha256: binary.sha256, cwd: project,
    env: Object.fromEntries(Object.entries(env).filter(([, value]) => typeof value === 'string')),
    onEvent(event) {
      if (turnActive) awaitModel();
      const params = event.message.params ?? {};
      const named = agentPathOf(params);
      if (named) agents.set(...named);
      if (event.method === 'item/started' && params.item?.type === 'fileChange') files.set(params.item.id, pathsOf(params.item.changes?.map?.(change => change.path)));
      if (event.method === 'item/completed') files.delete(params.item?.id);
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
    const line = text => {
      // While an approval request waits, a line is its answer: y or n; any other line shows the question again.
      if (questions.length && !stopAsked) {
        const word = text.trim().toLowerCase();
        if (YES.has(word) || NO.has(word)) answer(YES.has(word)); else ask();
        return;
      }
      if (!text.trim() || stopAsked) return;
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
    if (input.isTTY) readTerminal(input, write, {line, end, interrupt: cleared => onSignalOrKey('SIGINT', cleared)});
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
