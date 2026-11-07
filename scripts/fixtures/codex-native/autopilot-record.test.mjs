import "../../test-env.mjs"; // first: no variable of the developer's shell changes a result
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// The Codex autopilot's owner record reader and start marks (T663), on real Codex 0.164.0 records of the T662 proof.
// owner-records.json holds those records, scrubbed and trimmed: no path or text of the machine that made them, and
// the proof's probe phrases replaced with sage's phrases. Every case that the reader cannot prove refuses.
const PLUGIN = fileURLToPath(new URL("../../../plugins/sage-codex", import.meta.url));
const { readRecord, autopilotSwitch, turnAborted, RECORD_LIMIT } = await import(join(PLUGIN, "hooks/owner-record.mjs"));
const { switchModes } = await import(join(PLUGIN, "core/index.mjs"));
const { markFile } = await import(join(PLUGIN, "hooks/start-mark.mjs"));
const { modeDirectory } = await import(join(PLUGIN, "hooks/sage-codex-hook.mjs"));
const RECORDS = JSON.parse(readFileSync(fileURLToPath(new URL("./owner-records.json", import.meta.url)), "utf8"));

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), "sage-autopilot-record-")));
process.on("exit", () => rmSync(SCRATCH, { recursive: true, force: true }));
process.env.HOME = SCRATCH;
process.env.SAGE_HOME = join(SCRATCH, "sage");
delete process.env.CODEX_HOME;
let files = 0;
/** A record file with these lines (objects or raw text), and its text ending in a newline. */
function recordFile(lines, end = "\n") {
  const file = join(SCRATCH, `record-${++files}.jsonl`);
  writeFileSync(file, lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line))).join("\n") + end);
  return file;
}
const read = (lines, options) => readRecord(recordFile(lines), options);
/** The switch of a record with a start mark at line from, or its refusal. */
const decide = (lines, from = 0) => {
  const record = read(lines);
  return record.refused ? { refused: record.refused } : autopilotSwitch(record, { lines: from });
};
const ON = { on: true };
const NONE = { on: false, reason: "the owner has not turned autopilot on, with sage mode on, since this session started" };
const OFF = { on: false, reason: "the owner's latest autopilot switch is off" };

// Real lines of the proof records, for synthetic cases.
const real = RECORDS["exec-on"];
const META = real[0];
const ownerLine = real.find((o) => o.payload.role === "user" && o.payload.internal_chat_message_metadata_passthrough?.content_item_kinds?.[0] === "user.text");
const startLine = real.find((o) => o.payload.type === "task_started");
const TURN = startLine.payload.turn_id;
/** A task_started line of a new turn, with this trigger. */
const started = (turn, trigger) => ({ ...startLine, payload: { ...startLine.payload, turn_id: turn, root_turn_id: turn, turn_attribution: { ...startLine.payload.turn_attribution, turn_id: turn, root_turn_id: turn, turn_trigger: trigger } } });
/** An owner's message in a turn, with this text and these provenance types. */
const owner = (turn, text, provenance = ["user"]) => ({ ...ownerLine, payload: { ...ownerLine.payload, content: provenance.map((_, i) => ({ type: "input_text", text: i ? "" : text })),
  internal_chat_message_metadata_passthrough: { ...ownerLine.payload.internal_chat_message_metadata_passthrough, turn_id: turn, content_item_metadata: provenance.map((type) => ({ provenance: { type } })) } } });
const meta = (cli_version) => ({ ...META, payload: { ...META.payload, cli_version } });
/** The record with the owner's mode phrase (sage mode on) added in its first turn, before any message of the owner. */
function withMode(lines) {
  const first = lines.findIndex((o) => o.payload.type === "task_started");
  return [...lines.slice(0, first + 1), owner(lines[first].payload.turn_id, "sage mode"), ...lines.slice(first + 1)];
}

