// sage's Codex hooks in the user's hooks.json (T957): the fixed entries, the dispatcher, the launcher in
// <CODEX_HOME>/sage-hooks and the hooks install, uninstall and status commands. Every Codex home is a scratch folder
// under the temporary folder: no test reads or writes the real ~/.codex. No test runs Codex.
import "./test-env.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ROOT } from "./build.mjs";
import { entries, EVENTS } from "../plugins/sage-codex/hooks/entries.mjs";
import { dispatch, ROUTES } from "../plugins/sage-codex/hooks/dispatch.mjs";
import { planHooks } from "../plugins/sage-codex/hooks/launch.mjs";

const PLUGIN = join(ROOT, "plugins/sage-codex");
const MERGE = `gh pr merge 41 --squash --match-head-commit ${"a".repeat(40)}`;

/** A scratch HOME with a Codex home in it, and SAGE_HOME beside it. */
function scratch(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "sage-codex-hooks-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const codex = join(dir, ".codex");
  mkdirSync(codex);
  const { SAGE_HOME, CODEX_HOME, ...inherited } = process.env;
  const env = { ...inherited, HOME: dir, CODEX_HOME: codex, SAGE_HOME: join(dir, "sage-home") };
  /** The state tool's hooks command, as the owner runs it: node <plugin>/skills/sage/sage.mjs hooks <word>. */
  const hooks = (word, plugin = PLUGIN) => spawnSync(process.execPath, [join(plugin, "skills/sage/sage.mjs"), "hooks", word], { cwd: dir, env, encoding: "utf8" });
  /** A copy of the built plugin as Codex installs it, in plugins/cache/sage/sage/<version>. */
  const version = (name, from = PLUGIN) => { const root = join(codex, "plugins/cache/sage/sage", name); mkdirSync(join(root, ".."), { recursive: true }); cpSync(from, root, { recursive: true }); return root; };
  /** One event through the installed launcher, as Codex runs the entry's command (without a shell: node and its arguments). */
  const launch = (event, input, launcher = join(codex, "sage-hooks/launch.mjs")) => spawnSync(process.execPath, [launcher, event], { cwd: dir, env, input: typeof input === "string" ? input : JSON.stringify(input), encoding: "utf8" });
  return { dir, codex, env, hooks, version, launch, file: join(codex, "hooks.json") };
}

/** A fake installed version whose dispatcher prints its version and what it got. */
function marker(s, name) {
  const root = join(s.codex, "plugins/cache/sage/sage", name);
  mkdirSync(join(root, "hooks"), { recursive: true });
  writeFileSync(join(root, "hooks/dispatch.mjs"), `export const dispatch = (event, input, context) => ({ version: ${JSON.stringify(name)}, event, input, context });\n`);
  return root;
}

