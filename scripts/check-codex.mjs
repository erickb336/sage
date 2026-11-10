// The native packaging check, in a scratch HOME and CODEX_HOME that it deletes at the end: no model turn, and no write
// outside that folder. SAGE_CODEX_BIN names the codex binary, for example the desktop app's own (default: codex on PATH).
//   1. plugin/read finds every sage skill and no plugin hook (T957: sage's hooks are the user's entries).
//   2. sage's `hooks install` puts its entries in the scratch hooks.json; hooks/list shows the 7 as user hooks.
//   3. config/batchWrite trusts them, as the app's hook review does; then an update swaps the plugin's version folder,
//      and hooks/list must still show each sage entry as trusted, with the same key and hash.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT } from "./build.mjs";
import { waitNative } from "./wait-child.mjs";
import { EVENTS, install } from "../plugins/sage-codex/hooks/entries.mjs";

const PLUGIN = join(ROOT, "plugins/sage-codex");
// Codex names each event in camel case.
const sageEvents = Object.keys(EVENTS).map((event) => event[0].toLowerCase() + event.slice(1)).sort();
const binary = process.env.SAGE_CODEX_BIN ?? "codex";
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "sage-codex-check-")));
const codexHome = join(scratch, "codex-home"), project = join(scratch, "project");
const cache = join(codexHome, "plugins/cache/sage/sage");
mkdirSync(project, { recursive: true });
mkdirSync(cache, { recursive: true });
cpSync(PLUGIN, join(cache, "0.1.0"), { recursive: true });
writeFileSync(join(codexHome, "config.toml"), '[plugins."sage@sage"]\nenabled = true\n');
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("CODEX_FLORA_CCA_") && !["CODEX_EXEC_SERVER_REMOTE", "CODEX_SESSION_ID", "CODEX_THREAD_ID", "CODEX_ENVIRONMENT_ID"].includes(key))),
  HOME: scratch, CODEX_HOME: codexHome, DO_NOT_TRACK: "1" };

try {
  const versionChild = spawn(binary, ["--version"], { env, stdio: ["pipe", "pipe", "pipe"] });
  let version = "";
  versionChild.stdout.on("data", data => { version = (version + data).slice(0, 200); });
  versionChild.stderr.resume();
  versionChild.stdin.on("error", () => {});
  const versionClosed = waitNative(versionChild, { deadlineMs: 5000 });
  versionChild.stdin.end();
  const versionResult = await versionClosed;
  version = version.trim();
  if (versionResult.code !== 0 || !/^codex-cli \d+\.\d+\.\d+(?:[-+.][A-Za-z0-9.-]+)?$/.test(version)) {
    console.error("Codex package check failed: version discovery or graceful closure failed");
    process.exitCode = 1;
  } else {
    install(codexHome);
    const child = spawn(binary, ["app-server", "-c", 'cli_auth_credentials_store="ephemeral"', "-c", "features.remote_plugins=false", "-c", "features.plugin_hooks=true", "-c", "features.codex_hooks=true"], { env, stdio: ["pipe", "pipe", "pipe"] });
    const send = (method, params, id) => child.stdin.write(JSON.stringify({ method, params, ...(id === undefined ? {} : { id }) }) + "\n");
    let buffer = "";
    let finished = false;
    let failure;
    let discovered = 0, before;
    const finish = (error) => {
      if (error) failure ??= error;
      if (finished) return;
      finished = true;
      child.stdin.end();
    };
    /** sage's entries in one hooks/list reply: each with its event, key, hash, source and trust. */
    const sageHooks = (result) => result.data[0].hooks.filter((hook) => /sage-hooks\/launch\.mjs/.test(hook.command ?? ""))
      .map(({ eventName, key, currentHash, source, trustStatus, matcher }) => ({ eventName, key, currentHash, source, trustStatus, matcher }));
    child.stderr.resume();
    const closed = waitNative(child, { deadlineMs: 25000,
      onTimeout: () => finish(new Error("the app server timed out; native discovery is unverified")),
    });
    child.on("error", finish);
    child.stdin.on("error", finish);
    child.stdout.on("data", (data) => {
      if (finished) return;
      buffer += data.toString();
      if (buffer.length > 2 * 1024 * 1024) return finish(new Error("app server output exceeded the check's limit"));
      while (!finished && buffer.includes("\n")) {
        const end = buffer.indexOf("\n");
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        try {
          const reply = JSON.parse(line);
          if (![1, 2, 3, 4, 5].includes(reply.id)) continue;
          if (reply.error) throw new Error(reply.error.message);
          if (reply.id === 1) {
            send("initialized", {});
            send("plugin/read", { marketplacePath: join(ROOT, ".agents/plugins/marketplace.json"), pluginName: "sage" }, 2);
          } else if (reply.id === 2) {
            const plugin = reply.result.plugin;
            const expected = readdirSync(join(PLUGIN, "skills")).map((name) => `sage:${name}`).sort();
            assert.deepEqual(plugin.skills.map((skill) => skill.name).sort(), expected);
            assert.deepEqual(plugin.hooks, [], "the plugin declares no hooks, so no sage hook runs twice");
            assert.equal(plugin.summary.source.path, PLUGIN);
            discovered = expected.length;
            send("hooks/list", { cwds: [project] }, 3);
          } else if (reply.id === 3) {
            before = sageHooks(reply.result);
            assert.deepEqual(before.map((hook) => hook.eventName).sort(), sageEvents);
            assert.ok(before.every((hook) => hook.source === "user" && hook.trustStatus === "untrusted" && hook.matcher === null), JSON.stringify(before));
            send("config/batchWrite", { edits: [{ keyPath: "hooks.state", value: Object.fromEntries(before.map((hook) => [hook.key, { trusted_hash: hook.currentHash }])), mergeStrategy: "upsert" }], reloadUserConfig: true }, 4);
          } else if (reply.id === 4) {
            // An update of sage: a new version folder with changed files, and the old one gone.
            renameSync(join(cache, "0.1.0"), join(cache, "0.2.0"));
            const manifest = join(cache, "0.2.0/.codex-plugin/plugin.json");
            writeFileSync(manifest, JSON.stringify({ ...JSON.parse(readFileSync(manifest, "utf8")), version: "0.2.0" }));
            writeFileSync(join(cache, "0.2.0/hooks/gate-hook.mjs"), "// an update\n" + readFileSync(join(cache, "0.2.0/hooks/gate-hook.mjs"), "utf8"));
            send("hooks/list", { cwds: [project] }, 5);
          } else {
            const after = sageHooks(reply.result);
            assert.deepEqual(after, before.map((hook) => ({ ...hook, trustStatus: "trusted" })), "each sage entry stays trusted after the update");
            finish();
          }
        } catch (error) { finish(error); }
      }
    });
    send("initialize", { clientInfo: { name: "sage-package-check", version: "0.1.0" }, capabilities: { experimentalApi: true } }, 1);

    const result = await closed;
    if (!finished) failure ??= new Error("app server exited before the check completed");
    if (result.code !== 0 || result.signal) failure ??= new Error("app server did not close successfully");
    if (failure) {
      console.error(`Codex package check failed: ${failure.message}`);
      process.exitCode = 1;
    } else {
      console.log(`${version}: discovered ${discovered} skills and no plugin hook from the Codex package. hooks/list shows sage's ${before.length} entries as user hooks; after a trust write and a swap of the plugin's version folder, all ${before.length} stay trusted. No model turn was attempted, and only a scratch Codex home was written.`);
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
