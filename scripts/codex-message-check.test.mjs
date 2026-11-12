// The shape check of the chief's messages in Codex (T1005), in note mode: Codex's Stop event checks the last message of
// the chief's turn, and the next prompt gives the chief the note. Each case drives the installed launcher as Codex runs
// sage's entries (node <CODEX_HOME>/sage-hooks/launch.mjs <Event>, the event's JSON on stdin), with the input shapes of
// Codex 0.164.0 (its stop.command.input schema). Every home is a scratch folder: no test reads or writes the real
// ~/.codex, and no test runs Codex.
import "./test-env.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ROOT } from "./build.mjs";
import { renderMessage } from "../plugins/sage-codex/core/index.mjs";

const PLUGIN = join(ROOT, "plugins/sage-codex");
const fixture = (name) => JSON.parse(readFileSync(join(ROOT, "scripts/fixtures/messages", name), "utf8"));
/** A question as the message command prints it: a message that fits its kind's shape. */
const QUESTION = renderMessage(fixture("02-question.json"), { pagePath: (name) => `/pages/T1/${name}` }).text;
/** The same question written by hand with two misses: no "Needed by" part, and a task id in its own words. */
const MISSED = QUESTION.replace(/\n\n\*\*Needed by\*\*\n[\s\S]*?(?=\n\n)/, "").replace("**Where this is**\n", "**Where this is**\nT4242 waits. ");

