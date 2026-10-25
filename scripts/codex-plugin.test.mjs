import "./test-env.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { test } from "node:test";
import { z } from "zod";
import { ROOT } from "./build.mjs";

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
  const home = mkdtempSync(join(tmpdir(), "sage-codex-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const root = join(home, "plugins/cache/sage/sage/0.1.0");
  mkdirSync(root, { recursive: true });
  cpSync(PLUGIN, root, { recursive: true });
  writeFileSync(join(home, "config.toml"), `[plugins."sage@sage"]\nenabled = true\n` +
    trust.map((key) => `\n[hooks.state."sage@sage:hooks/hooks.json:${key}"]\ntrusted_hash = "sha256:00"\n`).join(""));
  const transcript = join(home, "rollout.jsonl");
  if (cliVersion) writeFileSync(transcript, JSON.stringify({ type: "session_meta", payload: { cli_version: cliVersion } }) + "\n");
  const run = (input) => {
    const r = spawnSync("node", [join(root, "hooks/session-start-hook.mjs")], { input: JSON.stringify({ session_id: "s1", cwd: home, transcript_path: transcript, ...input }), encoding: "utf8", env: { ...process.env, CODEX_HOME: home } });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout ? JSON.parse(r.stdout) : "";
  };
  return { run };
}

const output = (text) => ({ systemMessage: text, hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text } });
const ALL = ["session_start:0:0", "session_start:1:0", "user_prompt_submit:0:0", "user_prompt_submit:1:0", "pre_tool_use:0:0", "pre_tool_use:1:0", "permission_request:0:0", "post_tool_use:0:0", "subagent_start:0:0", "subagent_stop:0:0"];

test("the SessionStart hook gives the status of a trusted install on a tested Codex", (t) => {
  const { run } = installed(t, { trust: ALL, cliVersion: "0.164.0-alpha.11.1" });
  assert.deepEqual(run({ hook_event_name: "SessionStart", source: "startup" }), output(
    "sage 0.1.0 is installed. Codex 0.164.0-alpha.11.1.\nsage hooks: all 10 trusted.\nTo start sage mode, send this message alone: sage mode"));
});

test("the SessionStart hook names hooks without trust and warns outside the tested Codex range", (t) => {
  const { run } = installed(t, { trust: ["session_start:0:0"], cliVersion: "0.165.0" });
  assert.deepEqual(run({ hook_event_name: "SessionStart", source: "resume" }), output(
    "sage 0.1.0 is installed. Codex 0.165.0.\nsage hooks: 1 of 10 trusted. Type /hooks in the Codex CLI to review the others.\n" +
    "To start sage mode, send this message alone: sage mode\nWarning: sage is tested with Codex 0.160 to 0.164, not 0.165.0. Some sage hooks may not work."));
});

test("the SessionStart hook says when it cannot read the Codex version, and ignores other events", (t) => {
  const { run } = installed(t, { trust: ALL });
  assert.deepEqual(run({ hook_event_name: "SessionStart", source: "startup" }), output(
    "sage 0.1.0 is installed. Codex version unknown.\nsage hooks: all 10 trusted.\nTo start sage mode, send this message alone: sage mode\n" +
    "Warning: sage is tested with Codex 0.160 to 0.164. Some sage hooks may not work."));
  assert.equal(run({ hook_event_name: "UserPromptSubmit", prompt: "hello" }), "");
});
