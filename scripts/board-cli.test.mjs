import "./test-env.mjs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStateTool } from "../packages/sage-core/index.mjs";
import { createBoardConfig, readBoardConfig, runBoardCli } from "../packages/sage-board/cli.mjs";
function fixture(t) {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "sage-board-cli-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, "logbooks"), config = join(dir, "settings/board.json");
  const tool = createStateTool({ defaultRoot: () => root });
  tool.sage(["init", "--project", dir], { ...process.env, SAGE_HOME: root });
  tool.sage(["task", "add", "--title", "Sample CLI task", "--size", "small", "--project", dir], { ...process.env, SAGE_HOME: root });
  const value = createBoardConfig(config, { sources: [{ id: "sample", path: root }], pagesDir: join(dir, "pages") });
  return { dir, root, config, value };
}
test("T229: standalone config has no secret and no password, private mode and no logbook output path", t => {
  const { config, root, value } = fixture(t);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(config, "utf8"))).sort(), ["allowedHosts", "pagesDir", "port", "sources", "version"]);
  assert.equal(value.secret, undefined); assert.equal(value.password, undefined);
  assert.throws(() => createBoardConfig(join(root, "low-port.json"), { sources: [{ id: "sample", path: root }], port: 1023 }), /1024 to 65535/);
  assert.equal(statSync(config).mode & 0o777, 0o600);
  assert.deepEqual(readBoardConfig(config), value);
  assert.throws(() => createBoardConfig(join(root, "settings.json"), { sources: [{ id: "sample", path: root }] }), /outside logbook roots/);
  assert.throws(() => createBoardConfig(config, { sources: [{ id: "sample", path: root }] }), /exists, and setup does not change it/);
});
test("T395: setup on an existing config names the file and says how to change its port, and leaves the file as it was", async t => {
  const { config } = fixture(t), before = readFileSync(config, "utf8");
  const cli = fileURLToPath(new URL("../packages/sage-board/cli.mjs", import.meta.url));
  await assert.rejects(runBoardCli(["board", "--setup", "--config", config, "--port", "43200"], { output: () => {} }), {
    message: `the board config ${config} exists, and setup does not change it. To change its "port" or another setting, edit that file, then run node ${cli} board --stop --config ${config} and ask for the board again. To set the board up again, remove the file first.`,
  });
  assert.equal(readFileSync(config, "utf8"), before);
});
test("T395: setup with --config prints the set-password command with that --config, also when it is the default path of this HOME", async t => {
  const { dir, root } = fixture(t), home = join(dir, "home"), config = join(home, ".config/sage-board/board.json"), lines = [];
  const cli = fileURLToPath(new URL("../packages/sage-board/cli.mjs", import.meta.url));
  await runBoardCli(["board", "--setup", "--config", config, "--sources", JSON.stringify([{ id: "sample", path: root }])], { output: line => lines.push(line), env: { HOME: home } });
  assert.deepEqual(lines, [`Board config created: ${config}. Access from outside this Mac stays off until you set a board password: run in a terminal node ${cli} board --set-password --config ${config}`]);
});
test("standalone HTML export includes task detail, prints its path and does not overwrite", async t => {
  const { dir, config, value } = fixture(t), lines = [];
  await runBoardCli(["board", "all", "--html", "--config", config], { output: line => lines.push(line) });
  const file = lines[0];
  assert.ok(file.startsWith(join(dir, "pages/board-")));
  const html = readFileSync(file, "utf8");
  assert.ok(html.includes("Sample CLI task")); assert.ok(html.includes('<h3>Evidence <span class="n">0</span></h3>'));
  await runBoardCli(["board", "all", "--html", "--config", config], { output: line => lines.push(line) });
  assert.notEqual(lines[1], file);
  assert.ok(existsSync(file) && existsSync(lines[1]));
  await assert.rejects(runBoardCli(["board", "all", "--html", "--out", file, "--config", config], { output: () => {} }), /EEXIST/);
});
test("standalone refuses linked output parents and exposes status without a server", async t => {
  const { dir, root, config } = fixture(t), lines = [];
  const link = join(dir, "linked-pages"); symlinkSync(root, link);
  await assert.rejects(runBoardCli(["board", "all", "--html", "--out", join(link, "board.html"), "--config", config]), TypeError);
  assert.equal(existsSync(join(root, "board.html")), false);
  const outside = join(dir, "outside"), outsideLink = join(dir, "outside-link"); mkdirSync(outside); symlinkSync(outside, outsideLink);
  await assert.rejects(runBoardCli(["board", "all", "--html", "--out", join(outsideLink, "board.html"), "--config", config]), TypeError);
  assert.equal(existsSync(join(outside, "board.html")), false);
  await runBoardCli(["board", "all", "--status", "--config", config], { output: line => lines.push(line) });
  assert.ok(lines[0].includes("framed 1"));
  await assert.rejects(runBoardCli(["board", "--config", config, "--config", config]), /repeated/);
});