const USER = { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo mine" }] }], Stop: [{ hooks: [{ type: "command", command: "echo stop" }] }] }, other: { kept: true } };

test("the fixed list: 7 events, one group each with no matcher, each running the launcher with its event; the dispatcher routes the same events", () => {
  const list = entries("/h/.codex");
  assert.deepEqual(Object.keys(list), ["SessionStart", "UserPromptSubmit", "PreToolUse", "PermissionRequest", "PostToolUse", "SubagentStart", "SubagentStop"]);
  assert.deepEqual(Object.keys(ROUTES), Object.keys(EVENTS));
  assert.deepEqual(list.SessionStart, { hooks: [{ type: "command", command: 'node "/h/.codex/sage-hooks/launch.mjs" SessionStart', timeout: 10, additionalContextLimit: 6000 }] });
  assert.deepEqual(list.PreToolUse, { hooks: [{ type: "command", command: 'node "/h/.codex/sage-hooks/launch.mjs" PreToolUse', timeout: 30 }] });
  assert.equal(list.SubagentStart.hooks[0].additionalContextLimit, 16000);
  assert.ok(Object.values(list).every((group) => !("matcher" in group) && group.hooks.length === 1));
});

test("the dispatcher runs each hook only for the sources and tools that its matcher named before T957", async () => {
  const pre = (tool_name, command) => ({ hook_event_name: "PreToolUse", session_id: "s1", turn_id: "t1", cwd: "/", tool_name, tool_use_id: "c1", tool_input: { command } });
  const deny = await dispatch("PreToolUse", pre("Bash", MERGE), {});
  assert.equal(deny.hookSpecificOutput.permissionDecision, "deny");
  assert.match(deny.hookSpecificOutput.permissionDecisionReason, /^sage: in Codex, only sage's merge command merges/);
  // A tool that the gate's matcher did not name: no hook, no answer, also for a merge text.
  for (const tool of ["read_file", "web_search", "Edit"]) assert.equal(await dispatch("PreToolUse", pre(tool, MERGE), {}), undefined, tool);
  assert.equal(await dispatch("PermissionRequest", { ...pre("apply_patch", "x"), hook_event_name: "PermissionRequest" }, {}), undefined);
  assert.equal(await dispatch("PostToolUse", { ...pre("Bash", "ls"), hook_event_name: "PostToolUse" }, {}), undefined);
  // An input that is not JSON reaches the gate, which refuses it, as before.
  assert.match((await dispatch("PreToolUse", undefined, {})).hookSpecificOutput.permissionDecisionReason, /could not read this tool call/);
  assert.deepEqual(await dispatch("SubagentStop", undefined, {}), { systemMessage: "sage: the report check could not read this agent's stop, so it did not check its report." });
  assert.equal(await dispatch("Stop", {}, {}), undefined, "an event that is not in the list");
});

test("planHooks keeps the user's groups and their places, appends a missing sage group, replaces a changed one in place and removes one that is not wanted", () => {
  const home = "/h/.codex", wanted = entries(home);
  const first = planHooks(JSON.stringify(USER), home, wanted);
  assert.equal(first.changed, true);
  assert.deepEqual(first.data.other, { kept: true });
  assert.deepEqual(first.data.hooks.PreToolUse, [USER.hooks.PreToolUse[0], wanted.PreToolUse], "the user's group keeps index 0; sage's goes at the end");
  assert.deepEqual(first.data.hooks.Stop, USER.hooks.Stop);
  assert.equal(planHooks(JSON.stringify(first.data), home, wanted).changed, false, "a second plan changes nothing");
  // A changed sage group (another timeout) is replaced where it is; a second sage group of the same event goes.
  const old = structuredClone(first.data);
  old.hooks.PreToolUse = [{ ...wanted.PreToolUse, hooks: [{ ...wanted.PreToolUse.hooks[0], timeout: 5 }] }, USER.hooks.PreToolUse[0], wanted.PreToolUse];
  assert.deepEqual(planHooks(JSON.stringify(old), home, wanted).data.hooks.PreToolUse, [wanted.PreToolUse, USER.hooks.PreToolUse[0]]);
  // Not wanted any more: removed, and an event left with no group goes.
  const fewer = planHooks(JSON.stringify(first.data), home, { PreToolUse: wanted.PreToolUse });
  assert.deepEqual(Object.keys(fewer.data.hooks), ["PreToolUse", "Stop"]);
  assert.deepEqual(planHooks(JSON.stringify(first.data), home, {}).data, USER, "removing every sage group gives the user's file back");
  // The group of another Codex home is not sage's here.
  assert.deepEqual(planHooks(JSON.stringify(first.data), "/other", {}).data, first.data);
  for (const text of ["{", "[]", '{"hooks":[]}', '{"hooks":{"PreToolUse":{}}}']) assert.throws(() => planHooks(text, home, wanted), undefined, text);
  assert.deepEqual(planHooks(undefined, home, wanted).data, { hooks: Object.fromEntries(Object.entries(wanted).map(([e, g]) => [e, [g]])) }, "no file yet");
});

test("hooks install adds 7 entries after the user's own, keeps their keys, copies the launcher and keeps a backup; a second run writes nothing", (t) => {
  const s = scratch(t);
  const text = JSON.stringify(USER, null, 4);
  writeFileSync(s.file, text);
  const first = s.hooks("install");
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /Installed the launcher .*sage-hooks\/launch\.mjs\.\nWrote sage's 7 entries in .*hooks\.json; the other hooks there stay as they were\./);
  assert.match(first.stdout, /Next: in the Codex CLI, type \/hooks and trust the 7 sage hooks that are not trusted yet/);
  const data = JSON.parse(readFileSync(s.file, "utf8"));
  assert.deepEqual(data, { ...USER, hooks: { PreToolUse: [USER.hooks.PreToolUse[0], entries(s.codex).PreToolUse], Stop: USER.hooks.Stop, ...Object.fromEntries(Object.entries(entries(s.codex)).filter(([e]) => e !== "PreToolUse").map(([e, g]) => [e, [g]])) } });
  assert.equal(Object.values(data.hooks).flat().filter((g) => /sage-hooks\/launch\.mjs/.test(g.hooks[0].command)).length, 7);
  assert.equal(readFileSync(`${s.file}.sage-backup`, "utf8"), text);
  assert.equal(readFileSync(join(s.codex, "sage-hooks/launch.mjs"), "utf8"), readFileSync(join(PLUGIN, "hooks/launch.mjs"), "utf8"));
  const bytes = readFileSync(s.file), when = statSync(s.file).mtimeMs;
  const second = s.hooks("install");
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /^sage's hooks are already installed in .*hooks\.json\. Nothing changed\./);
  assert.deepEqual(readFileSync(s.file), bytes, "the same bytes");
  assert.equal(statSync(s.file).mtimeMs, when, "no write");
  t.diagnostic(`install twice: ${bytes.length} bytes, identical after the second run`);
});

test("hooks install refuses a hooks.json that does not parse and a Codex home with a quote or a dollar sign, and changes nothing", (t) => {
  const s = scratch(t);
  writeFileSync(s.file, "{ not json");
  const r = s.hooks("install");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^sage: .*hooks\.json: it does not parse as JSON .*Fix or move the file, then run this again\. Nothing changed\./);
  assert.equal(readFileSync(s.file, "utf8"), "{ not json");
  assert.equal(existsSync(join(s.codex, "sage-hooks")), false);
  for (const name of ['a"b', "a$b"]) {
    const home = join(s.dir, name);
    mkdirSync(home);
    const bad = spawnSync(process.execPath, [join(PLUGIN, "skills/sage/sage.mjs"), "hooks", "install"], { env: { ...s.env, CODEX_HOME: home }, encoding: "utf8" });
    assert.equal(bad.status, 1, name);
    assert.match(bad.stderr, /which the hook command cannot hold/, name);
    assert.equal(existsSync(join(home, "hooks.json")), false, name);
  }
  // A [hooks] table in config.toml: a note, and the install still runs. Trust records alone are no such table.
  writeFileSync(s.file, "{}");
  writeFileSync(join(s.codex, "config.toml"), '[hooks.state."x:pre_tool_use:0:0"]\ntrusted_hash = "sha256:00"\n');
  assert.doesNotMatch(s.hooks("install").stdout, /\[hooks\] table/);
  writeFileSync(join(s.codex, "config.toml"), '[[hooks.PreToolUse]]\nmatcher = "Bash"\n');
  assert.match(s.hooks("install").stdout, /also has hooks in a \[hooks\] table/);
});

test("hooks uninstall, and the launcher's --uninstall, remove only sage's entries and the launcher folder", (t) => {
  const s = scratch(t);
  writeFileSync(s.file, JSON.stringify(USER));
  assert.equal(s.hooks("install").status, 0);
  const r = s.hooks("uninstall");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(readFileSync(s.file, "utf8")), USER);
  assert.equal(existsSync(join(s.codex, "sage-hooks")), false);
  // After codex plugin remove, the plugin is gone: the launcher removes itself.
  assert.equal(s.hooks("install").status, 0);
  const own = spawnSync(process.execPath, [join(s.codex, "sage-hooks/launch.mjs"), "--uninstall"], { env: s.env, encoding: "utf8" });
  assert.equal(own.status, 0, own.stderr);
  assert.match(own.stdout, /Removed sage's entries from .*hooks\.json\. The other hooks there stay as they were\.\nRemoved .*sage-hooks\./);
  assert.deepEqual(JSON.parse(readFileSync(s.file, "utf8")), USER);
  assert.equal(existsSync(join(s.codex, "sage-hooks")), false);
});

test("the launcher runs the dispatcher of the version that Codex uses: local, else the highest version; it passes CODEX_HOME from its own path", (t) => {
  const s = scratch(t);
  assert.equal(s.hooks("install").status, 0);
  for (const name of ["0.9.0", "0.10.0", "0.10.0-alpha.1", "0.2.0"]) marker(s, name);
  writeFileSync(join(s.codex, "plugins/cache/sage/sage/9.9.9"), "a file is no version");
  const run = (event, input = { hook_event_name: event }) => { const r = s.launch(event, input); assert.equal(r.status, 0, r.stderr); return r.stdout ? JSON.parse(r.stdout) : undefined; };
  assert.deepEqual(run("SubagentStop"), { version: "0.10.0", event: "SubagentStop", input: { hook_event_name: "SubagentStop" }, context: { codexHome: s.codex, launcherVersion: 2 } });
  marker(s, "local");
  assert.equal(run("PreToolUse").version, "local");
  assert.equal(run("PreToolUse", "not json").input, undefined, "an input that is not JSON reaches the dispatcher as undefined");
});

test("the launcher does nothing when sage is not installed, when Codex turns the plugin off, and for a version without a dispatcher", (t) => {
  const s = scratch(t);
  assert.equal(s.hooks("install").status, 0);
  const merge = { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: MERGE } };
  const quiet = (why) => { const r = s.launch("PreToolUse", merge); assert.deepEqual([r.status, r.stdout, r.stderr], [0, "", ""], why); };
  quiet("no install");
  marker(s, "0.1.0");
  writeFileSync(join(s.codex, "config.toml"), '[plugins."sage@sage"] # sage\nenabled = false\n');
  quiet("plugin off");
  writeFileSync(join(s.codex, "config.toml"), '[plugins."sage@sage"]\nenabled = true\n');
  assert.equal(JSON.parse(s.launch("PreToolUse", merge).stdout).version, "0.1.0", "on again");
  rmSync(join(s.codex, "plugins/cache/sage/sage/0.1.0/hooks/dispatch.mjs"));
  writeFileSync(join(s.codex, "plugins/cache/sage/sage/0.1.0/hooks/hooks.json"), "{}");
  quiet("a version before T957 runs its own plugin hooks (hooks/hooks.json)");
});

