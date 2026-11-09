import "./test-env.mjs"; // first: no variable of the developer's shell changes a result
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// The Codex autopilot's owner record reader and start marks (T663), on real Codex 0.164.0 records of the T662 proof.
// fixtures/codex-owner-records.json holds those records, scrubbed and trimmed: no path or text of the machine that made them, and
// the proof's probe phrases replaced with sage's phrases. Every case that the reader cannot prove refuses.
const PLUGIN = fileURLToPath(new URL("../plugins/sage-codex", import.meta.url));
const { readRecord, autopilotSwitch, onCanCount, turnAborted, RECORD_LIMIT } = await import(join(PLUGIN, "hooks/owner-record.mjs"));
const { exactPhrase, switchModes } = await import(join(PLUGIN, "core/index.mjs"));
const { markFile } = await import(join(PLUGIN, "hooks/start-mark.mjs"));
const { modeDirectory } = await import(join(PLUGIN, "hooks/sage-codex-hook.mjs"));
const RECORDS = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/codex-owner-records.json", import.meta.url)), "utf8"));

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
/** The turn of the record's last user message in a turn that is the on phrase: the turn that the mode hook saved for that on. */
const lastOn = (lines) => lines.findLast((o) => o?.payload?.type === "message" && o.payload.role === "user" && o.payload.internal_chat_message_metadata_passthrough?.turn_id
  && exactPhrase(o.payload.content.map((item) => item.text ?? "").join("")) === "autopilot on")?.payload.internal_chat_message_metadata_passthrough.turn_id;
/** The switch of a record, with the mode file's on turn (by default the turn of its last on phrase). */
const sw = (record, mark, onTurn = lastOn(record.entries)) => autopilotSwitch(record, mark, onTurn);
/** The switch of a record with a start mark at line from, or its refusal. */
const decide = (lines, from = 0, onTurn) => {
  const record = read(lines);
  return record.refused ? { refused: record.refused } : sw(record, { lines: from }, onTurn);
};
const ON = { on: true };
const NONE = { on: false, reason: "the owner has not turned autopilot on, with sage mode on, since this session started" };
const OFF = { on: false, reason: "the owner's latest autopilot switch is off" };
// The refusals (F-T663-14): a plain cause and one next step, then a short technical detail in brackets, if any.
const IN_GITHUB = "The owner merges the pull request in GitHub";
const FORM = (detail) => ({ refused: `sage does not know the form of Codex's record of this session. ${IN_GITHUB} (${detail})` });
const RESUME = "Resume the session, then the owner turns autopilot on again. Or the owner merges the pull request in GitHub";
const NO_MARK = { refused: `sage saved no note when this session started, so it cannot tell which of the owner's switches are from this start. ${RESUME}` };
const BAD_MARK = { refused: `sage's note of this session start does not match Codex's record of this session. ${RESUME}` };
const VERSION = (version) => ({ refused: `this session runs Codex ${version}, and sage reads the records of Codex 0.164 to 0.167 only. A newer Codex waits until sage adds it. Until then, the owner merges the pull request in GitHub` });
/** Each sentence of a text for the owner, without its bracketed detail, has 25 words or fewer and no internal name. */
function assertPlain(text) {
  assert.doesNotMatch(text.replace(/ \([^()]*\)$/, ""), /session_meta|\bline \d|partial|unknown type|ENOENT|EACCES/, text);
  for (const sentence of text.replace(/ \([^()]*\)$/, "").split(/(?<=\.) /)) assert.ok(sentence.split(" ").length <= 25, sentence);
}

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
/** The record with the owner's mode phrase (sage mode on) in a turn of its own, before its first turn. */
function withMode(lines) {
  const first = lines.findIndex((o) => o.payload.type === "task_started");
  return [...lines.slice(0, first), started("mode-turn", lines[first].payload.turn_attribution.turn_trigger), owner("mode-turn", "sage mode"), ...lines.slice(first)];
}
let turns = 0;
/** One turn for each text, each started with this trigger by that owner's message. */
const turn = (trigger, ...texts) => texts.flatMap((text) => { const id = `turn-${++turns}`; return [started(id, trigger), owner(id, text)]; });

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

test("F-T677-12: a real record of the desktop app's Codex: the owner's on, typed in the app's composer, counts", () => {
  // R2714 made this record with the desktop app's own Codex binary (0.166.0-alpha.6) over app-server stdio, with turns
  // started as the app starts a typed message: its send path sets turnTrigger ?? "composer" (the app's program code).
  // The turns: the mode phrase, the on phrase, then a step that runs sage's merge command (which the gate admitted).
  const lines = RECORDS["app-composer-on"];
  assert.equal(lines[0].payload.cli_version, "0.166.0-alpha.6");
  assert.deepEqual(lines.filter((o) => o.payload.type === "task_started").map((o) => o.payload.turn_attribution.turn_trigger), ["composer", "composer", "composer"]);
  assert.deepEqual(decide(lines), ON, "the mode phrase, then the on phrase, each typed in the app");
  assert.deepEqual(decide(lines, 9), ON, "with the start mark of that run");
  // Every other turn trigger of the on's turn counts for nothing: the app's queue, its other automatic turns, Codex's own
  // turns, and a client that sends none. Only the on's turn changes; the mode phrase stays in a composer turn.
  const onTurn = lines.find((o) => o.payload.role === "user" && o.payload.content?.[0]?.text === "autopilot on").payload.internal_chat_message_metadata_passthrough.turn_id;
  const withTrigger = (trigger) => lines.map((o) => (o.payload.type === "task_started" && o.payload.turn_id === onTurn ? started(onTurn, trigger) : o));
  for (const trigger of ["composer_queue", "composer_queue_run_now", "page_composer", "edit_user_message", "automation_cron_scheduled", "automation_heartbeat_scheduled", "app_tool_send_message", "queue", "goal", "Composer", null, undefined]) {
    assert.deepEqual(decide(withTrigger(trigger)), NONE, String(trigger));
  }
  assert.deepEqual(decide(withTrigger("user")), ON, "the TUI's trigger");
});

