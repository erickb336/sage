import "./test-env.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { test } from "node:test";
import { z } from "zod";
import { ROOT } from "./build.mjs";
import { sessionStatus } from "../plugins/sage-codex/hooks/session-start-hook.mjs";
import { modeDirectory } from "../plugins/sage-codex/hooks/sage-codex-hook.mjs";

const json = (path) => JSON.parse(readFileSync(join(ROOT, path), "utf8"));
// A "./" path that stays inside its root (docs plugins/build.md, "Path rules" and "Marketplace metadata").
const inside = (root) => z.string().startsWith("./").refine((path) => !relative(root, resolve(root, path)).startsWith(".."), "path leaves its root");

// The marketplace format of the Codex docs (developers.openai.com/codex/plugins/build.md, "Marketplace metadata"):
// a top-level name, interface.displayName, and for each plugin a name, a local source path, both policy fields and a category.
const marketplace = z.object({
  name: z.string().min(1),
  interface: z.object({ displayName: z.string().min(1) }),
  plugins: z.array(z.object({
    name: z.string().min(1),
    source: z.object({ source: z.literal("local"), path: inside(ROOT) }),
    policy: z.object({ installation: z.enum(["AVAILABLE", "INSTALLED_BY_DEFAULT", "NOT_AVAILABLE"]), authentication: z.enum(["ON_INSTALL", "ON_USE"]) }),
    category: z.string().min(1),
  }).strict()).min(1),
}).strict();

// The .codex-plugin/plugin.json compatibility manifest: the fields of the Codex docs (plugins/build.md, "Add
// OpenAI-specific metadata"), with the name rule of agent-plugins.org/schemas/1.0.0/plugin.schema.json.
const manifest = (root) => z.object({
  name: z.string().regex(/^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/).max(64),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  description: z.string().min(1),
  author: z.object({ name: z.string(), email: z.string().optional(), url: z.string().optional() }).strict(),
  license: z.string(),
  repository: z.string().url(),
  hooks: inside(root).refine((path) => existsSync(join(root, path)), "hooks file is missing"),
  interface: z.object({
    displayName: z.string().min(1),
    shortDescription: z.string().min(1),
    developerName: z.string().min(1),
    category: z.string().min(1),
    websiteURL: z.string().url(),
  }).strict(),
}).strict();

const PLUGIN = join(ROOT, "plugins/sage-codex");

test("the sage marketplace and the Codex manifest match the documented formats", () => {
  const market = marketplace.parse(json(".agents/plugins/marketplace.json"));
  assert.equal(`${market.plugins[0].name}@${market.name}`, "sage@sage");
  assert.equal(market.plugins[0].source.path, "./plugins/sage-codex");
  const parsed = manifest(PLUGIN).parse(json("plugins/sage-codex/.codex-plugin/plugin.json"));
  assert.equal(parsed.name, market.plugins[0].name);
  // A broken manifest fails: a hooks path outside the plugin and an unknown field.
  assert.equal(manifest(PLUGIN).safeParse({ ...parsed, hooks: "../hooks.json" }).success, false);
  assert.equal(manifest(PLUGIN).safeParse({ ...parsed, agents: "./agents" }).success, false);
  assert.equal(marketplace.safeParse({ ...market, plugins: [{ ...market.plugins[0], policy: { installation: "AVAILABLE" } }] }).success, false);
});

test("each hook command runs a file of the built plugin", () => {
  const hooks = json("plugins/sage-codex/hooks/hooks.json").hooks;
  const files = Object.values(hooks).flat().flatMap((group) => group.hooks).map((hook) => /^node "\$\{PLUGIN_ROOT\}\/(.+)"$/.exec(hook.command)?.[1]);
  assert.deepEqual(files.filter((file) => !file || !existsSync(join(PLUGIN, file))), []);
  assert.equal(hooks.SessionStart[0].matcher, "startup|resume|clear");
});