test("the launcher refuses only a Bash merge or push when the dispatcher fails to load or points out of the cache", (t) => {
  const s = scratch(t);
  assert.equal(s.hooks("install").status, 0);
  const root = marker(s, "0.1.0");
  const call = (command, tool_name = "Bash") => s.launch("PreToolUse", { hook_event_name: "PreToolUse", tool_name, tool_input: { command } });
  const refused = (r) => JSON.parse(r.stdout).hookSpecificOutput;
  writeFileSync(join(root, "hooks/dispatch.mjs"), "throw new Error('broken');\n");
  for (const command of [MERGE, "git push origin HEAD"]) {
    const out = refused(call(command));
    assert.equal(out.permissionDecision, "deny", command);
    assert.match(out.permissionDecisionReason, /^sage: sage's Codex hooks could not load \(broken\)\. Tell the user\. It refuses a merge or a push until sage's hooks load$/);
  }
  const other = call("ls");
  assert.deepEqual([other.status, other.stdout], [0, ""]);
  assert.match(other.stderr, /could not load \(broken\)/);
  assert.equal(call(MERGE, "apply_patch").stdout, "", "only Bash");
  // A dispatcher that links out of the cache folder does not load.
  const outside = join(s.dir, "outside.mjs");
  writeFileSync(outside, "export const dispatch = () => ({ ran: 'outside' });\n");
  rmSync(join(root, "hooks/dispatch.mjs"));
  symlinkSync(outside, join(root, "hooks/dispatch.mjs"));
  assert.match(refused(call(MERGE)).permissionDecisionReason, /is not a file inside/);
  assert.match(call("ls").stderr, /is not a file inside/);
  // A version folder that is a link is no version for Codex, so none for the launcher.
  rmSync(root, { recursive: true });
  symlinkSync(join(s.dir), root);
  assert.deepEqual([call(MERGE).stdout, call(MERGE).stderr], ["", ""]);
});

