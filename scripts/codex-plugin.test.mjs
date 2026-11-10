import "./test-env.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { z } from "zod";
import { ROOT } from "./build.mjs";
import { sessionStatus } from "../plugins/sage-codex/hooks/session-start-hook.mjs";
import { modeDirectory, answer } from "../plugins/sage-codex/hooks/sage-codex-hook.mjs";
import { readMode, gate } from "../plugins/sage-codex/hooks/gate-hook.mjs";

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
  // A broken manifest fails: plugin hooks (T957: sage's hooks are the user's entries) and an unknown field.
  assert.equal(manifest(PLUGIN).safeParse({ ...parsed, hooks: "./hooks/hooks.json" }).success, false);
  assert.equal(manifest(PLUGIN).safeParse({ ...parsed, agents: "./agents" }).success, false);
  assert.equal(marketplace.safeParse({ ...market, plugins: [{ ...market.plugins[0], policy: { installation: "AVAILABLE" } }] }).success, false);
});

/**
 * An installed copy of the built plugin in a scratch CODEX_HOME, as `codex plugin add sage@sage` makes it, with sage's
 * entries from `hooks install` (T957). run sends one event through the installed launcher, as Codex runs the entry.
 */
function installed(t, { trust = [], cliVersion, threads = "[agents]\nmax_concurrent_threads_per_session = 10\n" } = {}) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "sage-codex-home-")));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const root = join(home, "plugins/cache/sage/sage/0.1.0");
  mkdirSync(root, { recursive: true });
  cpSync(PLUGIN, root, { recursive: true });
  writeFileSync(join(home, "config.toml"), `${threads}[plugins."sage@sage"]\nenabled = true\n` +
    trust.map((key) => `\n[hooks.state."${join(home, "hooks.json")}:${key}"]\ntrusted_hash = "sha256:00"\n`).join(""));
  const transcript = join(home, "rollout.jsonl");
  if (cliVersion) writeFileSync(transcript, JSON.stringify({ type: "session_meta", payload: { cli_version: cliVersion } }) + "\n");
  const { SAGE_HOME, ...inherited } = process.env;
  const env = { ...inherited, HOME: home, CODEX_HOME: home };
  const install = spawnSync(process.execPath, [join(root, "skills/sage/sage.mjs"), "hooks", "install"], { encoding: "utf8", env });
  assert.equal(install.status, 0, install.stderr);
  const run = (input) => {
    const r = spawnSync(process.execPath, [join(home, "sage-hooks/launch.mjs"), input.hook_event_name], { input: JSON.stringify({ session_id: "s1", cwd: home, transcript_path: transcript, ...input }), encoding: "utf8", env });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout ? JSON.parse(r.stdout) : "";
  };
  return { run, home };
}
const { stateKey } = await import(new URL("../plugins/sage-codex/hooks/hook-state.mjs", import.meta.url));

/** The hook's output: the status for the chief always, and a warning for the user only when there is a limit. */
const output = (status, warning) => ({ ...(warning ? { systemMessage: warning } : {}), hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: `${status}\nAutopilot is off at each start of a session. To turn it on, the user sends "autopilot on" alone, while sage mode is on.${warning ? `\n${warning}` : ""}` } });
const ALL = ["session_start:0:0", "user_prompt_submit:0:0", "pre_tool_use:0:0", "permission_request:0:0", "post_tool_use:0:0", "subagent_start:0:0", "subagent_stop:0:0"];
const START = "To start sage mode, the user sends this message alone: sage mode";
const RESET = /could not turn autopilot off in the saved mode of this session\. Autopilot still merges nothing until the owner sends "autopilot on" again in this session\./;