/** An installed copy of the built plugin in a scratch CODEX_HOME, as `codex plugin add sage@sage` makes it. */
function installed(t, { trust = [], cliVersion } = {}) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "sage-codex-home-")));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const root = join(home, "plugins/cache/sage/sage/0.1.0");
  mkdirSync(root, { recursive: true });
  cpSync(PLUGIN, root, { recursive: true });
  writeFileSync(join(home, "config.toml"), `[plugins."sage@sage"]\nenabled = true\n` +
    trust.map((key) => `\n[hooks.state."sage@sage:hooks/hooks.json:${key}"]\ntrusted_hash = "sha256:00"\n`).join(""));
  const transcript = join(home, "rollout.jsonl");
  if (cliVersion) writeFileSync(transcript, JSON.stringify({ type: "session_meta", payload: { cli_version: cliVersion } }) + "\n");
  const { SAGE_HOME, ...inherited } = process.env;
  const run = (input) => {
    const r = spawnSync("node", [join(root, "hooks/session-start-hook.mjs")], { input: JSON.stringify({ session_id: "s1", cwd: home, transcript_path: transcript, ...input }), encoding: "utf8", env: { ...inherited, CODEX_HOME: home } });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout ? JSON.parse(r.stdout) : "";
  };
  return { run, home };
}
const { stateKey } = await import(new URL("../plugins/sage-codex/hooks/principles-hook.mjs", import.meta.url));

/** The hook's output: the status for the chief always, and a warning for the user only when there is a limit. */
const output = (status, warning) => ({ ...(warning ? { systemMessage: warning } : {}), hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: warning ? `${status}\n${warning}` : status } });
const ALL = ["session_start:0:0", "session_start:1:0", "user_prompt_submit:0:0", "user_prompt_submit:1:0", "pre_tool_use:0:0", "pre_tool_use:1:0", "permission_request:0:0", "post_tool_use:0:0", "subagent_start:0:0", "subagent_stop:0:0"];
const START = "To start sage mode, the user sends this message alone: sage mode";

// Synthetic source fixtures only. These events do not establish native desktop mapping or authorization.
function resetFixture(t) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "sage-t96-reset-")));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = { HOME: home, CODEX_HOME: home, SAGE_HOME: join(home, "mode-root") };
  const dir = modeDirectory(env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const input = { hook_event_name: "SessionStart", source: "resume", session_id: "synthetic-t96-root" };
  const file = join(dir, `${stateKey(input)}.json`);
  const options = { pluginRoot: PLUGIN, codexHome: home, env };
  const run = (fields = {}) => sessionStatus({ ...input, ...fields }, options);
  const put = (state) => writeFileSync(file, JSON.stringify(state), { mode: 0o600 });
  return { dir, file, input, options, put, run };
}

test("T96 synthetic: startup and resume clear only autopilot before status, for every prior flag", (t) => {
  const f = resetFixture(t);
  for (const source of ["startup", "resume"]) for (const sage of [false, true]) for (const autopilot of [false, true]) {
    const before = { sage, autopilot, given: true, off: "synthetic-note" };
    f.put(before);
    const result = f.run({ source });
    assert.deepEqual(JSON.parse(readFileSync(f.file, "utf8")), { ...before, autopilot: false }, `${source}, sage=${sage}, autopilot=${autopilot}`);
    assert.match(result.hookSpecificOutput.additionalContext, sage ? /sage mode is on in this session/ : /To start sage mode/);
    assert.doesNotMatch(result.systemMessage ?? "", /autopilot reset is unavailable/);
    f.run({ source });
    assert.deepEqual(JSON.parse(readFileSync(f.file, "utf8")), { ...before, autopilot: false }, "repeated reset preserves other flags");
  }
  f.put({ sage: true, autopilot: true });
  assert.throws(() => sessionStatus(f.input, { ...f.options, pluginRoot: join(f.dir, "missing-plugin") }));
  assert.deepEqual(JSON.parse(readFileSync(f.file, "utf8")), { sage: true, autopilot: false }, "reset finishes before status reads plugin metadata");
});

