#!/usr/bin/env node
import {readFileSync, realpathSync, statSync} from 'node:fs';
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
const HOW_TO = '[Type a line and press Enter: the chief gets it as one turn. Ctrl-C stops the turn. Ctrl-D stops the controller.]';
const NEXT = 'Type the next line, or press Ctrl-D to stop the controller.';
const RESTART = 'Start the client again.';
const WAITING = '[Waiting for the model. Press Ctrl-C to stop the turn.]';
// A turn with no event from the controller for this long shows WAITING, once.
const WAIT_MS = 15000;
// The output that may wait for a terminal that takes none (a paused or a stopped terminal). Past it, the client
// stops the turn and drops output until the terminal takes it again, so its memory stays bounded.
const TERMINAL_QUEUE_BYTES = 8 * 1024 * 1024;
const TERMINAL_FULL = '[The terminal takes no output: more than 8 MiB waits for it. The client stopped the turn, and it drops output until the terminal takes output again. If you pressed Ctrl-S, press Ctrl-Q.]';

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
]);
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
function instructionsText(path) {
  try { return readFileSync(path, 'utf8'); }
  catch (error) { throw new Error(error.code === 'ENOENT' ? `The instructions file ${path} does not exist. Give the chief instructions file with --instructions.` : `The client cannot read the instructions file ${path} (${error.code}). Give a file that you can read with --instructions.`); }
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
function requestLine(method, params = {}) {
  if (method === 'item/commandExecution/requestApproval') return `[The chief asked to run a command: ${params.command ?? 'no command given'}. This client cannot ask you yet, so it refused, and the command did not run.]`;
  if (method === 'item/fileChange/requestApproval') return `[The chief asked to change files${params.reason ? ` (${params.reason})` : ''}. This client cannot ask you yet, so it refused, and the files did not change.]`;
  return `[The controller sent the request ${method}. This client answers no requests, so it refused.]`;
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
  let terminalLost = false, terminalFull = false, fullStop = false, owner;
  const write = text => {
    if (terminalLost) return;
    if ((output.writableLength ?? 0) > TERMINAL_QUEUE_BYTES) {
      if (terminalFull) return;
      terminalFull = true;
      output.write(`${TERMINAL_FULL}\n`);
      if (turnActive && !fullStop) { fullStop = true; owner.interrupt().catch(() => {}); }
      return;
    }
    terminalFull = false;
    output.write(text);
  };
  const say = (...lines) => { for (const line of lines) write(`${oneLine(line)}\n`); };
  const chief = text => { for (const line of String(text).split(/\r?\n/)) write(`chief> ${oneLine(line)}\n`); };
  // A controller text of several lines gives several lines, each with the prefix, so no line of it looks like the client's.
  const framed = (prefix, text, suffix) => {
    const lines = String(text).split(/\r?\n/).filter(line => line.trim());
    if (!lines.length) lines.push('');
    lines.forEach((line, index) => say(`[${prefix}${line}${index === lines.length - 1 ? suffix : ''}]`));
  };
  // While a turn runs, each controller event starts the wait again; after WAIT_MS with no event, the client says so once.
  const timer = schedule ?? defaultSchedule;
  let cancelWait = () => {}, waited = false;
  const awaitModel = () => { cancelWait(); cancelWait = waited ? () => {} : timer(() => { waited = true; say(WAITING); }, WAIT_MS); };
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
  owner = createControllerProcess({executable: binary.path, executableSha256: binary.sha256, cwd: project,
    env: Object.fromEntries(Object.entries(env).filter(([, value]) => typeof value === 'string')),
    onEvent(event) {
      if (turnActive) awaitModel();
      const params = event.message.params ?? {};
      if (event.kind === 'server-request-refused') say(requestLine(event.method, params));
      else if (event.method === 'warning' && typeof params.message === 'string') framed('Warning from the controller: ', params.message, '');
      else if (event.method === 'configWarning' && typeof params.summary === 'string') framed('Warning about your Codex config: ', params.summary, params.path ? ` (${params.path})` : '');
      else if (event.method === 'item/completed' && params.threadId === rootThread && params.item?.type === 'agentMessage') chief(params.item.text);
    }}, {spawn, schedule});

  const queue = [];
  const requestStop = () => {
    if (stopAsked) return;
    stopAsked = true;
    say('[Stopping the controller...]');
    owner.stop();
    wake();
  };
  // After the turn: the controller stops now, the fix for the line, a typed line waits, or the owner types the next line.
  const then = (hint, fix = false) => (stopAsked || (inputEnded && !queue.length) ? ' The controller stops now.' : fix || !queue.length ? ` ${hint}` : '');
  onSignal(signal => {
    if (signal === 'SIGHUP') { terminalLost = true; requestStop(); return; }
    if (signal !== 'SIGINT' || !ready || hinted) { requestStop(); return; }
    hinted = true;
    if (!turnActive) { say('[No turn is running. Press Ctrl-C again or Ctrl-D to stop the controller.]'); return; }
    say('[Stopping the turn... Press Ctrl-C again to stop the controller.]');
    owner.interrupt().catch(() => {});
  });

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
    say(`[Ready: task ${args.task}, run ${args.run}. The chief uses your Codex config: model ${shown(model.value)}${model.origin === 'default' ? ' (the Codex default)' : ''}, approval ${shown(approvalPolicy.value)}, sandbox ${shown(sandbox.value)}.]`, HOW_TO);
    ready = true;

    const reader = createInterface({input, crlfDelay: Infinity, terminal: false});
    reader.on('line', text => {
      if (!text.trim() || stopAsked) return;
      if (turnActive) say('[The chief is on a turn. Your line runs after it.]');
      queue.push(text); wake();
    });
    reader.on('close', () => {
      inputEnded = true;
      // The lines already typed still run, then the controller stops. A pipe's end can come in any read, so the end
      // of input never stops a turn by itself: Ctrl-C does that.
      if (turnActive && !stopAsked) say('[Your input ended. The controller stops after the lines that you typed. Press Ctrl-C to stop the turn now.]');
      wake();
    });
    owner.fenced().then(() => wake());
    for (;;) {
      if (stopAsked) break;
      // The controller fenced between turns (a crash, or a protocol fault): no line can run any more.
      if (owner.status().reason) break;
      if (queue.length) {
        const text = queue.shift();
        hinted = false; turnActive = true; waited = false; fullStop = false;
        const command = classify({text});
        if (command.kind === 'phrase') say(`[You typed the mode phrase "${command.phrase}". The client sends it to the chief, which switches the mode and says so.]`);
        if (command.kind === 'near') say(`[No mode changed: this line is not a mode phrase, so the chief gets it as a normal line. To switch, type one of these alone: ${command.phrases.join(', ')}.]`);
        awaitModel();
        const result = await owner.runTurn(text).catch(error => ({state: 'not-sent', error}));
        turnActive = false; cancelWait();
        say(turnLine(result, then, fullStop));
        // After a Ctrl-C the owner may not expect the line that waits, so the client says that it starts.
        if (hinted && result.state === 'interrupted' && queue.length && !stopAsked) say('[The line that you typed during the turn starts now.]');
        continue;
      }
      if (inputEnded) break;
      await new Promise(resolve => { wake = resolve; });
    }
    if (queue.length) say(`[${queue.length} typed line${queue.length === 1 ? '' : 's'} did not run.]`);
    return 'session';
  }
  // stop() runs on every path, so the controller never outlives the client.
  const outcome = await session().catch(error => { say(`[The client failed: ${error.message}]`); return 'failed'; });
  // An open input keeps the process alive after a stop by Ctrl-C or a signal, so the client releases it.
  input.destroy?.();
  const status = await owner.stop();
  const clean = !terminalLost && (stopAsked || inputEnded) && status.state === 'stopped' && status.reason === 'Stop requested';
  if (status.state !== 'stopped') say('[The controller did not stop after SIGTERM and SIGKILL. Find its codex app-server process and stop it.]');
  else if (clean) say('[You stopped the controller. The session ended.]');
  else if (outcome !== 'refused') say(`[The session ended early: ${plain(status.reason)}. ${RESTART}]`);
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
  process.on('exit', () => { if (lost) process.exitCode = 1; });
  runClient({argv: process.argv.slice(2), env: process.env, input: process.stdin, output: process.stdout, classify: parseCommand,
    onSignal: handler => { handle = handler; }})
    .then(code => { process.exitCode = code; }, error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
