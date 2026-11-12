// The chief's message against the shape of its kind (T1004), through the built hook as Claude Code runs it: a Stop event
// of the main session with the message that the owner now sees, then the next UserPromptSubmit. A message that names its
// kind and misses its shape gives the chief one note at that prompt and one line in the count of misses; a message that
// fits, a message with no kind, a session out of sage mode and an error in the check give no note, and the Stop is
// never blocked. The Stop event has the fields of a real one, captured from Claude Code 2.1.289.
import "./test-env.mjs"; // first: no variable of the developer's shell changes a result
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { renderMessage, textProblems } from "../packages/sage-core/message-checks.mjs";

const PLUGIN = fileURLToPath(new URL("../plugins/sage", import.meta.url));
const fixture = (name) => JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/messages/${name}`, import.meta.url)), "utf8"));
/** The text of the approved example question, as the chat shows it: it fits its shape. */
const QUESTION = renderMessage(fixture("02-question.json")).text;
/** The same question, written by hand with no "Needed by" part and with a task's raw id. */
const MISSED = QUESTION.replace(/\nNeeded by:[^\n]*\n[^\n]*\n/, "\n").replace("Should sage stop", "Should T77 stop");

/** A session with its own scratch home, sage home and hook state. send() returns the hook's answer, or undefined. */
function session(plugin = PLUGIN) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "sage-shape-")));
  mkdirSync(join(dir, "project"));
  const env = { ...process.env, HOME: join(dir, "home"), SAGE_HOME: join(dir, "sage"), SAGE_HOOKS_STATE: join(dir, "state") };
  const send = (event) => {
    const r = spawnSync("node", [join(plugin, "hooks/launcher.mjs"), "sage-hook.mjs"], {
      input: JSON.stringify({ session_id: "s1", transcript_path: join(dir, "t.jsonl"), cwd: join(dir, "project"), prompt_id: "p1", permission_mode: "default", ...event }),
      encoding: "utf8", env, timeout: 60_000, killSignal: "SIGKILL",
    });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout ? JSON.parse(r.stdout) : undefined;
  };
  const prompt = (text) => send({ hook_event_name: "UserPromptSubmit", prompt: text })?.hookSpecificOutput?.additionalContext;
  const stop = (message) => send({ hook_event_name: "Stop", effort: {}, stop_hook_active: false, last_assistant_message: message, background_tasks: [], session_crons: [] });
  const misses = () => {
    const file = join(dir, "state", "shape-misses.jsonl");
    return existsSync(file) ? readFileSync(file, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line)) : [];
  };
  return { dir, send, prompt, stop, misses };
}

test("a chief's message that names its kind and misses its shape gives one note at the next prompt, with the kind and each problem, and is counted with no text of the message", () => {
  const s = session();
  assert.match(s.prompt("sage mode"), /sage mode is on/);
  const problems = textProblems(MISSED);
  assert.ok(problems.some((p) => /needs "Needed by"/.test(p)) && problems.some((p) => /raw ids/.test(p)), "the fixture misses two ways");
  assert.equal(s.stop(MISSED), undefined, "the Stop is never blocked: the owner already sees the message");
  const note = s.prompt("go on");
  assert.match(note, /^sage: your last message names the kind "question"/, "the note names the kind");
  for (const p of problems) assert.ok(note.includes(`- ${p}`), `the note names the problem: ${p}`);
  assert.equal(s.prompt("and then?"), undefined, "the note comes once");
  // The count: one line for the miss, with its time, its kind and its problem names, and no text of the message.
  const [miss, ...more] = s.misses();
  assert.deepEqual(more, []);
  assert.deepEqual(Object.keys(miss), ["at", "kind", "problems"]);
  assert.ok(Math.abs(Date.parse(miss.at) - Date.now()) < 10 * 60_000, "the time of the miss");
  assert.equal(miss.kind, "question");
  assert.deepEqual(miss.problems, ["raw ids", "missing: Needed by"]);
  const line = readFileSync(join(s.dir, "state", "shape-misses.jsonl"), "utf8");
  assert.ok(!line.includes("T77") && !line.includes("Should"), "no id and no words of the message");
  // A second miss is a second line.
  s.stop(MISSED);
  assert.equal(s.misses().length, 2);
});

test("a chief's message that fits its shape, or that names no kind, gives no note and no count", () => {
  const s = session();
  s.prompt("sage mode");
  for (const message of [QUESTION, "Done: the build of T77 passed, and ├─ is a tree mark."]) {
    assert.equal(s.stop(message), undefined);
    assert.equal(s.prompt("go on"), undefined, message.split("\n", 1)[0]);
  }
  assert.deepEqual(s.misses(), []);
});

test("out of sage mode, a message that misses its shape gives no note: only the chief's messages are checked", () => {
  const s = session();
  assert.equal(s.prompt("hello"), undefined);
  assert.equal(s.stop(MISSED), undefined);
  assert.equal(s.prompt("go on"), undefined);
  assert.deepEqual(s.misses(), []);
});

test("an error in the check gives no note and no block", () => {
  // A copy of the plugin whose check throws: the hook's other work still loads.
  const plugin = realpathSync(mkdtempSync(join(tmpdir(), "sage-plugin-")));
  cpSync(PLUGIN, plugin, { recursive: true });
  const checks = join(plugin, "core/message-checks.mjs"), text = readFileSync(checks, "utf8");
  assert.ok(text.includes("export function messageMiss(text) {"));
  writeFileSync(checks, text.replace("export function messageMiss(text) {", 'export function messageMiss(text) {\n  throw new Error("a broken check");'));
  const s = session(plugin);
  assert.match(s.prompt("sage mode"), /sage mode is on/);
  assert.equal(s.stop(MISSED), undefined, "no block");
  assert.equal(s.prompt("go on"), undefined, "no note");
  assert.deepEqual(s.misses(), []);
  // The same events through the real check give the note, so the copy differs only in its check.
  const real = session();
  real.prompt("sage mode");
  real.stop(MISSED);
  assert.match(real.prompt("go on"), /the kind "question"/);
});
