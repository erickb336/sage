#!/usr/bin/env node
// Probe: does a resumed Claude Code session keep one session id? The chief's
// identity (chiefs.tsv, T604) is the hook's session_id, so a resume that gets a
// new id would read as a new chief. The probe runs the real CLI with HOME and
// CLAUDE_CONFIG_DIR in a scratch folder and a fake Messages API on 127.0.0.1,
// so it needs no login and it reaches no real session or network.
import { spawnSync, spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Answer every Messages API call with one short streamed text turn.
function fakeMessagesApi() {
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      if (!request.url.startsWith('/v1/messages')) { response.writeHead(200, { 'content-type': 'application/json' }); return response.end('{}'); }
      const usage = { input_tokens: 1, output_tokens: 1 };
      const message = { id: 'msg_probe', type: 'message', role: 'assistant', model: 'probe', content: [], stop_reason: null, stop_sequence: null, usage };
      const events = [
        ['message_start', { type: 'message_start', message }],
        ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }],
        ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }],
        ['message_stop', { type: 'message_stop' }],
      ];
      if (body.includes('"stream":true')) {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const [name, data] of events) response.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
        return response.end();
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ...message, content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }));
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function scratchHome(folder, port) {
  const home = join(folder, 'home');
  const config = join(folder, 'config');
  const project = join(folder, 'project');
  for (const path of [home, config, project]) mkdirSync(path, { recursive: true });
  const notes = join(folder, 'hooks.jsonl');
  const hook = join(folder, 'note-hook.mjs');
  writeFileSync(hook, `import { appendFileSync, readFileSync } from 'node:fs';\nconst note = JSON.parse(readFileSync(0, 'utf8'));\nappendFileSync(${JSON.stringify(notes)}, JSON.stringify({ event: note.hook_event_name, source: note.source, session_id: note.session_id }) + '\\n');\n`);
  const command = { type: 'command', command: `${JSON.stringify(process.execPath)} ${JSON.stringify(hook)}` };
  const settings = join(folder, 'settings.json');
  writeFileSync(settings, JSON.stringify({ hooks: Object.fromEntries(['SessionStart', 'UserPromptSubmit', 'Stop'].map(event => [event, [{ hooks: [command] }]])) }));
  // The interactive start asks nothing when these answers are on file.
  const key = 'sage-probe-not-a-key';
  writeFileSync(join(config, '.claude.json'), JSON.stringify({
    hasCompletedOnboarding: true, theme: 'dark', customApiKeyResponses: { approved: [key.slice(-20)], rejected: [] },
    projects: { [realpathSync(project)]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
  }));
  const env = {
    PATH: process.env.PATH, HOME: home, CLAUDE_CONFIG_DIR: config,
    DO_NOT_TRACK: '1', DISABLE_TELEMETRY: '1', DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_API_KEY: key,
  };
  return { env, project, settings, notes };
}

// spawnSync would stop the event loop that the fake API runs on.
function run(binary, args, { env, project }) {
  return new Promise(resolve => {
    const child = spawn(binary, args, { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => child.kill(), 60_000);
    child.on('close', status => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  });
}

// The interactive resume, under a pty, because a chief is an interactive session.
// It types one prompt, then the exit command. Python's pty is the one portable
// pty here: script(1) needs a real terminal on its own stdin.
const PTY = `
import os, pty, select, sys, time
pid, fd = pty.fork()
if pid == 0:
    os.execvp(sys.argv[1], sys.argv[1:])
start = time.time()
sent = 0
steps = [(8, b'fourth\\r'), (14, b'/clear\\r'), (20, b'fifth\\r'), (26, b'/exit\\r')]
while time.time() - start < 50:
    ready, _, _ = select.select([fd], [], [], 0.5)
    if ready:
        try:
            if not os.read(fd, 65536):
                break
        except OSError:
            break
    if sent < len(steps) and time.time() - start > steps[sent][0]:
        os.write(fd, steps[sent][1])
        sent += 1
`;

function runInteractive(binary, args, { env, project }) {
  return new Promise(resolve => {
    const child = spawn('python3', ['-I', '-c', PTY, binary, ...args], { cwd: project, env: { ...env, TERM: 'xterm' }, stdio: 'ignore' });
    const timer = setTimeout(() => child.kill(), 60_000);
    child.on('close', status => { clearTimeout(timer); resolve({ status }); });
  });
}

const readNotes = path => {
  try { return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
};

// Four starts of one session: new, resume by id, continue the latest, and an
// interactive resume. The interactive run then clears the session.
export async function probeResume({ binary = 'claude', folder = mkdtempSync(join(tmpdir(), 'sage-resume-probe-')) } = {}) {
  const server = await fakeMessagesApi();
  try {
    const home = scratchHome(folder, server.address().port);
    const flags = ['--settings', home.settings, '--output-format', 'json', '--max-turns', '1'];
    const first = await run(binary, ['-p', 'first', ...flags], home);
    if (first.status !== 0) return { live: false, reason: `first run exited ${first.status}: ${first.stderr.slice(0, 300)}` };
    const id = JSON.parse(first.stdout).session_id;
    const resumed = await run(binary, ['-p', 'second', '--resume', id, ...flags], home);
    const continued = await run(binary, ['-p', 'third', '--continue', ...flags], home);
    await runInteractive(binary, ['--resume', id, '--settings', home.settings], home);
    const replies = [JSON.parse(first.stdout).session_id, JSON.parse(resumed.stdout).session_id, JSON.parse(continued.stdout).session_id];
    const notes = readNotes(home.notes);
    const cleared = notes.findIndex(note => note.source === 'clear');
    const ids = rows => [...new Set(rows.map(note => note.session_id))];
    return {
      live: true, version: spawnSync(binary, ['--version'], { env: home.env, encoding: 'utf8' }).stdout.trim(), replies,
      starts: notes.filter(note => note.event === 'SessionStart').map(note => note.source),
      resumedIds: ids(cleared < 0 ? notes : notes.slice(0, cleared)), clearedIds: cleared < 0 ? [] : ids(notes.slice(cleared)),
    };
  } finally {
    await new Promise(resolve => server.close(resolve));
    rmSync(folder, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await probeResume();
  appendFileSync(1, `${JSON.stringify(result, null, 1)}\n`);
}