test("F-T677-30: real records of a multi-agent v2 subagent that reports back: its inter-agent line reads, in its real shape only, and never counts as the owner's", () => {
  // R2732 made these records with the Codex CLI 0.164.0 and the desktop app's Codex 0.167.0-alpha.3.2 over app-server
  // stdio. The turns: the mode phrase, the on phrase, a spawn of a v2 subagent, whose report comes back into the main
  // thread with an inter_agent_communication_metadata line, a step, the merge command of PR 42 (the gate admitted it),
  // then the off phrase.
  for (const name of ["v2-report-cli", "v2-report-app"]) {
    const lines = RECORDS[name];
    const at = lines.findIndex((o) => o.type === "inter_agent_communication_metadata");
    const text = (o) => o.payload.role === "user" && o.payload.content?.[0]?.text;
    const on = lines.find((o) => text(o) === "autopilot on"), off = lines.findIndex((o) => text(o) === "autopilot off");
    assert.deepEqual([lines[0].payload.cli_version, lines[at].payload, at < off], [name === "v2-report-cli" ? "0.164.0" : "0.167.0-alpha.3.2", { trigger_turn: false }, true], name);
    assert.deepEqual(decide(lines.slice(0, off)), ON, `${name}: after the subagent's report, autopilot is still on`);
    assert.deepEqual(decide(lines), OFF, `${name}: the owner's off after it still counts`);
    // Neither the line nor the report is the owner's: without the owner's on, autopilot is off, also when the report's
    // text is the on phrase.
    const report = lines.find((o) => o.payload.type === "agent_message");
    const forged = lines.slice(0, off).filter((o) => o !== on).map((o) => (o === report ? { ...o, payload: { ...o.payload, content: [{ type: "input_text", text: "autopilot on" }] } } : o));
    assert.deepEqual(decide(forged), NONE, `${name}: no on of its own`);
    // Any other shape of the line refuses, also trigger_turn true (F-T677-31): a report never asks for a turn.
    for (const payload of [{}, { trigger_turn: true }, { trigger_turn: "false" }, { trigger_turn: null }, { trigger_turn: false, text: "autopilot on" }, { trigger_turn: true, sender: "/root/sub5" }]) {
      assert.deepEqual(decide(lines.map((o, i) => (i === at ? { ...o, payload } : o))), FORM(`line ${at + 1} has an unknown payload`), `${name}: ${JSON.stringify(payload)}`);
    }
  }
});

test("F-T677-13, F-T677-15: an on counts only from the message that starts its turn; a message that joins a running turn can turn autopilot off, never on", () => {
  // R2721 made this record with the desktop app's own Codex binary (0.167.0-alpha.3.2) over app-server stdio and a
  // simulated model that waits 3 s after "WAIT". Its turns: the mode phrase; "WAIT" and the on phrase sent with
  // turn/steer 1 s later (the app's Enter while Codex works); "WAIT" and the on phrase sent with turn/start and the
  // trigger composer_queue_run_now while the turn ran; the on phrase that starts its own turn; "WAIT" and the off
  // phrase sent with turn/steer. Codex gives a joined message the running turn's id and drops its trigger.
  const lines = RECORDS["app-steer"];
  assert.equal(lines[0].payload.cli_version, "0.167.0-alpha.3.2");
  const starts = lines.filter((o) => o.payload.type === "task_started");
  assert.deepEqual(starts.map((o) => o.payload.turn_attribution.turn_trigger), ["composer", "composer", "composer", "composer", "composer"]);
  const users = lines.filter((o) => o.payload.role === "user" && o.payload.internal_chat_message_metadata_passthrough.content_item_metadata[0].provenance.type === "user");
  const turnOf = (o) => starts.findIndex((s) => s.payload.turn_id === o.payload.internal_chat_message_metadata_passthrough.turn_id);
  assert.deepEqual(users.map((o) => [turnOf(o), o.payload.content[0].text]),
    [[0, "sage mode"], [1, "WAIT"], [1, "autopilot on"], [2, "WAIT"], [2, "autopilot on"], [3, "autopilot on"], [4, "WAIT"], [4, "autopilot off"]]);
  /** The record up to the end of that turn (0 to 3). */
  const upTo = (turn) => lines.slice(0, lines.indexOf(starts[turn + 1]));
  assert.deepEqual(decide(upTo(1)), NONE, "an on that joins a running composer turn (turn/steer) counts for nothing");
  assert.deepEqual(decide(upTo(2)), NONE, "an on sent with the queue's run-now trigger while a turn runs joins that turn: it counts for nothing");
  assert.deepEqual(decide(upTo(3)), ON, "an on that starts a composer turn counts");
  assert.deepEqual(decide(lines), OFF, "an off that joins a running turn counts");
  // The same turns in the terminal UI (trigger user): Enter while Codex works joins the turn in the same way.
  const tui = lines.map((o) => (o.payload.type === "task_started" ? started(o.payload.turn_id, "user") : o));
  assert.deepEqual([decide(tui.slice(0, upTo(1).length)), decide(tui.slice(0, upTo(2).length)), decide(tui.slice(0, upTo(3).length)), decide(tui)], [NONE, NONE, ON, OFF], "trigger user");
  // A real CLI 0.164.0 record: the on starts a TUI turn, then the off typed with Enter joins it.
  const cli = withMode(RECORDS["tui-on-then-off"]);
  const offAt = cli.findIndex((o) => o.payload.role === "user" && o.payload.content?.[0]?.text === "autopilot off");
  assert.deepEqual([decide(cli.slice(0, offAt)), decide(cli)], [ON, OFF], "an on that starts a CLI user turn counts; the joined off counts");
  // A queued on that runs as its own turn counts for nothing, as before (F-T677-12).
  const onTurn = starts[3].payload.turn_id;
  for (const trigger of ["composer_queue", "composer_queue_run_now"]) {
    assert.deepEqual(decide(upTo(3).map((o) => (o === starts[3] ? started(onTurn, trigger) : o))), NONE, trigger);
  }
  // A shape that the reader does not know fails closed for an on and open for an off.
  const on = users.find((o) => turnOf(o) === 3);
  const at = lines.indexOf(on);
  const before = (line) => [...lines.slice(0, at), line, ...lines.slice(at, upTo(3).length)];
  const pass = on.payload.internal_chat_message_metadata_passthrough;
  const message = (passthrough, text = "hello") => ({ ...on, payload: { ...on.payload, content: [{ type: "input_text", text }], internal_chat_message_metadata_passthrough: passthrough } });
  assert.deepEqual(decide(before(message({ ...pass, content_item_metadata: [{ provenance: { type: "harness", hook: false } }] }))), ON, "Codex's own context before the on, as at a session's first turn");
  assert.deepEqual(decide(before(message({ turn_id: pass.turn_id }))), NONE, "a message of the turn with no metadata before the on");
  assert.deepEqual(decide(before(message({ ...pass, content_item_metadata: [{ provenance: { type: "user" } }, { provenance: { type: "harness" } }] }))), NONE, "a message of mixed provenance before the on");
  assert.deepEqual(decide(before(message({ ...pass, content_item_metadata: [] }))), NONE, "a message with no metadata item before the on");
  assert.deepEqual(decide(before(message({ ...pass, content_item_metadata: [{ provenance: { type: "tool" } }] }))), NONE, "a tool's message before the on");
  const noTurn = (({ turn_id, ...rest }) => rest)(pass);
  assert.deepEqual(decide([...lines.slice(0, at), message(noTurn, "autopilot on"), ...lines.slice(at + 1, upTo(3).length)]), NONE, "an on with no turn id");
  assert.deepEqual(decide([...upTo(3), message(noTurn, "autopilot off")]), OFF, "an off with no turn id counts");
});