test("T677 lifecycle: startup and resume turn autopilot off in the mode file; a failed reset says that merges still wait", async (t) => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "sage-t115-reset-")));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = { HOME: home, CODEX_HOME: home, SAGE_HOME: join(home, "mode-root") };
  const dir = modeDirectory(env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const input = { hook_event_name: "SessionStart", source: "resume", session_id: "synthetic-t115-root" };
  const file = join(dir, `${stateKey(input)}.json`);
  const options = { pluginRoot: join(ROOT, "plugins/sage-codex"), codexHome: home, env };
  const before = { sage: true, autopilot: true, given: true, off: "legacy" };
  const put = () => writeFileSync(file, JSON.stringify(before), { mode: 0o600 });
  // The gh merge form never runs, in any state: only sage's merge command merges (codex-autopilot-gate.test.mjs).
  const refusal = async () => {
    for (const extra of [{}, { agent_id: "child" }]) {
      const result = await gate({ ...input, ...extra, hook_event_name: "PreToolUse", tool_name: "Bash", cwd: home,
        tool_input: { command: `gh pr merge 41 --squash --delete-branch --match-head-commit ${"a".repeat(40)}` } }, { env });
      assert.equal(result.hookSpecificOutput.permissionDecision, "deny");
      assert.match(result.hookSpecificOutput.permissionDecisionReason, /^sage: in Codex, only sage's merge command merges/);
    }
  };
  for (const source of ["startup", "resume", "compact", "fork"]) {
    put();
    assert.deepEqual(readMode({ session: input.session_id }, env), { sage: true, autopilot: true }, source);
    await refusal();
    const result = sessionStatus({ ...input, source }, options);
    assert.match(result.hookSpecificOutput.additionalContext, /Autopilot is off at each start of a session\./);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { ...before, autopilot: !["startup", "resume"].includes(source) });
    await refusal();
  }
  put();
  assert.throws(() => sessionStatus(input, { ...options, pluginRoot: join(home, "missing") }));
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { ...before, autopilot: false }, "reset precedes status metadata reads");
  put();
  chmodSync(dir, 0o500);
  try {
    assert.match(sessionStatus(input, options).systemMessage, RESET);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), before, "failed reset does not claim to save");
    // The off phrase that the hook cannot save: one line, and no block (Codex's record still has the off).
    const failure = answer({ ...input, hook_event_name: "UserPromptSubmit", prompt: "autopilot off" }, env);
    assert.match(failure.systemMessage, /could not read or save/);
    assert.equal(failure.decision, undefined);
    await refusal();
  } finally { chmodSync(dir, 0o700); }
  for (const data of ["{", "null", '{"sage":true,"autopilot":"on"}']) {
    writeFileSync(file, data);
    assert.match(sessionStatus(input, options).systemMessage, RESET);
    assert.equal(readFileSync(file, "utf8"), data);
    assert.deepEqual(readMode({ session: input.session_id }, env), { sage: false, autopilot: false });
  }
});

test("the SessionStart hook gives a trusted install on a tested Codex no warning: the status goes to the chief only (R1665-3)", (t) => {
  const { run } = installed(t, { trust: ALL, cliVersion: "0.164.0" });
  for (const source of ["startup", "resume", "clear"]) {
    assert.deepEqual(run({ hook_event_name: "SessionStart", source }), output(`sage 0.1.0 is installed. Codex 0.164.0. sage hooks: 7 of 7 are trusted (by their trust records; Codex checks each hash).\n${START}`), source);
  }
  // F-T677-20: the tested range, 0.164 to 0.167, also holds the desktop app's 0.167.0-alpha.3.2.
  for (const version of ["0.167.0", "0.167.0-alpha.3.2"]) {
    assert.deepEqual(installed(t, { trust: ALL, cliVersion: version }).run({ hook_event_name: "SessionStart", source: "startup" }), output(`sage 0.1.0 is installed. Codex ${version}. sage hooks: 7 of 7 are trusted (by their trust records; Codex checks each hash).\n${START}`), version);
  }
});

test("the SessionStart hook warns the user for hooks without trust and outside the tested Codex range", (t) => {
  const { run } = installed(t, { trust: ["session_start:0:0"], cliVersion: "0.168.0" });
  assert.deepEqual(run({ hook_event_name: "SessionStart", source: "resume" }), output(`sage 0.1.0 is installed. Codex 0.168.0. sage hooks: 1 of 7 are trusted (by their trust records; Codex checks each hash).\n${START}`,
    "sage: 6 of the 7 sage hooks are not trusted or turned off, so they do not run. To trust them or turn them on, type /hooks in the Codex CLI.\n" +
    "sage: sage was not tested with Codex 0.168.0, so some sage rules may not run. Autopilot merges in Codex 0.164 and later."));
  assert.match(installed(t, { trust: ALL, cliVersion: "0.163.0" }).run({ hook_event_name: "SessionStart", source: "startup" }).systemMessage, /^sage: sage was not tested with Codex 0\.163\.0, so some sage rules may not run\. Autopilot merges in Codex 0\.164 and later\.$/);
});

test("on resume of a session over Node's string limit, the SessionStart hook still reads the Codex version (F-T473-1)", (t) => {
  const { run, home } = installed(t, { trust: ALL, cliVersion: "0.164.0" });
  truncateSync(join(home, "rollout.jsonl"), 600 * 2 ** 20); // sparse: the 600 MiB after the first line cost no disk
  assert.deepEqual(run({ hook_event_name: "SessionStart", source: "resume" }), output(`sage 0.1.0 is installed. Codex 0.164.0. sage hooks: 7 of 7 are trusted (by their trust records; Codex checks each hash).\n${START}`));
});

