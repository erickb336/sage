#!/usr/bin/env node
import {readFileSync, realpathSync} from 'node:fs';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {resolveControllerBinary} from './controller-binding.mjs';
import {createControllerProcess} from './controller-process.mjs';

const USAGE = 'Usage: SAGE_CODEX_CONTROLLER_BIN=<fork codex> node controller-client.mjs --project <folder> --task <T…> --run <R…> --instructions <file>';
const FLAGS = ['--project', '--task', '--run', '--instructions'];

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const [flag, value] = [argv[index], argv[index + 1]];
    if (!FLAGS.includes(flag) || typeof value !== 'string' || flag.slice(2) in args) throw new Error(USAGE);
    args[flag.slice(2)] = value;
  }
  if (FLAGS.some(flag => !(flag.slice(2) in args))) throw new Error(USAGE);
  return args;
}
function describe(result) {
  const detail = result.error ? `: ${result.error.message ?? result.error.reason ?? JSON.stringify(result.error)}` : '';
  return `[turn ${result.state}${result.timedOut ? ', timed out' : ''}${detail}]`;
}

/**
 * The owner's terminal client. Each typed line is one turn on the bound root thread, run one at a time. `classify`
 * (commands.mjs) labels the mode phrases for the owner; the line itself goes to the chief unchanged. An interrupt
 * request (Ctrl-C) interrupts the active turn. End of input stops the controller. Returns the exit code.
 */
export async function runClient({argv, env, input, output, classify, onInterrupt = () => {}, spawn, schedule}) {
  const say = text => output.write(`${text}\n`);
  const args = parseArgs(argv);
  const binary = resolveControllerBinary(env);
  const project = realpathSync(args.project);
  let rootThread = null;
  const owner = createControllerProcess({executable: binary.path, executableSha256: binary.sha256, cwd: project,
    env: Object.fromEntries(Object.entries(env).filter(([, value]) => typeof value === 'string')),
    onEvent(event) {
      const params = event.message.params ?? {};
      if (event.kind === 'server-request-refused') say(`[refused server request ${event.method}]`);
      else if (event.method === 'item/completed' && params.threadId === rootThread && params.item?.type === 'agentMessage') say(`chief> ${params.item.text}`);
    }}, {spawn, schedule});
  let clean = false, status;
  try {
    await owner.start();
    const opened = await owner.openThread({project, task: args.task, run: args.run, instructions: readFileSync(args.instructions, 'utf8')});
    if (opened.state !== 'bound') say(`[${opened.state} ${opened.code}: ${opened.error.message ?? JSON.stringify(opened.error)}]`);
    else {
      rootThread = opened.policy.threadId;
      say(`[bound ${args.task} ${args.run}, root ${rootThread}, binding ${opened.policy.bindingHash}]`);
      onInterrupt(() => { owner.interrupt().catch(() => say('[no active turn; end the input to stop the controller]')); });
      clean = true;
      for await (const line of createInterface({input, crlfDelay: Infinity, terminal: false})) {
        if (!line.trim()) continue;
        const command = classify({text: line});
        if (command.kind === 'phrase') say(`[owner phrase: ${command.phrase}]`);
        if (command.kind === 'near') say(`[no switch; the exact phrases are: ${command.phrases.join(', ')}]`);
        const result = await owner.runTurn(line).catch(error => ({state: 'refused', error: {message: error.message}}));
        say(describe(result));
        // An uncertain turn fences the controller: no later line can run.
        if (result.state === 'uncertain') { clean = false; break; }
      }
    }
  } finally {
    status = await owner.stop();
    say(`[controller ${status.state}${status.reason ? `: ${status.reason}` : ''}]`);
  }
  return clean && status.state === 'stopped' ? 0 : 1;
}

let entryPath;
try { if (process.argv[1]) entryPath = realpathSync(process.argv[1]); } catch { /* No filesystem entry path. */ }
if (entryPath === fileURLToPath(import.meta.url)) {
  // commands.mjs needs the bundled core, so the client runs from the built plugin.
  const {parseCommand} = await import('../skills/sage/commands.mjs');
  let interrupt = () => {};
  process.on('SIGINT', () => interrupt());
  runClient({argv: process.argv.slice(2), env: process.env, input: process.stdin, output: process.stdout, classify: parseCommand,
    onInterrupt: handler => { interrupt = handler; }})
    .then(code => { process.exitCode = code; }, error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