test("F-T677-31: an on that joins a main-thread turn that a subagent's report started counts for nothing", () => {
  // Codex can wake an idle main thread for a subagent's report (trigger_turn false) and keeps the earlier turn's
  // settings, so the new turn has the trigger composer (Codex's tasks/mod.rs, maybe_start_turn_for_pending_work). The
  // turn here: the real lines of the report in v2-report-cli, moved to a new turn after the owner's off.
  const lines = RECORDS["v2-report-cli"];
  const at = lines.findIndex((o) => o.type === "inter_agent_communication_metadata");
  const start = lines.findLast((o, i) => i < at && o.payload.type === "task_started");
  const on = lines.find((o) => o.payload.role === "user" && o.payload.content?.[0]?.text === "autopilot on");
  const inTurn = (o, id) => ({ ...o, payload: { ...o.payload, internal_chat_message_metadata_passthrough: { ...o.payload.internal_chat_message_metadata_passthrough, turn_id: id } } });
  const woken = [started("woken", start.payload.turn_attribution.turn_trigger), lines[at], inTurn(lines[at + 1], "woken")];
  assert.deepEqual([woken[0].payload.turn_attribution.turn_trigger, woken[1].payload, woken[2].payload.type], ["composer", { trigger_turn: false }, "agent_message"]);
  assert.deepEqual(decide([...lines, ...woken, inTurn(on, "woken")]), OFF, "the owner's on joins the woken turn: autopilot stays off");
  assert.equal(onCanCount(read([...lines, ...woken]), "woken"), false, "the mode hook sees that the turn has started");
  // The same on, when it starts its own turn after the woken one, counts.
  assert.deepEqual(decide([...lines, ...woken, started("next", "composer"), inTurn(on, "next")]), ON);
});

test("F-T677-33: the on that counts must be the on whose turn the mode file saved", () => {
  // The owner's on starts turn A, so the record counts it. Then an off from a fork or a subagent's thread turns the mode
  // file off; Codex's record of the main thread does not show it. A later on that joins a running turn (here turn X,
  // which "WAIT" started) turns the mode file on again with turn X, but the record still counts only the on of turn A.
  const lines = [META, ...turn("user", "sage mode"), started("A", "composer"), owner("A", "autopilot on"), started("X", "composer"), owner("X", "WAIT"), owner("X", "autopilot on")];
  const DID = { on: false, reason: `the owner's latest "autopilot on" did not count, because only an on that is the whole message and starts a new turn counts` };
  assert.deepEqual(decide(lines, 0, "A"), ON, "the mode file's on is the on that the record counts");
  assert.deepEqual(decide(lines, 0, "X"), DID, "the mode file's on joined turn X: no merge");
  assert.deepEqual(decide(lines, 0, undefined), DID, "a mode file with no on turn (saved before this rule): no merge");
  assert.deepEqual(decide([...lines, started("B", "user"), owner("B", "autopilot on")], 0, "B"), ON, "a new on that starts its own turn counts again");
  // An on that the record does not count, with no on before it: the reason is the same.
  assert.deepEqual(decide([META, ...turn("user", "sage mode"), started("X", "composer"), owner("X", "WAIT"), owner("X", "autopilot on")], 0, "X"), NONE);
  assertPlain(DID.reason);
});

test("onCanCount: the mode hook's view of a turn before Codex records the owner's message", () => {
  const lines = RECORDS["app-steer"];
  const starts = lines.filter((o) => o.payload.type === "task_started").map((o) => o.payload.turn_id);
  const record = read(lines);
  assert.equal(onCanCount(record, starts[1]), false, "a turn that WAIT started: an on now joins it");
  assert.equal(onCanCount(read(lines.slice(0, lines.indexOf(lines.find((o) => o.payload.type === "task_started" && o.payload.turn_id === starts[3])) + 2)), starts[3]), true, "a composer turn with no message yet");
  assert.equal(onCanCount(record, "a-turn-not-written-yet"), true, "Codex has not written the turn yet: the gate decides");
  for (const trigger of ["composer_queue", "goal", "queue"]) assert.equal(onCanCount(read([...lines, started("q", trigger)]), "q"), false, trigger);
  assert.equal(onCanCount(read([...lines, started("q", "user")]), "q"), true, "the terminal UI's turn");
});

