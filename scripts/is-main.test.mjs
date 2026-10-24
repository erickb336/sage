// The main guard of graphics.mjs and board-shots.mjs (scripts/is-main.mjs): a script on standard input can import
// either module, and a run of graphics.mjs through a linked path still draws.
import "./test-env.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { ROOT } from "./build.mjs";

for (const script of ["graphics.mjs", "board-shots.mjs"]) {
  test(`a script on standard input imports ${script} without an error, and does not run its main`, () => {
    const url = pathToFileURL(join(ROOT, "scripts", script)).href;
    const r = spawnSync("node", ["--input-type=module", "-"], { input: `await import(${JSON.stringify(url)});\nconsole.log("imported");\n`, encoding: "utf8" });
    assert.equal(r.stderr, "");
    assert.equal(r.stdout, "imported\n");
    assert.equal(r.status, 0);
  });
}

test("a run of graphics.mjs through a linked folder still draws every graphic", (t) => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "sage-is-main-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "real/scripts"), { recursive: true });
  for (const file of ["graphics.mjs", "is-main.mjs"]) cpSync(join(ROOT, "scripts", file), join(dir, "real/scripts", file));
  symlinkSync(join(dir, "real"), join(dir, "link"), "dir");
  const r = spawnSync("node", [join(dir, "link/scripts/graphics.mjs")], { encoding: "utf8" });
  assert.equal(r.stderr, "");
  assert.equal(r.status, 0);
  const drawn = readdirSync(join(dir, "real/docs/assets")).sort();
  assert.equal(r.stdout, `drew ${drawn.length} files in docs/assets\n`);
  assert.ok(drawn.includes("hero-light.svg") && drawn.includes("hero-dark.svg"), drawn.join(", "));
});
