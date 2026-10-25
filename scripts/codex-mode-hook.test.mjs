// The sage hook for Codex (T453): the mode phrases and the chief role, run as Codex runs the hook: one process for
// each event, with the event's JSON on stdin (the input and output shapes of the Codex hook docs, as T451 saw them in
// Codex 0.160.0). The phrase cases are the Claude hook's own table (fixtures/mode-cases.mjs).
import "./test-env.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { NEAR_NOTE, PHRASE_CASES, S_ON, SUBSESSION_PROMPTS } from "./fixtures/mode-cases.mjs";

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
/** The mode file of a session's root thread: the file name is the sha256 of the session id and no agent id. */
const modeFile = (s, dir = MODE_DIR) => join(dir, `${createHash("sha256").update(JSON.stringify([s.id, null])).digest("hex")}.json`);
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
  assert.match(on, /Each `sage` command below is a tool of the plugin's `sage` MCP server/, "the Codex bindings of the chief instructions");
  assert.equal(await s.prompt("what is open?"), undefined, "the role is not repeated on each prompt");
  assert.equal(await s.start("startup"), undefined);
  assert.equal(await s.start("resume"), undefined, "a resumed thread keeps the role in its history");
  assert.match(contextOf(await s.start("compact"), "SessionStart"), ROLE);
  assert.match(on, /\n\n---\n\nsage: confirm the switch to the user in one line of your reply: sage mode is on, and autopilot is off\.$/, "the chief confirms the switch");
  assert.deepEqual(await s.prompt("sage mode off"), { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "sage: sage mode is off. This is a normal session for the rest of it, also when it started as the chief: you may change files yourself again.\n\n---\n\nsage: confirm the switch to the user in one line of your reply: sage mode is off, and autopilot is off." } }, "a normal switch shows the user no warning line: the chief confirms it");
  assert.equal(await s.prompt("what is open?"), undefined, "no role after the off phrase");
  assert.equal(await s.start("compact"), undefined, "no role after a compaction in an off session");
  assert.match(contextOf(await s.prompt("SAGE MODE ON.")), ROLE, "the on phrase gives the role again");
});

test("T453: the autopilot phrases record autopilot; the user gets the limit line, and the chief confirms the switch", async () => {
  const s = session();
  assert.deepEqual(await s.prompt("autopilot on"), { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: 'sage: autopilot did not switch on, because it turns on only while sage mode is on. Ask the user to send "sage mode" first, then "autopilot on", each as a message alone.' } });
  await s.prompt("sage mode");
  assert.deepEqual(await s.prompt("autopilot on"), {
    systemMessage: "sage: autopilot is on, but in Codex it merges nothing yet: work stops at verified, and you merge.",
    hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "sage: autopilot is on. In Codex, sage has no merge check yet, so autopilot merges nothing: work stops at verified, and the user merges.\n\n---\n\nsage: confirm the switch to the user in one line of your reply: sage mode is on, and autopilot is on." },
  });
  assert.equal(await modes(s), "sage mode on, autopilot on");
  assert.deepEqual(await s.prompt("autopilot off"), { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "sage: autopilot is off. Work stops at verified, and the user merges.\n\n---\n\nsage: confirm the switch to the user in one line of your reply: sage mode is on, and autopilot is off." } });
  assert.equal(await modes(s), "sage mode on, autopilot off");
});

test("T453: the help phrase says when to send a phrase and that autopilot merges nothing in Codex, with no board phrase or Claude command", async () => {
  const help = contextOf(await session().prompt("sage help"));
  assert.match(help, /^Switches: send the phrase alone, as the whole message, in any letter case\. Spaces at the ends and one full stop are fine\. Any other message switches nothing\.\nSend a phrase when Codex is idle\. In Codex, autopilot merges nothing yet: work stops at verified, and you merge\.\n- "sage mode": turns sage mode on\.$/m);
  assert.doesNotMatch(help, /Board:|claude plugin update|Claude|switches when its turn starts/);
});