test("T96 synthetic: missing state is off; clear, compact, fork and other events preserve saved modes", (t) => {
  const f = resetFixture(t);
  const missing = f.run();
  assert.match(missing.hookSpecificOutput.additionalContext, /To start sage mode/);
  assert.doesNotMatch(missing.systemMessage ?? "", /autopilot reset is unavailable/);
  assert.equal(existsSync(f.file), false, "missing state needs no new mode file");
  for (const source of ["clear", "compact", "fork", "unknown"]) {
    f.put({ sage: true, autopilot: true, given: true });
    f.run({ source });
    assert.deepEqual(JSON.parse(readFileSync(f.file, "utf8")), { sage: true, autopilot: true, given: true });
  }
  assert.equal(f.run({ hook_event_name: "UserPromptSubmit" }), undefined);
  assert.deepEqual(JSON.parse(readFileSync(f.file, "utf8")), { sage: true, autopilot: true, given: true });
});

test("T96 synthetic: missing or malformed identity reports unavailable without changing any saved mode", (t) => {
  const f = resetFixture(t);
  f.put({ sage: true, autopilot: true });
  for (const fields of [{ session_id: undefined }, { session_id: null }, { session_id: 7 }, { session_id: "" }, { session_id: {} }, { agent_id: "synthetic-child" }, { agent_id: null }]) {
    const result = f.run(fields);
    assert.match(result.systemMessage, /autopilot reset is unavailable/);
    assert.match(result.hookSpecificOutput.additionalContext, /autopilot reset is unavailable/);
    assert.deepEqual(JSON.parse(readFileSync(f.file, "utf8")), { sage: true, autopilot: true });
    assert.deepEqual(readdirSync(f.dir), [f.file.slice(f.file.lastIndexOf("/") + 1)]);
  }
});

test("T96 synthetic: damaged state and reset write errors report unavailable without claiming off", (t) => {
  const f = resetFixture(t);
  for (const data of ["{", "null", '{"sage":true,"autopilot":"on"}']) {
    writeFileSync(f.file, data, { mode: 0o600 });
    const result = f.run();
    assert.match(result.systemMessage, /autopilot reset is unavailable/);
    assert.doesNotMatch(result.systemMessage, /autopilot (?:is|are|now) off/);
    assert.equal(readFileSync(f.file, "utf8"), data);
  }
  f.put({ sage: true, autopilot: true });
  chmodSync(f.dir, 0o500);
  try {
    const result = f.run();
    assert.match(result.systemMessage, /autopilot reset is unavailable/);
    assert.doesNotMatch(result.systemMessage, /autopilot (?:is|are|now) off/);
    assert.deepEqual(JSON.parse(readFileSync(f.file, "utf8")), { sage: true, autopilot: true });
  } finally { chmodSync(f.dir, 0o700); }
});

test("the SessionStart hook gives a trusted install on a tested Codex no warning: the status goes to the chief only (R1665-3)", (t) => {
  const { run } = installed(t, { trust: ALL, cliVersion: "0.164.0" });
  for (const source of ["startup", "resume", "clear"]) {
    assert.deepEqual(run({ hook_event_name: "SessionStart", source }), output(`sage 0.1.0 is installed. Codex 0.164.0. sage hooks: 10 of 10 have a trust record (Codex checks each hash).\n${START}`), source);
  }
  assert.deepEqual(installed(t, { trust: ALL, cliVersion: "0.160.0" }).run({ hook_event_name: "SessionStart", source: "startup" }), output(`sage 0.1.0 is installed. Codex 0.160.0. sage hooks: 10 of 10 have a trust record (Codex checks each hash).\n${START}`));
});

test("the SessionStart hook warns the user for hooks without trust and outside the tested Codex range", (t) => {
  const { run } = installed(t, { trust: ["session_start:0:0"], cliVersion: "0.167.0" });
  assert.deepEqual(run({ hook_event_name: "SessionStart", source: "resume" }), output(`sage 0.1.0 is installed. Codex 0.167.0. sage hooks: 1 of 10 have a trust record (Codex checks each hash).\n${START}`,
    "sage: 9 of the 10 sage hooks are not trusted yet, so some sage rules do not run. To trust them, type /hooks in the Codex CLI.\n" +
    "sage: this is Codex 0.167.0, and sage is tested only with Codex 0.160 to 0.166. Some sage rules may not run."));
});

