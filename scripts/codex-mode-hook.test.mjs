// The sage hook for Codex (T453): the mode phrases and the chief role, run as Codex runs the hook: one process for
// each event, with the event's JSON on stdin (the input and output shapes of the Codex hook docs, as T451 saw them in
// Codex 0.160.0). The phrase cases are the Claude hook's own table (fixtures/mode-cases.mjs).
import "./test-env.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { NEAR_NOTE, PHRASE_CASES, S_ON } from "./fixtures/mode-cases.mjs";

const HOOK = fileURLToPath(new URL("../plugins/sage-codex/hooks/sage-codex-hook.mjs", import.meta.url));
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "sage-codex-mode-")));
after(() => rmSync(scratch, { recursive: true, force: true }));
const CODEX_HOME = join(scratch, "codex");
const MODE_DIR = join(CODEX_HOME, "sage", ".hooks", "codex");

/** Runs the hook once, as Codex does: the raw stdin text in, the parsed stdout out (undefined for no output). */
function run(stdin, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK], { env: { PATH: "/usr/bin:/bin", HOME: join(scratch, "home"), CODEX_HOME, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.resume();
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(out ? JSON.parse(out) : undefined) : reject(Error(`hook exit ${code}`))));
    child.stdin.end(stdin);
  });
}

let sessions = 0;
/** A Codex session: prompt() and start() send the documented UserPromptSubmit and SessionStart inputs. */
function session(env) {
  const id = `019a${String(++sessions).padStart(4, "0")}-0000-7000-8000-000000000000`;
  const base = { session_id: id, transcript_path: null, cwd: scratch, model: "fixture", permission_mode: "default" };
  const send = (fields) => run(JSON.stringify({ ...base, ...fields }), env);
  return {
    id,
    send,
    prompt: (prompt, extra = {}) => send({ hook_event_name: "UserPromptSubmit", turn_id: `turn-${sessions}`, prompt, ...extra }),
    start: (source) => send({ hook_event_name: "SessionStart", source }),
  };
}
const contextOf = (output, event = "UserPromptSubmit") => {
  if (output === undefined) return undefined;
  assert.equal(output.hookSpecificOutput.hookEventName, event);
  return output.hookSpecificOutput.additionalContext;
};
/** The modes, as the help phrase reports them, in the table's words: "sage mode on, autopilot off". */
async function modes(s) {
  const now = /^Now: sage mode is (on|off), and autopilot is (on|off)\.$/m.exec(contextOf(await s.prompt("sage help")) ?? "");
  assert.ok(now, "the help phrase reports the modes");
  return `sage mode ${now[1]}, autopilot ${now[2]}`;
}
const ROLE = /^sage: sage mode is on\. You are the user's chief of staff until the user sends the message "sage mode off", alone\.\n\nThe state tool: node "[^"]+\/skills\/sage\/sage\.mjs" <command> --project <path>\./;

test("T453: the Claude hook's phrase table gives the same modes and near-miss notes in Codex", async () => {
  const got = await Promise.all(PHRASE_CASES.map(async ([why, before, message]) => {
    const s = session();
    for (const m of before) await s.prompt(m);
    const note = contextOf(await s.prompt(message)) ?? "";
    return [why, await modes(s), NEAR_NOTE.exec(note)?.[1] ?? null];
  }));
  assert.deepEqual(got, PHRASE_CASES.map(([why, , , after, near]) => [why, after, near]));
});