test("real records of the proof: on counts only from the owner, in a turn that a person started, after the session start", () => {
  assert.deepEqual(decide(withMode(RECORDS["exec-on"])), ON, "codex exec with the on phrase as its prompt, after the mode phrase");
  assert.deepEqual(decide(RECORDS["exec-on"]), NONE, "the same record without the mode phrase: sage mode is off, so the on is no switch");
  assert.deepEqual(decide(withMode(RECORDS["tui-on-then-off"])), OFF, "TUI: on, then off typed with Enter in the same turn");
  assert.deepEqual(decide(withMode(RECORDS["tui-on-then-esc"])), ON, "TUI: on, then Esc");
  assert.deepEqual(decide(withMode(RECORDS["queue-on"])), NONE, "the on phrase sent with codex queue: provenance user, turn trigger queue");
  assert.deepEqual(decide(withMode(RECORDS["hook-text-on"])), NONE, "the on phrase as hook context and as a Stop continuation (harness)");
  assert.deepEqual(decide(withMode(RECORDS["goal-on"])), NONE, "a /goal whose text is the on phrase: turn trigger goal");
  assert.deepEqual(decide(withMode(RECORDS.fork)), NONE, "a fork record starts fresh: the parent's on is not in it");
});

test("the switches agree with core's mode rules: an on counts only while sage mode is on (F-T663-2)", () => {
  const turn = (trigger, ...texts) => [started(`turn-${trigger}`, trigger), ...texts.map((text) => owner(`turn-${trigger}`, text))];
  assert.deepEqual(decide([META, ...turn("user", "autopilot on", "sage mode")]), NONE, "probe A: the on while sage mode is off, then only the mode phrase");
  assert.deepEqual(decide([META, ...turn("user", "autopilot on")]), NONE, "the on alone: sage mode is off");
  assert.deepEqual(decide([META, ...turn("user", "sage mode", "autopilot on")]), ON, "the mode phrase, then the on");
  assert.deepEqual(decide([META, ...turn("user", "sage mode", "autopilot on", "sage mode off", "sage mode")]), OFF, "the off form of the mode phrase ends autopilot, and the mode phrase does not bring it back");
  assert.deepEqual(decide([META, ...turn("user", "sage mode on", "autopilot on", "sage mode off", "autopilot on")]), OFF, "an on after sage mode off is no switch");
  assert.deepEqual(decide([META, ...turn("queue", "sage mode"), ...turn("exec", "autopilot on")]), ON, "the mode phrase counts from any owner message; the on from a person's turn");
  assert.deepEqual(decide([META, ...turn("user", "sage mode", "autopilot on"), ...turn("queue", "sage mode off")]), OFF, "the off form of the mode phrase from a queued message");
  // A later session_meta (a startup or a fork) starts with both modes off, as a new mode file does.
  assert.deepEqual(decide([META, ...turn("user", "sage mode"), META, ...turn("exec", "autopilot on")]), NONE, "sage mode does not carry into a new session_meta");

  // Every sequence of up to 4 owner switches, in turns that a person started, gives what core's switchModes gives.
  const phrases = ["sage mode", "sage mode on", "sage mode off", "autopilot on", "autopilot off", "sage help"];
  const sequences = [[]];
  for (let length = 1; length <= 4; length++) for (const s of sequences.filter((q) => q.length === length - 1)) for (const p of phrases) sequences.push([...s, p]);
  assert.equal(sequences.length, 1 + 6 + 36 + 216 + 1296);
  let on = 0;
  for (const sequence of sequences) {
    const lines = [META, started("t", "user"), ...sequence.map((text) => owner("t", text))];
    const core = {};
    for (const text of sequence) switchModes({ owner: true, text, all: text }, core, { autopilotOn: () => "" });
    const result = autopilotSwitch({ entries: lines, lines: lines.length }, { lines: 0 });
    assert.equal(result.on, core.autopilot === true, JSON.stringify(sequence));
    if (result.on) on++;
  }
  assert.ok(on > 100 && on < sequences.length / 2, `some sequences are on, most are off (${on})`);
});