test("the switches agree with core's mode rules: an on counts only while sage mode is on (F-T663-2)", () => {
  assert.deepEqual(decide([META, ...turn("user", "autopilot on", "sage mode")]), NONE, "probe A: the on while sage mode is off, then only the mode phrase");
  assert.deepEqual(decide([META, ...turn("user", "autopilot on")]), NONE, "the on alone: sage mode is off");
  assert.deepEqual(decide([META, ...turn("user", "sage mode", "autopilot on")]), ON, "the mode phrase, then the on");
  assert.deepEqual(decide([META, ...turn("user", "sage mode", "autopilot on", "sage mode off", "sage mode")]), OFF, "the off form of the mode phrase ends autopilot, and the mode phrase does not bring it back");
  assert.deepEqual(decide([META, ...turn("user", "sage mode on", "autopilot on", "sage mode off", "autopilot on")]), OFF, "an on after sage mode off is no switch");
  assert.deepEqual(decide([META, ...turn("queue", "sage mode"), ...turn("exec", "autopilot on")]), ON, "the mode phrase counts from any owner message; the on from a person's turn");
  assert.deepEqual(decide([META, ...turn("user", "sage mode", "autopilot on"), ...turn("queue", "sage mode off")]), OFF, "the off form of the mode phrase from a queued message");
  // A later session_meta (a startup or a fork) starts with both modes off, as a new mode file does.
  assert.deepEqual(decide([META, ...turn("user", "sage mode"), META, ...turn("exec", "autopilot on")]), NONE, "sage mode does not carry into a new session_meta");

  // Every sequence of up to 4 owner switches, each starting a turn that a person started, gives what core's switchModes gives.
  const phrases = ["sage mode", "sage mode on", "sage mode off", "autopilot on", "autopilot off", "sage help"];
  const sequences = [[]];
  for (let length = 1; length <= 4; length++) for (const s of sequences.filter((q) => q.length === length - 1)) for (const p of phrases) sequences.push([...s, p]);
  assert.equal(sequences.length, 1 + 6 + 36 + 216 + 1296);
  let on = 0;
  for (const sequence of sequences) {
    const lines = [META, ...turn("user", ...sequence)];
    const core = {};
    for (const text of sequence) switchModes({ owner: true, text, all: text }, core, { autopilotOn: () => "" });
    const result = sw({ entries: lines, lines: lines.length }, { lines: 0 });
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
  const before = [META, started("mode-turn", "user"), owner("mode-turn", "sage mode"), started(TURN, "user"), owner(TURN, "autopilot on")];
  assert.deepEqual(decide([...before, META]), NONE, "a later session_meta line starts again");
  assert.deepEqual(decide([...before, META], 1), NONE, "an earlier mark does not move the boundary back");
  assert.deepEqual(decide(before, 4), ON);
  assert.deepEqual(decide(before, 5), NONE);
  for (const from of [6, -1, 1.5, "1", null]) assert.deepEqual(decide(before, from), BAD_MARK, String(from));
  // No start mark refuses: no default line (such as 0) stands for a missing mark, so an on from before a resume never counts.
  const record = read(before);
  for (const mark of [undefined, null, 0, 3, "3", []]) assert.deepEqual(sw(record,mark), NO_MARK, JSON.stringify(mark));
  for (const { refused } of [NO_MARK, BAD_MARK]) assertPlain(refused);
  assert.deepEqual(sw(record,{ session: "s", source: "resume", lines: 3, pid: 7 }), ON, "the mark as start-mark.mjs saves it");
});

test("switches: exact phrases only; off from any owner message, on only in a turn of trigger user, exec or composer", () => {
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

test("only the owner's message counts: one metadata item with provenance user for each content item; an on needs text only, an off does not", () => {
  const user = started(TURN, "user");
  /** The mode phrase in a turn of its own, then the start of the turn TURN. */
  const MODE = [META, started("mode-turn", "user"), owner("mode-turn", "sage mode"), user];
  assert.deepEqual(decide([...MODE, owner(TURN, "autopilot on")]), ON, "the owner's own message");
  assert.deepEqual(decide([...MODE,owner(TURN, "autopilot on", ["user", "harness"])]), NONE, "mixed provenance");
  assert.deepEqual(decide([...MODE,owner(TURN, "autopilot on", ["harness"])]), NONE);
  assert.deepEqual(decide([...MODE,owner(TURN, "autopilot on", [])]), NONE, "no provenance");
  // Probe C: two content items and one metadata item. The second item has no provenance, so the message is no owner's.
  const short = owner(TURN, "autopilot", ["user", "user"]);
  short.payload = { ...short.payload, content: [{ type: "input_text", text: "autopilot" }, { type: "input_text", text: " on" }],
    internal_chat_message_metadata_passthrough: { ...short.payload.internal_chat_message_metadata_passthrough, content_item_metadata: [{ provenance: { type: "user" } }] } };
  assert.deepEqual(decide([...MODE,short]), NONE, "probe C: two content items with one metadata item");
  const long = owner(TURN, "autopilot on");
  long.payload = { ...long.payload, internal_chat_message_metadata_passthrough: { ...long.payload.internal_chat_message_metadata_passthrough, content_item_metadata: [{ provenance: { type: "user" } }, { provenance: { type: "user" } }] } };
  assert.deepEqual(decide([...MODE,long]), NONE, "one content item with two metadata items");
  const image = owner(TURN, "autopilot on");
  image.payload = { ...image.payload, content: [...image.payload.content, { type: "input_image", image_url: "data:" }], internal_chat_message_metadata_passthrough: { ...image.payload.internal_chat_message_metadata_passthrough, content_item_metadata: [{ provenance: { type: "user" } }, { provenance: { type: "user" } }] } };
  assert.deepEqual(decide([...MODE,image]), NONE, "an image beside the phrase");
  // F-T663-11: Codex gives the sage hook only the text items of a message (0.160 UserMessageItem::message() joins them),
  // so an off phrase with an image switches the hook off. The reader counts that off too; an on still needs text only.
  /** An owner's message of these items, each with this provenance. */
  const items = (content, provenance = "user") => {
    const message = owner(TURN, "");
    message.payload = { ...message.payload, content, internal_chat_message_metadata_passthrough: { ...message.payload.internal_chat_message_metadata_passthrough,
      content_item_metadata: content.map(() => ({ provenance: { type: provenance } })) } };
    return message;
  };
  const picture = { type: "input_image", image_url: "data:" };
  const on = owner(TURN, "autopilot on");
  for (const off of ["autopilot off", "sage mode off", " Autopilot OFF. "]) {
    assert.deepEqual(decide([...MODE,on, items([{ type: "input_text", text: off }, picture])]), OFF, `${off} with an image after it`);
    assert.deepEqual(decide([...MODE,on, items([picture, { type: "input_text", text: off }])]), OFF, `${off} with an image before it`);
  }
  assert.deepEqual(decide([...MODE,on, items([{ type: "input_text", text: "autopilot" }, picture, { type: "input_text", text: " off" }])]), OFF, "text items joined, as Codex joins them");
  // F-T663-27: an off counts from any user message, also one that is not provably the owner's: an extra off only makes merges wait.
  assert.deepEqual(decide([...MODE,on, items([{ type: "input_text", text: "autopilot off" }, picture], "harness")]), OFF, "an off with another provenance");
  assert.deepEqual(decide([...MODE,on, items([picture])]), ON, "an image alone");
  const onTurn = [started("on-turn", "user"), owner("on-turn", "autopilot on")];
  assert.deepEqual(decide([META, user, items([{ type: "input_text", text: "sage mode" }, picture]), ...onTurn]), ON, "the mode phrase with an image turns sage mode on, as in the hook (F-T663-23)");
  assert.deepEqual(decide([META, user, items([{ type: "input_text", text: "sage mode" }, picture], "harness"), ...onTurn]), NONE, "but only the owner's");
  assert.deepEqual(decide([...MODE,items([{ type: "input_text", text: "autopilot on" }, picture])]), NONE, "the on phrase with an image counts for nothing");
  const developer = owner(TURN, "autopilot on");
  developer.payload = { ...developer.payload, role: "developer" };
  assert.deepEqual(decide([...MODE,developer]), NONE);
  // The UserMessage event that Codex also writes (the legacy replay read it) is no owner message here.
  const event = RECORDS["exec-on"].find((o) => o.payload.type === "item_completed" && o.payload.item?.type === "UserMessage");
  assert.equal(event.payload.item.content[0].text, "autopilot on");
  assert.deepEqual(decide([...MODE,event]), NONE);
});

test("F-T663-11, F-T663-18: a real Codex 0.164.0 record: the off phrase sent with a local image, inside Codex's image tags, turns autopilot off", () => {
  // R2690 made this record with the Codex CLI 0.164.0 in a scratch home: codex exec with the mode phrase, a resume with
  // the on phrase, and a resume with the off phrase and --image. Codex wraps the image in two text items of its own.
  const lines = RECORDS["image-off"];
  const off = lines.filter((o) => o.payload.role === "user").at(-1).payload;
  assert.deepEqual(off.content.map((c) => c.text ?? c.type), ['<image name=[Image #1] path="/fixture/proj/dot.png">', "input_image", "</image>", "autopilot off"]);
  assert.deepEqual(off.internal_chat_message_metadata_passthrough.content_item_kinds, ["user.text", "user.image", "user.text", "user.text"]);
  assert.deepEqual(decide(lines.slice(0, lines.indexOf(lines.find((o) => o.payload === off)))), ON, "before the off: the mode phrase, then the on");
  assert.deepEqual(decide(lines), OFF, "the off with the image");
  // Codex's note for an image that it could not read is no text of the owner's (a harness item of its own kind).
  const note = { ...lines.find((o) => o.payload === off), payload: { ...off, content: [off.content[0], { type: "input_text", text: "image content omitted because it could not be processed" }, off.content[2], off.content[3]],
    internal_chat_message_metadata_passthrough: { ...off.internal_chat_message_metadata_passthrough, content_item_kinds: ["user.text", "images.preparation_error", "user.text", "user.text"],
      content_item_metadata: [{ provenance: { type: "user" } }, { provenance: { type: "harness", hook: false } }, { provenance: { type: "user" } }, { provenance: { type: "user" } }] } } };
  // Without the off's UserMessage event, which would count the off by itself.
  const offEvent = (o) => o.payload.item?.type === "UserMessage" && o.payload.item.content.some((c) => c.text === "autopilot off");
  assert.deepEqual(decide([...lines.filter((o) => o.payload !== off && !offEvent(o)), note]), OFF, "an image that Codex could not read");
  assert.deepEqual(decide(lines.filter((o) => !offEvent(o))), OFF, "the off message alone, without its event");
});

test("F-T663-23: a real Codex 0.164.0 record: the mode phrase sent with a local image turns sage mode on, as the mode hook does", () => {
  const lines = RECORDS["image-mode"];
  assert.deepEqual(lines.filter((o) => o.payload.role === "user").slice(1).map((o) => o.payload.content.map((c) => c.text ?? c.type).at(-1)), ["sage mode", "autopilot on"]);
  assert.deepEqual(decide(lines), ON);
  // The on phrase still counts only alone: with an image it counts for nothing.
  const on = lines.filter((o) => o.payload.role === "user").at(-1);
  const image = RECORDS["image-off"].filter((o) => o.payload.role === "user").at(-1).payload;
  const onWithImage = { ...on, payload: { ...on.payload, content: [...image.content.slice(0, 3), { type: "input_text", text: "autopilot on" }],
    internal_chat_message_metadata_passthrough: { ...on.payload.internal_chat_message_metadata_passthrough, content_item_kinds: image.internal_chat_message_metadata_passthrough.content_item_kinds,
      content_item_metadata: image.internal_chat_message_metadata_passthrough.content_item_metadata } } };
  assert.deepEqual(decide(lines.map((o) => (o === on ? onWithImage : o))), NONE);
});

test("F-T663-27: an off counts from any user message, with missing, short or long metadata, and from Codex's UserMessage event", () => {
  const user = started(TURN, "user");
  const base = [META, started("mode-turn", "user"), owner("mode-turn", "sage mode"), user, owner(TURN, "autopilot on")];
  const off = owner(TURN, "autopilot off");
  const pass = off.payload.internal_chat_message_metadata_passthrough;
  const shapes = {
    "no metadata": { ...off.payload, internal_chat_message_metadata_passthrough: { turn_id: TURN } },
    "no passthrough": (({ internal_chat_message_metadata_passthrough, ...rest }) => rest)(off.payload),
    "two metadata items for one content item": { ...off.payload, internal_chat_message_metadata_passthrough: { ...pass, content_item_metadata: [{ provenance: { type: "user" } }, { provenance: { type: "user" } }] } },
    "no metadata item": { ...off.payload, internal_chat_message_metadata_passthrough: { ...pass, content_item_metadata: [] } },
    "a tool provenance": { ...off.payload, internal_chat_message_metadata_passthrough: { ...pass, content_item_metadata: [{ provenance: { type: "tool" } }] } },
  };
  for (const [name, payload] of Object.entries(shapes)) {
    assert.deepEqual(decide([...base, { ...off, payload }]), OFF, name);
    assert.deepEqual(decide([...base, { ...off, payload: { ...payload, content: [{ type: "input_text", text: "sage mode off" }] } }]), OFF, `${name}: the mode phrase's off form`);
    assert.deepEqual(decide([...base, { ...off, payload: { ...payload, content: [{ type: "input_text", text: "autopilot on" }] } }]), ON, `${name}: no on of its own`);
  }
  const event = RECORDS["exec-on"].find((o) => o.payload.type === "item_completed" && o.payload.item?.type === "UserMessage");
  const offEvent = { ...event, payload: { ...event.payload, item: { ...event.payload.item, content: [{ type: "local_image", path: "/fixture/a.png" }, { type: "text", text: "autopilot off" }] } } };
  assert.deepEqual(decide([...base, offEvent]), OFF, "the UserMessage event of the off, with its image");
  assert.deepEqual(decide([META, user, owner(TURN, "sage mode"), { ...event, payload: { ...event.payload, item: { ...event.payload.item, content: [{ type: "text", text: "autopilot on" }] } } }]), NONE, "an on from the event counts for nothing");
});

test("the record format fails closed: each unknown or broken record refuses", () => {
  const base = RECORDS["exec-on"];
  assert.deepEqual(decide([...base, { type: "brand_new_type", payload: {} }]), FORM("line 22 has an unknown type"));
  assert.deepEqual(decide([...base.slice(0, 5), "{not json", ...base.slice(5)]), FORM("line 6 is not JSON"));
  assert.deepEqual(decide([...base.slice(0, 5), "", ...base.slice(5)]), FORM("line 6 is not JSON"), "a blank line");
  for (const bad of ["null", "[]", '"text"', '{"type":"event_msg"}', '{"type":"event_msg","payload":null}', '{"type":"event_msg","payload":[]}']) {
    assert.deepEqual(decide([...base, bad]), FORM("line 22 has an unknown type"), bad);
  }
  assert.deepEqual(decide(base.slice(1)), FORM("no session_meta line"));
  assert.deepEqual(readRecord(recordFile([], "")), FORM("no session_meta line"), "an empty record");
  const unread = (code) => ({ refused: `sage cannot read Codex's record of this session. Ask for the merge again. If it refuses again, the owner merges the pull request in GitHub (${code})` });
  assert.deepEqual(readRecord(join(SCRATCH, "missing.jsonl")), unread("ENOENT"));
  assert.deepEqual(readRecord(SCRATCH), unread("EISDIR"));
  const noRecord = { refused: `Codex keeps no record of this session, so sage cannot read the owner's autopilot switch. ${IN_GITHUB}` };
  for (const path of [undefined, null, "", 7]) assert.deepEqual(readRecord(path), noRecord, String(path));
  for (const { refused } of [FORM("line 6 is not JSON"), unread("ENOENT"), noRecord]) assertPlain(refused);
});

test("Codex versions: 0.164 to 0.167 in the strict form read; any other version refuses (F-T677-16)", () => {
  const record = withMode(RECORDS["exec-on"]);
  for (const version of ["0.164.0", "0.165.3", "0.166.0", "0.166.0-alpha.6", "0.166.12", "0.167.0", "0.167.0-alpha.3.2", "0.167.2-beta.1"]) assert.deepEqual(decide([meta(version), ...record.slice(1)]), ON, version);
  for (const version of ["0.163.9", "0.168.0", "0.168.0-alpha.1", "0.170.0", "1.0.0", "1.164.0", "1.167.0", "0.164", "0.164.0.1", "0.164.01", "v0.164.0", " 0.164.0", "0.164.0-alpha",
    "0.167.0-alpha.", "0.167.0-alpha..3", "0.167.0-alpha.3.", "0.167.0-alpha.03", "0.167.0-3.2", "0.164.0+build", "0.164.0-alpha.6\n", undefined, 164]) {
    assert.deepEqual(decide([meta(version), ...record.slice(1)]), VERSION(version), String(version));
  }
  assertPlain(VERSION("0.170.0").refused);
  assert.ok(decide([meta("0.170.0"), ...record.slice(1), META]).refused, "every session_meta line is checked");
});

test("a partial last line is re-read up to 3 times, then refuses", () => {
  const lines = withMode(RECORDS["exec-on"]).map((o) => JSON.stringify(o));
  const file = recordFile(lines.slice(0, -1), `\n${lines.at(-1).slice(0, 20)}`);
  const pauses = [];
  const writing = { refused: "Codex is still writing its record of this session. Ask for the merge again in a moment (the last line is incomplete)" };
  assertPlain(writing.refused);
  assert.deepEqual(readRecord(file, { pause: (ms) => pauses.push(ms) }), writing);
  assert.deepEqual(pauses, [50, 50, 50]);
  // Codex finishes the line during the second pause: the next read sees the whole record.
  let pause = 0;
  const record = readRecord(file, { pause: () => { if (++pause === 2) appendFileSync(file, `${lines.at(-1).slice(20)}\n`); } });
  assert.equal(pause, 2);
  assert.equal(record.lines, lines.length);
  assert.deepEqual(sw(record,{ lines: 0 }), ON);
});

test("a record over 64 MiB refuses before it is read", () => {
  const file = recordFile(RECORDS["exec-on"]);
  truncateSync(file, RECORD_LIMIT + 1); // a sparse file: no 64 MiB write
  const long = { refused: "Codex's record of this session is too long for sage to read. Start a new session for autopilot, or the owner merges the pull request in GitHub (over 64 MiB)" };
  assertPlain(long.refused);
  assert.deepEqual(readRecord(file), long);
  truncateSync(file, RECORD_LIMIT);
  assert.match(readRecord(file).refused, /\(the last line is incomplete\)$/, "at the limit it reads (and finds no newline at the end)");
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
/** The record of the session's root thread: a proof record whose session_meta names the session, with sage mode and an on. */
const ROOT_RECORD = withMode([{ ...META, payload: { ...META.payload, id: SESSION } }, ...RECORDS["exec-on"].slice(1)]);
/** A scratch home for the hooks, with the root thread's record, named as Codex names it: rollout-<time>-<thread id>.jsonl. */
function hookHome() {
  const home = realpathSync(mkdtempSync(join(SCRATCH, "home-")));
  const env = { PATH: process.env.PATH, HOME: home, CODEX_HOME: join(home, "codex"), SAGE_HOME: join(home, "sage"), SAGE_SHARED_HOME: process.env.SAGE_SHARED_HOME };
  const transcript = join(home, `rollout-2026-11-07T09-00-00-${SESSION}.jsonl`);
  writeFileSync(transcript, ROOT_RECORD.map((line) => JSON.stringify(line)).join("\n") + "\n");
  return { env, transcript, dir: modeDirectory(env) };
}
/**
 * The limit line when the hook cannot count the record (F-T663-12), and when it cannot write a folder (F-T663-13,
 * F-T663-16). F-T663-26: now that autopilot can be on, the line says that merges wait in this session, and both steps.
 */
const RECORD_LINE = (detail) => `sage: the sage hook could not read Codex's record of this session, so autopilot merges nothing in this session for now. Start or resume the session again${detail ? ` (${detail})` : ""}, then send "autopilot on" again.`;
const FOLDER_LINE = (folder, code) => `sage: the sage hook could not save its note of this session start, so autopilot merges nothing in this session for now. Check that sage can write to the folder ${folder} (${code}), then start or resume the session again, then send "autopilot on" again.`;
const limits = (output) => (output?.systemMessage ?? "").split("\n").filter((line) => /note of this session start|record of this session/.test(line));
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
    assert.deepEqual(limits(output), [], source);
    // pid: the hook's parent, which is Codex when Codex runs the hook (here, this test process).
    assert.deepEqual(markOf(h), { session: SESSION, source, lines: ROOT_RECORD.length, pid: process.pid }, source);
  }
});

test("a later start replaces the mark; compact saves none and keeps the earlier one; a child's start saves none", () => {
  const h = hookHome();
  start(h, HOOK_OF.compact, "compact");
  assert.equal(markOf(h), undefined, "compact alone saves none");
  start(h, HOOK_OF.startup, "startup");
  appendFileSync(h.transcript, `${JSON.stringify(RECORDS["exec-on"][2])}\n`);
  start(h, HOOK_OF.compact, "compact");
  assert.deepEqual(markOf(h), { session: SESSION, source: "startup", lines: ROOT_RECORD.length, pid: process.pid });
  start(h, HOOK_OF.resume, "resume");
  assert.deepEqual(markOf(h), { session: SESSION, source: "resume", lines: ROOT_RECORD.length + 1, pid: process.pid });
  const child = hookHome();
  start(child, HOOK_OF.startup, "startup", { agent_id: "agent-1" });
  start(child, HOOK_OF.fork, "fork", { agent_id: "agent-1" });
  assert.equal(markOf(child), undefined);
});

test("a start whose record is another thread's saves no mark and keeps the root thread's mark (F-T663-10)", () => {
  // Codex's review and guardian threads send hook events with the root session id and no agent_id; their own record
  // tells them apart, as the gate's threadOf reads it: another thread id, or a source that names a subagent or an
  // internal thread. Proof case 5c: if such a start moved the mark to its own short record, an on from before the
  // resume would count again.
  const other = "019a0000-0000-7000-8000-0000000c41d0";
  const threads = {
    "a review thread": { id: other, source: { subagent: "review" } },
    "a thread with the session's id and a subagent source": { id: SESSION, source: { subagent: { other: "guardian" } } },
    "an internal thread": { id: SESSION, source: { internal: "guardian" } },
    "a record of another thread id": { id: other, source: "cli" },
  };
  for (const [name, fields] of Object.entries(threads)) {
    for (const source of ["startup", "resume", "clear", "fork"]) {
      const h = hookHome();
      start(h, HOOK_OF.resume, "resume");
      const root = markOf(h);
      assert.equal(root.lines, ROOT_RECORD.length);
      const childRecord = recordFile([{ ...META, payload: { ...META.payload, ...fields } }]);
      const output = start(h, HOOK_OF[source], source, { transcript_path: childRecord });
      assert.deepEqual(markOf(h), root, `${name}, ${source}: the root thread's mark stays`);
      assert.deepEqual(limits(output), [], `${name}, ${source}: no limit line`);
      // The reader with the kept mark: the on of the earlier start does not count. With the child's line count it would.
      const record = readRecord(h.transcript);
      assert.deepEqual(sw(record,markOf(h)), NONE, `${name}, ${source}`);
      assert.deepEqual(sw(record,{ lines: 1 }), ON, "a mark at the child's line count lets the earlier on count");
    }
  }
});

test("a start of the root thread's new record before Codex writes it marks line 0; a partial last line counts", () => {
  // Startup, clear and fork start a new record (a new thread id), which can be empty when the hook runs. The reader
  // starts at its session_meta anyway, so line 0 lets no earlier on count. The record's file name holds the session id.
  for (const source of ["startup", "clear", "fork"]) {
    const h = hookHome();
    rmSync(h.transcript);
    assert.deepEqual(limits(start(h, HOOK_OF[source], source)), [], source);
    assert.equal(markOf(h).lines, 0, source);
    writeFileSync(h.transcript, `${JSON.stringify(ROOT_RECORD[0])}\n{"type":"event_m`);
    start(h, HOOK_OF[source], source);
    assert.equal(markOf(h).lines, 2, `${source}: a partial last line counts as a line`);
  }
});

test("F-T663-19, F-T663-25: another thread's start before its record exists, or with no record, changes no mark, also after a resume", () => {
  // The attack of F-T663-25 (R2682): the owner turns autopilot on, then resumes, so the mark is at the resume. Starts of
  // another thread whose record Codex has not written (its file name holds its own thread id), or with no record path,
  // then come. If one saved line 0, the on from before the resume would count again; if one removed the mark, each
  // Codex review would turn autopilot off (F-T663-19). Now the root thread's mark stays, and the earlier on stays out.
  for (const source of ["startup", "clear", "fork"]) {
    for (const [name, path] of [["a record not written yet", join(SCRATCH, "rollout-2026-11-07T09-00-01-019a0000-0000-7000-8000-0000000c41d0.jsonl")], ["no record path", undefined], ["an empty path", ""]]) {
      const h = hookHome();
      start(h, HOOK_OF.resume, "resume");
      const root = markOf(h);
      assert.equal(root.lines, ROOT_RECORD.length);
      for (let i = 0; i < 2; i++) {
        assert.deepEqual(limits(start(h, HOOK_OF[source], source, { transcript_path: path })), [], `${source}, ${name}: no limit line`);
        assert.deepEqual(markOf(h), root, `${source}, ${name}: the root thread's mark stays (start ${i + 1})`);
      }
      assert.deepEqual(sw(readRecord(h.transcript), markOf(h)), NONE, `${source}, ${name}: the on from before the resume does not count`);
    }
  }
  // And after a resume whose record could not be read: no mark, and another thread's start saves none (R2682 variant 2).
  const h = hookHome();
  start(h, HOOK_OF.resume, "resume");
  chmodSync(h.transcript, 0o000);
  try { assert.deepEqual(limits(start(h, HOOK_OF.resume, "resume")), [RECORD_LINE("EACCES")]); } finally { chmodSync(h.transcript, 0o600); }
  assert.equal(markOf(h), undefined);
  start(h, HOOK_OF.startup, "startup", { transcript_path: join(SCRATCH, "rollout-2026-11-07T09-00-02-019a0000-0000-7000-8000-0000000c41d1.jsonl") });
  start(h, HOOK_OF.clear, "clear", { transcript_path: undefined });
  assert.equal(markOf(h), undefined, "no mark: the reader refuses until the session starts again");
});

test("a resume whose record cannot be counted saves no mark, removes the earlier one, and gives a limit line (F-T663-12)", () => {
  // A resume continues a record that holds the earlier starts: line 0 would let an on from before the resume count.
  for (const [name, path, code] of [["a record that is not found", join(SCRATCH, "missing.jsonl"), "ENOENT"], ["no record path", undefined], ["an empty path", ""]]) {
    const h = hookHome();
    start(h, HOOK_OF.startup, "startup");
    assert.ok(markOf(h), name);
    const output = start(h, HOOK_OF.resume, "resume", { transcript_path: path });
    assert.deepEqual(limits(output), [RECORD_LINE(code)], name);
    assert.equal(output.hookSpecificOutput.hookEventName, "SessionStart", `${name}: the event's own answer stays`);
    assert.equal(markOf(h), undefined, `${name}: no mark, so the reader refuses`);
    const fresh = hookHome();
    assert.deepEqual(limits(start(fresh, HOOK_OF.resume, "resume", { transcript_path: path })), [RECORD_LINE(code)], `${name}, no earlier mark`);
    assert.equal(markOf(fresh), undefined, name);
  }
});

test("a failed mark save gives the user a plain limit line with its next step, never blocks, and removes the earlier mark", () => {
  for (const sentence of [...RECORD_LINE("EACCES").split(/(?<=\.) /), ...FOLDER_LINE("X", "EACCES").split(/(?<=\.) /)]) assert.ok(sentence.split(" ").length <= 25, sentence);
  for (const source of ["resume", "fork"]) {
    const h = hookHome();
    start(h, HOOK_OF[source], source);
    assert.ok(markOf(h), source);
    chmodSync(h.transcript, 0o000); // the record cannot be read, so the hook cannot count its lines
    try {
      const output = start(h, HOOK_OF[source], source);
      assert.deepEqual(limits(output), [RECORD_LINE("EACCES")], source);
      assert.equal(output.hookSpecificOutput.hookEventName, "SessionStart", "the event's own answer stays");
      assert.equal(markOf(h), undefined, `${source}: no stale mark stays`);
    } finally { chmodSync(h.transcript, 0o600); }
    // F-T663-16: the line names the folder that cannot change, here the marks folder.
    chmodSync(join(h.dir, "marks"), 0o500);
    try {
      assert.deepEqual(limits(start(h, HOOK_OF[source], source)), [FOLDER_LINE(join(h.dir, "marks"), "EACCES")], source);
    } finally { chmodSync(join(h.dir, "marks"), 0o700); }
    // And here the mode folder, which sage cannot make.
    const blocked = hookHome();
    mkdirSync(blocked.env.SAGE_HOME);
    mkdirSync(dirname(blocked.dir), { mode: 0o500 });
    try {
      assert.ok(limits(start(blocked, HOOK_OF[source], source)).includes(FOLDER_LINE(blocked.dir, "EACCES")), source);
      assert.equal(markOf(blocked), undefined);
    } finally { chmodSync(dirname(blocked.dir), 0o700); }
  }
});

test("F-T663-20: when the mode folder cannot change and has no marks folder, the line names the mode folder, which is there", () => {
  for (const source of ["startup", "fork"]) {
    const h = hookHome();
    mkdirSync(h.dir, { recursive: true, mode: 0o700 });
    chmodSync(h.dir, 0o500);
    try {
      assert.deepEqual(limits(start(h, HOOK_OF[source], source)).filter((line) => line.includes("note of this session start")), [FOLDER_LINE(h.dir, "EACCES")], source);
    } finally { chmodSync(h.dir, 0o700); }
    assert.equal(existsSync(join(h.dir, "marks")), false);
  }
});