let sessions = 0, turns = 0;
/** A scratch HOME and Codex home with the built plugin installed and sage's entries in hooks.json, and one Codex session. */
function setup(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "sage-codex-message-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const codex = join(dir, ".codex");
  mkdirSync(join(codex, "plugins/cache/sage/sage"), { recursive: true });
  cpSync(PLUGIN, join(codex, "plugins/cache/sage/sage/0.1.0"), { recursive: true });
  const { SAGE_HOME, CODEX_HOME, ...inherited } = process.env;
  const env = { ...inherited, HOME: dir, CODEX_HOME: codex, SAGE_HOME: join(dir, "sage-home") };
  const installed = spawnSync(process.execPath, [join(codex, "plugins/cache/sage/sage/0.1.0/skills/sage/sage.mjs"), "hooks", "install"], { cwd: dir, env, encoding: "utf8" });
  assert.equal(installed.status, 0, installed.stderr);
  const session = `019b${String(++sessions).padStart(4, "0")}-0000-7000-8000-000000000000`;
  const base = { session_id: session, transcript_path: null, cwd: dir, model: "fixture", permission_mode: "default" };
  /** One event through the installed launcher: its parsed output (undefined for none), after a clean exit. */
  const launch = (event, fields) => {
    const r = spawnSync(process.execPath, [join(codex, "sage-hooks/launch.mjs"), event], { cwd: dir, env, input: JSON.stringify({ ...base, hook_event_name: event, ...fields }), encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout ? JSON.parse(r.stdout) : undefined;
  };
  const prompt = (text) => launch("UserPromptSubmit", { turn_id: `turn-${++turns}`, prompt: text });
  /** The chief's turn ends with this message: Codex's Stop input. */
  const stop = (message) => launch("Stop", { turn_id: `turn-${turns}`, stop_hook_active: false, last_assistant_message: message });
  const note = (output) => output?.hookSpecificOutput?.additionalContext;
  const misses = join(dir, "sage-home/.hooks/codex/message-misses.jsonl");
  return { dir, prompt, stop, note, misses, count: () => (existsSync(misses) ? readFileSync(misses, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []) };
}

test("sage's entries include Stop: hooks install writes it, and the launcher runs the check at Stop", (t) => {
  const s = setup(t);
  const hooks = JSON.parse(readFileSync(join(s.dir, ".codex/hooks.json"), "utf8")).hooks;
  assert.deepEqual(hooks.Stop, [{ hooks: [{ type: "command", command: `node "${join(s.dir, ".codex/sage-hooks/launch.mjs")}" Stop`, timeout: 10 }] }]);
});

test("a chief message that names its kind and misses its shape: no block at Stop, a note at the next prompt with the kind and each problem, and one count line with no message text", (t) => {
  const s = setup(t), start = Date.now();
  assert.match(s.note(s.prompt("sage mode")), /You are the user's chief of staff/);
  assert.equal(s.stop(MISSED), undefined, "the stop gives no output: nothing blocks");
  const note = s.note(s.prompt("ok, go on"));
  assert.equal(note, [
    'sage: your last message names the kind "question" on its first line, but it misses the shape of that kind:',
    "- raw ids in the message: T4242. Name the work in words; put its ids in the Ref line",
    '- a question needs "Needed by"',
    "Fix this in your next message of that kind: the presentation skill gives each kind's parts, and sage's message command prints a message in its kind's shape.",
  ].join("\n"));
  assert.equal(s.note(s.prompt("and the next one")), undefined, "the note comes once");
  const lines = s.count();
  assert.equal(lines.length, 1);
  assert.deepEqual(Object.keys(lines[0]), ["at", "kind", "problems"]);
  assert.ok(Date.parse(lines[0].at) >= start && Date.parse(lines[0].at) <= Date.now(), "the time of the miss");
  assert.deepEqual(lines[0], { at: lines[0].at, kind: "question", problems: ["raw ids", "missing: Needed by"] });
  assert.doesNotMatch(readFileSync(s.misses, "utf8"), /T4242|waits/, "no word of the message");
  // A second miss is a second line.
  s.stop(MISSED);
  assert.equal(s.count().length, 2);
});

test("a message that fits its kind's shape, and a message that names no kind, give no note and no count", (t) => {
  const s = setup(t);
  s.prompt("sage mode");
  assert.equal(s.stop(QUESTION), undefined);
  assert.equal(s.note(s.prompt("ok")), undefined, "a message that fits");
  assert.equal(s.stop("Done: T12 merged, and T13 waits for G7.\n├─ next"), undefined);
  assert.equal(s.note(s.prompt("ok")), undefined, "a message with no kind");
  assert.equal(s.stop(null), undefined, "Codex gives null for a turn with no message");
  assert.equal(s.note(s.prompt("ok")), undefined);
  assert.deepEqual(s.count(), []);
});

test("the note is about the last message only, as in Claude: a later Stop that fits, names no kind or has no message removes it", (t) => {
  const s = setup(t);
  s.prompt("sage mode");
  // Two turns end with no prompt between them, for example when an agent's end wakes the chief.
  s.stop(MISSED);
  assert.equal(s.stop(QUESTION), undefined);
  assert.equal(s.note(s.prompt("ok")), undefined, "a later message that fits");
  s.stop(MISSED);
  s.stop("Done: the build passed.");
  assert.equal(s.note(s.prompt("ok")), undefined, "a later message with no kind");
  s.stop(MISSED);
  s.stop(null);
  assert.equal(s.note(s.prompt("ok")), undefined, "a later turn with no message");
  // A later miss still gives its note, and each miss is counted.
  s.stop(QUESTION);
  s.stop(MISSED);
  assert.match(s.note(s.prompt("ok")), /misses the shape of that kind/);
  assert.equal(s.count().length, 4);
});

test("a note file that cannot be read is removed at the next prompt, so it is not read again (F-T1005-3)", (t) => {
  const s = setup(t);
  s.prompt("sage mode");
  s.stop(MISSED);
  const notes = join(s.dir, "sage-home/.hooks/codex/notes");
  const [name] = readdirSync(notes);
  writeFileSync(join(notes, name), "{ damaged");
  assert.equal(s.note(s.prompt("ok")), undefined);
  assert.deepEqual(readdirSync(notes), [], "the damaged note is gone");
  // The next miss gives its note as usual.
  s.stop(MISSED);
  assert.match(s.note(s.prompt("ok")), /misses the shape of that kind/);
});

test("out of sage mode there is no chief, so a miss gives no note; and a note waits for sage mode", (t) => {
  const s = setup(t);
  assert.equal(s.stop(MISSED), undefined);
  assert.equal(s.note(s.prompt("ok")), undefined);
  assert.deepEqual(s.count(), [], "not the chief's message");
  // A miss in sage mode, then the off phrase: the note goes, and it does not come back at a later on.
  s.prompt("sage mode");
  s.stop(MISSED);
  assert.doesNotMatch(s.note(s.prompt("sage mode off")) ?? "", /misses the shape/);
  assert.doesNotMatch(s.note(s.prompt("sage mode")) ?? "", /misses the shape/);
});

test("an error gives no note and no block: the check fails open", (t) => {
  const s = setup(t);
  s.prompt("sage mode");
  // The notes folder cannot be made: a file has its name.
  writeFileSync(join(s.dir, "sage-home/.hooks/codex/notes"), "not a folder");
  assert.equal(s.stop(MISSED), undefined, "no output, so nothing blocks");
  assert.equal(s.note(s.prompt("ok")), undefined);
  assert.deepEqual(s.count(), []);
  // A Stop input that the check cannot read.
  assert.equal(s.stop({ not: "text" }), undefined);
});