test("a resume writes no session_meta, so only the start mark keeps the earlier on from counting (proof case 5c)", () => {
  const lines = withMode(RECORDS["exec-on-then-resume"]);
  // The resume's mark: the record's line count when the resumed session starts, after the first start's last turn.
  const resumed = lines.findIndex((o) => o.payload.type === "task_complete") + 1;
  assert.equal(lines.slice(resumed).find((o) => o.payload.type === "task_started")?.payload.turn_attribution.turn_trigger, "exec", "a turn after the resume");
  assert.equal(lines.filter((o) => o.type === "session_meta").length, 1);
  const beforeOnAgain = lines.slice(0, lines.findLastIndex((o) => o.payload.role === "user" && o.payload.content?.[0]?.text === "autopilot on"));
  assert.deepEqual(decide(beforeOnAgain), ON, "without a mark, the on of the earlier start counts");
  assert.deepEqual(decide(beforeOnAgain, resumed), NONE, "with the mark at the resume, it does not");
  assert.deepEqual(decide(lines, resumed), ON, "the owner's on after the resume counts: sage mode carries over the resume, as the mode file does");
  assert.deepEqual(decide(lines, lines.length), NONE, "a mark at the end of the record: nothing after it");
});

test("the boundary is the later of the last session_meta line and the start mark; the mark is required (F-T663-5)", () => {
  const before = [META, started(TURN, "user"), owner(TURN, "sage mode"), owner(TURN, "autopilot on")];
  assert.deepEqual(decide([...before, META]), NONE, "a later session_meta line starts again");
  assert.deepEqual(decide([...before, META], 1), NONE, "an earlier mark does not move the boundary back");
  assert.deepEqual(decide(before, 3), ON);
  assert.deepEqual(decide(before, 4), NONE);
  for (const from of [5, -1, 1.5, "1", null]) assert.deepEqual(decide(before, from), { refused: "sage's note of this session start does not fit Codex's session record" }, String(from));
  // No start mark refuses: no default line (such as 0) stands for a missing mark, so an on from before a resume never counts.
  const record = read(before);
  for (const mark of [undefined, null, 0, 3, "3", []]) {
    assert.deepEqual(autopilotSwitch(record, mark), { refused: "sage saved no note when this session started, so it cannot tell which switches of the owner are from this start" }, JSON.stringify(mark));
  }
  assert.deepEqual(autopilotSwitch(record, { session: "s", source: "resume", lines: 3, pid: 7 }), ON, "the mark as start-mark.mjs saves it");
});

test("switches: exact phrases only; off from any owner message, on only in a turn of trigger user or exec", () => {
  const turn = (trigger, ...texts) => [started(`turn-${trigger}`, trigger), ...texts.map((text) => owner(`turn-${trigger}`, text))];
  const mode = turn("user", "sage mode");
  assert.deepEqual(decide([META, ...mode, ...turn("exec", "autopilot on")]), ON);
  assert.deepEqual(decide([META, ...mode, ...turn("exec", "  Autopilot ON. ")]), ON, "core's exact phrase: letter case, spaces at the ends, one full stop");
  for (const trigger of ["queue", "goal", "review", undefined]) assert.deepEqual(decide([META, ...mode, ...turn(trigger, "autopilot on")]), NONE, String(trigger));
  assert.deepEqual(decide([META, ...mode, owner("no-start-line", "autopilot on")]), NONE, "a turn without a task_started line");
  assert.deepEqual(decide([META, ...turn("user", "sage mode", "autopilot on"), ...turn("queue", "autopilot off")]), OFF, "off from a queued message");
  assert.deepEqual(decide([META, ...turn("user", "sage mode", "autopilot on"), ...turn("goal", "sage mode off")]), OFF, "the off form of the mode phrase");
  assert.deepEqual(decide([META, ...turn("user", "sage mode", "autopilot on", "sage mode", "sage mode on", "sage help")]), ON, "the mode phrases and help switch no autopilot");
  assert.deepEqual(decide([META, ...turn("user", "sage mode", "autopilot off", "autopilot on")]), ON, "the latest switch wins");
  for (const text of ["autopilot on please", "autopilot  on", "'autopilot on'", "autopilot on!", "autopilot on\nautopilot on"]) {
    assert.deepEqual(decide([META, ...turn("user", "sage mode", text)]), NONE, JSON.stringify(text));
  }
  assert.deepEqual(decide([META, ...turn("user", "sage mode", "autopilot on"), ...turn("exec", "turn autopilot off now")]), ON, "a sentence is no off");
});