test("T453: the on phrase gives the chief role once; the off phrase ends it; a compaction gives it again only in sage mode", async () => {
  const s = session();
  assert.equal(await s.prompt("fix the login bug"), undefined, "no mode, no context");
  const on = contextOf(await s.prompt("sage mode"));
  assert.match(on, ROLE);
  assert.match(on, /\n# Chief of staff \(sage mode\)\n/);
  assert.match(on, /Use the installed Sage skill’s absolute state-tool path/, "the Codex bindings of the chief instructions");
  assert.equal(await s.prompt("what is open?"), undefined, "the role is not repeated on each prompt");
  assert.equal(await s.start("startup"), undefined);
  assert.equal(await s.start("resume"), undefined, "a resumed thread keeps the role in its history");
  assert.match(contextOf(await s.start("compact"), "SessionStart"), ROLE);
  assert.equal(contextOf(await s.prompt("sage mode off")), "sage: sage mode is off. This is a normal session for the rest of it, also when it started as the chief: you may change files yourself again.");
  assert.equal(await s.prompt("what is open?"), undefined, "no role after the off phrase");
  assert.equal(await s.start("compact"), undefined, "no role after a compaction in an off session");
  assert.match(contextOf(await s.prompt("SAGE MODE ON.")), ROLE, "the on phrase gives the role again");
});

test("T453: the autopilot phrases record autopilot, and the note says that sage in Codex merges nothing yet", async () => {
  const s = session();
  assert.equal(contextOf(await s.prompt("autopilot on")), 'sage: autopilot did not switch on, because it turns on only while sage mode is on. Ask the user to send "sage mode" first, then "autopilot on", each as a message alone.');
  await s.prompt("sage mode");
  assert.equal(contextOf(await s.prompt("autopilot on")), "sage: autopilot is on. In Codex, sage has no merge check yet, so autopilot merges nothing: work stops at verified, and the user merges.");
  assert.equal(await modes(s), "sage mode on, autopilot on");
  assert.equal(contextOf(await s.prompt("autopilot off")), "sage: autopilot is off. Work stops at verified, and the user merges.");
  assert.equal(await modes(s), "sage mode on, autopilot off");
});

test("T453: the help phrase lists the Codex timing, and no board phrase or Claude command", async () => {
  const help = contextOf(await session().prompt("sage help"));
  assert.match(help, /^Switches: send the phrase alone, as the whole message, in any letter case\. Spaces at the ends and one full stop are fine\. Any other message switches nothing\.\nSend a phrase as a message alone\. A phrase typed while Codex works switches when its turn starts\.\n- "sage mode": turns sage mode on\.$/m);
  assert.doesNotMatch(help, /Board:|claude plugin update|Claude/);
});

test("T453: a subagent's prompt switches nothing and gets no role, also with the parent's session id", async () => {
  const s = session();
  assert.equal(await s.prompt("sage mode", { agent_id: "agent-1", agent_type: "default" }), undefined);
  assert.equal(await modes(s), "sage mode off, autopilot off");
  await s.prompt("sage mode");
  assert.equal(await s.prompt("sage mode off", { agent_id: "agent-1" }), undefined);
  assert.equal(await modes(s), "sage mode on, autopilot off");
});

const UNKNOWN = { systemMessage: "sage: the sage hook did not recognise this Codex event, so it switched no mode, and autopilot is off. Update the sage plugin or Codex." };

test("T453: an unknown input shape switches nothing, turns autopilot off, and shows one plain line", async () => {
  const s = session();
  for (const m of S_ON) await s.prompt(m);
  assert.deepEqual(await s.send({ hook_event_name: "UserPromptSubmit", prompt: ["sage mode off"] }), UNKNOWN);
  assert.equal(await modes(s), "sage mode on, autopilot off", "autopilot is off, and the off phrase in the wrong shape did not switch");
  assert.deepEqual(await s.send({ hook_event_name: "SessionStart" }), UNKNOWN, "no source");
  assert.deepEqual(await s.send({ hook_event_name: "Stop" }), UNKNOWN, "an event that hooks.json does not name");
  assert.deepEqual(await run("not json"), UNKNOWN);
  assert.deepEqual(await run(JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: "sage mode" })), UNKNOWN, "no session id");
  assert.equal(readdirSync(MODE_DIR).length > 0, true, "the mode files are under the Codex logbook root");
});

test("T453: a damaged mode file reads as no mode; a mode folder that cannot be used fails closed with one line", async () => {
  const s = session();
  await s.prompt("sage mode");
  for (const name of readdirSync(MODE_DIR)) writeFileSync(join(MODE_DIR, name), "{not json");
  assert.equal(await modes(s), "sage mode off, autopilot off");
  const home = join(scratch, "blocked");
  mkdirSync(home);
  writeFileSync(join(home, ".hooks"), "a file where the mode folder goes");
  assert.deepEqual(await session({ SAGE_HOME: home }).prompt("sage mode"), { systemMessage: "sage: the sage hook could not read or save the sage mode of this session, so it switched no mode. Check the sage folder in the Codex home." });
  assert.equal(readFileSync(join(home, ".hooks"), "utf8"), "a file where the mode folder goes");
});

test("T453: SAGE_HOOKS=off turns the hook off", async () => {
  assert.equal(await session({ SAGE_HOOKS: "off" }).prompt("sage mode"), undefined);
});

test("T453: hooks.json runs the sage hook on UserPromptSubmit and on SessionStart with source compact, with room for the role", () => {
  const { hooks } = JSON.parse(readFileSync(new URL("../plugins/sage-codex/hooks/hooks.json", import.meta.url), "utf8"));
  const sage = (groups) => groups.flatMap((g) => g.hooks.filter((h) => h.command.endsWith('/hooks/sage-codex-hook.mjs"')).map((h) => ({ matcher: g.matcher, limit: h.additionalContextLimit })));
  assert.deepEqual(sage(hooks.UserPromptSubmit), [{ matcher: undefined, limit: 6000 }]);
  assert.deepEqual(sage(hooks.SessionStart), [{ matcher: "compact", limit: 6000 }]);
});

test("T453: the chief role fits the hooks.json context limit, counted at 3 bytes for each token (English text has about 4)", async () => {
  const role = contextOf(await session().prompt("sage mode"));
  assert.ok(Buffer.byteLength(role) < 6000 * 3, `${Buffer.byteLength(role)} bytes`);
});
