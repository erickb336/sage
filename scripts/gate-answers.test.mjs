import "./test-env.mjs";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as claude from "../plugins/sage/skills/sage/sage.mjs";
import { tool as codex } from "../plugins/sage-codex/skills/sage/sage.mjs";
import { readBoardSources } from "../plugins/sage/core/board-reader.mjs";

const at = (path) => fileURLToPath(new URL(path, import.meta.url));
const CLAUDE_HOOK = at("../plugins/sage/hooks/sage-hook.mjs"), WAIT = at("../plugins/sage/hooks/wait.mjs");
const TOOLS = { claude: at("../plugins/sage/skills/sage/sage.mjs"), codex: at("../plugins/sage-codex/skills/sage/sage.mjs") };
const DISPATCH = pathToFileURL(at("../plugins/sage-codex/hooks/dispatch.mjs")).href;
const BRIEF_HOOK = pathToFileURL(at("../plugins/sage-codex/hooks/brief-hook.mjs")).href, REPORT_GATE = pathToFileURL(at("../plugins/sage-codex/hooks/report-gate.mjs")).href;
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
const ADD = ["--size", "small", "--priority", "P2"];
const STAMP = "\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\dZ";
const REPORT = "STATUS done\nRESULT PASS\nEVIDENCE e\nFINDINGS none\nQUESTIONS none\nNOT VERIFIED n\nBRANCH b";
const brief = (run, task) => `Run ${run} · task ${task} (build)\nGOAL: a\nSCOPE: b\nCONTEXT: c\nDECISIONS: d\nACCEPTANCE: e\nVERIFY: f\nBUDGET: 1 hour of agent time\nFORBIDDEN: g\nREPORT: h\nSTANDING: i`;

