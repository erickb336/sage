// T1009 (F-T997-1): a milestone's word and its release's word come from the words of its tasks' cards (taskWord, the one
// mapping of T1002), on the board model, the chat board and status alike. The T997 example: an active milestone whose
// pilot has an open gate (needs you) and whose other task waits for the pilot (waiting) is in progress, not "not started".
// One logbook, written by the state tool as the chief writes it, read by all three views. SAMPLE DATA only.
import "./test-env.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildBoardModel, readBoardSources, renderBoardText, taskWord } from "../packages/sage-core/index.mjs";

const TOOL = fileURLToPath(new URL("../plugins/sage/skills/sage/sage.mjs", import.meta.url));
const SPY = fileURLToPath(new URL("kill-spy.mjs", import.meta.url));

function logbook() {
  const home = mkdtempSync(join(tmpdir(), "sage-word-")), project = mkdtempSync(join(tmpdir(), "sage-word-project-"));
  // Each command preloads the kill spy and asks SAGE_TEST_PIDS about a lock's holder, so none reads or signals a real process.
  const env = { ...process.env, HOME: home, SAGE_HOME: home, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${JSON.stringify(SPY)}`.trim(), SAGE_TEST_KILLS: join(home, "kills"), SAGE_TEST_PIDS: "{}" };
  const ok = (...args) => {
    const r = spawnSync(process.execPath, [TOOL, ...args, "--project", project], { encoding: "utf8", env, timeout: 60_000 });
    assert.equal(r.status, 0, `sage ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const dir = ok("init").replace(/^\S+ /, "");
  return { home, dir, ok };
}
/** Sets a task's state cell by hand, as a real logbook can hold it: the state tool briefs no task whose waits are unmet. */
function setState(dir, id, state) {
  const [head, ...lines] = readFileSync(join(dir, "tasks.tsv"), "utf8").split("\n").filter(Boolean), at = head.split("\t").indexOf("state");
  writeFileSync(join(dir, "tasks.tsv"), [head, ...lines.map(line => { const v = line.split("\t"); if (v[0] === id) v[at] = state; return v.join("\t"); })].join("\n") + "\n");
}

test("T1009: the T997 example, a milestone whose tasks need you and wait, is in progress on the board model, the chat board and status", () => {
  const s = logbook();
  for (const n of [1, 2, 3]) s.ok("task", "add", "--title", `Sample task ${n}`, "--size", "small", "--priority", "P2");
  s.ok("milestone", "propose", "--name", "Sage feel", "--goal", "A sample goal", "--pilot", "T1", "--tasks", "T2");
  s.ok("gate", "answer", "G1", "--option", "1"); // approve: M1 is active, T1 and T2 are framed
  s.ok("gate", "add", "T1", "--question", "Sample: which layout?", "--options", "first|second", "--recommend", "first"); // T1 needs you
  s.ok("release", "add", "--name", "1.0");
  s.ok("milestone", "M1", "set", "release=1.0");
  s.ok("task", "T3", "set", "release=1.0"); // a single task that has not started

  const board = buildBoardModel(readBoardSources([{ id: "current", label: "Current provider", path: s.home }]), {});
  const card = id => board.tasks.find(task => task.id === id);
  assert.deepEqual(["T1", "T2", "T3"].map(id => taskWord(card(id)).word), ["needs you", "waiting", "not started"], "the cards of the T997 example");
  assert.deepEqual([board.milestones[0].id, board.milestones[0].state], ["M1", "active"]);
  // The chat board shows a milestone in a release in its "Where we are" frame: its name, then its word on its first line.
  const frame = renderBoardText(board).match(/│ ╭─ Milestone 1: Sage feel ─+╮ │\n│ │ (.+?) · 0 of 2 tasks done/)?.[1];
  const status = s.ok("status"), statusWord = name => status.match(new RegExp(`^${name} · (?:release 1\\.0 · )?(.+?) · `, "m"))?.[1];
  // One assertion, so that a failure shows the word of each view at once.
  assert.deepEqual({
    board: board.milestones[0].word, chat: frame?.toLowerCase(), status: statusWord("milestone M1"),
    releaseOnBoard: board.releases[0].releases[0].word, releaseInStatus: statusWord("release 1\\.0"),
  }, { board: "in progress", chat: "in progress", status: "in progress", releaseOnBoard: "in progress", releaseInStatus: "in progress" });
});

test("T1009: a milestone whose only open task waits after its briefing has not started, on the board model, the chat board and status", () => {
  // A briefed task that waits for its pilot is waiting (T1002 F3), so nothing in the milestone has started yet.
  const s = logbook();
  for (const n of [1, 2]) s.ok("task", "add", "--title", `Sample task ${n}`, "--size", "small", "--priority", "P2");
  s.ok("milestone", "propose", "--name", "Sage feel", "--goal", "A sample goal", "--pilot", "T1", "--tasks", "T2");
  s.ok("gate", "answer", "G1", "--option", "1");
  setState(s.dir, "T2", "briefed");

  const board = buildBoardModel(readBoardSources([{ id: "current", label: "Current provider", path: s.home }]), {});
  assert.deepEqual(["T1", "T2"].map(id => taskWord(board.tasks.find(task => task.id === id)).word), ["not started", "waiting"]);
  assert.deepEqual({
    board: board.milestones[0].word,
    chat: renderBoardText(board).match(/^- Milestone 1\\: Sage feel · (.+?) · 0 of 2 merged/m)?.[1],
    status: s.ok("status").match(/^milestone M1 · (.+?) · /m)?.[1],
  }, { board: "not started", chat: "not started", status: "not started" });
});