test("T453: a review or guardian subsession's prompt, with the root session id and no agent_id, switches nothing and gets no role", async () => {
  const got = [];
  for (const [why, prompt] of SUBSESSION_PROMPTS) {
    const s = session();
    for (const m of S_ON) await s.prompt(m);
    const output = contextOf(await s.prompt(prompt)) ?? "";
    got.push([why, await modes(s), /chief of staff|confirm the switch/.test(output)]);
  }
  assert.deepEqual(got, SUBSESSION_PROMPTS.map(([why]) => [why, "sage mode on, autopilot on", false]));
});

test("T453: a fork starts with sage mode off, and the chief gets one note to tell the user if its history shows the role", async () => {
  const s = session();
  assert.deepEqual(await s.start("fork"), { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: 'sage: this thread is a fork, so sage mode and autopilot are off in it, also if the history shows the chief role: this is a normal session, and you may change files yourself. If the history shows the chief role, tell the user in one line of your reply that sage mode is off in this fork, and that the message "sage mode" alone turns it on.' } });
  assert.equal(await modes(s), "sage mode off, autopilot off");
  assert.match(contextOf(await s.prompt("sage mode")), ROLE, "the on phrase gives the fork the role");
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

const DAMAGED = 'sage: the sage mode file of this session was damaged, so sage mode and autopilot are now off. Send "sage mode" alone to turn sage mode on again.';
const DAMAGED_NOTE = 'sage: the sage mode file of this session was damaged, so sage mode and autopilot are now off. This is a normal session until the user sends "sage mode" alone, also if the history shows the chief role: you may change files yourself. Tell the user this in one line of your reply.';

test("T453: a damaged mode file turns sage mode and autopilot off, tells the user once, and is replaced by a clean off state", async () => {
  const got = [];
  for (const damage of ["{not json", "[]", "null", '{"sage":"yes","autopilot":true}']) {
    const s = session();
    for (const m of S_ON) await s.prompt(m);
    const file = modeFile(s);
    writeFileSync(file, damage);
    got.push([damage, await s.prompt("autopilot on"), JSON.parse(readFileSync(file, "utf8")), await s.start("compact"), await modes(s)]);
  }
  const once = { systemMessage: DAMAGED, hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: DAMAGED_NOTE } };
  assert.deepEqual(got, ["{not json", "[]", "null", '{"sage":"yes","autopilot":true}'].map((damage) => [damage, once, { sage: false, autopilot: false }, undefined, "sage mode off, autopilot off"]));
});

test("T453: an unreadable mode file, or a mode folder that cannot be used, fails closed with one line that names the folder", async () => {
  const s = session({ SAGE_HOME: join(scratch, "folder-file") });
  await s.prompt("sage mode");
  const dir = join(scratch, "folder-file", ".hooks", "codex");
  rmSync(modeFile(s, dir));
  mkdirSync(modeFile(s, dir)); // a folder where the mode file goes: it cannot be read or replaced
  const line = { systemMessage: `sage: the sage hook could not read or save the sage mode of this session, so it switched no mode. Check the folder ${dir}.` };
  assert.deepEqual(await s.prompt("sage mode"), line);
  const home = join(scratch, "blocked");
  mkdirSync(home);
  writeFileSync(join(home, ".hooks"), "a file where the mode folder goes");
  assert.deepEqual(await session({ SAGE_HOME: home }).prompt("sage mode"), { systemMessage: `sage: the sage hook could not read or save the sage mode of this session, so it switched no mode. Check the folder ${join(home, ".hooks", "codex")}.` });
  assert.equal(readFileSync(join(home, ".hooks"), "utf8"), "a file where the mode folder goes");
});

test("T453: the core reader of the mode file: no file is a new session; a file that cannot be read or holds no mode state is damaged and off", async () => {
  const { readModeFile } = await import("../packages/sage-core/mode-policy.mjs");
  const thrown = (code) => () => { throw Object.assign(Error(code), { code }); };
  const value = (v) => () => v;
  const got = [["no file", thrown("ENOENT")], ["no access", thrown("EACCES")], ["not JSON", () => JSON.parse("{")], ["an array", value([])], ["a string flag", value({ sage: "false" })], ["a clean state", value({ sage: true, given: true, autopilot: false, off: "owner" })]]
    .map(([why, read]) => [why, readModeFile(read, "/no/such/file.json")]);
  const off = { state: { sage: false, autopilot: false }, damaged: true };
  assert.deepEqual(got, [["no file", { state: {}, damaged: false }], ["no access", off], ["not JSON", off], ["an array", off], ["a string flag", off], ["a clean state", { state: { sage: true, given: true, autopilot: false, off: "owner" }, damaged: false }]]);
});