test("on resume of a session over Node's string limit, the SessionStart hook still reads the Codex version (F-T473-1)", (t) => {
  const { run, home } = installed(t, { trust: ALL, cliVersion: "0.164.0" });
  truncateSync(join(home, "rollout.jsonl"), 600 * 2 ** 20); // sparse: the 600 MiB after the first line cost no disk
  assert.deepEqual(run({ hook_event_name: "SessionStart", source: "resume" }), output(`sage 0.1.0 is installed. Codex 0.164.0. sage hooks: 10 of 10 have a trust record (Codex checks each hash).\n${START}`));
});

test("the SessionStart hook says when it cannot read the Codex version, and ignores other events", (t) => {
  const { run } = installed(t, { trust: ALL });
  assert.deepEqual(run({ hook_event_name: "SessionStart", source: "startup" }), output(`sage 0.1.0 is installed. Codex version unknown. sage hooks: 10 of 10 have a trust record (Codex checks each hash).\n${START}`,
    "sage: the hook could not read the Codex version, and sage is tested only with Codex 0.160 to 0.166. Some sage rules may not run."));
  assert.equal(run({ hook_event_name: "UserPromptSubmit", prompt: "hello" }), "");
});

test("on resume with sage mode on, the hook process resets autopilot and keeps sage mode in its status (R1663-3, T96; synthetic)", (t) => {
  const { run, home } = installed(t, { trust: ALL, cliVersion: "0.164.0" });
  const folder = join(home, "sage/.hooks/codex");
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  writeFileSync(join(folder, `${stateKey({ session_id: "s1" })}.json`), JSON.stringify({ sage: true, autopilot: true, given: true }), { mode: 0o600 });
  assert.deepEqual(run({ hook_event_name: "SessionStart", source: "resume" }), output("sage 0.1.0 is installed. Codex 0.164.0. sage hooks: 10 of 10 have a trust record (Codex checks each hash).\nsage mode is on in this session."));
  assert.deepEqual(JSON.parse(readFileSync(join(folder, `${stateKey({ session_id: "s1" })}.json`), "utf8")), { sage: true, autopilot: false, given: true });
  writeFileSync(join(folder, `${stateKey({ session_id: "s1" })}.json`), JSON.stringify({ sage: false, autopilot: false }), { mode: 0o600 });
  assert.deepEqual(run({ hook_event_name: "SessionStart", source: "resume" }), output(`sage 0.1.0 is installed. Codex 0.164.0. sage hooks: 10 of 10 have a trust record (Codex checks each hash).\n${START}`));
});

test("the Codex guide carries the owner's lines for install, trust, removal, the tools and the push limit (R1670, R1671-1, R1671-3, R1665-8)", () => {
  const guide = readFileSync(join(ROOT, "docs/guide/codex.md"), "utf8").replace(/\s+/g, " ");
  for (const line of [
    "To get it, run `npm install -g @openai/codex@0.164.0`.", // R1670-3
    "one tool for each command of the state tool that the chief uses.", // R1665-8, R1670-2
    "A reviewer's commit through these forms can also be pushed to the task's branch. Read the branch's commits before a merge, or keep autopilot off for such a task.", // R1670-6
    "when no sage hook is trusted, no sage hook runs, so you see no sage line at all, also no warning. If sage mode does not start, type `/hooks` in the Codex CLI", // R1671-1
    "Codex keeps the trust records of the sage hooks in your Codex config", // R1671-3
    "sage: this is Codex 0.167.0, and sage is tested only with Codex 0.160 to 0.166. Some sage rules may not run.", // R1670-7
    "Codex 0.164.0 runs no hook for text that an agent types into a shell that still runs (`write_stdin`, for example after `zsh -i`). That text passes every sage rule", // R1675-2
  ]) assert.ok(guide.includes(line), line);
  assert.match(readFileSync(join(ROOT, "CHANGELOG.md"), "utf8"), /- A limit: Codex 0\.164\.0 runs no hook for text that an agent types into a shell that still runs \(`write_stdin`\)/, "R1675-2");
  assert.doesNotMatch(guide, /the chief and the leads use/);
  // R1670-8: the README's limits table is gone (T521); the Codex guide's rules table keeps these stops.
  for (const rule of ["| The chief and a lead record the logbook |", "| A role agent starts no agents |", "| No agent runs Codex from the shell |"]) assert.ok(guide.includes(rule), `R1670-8: ${rule}`);
});