test("end to end: hooks install, then the installed launcher gives the real start status; a swap of the version folder keeps the entries and runs the new version", (t) => {
  const s = scratch(t);
  s.version("0.1.0");
  assert.equal(s.hooks("install").status, 0);
  const bytes = readFileSync(s.file);
  const start = { hook_event_name: "SessionStart", source: "startup", session_id: "s1", cwd: s.dir, transcript_path: join(s.dir, "none.jsonl") };
  const status = () => JSON.parse(s.launch("SessionStart", start).stdout).hookSpecificOutput.additionalContext;
  assert.match(status(), /^sage 0\.1\.0 is installed\. Codex version unknown\. sage hooks: 0 of 7 are trusted \(by their trust records; Codex checks each hash\)\./);
  assert.match(status(), /sage: 7 of the 7 sage hooks are not trusted or turned off, so they do not run\. To trust them or turn them on, type \/hooks in the Codex CLI\./);
  // An update: Codex installs the new version folder and removes the old one. The entries stay byte for byte.
  const next = s.version("0.2.0");
  const manifest = join(next, ".codex-plugin/plugin.json");
  writeFileSync(manifest, JSON.stringify({ ...JSON.parse(readFileSync(manifest, "utf8")), version: "0.2.0" }));
  rmSync(join(s.codex, "plugins/cache/sage/sage/0.1.0"), { recursive: true });
  assert.match(status(), /^sage 0\.2\.0 is installed\./);
  assert.deepEqual(readFileSync(s.file), bytes, "an update changes no entry, so it needs no new trust");
  // A rename of the folder (Codex's own swap) too.
  renameSync(next, join(s.codex, "plugins/cache/sage/sage/0.3.0"));
  assert.match(status(), /^sage 0\.2\.0 is installed\./, "the manifest's version, from the folder that Codex uses");
  assert.deepEqual(readFileSync(s.file), bytes);
});

test("the start status names each missing or changed entry, each entry without a trust record and an old launcher, with the command that fixes it", (t) => {
  const s = scratch(t);
  const root = s.version("0.1.0");
  assert.equal(s.hooks("install").status, 0);
  const keys = ["session_start", "user_prompt_submit", "pre_tool_use", "permission_request", "post_tool_use", "subagent_start", "subagent_stop"];
  writeFileSync(join(s.codex, "config.toml"), keys.map((key) => `[hooks.state."${s.file}:${key}:0:0"]\ntrusted_hash = "sha256:00"\n`).join("\n"));
  const start = { hook_event_name: "SessionStart", source: "startup", session_id: "s1", cwd: s.dir, transcript_path: join(s.dir, "none.jsonl") };
  const warning = () => JSON.parse(s.launch("SessionStart", start).stdout).systemMessage;
  assert.equal(warning(), "sage: the hook could not read the Codex version, so some sage rules may not run. Autopilot merges in Codex 0.164 and later.\n" +
    "sage: Codex runs at most 3 agents at once in this session (Codex's default of 4 threads, the chief's own included), and this project's agent cap is 10 (max_agents, or cap.<project>). An agent over Codex's limit fails to start with \"agent thread limit reached\". To raise it, set max_concurrent_threads_per_session = 10 under [agents] in " + join(s.codex, "config.toml") + ", then start a new session.", "all 7 entries match and have a record");
  const install = `node "${join(root, "skills/sage/sage.mjs")}" hooks install`;
  const ask = `the user runs this command in a terminal, or says yes and then the chief runs it (never without that yes): ${install}`;
  // One entry gone, one with another timeout (a hand edit), and an old launcher.
  const data = JSON.parse(readFileSync(s.file, "utf8"));
  delete data.hooks.SubagentStop;
  data.hooks.PostToolUse[0].hooks[0].timeout = 99;
  writeFileSync(s.file, JSON.stringify(data));
  const launcher = join(s.codex, "sage-hooks/launch.mjs");
  writeFileSync(launcher, readFileSync(launcher, "utf8").replace(/LAUNCHER_VERSION = \d+;/, "LAUNCHER_VERSION = 0;"));
  // F-T957-4: the changed entry keeps the record of its old text, which Codex reports as Modified, so it is not trusted.
  assert.deepEqual(warning().split("\n").slice(0, 3), [
    `sage: 2 of the 7 sage hook entries in ${s.file} are missing or changed, so some sage rules do not run. To fix them, ${ask}`,
    "sage: 1 of the 7 sage hooks is not trusted or turned off, so it does not run. To trust it or turn it on, type /hooks in the Codex CLI.",
    `sage: the sage hook launcher in ${join(s.codex, "sage-hooks")} is older than this sage version. To update it, ${ask}`,
  ]);
  writeFileSync(join(s.codex, "config.toml"), keys.slice(0, 4).map((key) => `[hooks.state."${s.file}:${key}:0:0"]\ntrusted_hash = "sha256:00"\n`).join("\n"));
  assert.equal(warning().split("\n")[1], "sage: 2 of the 7 sage hooks are not trusted or turned off, so they do not run. To trust them or turn them on, type /hooks in the Codex CLI.");
  const status = s.hooks("status", root);
  assert.equal(status.status, 0, status.stderr);
  assert.equal(status.stdout, [
    `Entries in ${s.file}: 5 of 7 match this sage version (PostToolUse changed, SubagentStop missing). 4 of 6 are trusted (by their trust records).`,
    `Launcher: version 0 in ${join(s.codex, "sage-hooks")}; this sage version's launcher is version 2.`,
    `Installed sage: ${root}.`,
    `To fix: ${ask}`,
  ].join("\n") + "\n");
  assert.equal(s.hooks("install", root).status, 0);
  assert.equal(warning().split("\n")[0], "sage: 3 of the 7 sage hooks are not trusted or turned off, so they do not run. To trust them or turn them on, type /hooks in the Codex CLI.", "fixed: only the trust is left");
  assert.match(s.hooks("status", root).stdout, /: 7 of 7 match this sage version\. 4 of 7 are trusted \(by their trust records\)\.\nLauncher: version 2 in /);
  // F-T957-4: a record that /hooks turned off (enabled = false) does not count.
  writeFileSync(join(s.codex, "config.toml"), keys.map((key, i) => `[hooks.state."${s.file}:${key}:0:0"]\ntrusted_hash = "sha256:00"\n${i === 2 ? "enabled = false\n" : ""}`).join("\n"));
  assert.match(s.hooks("status", root).stdout, /\. 6 of 7 are trusted \(by their trust records\)\./);
});