test("T453: SAGE_HOOKS=off switches nothing, and an exact phrase gets one line that says the sage hook is off", async () => {
  const s = session({ SAGE_HOOKS: "off" });
  assert.deepEqual(await s.prompt("sage mode"), { systemMessage: "sage: the sage hook is off (SAGE_HOOKS=off), so this phrase switched no mode. Start Codex without SAGE_HOOKS=off to use the phrases." });
  assert.equal(await s.prompt("fix the login bug"), undefined, "a normal message gets no line");
  assert.equal(await s.prompt("sage mode", { agent_id: "agent-1" }), undefined, "a subagent gets no line");
  assert.equal(existsSync(modeFile(s)), false, "the session has no mode file: no mode switched");
});

test("T453: hooks.json runs the sage hook on UserPromptSubmit and on SessionStart with source compact or fork, with room for the role", () => {
  const { hooks } = JSON.parse(readFileSync(new URL("../plugins/sage-codex/hooks/hooks.json", import.meta.url), "utf8"));
  const sage = (groups) => groups.flatMap((g) => g.hooks.filter((h) => h.command.endsWith('/hooks/sage-codex-hook.mjs"')).map((h) => ({ matcher: g.matcher, limit: h.additionalContextLimit })));
  assert.deepEqual(sage(hooks.UserPromptSubmit), [{ matcher: undefined, limit: 6000 }]);
  assert.deepEqual(sage(hooks.SessionStart), [{ matcher: "compact|fork", limit: 6000 }]);
  assert.deepEqual(hooks.SessionStart.map((g) => g.matcher), ["startup|resume|clear", "compact|fork"], "the start status keeps its own group");
});

test("T453: the README and the Codex guide say what the hook really does in Codex (R1653)", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const guide = readFileSync(new URL("../docs/guide/codex.md", import.meta.url), "utf8");
  const found = (text, pattern) => pattern.test(text.replace(/\s+/g, " "));
  assert.deepEqual({
    "README: the autopilot phrases merge nothing in Codex": found(readme, /`sage mode off` and `sage help` work as in Claude Code; `autopilot on` and `autopilot off` record autopilot, but in Codex it merges nothing yet: you merge\./),
    "README: no claim that every phrase works as in Claude Code": !found(readme, /`autopilot off` and `sage help` work as in Claude Code/),
    "guide: the warning line, and that codex exec does not show it": found(guide, /gives Codex a warning line; the terminal UI and the app show it; `codex exec` does not\./),
    "guide: no claim that the hook shows one line": !found(guide, /and shows one line/),
    "guide: a damaged mode file": found(guide, /A damaged mode file turns sage mode and autopilot off/),
    "guide: send a phrase when Codex is idle": found(guide, /Send a phrase when Codex is idle\./),
    "guide: no exact phrase for a question": found(guide, /unless your message was a question/),
    "guide: the desktop app, not yet checked": found(guide, /desktop app.*This desktop path is not checked yet\./i),
    "guide: step 3 starts Codex with no flags and trusts the hooks": found(guide, /3\. Run `codex` in a project folder\. At the "Hooks need review" screen .*choose \*\*Trust all and continue\*\*/),
    "guide: a fork starts with sage mode off": found(guide, /A forked thread starts with sage mode and autopilot off/),
  }, Object.fromEntries(["README: the autopilot phrases merge nothing in Codex", "README: no claim that every phrase works as in Claude Code", "guide: the warning line, and that codex exec does not show it", "guide: no claim that the hook shows one line", "guide: a damaged mode file", "guide: send a phrase when Codex is idle", "guide: no exact phrase for a question", "guide: the desktop app, not yet checked", "guide: step 3 starts Codex with no flags and trusts the hooks", "guide: a fork starts with sage mode off"].map((k) => [k, true])));
});

test("T453: the chief role fits the hooks.json context limit, counted at 3 bytes for each token (English text has about 4)", async () => {
  const role = contextOf(await session().prompt("sage mode"));
  assert.ok(Buffer.byteLength(role) < 6000 * 3, `${Buffer.byteLength(role)} bytes`);
});