test("only the owner's message counts: one metadata item with provenance user for each content item, and only text", () => {
  const user = started(TURN, "user");
  const mode = owner(TURN, "sage mode");
  assert.deepEqual(decide([META, user, mode, owner(TURN, "autopilot on")]), ON, "the owner's own message");
  assert.deepEqual(decide([META, user, mode, owner(TURN, "autopilot on", ["user", "harness"])]), NONE, "mixed provenance");
  assert.deepEqual(decide([META, user, mode, owner(TURN, "autopilot on", ["harness"])]), NONE);
  assert.deepEqual(decide([META, user, mode, owner(TURN, "autopilot on", [])]), NONE, "no provenance");
  // Probe C: two content items and one metadata item. The second item has no provenance, so the message is no owner's.
  const short = owner(TURN, "autopilot", ["user", "user"]);
  short.payload = { ...short.payload, content: [{ type: "input_text", text: "autopilot" }, { type: "input_text", text: " on" }],
    internal_chat_message_metadata_passthrough: { ...short.payload.internal_chat_message_metadata_passthrough, content_item_metadata: [{ provenance: { type: "user" } }] } };
  assert.deepEqual(decide([META, user, mode, short]), NONE, "probe C: two content items with one metadata item");
  const long = owner(TURN, "autopilot on");
  long.payload = { ...long.payload, internal_chat_message_metadata_passthrough: { ...long.payload.internal_chat_message_metadata_passthrough, content_item_metadata: [{ provenance: { type: "user" } }, { provenance: { type: "user" } }] } };
  assert.deepEqual(decide([META, user, mode, long]), NONE, "one content item with two metadata items");
  const image = owner(TURN, "autopilot on");
  image.payload = { ...image.payload, content: [...image.payload.content, { type: "input_image", image_url: "data:" }], internal_chat_message_metadata_passthrough: { ...image.payload.internal_chat_message_metadata_passthrough, content_item_metadata: [{ provenance: { type: "user" } }, { provenance: { type: "user" } }] } };
  assert.deepEqual(decide([META, user, mode, image]), NONE, "an image beside the phrase");
  const developer = owner(TURN, "autopilot on");
  developer.payload = { ...developer.payload, role: "developer" };
  assert.deepEqual(decide([META, user, mode, developer]), NONE);
  // The UserMessage event that Codex also writes (the legacy replay read it) is no owner message here.
  const event = RECORDS["exec-on"].find((o) => o.payload.type === "item_completed" && o.payload.item?.type === "UserMessage");
  assert.equal(event.payload.item.content[0].text, "autopilot on");
  assert.deepEqual(decide([META, user, mode, event]), NONE);
});

test("the record format fails closed: each unknown or broken record refuses", () => {
  const base = RECORDS["exec-on"];
  const refused = (reason) => ({ refused: reason });
  assert.deepEqual(decide([...base, { type: "brand_new_type", payload: {} }]), refused("line 22 of Codex's session record has an unknown type"));
  assert.deepEqual(decide([...base.slice(0, 5), "{not json", ...base.slice(5)]), refused("line 6 of Codex's session record is not JSON"));
  assert.deepEqual(decide([...base.slice(0, 5), "", ...base.slice(5)]), refused("line 6 of Codex's session record is not JSON"), "a blank line");
  for (const bad of ["null", "[]", '"text"', '{"type":"event_msg"}', '{"type":"event_msg","payload":null}', '{"type":"event_msg","payload":[]}']) {
    assert.deepEqual(decide([...base, bad]), refused("line 22 of Codex's session record has an unknown type"), bad);
  }
  assert.deepEqual(decide(base.slice(1)), refused("Codex's session record has no session_meta line"));
  assert.deepEqual(readRecord(recordFile([], "")), refused("Codex's session record has no session_meta line"), "an empty record");
  assert.deepEqual(readRecord(join(SCRATCH, "missing.jsonl")), refused("Codex's session record cannot be read (ENOENT)"));
  assert.deepEqual(readRecord(SCRATCH), refused("Codex's session record cannot be read (EISDIR)"));
  for (const path of [undefined, null, "", 7]) assert.deepEqual(readRecord(path), refused("Codex gave no path to its session record"), String(path));
});