test("F-T957-1: through the launcher, a review child's stop keeps its report in the SAGE_HOME logbook, where its start bound it", (t) => {
  const s = scratch(t);
  const root = s.version("0.1.0");
  assert.equal(s.hooks("install").status, 0);
  const project = join(s.dir, "project");
  mkdirSync(project);
  const git = (...args) => spawnSync("git", ["-C", project, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("commit", "-q", "--allow-empty", "-m", "start");
  const ok = (...args) => { const r = spawnSync(process.execPath, [join(root, "skills/sage/sage.mjs"), ...args, "--project", project], { env: s.env, encoding: "utf8" }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  ok("init");
  ok("task", "add", "--priority", "P2", "--title", "t1", "--size", "small");
  const run = ok("run", "add", "T1", "--role", "qa").split(" ")[0];
  const transcript = join(s.dir, "child.jsonl");
  writeFileSync(transcript, JSON.stringify({ type: "session_meta", payload: { id: "01a1726e-0000-7000-8000-000000000001", agent_path: `/root/sage_qa_t1_${run.toLowerCase()}` } }) + "\n");
  const start = s.launch("SubagentStart", { hook_event_name: "SubagentStart", session_id: "s1", transcript_path: transcript, cwd: project });
  assert.equal(start.status, 0, start.stderr);
  const report = "STATUS done\nRESULT PASS\nEVIDENCE npm test passed\nFINDINGS none\nQUESTIONS none\nNOT VERIFIED none\nBRANCH none";
  const stop = s.launch("SubagentStop", { hook_event_name: "SubagentStop", session_id: "s1", transcript_path: transcript, agent_transcript_path: transcript, cwd: project, stop_hook_active: false, last_assistant_message: report });
  assert.equal(stop.status, 0, stop.stderr);
  assert.deepEqual(JSON.parse(stop.stdout), {}, "the report is kept, with no line for the chief");
  const book = ok("logbook");
  assert.ok(book.startsWith(`${s.env.SAGE_HOME}/`), book);
  assert.equal(JSON.parse(readFileSync(join(book, "kept", `${run}.json`), "utf8")).text, report);
});

test("F-T957-3, F-T957-11: hooks install with no hooks file makes one, and names no backup and no other hooks", (t) => {
  const s = scratch(t);
  const r = s.hooks("install");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`\\nWrote sage's 7 entries in a new ${s.file.replaceAll(".", "\\.")}\\.\\n`));
  assert.doesNotMatch(r.stdout, /sage-backup|stay as they were/);
  assert.equal(existsSync(`${s.file}.sage-backup`), false);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(s.file, "utf8")).hooks), Object.keys(EVENTS));
});

test("F-T957-12: hooks uninstall refuses a hooks.json that does not parse, names the file and changes nothing", (t) => {
  const s = scratch(t);
  assert.equal(s.hooks("install").status, 0);
  writeFileSync(s.file, "{ not json");
  const r = s.hooks("uninstall");
  assert.equal(r.status, 1);
  assert.match(r.stderr, new RegExp(`^sage: ${s.file.replaceAll(".", "\\.")}: it does not parse as JSON \\(.*\\)\\. Nothing changed\\.\\n$`));
  assert.equal(readFileSync(s.file, "utf8"), "{ not json");
  assert.equal(existsSync(join(s.codex, "sage-hooks/launch.mjs")), true, "the launcher stays");
  const own = spawnSync(process.execPath, [join(s.codex, "sage-hooks/launch.mjs"), "--uninstall"], { env: s.env, encoding: "utf8" });
  assert.equal(own.status, 1);
  assert.equal(own.stderr, r.stderr, "the launcher's --uninstall says the same");
});

test("F-T957-9: the launcher does nothing for each TOML form that turns the plugin off, and runs when it is on or when the reader is not sure", (t) => {
  const s = scratch(t);
  assert.equal(s.hooks("install").status, 0);
  marker(s, "0.1.0");
  const merge = { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: MERGE } };
  const config = join(s.codex, "config.toml");
  const off = [
    '[plugins."sage@sage"]\nenabled = false\n',
    'model = "x"\nplugins."sage@sage".enabled = false\n',
    '[plugins]\n"sage@sage".enabled = false\n',
    '[plugins]\n"sage@sage" = { enabled = false }\n',
    'plugins = { "sage@sage" = { enabled = false } }\n',
    "plugins.'sage@sage' = { release_id = \"r1\", enabled = false } # off\n",
    "[ plugins . 'sage@sage' ]  # sage\n  enabled=false\n",
  ];
  for (const text of off) {
    writeFileSync(config, text);
    const r = s.launch("PreToolUse", merge);
    assert.deepEqual([r.status, r.stdout, r.stderr], [0, "", ""], text);
  }
  const on = [
    '[plugins."sage@sage"]\nenabled = true\n',
    '[plugins."other@x"]\nenabled = false\n',
    '[plugins."sage@sage".x]\nenabled = false\n',
    '[plugins]\n"sage@sage" = { enabled = true }\n[other]\nenabled = false\n',
    '[[profiles]]\nplugins."sage@sage".enabled = false\n',
    '[plugins."sage\\u0040sage"]\nenabled = false\n', // an escape in the key: the reader is not sure, so the hooks run
  ];
  for (const text of on) {
    writeFileSync(config, text);
    assert.equal(JSON.parse(s.launch("PreToolUse", merge).stdout).version, "0.1.0", text);
  }
});