test("T952: the SessionStart hook warns when Codex's thread limit runs fewer agents than the project's agent cap, and names the setting to change", (t) => {
  const warning = (threads, files = {}, folder = "") => {
    const { run, home } = installed(t, { trust: ALL, cliVersion: "0.164.0", threads });
    for (const [path, text] of Object.entries(typeof files === "function" ? files(basename(home).toLowerCase().replace(/[^a-z0-9]+/g, "-")) : files)) { mkdirSync(join(home, path, ".."), { recursive: true }); writeFileSync(join(home, path), text); }
    return [run({ hook_event_name: "SessionStart", source: "startup", cwd: join(home, folder) }).systemMessage, join(home, "config.toml"), home];
  };
  // No setting: Codex's default of 4 threads holds the chief and 3 agents, below the default cap of 10.
  const [none, file] = warning("");
  assert.equal(none, `sage: Codex runs at most 3 agents at once in this session (Codex's default of 4 threads, the chief's own included), and this project's agent cap is 10 (max_agents, or cap.<project>). An agent over Codex's limit fails to start with "agent thread limit reached". To raise it, set max_concurrent_threads_per_session = 10 under [agents] in ${file}, then start a new session. sage reads only ${file} and the project's .codex/config.toml (it counts that file only where it lowers the limit, because Codex skips it in a project that Codex does not trust), not a -c override, a profile or a managed config.`);
  // Only the agents key: it counts the agents alone, and its alias max_threads reads the same.
  for (const threads of ["[agents]\nmax_concurrent_threads_per_session = 6\n", "[agents]\nmax_threads = 6 # an alias\n", "agents.max_concurrent_threads_per_session = 6\n", "agents = { max_concurrent_threads_per_session = 6 }\n"]) {
    assert.match(warning(threads)[0], /^sage: Codex runs at most 6 agents at once in this session \(agents\.max_concurrent_threads_per_session = 6\), and this project's agent cap is 10 .* set max_concurrent_threads_per_session = 10 under \[agents\] in /, threads);
  }
  // The features.multi_agent_v2 key wins over the agents key, and counts the chief's own thread: 10 threads hold 9 agents.
  for (const threads of ["[agents]\nmax_concurrent_threads_per_session = 20\n[features.multi_agent_v2]\nenabled = true\nmax_concurrent_threads_per_session = 10\n", "[agents]\nmax_concurrent_threads_per_session = 20\n[features]\nmulti_agent_v2 = { enabled = true, max_concurrent_threads_per_session = 10 }\n",
    "agents = { max_concurrent_threads_per_session = 20 }\nfeatures = { multi_agent_v2 = { enabled = true, max_concurrent_threads_per_session = 10 } }\n"]) { // an inline table in an inline table (F-T952-3)
    assert.match(warning(threads)[0], /^sage: Codex runs at most 9 agents at once in this session \(features\.multi_agent_v2\.max_concurrent_threads_per_session = 10, which counts the chief's own thread\), and this project's agent cap is 10 .* set max_concurrent_threads_per_session = 11 under \[features\.multi_agent_v2\] in /, threads);
  }
  // A high enough value: no warning, and the status goes to the chief only.
  for (const threads of ["[agents]\nmax_concurrent_threads_per_session = 10\n", "[agents]\nmax_concurrent_threads_per_session = 2\n[features.multi_agent_v2]\nenabled = true\nmax_concurrent_threads_per_session = 11\n", "[features]\nmulti_agent_v2 = true\n[agents]\nmax_concurrent_threads_per_session = 12\n"]) {
    assert.equal(warning(threads)[0], undefined, threads);
  }
  // The cap is sage's own: a lower max_agents needs fewer agents, and the project's cap.<project> wins over it.
  assert.equal(warning("", { "sage/config.json": JSON.stringify({ max_agents: 3 }) })[0], undefined, "3 agents fit in Codex's default");
  const project = (name) => ({ "sage/config.json": JSON.stringify({ max_agents: 3, [`cap.${name}`]: 5 }) }); // the project is the session's folder
  assert.match(warning("[agents]\nmax_concurrent_threads_per_session = 4\n", project)[0] ?? "", /at most 4 agents .* this project's agent cap is 5 /);

  // TOML's other integer forms read as their number (F-T952-5): 1_0 and +10 are 10.
  for (const value of ["1_0", "+10", "+1_0"]) assert.equal(warning(`[agents]\nmax_concurrent_threads_per_session = ${value}\n`)[0], undefined, value);
  for (const value of ["1__0", "10_", "_10", "0_6"]) assert.match(warning(`[agents]\nmax_concurrent_threads_per_session = ${value}\n`)[0] ?? "", /at most 3 agents /, `${value} is not a TOML integer`);

  // Codex runs multi-agent v2 for sure only when features.multi_agent_v2 is turned on (F-T952-10). Else the model may run
  // v1, whose limit is the agents key or 6 agents, so the lower limit counts, and the line to change is the agents key.
  for (const off of ["enabled = false\n", ""]) {
    assert.match(warning(`[features.multi_agent_v2]\n${off}max_concurrent_threads_per_session = 11\n`)[0] ?? "", /^sage: Codex runs at most 6 agents at once in this session \(Codex's default of 6 agents in multi-agent v1, .* set max_concurrent_threads_per_session = 10 under \[agents\] in /, off);
    assert.equal(warning(`[features.multi_agent_v2]\n${off}max_concurrent_threads_per_session = 11\n[agents]\nmax_concurrent_threads_per_session = 10\n`)[0], undefined, `${off}: both limits hold 10 agents`);
    assert.match(warning(`[agents]\nmax_concurrent_threads_per_session = 20\n[features.multi_agent_v2]\n${off}max_concurrent_threads_per_session = 5\n`)[0] ?? "", /at most 4 agents .*features\.multi_agent_v2\.max_concurrent_threads_per_session = 5/, `${off}: the v2 limit still counts when it is the lower`);
  }
  for (const on of ["[features.multi_agent_v2]\nenabled = true\nmax_concurrent_threads_per_session = 11\n", "[features]\nmulti_agent_v2 = { enabled = true, max_concurrent_threads_per_session = 11 }\n"]) assert.equal(warning(on)[0], undefined, on);
});

test("F-T952-2: the thread warning also reads the project's .codex/config.toml, from the project root to the session's folder, and counts it only where it lowers the limit", (t) => {
  const warning = (threads, files, folder = "") => {
    const { run, home } = installed(t, { trust: ALL, cliVersion: "0.164.0", threads });
    for (const [path, text] of Object.entries(files)) { mkdirSync(join(home, path, ".."), { recursive: true }); writeFileSync(join(home, path), text); }
    return { said: run({ hook_event_name: "SessionStart", source: "startup", cwd: join(home, folder) }).systemMessage, home };
  };
  const TEN = "[agents]\nmax_concurrent_threads_per_session = 10\n", FOUR = "[agents]\nmax_concurrent_threads_per_session = 4\n";
  // A project's file that lowers the limit warns, and names that file as the place to change.
  const lower = warning(TEN, { ".codex/config.toml": FOUR });
  assert.match(lower.said ?? "", /^sage: Codex runs at most 4 agents .* under \[agents\] in /);
  assert.ok(lower.said.includes(`in ${join(lower.home, ".codex/config.toml")}, then`), lower.said);
  assert.match(lower.said, /not a -c override, a profile or a managed config\.$/, "the warning says what it does not see");
  // In a git project, each .codex folder from the project root down to the session's folder counts, the nearest last.
  assert.match(warning(TEN, { "repo/.git/HEAD": "ref: refs/heads/main\n", "repo/.codex/config.toml": FOUR }, "repo/src").said ?? "", /at most 4 agents /, "the project root's file");
  assert.match(warning(TEN, { "repo/.git/HEAD": "ref: refs/heads/main\n", "repo/.codex/config.toml": TEN, "repo/src/.codex/config.toml": FOUR }, "repo/src").said ?? "", /at most 4 agents /, "a nearer file wins");
  assert.equal(warning(TEN, { "repo/.git/HEAD": "ref: refs/heads/main\n", ".codex/config.toml": FOUR }, "repo/src").said, undefined, "a .codex folder above the project root is not the project's");
  // A project's file that raises the limit does not hide the user's lower one: Codex skips it in an untrusted project.
  const raise = warning(FOUR, { ".codex/config.toml": TEN });
  assert.match(raise.said ?? "", /at most 4 agents /);
  assert.ok(raise.said.includes(`in ${join(raise.home, "config.toml")}, then`), raise.said);
});

test("the SessionStart hook says when it cannot read the Codex version, and ignores other events", (t) => {
  const { run } = installed(t, { trust: ALL });
  assert.deepEqual(run({ hook_event_name: "SessionStart", source: "startup" }), output(`sage 0.1.0 is installed. Codex version unknown. sage hooks: 7 of 7 are trusted (by their trust records; Codex checks each hash).\n${START}`,
    "sage: the hook could not read the Codex version, so some sage rules may not run. Autopilot merges in Codex 0.164 and later."));
  assert.equal(run({ hook_event_name: "UserPromptSubmit", prompt: "hello" }), "");
});

test("on resume with sage mode on, the status says that sage mode is on, not how to start it (R1663-3)", (t) => {
  const { run, home } = installed(t, { trust: ALL, cliVersion: "0.164.0" });
  const folder = join(home, "sage/.hooks/codex");
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  writeFileSync(join(folder, `${stateKey({ session_id: "s1" })}.json`), JSON.stringify({ sage: true, autopilot: false, given: true }), { mode: 0o600 });
  assert.deepEqual(run({ hook_event_name: "SessionStart", source: "resume" }), output("sage 0.1.0 is installed. Codex 0.164.0. sage hooks: 7 of 7 are trusted (by their trust records; Codex checks each hash).\nsage mode is on in this session."));
  writeFileSync(join(folder, `${stateKey({ session_id: "s1" })}.json`), JSON.stringify({ sage: false, autopilot: false }), { mode: 0o600 });
  assert.deepEqual(run({ hook_event_name: "SessionStart", source: "resume" }), output(`sage 0.1.0 is installed. Codex 0.164.0. sage hooks: 7 of 7 are trusted (by their trust records; Codex checks each hash).\n${START}`));
});

test("the Codex guide carries the owner's lines for install, trust, removal, the tools and the push limit (R1670, R1671-1, R1671-3, R1665-8)", () => {
  const guide = readFileSync(join(ROOT, "docs/guide/codex.md"), "utf8").replace(/\s+/g, " ");
  for (const line of [
    "To get it, run `npm install -g @openai/codex@0.164.0`.", // R1670-3
    "one tool for each command of the state tool that the chief uses.", // R1665-8, R1670-2
    "A reviewer's commit through these forms can also be pushed to the task's branch. Read the branch's commits before a merge, or keep autopilot off for such a task.", // R1670-6
    "when no sage hook is trusted, no sage hook runs, so you see no sage line at all, also no warning. If sage mode does not start, type `/hooks` in the Codex CLI", // R1671-1
    "Codex keeps the trust records of the sage hooks in your Codex config", // R1671-3
    "An update needs no new trust. Codex trusts each sage entry of your hooks file by its text and its place, not by sage's files", // T957
    "It removes the 7 sage entries from your hooks file and the `~/.codex/sage-hooks` folder. Your own hooks stay.", // T957
    "sage: sage was not tested with Codex 0.168.0, so some sage rules may not run. Autopilot merges in Codex 0.164 and later.", // R1670-7, F-T677-20, F-T951-2, F-T951-3
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
      "- `gh`, logged in (`gh auth login`), and a GitHub remote for the project. sage uses them for pull requests and the merge check; without them, work stops at a verified branch.", // F-T470-15
      "Codex's review thread runs in the chief's session and has no agent id, but its record names a review source |", // F-T470-1, a table cell
      "If an agent says that the hook could not read Codex's record of its thread, start a new session in the project folder. If it happens again, report it with your Codex version.", // F-T470-2
      "4. Send the on phrase alone (see [Turn on sage mode](#turn-on-sage-mode)). When all is well, you see no sage line", // F-T470-8
      "Send an on phrase when Codex is idle. An off phrase works at any time", // F-T470-9, F-T677-6
      "| Press Esc | The merge stops at once, unless its call to GitHub has started: that merge completes. Autopilot stays on: to stop later merges, send the off phrase. |", // T677, F-T677-5
      "| Send `autopilot off` with Enter while Codex works | No merge starts from Codex's next step on.", // T677
      "| Queue `autopilot off` with Tab | It waits until the turn ends.", // T677
      "The off phrase always counts, and nothing blocks it", // T677
      "For a local clone, run `git pull` in the clone instead of the upgrade command.", // F-T470-12
      "The Codex logbook in `~/.codex/sage` stays; delete that folder yourself to remove it.", // F-T470-12
      "- Under full access (`danger-full-access`), sage mode gives no guarantee", // F-T470-14: in the guide since the README's limits table went (T521)
    ],
    readme: [
      "**sage-stack is a multi-agent development stack for Claude Code and Codex", // F-T470-11, T942
      "in Codex (the CLI and the desktop app), sage mode, autopilot, the shared logbook and the board phrases work through the sage plugin ([sage in Codex](docs/guide/codex.md))", // F-T470-11, T905, T921
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