test("standalone setup and installation stay explicit, with no service operation", async t => {
  const { dir, root } = fixture(t), config = join(dir, "extra/board.json"), lines = [];
  await runBoardCli(["board", "--setup", "--config", config, "--sources", JSON.stringify([{ id: "sample", path: root }])], { output: line => lines.push(line) });
  assert.deepEqual(lines, [`Board config created: ${config}. Access from outside this Mac stays off until you set a board password: run in a terminal node ${fileURLToPath(new URL("../packages/sage-board/cli.mjs", import.meta.url))} board --set-password --config ${config}`]);
  const install = join(dir, "installed"), plist = join(dir, "login/board.plist");
  await assert.rejects(runBoardCli(["board", "--install", "--install-dir", install, "--login-file", join(root, "board.plist"), "--config", config]), /outside logbook roots/);
  assert.equal(existsSync(install), false);
  // The login file names Node through a stable PATH command, so a fixture PATH replaces the machine's PATH.
  const bin = join(dir, "bin"), stableNode = join(bin, "node"), savedPath = process.env.PATH;
  mkdirSync(bin); symlinkSync(process.execPath, stableNode);
  process.env.PATH = join(dir, "empty-bin");
  try {
    await assert.rejects(runBoardCli(["board", "--install", "--install-dir", install, "--login-file", plist, "--config", config]), /upgrade-stable Node/);
    process.env.PATH = bin;
    await runBoardCli(["board", "--install", "--install-dir", install, "--login-file", plist, "--config", config], { output: line => lines.push(line) });
  } finally { process.env.PATH = savedPath; }
  assert.ok(readFileSync(join(install, "packages/sage-board/cli.mjs"), "utf8").includes("runBoardCli"));
  assert.ok(readFileSync(plist, "utf8").includes("dev.sage.board"));
  assert.ok(readFileSync(plist, "utf8").includes(`<string>${stableNode}</string>`));
  const installed = spawnSync(process.execPath, [join(install, "packages/sage-board/cli.mjs"), "board", "all", "--status", "--config", config], { cwd: dir, env: process.env, encoding: "utf8" });
  assert.equal(installed.status, 0, installed.stderr);
  assert.ok(installed.stdout.includes("framed 1"));
});


test("malformed settings and setup JSON never expose input in diagnostics", async t => {
  const { dir } = fixture(t), malformed = join(dir, "bad.json"), privateText = "SAMPLE_SECRET_DO_NOT_LOG";
  writeFileSync(malformed, privateText);
  assert.throws(() => readBoardConfig(malformed), error => error.message === "board JSON is invalid" && !error.message.includes(privateText));
  await assert.rejects(runBoardCli(["board", "--setup", "--config", join(dir, "unused.json"), "--sources", privateText]), { message: "board JSON is invalid" });
  assert.equal(existsSync(join(dir, "unused.json")), false);
});


test("settings reads reject linked ancestors and service commands reject ignored task scope", async t => {
  const { dir, config } = fixture(t), link = join(dir, "settings-link");
  symlinkSync(join(dir, "settings"), link);
  assert.throws(() => readBoardConfig(join(link, "board.json")), /ordinary directory/);
  await assert.rejects(runBoardCli(["board", "--serve", "--scope", "sample/project", "--config", config]), /only for a task lookup/);
});


test("standalone current-checkout board and task commands work without explicit project", t => {
  const { dir, config } = fixture(t), cli = fileURLToPath(new URL("../packages/sage-board/cli.mjs", import.meta.url));
  for (const scope of ["this", "T1"]) {
    const result = spawnSync(process.execPath, [cli, "board", scope, "--config", config], { cwd: dir, env: process.env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes("Sample CLI task"));
    if (scope === "T1") assert.ok(result.stdout.includes("**Brief**"));
  }
});

test("T229: a config with an old secret still loads, and the secret is not kept or used", async t => {
  const { dir, root } = fixture(t), config = join(dir, "old/board.json");
  mkdirSync(join(dir, "old"));
  const secret = "sampleOldSecretSampleOldSecretSampleOldSecr";
  writeFileSync(config, JSON.stringify({ version: 1, sources: [{ id: "sample", path: root }], port: 43123, allowedHosts: [], secret }), { mode: 0o600 });
  const loaded = readBoardConfig(config);
  assert.equal(loaded.secret, undefined, "the old secret is dropped on load, so no server gets it");
  assert.equal(loaded.password, undefined);
  const lines = [];
  await runBoardCli(["board", "all", "--status", "--config", config], { output: line => lines.push(line) });
  assert.ok(lines[0].includes("framed 1"));
});