test("F-T957-5: the launcher refuses a Bash merge or push when the dispatcher gives no answer before the entry's timeout, then ends; an answer in time ends at once", (t) => {
  const s = scratch(t);
  assert.equal(s.hooks("install").status, 0);
  const root = marker(s, "0.1.0");
  const launcher = join(s.codex, "sage-hooks/launch.mjs");
  const call = (command) => spawnSync(process.execPath, [launcher, "PreToolUse"], { cwd: s.dir, env: s.env, encoding: "utf8", timeout: 10000,
    input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } }) });
  // An answer in time: the 30 s entry's timer goes, so the process ends long before the timer would fire (24 s).
  const quick = call(MERGE);
  assert.deepEqual([quick.status, quick.signal, JSON.parse(quick.stdout).version], [0, null, "0.1.0"]);
  // A dispatcher that never answers and holds the process open; the test's copy of the launcher has a 0.5 s timeout.
  writeFileSync(join(root, "hooks/dispatch.mjs"), "export const dispatch = () => new Promise(() => { setInterval(() => {}, 1000); });\n");
  writeFileSync(launcher, readFileSync(launcher, "utf8").replace(/\bPreToolUse: 30\b/, "PreToolUse: 0.5"));
  for (const command of [MERGE, "git push origin HEAD"]) {
    const r = call(command);
    assert.deepEqual([r.status, r.signal], [0, null], command);
    assert.deepEqual(JSON.parse(r.stdout).hookSpecificOutput, { hookEventName: "PreToolUse", permissionDecision: "deny",
      permissionDecisionReason: "sage: sage's Codex hooks could not load (no answer in 0.4 s). Tell the user. It refuses a merge or a push until sage's hooks load" }, command);
  }
  const other = call("ls");
  assert.deepEqual([other.status, other.signal, other.stdout], [0, null, ""]);
  assert.match(other.stderr, /could not load \(no answer in 0\.4 s\)/);
});

test("F-T957-19: the gate's not-running line and the start status ask the user for the install, say that the chief runs it only after a yes, and give the exact command", async (t) => {
  const { NO_GATE } = await import("../plugins/sage-codex/hooks/gate-hook.mjs");
  const install = `node "${join(PLUGIN, "skills/sage/sage.mjs")}" hooks install`;
  assert.equal(NO_GATE, `sage's gate is not running. If sage's hooks are not installed yet, tell the user. To install them, the user runs this command in a terminal, or says yes and then the chief runs it (never without that yes): ${install}. Then the user trusts them with /hooks in the Codex CLI (or the app's hook review), and you try again.`);
  const s = scratch(t);
  const root = s.version("0.1.0");
  assert.equal(s.hooks("install").status, 0);
  rmSync(s.file);
  const start = { hook_event_name: "SessionStart", source: "startup", session_id: "s1", cwd: s.dir, transcript_path: join(s.dir, "none.jsonl") };
  const out = JSON.parse(s.launch("SessionStart", start).stdout);
  const line = `sage: 7 of the 7 sage hook entries in ${s.file} are missing or changed, so some sage rules do not run. To fix them, the user runs this command in a terminal, or says yes and then the chief runs it (never without that yes): node "${join(root, "skills/sage/sage.mjs")}" hooks install`;
  assert.equal(out.systemMessage.split("\n")[0], line, "the user's line");
  assert.ok(out.hookSpecificOutput.additionalContext.split("\n").includes(line), "the chief's status");
  for (const text of [NO_GATE, out.hookSpecificOutput.additionalContext]) assert.doesNotMatch(text, /run: node/, "no order to run it");
});

test("F-T957-25: hooks install writes the Codex home that holds the plugin, not ~/.codex, and refuses a CODEX_HOME that names another home", (t) => {
  const s = scratch(t);
  const root = s.version("0.1.0");
  const other = join(s.dir, "home2");
  mkdirSync(join(other, ".codex"), { recursive: true });
  const { CODEX_HOME, ...env } = s.env;
  const run = (extra) => spawnSync(process.execPath, [join(root, "skills/sage/sage.mjs"), "hooks", "install"], { env: { ...env, HOME: other, ...extra }, encoding: "utf8" });
  const r = run({});
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(s.file), "the plugin's home");
  assert.equal(existsSync(join(other, ".codex/hooks.json")), false, "not ~/.codex");
  assert.match(readFileSync(s.file, "utf8"), new RegExp(`node \\\\"${join(s.codex, "sage-hooks/launch.mjs").replaceAll(".", "\\.")}\\\\" SessionStart`));
  rmSync(s.file);
  const refused = run({ CODEX_HOME: join(other, ".codex") });
  assert.equal(refused.status, 1);
  assert.equal(refused.stderr, `sage: this sage plugin is in the Codex home ${s.codex}, but CODEX_HOME is ${join(other, ".codex")}. Run the command of the plugin in ${join(other, ".codex")}/plugins/cache/sage/sage, or run this one without CODEX_HOME. Nothing changed.\n`);
  assert.deepEqual([existsSync(s.file), existsSync(join(other, ".codex/hooks.json"))], [false, false]);
  assert.equal(run({ CODEX_HOME: s.codex }).status, 0, "the same home");
  assert.ok(existsSync(s.file));
});

