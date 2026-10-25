// Read-only native packaging check: no installation, configuration writes or model turn.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./build.mjs";
import { waitNative } from "./fixtures/codex-native/wait-native.mjs";

// Codex names each event of hooks.json in camel case, one entry for each handler.
const hookEvents = Object.entries(JSON.parse(readFileSync(join(ROOT, "plugins/sage-codex/hooks/hooks.json"), "utf8")).hooks)
  .flatMap(([event, groups]) => groups.flatMap((group) => group.hooks.map(() => event[0].toLowerCase() + event.slice(1)))).sort();

const binary = process.env.SAGE_CODEX_BIN ?? "codex";
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("CODEX_FLORA_CCA_") && !["CODEX_EXEC_SERVER_REMOTE", "CODEX_SESSION_ID", "CODEX_THREAD_ID", "CODEX_ENVIRONMENT_ID"].includes(key)));
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
  const child = spawn(binary, ["app-server", "-c", 'cli_auth_credentials_store="ephemeral"', "-c", "features.remote_plugins=false", "-c", "features.plugin_hooks=true", "-c", "features.codex_hooks=true"], { env, stdio: ["pipe", "pipe", "pipe"] });
  const send = (method, params, id) => child.stdin.write(JSON.stringify({ method, params, ...(id === undefined ? {} : { id }) }) + "\n");
  let buffer = "";
  let finished = false;
  let failure;
  let discovered = 0;
  const finish = (error) => {
    if (error) failure ??= error;
    if (finished) return;
    finished = true;
    child.stdin.end();
  };
  child.stderr.resume();
  const closed = waitNative(child, { deadlineMs: 25000,
    onTimeout: () => finish(new Error("plugin/read timed out; native discovery is unverified")),
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
        if (reply.id !== 1 && reply.id !== 2) continue;
        if (reply.error) throw new Error(reply.error.message);
        if (reply.id === 1) {
          send("initialized", {});
          send("plugin/read", { marketplacePath: join(ROOT, ".agents/plugins/marketplace.json"), pluginName: "sage" }, 2);
        } else {
          const plugin = reply.result.plugin;
          const expected = readdirSync(join(ROOT, "plugins/sage-codex/skills")).map((name) => `sage:${name}`).sort();
          assert.deepEqual(plugin.skills.map((skill) => skill.name).sort(), expected);
          assert.deepEqual(plugin.hooks.map((hook) => hook.eventName).sort(), hookEvents);
          assert.equal(plugin.summary.source.path, join(ROOT, "plugins/sage-codex"));
          discovered = expected.length;
          finish();
        }
      } catch (error) { finish(error); }
    }
  });
  send("initialize", { clientInfo: { name: "sage-package-check", version: "0.1.0" }, capabilities: { experimentalApi: true } }, 1);

  const result = await closed;
  if (!finished) failure ??= new Error("app server exited before plugin/read completed");
  if (result.code !== 0 || result.signal) failure ??= new Error("app server did not close successfully");
  if (failure) {
    console.error(`Codex package check failed: ${failure.message}`);
    process.exitCode = 1;
  } else {
    console.log(`${version}: discovered ${discovered} skills and ${hookEvents.length} hooks from the Codex package. No model turn or install was attempted.`);
  }
}
