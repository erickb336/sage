#!/usr/bin/env node
import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const name = basename(process.argv[2] ?? "");
if (!name.endsWith(".mjs")) {
  process.stderr.write("usage: node launcher.mjs <hook file name>, for example sage-hook.mjs\n");
  process.exit(1);
}
const ownRoot = realpathSync(dirname(dirname(fileURLToPath(import.meta.url))));

function read(file) {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const s = fstatSync(fd);
    if (!s.isFile() || s.size > 1 << 20) throw new Error(`${file} is not a regular file of at most 1 MB`);
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

const release = (root) => JSON.parse(read(join(root, ".claude-plugin", "plugin.json"))).metadata?.release ?? 0;

function current() {
  const cache = dirname(ownRoot) + sep;
  const plugins = dirname(dirname(dirname(cache)));
  if (cache !== join(plugins, "cache", "sage", "sage") + sep || basename(plugins) !== "plugins") throw new Error(`${ownRoot} is not an installed version`);
  const entry = JSON.parse(read(join(plugins, "installed_plugins.json"))).plugins["sage@sage"].find((e) => e.scope === "user");
  if (!isAbsolute(entry.installPath)) throw new Error(`${entry.installPath} is not absolute`);
  const install = realpathSync(entry.installPath);
  if (!install.startsWith(cache)) throw new Error(`${install} is outside ${cache}`);
  if (!(release(install) >= release(ownRoot))) throw new Error(`${install} is older than ${ownRoot}`);
  const hook = realpathSync(join(install, "hooks", name));
  if (!hook.startsWith(install + sep) || !statSync(hook).isFile()) throw new Error(`${hook} is not a hook of ${install}`);
  return hook;
}

const run = (hook) => {
  process.argv[1] = hook;
  return import(pathToFileURL(hook).href);
};

let hook;
try {
  hook = current();
} catch {
  hook = join(ownRoot, "hooks", name);
}
try {
  await run(hook);
} catch (first) {
  try {
    await run(realpathSync(join(ownRoot, "hooks", name)));
  } catch (e) {
    let input;
    try {
      input = JSON.parse(readFileSync(0, "utf8"));
    } catch {}
    const reason = `sage: the ${name} hook could not load (${first?.message ?? first}; ${e?.message ?? e}). Tell the user.`;
    const command = [].concat(input?.tool_input?.command ?? []).join(" ");
    if (name === "sage-hook.mjs" && input?.hook_event_name === "PreToolUse" && input.tool_name === "Bash" && /\b(merge|push)\b/.test(command))
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `${reason} It refuses a merge or a push until a hook loads.` } }));
    else process.stderr.write(`${reason}\n`);
  }
}