test("Codex versions: 0.164 to 0.166 in the strict form read; any other version refuses", () => {
  const record = withMode(RECORDS["exec-on"]);
  for (const version of ["0.164.0", "0.165.3", "0.166.0", "0.166.0-alpha.6", "0.166.12"]) assert.deepEqual(decide([meta(version), ...record.slice(1)]), ON, version);
  for (const version of ["0.163.9", "0.167.0", "0.170.0", "1.164.0", "0.164", "0.164.0.1", "0.164.01", "v0.164.0", " 0.164.0", "0.164.0-alpha", "0.164.0+build", "0.164.0-alpha.6\n", undefined, 164]) {
    assert.deepEqual(decide([meta(version), ...record.slice(1)]), { refused: `Codex's session record is from Codex ${version}, and sage reads only the session records of Codex 0.164 to 0.166` }, String(version));
  }
  assert.ok(decide([meta("0.170.0"), ...record.slice(1), META]).refused, "every session_meta line is checked");
});

test("a partial last line is re-read up to 3 times, then refuses", () => {
  const lines = withMode(RECORDS["exec-on"]).map((o) => JSON.stringify(o));
  const file = recordFile(lines.slice(0, -1), `\n${lines.at(-1).slice(0, 20)}`);
  const pauses = [];
  assert.deepEqual(readRecord(file, { pause: (ms) => pauses.push(ms) }), { refused: "Codex's session record ends in a partial line" });
  assert.deepEqual(pauses, [50, 50, 50]);
  // Codex finishes the line during the second pause: the next read sees the whole record.
  let pause = 0;
  const record = readRecord(file, { pause: () => { if (++pause === 2) appendFileSync(file, `${lines.at(-1).slice(20)}\n`); } });
  assert.equal(pause, 2);
  assert.equal(record.lines, lines.length);
  assert.deepEqual(autopilotSwitch(record, { lines: 0 }), ON);
});

test("a record over 64 MiB refuses before it is read", () => {
  const file = recordFile(RECORDS["exec-on"]);
  truncateSync(file, RECORD_LIMIT + 1); // a sparse file: no 64 MiB write
  assert.deepEqual(readRecord(file), { refused: "Codex's session record is over 64 MiB" });
  truncateSync(file, RECORD_LIMIT);
  assert.deepEqual(readRecord(file), { refused: "Codex's session record ends in a partial line" }, "at the limit it reads (and finds no newline at the end)");
});

test("turnAborted finds Codex's turn_aborted event of that turn only (Esc)", () => {
  const record = read(RECORDS["tui-on-then-esc"]);
  const aborted = RECORDS["tui-on-then-esc"].find((o) => o.payload.type === "turn_aborted").payload.turn_id;
  assert.equal(turnAborted(record, aborted), true);
  assert.equal(turnAborted(record, "another-turn"), false);
  assert.equal(turnAborted(read(RECORDS["exec-on"]), RECORDS["exec-on"][1].payload.turn_id), false);
});

// Start marks: the SessionStart hooks of the built plugin, run as Codex runs them (one node process, JSON on stdin).
const SESSION = "019a0000-0000-7000-8000-00000000c0de";
/** A scratch home for the hooks, with a record of the session. */
function hookHome() {
  const home = realpathSync(mkdtempSync(join(SCRATCH, "home-")));
  const env = { PATH: process.env.PATH, HOME: home, CODEX_HOME: join(home, "codex"), SAGE_HOME: join(home, "sage"), SAGE_SHARED_HOME: process.env.SAGE_SHARED_HOME };
  return { env, transcript: recordFile(RECORDS["exec-on"]), dir: modeDirectory(env) };
}
/** Run one built hook on a SessionStart event of the session; its output object, or undefined. */
function start(h, script, source, extra = {}) {
  const r = spawnSync(process.execPath, [join(PLUGIN, "hooks", script)], { env: h.env, encoding: "utf8",
    input: JSON.stringify({ hook_event_name: "SessionStart", session_id: SESSION, cwd: h.env.HOME, transcript_path: h.transcript, source, ...extra }) });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout ? JSON.parse(r.stdout) : undefined;
}
const markOf = (h) => (existsSync(markFile(h.dir, SESSION)) ? JSON.parse(readFileSync(markFile(h.dir, SESSION), "utf8")) : undefined);
const HOOK_OF = { startup: "session-start-hook.mjs", resume: "session-start-hook.mjs", clear: "session-start-hook.mjs", fork: "sage-codex-hook.mjs", compact: "sage-codex-hook.mjs" };

