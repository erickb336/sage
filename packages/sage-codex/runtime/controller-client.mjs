#!/usr/bin/env node
import {readFileSync, realpathSync, statSync} from 'node:fs';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {bindTask, resolveControllerBinary} from './controller-binding.mjs';
import {createControllerProcess} from './controller-process.mjs';

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

// Controller text never reaches the terminal raw. Each C0 and C1 control character, the newline too, becomes U+FFFD,
// so that the text cannot move the cursor, write the clipboard (OSC 52) or start a new line that looks like the client's.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
export const oneLine = text => String(text).replace(CONTROL, '�');

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
// The thread reply gives the sandbox as {type: 'readOnly'}; the owner's config says read-only.
const shown = value => (typeof value === 'string' ? value : value?.type?.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`) ?? JSON.stringify(value));
const why = error => error?.message ?? error?.reason ?? (error ? JSON.stringify(error) : 'the controller gave no reason');

function turnLine(result) {
  if (result.state === 'completed') return '[Turn completed.]';
  if (result.state === 'interrupted') return result.timedOut ? `[The turn reached its time limit, so the client stopped it. ${NEXT}]` : `[You stopped the turn. ${NEXT}]`;
  if (result.state === 'failed') return `[The turn failed: ${why(result.error)}. Type the line again to try again, or press Ctrl-D to stop the controller.]`;
  if (result.state === 'refused') return `[The controller refused the turn: ${why(result.error)}. Change the line, then type it again.]`;
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
 * `onSignal` gets the handler for SIGINT, SIGTERM and SIGHUP. Returns the exit code: 0 only after a stop that the
 * owner asked for (end of input or Ctrl-C), 1 after a refusal, a crash or an unknown turn result.
 */
export async function runClient({argv, env, input, output, classify, onSignal = () => {}, spawn, schedule}) {
  const say = (...lines) => { for (const line of lines) output.write(`${oneLine(line)}\n`); };
  const chief = text => { for (const line of String(text).split(/\r?\n/)) output.write(`chief> ${oneLine(line)}\n`); };
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
  const owner = createControllerProcess({executable: binary.path, executableSha256: binary.sha256, cwd: project,
    env: Object.fromEntries(Object.entries(env).filter(([, value]) => typeof value === 'string')),
    onEvent(event) {
      const params = event.message.params ?? {};
      if (event.kind === 'server-request-refused') say(requestLine(event.method, params));
      else if (event.method === 'warning' && typeof params.message === 'string') say(`[Warning from the controller: ${params.message}]`);
      else if (event.method === 'configWarning' && typeof params.summary === 'string') say(`[Warning about your Codex config: ${params.summary}${params.path ? ` (${params.path})` : ''}]`);
      else if (event.method === 'item/completed' && params.threadId === rootThread && params.item?.type === 'agentMessage') chief(params.item.text);
    }}, {spawn, schedule});

  // The owner's stop: end of input, a second Ctrl-C, SIGTERM or SIGHUP. Each wakes the loop below.
  let ready = false, stopAsked = false, inputEnded = false, turnActive = false, hinted = false, wake = () => {};
  const queue = [];
  const requestStop = () => {
    if (stopAsked) return;
    stopAsked = true;
    say('[Stopping the controller...]');
    owner.stop();
    wake();
  };
  onSignal(signal => {
    if (signal !== 'SIGINT' || !ready || hinted) { requestStop(); return; }
    hinted = true;
    if (!turnActive) { say('[No turn is running. Press Ctrl-C again or Ctrl-D to stop the controller.]'); return; }
    say('[Stopping the turn... Press Ctrl-C again to stop the controller.]');
    owner.interrupt().catch(() => {});
  });

  async function session() {
    try { await owner.start(); } catch (error) {
      if (!stopAsked) say(`[The controller did not start: ${owner.status().reason ?? error.message}. Check that SAGE_CODEX_CONTROLLER_BIN is the fork binary and that your Codex config file loads. ${RESTART}]`);
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
    say(`[Ready: task ${args.task}, run ${args.run}. The chief uses your Codex config: model ${shown(model.value)}, approval ${shown(approvalPolicy.value)}, sandbox ${shown(sandbox.value)}.]`, HOW_TO);
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
        hinted = false; turnActive = true;
        const command = classify({text});
        if (command.kind === 'phrase') say(`[You typed the mode phrase "${command.phrase}". The client sends it to the chief, which switches the mode and says so.]`);
        if (command.kind === 'near') say(`[No mode changed: this line is not a mode phrase, so the chief gets it as a normal line. To switch, type one of these alone: ${command.phrases.join(', ')}.]`);
        const result = await owner.runTurn(text).catch(error => ({state: 'not-sent', error}));
        turnActive = false;
        say(result.state === 'not-sent' ? `[The client did not send the line: ${why(result.error)} Shorten or correct the line, then type it again.]` : turnLine(result));
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
  const clean = (stopAsked || inputEnded) && status.state === 'stopped' && status.reason === 'Stop requested';
  if (status.state !== 'stopped') say('[The controller did not stop after SIGTERM and SIGKILL. Find its codex app-server process and stop it.]');
  else if (clean) say('[You stopped the controller. The session ended.]');
  else if (outcome !== 'refused') say(`[The session ended early: ${reasonText(status.reason)}. ${RESTART}]`);
  return clean ? 0 : 1;
}
const ENDED = /^(Owned process closed|Owned stream closed|Protocol stream ended|Incomplete protocol stream)$/;
const reasonText = reason => (ENDED.test(reason) ? 'the controller process ended by itself' : reason === 'Turn outcome uncertain' ? 'a turn result is unknown' : reason);

let entryPath;
try { if (process.argv[1]) entryPath = realpathSync(process.argv[1]); } catch { /* No filesystem entry path. */ }
if (entryPath === fileURLToPath(import.meta.url)) {
  // commands.mjs needs the bundled core, so the client runs from the built plugin.
  const {parseCommand} = await import('../skills/sage/commands.mjs');
  let handle = () => {};
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => handle(signal));
  runClient({argv: process.argv.slice(2), env: process.env, input: process.stdin, output: process.stdout, classify: parseCommand,
    onSignal: handler => { handle = handler; }})
    .then(code => { process.exitCode = code; }, error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