test("F-T957-2, F-T957-10: install and uninstall keep a handler that the user put inside sage's group", (t) => {
  const home = "/h/.codex", wanted = entries(home), sage = wanted.PreToolUse.hooks[0];
  const mine = { type: "command", command: "echo mine" };
  // The user's handler after sage's, in sage's group: install changes nothing, uninstall keeps the user's handler.
  const shared = { hooks: { PreToolUse: [{ hooks: [sage, mine] }] } };
  assert.deepEqual(planHooks(JSON.stringify(shared), home, { PreToolUse: wanted.PreToolUse }), { data: shared, changed: false });
  assert.deepEqual(planHooks(JSON.stringify(shared), home, {}).data, { hooks: { PreToolUse: [{ hooks: [mine] }] } });
  // A changed sage handler is replaced in place, beside the user's.
  const old = { hooks: { PreToolUse: [{ hooks: [mine, { ...sage, timeout: 5 }] }] } };
  assert.deepEqual(planHooks(JSON.stringify(old), home, { PreToolUse: wanted.PreToolUse }).data, { hooks: { PreToolUse: [{ hooks: [mine, sage] }] } });
  // sage's handler in a group with a matcher: the user's group stays as it is, and sage's group goes at the end.
  const matched = { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [mine, sage] }] } };
  assert.deepEqual(planHooks(JSON.stringify(matched), home, { PreToolUse: wanted.PreToolUse }).data, { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [mine] }, wanted.PreToolUse] } });
  // Through the commands, in a scratch Codex home: the status counts the shared group as sage's entry.
  const s = scratch(t);
  assert.equal(s.hooks("install").status, 0);
  const data = JSON.parse(readFileSync(s.file, "utf8"));
  data.hooks.Stop = [{ hooks: [mine] }];
  data.hooks.SessionStart[0].hooks.push(mine);
  writeFileSync(s.file, JSON.stringify(data));
  assert.match(s.hooks("install").stdout, /already installed/);
  assert.match(s.hooks("status").stdout, /: 7 of 7 match this sage version\./);
  assert.equal(s.hooks("uninstall").status, 0);
  assert.deepEqual(JSON.parse(readFileSync(s.file, "utf8")), { hooks: { SessionStart: [{ hooks: [mine] }], Stop: [{ hooks: [mine] }] } });
});

test("F-T957-14, F-T957-15: a newest version folder without a dispatcher (empty or broken) makes the launcher refuse a merge or a push", (t) => {
  const s = scratch(t);
  assert.equal(s.hooks("install").status, 0);
  marker(s, "0.1.0");
  mkdirSync(join(s.codex, "plugins/cache/sage/sage/0.2.0"));
  const call = (command) => s.launch("PreToolUse", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } });
  for (const command of [MERGE, "git push origin HEAD"]) assert.deepEqual(JSON.parse(call(command).stdout).hookSpecificOutput, { hookEventName: "PreToolUse", permissionDecision: "deny",
    permissionDecisionReason: "sage: sage's Codex hooks could not load (the sage version 0.2.0 has no hooks/dispatch.mjs). Tell the user. It refuses a merge or a push until sage's hooks load" }, command);
  const other = call("ls");
  assert.deepEqual([other.status, other.stdout], [0, ""]);
  assert.match(other.stderr, /the sage version 0\.2\.0 has no hooks\/dispatch\.mjs/);
  mkdirSync(join(s.codex, "plugins/cache/sage/sage/0.2.0/hooks"));
  assert.match(JSON.parse(call(MERGE).stdout).hookSpecificOutput.permissionDecisionReason, /0\.2\.0 has no hooks\/dispatch\.mjs/, "a hooks folder without the dispatcher");
});

test("F-T957-20: hooks install treats a 0-byte or blank hooks.json as empty", (t) => {
  const s = scratch(t);
  for (const text of ["", "\n  \n"]) {
    writeFileSync(s.file, text);
    const r = s.hooks("install");
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(s.file, "utf8")).hooks), Object.keys(EVENTS), JSON.stringify(text));
  }
});

test("F-T957-26: the install's next line says 1 hook, not 1 hooks", (t) => {
  const s = scratch(t);
  const keys = ["session_start", "user_prompt_submit", "pre_tool_use", "permission_request", "post_tool_use", "subagent_start"];
  writeFileSync(join(s.codex, "config.toml"), keys.map((key) => `[hooks.state."${s.file}:${key}:0:0"]\ntrusted_hash = "sha256:00"\n`).join("\n"));
  assert.match(s.hooks("install").stdout, /\nNext: in the Codex CLI, type \/hooks and trust the 1 sage hook that is not trusted yet \(the hooks of /);
});

test("F-T957-13: the launcher reads no setting inside a TOML multi-line string", (t) => {
  const s = scratch(t);
  assert.equal(s.hooks("install").status, 0);
  marker(s, "0.1.0");
  const merge = { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: MERGE } };
  const config = join(s.codex, "config.toml");
  for (const mark of ['"""', "'''"]) {
    writeFileSync(config, `notes = ${mark}\n[plugins."sage@sage"]\nenabled = false\n${mark}\n`);
    assert.equal(JSON.parse(s.launch("PreToolUse", merge).stdout).version, "0.1.0", mark);
    writeFileSync(config, `notes = ${mark}one\ntwo${mark}\n[plugins."sage@sage"]\nenabled = false\n`);
    const r = s.launch("PreToolUse", merge);
    assert.deepEqual([r.status, r.stdout, r.stderr], [0, "", ""], `${mark}: off after the string ends`);
  }
});

