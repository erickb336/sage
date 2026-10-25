#!/usr/bin/env node
// Codex SessionStart hook: one short sage status at the start of a session, for the owner (systemMessage) and the
// model (additionalContext). It reads files only and never blocks the session. One script for each event, after
// oh-my-codex (MIT, github.com/Yeachan-Heo/oh-my-codex).
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PHRASES } from "sage-core";

/** The Codex versions (major.minor, both ends included) that sage was checked with. */
export const TESTED_CODEX = ["0.160", "0.164"];
const ON_PHRASE = Object.keys(PHRASES).find((phrase) => PHRASES[phrase].sage === true);

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const minor = (version) => /^(\d+)\.(\d+)/.exec(version)?.slice(1).map(Number);

/** The Codex version from the session's first transcript line (session_meta), or null. */
function codexVersion(transcriptPath) {
  try {
    const first = readFileSync(transcriptPath, "utf8").split("\n", 1)[0];
    const version = JSON.parse(first).payload?.cli_version;
    return typeof version === "string" && minor(version) ? version : null;
  } catch { return null; }
}

/**
 * The trust keys of this plugin's hooks, in Codex's form <plugin>@<marketplace>:hooks/hooks.json:<event>:<group>:<handler>.
 * The installed root is <CODEX_HOME>/plugins/cache/<marketplace>/<plugin>/<version>.
 */
function hookKeys(pluginRoot) {
  const id = `${basename(dirname(pluginRoot))}@${basename(dirname(dirname(pluginRoot)))}`;
  const snake = (event) => event.replace(/(?<!^)([A-Z])/g, "_$1").toLowerCase();
  return Object.entries(readJson(join(pluginRoot, "hooks/hooks.json")).hooks).flatMap(([event, groups]) =>
    groups.flatMap((group, g) => group.hooks.map((_, h) => `${id}:hooks/hooks.json:${snake(event)}:${g}:${h}`)));
}

/** How many of the keys have a trust record in the owner's config.toml. Codex itself checks each hash. */
function trustedCount(keys, codexHome) {
  let config = "";
  try { config = readFileSync(join(codexHome, "config.toml"), "utf8"); } catch { /* No config yet. */ }
  const trusted = new Set();
  let table = null;
  for (const line of config.split("\n")) {
    const header = /^\s*\[hooks\.state\."([^"]+)"\]\s*$/.exec(line);
    if (header) table = header[1];
    else if (/^\s*\[/.test(line)) table = null;
    else if (table && /^\s*trusted_hash\s*=\s*"sha256:/.test(line)) trusted.add(table);
  }
  return keys.filter((key) => trusted.has(key)).length;
}

/** The hook's output JSON for one SessionStart input, or undefined for any other event. */
export function sessionStatus(input, { pluginRoot, codexHome }) {
  if (input?.hook_event_name !== "SessionStart") return undefined;
  const plugin = readJson(join(pluginRoot, ".codex-plugin/plugin.json")).version;
  const version = codexVersion(input.transcript_path);
  const keys = hookKeys(pluginRoot);
  const trusted = trustedCount(keys, codexHome);
  const [low, high] = TESTED_CODEX.map(minor);
  const at = version && minor(version);
  const inRange = at && (at[0] - low[0] || at[1] - low[1]) >= 0 && (at[0] - high[0] || at[1] - high[1]) <= 0;
  const lines = [
    `sage ${plugin} is installed. Codex ${version ?? "version unknown"}.`,
    trusted === keys.length ? `sage hooks: all ${keys.length} trusted.`
      : `sage hooks: ${trusted} of ${keys.length} trusted. Type /hooks in the Codex CLI to review the others.`,
    `To start sage mode, send this message alone: ${ON_PHRASE}`,
  ];
  if (!inRange) lines.push(`Warning: sage is tested with Codex ${TESTED_CODEX.join(" to ")}${version ? `, not ${version}` : ""}. Some sage hooks may not work.`);
  const text = lines.join("\n");
  return { systemMessage: text, hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text } };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const output = sessionStatus(JSON.parse(readFileSync(0, "utf8")), {
      pluginRoot: join(dirname(fileURLToPath(import.meta.url)), ".."),
      codexHome: process.env.CODEX_HOME || join(homedir(), ".codex"),
    });
    if (output) process.stdout.write(JSON.stringify(output));
  } catch { /* A status line must not break a coding session. */ }
}
