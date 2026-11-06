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
import { chiefInstructionParts } from "../plugins/sage-codex/runtime/chief-output.mjs";

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
const ROLE = /^sage: sage mode is on\. You are the user's chief of staff until the user sends the message "sage mode off", alone\.\n\nThe state tool, for reads only: node "[^"]+\/skills\/sage\/sage\.mjs" <command> --project <path>\. Write the logbook only with the sage MCP tools\.\n/;

test("T115: exact autopilot on is unavailable, including repeats and saved true", async () => {
  const s = session();
  for (const sage of [false, true]) {
    mkdirSync(MODE_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(modeFile(s), JSON.stringify({ sage, autopilot: true, given: true }), { mode: 0o600 });
    for (const phrase of ["autopilot on", " AUTOPILOT ON. ", "autopilot on"]) {
      assert.match(contextOf(await s.prompt(phrase)), /automatic merging is unavailable/);
      assert.deepEqual(JSON.parse(readFileSync(modeFile(s), "utf8")), { sage, autopilot: false, given: true });
    }
  }
});

test("T453: the Claude hook's phrase table gives the same modes and near-miss notes in Codex", async () => {
  const got = await Promise.all(PHRASE_CASES.map(async ([why, before, message]) => {
    const s = session();
    for (const m of before) await s.prompt(m);
    const note = contextOf(await s.prompt(message)) ?? "";
    return [why, await modes(s), NEAR_NOTE.exec(note)?.[1] ?? null];
  }));
  assert.deepEqual(got, PHRASE_CASES.map(([why, , , after, near]) => [why, after.replace("autopilot on", "autopilot off"), near]));
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

test("T115: autopilot stays unavailable while ordinary Sage modes work", async () => {
  const s = session();
  assert.match(contextOf(await s.prompt("autopilot on")), /automatic merging is unavailable/);
  await s.prompt("sage mode");
  assert.match(contextOf(await s.prompt("autopilot on")), /automatic merging is unavailable/);
  assert.equal(await modes(s), "sage mode on, autopilot off");
  assert.equal(await s.prompt("autopilot off"), undefined);
  assert.equal(await modes(s), "sage mode on, autopilot off");
});

test("T453: the help phrase says when to send a phrase and that autopilot merges verified work in Codex, with no board phrase or Claude command", async () => {
  const help = contextOf(await session().prompt("sage help"));
  assert.match(help, /Automatic merging is unavailable in Codex\. Sage prepares the checks; the owner merges directly in GitHub\./);
  assert.match(help, /"autopilot on": automatic merging is unavailable in Codex\./);
  assert.doesNotMatch(help, /turns autopilot on/);
  assert.doesNotMatch(help, /the hook allows|exact merge command|merge_check/, "the help list is in the user's words (R1665-5)");
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
  assert.deepEqual(got, SUBSESSION_PROMPTS.map(([why]) => [why, "sage mode on, autopilot off", false]));
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

const UNKNOWN = { systemMessage: "sage: the sage hook did not recognise this Codex event, so it switched no mode, and autopilot is off. Update the sage plugin, and keep Codex in the tested range (0.160 to 0.166)." };

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
  const once = { systemMessage: `${DAMAGED} sage: automatic merging is unavailable in Codex. Sage prepares the checks; the owner merges directly in GitHub.`, hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: DAMAGED_NOTE } };
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

function assertMergePolicyMatches(guide, help) {
  const policies = (text) => {
    const prose = text.replace(/\s+/g, " ");
    return {
      automatic: /autopilot merges verified work|sage merges a pull request by itself/i.test(prose),
      owner: /automatic merging is unavailable/i.test(prose),
    };
  };
  const documented = policies(guide);
  const reported = policies(help);
  for (const [label, policy] of [["guide", documented], ["runtime help", reported]]) {
    assert.equal(Number(policy.automatic) + Number(policy.owner), 1, `${label}: exactly one merge policy`);
  }
  assert.deepEqual(documented, reported, "guide and runtime help agree on merge policy");
  if (documented.owner) {
    assert.match(guide.replace(/\s+/g, " "), /merge directly in GitHub/, "guide names the owner's merge action");
    assert.match(help, /the owner merges directly in GitHub/, "runtime help names the owner's merge action");
  }
}

test("T453: merge policy consistency rejects missing, contradictory and mismatched claims (T116)", () => {
  const automaticGuide = "With autopilot on, autopilot merges verified work.";
  const automaticHelp = "With autopilot on, sage merges a pull request by itself after its clean reviews and checks.";
  const ownerGuide = "The exact on phrase reports that automatic merging is unavailable. The chief prepares a reviewed pull request for you to merge directly in GitHub.";
  const ownerHelp = "Automatic merging is unavailable in Codex. Sage prepares the checks; the owner merges directly in GitHub.";
  assertMergePolicyMatches(automaticGuide, automaticHelp);
  assertMergePolicyMatches(ownerGuide, ownerHelp);
  for (const [guide, help] of [
    ["", automaticHelp], [automaticGuide, ""],
    [automaticGuide, ownerHelp], [ownerGuide, automaticHelp],
    [automaticGuide + ownerGuide, automaticHelp], [ownerGuide, automaticHelp + ownerHelp],
    ["Automatic merging is unavailable.", ownerHelp],
    [ownerGuide, "Automatic merging is unavailable."],
  ]) assert.throws(() => assertMergePolicyMatches(guide, help), assert.AssertionError);
});

test("T453: the README and the Codex guide say what the hook really does in Codex (R1653)", async () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const guide = readFileSync(new URL("../docs/guide/codex.md", import.meta.url), "utf8");
  assertMergePolicyMatches(guide, contextOf(await session().prompt("sage help")) ?? "");
  const found = (text, pattern) => pattern.test(text.replace(/\s+/g, " "));
  assert.deepEqual({
    "guide and README: no obsolete merge status": !found(guide + readme, /merges nothing yet/),
    "README: no claim that every phrase works as in Claude Code": !found(readme, /`autopilot off` and `sage help` work as in Claude Code/),
    "guide: the warning line, and that codex exec does not show it": found(guide, /gives Codex a warning line; the terminal UI and the app show it; `codex exec` does not\./),
    "guide: no claim that the hook shows one line": !found(guide, /and shows one line/),
    "guide: a damaged mode file": found(guide, /A damaged mode file turns sage mode and autopilot off/),
    "guide: send a phrase when Codex is idle": found(guide, /Send a phrase when Codex is idle\./),
    "guide: no exact phrase for a question": found(guide, /unless your message was a question/),
    "guide: the desktop app, not yet checked": found(guide, /desktop app.*This desktop path is not checked yet\./i),
    "guide: step 3 starts Codex with no flags and trusts the hooks": found(guide, /3\. Run `codex` in a project folder\. At the "Hooks need review" screen .*choose \*\*Trust all and continue\*\*/),
    "guide: a fork starts with sage mode off": found(guide, /A forked thread starts with sage mode and autopilot off/),
  }, Object.fromEntries(["guide and README: no obsolete merge status", "README: no claim that every phrase works as in Claude Code", "guide: the warning line, and that codex exec does not show it", "guide: no claim that the hook shows one line", "guide: a damaged mode file", "guide: send a phrase when Codex is idle", "guide: no exact phrase for a question", "guide: the desktop app, not yet checked", "guide: step 3 starts Codex with no flags and trusts the hooks", "guide: a fork starts with sage mode off"].map((k) => [k, true])));
});

test("T462: the guide, the README and the CHANGELOG say what is checked in Codex and what is not (R1665-1, R1665-2, R1664-7, R1664-8)", () => {
  const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8").replace(/\s+/g, " ");
  const guide = read("../docs/guide/codex.md"), readme = read("../README.md");
  const entry = /- \*\*sage on Codex\.\*\*[^\n]*/.exec(readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8"))[0];
  assert.deepEqual({
    "guide: the Codex CLI on PATH, also for a desktop app user": /The Codex CLI on your PATH, in that range, also when you use only the desktop app: .*`npm install -g @openai\/codex@0\.164\.0`/.test(guide),
    "guide: the app's own plugin list is not checked": /An install from the app's own plugin list is not checked yet\./.test(guide),
    "guide: checked on 0.164.0": /checked with the Codex CLI 0\.160\.0, 0\.164\.0 and 0\.166\.0/.test(guide),
    "CHANGELOG: the desktop app should work the same way, not checked yet": /The Codex desktop app should work the same way, but it is not checked yet\./.test(entry) && !/in the CLI and the desktop app/.test(entry),
    "README: no claim that the desktop app is checked": !/the CLI or the desktop app: run/.test(readme),
    "guide: the reviewer writes that the hook does not block": /A write through `git apply`, `git commit`, a script file that `node` or `python` runs, or `make` is not blocked\./.test(guide),
    "guide: full access gives no mode guarantee": /Under full access \(`danger-full-access`\), sage mode gives no guarantee/.test(guide),
    "guide: the sessions folder": /names the Codex sage folder, the shared root or the Codex sessions folder/.test(guide),
  }, Object.fromEntries(["guide: the Codex CLI on PATH, also for a desktop app user", "guide: the app's own plugin list is not checked", "guide: checked on 0.164.0", "CHANGELOG: the desktop app should work the same way, not checked yet",
    "README: no claim that the desktop app is checked", "guide: the reviewer writes that the hook does not block", "guide: full access gives no mode guarantee", "guide: the sessions folder"].map((k) => [k, true])));
});

test("T462: the chief role says what the hooks hold: role agents other than a lead start no agents and record nothing, and each spawn names its run (R1664-3, R1663-2)", async () => {
  const role = contextOf(await session().prompt("sage mode")).replace(/\s+/g, " ");
  assert.match(role, /Other role agents start no agents and record nothing in the logbook: the plugin's hook refuses a role agent's `spawn_agent` and its sage tools that write/);
  assert.match(role, /the task and the run id that `run_add` printed \(for example `sage_implementer_t12_r40` for run R40\)/);
  assert.doesNotMatch(role, /cannot start more agents/);
});

test("T553: the chief role runs one lead for each task, starts the lead, PE and designer, and says what to do on v1 and at the thread limit", async () => {
  const role = contextOf(await session().prompt("sage mode")).replace(/\s+/g, " ");
  for (const row of ["lead", "pe", "designer", "arena-judge"]) assert.match(role, new RegExp(`\\| ${row} \\| `), row);
  assert.match(role, /One lead for each task with a build/);
  assert.match(role, /with the task name `sage_lead_t12_r40` for run R40 \(`sage_lead_t<n>_r<k>`\)/);
  assert.match(role, /The `message` starts with the whole output of `role\.mjs lead`, then the brief/);
  assert.match(role, /You record only this run of the task: the lead records its team's runs, findings and verdicts/);
  assert.match(role, /For `collab spawn failed: agent thread limit reached`, read its \*\*Thread limit\*\*/);
  assert.doesNotMatch(role, /team is flat|Leads come later/);
  const pages = readFileSync(new URL("../plugins/sage-codex/skills/sage/references/roles.md", import.meta.url), "utf8");
  for (const heading of ["## Start a lead", "## The lead's report", "## Thread limit"]) assert.ok(pages.includes(`\n${heading}\n`), heading);
  // Each lead name that the chief reads has its run (F-T552-24): a second lead of a task needs its own name.
  const names = [...`${role}\n${pages}`.matchAll(/sage_lead_t[^\s`)]*/g)].map(([name]) => name);
  assert.ok(names.length >= 3, names.join(", "));
  assert.deepEqual(names.filter((name) => !/_t(?:\d+|<n>)_r(?:\d+|<k>)$/.test(name)), []);
});

test("T603: the chief role holds the pilot's rules: a v2 model only, no fresh lead with no spawn tools, its turn stays open, the real limit message, the approvals", async () => {
  const role = contextOf(await session().prompt("sage mode")).replace(/\s+/g, " ");
  assert.match(role, /sage on Codex needs a multi-agent v2 model for the chief and each child\. With no `spawn_agent` in the `collaboration` namespace, start no agent, and tell the owner to start a new session on a v2 model \(see the guide's What you need\)\./);
  assert.match(role, /Never switch the model during a run/);
  assert.match(role, /When a lead reports that it has no spawn tools, end its run, start no fresh lead, and tell the owner the same fix\./);
  assert.match(role, /Do not end your turn while a child runs: a child's report starts no turn\./);
  assert.match(role, /Call `wait_agent` \(only `timeout_ms`, at most 3600000\) until the report comes as a message in your next input/);
  assert.match(role, /"A child still runs\. Send any message, and one more if its report has not come\."/);
  assert.match(role, /collab spawn failed: agent thread limit reached/);
  assert.match(role, /Git writes and network steps ask the owner for approval, at least 5 clicks in each small task/);
  assert.doesNotMatch(role, /AgentLimitReached|multi-agent v1|do the lead's work/);
  const roles = readFileSync(new URL("../plugins/sage-codex/skills/sage/references/roles.md", import.meta.url), "utf8").replace(/\s+/g, " ");
  assert.match(roles, /A lead that has no spawn tools is the exception: start no fresh lead until the owner says that the session runs on a v2 model\./);
  // F-T603-1: the line comes before the steps that it guards, so a refused `gh pr checks` never reaches the checks-fail step.
  const report = roles.slice(roles.indexOf("## The lead's report"));
  const refusal = report.search(/When the sandbox refuses one, run the same command again with escalated permissions, and wait for the owner\. A sandbox refusal is not a failed check: a check fails only when `gh pr checks` lists it as failed\. When the approval policy is `never` or the owner says no, record no verdict, and tell the owner which step stopped\./);
  assert.ok(refusal > 0 && refusal < report.indexOf("When a check fails, record `checks-fail`"), String(refusal));
});

test("T603: the Codex pages hold no v1 path for a task, and the guide gives the approval count, what the pilot did not prove and the turn rule", () => {
  const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8").replace(/\s+/g, " ");
  const guide = read("../docs/guide/codex.md"), readme = read("../README.md");
  for (const [name, text] of Object.entries({ guide, readme,
    roles: read("../plugins/sage-codex/skills/sage/references/roles.md"), workflow: read("../plugins/sage-codex/skills/sage/references/workflow.md"),
    steps: read("../plugins/sage-codex/skills/sage/references/lead-steps.md"), chief: read("../plugins/sage-codex/runtime/chief-instructions.md") })) {
    assert.doesNotMatch(text, /AgentLimitReached|does the lead's work|do the lead's work|On multi-agent v1|Multi-agent v1\.|only in the `multi_agent_v1`|4 times/, name);
  }
  assert.match(guide, /sage on Codex needs a multi-agent v2 model for the chief and each child\./);
  assert.match(guide, /Codex can ask for permission during ordinary Sage work before the owner merges\./);
  assert.match(guide, /The following count describes the default `workspace-write` sandbox used in the pilot\./);
  assert.match(guide, /The count of 5 is for the first five rows, in one small task with separate commands\./);
  assert.match(guide, /A model that joins `git add` and `git commit` in one command gets one prompt for both\./);
  assert.match(guide, /The sage hook never grants automatic approval through `PermissionRequest`\./);
  assert.match(guide, /\| Read the pull request and its checks \(`gh pr view`, `gh pr checks`\) \| The chief's check of a ready task, before the merge \| It needs the network \|/);
  assert.match(guide, /- A multi-agent v2 model for the chief and each child\. In Codex 0\.164\.0's bundled catalog, the `gpt-6-sol` models are v2, and `gpt-5\.6-luna` is not/);
  const needs = guide.slice(guide.indexOf("## What you need"), guide.indexOf("## Install"));
  assert.doesNotMatch(needs, /gpt-5\.5/, "seen only from one spawn output");
  assert.match(guide, /\*\*`writable_roots` and the network: not proved\.\*\* sage keeps Codex's defaults, and it does not recommend this option/);
  assert.match(guide, /`git worktree add -b` failed in the sandbox, but it left the branch\. 2\. The escalated retry stopped with `a branch named 'sage\/t1-demo' already exists`, so no worktree came to exist\./);
  assert.match(guide, /\*\*Not proved yet:\*\* - An escalated push under a strict sandbox\./);
  assert.doesNotMatch(guide, /Opt in to fewer prompts|writable_roots = /);
  assert.doesNotMatch(readme, /option for fewer prompts/);
  assert.match(guide, /With `approval_policy = "never"`, Codex refuses each escalation, so a build cannot commit/);
  assert.match(guide, /A child's report starts no turn in Codex\./);
  assert.match(guide, /fails with `collab spawn failed: agent thread limit reached`/);
  assert.match(readme, /at least 5 times in each small task/);
});

/** The shared chief text as the build writes it, after the Codex preface; the Markdown file adds its own final newline. */
const CHIEF = readFileSync(new URL("../plugins/sage-codex/runtime/chief-instructions.md", import.meta.url), "utf8").split("\n---\n\n")[1].slice(0, -1);
// Codex 0.164.0 counts hook context as ceil(bytes / 4) tokens and cuts it above the hook's limit: 6000 tokens in
// hooks.json, 2500 for an mcp_tool hook (codex-rs utils/string/src/truncate.rs, hooks/src/output_spill.rs).
test("T494: the chief role reaches the chief whole, with 2000 bytes left under the real Codex limit, on activation and after compaction", async () => {
  const s = session();
  const roles = [contextOf(await s.prompt("sage mode")), contextOf(await s.start("compact"), "SessionStart")];
  for (const role of roles) {
    assert.match(role, ROLE);
    assert.ok(role.endsWith(CHIEF) || role.includes(`${CHIEF}\n\n---\n\n`), "the whole chief text");
    assert.ok(Buffer.byteLength(role) + 2000 <= 6000 * 4, `${Buffer.byteLength(role)} bytes, ${6000 * 4 - Buffer.byteLength(role)} left of 24000`);
  }
});

test("T494: the native chief parts join to the whole chief text, each part at most 10000 bytes, and a text too long refuses with its size", () => {
  const strip = (part) => part.replace(/^Sage chief instructions: part [12] of 2\n\n/, "");
  const text = CHIEF;
  const parts = chiefInstructionParts();
  assert.equal(parts.length, 2);
  assert.equal(parts.map(strip).join(""), text);
  assert.ok(parts.every((part) => Buffer.byteLength(part) <= 10_000), parts.map((part) => Buffer.byteLength(part)).join(", "));
  assert.ok(Buffer.byteLength(parts[1]) + 2000 <= 10_000, `${10_000 - Buffer.byteLength(parts[1])} bytes left in part 2`);
  assert.throws(() => chiefInstructionParts(text + "An extra rule.\n".repeat(400)), {
    message: `Sage chief instructions are ${Buffer.byteLength(text) + 6000} bytes and do not fit in 2 native hook parts of 10000 bytes: shorten the chief text` });
  assert.throws(() => chiefInstructionParts("x".repeat(10_000)), /do not fit in 2 native hook parts/, "one line longer than a part");
});