function scratch(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "sage-gate-answers-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const fakes = join(base, "fakes");
  mkdirSync(fakes);
  for (const name of ["gh", "ps", "kill"]) {
    writeFileSync(join(fakes, name), `#!/bin/sh\necho fake-${name} >&2\nexit 1\n`);
    chmodSync(join(fakes, name), 0o755);
  }
  const env = { PATH: `${fakes}:/usr/bin:/bin`, HOME: join(base, "home"), CLAUDE_CONFIG_DIR: join(base, "claude"), CODEX_HOME: join(base, "codex"), SAGE_SHARED_HOME: join(base, "shared"),
    SAGE_HOOKS_STATE: join(base, "hook-state"), SAGE_WORKTREES: join(base, "worktrees"), SAGE_TEST_PIDS: "{}", SAGE_TEST_MACHINE_ID: "test-machine", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const project = join(base, "project");
  mkdirSync(project);
  execFileSync("git", ["init", "-q", "-b", "main", project]);
  execFileSync("git", ["-C", project, "commit", "-q", "--allow-empty", "-m", "first"], { env: gitEnv });
  return { base, env, project };
}

function claudeEvent(w, event) {
  const r = spawnSync(process.execPath, [CLAUDE_HOOK], { input: JSON.stringify({ session_id: "claude-1", cwd: w.project, ...event }), env: w.env, encoding: "utf8", timeout: 60_000 });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout ? JSON.parse(r.stdout) : undefined;
}
let turns = 0;
function codexInput(w, event) {
  const transcript = join(w.base, "rollout.jsonl");
  if (!existsSync(transcript)) writeFileSync(transcript, `${JSON.stringify({ type: "session_meta", payload: { id: "codex-1", session_id: "codex-1", cli_version: "0.164.0", source: "cli" } })}\n`);
  return JSON.stringify({ session_id: "codex-1", transcript_path: transcript, cwd: w.project, model: "fixture", permission_mode: "default", ...event });
}
const RUNNER = `import { dispatch } from ${JSON.stringify(DISPATCH)}; import { readFileSync } from "node:fs"; const input = JSON.parse(readFileSync(0, "utf8")); const out = await dispatch(input.hook_event_name, input, {}); process.stdout.write(JSON.stringify(out ?? null));`;
function codexEvent(w, event) {
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", RUNNER], { input: codexInput(w, event), env: w.env, encoding: "utf8", timeout: 60_000 });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}
const HOOKS = {
  claude: { say: (w, prompt) => claudeEvent(w, { hook_event_name: "UserPromptSubmit", prompt }), step: (w) => claudeEvent(w, { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "ls" }, tool_response: {} }) },
  codex: { say: (w, prompt) => codexEvent(w, { hook_event_name: "UserPromptSubmit", turn_id: `turn-${++turns}`, prompt }), step: (w) => codexEvent(w, { hook_event_name: "PostToolUse", tool_name: "read_file", tool_input: {}, tool_response: {} }) },
};
const contextOf = (out) => out?.hookSpecificOutput?.additionalContext ?? "";

function shared(t) {
  const w = scratch(t);
  claude.sage(["link", "--separate", "--project", w.project], w.env);
  HOOKS.claude.say(w, "sage mode");
  HOOKS.codex.say(w, "sage mode");
  const dir = claude.storeDir(w.project, w.env), chiefs = { claude: claude.chiefFor(w.project, "claude-1", w.env), codex: codex.chiefFor(w.project, "codex-1", w.env) };
  const tools = { claude, codex };
  const as = (provider, ...args) => tools[provider].sage([...args, "--project", w.project, "--chief", chiefs[provider]], w.env);
  const owner = (provider, ...args) => tools[provider].sage([...args, "--project", w.project], w.env);
  const refused = (provider, ...args) => {
    try { owner(provider, ...args); } catch (error) { return error.message; }
    assert.fail(`no refusal: ${args.join(" ")}`);
  };
  const gate = (id) => { const g = claude.read(dir, "gates").find((x) => x.id === id); return { ...g, answered: g.answered ? JSON.parse(g.answered) : "", picked: g.picked ? JSON.parse(g.picked) : "" }; };
  const task = (id) => claude.read(dir, "tasks").find((x) => x.id === id);
  const decisions = () => claude.read(dir, "decisions").map((d) => d.decision);
  return { ...w, dir, chiefs, as, owner, refused, gate, task, decisions };
}
const other = (provider) => (provider === "claude" ? "codex" : "claude");

test("both chiefs are registered at sage mode on: C1 in Claude and C2 in Codex", (t) => {
  const w = shared(t);
  assert.deepEqual(w.chiefs, { claude: "C1", codex: "C2" });
});

test("first answer wins: a second answer to a plain or a takeover gate is refused, and names the first answer, its place and its time; a breakdown gate keeps its own rule", (t) => {
  const w = shared(t);
  w.as("claude", "task", "add", "--title", "a", ...ADD);
  w.as("claude", "gate", "add", "T1", "--question", "Which name?", "--options", "short|long", "--recommend", "short");
  assert.equal(w.owner("codex", "gate", "answer", "G1", "--option", "2", "--via", "codex-card"), "G1 answered · long");
  const { answered, picked } = w.gate("G1");
  assert.deepEqual([answered.via, picked.chief], ["codex-card", ""], "an answer from a terminal with no chief names no chief");
  const before = readFileSync(join(w.dir, "gates.tsv"), "utf8");
  for (const [provider, via] of [["claude", "claude-card"], ["codex", "chat"], ["claude", "board"]]) {
    assert.equal(w.refused(provider, "gate", "answer", "G1", "--option", "1", "--via", via), `G1 has the answer "long" already, from a Codex card at ${answered.at}: the first answer wins, so this answer is not recorded. Nothing changed.`);
  }
  assert.equal(readFileSync(join(w.dir, "gates.tsv"), "utf8"), before, "a refused answer writes nothing");

  w.as("claude", "gate", "replace", "T1", "--to", "C2");
  w.owner("claude", "gate", "answer", "G2", "--option", "2", "--via", "claude-card");
  assert.match(w.refused("codex", "gate", "answer", "G2", "--option", "1"), new RegExp(`^G2 has the answer "decline" already, from a Claude card at ${STAMP}: the first answer wins, so this answer is not recorded\\. To change the chief, open a new takeover gate\\. Nothing changed\\.$`));
  assert.equal(w.task("T1").chief, "C1");

  w.as("claude", "task", "add", "--title", "b", ...ADD);
  w.as("claude", "milestone", "propose", "--name", "M", "--goal", "g", "--pilot", "T1", "--tasks", "T2");
  w.owner("claude", "gate", "answer", "G3", "--option", "3");
  const drop = w.gate("G3").answered;
  assert.equal(drop.via, "chat");
  const again = w.refused("codex", "gate", "answer", "G3", "--option", "1", "--via", "codex-card");
  assert.ok(again.startsWith(`G3 has the answer "drop" already, from the chat at ${drop.at}: the first answer wins, so this answer is not recorded.`), again);
  assert.match(again, / G3 is a breakdown gate, and a breakdown gate answers once: for a change of mind, the chief proposes the milestone again \(sage milestone propose <M>\)/);
  assert.equal(w.gate("G3").answer, "drop");
  assert.equal(w.refused("claude", "gate", "answer", "G1", "--option", "1", "--via", "phone"), `--via is the place of the owner's answer: board, claude-card, codex-card, chat. Nothing changed.`);
});

for (const owning of ["claude", "codex"]) {
  test(`a board answer only records; the ${owning} chief's hook applies it at its next step and records the pickup, and the other chief's hook leaves it`, (t) => {
    const w = shared(t);
    const me = w.chiefs[owning];
    w.as(owning, "task", "add", "--title", "a", ...ADD);
    w.as(owning, "gate", "add", "T1", "--question", "Ship it?", "--options", "yes|no", "--recommend", "yes");
    const said = w.owner(other(owning), "gate", "answer", "G1", "--option", "2", "--via", "board");
    assert.match(said, new RegExp(`^G1 recorded · no · from the board, at ${STAMP}\\. It acts when ${me} \\(${owning}\\) picks it up at its next ${owning === "codex" ? "turn: a message in its chat, or its next tool call" : "step"}; until then, sage gate undo G1 takes it back\\.$`));
    let g = w.gate("G1");
    assert.equal(g.answer, "", "the answer does not act before the pickup");
    assert.deepEqual([g.answered.via, g.answered.answer, g.picked], ["board", "no", ""]);
    assert.match(w.owner("claude", "status"), /gates {3}0 open · 1 answered on the board, not picked up yet · G1 .*\(board answer: no\)/, "F-T1059-9: a pending board answer is not an open question");
    assert.ok(!w.decisions().some((d) => d.endsWith("→ no")), "no decision before the pickup");

    assert.equal(contextOf(HOOKS[other(owning)].step(w)), "", "the other chief does not pick up a gate that is not its own");
    assert.equal(w.gate("G1").answer, "");

    const note = contextOf(HOOKS[owning].step(w));
    assert.match(note, new RegExp(`^sage: the owner answered on the board, and this hook applied that answer for you.*\\n- G1 \\(T1\\): the owner answered "no" on the board at ${g.answered.at}\\. Picked up at ${STAMP}, so it has no undo now: G1 answered · no$`, "s"));
    g = w.gate("G1");
    assert.equal(g.answer, "no");
    assert.deepEqual([g.answered.via, g.answered.at, "answer" in g.answered, g.picked.chief], ["board", w.gate("G1").answered.at, false, me]);
    assert.ok(w.decisions().includes("Ship it? → no"));
    assert.equal(contextOf(HOOKS[owning].step(w)), "", "a pickup happens once");
    assert.match(w.refused(other(owning), "gate", "undo", "G1"), new RegExp(`^G1 has the board answer "no", and ${me} picked it up at ${STAMP}, so it acted already: an undo works only before the pickup\\. Nothing changed\\.$`));
  });
}

test("a board answer and a card answer race under the logbook lock, from both providers: the first one wins, and the other names it", async (t) => {
  const w = shared(t);
  w.as("claude", "task", "add", "--title", "a", ...ADD);
  const gates = 8;
  for (let i = 0; i < gates; i++) w.as("claude", "gate", "add", "T1", "--question", `Q${i}?`, "--options", "a|b", "--recommend", "a");
  const answer = (provider, gate, option, via) => new Promise((done) => {
    const child = spawn(process.execPath, [TOOLS[provider], "gate", "answer", gate, "--option", option, "--via", via, "--project", w.project], { env: w.env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => done({ code, out: out.trim(), via }));
  });
  for (let i = 0; i < gates; i++) {
    const card = i % 2 ? ["codex", "codex-card"] : ["claude", "claude-card"], id = `G${i + 1}`;
    const results = await Promise.all([answer("claude", id, "1", "board"), answer(card[0], id, "2", card[1])]);
    const won = results.filter((r) => r.code === 0), lost = results.filter((r) => r.code !== 0);
    assert.equal(won.length, 1, `${id}: exactly one answer wins: ${JSON.stringify(results)}`);
    const g = w.gate(id), place = { board: "the board", "claude-card": "a Claude card", "codex-card": "a Codex card" }[won[0].via];
    assert.equal(g.answered.via, won[0].via);
    assert.match(lost[0].out, new RegExp(`^sage: ${id} has the answer "${won[0].via === "board" ? "a" : "b"}" already, from ${place} at ${STAMP}: the first answer wins`), `${id}: the loser names the winner`);
  }
});

test("Undo works only before the pickup: it clears a board answer so that a card answer can land, and it is refused for a card answer", (t) => {
  const w = shared(t);
  w.as("claude", "task", "add", "--title", "a", ...ADD);
  w.as("claude", "gate", "add", "T1", "--question", "Ship it?", "--options", "yes|no", "--recommend", "yes");
  assert.equal(w.refused("codex", "gate", "undo", "G1"), "G1 has no answer, so there is nothing to undo. Nothing changed.");
  w.owner("codex", "gate", "answer", "G1", "--option", "2", "--via", "board");
  assert.match(w.refused("claude", "gate", "answer", "G1", "--option", "1", "--via", "claude-card"), /^G1 has the answer "no" already, from the board at .*No chief has picked it up yet, so the owner can take it back first: sage gate undo G1\. Nothing changed\.$/);
  assert.equal(w.owner("codex", "gate", "undo", "G1"), `G1 undone · the board answer "no" is gone, and G1 is open again.`);
  assert.deepEqual([w.gate("G1").answer, w.gate("G1").answered], ["", ""]);
  assert.ok(w.decisions().includes("G1 board answer undone: no"));
  assert.equal(contextOf(HOOKS.claude.step(w)), "", "nothing to pick up after the undo");
  assert.equal(w.as("codex", "gate", "answer", "G1", "--option", "1", "--via", "codex-card"), "G1 answered · yes");
  assert.deepEqual([w.gate("G1").picked.chief, w.gate("G1").answered.via], ["C2", "codex-card"], "a card answer counts as picked at once, by the chief that recorded and applied it, not by the owning chief C1");
  assert.match(w.refused("codex", "gate", "undo", "G1"), /^G1 has the answer "yes" from a Codex card at \S+\. An answer acts at once unless it comes from the board, so only a board answer that no chief picked up yet has an undo\. Nothing changed\.$/);
});

test("Undo and the pickup race under the same lock: for each gate exactly one of them wins", async (t) => {
  const w = shared(t);
  w.as("claude", "task", "add", "--title", "a", ...ADD);
  const gates = 6;
  for (let i = 1; i <= gates; i++) w.as("claude", "gate", "add", "T1", "--question", `Q${i}?`, "--options", "a|b", "--recommend", "a");
  const run = (args, input) => new Promise((done) => {
    const child = spawn(process.execPath, args, { env: w.env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => done({ code, out }));
    child.stdin.end(input ?? "");
  });
  for (let i = 1; i <= gates; i++) {
    const id = `G${i}`;
    w.owner("codex", "gate", "answer", id, "--option", "2", "--via", "board");
    const [undo, hook] = await Promise.all([
      run([TOOLS.codex, "gate", "undo", id, "--project", w.project]),
      run([CLAUDE_HOOK], JSON.stringify({ session_id: "claude-1", cwd: w.project, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "ls" }, tool_response: {} })),
    ]);
    const g = w.gate(id), picked = new RegExp(`- ${id} \\(T1\\): the owner answered "b"`).test(contextOf(JSON.parse(hook.out || "null")));
    if (undo.code === 0) {
      assert.match(undo.out, new RegExp(`^${id} undone`));
      assert.equal(picked, false, `${id}: an undone answer is never applied`);
      assert.deepEqual([g.answer, g.answered], ["", ""]);
    } else {
      assert.match(undo.out, new RegExp(`${id} has the board answer "b", and C1 picked it up at`), `${id}: the late undo names the pickup`);
      assert.equal(picked, true);
      assert.deepEqual([g.answer, g.picked.chief], ["b", "C1"]);
    }
  }
});

for (const [from, to] of [["claude", "codex"], ["codex", "claude"]]) {
  test(`gate give hands a ${from} task to the ${to} chief through the one-recipient takeover gate, and the receiving chief applies a board approve`, (t) => {
    const w = shared(t);
    w.as(from, "task", "add", "--title", "a", ...ADD);
    const receiver = w.chiefs[to];
    const opened = w.owner(from, "gate", "give", "T1", "--to", receiver);
    assert.match(opened, new RegExp(`^G1 open · Hand T1 from ${w.chiefs[from]} \\(${from}\\) to ${receiver} \\(${to}\\)\\? Runs that end as failed: none\\.`));
    assert.match(w.owner(to, "gate", "give", "T1", "--to", receiver), /^G1 is open already · /, "the same open gate, not a second one");
    assert.deepEqual([w.gate("G1").kind, w.gate("G1").chief], ["replace", receiver]);
    assert.match(w.owner(to, "gate", "answer", "G1", "--option", "1", "--via", "board"), new RegExp(`It acts when ${receiver} \\(${to}\\) picks it up`));
    assert.equal(contextOf(HOOKS[from].step(w)), "", "the giving chief does not apply it");
    assert.equal(w.task("T1").chief, w.chiefs[from]);
    assert.match(contextOf(HOOKS[to].step(w)), new RegExp(`- G1 \\(T1\\): the owner answered "approve" on the board at ${STAMP}\\. Picked up at ${STAMP}, so it has no undo now: G1 answered · approve · T1 chief ${receiver}`));
    assert.equal(w.task("T1").chief, receiver);
    assert.equal(w.gate("G1").picked.chief, receiver);
    assert.ok(w.decisions().some((d) => d.startsWith("Hand T1 from") && d.endsWith("→ approve")));
  });
}

for (const provider of ["claude", "codex"]) {
  test(`F-T1059-47: in ${provider}, gate give refuses a second takeover question for a task while one is open to another chief`, (t) => {
    const w = shared(t);
    w.as("claude", "task", "add", "--title", "a", ...ADD);
    writeFileSync(join(w.dir, "chiefs.tsv"), `${readFileSync(join(w.dir, "chiefs.tsv"), "utf8")}C3\tclaude\tclaude-3\t2026-01-01T00:00:00Z\n`);
    assert.match(w.owner(provider, "gate", "give", "T1", "--to", "C2"), /^G1 open · /);
    const before = readFileSync(join(w.dir, "gates.tsv"), "utf8");
    assert.equal(w.refused(provider, "gate", "give", "T1", "--to", "C3"), "G1 is open already: it asks to hand T1 to C2 (codex). A task has one open takeover question at a time: answer G1 first (or undo your board answer to it), then give T1 again. Nothing changed.");
    assert.equal(readFileSync(join(w.dir, "gates.tsv"), "utf8"), before, "no second takeover question");
    w.owner(provider, "gate", "answer", "G1", "--option", "2", "--via", "chat");
    assert.match(w.owner(provider, "gate", "give", "T1", "--to", "C3"), /^G2 open · Hand T1 from C1 \(claude\) to C3 \(claude\)\?/);
  });
}

test("a board answer that cannot act at the pickup is cleared, the gate opens again, and the chief hears why", (t) => {
  const w = shared(t);
  w.as("claude", "task", "add", "--title", "a", ...ADD);
  w.owner("claude", "gate", "give", "T1", "--to", "C2");
  w.owner("claude", "gate", "answer", "G1", "--option", "1", "--via", "board");
  w.as("claude", "run", "add", "T1", "--role", "qa");
  const note = contextOf(HOOKS.codex.step(w));
  assert.match(note, /- G1 \(T1\): the owner answered "approve" on the board at .*, and it cannot act: R1 started after G1 opened, so G1 does not name each run that ends as failed\. .* So sage cleared that answer, and G1 is open again: tell the owner why, and ask again\.$/);
  assert.deepEqual([w.gate("G1").answer, w.gate("G1").answered, w.task("T1").chief], ["", "", "C1"]);
  assert.equal(w.owner("codex", "gate", "answer", "G1", "--option", "2", "--via", "codex-card").split(" · ")[1], "decline");
});

test("gate add --message keeps the checked question message as gates/G<n>.json, and refuses another kind or a broken shape", (t) => {
  const w = shared(t);
  w.as("claude", "task", "add", "--title", "a", ...ADD);
  const file = join(w.base, "question.json");
  const message = { kind: "question", title: "Ship the new board?", blocks: [
    { t: "field", label: "Where this is", text: "The board is built." }, { t: "field", label: "What you approve", text: "The release of the board." },
    { t: "field", label: "The one real choice in it", text: "Now or later." },
    { t: "table", head: ["Answer", "What happens next", "Cost"], rows: [["now", "It ships today.", "none"], ["later", "It waits a week.", "none"]], pick: 0 },
    { t: "field", label: "If you do not answer", text: "It waits." }, { t: "field", label: "Needed by", text: "Friday." }, { t: "field", label: "After you answer", text: "I ship it." }] };
  writeFileSync(file, JSON.stringify(message));
  const out = w.as("claude", "gate", "add", "T1", "--question", "Ship the new board?", "--options", "now|later", "--recommend", "now", "--message", file);
  assert.equal(out, `G1 open · Ship the new board? · its message: ${join(w.dir, "gates", "G1.json")}`);
  const kept = JSON.parse(readFileSync(join(w.dir, "gates", "G1.json"), "utf8"));
  assert.deepEqual([kept.gate, kept.task, kept.message], ["G1", "T1", message]);
  assert.match(kept.text, /^QUESTION/);
  writeFileSync(file, JSON.stringify({ ...message, kind: "progress" }));
  assert.throws(() => w.as("claude", "gate", "add", "T1", "--question", "q?", "--options", "a|b", "--recommend", "a", "--message", file), /--message is the file of a question message .*not of "progress"\. Nothing written\./);
  writeFileSync(file, JSON.stringify({ ...message, blocks: message.blocks.slice(0, 2) }));
  assert.throws(() => w.as("claude", "gate", "add", "T1", "--question", "q?", "--options", "a|b", "--recommend", "a", "--message", file), /the message is not in its kind's shape, so the gate keeps no message in another shape\. Nothing written\./);
  assert.equal(claude.read(w.dir, "gates").length, 1, "a refused message opens no gate");
  assert.equal(existsSync(join(w.dir, "gates", "G2.json")), false);

  writeFileSync(file, JSON.stringify({ ...message, long: { title: "Ship the new board, in short", main: "the page holds the whole question." } }));
  assert.throws(() => w.as("claude", "gate", "add", "--question", "q?", "--options", "a|b", "--recommend", "a", "--message", file), /it needs a page, and a page lives in a task's pages folder: give the gate its task\. Nothing written\./);
  w.as("claude", "gate", "add", "T1", "--question", "Ship it now?", "--options", "now|later", "--recommend", "now", "--message", file);
  const { text } = JSON.parse(readFileSync(join(w.dir, "gates", "G2.json"), "utf8"));
  const named = text.split("\n").map((line) => line.trim()).filter((line) => line.startsWith("/") && line.endsWith(".html"));
  assert.equal(named.length, 1, text);
  assert.match(readFileSync(named[0], "utf8"), /^<!DOCTYPE html>/i, "the page that the kept text names exists");
});

test("the Claude Stop hook asks an idle chief with open gates to start the gates wait once; it is quiet while work runs, and it hands over a board answer", (t) => {
  const w = shared(t);
  const stop = (tasks, active = false) => claudeEvent(w, { hook_event_name: "Stop", stop_hook_active: active, last_assistant_message: "ok", background_tasks: tasks });
  w.as("claude", "task", "add", "--title", "a", ...ADD);
  assert.equal(stop([])?.decision, undefined, "no open gate: no wait");
  w.as("claude", "gate", "add", "T1", "--question", "Ship it?", "--options", "yes|no", "--recommend", "yes");
  assert.equal(stop([{ id: "a1", type: "subagent", status: "running" }])?.decision, undefined, "work runs, so it wakes the chief anyway");
  const told = stop([{ id: "a1", type: "subagent", status: "completed" }]);
  assert.equal(told.decision, "block");
  assert.ok(told.reason.startsWith("sage: G1 waits for the owner, and no agent or command of yours runs"));
  assert.ok(told.reason.includes(`${WAIT} --gates C1`) || told.reason.includes(`"${WAIT}" --gates C1`), told.reason);
  assert.equal(stop([])?.decision, undefined, "told once for the same open gates");
  w.as("claude", "gate", "add", "T1", "--question", "Name?", "--options", "a|b", "--recommend", "a");
  assert.equal(stop([], true)?.decision, undefined, "never blocks a stop that a block started");
  assert.match(stop([]).reason, /^sage: G1, G2 wait for the owner/);
  w.owner("codex", "gate", "answer", "G2", "--option", "2", "--via", "board");
  const handed = stop([], true);
  assert.equal(handed.decision, "block");
  assert.match(handed.reason, /- G2 \(T1\): the owner answered "b" on the board at .*: G2 answered · b$/);
  assert.equal(w.gate("G2").picked.chief, "C1");
});

test("wait.mjs --gates ends when a board answer comes, names it, and times out with the step to run it again", async (t) => {
  const w = shared(t);
  w.as("claude", "task", "add", "--title", "a", ...ADD);
  w.as("claude", "gate", "add", "T1", "--question", "Ship it?", "--options", "yes|no", "--recommend", "yes");
  const wait = (ms, ...args) => spawnSync(process.execPath, [WAIT, "--gates", ...args], { cwd: w.project, env: { ...w.env, SAGE_WAIT_MS: String(ms) }, encoding: "utf8", timeout: 60_000 });
  assert.equal(wait(300, "C1").stdout, "No answer yet to G1 after 0 minutes: run this command again, in the background.\n");
  assert.match(wait(300).stdout, /^usage: node wait\.mjs --gates \[C<n>\]/, "a shared logbook needs the chief id");
  assert.equal(wait(300, "C2").stdout, "No gate of yours waits for the owner, so there is nothing to wait for.\n");
  const child = spawn(process.execPath, [WAIT, "--gates", "C1"], { cwd: w.project, env: { ...w.env, SAGE_WAIT_MS: "30000" }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  const ended = new Promise((done) => child.on("close", done));
  await new Promise((done) => setTimeout(done, 500));
  w.owner("codex", "gate", "answer", "G1", "--option", "1", "--via", "board");
  await ended;
  assert.match(out, /^G1 \(T1\) has the owner's answer "yes" from the board, at .*\.\nRun .* status now, as a command of its own: this hook applies the answer then, and tells you what it did\.\n$/);
  assert.equal(w.gate("G1").answer, "", "the wait applies nothing: the hook does");
});

test("the hooks keep each run's brief and report as briefs/R<n>.md and reports/R<n>.md, in Claude and in Codex", async (t) => {
  const w = shared(t);
  w.as("claude", "task", "add", "--title", "a", ...ADD);
  w.as("claude", "task", "T1", "set", "state=briefed");
  w.as("claude", "task", "T1", "set", "state=building", "branch=sage/t1-a");
  w.as("claude", "run", "add", "T1", "--role", "implementer", "--branch", "sage/t1-a");
  const start = { subagent_type: "sage:implementer", description: "build", prompt: brief("R1", "T1"), run_in_background: true };
  const denied = claudeEvent(w, { hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: start, tool_use_id: "start-1" })?.hookSpecificOutput?.permissionDecision;
  assert.equal(denied, undefined);
  assert.equal(readFileSync(join(w.dir, "briefs", "R1.md"), "utf8"), brief("R1", "T1"), "Claude keeps the brief at the agent's start");
  claudeEvent(w, { hook_event_name: "PostToolUse", tool_name: "Agent", tool_use_id: "start-1", tool_response: { status: "async_launched", agentId: "agent-1" } });
  claudeEvent(w, { hook_event_name: "SubagentStart", agent_id: "agent-1", agent_type: "sage:implementer" });
  claudeEvent(w, { hook_event_name: "SubagentStop", agent_id: "agent-1", agent_type: "sage:implementer", last_assistant_message: REPORT, stop_hook_active: false });
  assert.equal(readFileSync(join(w.dir, "reports", "R1.md"), "utf8"), REPORT, "Claude keeps the report at the agent's end");

  w.as("codex", "task", "add", "--title", "b", ...ADD);
  w.as("codex", "run", "add", "T2", "--role", "qa");
  const name = "sage_qa_t2_r2", transcript = join(w.base, "child.jsonl");
  writeFileSync(transcript, `${JSON.stringify({ type: "session_meta", payload: { id: "child-thread", agent_path: `/root/${name}` } })}\n`);
  const run = (module, call, input) => {
    const code = `import * as m from ${JSON.stringify(module)}; import { readFileSync } from "node:fs"; process.stdout.write(JSON.stringify(m.${call}(JSON.parse(readFileSync(0, "utf8")))));`;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], { input: JSON.stringify(input), env: w.env, encoding: "utf8", timeout: 60_000 });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  const checked = `import { recordBrief } from ${JSON.stringify(BRIEF_HOOK)}; process.stdout.write(JSON.stringify(recordBrief(${JSON.stringify(w.project)}, ${JSON.stringify(name)}, ${JSON.stringify(brief("R2", "T2"))}, process.env, "codex-1")));`;
  assert.equal(spawnSync(process.execPath, ["--input-type=module", "-e", checked], { env: w.env, encoding: "utf8" }).stdout, "[]");
  run(BRIEF_HOOK, "briefHook", { hook_event_name: "SubagentStart", session_id: "codex-1", transcript_path: transcript, cwd: w.project });
  assert.equal(readFileSync(join(w.dir, "briefs", "R2.md"), "utf8"), brief("R2", "T2"), "Codex keeps the brief at the agent's start");
  run(REPORT_GATE, "reportGate", { hook_event_name: "SubagentStop", stop_hook_active: false, last_assistant_message: REPORT, agent_transcript_path: transcript, cwd: w.project });
  assert.equal(readFileSync(join(w.dir, "reports", "R2.md"), "utf8"), REPORT, "Codex keeps the report at the agent's end");
  const forged = `Run R1 · task T1 (build)\n${REPORT}`;
  run(REPORT_GATE, "reportGate", { hook_event_name: "SubagentStop", stop_hook_active: false, last_assistant_message: forged, agent_transcript_path: transcript, cwd: w.project });
  assert.equal(readFileSync(join(w.dir, "reports", "R1.md"), "utf8"), REPORT, "a Codex agent's text cannot name another run's report");
  assert.equal(readFileSync(join(w.dir, "reports", "R2.md"), "utf8"), forged, "the run comes from the agent's name");
});

test("old gates.tsv rows still read and answer once; a logbook with no chiefs gets no new column from a card answer; the board reads the new columns", (t) => {
  const w = scratch(t);
  const run = (...args) => claude.sage([...args, "--project", w.project], w.env);
  run("init");
  run("task", "add", "--title", "a", ...ADD);
  const dir = claude.storeDir(w.project, w.env);
  writeFileSync(join(dir, "gates.tsv"), "id\ttask\tquestion\toptions\trecommendation\tdefault\tanswer\tat\nG1\tT1\tOld?\tyes|no\tyes\t\tno\t2026-01-01T00:00:00Z\nG2\tT1\tOpen?\tyes|no\tyes\t\t\t2026-01-01T00:00:00Z\n");
  assert.match(run("status"), /gates {3}1 open · G2 Open\?/);
  assert.throws(() => run("gate", "answer", "G1", "--option", "1"), /^Error: G1 has the answer "no" already, from a place and at a time that sage did not record: the first answer wins/);
  run("gate", "answer", "G2", "--option", "1", "--via", "chat");
  const head = readFileSync(join(dir, "gates.tsv"), "utf8").split("\n")[0];
  assert.equal(head, "id\ttask\tquestion\toptions\trecommendation\tdefault\tanswer\tat\tanswered\tpicked", "the new columns are sparse: no chief column without a chief");
  run("gate", "add", "T1", "--question", "New?", "--options", "a|b", "--recommend", "a");
  assert.equal(claude.read(dir, "gates").at(-1).chief, undefined);
  const projects = readBoardSources([{ id: "claude", path: join(w.env.CLAUDE_CONFIG_DIR, "sage"), label: "claude" }]).flatMap((source) => source.projects);
  const gates = projects.find((p) => p.name === basename(dir))?.tables?.gates ?? [];
  assert.ok(gates.some((g) => g.id === "G2" && g.answer === "yes"), "the board's reader reads a gates.tsv with the new columns");
});

for (const [from, to] of [["claude", "codex"], ["codex", "claude"]]) {
  test(`after the owner hands a ${from} task to the ${to} chief, the ${to} chief owns the task's older gates: its hook picks up their board answers, and its gates wait and the Stop note list them`, (t) => {
    const w = shared(t);
    const giver = w.chiefs[from], taker = w.chiefs[to];
    const wait = (chief) => spawnSync(process.execPath, [WAIT, "--gates", chief], { cwd: w.project, env: { ...w.env, SAGE_WAIT_MS: "300" }, encoding: "utf8", timeout: 60_000 }).stdout;
    const NONE = "No gate of yours waits for the owner, so there is nothing to wait for.\n", WAITS = "No answer yet to G1 after 0 minutes: run this command again, in the background.\n";
    w.as(from, "task", "add", "--title", "a", ...ADD);
    w.as(from, "gate", "add", "T1", "--question", "Ship it?", "--options", "yes|no", "--recommend", "yes");
    assert.deepEqual([wait(giver), wait(taker)], [WAITS, NONE]);
    w.owner(from, "gate", "give", "T1", "--to", taker);
    w.owner(to, "gate", "answer", "G2", "--option", "1", "--via", `${to}-card`);
    assert.equal(w.task("T1").chief, taker);
    assert.deepEqual([wait(giver), wait(taker)], [NONE, WAITS], "G1 moved with T1");
    const told = claudeEvent(w, { hook_event_name: "Stop", stop_hook_active: false, last_assistant_message: "ok", background_tasks: [] });
    if (to === "claude") assert.match(told.reason, /^sage: G1 waits for the owner/);
    else assert.equal(told?.decision, undefined, "the Claude chief gave T1 away, so G1 is not its gate");
    assert.match(w.owner(from, "gate", "answer", "G1", "--option", "2", "--via", "board"), new RegExp(`It acts when ${taker} \\(${to}\\) picks it up`));
    assert.equal(contextOf(HOOKS[from].step(w)), "", "the giving chief does not pick it up");
    assert.equal(w.gate("G1").answer, "");
    assert.match(contextOf(HOOKS[to].step(w)), /- G1 \(T1\): the owner answered "no" on the board at .*: G1 answered · no$/);
    assert.deepEqual([w.gate("G1").answer, w.gate("G1").picked.chief], ["no", taker]);
  });
}

for (const [from, to] of [["claude", "codex"], ["codex", "claude"]]) {
  test(`after the owner hands a ${from} task to the ${to} chief and the ${to} chief unclaims it, the task's older gates stay with the ${to} chief, the one chief that may claim it back`, (t) => {
    const w = shared(t);
    const giver = w.chiefs[from], taker = w.chiefs[to];
    const wait = (chief) => spawnSync(process.execPath, [WAIT, "--gates", chief], { cwd: w.project, env: { ...w.env, SAGE_WAIT_MS: "300" }, encoding: "utf8", timeout: 60_000 }).stdout;
    const NONE = "No gate of yours waits for the owner, so there is nothing to wait for.\n", WAITS = "No answer yet to G1 after 0 minutes: run this command again, in the background.\n";
    w.as(from, "task", "add", "--title", "a", ...ADD);
    w.as(from, "gate", "add", "T1", "--question", "Ship it?", "--options", "yes|no", "--recommend", "yes");
    w.owner(from, "gate", "give", "T1", "--to", taker);
    w.owner(to, "gate", "answer", "G2", "--option", "1", "--via", `${to}-card`);
    assert.match(w.as(to, "unclaim", "T1"), new RegExp(`^T1 unclaimed · no owning chief\\. Only ${taker} claims it back`));
    assert.equal(w.task("T1").chief, "");
    assert.deepEqual([wait(giver), wait(taker)], [NONE, WAITS], "G1 stays with the chief that unclaimed T1");
    const told = claudeEvent(w, { hook_event_name: "Stop", stop_hook_active: false, last_assistant_message: "ok", background_tasks: [] });
    if (to === "claude") assert.match(told.reason, /^sage: G1 waits for the owner/);
    else assert.equal(told?.decision, undefined, "the Claude chief gave T1 away, so G1 is not its gate");
    assert.match(w.owner(from, "gate", "answer", "G1", "--option", "2", "--via", "board"), new RegExp(`It acts when ${taker} \\(${to}\\) picks it up`));
    assert.equal(contextOf(HOOKS[from].step(w)), "", "the giving chief does not pick it up");
    assert.equal(w.gate("G1").answer, "");
    assert.match(contextOf(HOOKS[to].step(w)), /- G1 \(T1\): the owner answered "no" on the board at .*: G1 answered · no$/);
    assert.deepEqual([w.gate("G1").answer, w.gate("G1").picked.chief], ["no", taker]);
  });
}

test("gate add refuses a task id that is not a task of the logbook, and writes no gate, page or folder for it; a gate with no task still opens", (t) => {
  const w = shared(t);
  w.as("claude", "task", "add", "--title", "a", ...ADD);
  const file = join(w.base, "question.json"), root = claude.pagesRoot(w.project, w.env);
  writeFileSync(file, JSON.stringify({ kind: "question", title: "Ship it?", long: { title: "Ship it, in short", main: "the page holds the whole question." }, blocks: [
    { t: "field", label: "Where this is", text: "a" }, { t: "field", label: "What you approve", text: "b" }, { t: "field", label: "The one real choice in it", text: "c" },
    { t: "table", head: ["Answer", "What happens next", "Cost"], rows: [["yes", "d", "none"], ["no", "e", "none"]], pick: 0 },
    { t: "field", label: "If you do not answer", text: "f" }, { t: "field", label: "Needed by", text: "g" }, { t: "field", label: "After you answer", text: "h" }] }));
  for (const id of ["T99", "../../../escape-a", "T1/../../escape-b", "t1"]) {
    for (const message of [[], ["--message", file]]) {
      assert.throws(() => w.as("claude", "gate", "add", id, "--question", "Ship it?", "--options", "yes|no", "--recommend", "yes", ...message), (e) => e.message.startsWith(`no task ${id}. The latest: T1.`), `${id} ${message.length ? "with" : "without"} a message`);
    }
    assert.equal(existsSync(join(root, id)), false, `no folder for ${id}`);
  }
  assert.deepEqual([claude.read(w.dir, "gates").length, existsSync(join(w.dir, "gates"))], [0, false], "a refused gate writes nothing");
  assert.equal(w.as("claude", "gate", "add", "--question", "Ship it?", "--options", "yes|no", "--recommend", "yes"), "G1 open · Ship it?");
  assert.equal(w.gate("G1").task, "");
});

test("the lint offer belongs to the chief that ran lint: its hook applies a board yes and owns the new task, and the other chief's hook leaves it", (t) => {
  const w = shared(t);
  writeFileSync(join(w.project, "a.js"), "export const a = 1;\n");
  execFileSync("git", ["-C", w.project, "add", "-A"], { env: gitEnv });
  execFileSync("git", ["-C", w.project, "commit", "-q", "-m", "code"], { env: gitEnv });
  const sha = execFileSync("git", ["-C", w.project, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  execFileSync("git", ["-C", w.project, "update-ref", "refs/remotes/origin/main", sha]);
  w.as("claude", "task", "add", "--title", "a", ...ADD);
  assert.match(w.as("claude", "lint", "T1", "--sha", sha), /\nG1 open · Add sage's no-comments lint rules to this project/);
  assert.match(w.owner("codex", "gate", "answer", "G1", "--option", "1", "--via", "board"), /It acts when C1 \(claude\) picks it up/);
  assert.equal(contextOf(HOOKS.codex.step(w)), "", "the Codex chief did not run lint, so it does not pick up the offer");
  assert.equal(w.task("T2"), undefined);
  assert.match(contextOf(HOOKS.claude.step(w)), /- G1: the owner answered "add the rules" on the board at .*G1 answered · add the rules/);
  assert.equal(w.task("T2").chief, "C1");
});

test("in a shared logbook, the Claude hook asks a chief to name itself on a gate answer, so that the gate records which chief applied it", (t) => {
  const w = shared(t);
  w.as("claude", "task", "add", "--title", "a", ...ADD);
  w.as("claude", "gate", "add", "T1", "--question", "Ship it?", "--options", "yes|no", "--recommend", "yes");
  const pre = (command) => claudeEvent(w, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } })?.hookSpecificOutput ?? {};
  const answer = `node ${TOOLS.claude} gate answer G1 --option 1 --via claude-card --project ${w.project}`;
  assert.equal(pre(answer).permissionDecision, "deny");
  assert.match(pre(answer).permissionDecisionReason, /add --chief C1 to this command/);
  assert.equal(pre(`${answer} --chief C1`).permissionDecision, undefined);
  assert.equal(pre(`node ${TOOLS.claude} gate undo G1 --project ${w.project}`).permissionDecision, undefined, "an undo is the owner's act and names no chief");
});