test("T470: the Codex guide, the README and the CHANGELOG carry the owner's copy before the pilot", () => {
  const flat = (path) => readFileSync(join(ROOT, path), "utf8").replace(/\s+/g, " ");
  const texts = { guide: flat("docs/guide/codex.md"), readme: flat("README.md"), changelog: flat("CHANGELOG.md") };
  const lines = {
    guide: [
      "Codex 0.164.0 runs no hook for text that an agent types into a shell that still runs (`write_stdin`, for example after `zsh -i`). That text passes every sage rule, also a push or a merge. Autopilot off does not stop such a merge.", // F-T470-13
      "- In workspace-write, the sandbox keeps this text off the network and keeps the logbook and the sessions folder closed. Keep network access off for the session (`[sandbox_workspace_write] network_access = false`, the default). When Codex asks to run an interactive shell (for example `zsh -i`) outside the sandbox, refuse.", // F-T470-13
      "- `gh`, logged in (`gh auth login`), and a GitHub remote for the project. sage uses them for pull requests and the merge check; without them, work stops at a verified branch and autopilot merges nothing.", // F-T470-15
      "Codex's review thread runs in the chief's session and has no agent id, but its record names a review source |", // F-T470-1, a table cell
      "If an agent says that the hook could not read Codex's record of its thread, start a new session in the project folder. If it happens again, report it with your Codex version.", // F-T470-2
      "4. Send the on phrase alone (see [Turn on sage mode](#turn-on-sage-mode)). When all is well, you see no sage line", // F-T470-8
      "To stop merges at once, press Esc to stop Codex's turn, then send the off phrase for autopilot alone.", // F-T470-9
      "For a local clone, run `git pull` in the clone instead of the upgrade command.", // F-T470-12
      "The Codex logbook in `~/.codex/sage` stays; delete that folder yourself to remove it.", // F-T470-12
      "- Under full access (`danger-full-access`), sage mode gives no guarantee", // F-T470-14: in the guide since the README's limits table went (T521)
    ],
    readme: [
      "**sage is a Claude Code and Codex plugin for developers who", // F-T470-11
      "the lead has source tests but no real run yet, and the board phrases do not work there yet ([sage in Codex](docs/guide/codex.md))", // F-T470-11
      "You also need Node.js 20 or later, `gh` logged in, and a GitHub remote for the project (see [What you need](docs/guide/codex.md#what-you-need)).", // F-T470-15, T467
    ],
    changelog: [
      "and a command such as `$EDITOR codex/a.txt` runs, except for a role agent while the mode is on.", // F-T470-3
      "so that text passes every sage rule, also a push or a merge. In workspace-write, the sandbox keeps this text off the network and keeps the logbook closed: keep network access off, and refuse an interactive shell outside the sandbox. Autopilot off does not stop such a merge.", // F-T470-13
    ],
  };
  const missing = Object.entries(lines).flatMap(([name, list]) => list.filter((line) => !texts[name].includes(line)).map((line) => `${name}: ${line}`));
  assert.deepEqual(missing, []);
  const wrong = { // the old lines, which misled
    "guide: autopilot off as a mitigation of write_stdin": /network access off for role agents, or keep autopilot off/.test(texts.guide),
    "guide: step 4 says any message": /4\. Send a message\./.test(texts.guide),
    "CHANGELOG: outside sage mode only": /and outside sage mode a command such as/.test(texts.changelog),
    "README: a Claude Code plugin only": /sage is a Claude Code plugin for developers/.test(texts.readme),
  };
  assert.deepEqual(Object.entries(wrong).filter(([, found]) => found).map(([name]) => name), []);
});
