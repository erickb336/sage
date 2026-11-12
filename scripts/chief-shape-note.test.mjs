// The chief's message against the shape of its kind (T1004), through the built hook as Claude Code runs it: a Stop event
// of the main session with the message that the owner now sees, then the next UserPromptSubmit. A message that names its
// kind and misses its shape gives the chief one note at that prompt and one line in the count of misses; a message that
// fits, a message with no kind, a session out of sage mode and an error in the check give no note, and the Stop is
// never blocked. The Stop event has the fields of a real one, captured from Claude Code 2.1.289.
import "./test-env.mjs"; // first: no variable of the developer's shell changes a result
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
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

// Round 1 of T1004's repair: the note is about the chief's last message only, and a message with very many problems
// still gives a short note and a count.
/** The problem lines of a note: "- " and a problem, or "- and N more". */
const problemLines = (note) => note.split("\n").filter((line) => line.startsWith("- "));

test("F-T1004-1, F-T1004-3: a later message that fits, or that names no kind, leaves no note of an earlier miss", () => {
  const s = session();
  s.prompt("sage mode");
  for (const later of [QUESTION, "Done: fine"]) {
    s.stop(MISSED);
    assert.equal(s.stop(later), undefined);
    assert.equal(s.prompt("go on"), undefined, `after: ${later.split("\n", 1)[0]}`);
  }
  assert.equal(s.misses().length, 2, "each miss is still counted");
});

test("F-T1004-4: the note is about the last message before a prompt: of two misses, the last one; after a message that fits, none; and each miss is counted", () => {
  const s = session();
  s.prompt("sage mode");
  const onlyId = QUESTION.replace("Should sage stop", "Should T77 stop"); // a raw id, and every part
  const onlyPart = QUESTION.replace(/\nNeeded by:[^\n]*\n[^\n]*\n/, "\n"); // no "Needed by", and no id
  assert.deepEqual(textProblems(onlyId).length, 1);
  assert.deepEqual(textProblems(onlyPart).length, 1);
  s.stop(onlyId);
  s.stop(onlyPart);
  const note = s.prompt("go on");
  assert.match(note, /^sage: your last message /);
  assert.deepEqual(problemLines(note), [`- ${textProblems(onlyPart)[0]}`], "the problem of the last message only");
  assert.deepEqual(s.misses().map((m) => m.problems), [["raw ids"], ["missing: Needed by"]]);
  // The last message fits: no note at all, also after two misses.
  s.stop(onlyId);
  s.stop(onlyPart);
  s.stop(QUESTION);
  assert.equal(s.prompt("and then?"), undefined);
});

test("F-T1004-2: a message with thousands of problems gives a note of 20 problems and the count of the rest, and the session's hook state stays readable", () => {
  const s = session();
  s.prompt("sage mode");
  // 12,000 small pictures, each with a tree mark: the note once listed each one, and the hook state passed its 1 MB limit.
  const many = `PROGRESS\n\nThe build moved on\n\n${"```\n├\n```\n".repeat(12_000)}`;
  const all = textProblems(many);
  assert.ok(all.length > 12_000);
  assert.equal(s.stop(many), undefined);
  assert.ok(statSync(join(s.dir, "state", "s1.json")).size < 64 * 1024, "the hook state stays small");
  const note = s.prompt("go on");
  assert.deepEqual(problemLines(note), [...all.slice(0, 20).map((p) => `- ${p}`), `- and ${all.length - 20} more`]);
  const [{ problems: names }] = s.misses();
  assert.equal(names[0], "picture");
  assert.equal(new Set(names).size, names.length, "the count names each kind of problem once");
  // The state is still read: the next miss gives its own note.
  s.stop(MISSED);
  assert.match(s.prompt("and then?"), /needs "Needed by"/);
});

test("F-T1004-2: the raw-id problem lists at most 20 ids, and the count of the rest", () => {
  const s = session();
  s.prompt("sage mode");
  const ids = Array.from({ length: 5_000 }, (_, i) => `T${i + 1}`);
  s.stop(QUESTION.replace("Should sage stop", `Should ${ids.join(" ")} stop`));
  const [line, ...rest] = problemLines(s.prompt("go on"));
  assert.deepEqual(rest, []);
  assert.equal(line, `- raw ids in the message: ${ids.slice(0, 20).join(", ")} and 4980 more. Name the work in words; put its ids in the Ref line`);
});

test("F-T1004-5: a picture with very many problems gives a note and a count, not an error", () => {
  const s = session();
  s.prompt("sage mode");
  // 200,000 lines over the width of 46 columns in one picture: their problems once overflowed the stack in one push.
  const wide = `PROGRESS\n\nThe build moved on\n\nThe flow\n\`\`\`\n${`${"x".repeat(47)}\n`.repeat(200_000)}\`\`\`\n`;
  assert.equal(s.stop(wide), undefined);
  const lines = problemLines(s.prompt("go on"));
  assert.equal(lines.length, 21);
  assert.equal(lines[0], "- picture 1: line 1 is 47 columns: a picture has at most 46");
  assert.match(lines[20], /^- and \d+ more$/);
  assert.equal(s.misses().length, 1);
  assert.equal(s.misses()[0].problems[0], "picture");
});
