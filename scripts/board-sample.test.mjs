// The board sample script (T305) writes SAMPLE DATA only into an empty folder of your choice: never through a link and
// never into a real logbook root (F-T305-1, F-T305-2). Every folder here is in a fresh temporary folder.
import "./test-env.mjs";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { writeSampleLogbooks } from "./board-sample.mjs";

const NOW = "2026-10-18T12:00:00Z";
function scratch(t) {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "sage-board-sample-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("T305 F-T305-1: the sample script refuses a link as its folder, and a path through a link, and writes nothing there", t => {
  const dir = scratch(t), empty = join(dir, "empty");
  mkdirSync(empty);
  symlinkSync(empty, join(dir, "link"));
  assert.throws(() => writeSampleLogbooks(join(dir, "link"), { now: NOW }), /goes through the link .*link: give the real path \(.*empty\)/);
  assert.throws(() => writeSampleLogbooks(join(dir, "link", "sample"), { now: NOW }), /goes through the link .*link: give the real path \(.*empty[/]sample\)/);
  assert.deepEqual(readdirSync(empty), []);
  // The real path of the same folder works.
  const sources = writeSampleLogbooks(join(empty, "sample"), { now: NOW });
  assert.deepEqual(sources.map(source => source.path), [join(empty, "sample", "claude"), join(empty, "sample", "codex")]);
  assert.deepEqual(readdirSync(join(empty, "sample")).sort(), ["checkouts", "claude", "codex"]);
});

test("T305 F-T305-2: the sample script refuses a folder in a real logbook root, and writes nothing there", t => {
  const dir = scratch(t), home = join(dir, "home"), env = { HOME: home, SAGE_HOME: join(dir, "sage-home"), CLAUDE_CONFIG_DIR: join(dir, "claude-config"), CODEX_HOME: join(dir, "codex-home") };
  for (const folder of [join(dir, "sage-home"), join(dir, "sage-home", "sample"), join(dir, "claude-config", "sage", "sample"), join(dir, "codex-home", "x"), join(home, ".claude", "sage", "sample"), join(home, ".codex", "sample"), join(home, ".config", "sage-board", "sample")]) {
    assert.throws(() => writeSampleLogbooks(folder, { now: NOW, env }), /is in the real logbook root .*: give a folder outside it/, folder);
    assert.equal(existsSync(folder), false, folder);
  }
  // The same home, outside its roots, works: ~/.claude itself is not a logbook root.
  assert.equal(writeSampleLogbooks(join(home, ".claude", "sample"), { now: NOW, env }).length, 2);
});