test("startup, resume and clear (session-start-hook) and fork (sage-codex-hook) each save a start mark", () => {
  for (const source of ["startup", "resume", "clear", "fork"]) {
    const h = hookHome();
    const output = start(h, HOOK_OF[source], source);
    assert.doesNotMatch(output?.systemMessage ?? "", /could not save/, source);
    // pid: the hook's parent, which is Codex when Codex runs the hook (here, this test process).
    assert.deepEqual(markOf(h), { session: SESSION, source, lines: RECORDS["exec-on"].length, pid: process.pid }, source);
  }
});

test("a later start replaces the mark; compact saves none and keeps the earlier one; a child's start saves none", () => {
  const h = hookHome();
  start(h, HOOK_OF.compact, "compact");
  assert.equal(markOf(h), undefined, "compact alone saves none");
  start(h, HOOK_OF.startup, "startup");
  appendFileSync(h.transcript, `${JSON.stringify(RECORDS["exec-on"][2])}\n`);
  start(h, HOOK_OF.compact, "compact");
  assert.deepEqual(markOf(h), { session: SESSION, source: "startup", lines: RECORDS["exec-on"].length, pid: process.pid });
  start(h, HOOK_OF.resume, "resume");
  assert.deepEqual(markOf(h), { session: SESSION, source: "resume", lines: RECORDS["exec-on"].length + 1, pid: process.pid });
  const child = hookHome();
  start(child, HOOK_OF.startup, "startup", { agent_id: "agent-1" });
  start(child, HOOK_OF.fork, "fork", { agent_id: "agent-1" });
  assert.equal(markOf(child), undefined);
});

test("a start before Codex writes the record marks line 0; a partial last line counts as a line", () => {
  const h = hookHome();
  rmSync(h.transcript);
  start(h, HOOK_OF.startup, "startup");
  assert.equal(markOf(h).lines, 0);
  writeFileSync(h.transcript, `${JSON.stringify(META)}\n{"type":"event_m`);
  start(h, HOOK_OF.fork, "fork");
  assert.equal(markOf(h).lines, 2);
});

test("a failed mark save gives the user a plain limit line, never blocks, and removes the earlier mark", () => {
  for (const source of ["resume", "fork"]) {
    const h = hookHome();
    // The limit line in plain words (F-T663-6): what failed and what it means, then the folder to check.
    const limit = `sage: the sage hook could not save its note of this session start, so autopilot merges nothing until the session starts again. Check that sage can write to the folder ${h.dir} (EACCES).`;
    for (const sentence of limit.replace(h.dir, "X").split(/(?<=\.) /)) assert.ok(sentence.split(" ").length <= 25, sentence);
    start(h, HOOK_OF[source], source);
    assert.ok(markOf(h), source);
    chmodSync(h.transcript, 0o000); // the record cannot be read, so the hook cannot count its lines
    try {
      const output = start(h, HOOK_OF[source], source);
      assert.ok(output.systemMessage.split("\n").includes(limit), `${source}: ${output.systemMessage}`);
      assert.equal(output.hookSpecificOutput.hookEventName, "SessionStart", "the event's own answer stays");
      assert.equal(markOf(h), undefined, `${source}: no stale mark stays`);
    } finally { chmodSync(h.transcript, 0o600); }
    chmodSync(join(h.dir, "marks"), 0o500); // the marks folder cannot change
    try {
      assert.ok(start(h, HOOK_OF[source], source).systemMessage.split("\n").includes(limit), source);
    } finally { chmodSync(join(h.dir, "marks"), 0o700); }
  }
});