test("F-T957-17: local wins over a name that sorts after it, and a trust record keyed by the plain ~/.codex path counts", (t) => {
  const s = scratch(t);
  assert.equal(s.hooks("install").status, 0);
  marker(s, "zz");
  assert.equal(JSON.parse(s.launch("SubagentStop", { hook_event_name: "SubagentStop" }).stdout).version, "zz", "without local, the highest name");
  marker(s, "local");
  assert.equal(JSON.parse(s.launch("SubagentStop", { hook_event_name: "SubagentStop" }).stdout).version, "local");
  // ~/.codex is a link to the real Codex home, and CODEX_HOME is not set: Codex keys the hooks by the plain path.
  const home = join(s.dir, "home2");
  mkdirSync(home);
  symlinkSync(s.codex, join(home, ".codex"));
  const keys = ["session_start", "user_prompt_submit", "pre_tool_use", "permission_request", "post_tool_use", "subagent_start", "subagent_stop"];
  const plain = join(home, ".codex/hooks.json");
  writeFileSync(join(s.codex, "config.toml"), keys.map((key) => `[hooks.state."${plain}:${key}:0:0"]\ntrusted_hash = "sha256:00"\n`).join("\n"));
  const { CODEX_HOME, ...env } = s.env;
  const status = (extra) => spawnSync(process.execPath, [join(PLUGIN, "skills/sage/sage.mjs"), "hooks", "status"], { env: { ...env, HOME: home, ...extra }, encoding: "utf8" }).stdout;
  assert.match(status({}), /\. 7 of 7 are trusted \(by their trust records\)\./);
  assert.match(status({ HOME: join(s.dir, "home3"), CODEX_HOME: s.codex }), /\. 0 of 7 are trusted/, "the plain form counts only when it is this home");
});

test("F-T957-18: when the dispatcher fails, the launcher refuses the gh api forms of a merge or a ref write too", (t) => {
  const s = scratch(t);
  assert.equal(s.hooks("install").status, 0);
  const root = marker(s, "0.1.0");
  writeFileSync(join(root, "hooks/dispatch.mjs"), "throw new Error('broken');\n");
  const call = (command) => s.launch("PreToolUse", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } });
  for (const command of [
    "gh api -X PUT repos/o/r/pulls/41/merge",
    "gh api repos/o/r/merges -f base=main -f head=topic",
    "gh api graphql -f query='mutation { mergePullRequest(input: {pullRequestId: \"x\"}) { clientMutationId } }'",
    "gh api graphql -f query='mutation { enablePullRequestAutoMerge(input: {pullRequestId: \"x\"}) { clientMutationId } }'",
    "gh api -X PATCH repos/o/r/git/refs/heads/main -f sha=abc",
    "gh api graphql -f query='mutation { updateRef(input: {refId: \"x\", oid: \"y\"}) { clientMutationId } }'",
    "gh api graphql -f query='mutation { createCommitOnBranch(input: {}) { clientMutationId } }'",
  ]) assert.equal(JSON.parse(call(command).stdout).hookSpecificOutput.permissionDecision, "deny", command);
  assert.equal(call("gh pr view 41").stdout, "", "a read passes");
});

test("F-T957-22: the launcher orders build metadata as Codex does: numeric parts as numbers, and none first", (t) => {
  const s = scratch(t);
  assert.equal(s.hooks("install").status, 0);
  const run = () => JSON.parse(s.launch("SubagentStop", { hook_event_name: "SubagentStop" }).stdout).version;
  marker(s, "1.0.0+build.9");
  marker(s, "1.0.0+build.10");
  marker(s, "1.0.0");
  assert.equal(run(), "1.0.0+build.10");
  marker(s, "1.0.1-rc.2");
  marker(s, "1.0.1-rc.10");
  assert.equal(run(), "1.0.1-rc.10", "a pre-release, as before");
});

test("T971: a sage marketplace pinned to one commit gets a warning in the start status and in hooks status, with the steps that end the pin", (t) => {
  const s = scratch(t);
  const root = s.version("0.1.0");
  assert.equal(s.hooks("install").status, 0);
  const config = join(s.codex, "config.toml");
  const start = { hook_event_name: "SessionStart", source: "startup", session_id: "s1", cwd: s.dir, transcript_path: join(s.dir, "none.jsonl") };
  const lines = () => [JSON.parse(s.launch("SessionStart", start).stdout).systemMessage.split("\n"), s.hooks("status", root).stdout.trimEnd().split("\n")];
  const sha = "06d98f689984132d0185ed3dff0e4171b8bd838a";
  const pin = `sage: ${config} pins the sage marketplace to the commit ${sha}, so an upgrade gets no newer sage. To get updates, the user runs in a terminal: ` +
    "codex plugin marketplace remove sage, then codex plugin marketplace add https://github.com/erickb336/sage-stack.git, then codex plugin add sage@sage. Then start a new session.";
  // The text that `codex plugin marketplace add https://github.com/erickb336/sage.git --ref <sha>` writes (Codex 0.164.0).
  const marketplace = (ref) => `[marketplaces.sage]\nsource_type = "git"\nsource = "https://github.com/erickb336/sage.git"\n${ref === undefined ? "" : `ref = ${ref}\n`}`;
  writeFileSync(config, marketplace(`"${sha}"`));
  for (const [i, found] of lines().entries()) assert.ok(found.includes(pin), `${["start status", "hooks status"][i]}: ${found.join("\n")}`);
  writeFileSync(config, `[marketplaces]\nsage = { source = "x", ref = '${sha.slice(0, 8)}' }\n`);
  assert.ok(lines()[1].includes(pin.replace(sha, sha.slice(0, 8))), "another TOML form and a short commit");
  // No pin: a ref that names a branch follows it, and a marketplace without a ref follows its default branch.
  for (const ref of ['"main"', undefined]) {
    writeFileSync(config, marketplace(ref));
    for (const found of lines()) assert.ok(!found.some((line) => line.includes("pins the sage marketplace")), String(ref));
  }
});
