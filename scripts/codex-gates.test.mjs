import "./test-env.mjs"; // first: no variable of the developer's shell changes a result
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { history } from "./fixtures/merge-history.mjs";

// The Codex gates (T456), through Codex's PreToolUse and PermissionRequest input and output shapes. The pure tests give
// the gate a fixed mode and merge check; the process tests run the built hook with a mode file, a logbook and a fake gh.
const HOOK = fileURLToPath(new URL("../plugins/sage-codex/hooks/gate-hook.mjs", import.meta.url));
const TOOL = fileURLToPath(new URL("../plugins/sage-codex/skills/sage/sage.mjs", import.meta.url));
const { gate, readMode, typedModes, namesSageFolder, resumesSession, codexRuns } = await import(HOOK);
// Codex adds ". Command: <the command>" after a refusal reason, so no reason ends with a period (F-T470-6).
const UNREADABLE = "sage: the hook could not read this tool call, so it refuses it. Codex may have changed its hook input: update the sage plugin, or tell the user";
const { stateKey } = await import(new URL("../plugins/sage-codex/hooks/principles-hook.mjs", import.meta.url));

const SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const MERGE = `gh pr merge 41 --squash --delete-branch --match-head-commit ${SHA}`;
const CWD = "/work/project";
const base = { session_id: "019a0000-0000-7000-8000-000000000001", turn_id: "t1", transcript_path: null, cwd: CWD, model: "m", permission_mode: "default" };
const pre = (tool_name, command, extra = {}) => ({ ...base, hook_event_name: "PreToolUse", tool_name, tool_use_id: "call_1", tool_input: { command }, ...extra });
const ask = (command, extra = {}) => ({ ...base, hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command, description: "needs network" }, ...extra });
const patch = (...lines) => `*** Begin Patch\n${lines.join("\n")}\n*** End Patch`;
const CHILD = { agent_id: "agent-1", agent_type: "worker" };
const denied = (out) => (out?.hookSpecificOutput?.permissionDecision === "deny" ? out.hookSpecificOutput.permissionDecisionReason : undefined);
const ALLOW = { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } };
const BAD_NAME = (name) => `sage: "${name}" starts with sage_ but is not a sage task name (sage_<role>_t<n>_r<k>), so this agent counts as a read-only role: it changes no files. Report instead`;
const RO = (role) => `sage: in sage mode, the ${role} agent changes no files. Report the finding instead`;
const LOGBOOK = "sage: role agents report; only the chief records the logbook. Put this in your report";
const SPAWN = "sage: role agents start no agents; only the chief does. Put what you need in your report";
const CHILD_CODEX = "sage: role agents never start Codex from the shell, because a new Codex session runs outside the hooks of this session. Put what you need in your report";
const UNREAD_CODEX = "sage: the hook could not read this shell command, and it names codex, so it refuses it. Write the command in a plainer form";
/** A call of a tool of the plugin's sage MCP server, as Codex gives it to PreToolUse: mcp__sage__<tool>, with the call's arguments. */
const mcp = (name, args = {}, extra = {}) => ({ ...base, hook_event_name: "PreToolUse", tool_name: `mcp__sage__${name}`, tool_use_id: "call_1", tool_input: { project: CWD, ...args }, ...extra });

/** A gate with a fixed mode and merge check; checks counts the merge checks it ran. */
function fixed({ sage = true, autopilot = false, ok = true } = {}) {
  const checks = [];
  const deps = { mode: () => ({ sage, autopilot: sage && autopilot }), check: async (merge) => (checks.push(merge), ok ? { ok: true } : { ok: false, reason: "sage: the merge check refuses: no verdicts recorded" }) };
  return { run: (input) => gate(input, deps), checks };
}

test("an input shape that the gate does not know is denied with one line, and a request gets no decision", async () => {
  const g = fixed({ sage: false });
  for (const input of [null, "text", {}, { ...pre("Bash", "ls"), session_id: undefined }, { ...pre("Bash", "ls"), cwd: "relative" },
    pre("Bash", ["ls"]), { ...pre("Bash", "ls"), tool_input: null }, pre("Bash", "ls", { agent_id: 7 }), pre("Write", "x")]) {
    const out = await g.run(input);
    assert.equal(denied(out), UNREADABLE, JSON.stringify(input));
    assert.doesNotMatch(denied(out), /\n/);
  }
  assert.deepEqual(await g.run({ ...ask(MERGE), tool_input: { command: ["gh"] } }), { systemMessage: "sage: the hook could not read this approval request, so Codex asks you." });
  assert.equal(await g.run(pre("Bash", "ls")), undefined, "a readable call with no rule passes");
});

test("no refusal reason ends with a period, because Codex adds \". Command: …\" after it (F-T470-6)", async () => {
  const g = fixed({ sage: true });
  const reasons = {
    unreadable: denied(await g.run(null)),
    chief: denied(await g.run(pre("apply_patch", patch("*** Update File: src/a.js", "@@", "-a", "+b")))),
    codexFolder: denied(await g.run(pre("apply_patch", patch("*** Add File: .codex/config.toml", "+x")))),
    sageFolder: denied(await g.run(pre("Bash", "ls ~/.codex/sage"))),
    resume: denied(await g.run(pre("Bash", "codex resume --last"))),
    logbook: denied(await g.run(mcp("verdict", { task: "T1" }, CHILD))),
    spawn: denied(await g.run({ ...base, ...CHILD, hook_event_name: "PreToolUse", tool_name: "spawn_agent", tool_use_id: "call_1", tool_input: { task_name: "x", message: "y" } })),
    push: denied(await g.run(pre("Bash", "git push --force origin main"))),
    mergeForm: denied(await g.run(pre("Bash", "gh pr merge 41"))),
    autopilotOff: denied(await g.run(pre("Bash", MERGE))),
  };
  for (const [name, reason] of Object.entries(reasons)) {
    assert.match(reason ?? "", /^sage: /, name);
    assert.doesNotMatch(reason, /\.$/, `${name}: ${reason}`);
  }
  assert.equal(reasons.chief, 'sage: sage mode is on, so the chief does not change files. Brief an implementer to make this change. The user ends sage mode with the message "sage mode off", alone');
});

test("no thread changes files under a .codex folder, in any mode", async () => {
  for (const mode of [{ sage: false }, { sage: true }]) {
    const g = fixed(mode);
    for (const extra of [{}, CHILD]) {
      for (const p of [patch("*** Add File: .codex/config.toml", "+[mcp_servers.x]"), patch("*** Update File: sub/.CODEX/hooks.json", "@@", "-a", "+b"),
        patch("*** Update File: src/a.js", "*** Move to: .codex/a.js", "@@", "-a", "+b"), patch(`*** Delete File: ${CWD}/.codex`)]) {
        assert.match(denied(await g.run(pre("apply_patch", p, extra))) ?? "", /^sage: no agent changes files under a \.codex folder/, p);
      }
      for (const command of ["echo x > .codex/config.toml", "printf '[x]' >> ~/.codex/config.toml", "cp /tmp/c .codex/config.toml", "sed -i '' s/a/b/ .codex/config.toml"]) {
        assert.match(denied(await g.run(pre("Bash", command, extra))) ?? "", /^sage: no agent changes files under a \.codex folder/, command);
      }
    }
  }
  const g = fixed({ sage: false });
  assert.equal(await g.run(pre("apply_patch", patch("*** Add File: .codexrc", "+x"))), undefined, "a name that only starts with .codex");
  for (const command of ["cat .codex/config.toml", "ls -la .codex", "echo x > notes.txt"]) assert.equal(await g.run(pre("Bash", command)), undefined, command);
  assert.match(denied(await g.run(pre("apply_patch", "not a patch"))) ?? "", /could not read this patch/);
});

/** A Codex record of a thread (the session_meta line), in a file of its own, as transcript_path names it. */
function record(t, payload) {
  const dir = mkdtempSync(join(tmpdir(), "sage-codex-record-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "rollout.jsonl");
  writeFileSync(file, JSON.stringify({ type: "session_meta", payload }) + "\n");
  return file;
}

test("in sage mode the chief changes no file, and a child may", async (t) => {
  const p = patch("*** Update File: src/a.js", "@@", "-a", "+b");
  assert.equal(denied(await fixed({ sage: true }).run(pre("apply_patch", p))), 'sage: sage mode is on, so the chief does not change files. Brief an implementer to make this change. The user ends sage mode with the message "sage mode off", alone');
  const child = record(t, { id: "child", session_id: base.session_id, agent_path: "/root/worker_1", source: { subagent: { thread_spawn: { depth: 1 } } } });
  assert.equal(await fixed({ sage: true }).run(pre("apply_patch", p, { ...CHILD, transcript_path: child })), undefined, "a child edits");
  assert.equal(await fixed({ sage: true }).run(pre("apply_patch", p, { agent_id: "", transcript_path: child })), undefined, "an empty agent_id is a child too");
  assert.equal(await fixed({ sage: false }).run(pre("apply_patch", p)), undefined, "outside sage mode the root edits");
});

test("Codex's own threads (review, guardian) share the session id and have no agent_id, but count as read-only role agents in every rule (R1669-1)", async (t) => {
  const session = base.session_id;
  const root = record(t, { id: session, session_id: session, source: "cli", cli_version: "0.164.0" });
  const threads = {
    review: record(t, { id: "019a0000-0000-7000-8000-0000000000aa", session_id: session, source: { subagent: "review" } }),
    guardian: record(t, { id: "019a0000-0000-7000-8000-0000000000bb", session_id: session, source: { subagent: { other: "guardian" } } }),
    internal: record(t, { id: "019a0000-0000-7000-8000-0000000000cc", session_id: session, source: { internal: "guardian" } }),
    "other id": record(t, { id: "019a0000-0000-7000-8000-0000000000dd", session_id: session, source: "cli" }),
  };
  const p = patch("*** Update File: src/a.js", "@@", "-a", "+b");
  const spawn = { ...base, hook_event_name: "PreToolUse", tool_name: "spawn_agent", tool_use_id: "call_1", tool_input: { task_name: "x", message: "y" } };
  for (const sage of [false, true]) {
    const g = fixed({ sage, autopilot: true });
    // The root thread, with its own record: the chief.
    assert.equal(await g.run(mcp("verdict", { task: "T1", kind: "review-clean", sha: SHA }, { transcript_path: root })), undefined, "the chief records the logbook");
    assert.equal(await g.run({ ...spawn, transcript_path: root }), undefined, "the chief starts agents");
    for (const [name, transcript_path] of Object.entries(threads)) {
      const extra = { transcript_path };
      const role = { review: "Codex review", guardian: "Codex approval check", internal: "Codex approval check" }[name];
      const got = {
        verdict: denied(await g.run(mcp("verdict", { task: "T1", kind: "review-clean", sha: SHA, cycle: 1, pr: 41 }, extra))),
        gate_answer: denied(await g.run(mcp("gate_answer", { gate: "G1", option: 1 }, extra))),
        status: denied(await g.run(mcp("status", {}, extra))),
        spawn: denied(await g.run({ ...spawn, ...extra })),
        codex: denied(await g.run(pre("Bash", "codex exec hi", extra))),
        edit: denied(await g.run(pre("apply_patch", p, extra))),
        merge: denied(await g.run(pre("Bash", MERGE, extra))),
      };
      const UNREAD = /^sage: the hook could not read this agent's task name/;
      assert.equal(got.verdict, LOGBOOK, name);
      assert.equal(got.gate_answer, LOGBOOK, name);
      assert.equal(got.status, undefined, `${name}: a read passes`);
      if (role) {
        assert.equal(got.spawn, SPAWN, name);
        assert.equal(got.codex, CHILD_CODEX, name);
        assert.equal(got.edit, sage ? RO(role) : undefined, name);
      } else {
        for (const key of ["spawn", "codex"]) assert.match(got[key] ?? "", UNREAD, `${name} ${key}`);
        if (sage) assert.match(got.edit ?? "", UNREAD, name);
      }
      assert.equal(got.merge, sage ? "sage: an agent never merges. Report the pull request as ready" : undefined, name);
      assert.equal(await g.run({ ...ask(MERGE), transcript_path }), undefined, `${name}: no approval decision`);
    }
  }
});

test("a child with an agent_id and no transcript fails closed: read-only, it starts no agent and no Codex (R1669-5)", async () => {
  const g = fixed({ sage: true });
  const p = patch("*** Update File: src/a.js", "@@", "-a", "+b");
  const spawn = { ...base, ...CHILD, hook_event_name: "PreToolUse", tool_name: "spawn_agent", tool_use_id: "call_1", tool_input: { task_name: "x", message: "y" } };
  const UNREAD = "sage: the hook could not read this agent's task name from Codex's record of its thread, so it refuses this call. Tell the user";
  assert.deepEqual([denied(await g.run(pre("apply_patch", p, CHILD))), denied(await g.run(pre("Bash", "echo x > notes.txt", CHILD))), denied(await g.run(spawn)), denied(await g.run(pre("Bash", "codex exec hi", CHILD)))],
    [UNREAD, UNREAD, UNREAD, UNREAD]);
  assert.equal(denied(await g.run(pre("Bash", "npm test", CHILD))), undefined, "it still runs the checks");
  assert.equal(denied(await fixed({ sage: false }).run(pre("apply_patch", p, CHILD))), undefined, "outside sage mode the role rule does not act");
  const unread = "sage: the hook could not read Codex's record of this thread, so it refuses this call. Tell the user";
  assert.equal(denied(await g.run(mcp("verdict", { task: "T1" }, { transcript_path: "/none/rollout.jsonl" }))), unread, "a thread with no agent_id and a record that the hook cannot read");
  assert.equal(await g.run(mcp("verdict", { task: "T1" })), undefined, "an ephemeral root thread (no transcript) is the chief");
});

test("a chief's transcript over Node's string limit still reads as the chief; a first line over 1 MiB fails closed (R1675-5)", async (t) => {
  const g = fixed({ sage: true });
  const long = record(t, { id: base.session_id });
  truncateSync(long, 600 * 2 ** 20); // sparse: the 600 MiB after the first line cost no disk
  assert.equal(await g.run(mcp("verdict", { task: "T1" }, { transcript_path: long })), undefined, "a long session keeps its logbook tools");
  const wide = record(t, { id: base.session_id, base_instructions: "a".repeat(2 ** 20) });
  assert.equal(denied(await g.run(mcp("verdict", { task: "T1" }, { transcript_path: wide }))),
    "sage: the hook could not read Codex's record of this thread, so it refuses this call. Tell the user");
});

test("a merge runs only on the root thread, with autopilot on and a passing merge check", async () => {
  const off = fixed({ autopilot: false });
  assert.equal(denied(await off.run(pre("Bash", MERGE))), 'sage: autopilot is off, so the user merges. Report the pull request as ready. The user turns it on with the message "autopilot on", alone');
  assert.equal(off.checks.length, 0, "autopilot off refuses before the merge check");
  const failing = fixed({ autopilot: true, ok: false });
  assert.equal(denied(await failing.run(pre("Bash", MERGE))), "sage: the merge check refuses: no verdicts recorded");
  assert.deepEqual(failing.checks, [{ pr: "41", sha: SHA }]);
  const passing = fixed({ autopilot: true });
  assert.equal(await passing.run(pre("Bash", MERGE)), undefined, "the verified merge runs");
  assert.equal(denied(await passing.run(pre("Bash", MERGE, CHILD))), "sage: an agent never merges. Report the pull request as ready");
  for (const command of [`gh pr merge 41 --squash --match-head-commit ${SHA}`, "gh pr merge 41 --squash --delete-branch", `${MERGE} && echo done`, `bash -c "${MERGE}"`, "gh api -X PUT repos/o/r/pulls/41/merge"]) {
    assert.match(denied(await passing.run(pre("Bash", command))) ?? "", /^sage: (?:merge only|the hook cannot prove)/, command);
  }
  assert.equal(passing.checks.length, 1, "only the exact form reaches the merge check");
  assert.equal(await fixed({ sage: false }).run(pre("Bash", MERGE)), undefined, "outside sage mode the gate does not judge merges");
});

test("the approval request of the verified merge is allowed; every other request gets no decision", async () => {
  const passing = fixed({ autopilot: true });
  assert.deepEqual(await passing.run(ask(MERGE)), ALLOW);
  for (const input of [ask(MERGE, CHILD), ask("curl https://example.com"), ask(`${MERGE} && echo done`), ask(`gh pr merge 41 --merge --match-head-commit ${SHA}`), { ...ask(MERGE), tool_name: "apply_patch" }]) {
    assert.equal(await passing.run(input), undefined, JSON.stringify(input.tool_input));
  }
  assert.equal(passing.checks.length, 1);
  assert.equal(await fixed({ autopilot: false }).run(ask(MERGE)), undefined, "autopilot off: Codex asks the user");
  assert.equal(await fixed({ autopilot: true, ok: false }).run(ask(MERGE)), undefined, "a failing check: Codex asks the user");
});

/** A git checkout on the task's branch, a sage home and a fake gh that answers gh pr view and logs every call. */
function world(t, { at = "project" } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "sage-codex-gate-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const project = join(dir, at), bin = join(dir, "bin");
  mkdirSync(bin);
  mkdirSync(project, { recursive: true });
  spawnSync("git", ["init", "-q", "-b", "sage/t1", project]);
  spawnSync("git", ["-C", project, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "start"]);
  writeFileSync(join(bin, "gh"), `#!/bin/sh\necho "$@" >> "${dir}/gh-calls.log"\n[ "$1 $2" = "pr view" ] && printf '{"headRefName":"sage/t1","isCrossRepository":false,"baseRefOid":"%s"}' "$(cat "${dir}/base" 2>/dev/null)"\nexit 0\n`);
  chmodSync(join(bin, "gh"), 0o755);
  for (const name of ["ps", "pgrep", "kill"]) writeFileSync(join(bin, name), `#!/bin/sh\necho ${name} >> "${dir}/fake-calls.log"\n`, { mode: 0o755 }); // order 14
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: join(dir, "home"), SAGE_HOME: join(dir, "sage"), CODEX_HOME: join(dir, "codex-home") };
  const sage = (...args) => spawnSync(process.execPath, [TOOL, ...args, "--project", project], { encoding: "utf8", env });
  // Codex's transcript of the root thread: the user's typed messages, as item_completed events with a UserMessage item.
  const transcript = join(dir, "rollout.jsonl");
  const typed = (...messages) => writeFileSync(transcript, [{ type: "session_meta", payload: { id: base.session_id } },
    ...messages.map((text) => ({ type: "event_msg", payload: { type: "item_completed", thread_id: base.session_id, item: { type: "UserMessage", content: [{ type: "text", text }] } } }))]
    .map((line) => JSON.stringify(line)).join("\n") + "\n");
  typed();
  /** A child's transcript whose first line names its agent path, as Codex writes it. */
  const child = (path) => {
    const file = join(dir, `child-${path.split("/").at(-1)}.jsonl`);
    writeFileSync(file, JSON.stringify({ type: "session_meta", payload: { id: "child", agent_path: path } }) + "\n");
    return { ...CHILD, transcript_path: file };
  };
  const mode = (state) => {
    const folder = join(env.SAGE_HOME, ".hooks", "codex");
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    writeFileSync(join(folder, `${stateKey({ session_id: base.session_id })}.json`), JSON.stringify(state), { mode: 0o600 });
    return folder;
  };
  const send = (input) => {
    const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ ...input, transcript_path: input.transcript_path ?? transcript, cwd: project }), encoding: "utf8", env, timeout: 60_000 });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout ? JSON.parse(r.stdout) : undefined;
  };
  return { dir, project, env, sage, mode, send, typed, child, transcript };
}

test("the hook process reads the mode file and the ledger: a verified merge passes and its request is allowed", (t) => {
  const w = world(t);
  w.typed("sage mode", "autopilot on");
  w.mode({ sage: true, autopilot: false });
  assert.match(denied(w.send(pre("Bash", MERGE))) ?? "", /^sage: autopilot is off/);
  assert.equal(w.send(ask(MERGE)), undefined);
  w.mode({ sage: true, autopilot: true });
  assert.match(denied(w.send(pre("Bash", MERGE))) ?? "", /^sage: the merge check refuses: /, "no verdicts yet");
  assert.equal(w.send(ask(MERGE)), undefined, "a failing check leaves the prompt to Codex");
  assert.equal(w.sage("init").status, 0);
  assert.equal(w.sage("task", "add", "--priority", "P2", "--title", "t", "--size", "small").status, 0);
  for (const kind of ["checks-pass", "review-clean", "qa-pass"]) assert.equal(w.sage("verdict", "T1", "--sha", SHA, "--kind", kind, "--cycle", "1", "--pr", "41").status, 0);
  assert.equal(w.send(pre("Bash", MERGE)), undefined, "the verified merge runs");
  assert.deepEqual(w.send(ask(MERGE)), ALLOW, "and Codex shows no prompt for it");
  assert.match(denied(w.send(pre("Bash", MERGE, CHILD))) ?? "", /^sage: an agent never merges/);
  w.mode({ sage: false, autopilot: true });
  assert.equal(w.send(ask(MERGE)), undefined, "autopilot counts only in sage mode");
  assert.match(denied(w.send(pre("apply_patch", patch("*** Add File: .codex/config.toml", "+x")))) ?? "", /^sage: no agent changes files under a \.codex folder/);
  assert.equal(denied(w.send("{not json")), UNREADABLE);
});

test("the Codex merge rule keeps the verdicts over a clean merge of main, through core's merge check (T493)", (t) => {
  const w = world(t);
  w.typed("sage mode", "autopilot on");
  w.mode({ sage: true, autopilot: true });
  const h = history(w.project);
  h.start();
  const h0 = h.work({ "src.js": "a\nb\n", "CHANGELOG.md": "- task\n- base\n" });
  assert.equal(w.sage("init").status, 0);
  assert.equal(w.sage("task", "add", "--priority", "P2", "--title", "t", "--size", "small").status, 0);
  for (const kind of ["checks-pass", "review-clean", "qa-pass"]) assert.equal(w.sage("verdict", "T1", "--sha", h0, "--kind", kind, "--cycle", "1", "--pr", "41").status, 0);
  const h1 = h.merge(h.main({ "CHANGELOG.md": "- main\n- base\n" }), { "CHANGELOG.md": "- task\n- main\n- base\n" });
  const merge = `gh pr merge 41 --squash --delete-branch --match-head-commit ${h1}`;
  assert.equal(w.sage("verdict", "T1", "--sha", h1, "--kind", "checks-pass", "--cycle", "1", "--pr", "41").status, 0);
  assert.match(denied(w.send(pre("Bash", merge))) ?? "", /do not carry over: the merge check has no base commit of the pull request from GitHub/, "gh gives no base commit");
  writeFileSync(join(w.dir, "base"), h.git("rev-parse", "main")); // the base commit on GitHub, which gh pr view gives
  assert.equal(w.send(pre("Bash", merge)), undefined, "the merge of main keeps the reviewed head's verdicts");
  const evil = h.merge(h.main({ "other.js": "m\n" }), { "src.js": "a\nb\nevil\n" });
  writeFileSync(join(w.dir, "base"), h.git("rev-parse", "main"));
  assert.equal(w.sage("verdict", "T1", "--sha", evil, "--kind", "checks-pass", "--cycle", "1", "--pr", "41").status, 0);
  assert.match(denied(w.send(pre("Bash", `gh pr merge 41 --squash --delete-branch --match-head-commit ${evil}`))) ?? "", /^sage: the merge check refuses: T1: 0 of 1 clean cycles on this SHA; .* do not carry over: the merge changes "src\.js" otherwise than/);
});

test("the core reader of the mode file: no file is no mode, and a damaged file or a link is off (one rule with the mode hook)", (t) => {
  const w = world(t);
  const at = { session: base.session_id, transcript: w.transcript };
  w.typed("sage mode", "autopilot on");
  assert.deepEqual(readMode(at, w.env), { sage: false, autopilot: false }, "no file is no mode");
  const folder = w.mode({ sage: true, autopilot: true });
  assert.deepEqual(readMode(at, w.env), { sage: true, autopilot: true });
  const file = join(folder, `${stateKey({ session_id: base.session_id })}.json`);
  writeFileSync(file, "{not json");
  assert.deepEqual(readMode(at, w.env), { sage: false, autopilot: false }, "a damaged file is off");
  rmSync(file);
  writeFileSync(join(folder, "other.json"), JSON.stringify({ sage: true, autopilot: true }));
  symlinkSync(join(folder, "other.json"), file);
  assert.deepEqual(readMode(at, w.env), { sage: false, autopilot: false }, "a link is not read");
  assert.equal(w.send(pre("apply_patch", patch("*** Update File: a.js", "@@", "-a", "+b"))), undefined, "off: the root edits");
  assert.equal(w.send(pre("Bash", MERGE)), undefined, "off: the gate does not judge merges");
});

test("a forged mode file alone unlocks no merge: autopilot also needs the user's typed messages in Codex's transcript (T460)", (t) => {
  const w = world(t);
  w.mode({ sage: true, autopilot: true });
  assert.equal(w.sage("init").status, 0);
  assert.equal(w.sage("task", "add", "--priority", "P2", "--title", "t", "--size", "small").status, 0);
  for (const kind of ["checks-pass", "review-clean", "qa-pass"]) assert.equal(w.sage("verdict", "T1", "--sha", SHA, "--kind", kind, "--cycle", "1", "--pr", "41").status, 0);
  const cases = [["no transcript", null], ["no typed phrase", []], ["sage mode only", ["sage mode"]], ["autopilot before sage mode", ["autopilot on", "sage mode"]],
    ["autopilot off last", ["sage mode", "autopilot on", "autopilot off"]], ["sage mode off last", ["sage mode", "autopilot on", "sage mode off"]], ["a phrase inside a message", ["sage mode", "please autopilot on now"]], ["typed", ["sage mode", "autopilot on"]]];
  const got = cases.map(([why, messages]) => {
    if (messages) w.typed(...messages);
    const input = messages ? {} : { transcript_path: join(w.dir, "none.jsonl") };
    return [why, denied(w.send(pre("Bash", MERGE, input)))?.slice(0, 25) ?? "runs", w.send(ask(MERGE, input))?.hookSpecificOutput?.decision?.behavior ?? "prompt"];
  });
  const off = "sage: autopilot is off, s";
  assert.deepEqual(got, [["no transcript", "sage: the hook could not ", "prompt"], ["no typed phrase", off, "prompt"], ["sage mode only", off, "prompt"], ["autopilot before sage mode", off, "prompt"],
    ["autopilot off last", off, "prompt"], ["sage mode off last", off, "prompt"], ["a phrase inside a message", off, "prompt"], ["typed", "runs", "allow"]]);
  const other = { type: "event_msg", payload: { type: "item_completed", thread_id: "another-thread", item: { type: "UserMessage", content: [{ type: "text", text: "autopilot on" }] } } };
  writeFileSync(w.transcript, ["sage mode"].map((text) => JSON.stringify({ ...other, payload: { ...other.payload, thread_id: base.session_id, item: { ...other.payload.item, content: [{ type: "text", text }] } } })).concat(JSON.stringify(other)).join("\n"));
  assert.deepEqual(typedModes(w.transcript, base.session_id), { sage: true, autopilot: false }, "a message of another thread (a fork's copied history) does not count");
});

test("typed messages count in a transcript over Node's string limit, in lines across piece ends and in CRLF lines (F-T473-1)", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "sage-typed-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const typed = (text, thread = base.session_id) => JSON.stringify({ type: "event_msg", payload: { type: "item_completed", thread_id: thread, item: { type: "UserMessage", content: [{ type: "text", text }] } } });
  const meta = JSON.stringify({ type: "session_meta", payload: { id: base.session_id } });
  const file = (name, text) => { writeFileSync(join(dir, name), text); return join(dir, name); };
  // 600 MiB: the first line, a sparse gap of zero bytes (no disk), then the typed messages after it.
  const long = file("long.jsonl", `${meta}\n`);
  truncateSync(long, 600 * 2 ** 20);
  appendFileSync(long, `\n${typed("sage mode")}\n${typed("autopilot on")}\n`);
  const started = performance.now();
  assert.deepEqual(typedModes(long, base.session_id), { sage: true, autopilot: true }, "a 600 MiB session");
  console.log(`typedModes, 600 MiB sparse transcript: ${Math.round(performance.now() - started)} ms`); // evidence only: no time limit (order 26)
  appendFileSync(long, `${typed("autopilot off")}\n`);
  assert.deepEqual(typedModes(long, base.session_id), { sage: true, autopilot: false }, "the off phrase after the gap counts too");
  // A thread id of 3 MiB of 3-byte characters: each line crosses piece ends, and some ends cut a character in two.
  const wide = `s-${"€".repeat(2 ** 20)}`;
  assert.deepEqual(typedModes(file("wide.jsonl", `${meta}\n${typed("sage mode", wide)}\n${typed("autopilot on", wide)}`), wide), { sage: true, autopilot: true }, "lines across pieces");
  assert.deepEqual(typedModes(file("crlf.jsonl", `${meta}\r\n${typed("sage mode")}\r\n${typed("autopilot on")}\r\n`), base.session_id), { sage: true, autopilot: true }, "CRLF lines");
});

test("no thread names the Codex sage folder in a shell command, or resumes or forks a Codex session (T460)", (t) => {
  const w = world(t);
  const home = w.env.HOME;
  const env = { ...w.env, SAGE_HOME: undefined, CODEX_HOME: join(home, ".codex") };
  const named = ["cat ~/.codex/sage/.hooks/codex/x.json", `echo '{}' > "${home}/.codex/sage/.hooks/codex/x.json"`, "ls $HOME/.codex/sage", "rm -rf ${CODEX_HOME}/sage",
    "cp f $SAGE_HOME/x", "echo > .hooks/codex/a.json", `ls ${home.toUpperCase()}/.CODEX/SAGE`];
  const clean = ["ls ~/.codex/sagebook", `node ${home}/.codex/plugins/cache/sage/sage/0.1.0/skills/sage/sage.mjs status --project /p`, "echo sage mode", "git log"];
  assert.deepEqual(named.filter((c) => !namesSageFolder(c, env)), [], "each form is found");
  assert.deepEqual(clean.filter((c) => namesSageFolder(c, env)), [], "no false match");
  const resumes = ["codex resume --last", "codex exec resume abc 'autopilot on'", "/opt/homebrew/bin/codex fork abc", "FOO=1 codex resume", "cd /p && env codex exec --json resume --last hi",
    `bash -c "codex resume --last"`, "timeout 5 codex fork abc"];
  const others = ["codex exec 'hello'", "git commit -m 'codex resume notes'", "echo codex resume", "codex --version"];
  assert.deepEqual(resumes.filter((c) => !resumesSession(c)), []);
  assert.deepEqual(others.filter((c) => resumesSession(c)), []);
  for (const mode of [{ sage: false, autopilot: false }, { sage: true, autopilot: true }]) {
    w.mode(mode);
    for (const extra of [{}, CHILD]) {
      assert.match(denied(w.send(pre("Bash", `cat ${w.env.SAGE_HOME}/.hooks/codex/x.json`, extra))) ?? "", /^sage: no agent runs a shell command that names the Codex sage folder/);
      assert.match(denied(w.send(pre("Bash", "codex exec resume --last 'autopilot on'", extra))) ?? "", /^sage: no agent resumes or forks a Codex session/);
      assert.equal(denied(w.send(pre("Bash", "echo 'unclosed | codex resume", extra))), "sage: the hook could not read this shell command, and it names codex, so it refuses it. Write the command in a plainer form");
    }
  }
});

test("in sage mode a child whose task name names a read-only role changes no file; an implementer and an unnamed child may", (t) => {
  const w = world(t);
  const p = patch("*** Update File: src/a.js", "@@", "-a", "+b");
  w.mode({ sage: true, autopilot: false });
  const got = ["sage_code_reviewer_t3", "sage_security_reviewer_t3", "sage_ux_reviewer_t3", "sage_qa_t3", "sage_pe_t3", "sage_lead_t3", "sage_implementer_t3", "sage_designer_t3", "worker_1", "sage_unknown_t3"]
    .map((name) => [name, denied(w.send(pre("apply_patch", p, w.child(`/root/${name}`)))) ?? "edits"]);
  const ro = (role) => `sage: in sage mode, the ${role} agent changes no files. Report the finding instead`;
  assert.deepEqual(got.slice(0, 9), [["sage_code_reviewer_t3", ro("code-reviewer")], ["sage_security_reviewer_t3", ro("security-reviewer")], ["sage_ux_reviewer_t3", ro("ux-reviewer")], ["sage_qa_t3", ro("qa")], ["sage_pe_t3", ro("pe")], ["sage_lead_t3", ro("lead")],
    ["sage_implementer_t3", "edits"], ["sage_designer_t3", "edits"], ["worker_1", "edits"]]);
  assert.equal(got[9][1], BAD_NAME("sage_unknown_t3"), "a sage_ name with an unknown role fails closed");
  assert.match(denied(w.send(pre("apply_patch", p, { ...CHILD, transcript_path: join(w.dir, "none.jsonl") }))) ?? "", /^sage: the hook could not read this agent's task name/);
  assert.equal(w.send(pre("Bash", "npm test", w.child("/root/sage_qa_t3"))), undefined, "QA still runs commands");
  w.mode({ sage: false, autopilot: false });
  assert.equal(w.send(pre("apply_patch", p, w.child("/root/sage_qa_t3"))), undefined, "outside sage mode the role rule does not act");
});

test("in sage mode a read-only role writes no file from the shell either; it still reads and runs the checks (T462)", (t) => {
  const w = world(t);
  w.mode({ sage: true, autopilot: false });
  const writes = ["echo x > notes.txt", "printf 'a' >> src/a.js", "sed -i '' s/a/b/ src/a.js", "cp a.js b.js", "tee review.md < /dev/null", `node -e "require('fs').writeFileSync('x','y')"`, `bash -c "rm -f src/a.js"`];
  const reads = ["cat src/a.js", "git diff main", "npm test", "grep -rn codex src", "ls -la", "echo done"];
  const ro = (role) => `sage: in sage mode, the ${role} agent changes no files. Report the finding instead`;
  for (const [name, role] of [["sage_code_reviewer_t3", "code-reviewer"], ["sage_qa_t3", "qa"], ["sage_pe_t3", "pe"]]) {
    assert.deepEqual(writes.map((c) => denied(w.send(pre("Bash", c, w.child(`/root/${name}`))))), writes.map(() => ro(role)), name);
    assert.deepEqual(reads.map((c) => denied(w.send(pre("Bash", c, w.child(`/root/${name}`))))), reads.map(() => undefined), name);
  }
  for (const name of ["sage_implementer_t3", "worker_1"]) assert.equal(denied(w.send(pre("Bash", writes[0], w.child(`/root/${name}`)))), undefined, name);
  assert.equal(denied(w.send(pre("Bash", writes[0], w.child("/root/sage_unknown_t3")))), BAD_NAME("sage_unknown_t3"));
  w.mode({ sage: false, autopilot: false });
  assert.equal(denied(w.send(pre("Bash", writes[0], w.child("/root/sage_qa_t3")))), undefined, "outside sage mode the role rule does not act");
});

test("no sage child starts Codex from the shell, in any mode: the new session would run outside these hooks (T462)", (t) => {
  const w = world(t);
  const CHILD_CODEX = "sage: role agents never start Codex from the shell, because a new Codex session runs outside the hooks of this session. Put what you need in your report";
  const starts = ["codex exec 'report ok'", "codex", "/opt/homebrew/bin/codex exec --json hi", "cd /tmp && npx codex e hi", `bash -c "codex exec hi"`, "env FOO=1 codex app-server"];
  const others = ["grep -rn codex src", "echo codex exec", "git log --grep codex", "ls packages/sage-codex"];
  for (const mode of [{ sage: false, autopilot: false }, { sage: true, autopilot: false }]) {
    w.mode(mode);
    for (const name of ["sage_implementer_t1", "sage_code_reviewer_t1"]) {
      assert.deepEqual(starts.map((c) => denied(w.send(pre("Bash", c, w.child(`/root/${name}`))))), starts.map(() => CHILD_CODEX), name);
      assert.deepEqual(others.map((c) => denied(w.send(pre("Bash", c, w.child(`/root/${name}`))))), others.map(() => undefined), name);
    }
    assert.equal(denied(w.send(pre("Bash", starts[0], w.child("/root/worker_1")))), undefined, "a child that is not a sage role agent");
    assert.equal(denied(w.send(pre("Bash", "codex --version"))), undefined, "the main thread");
  }
  assert.match(denied(w.send(pre("Bash", starts[0], { ...CHILD, transcript_path: join(w.dir, "none.jsonl") }))) ?? "", /^sage: the hook could not read this agent's task name/);
});

test("only the chief records the logbook: a child's sage tool that writes is denied with one line, in any mode; reads pass (R1664-1, R1664-2)", async (t) => {
  const writes = [["verdict", { task: "T1", kind: "review-clean", sha: SHA, cycle: 1, pr: 41 }], ["gate_answer", { gate: "G1", option: 1 }], ["brief", { task_name: "sage_qa_t1", brief: "GOAL x" }],
    ["finding_add", { task: "T1", source: "qa", severity: "low" }], ["finding_triage", { task: "T1", key: "F-T1-1", decision: "dismiss", reason: "x" }], ["finding_close", { task: "T1", key: "F-T1-1" }],
    ["task_set", { task: "T1", fields: { state: "verified" } }], ["task_add", { title: "x", size: "tiny" }], ["standing_add", { order: "x" }], ["run_add", { task: "T1", role: "qa" }],
    ["run_done", { run: "R1", status: "done" }], ["round", { task: "T1" }], ["log", { task: "T1", decision: "x", why: "y" }], ["gate_add", { task: "T1", question: "q", options: "a|b", recommend: "a" }],
    ["finding_move", { task: "T1", key: "F-T1-1", to: "x" }], ["init", {}], ["pages", { task: "T1", record: "/p/page.html" }],
    ["pages", { task: "T1", run: "R1", text: "STATUS done" }], ["pages", { task: "T1", text: "STATUS done" }], ["unknown_tool", {}]];
  const reads = [["status", {}], ["standing", {}], ["merge_check", { sha: SHA }], ["pages", { task: "T1" }]];
  for (const mode of [{ sage: false }, { sage: true, autopilot: true }]) {
    const g = fixed(mode);
    for (const extra of [CHILD, { agent_id: "" }, { ...CHILD, transcript_path: "/none.jsonl" }]) {
      assert.deepEqual(await Promise.all(writes.map(([name, args]) => g.run(mcp(name, args, extra)).then(denied))), writes.map(() => LOGBOOK), JSON.stringify(mode));
      assert.deepEqual(await Promise.all(reads.map(([name, args]) => g.run(mcp(name, args, extra)))), reads.map(() => undefined));
    }
    assert.deepEqual(await Promise.all(writes.map(([name, args]) => g.run(mcp(name, args)))), writes.map(() => undefined), "the chief records the logbook");
  }
  assert.equal(denied(await fixed().run({ ...mcp("verdict"), tool_input: "x" })), UNREADABLE, "an input that it cannot read");
  // The built hook process, with the matcher of hooks.json: Codex runs the gate for these tools.
  const w = world(t);
  assert.equal(denied(w.send(mcp("verdict", { task: "T1", kind: "qa-pass", sha: SHA }, w.child("/root/sage_code_reviewer_t1")))), LOGBOOK);
  assert.equal(w.send(mcp("verdict", { task: "T1", kind: "qa-pass", sha: SHA })), undefined);
  const { hooks } = JSON.parse(readFileSync(new URL("../plugins/sage-codex/hooks/hooks.json", import.meta.url), "utf8"));
  const gateMatcher = new RegExp(hooks.PreToolUse.find((g) => g.hooks.some((h) => h.command.endsWith('/hooks/gate-hook.mjs"'))).matcher);
  const names = ["mcp__sage__verdict", "mcp__sage__gate_answer", "mcp__sage__brief", "spawn_agent", "collaborationspawn_agent", "Bash", "apply_patch", "mcp__github__create_issue", "exec_command", "wait_agent"];
  assert.deepEqual(names.filter((name) => gateMatcher.test(name)), names.slice(0, 7));
});

test("a role agent starts no agents, in any mode, and a thread under a read-only role at any part of its agent path is read-only (R1664-3)", async (t) => {
  const w = world(t);
  const spawn = (extra, tool_name = "collaborationspawn_agent") => ({ ...base, hook_event_name: "PreToolUse", tool_name, tool_use_id: "call_1", tool_input: { task_name: "helper", message: "write a file", fork_turns: "none" }, ...extra });
  for (const mode of [{ sage: false, autopilot: false }, { sage: true, autopilot: false }]) {
    w.mode(mode);
    for (const path of ["/root/sage_code_reviewer_t1", "/root/sage_implementer_t1_r4", "/root/Sage_QA_T1", "/root/worker_1/sage_qa_t1", "/root/sage_qa_t1/helper"]) {
      for (const tool of ["collaborationspawn_agent", "spawn_agent"]) assert.equal(denied(w.send(spawn(w.child(path), tool))), SPAWN, `${path} ${tool}`);
    }
    assert.equal(w.send(spawn(w.child("/root/worker_1"))), undefined, "a child that is not a sage role agent");
    assert.equal(w.send(spawn({})), undefined, "the chief starts agents");
    assert.match(denied(w.send(spawn({ ...CHILD, transcript_path: join(w.dir, "none.jsonl") }))) ?? "", /^sage: the hook could not read this agent's task name/);
  }
  w.mode({ sage: true, autopilot: false });
  const p = patch("*** Update File: src/a.js", "@@", "-a", "+b");
  const got = ["/root/sage_code_reviewer_t1/helper", "/root/sage_qa_t1/worker_2/helper", "/root/worker_1/sage_pe_t2", "/root/sage_implementer_t1/helper", "/root/worker_1/helper"]
    .map((path) => [path, denied(w.send(pre("apply_patch", p, w.child(path)))) ?? "edits", denied(w.send(pre("Bash", "echo x > notes.txt", w.child(path)))) ?? "writes"]);
  assert.deepEqual(got, [["/root/sage_code_reviewer_t1/helper", RO("code-reviewer"), RO("code-reviewer")], ["/root/sage_qa_t1/worker_2/helper", RO("qa"), RO("qa")],
    ["/root/worker_1/sage_pe_t2", RO("pe"), RO("pe")], ["/root/sage_implementer_t1/helper", "edits", "writes"], ["/root/worker_1/helper", "edits", "writes"]]);
  assert.equal(denied(w.send(pre("Bash", "codex exec hi", w.child("/root/worker_1/sage_implementer_t1/helper")))), CHILD_CODEX, "a helper under a sage agent starts no Codex either");
});

test("a sage_ name that is not a sage task name counts as a read-only role; a name with a run is read by its role (R1664-6, R1663-2)", (t) => {
  const w = world(t);
  w.mode({ sage: true, autopilot: false });
  const p = patch("*** Update File: src/a.js", "@@", "-a", "+b");
  const names = ["Sage_Code_Reviewer_T1", "sage_qa_T1", "sage_security_reviewer_t01", "sage_code_reviewer_t1x", "SAGE_implementer_t1", "sage_implementer_t1_r0", "sage__t1"];
  for (const name of names) {
    assert.equal(denied(w.send(pre("apply_patch", p, w.child(`/root/${name}`)))), BAD_NAME(name), name);
    assert.equal(denied(w.send(pre("Bash", "echo x > notes.txt", w.child(`/root/${name}`)))), BAD_NAME(name), name);
    assert.equal(denied(w.send(pre("Bash", "codex exec hi", w.child(`/root/${name}`)))), CHILD_CODEX, name);
  }
  assert.equal(denied(w.send(pre("apply_patch", p, w.child("/root/sage_code_reviewer_t3_r9")))), RO("code-reviewer"));
  assert.equal(denied(w.send(pre("apply_patch", p, w.child("/root/sage_security_reviewer_t3_r12")))), RO("security-reviewer"));
  assert.equal(w.send(pre("apply_patch", p, w.child("/root/sage_implementer_t3_r9"))), undefined, "an implementer's second run edits");
  assert.equal(w.send(pre("apply_patch", p, w.child("/root/sagebrush_t1"))), undefined, "a name that only starts with sage, not sage_");
});

/**
 * A fake installed Codex with the layout of the npm package 0.164.0: the launcher bin/codex.js, the native binary
 * vendor/<target>/bin/codex, Codex's own rg in vendor/<target>/codex-path, the codex link on PATH, and the codex-arg0
 * folder that Codex puts on PATH, with its apply_patch link to the binary that runs. Nothing here runs.
 */
function fakeCodex(w) {
  const pkg = join(w.dir, "lib/node_modules/@openai/codex");
  const vendor = join(pkg, "node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin");
  for (const dir of ["bin", "codex-path"]) mkdirSync(join(vendor, dir), { recursive: true });
  mkdirSync(join(pkg, "bin"), { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@openai/codex", version: "0.164.0" }));
  writeFileSync(join(pkg, "bin/codex.js"), "#!/usr/bin/env node\nprocess.exit(3);\n", { mode: 0o755 });
  writeFileSync(join(vendor, "bin/codex"), "#!/bin/sh\nexit 3\n", { mode: 0o755 });
  writeFileSync(join(vendor, "codex-path/rg"), "#!/bin/sh\necho rg-ran\n", { mode: 0o755 });
  symlinkSync(join(pkg, "bin/codex.js"), join(w.dir, "bin/codex"));
  symlinkSync(join(pkg, "bin/codex.js"), join(w.dir, "bin/helper-tool"));
  symlinkSync(join(vendor, "bin/codex"), join(w.dir, "bin/native-tool"));
  // The desktop app's own binary is not in the npm package: the hook finds it through the apply_patch link of codex-arg0.
  const app = join(w.dir, "Codex.app/Contents/Resources");
  mkdirSync(app, { recursive: true });
  writeFileSync(join(app, "codex"), "#!/bin/sh\nexit 3\n", { mode: 0o755 });
  symlinkSync(join(app, "codex"), join(w.dir, "bin/app-tool"));
  const arg0 = join(w.dir, "codex-home/tmp/arg0/codex-arg0AbCd12");
  mkdirSync(arg0, { recursive: true });
  for (const name of ["apply_patch", "applypatch"]) symlinkSync(join(app, "codex"), join(arg0, name));
  return { pkg, vendor, arg0, env: { ...w.env, PATH: [arg0, join(vendor, "codex-path"), join(w.dir, "bin"), "/usr/bin", "/bin"].join(":") } };
}

test("a codex program is found by the real file of a Codex executable, as node's script, and through an expansion, also for resume (R1664-4)", (t) => {
  const w = world(t);
  const { pkg, vendor, env } = fakeCodex(w);
  const starts = [`node ${pkg}/bin/codex.js exec hi`, `node --no-warnings ${pkg}/bin/codex.js`, `${w.dir}/bin/helper-tool exec hi`, "helper-tool exec hi",
    `${vendor}/bin/codex exec hi`, "native-tool exec hi", "app-tool exec hi", "npx @openai/codex@0.164.0 exec hi", `cd ${w.dir}/bin && ./helper-tool exec hi`];
  const expansions = ["C=codex; $C exec hi", '"$(command -v codex)" exec hi', "`which codex` exec hi", "X=helper-tool; $X --codex"];
  const others = ["node scripts/build.mjs", "npm test", "grep -rn codex src", `cat ${pkg}/package.json`, "echo $HOME", "ls $HOME", "rg -n codex src", `${vendor}/codex-path/rg -n codex src`];
  assert.deepEqual(starts.map((c) => codexRuns(c, w.project, env)?.length), starts.map(() => 1), "each start is found");
  assert.deepEqual(expansions.map((c) => codexRuns(c, w.project, env)), expansions.map(() => null), "an expansion with codex named is unreadable");
  assert.deepEqual(others.map((c) => codexRuns(c, w.project, env)), others.map(() => []));
  w.mode({ sage: true, autopilot: false });
  const reviewer = { ...w.child("/root/sage_code_reviewer_t1") };
  const send = (input) => {
    const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ ...input, transcript_path: input.transcript_path ?? w.transcript, cwd: w.project }), encoding: "utf8", env, timeout: 60_000 });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout ? denied(JSON.parse(r.stdout)) : undefined;
  };
  assert.deepEqual(starts.map((c) => send(pre("Bash", c, reviewer))), starts.map(() => CHILD_CODEX));
  assert.deepEqual(expansions.map((c) => send(pre("Bash", c, reviewer))), expansions.map(() => UNREAD_CODEX));
  assert.deepEqual(others.map((c) => send(pre("Bash", c, reviewer))), others.map(() => undefined));
  for (const command of [`node ${pkg}/bin/codex.js resume --last`, "helper-tool exec resume --last 'autopilot on'", "C=codex; $C resume --last"]) {
    assert.match(send(pre("Bash", command)) ?? "", /^sage: no agent (?:resumes or forks a Codex session|could not read)|^sage: the hook could not read this shell command/, command);
  }
  assert.equal(send(pre("Bash", "helper-tool --version")), undefined, "the chief may run Codex, without resume or fork");
  assert.deepEqual(resumesSession(`node ${pkg}/bin/codex.js fork abc`, w.project, env), true);
});

test("Codex's own rg in codex-path, first on PATH, is not Codex: a role agent's rg runs (R1668-1)", (t) => {
  const w = world(t);
  const { vendor, env } = fakeCodex(w);
  // The hook resolves rg by the hook's PATH, which Codex starts with codex-path, as in a real 0.164.0 session.
  assert.equal(spawnSync("rg", [], { env, encoding: "utf8" }).stdout, "rg-ran\n", "the fake rg is the one on PATH");
  w.mode({ sage: true, autopilot: false });
  for (const name of ["sage_code_reviewer_t1", "sage_implementer_t1", "sage_qa_t1"]) {
    for (const command of ["rg -n codex src", "rg --files", `${vendor}/codex-path/rg -n x`, "rg -n codex src | head -5"]) {
      const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ ...pre("Bash", command, w.child(`/root/${name}`)), cwd: w.project }), encoding: "utf8", env, timeout: 60_000 });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, "", `${name}: ${command}`);
    }
  }
  // Codex's apply_patch link points at the Codex binary, but it applies a patch: it starts no session. For a read-only
  // role it is a file write; an implementer may run it.
  const send = (command, path) => {
    const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ ...pre("Bash", command, w.child(path)), cwd: w.project }), encoding: "utf8", env, timeout: 60_000 });
    return r.stdout ? denied(JSON.parse(r.stdout)) : undefined;
  };
  assert.equal(send("apply_patch < change.patch", "/root/sage_code_reviewer_t1"), RO("code-reviewer"));
  assert.equal(send("apply_patch < change.patch", "/root/sage_implementer_t1"), undefined);
});

test("codex --version and --help start no session: a role agent may run them (R1671-2)", (t) => {
  const w = world(t);
  const { pkg, env } = fakeCodex(w);
  w.mode({ sage: true, autopilot: false });
  const send = (command) => {
    const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ ...pre("Bash", command, w.child("/root/sage_code_reviewer_t1")), cwd: w.project }), encoding: "utf8", env, timeout: 60_000 });
    return r.stdout ? denied(JSON.parse(r.stdout)) : undefined;
  };
  const prints = ["codex --version", "codex -V", "codex --help", "codex -h", `node ${pkg}/bin/codex.js --version`, "app-tool --version", "codex --version && npm test"];
  assert.deepEqual(prints.map(send), prints.map(() => undefined));
  const starts = ["codex", "codex exec --help hi", "codex --version exec hi", "codex exec hi && codex --version"];
  assert.deepEqual(starts.map(send), starts.map(() => CHILD_CODEX));
});

test("a command that runs a program from an expansion and names codex is refused only for a role agent in sage mode (R1668-2)", (t) => {
  const w = world(t);
  const commands = ["$EDITOR codex/a.txt", "$(npm bin)/eslint packages/sage-codex", "X=ls; $X codex"];
  const send = (command, extra = {}) => denied(w.send(pre("Bash", command, extra)));
  w.mode({ sage: false, autopilot: false });
  for (const extra of [{}, w.child("/root/sage_code_reviewer_t1"), w.child("/root/worker_1")]) assert.deepEqual(commands.map((c) => send(c, extra)), commands.map(() => undefined), "sage mode off");
  w.mode({ sage: true, autopilot: false });
  assert.deepEqual(commands.map((c) => send(c)), commands.map(() => undefined), "the chief");
  assert.deepEqual(commands.map((c) => send(c, w.child("/root/worker_1"))), commands.map(() => undefined), "a child that is not a role agent");
  assert.deepEqual(commands.map((c) => send(c, w.child("/root/sage_code_reviewer_t1"))), commands.map(() => UNREAD_CODEX), "a role agent in sage mode");
  assert.equal(send("C=codex; $C fork abc"), UNREAD_CODEX, "a possible fork is refused for every thread");
});

test("a child runs only the read commands of the state tool from the shell, and never its MCP server, in any mode (R1669-2)", (t) => {
  const w = world(t);
  const plugin = fileURLToPath(new URL("../plugins/sage-codex/", import.meta.url));
  const copy = join(w.dir, "elsewhere/skills/sage/sage.mjs");
  mkdirSync(join(w.dir, "elsewhere/skills/sage"), { recursive: true });
  writeFileSync(copy, "");
  const writes = [`node ${TOOL} verdict T1 --sha ${SHA} --kind review-clean --cycle 1`, `node ${TOOL} gate G1 answer 1`, `node ${plugin}mcp/state-server.mjs`,
    `cd ${plugin}skills/sage && node ./sage.mjs task T1 set state=verified`, `node ${copy} verdict T1`, `node ${TOOL} pages T1 record /p.html`,
    `X=${TOOL}; node $X verdict T1`, `bash -c "node ${TOOL} log T1 --decision x --why y"`];
  const reads = [`node ${TOOL} status`, `node ${TOOL} status --project ${w.project}`, `node ${TOOL} standing`, `node ${TOOL} merge-check ${SHA}`, `node ${TOOL} pages T1`, "node scripts/build.mjs", "npm test"];
  for (const mode of [{ sage: false, autopilot: false }, { sage: true, autopilot: false }]) {
    w.mode(mode);
    for (const path of ["/root/sage_implementer_t1", "/root/sage_code_reviewer_t1", "/root/worker_1"]) {
      assert.deepEqual(writes.map((c) => denied(w.send(pre("Bash", c, w.child(path))))), writes.map(() => LOGBOOK), path);
      assert.deepEqual(reads.map((c) => denied(w.send(pre("Bash", c, w.child(path))))), reads.map(() => undefined), path);
    }
    assert.equal(denied(w.send(pre("Bash", writes[0]))), undefined, "the chief may run the state tool");
  }
});

test("in sage mode a push takes core's push form, as in the Claude hook; outside sage mode the gate does not judge it (R1664-5)", (t) => {
  const w = world(t);
  const pushes = { "git push --force origin sage/t1": /^sage: sage mode never force-pushes/, "git push origin main": /^sage: work reaches main only through a pull request/,
    "git push": /^sage: name the remote and the branch/, "git push upstream sage/t1": /^sage: push to origin/, "git push origin HEAD:main": /^sage: work reaches main only through a pull request/,
    "bash -c 'git push -f origin sage/t1'": /^sage: /, "gh api -X PUT repos/o/r/contents/a.txt -f branch=main -f message=x -f content=eA==": /^sage: /, "git push origin +sage/t1": /^sage: sage mode never force-pushes/ };
  for (const mode of [{ sage: true, autopilot: false }, { sage: true, autopilot: true }]) {
    w.mode(mode);
    w.typed("sage mode", "autopilot on");
    for (const extra of [{}, w.child("/root/sage_implementer_t1")]) {
      for (const [command, why] of Object.entries(pushes)) assert.match(denied(w.send(pre("Bash", command, extra))) ?? "runs", why, command);
      assert.equal(w.send(pre("Bash", "git push -u origin sage/t1", extra)), undefined, "the push form runs");
      assert.equal(w.send(pre("Bash", "git push --delete origin sage/t9", extra)), undefined, "a branch delete");
    }
  }
  w.mode({ sage: false, autopilot: false });
  assert.equal(w.send(pre("Bash", "git push --force origin sage/t1")), undefined, "outside sage mode");
});

test("the sage folder rule also covers the Codex sessions folder, where the typed messages are (R1664-8)", (t) => {
  const w = world(t);
  const home = w.env.HOME;
  const env = { ...w.env, SAGE_HOME: undefined, CODEX_HOME: join(home, ".codex") };
  const named = ["cat ~/.codex/sessions/2026/10/25/rollout-x.jsonl", `echo '{}' >> ${home}/.codex/sessions/2026/10/25/rollout-x.jsonl`, "ls $CODEX_HOME/sessions", "ls ${CODEX_HOME}/sessions/2026", "grep -r autopilot $HOME/.codex/sessions"];
  const clean = ["ls ~/.codex/sessionsx", "ls ~/.codex/worktrees", "echo sessions", "cat notes/sessions/a.md"];
  assert.deepEqual(named.filter((c) => !namesSageFolder(c, env)), []);
  assert.deepEqual(clean.filter((c) => namesSageFolder(c, env)), []);
  w.mode({ sage: false, autopilot: false });
  assert.match(denied(w.send(pre("Bash", "ls $CODEX_HOME/sessions", CHILD))) ?? "", /^sage: no agent runs a shell command that names the Codex sage folder or the Codex sessions folder/);
});

test("a project under the desktop app's ~/.codex/worktrees edits as usual, with sage mode off and on; its own .codex folder stays closed (R1666-1)", (t) => {
  const w = world(t, { at: "home/.codex/worktrees/w1/app" });
  const p = (path) => patch(`*** Add File: ${path}`, "+x");
  const project = w.project;
  w.mode({ sage: false, autopilot: false });
  for (const path of ["notes.md", "src/a.js", `${project}/src/b.js`]) assert.equal(w.send(pre("apply_patch", p(path))), undefined, path);
  assert.equal(w.send(pre("Bash", `echo x > ${project}/notes.txt`)), undefined);
  assert.equal(w.send(pre("Bash", "echo x > notes.txt")), undefined);
  w.mode({ sage: true, autopilot: false });
  for (const path of ["notes.md", `${project}/src/b.js`]) assert.equal(w.send(pre("apply_patch", p(path), w.child("/root/sage_implementer_t1"))), undefined, path);
  assert.equal(w.send(pre("Bash", `echo x > ${project}/notes.txt`, w.child("/root/sage_implementer_t1"))), undefined);
  for (const mode of [{ sage: false, autopilot: false }, { sage: true, autopilot: false }]) {
    w.mode(mode);
    for (const path of [".codex/config.toml", "sub/.codex/hooks.json", `${project}/.codex/config.toml`, "../../../config.toml", `${w.dir}/home/.codex/config.toml`]) {
      assert.match(denied(w.send(pre("apply_patch", p(path), w.child("/root/sage_implementer_t1")))) ?? "", /^sage: no agent changes files under a \.codex folder/, path);
    }
    assert.match(denied(w.send(pre("Bash", `echo x > ${project}/.codex/config.toml`, w.child("/root/sage_implementer_t1")))) ?? "", /^sage: no agent changes files under a \.codex folder/);
  }
});

/** A sage child's event fields: its agent_id and Codex's record of it, with its agent path. */
const sageChild = (t, path) => ({ agent_id: "agent-9", transcript_path: record(t, { id: "019a0000-0000-7000-8000-0000000000ee", agent_path: path, source: { subagent: { thread_spawn: { depth: 1 } } } }) });

test("in sage mode, normal commands that name codex run for every agent: a program by a path, in a subfolder, or behind a pipe (R1733-1)", async (t) => {
  const reads = ["~/bin/tool codex", "pushd packages/sage-codex && ../../node_modules/.bin/esbuild hooks/gate-hook.mjs",
    "(cd packages/sage-codex && ../../node_modules/.bin/esbuild hooks/gate-hook.mjs)", "cat codex.json | python3 -mjson.tool",
    "rg -n codex src | node scripts/count.mjs", "codex --version", "cat .codex/config.toml"];
  const g = fixed({ sage: true });
  for (const [who, list] of [[{}, reads], [sageChild(t, "/root/sage_code_reviewer_t1_r1"), reads], [sageChild(t, "/root/helper_1"), reads],
    [sageChild(t, "/root/sage_implementer_t1_r1"), [...reads, "cat x.json | python3 -mjson.tool > codex.json"]]]) {
    assert.deepEqual(await Promise.all(list.map(async (c) => denied(await g.run(pre("Bash", c, who))))), list.map(() => undefined), who.transcript_path ?? "the chief");
  }
  // A program from an expansion stays unreadable for a role agent in sage mode.
  assert.equal(denied(await g.run(pre("Bash", "$EDITOR codex/a.txt", sageChild(t, "/root/sage_implementer_t1_r1")))), UNREAD_CODEX);
});

test("a child's node run of a file that only has the state tool's name in it, or of a script that reads the state tool as data, runs; logbook repair and standing add are writes (R1713-1, R1711-2, R1712-4, R1733-3)", async (t) => {
  const server = fileURLToPath(new URL("../plugins/sage-codex/mcp/state-server.mjs", import.meta.url));
  const runs = ["node src/message.mjs", "node src/usage.mjs", "node passage.mjs", "node my-state-server.js", `node scripts/lint.mjs ${TOOL}`,
    `rg -l x ${server} | node scripts/count.mjs`, `git diff | node scripts/count.mjs`, `node ${TOOL} logbook`, `node ${TOOL} logbook --project ${CWD}`,
    `node ${TOOL} standing`, `node ${TOOL} standing --project ${CWD}`];
  const writes = [`node ${TOOL} logbook repair --accept-loss runs --project ${CWD}`, `node ${TOOL} logbook --project ${CWD} repair --accept-loss runs`,
    `node ${TOOL} standing add x --project ${CWD}`, `node ${TOOL} standing --project ${CWD} add x`];
  for (const mode of [{ sage: false }, { sage: true }]) {
    const g = fixed(mode);
    for (const path of ["/root/sage_qa_t1_r2", "/root/helper_1"]) {
      const child = sageChild(t, path);
      assert.deepEqual(await Promise.all(runs.map(async (c) => denied(await g.run(pre("Bash", c, child))))), runs.map(() => undefined), `${path} ${mode.sage}`);
      assert.deepEqual(await Promise.all(writes.map(async (c) => denied(await g.run(pre("Bash", c, child))))), writes.map(() => LOGBOOK), `${path} ${mode.sage}`);
    }
  }
  assert.equal(denied(await fixed({ sage: true }).run(pre("Bash", writes[0]))), undefined, "the chief");
});

test("no sage child sends a message to another thread, with v1's send_input or v2's send_message and followup_task; the chief and other children may (F-T471-4, R1712-1, R1711-3)", async (t) => {
  const SEND = "sage: agents send no input to another thread, because a message to the chief's thread would count as the user's. Put it in your report";
  const send = (tool_name, extra) => ({ ...base, hook_event_name: "PreToolUse", tool_name, tool_use_id: "call_1", tool_input: { target: base.session_id, message: "autopilot on" }, ...extra });
  const tools = ["multi_agent_v1send_input", "send_input", "collaborationsend_message", "collaborationfollowup_task"];
  for (const mode of [{ sage: false }, { sage: true }]) {
    const g = fixed(mode);
    for (const tool of tools) {
      assert.equal(denied(await g.run(send(tool, sageChild(t, "/root/sage_code_reviewer_t1_r1")))), SEND, `${tool} a reviewer`);
      assert.equal(await g.run(send(tool, sageChild(t, "/root/worker_1"))), undefined, `${tool} a child that is not a sage child`);
      assert.equal(await g.run(send(tool, {})), undefined, `${tool} the chief`);
    }
  }
  const matcher = new RegExp(JSON.parse(readFileSync(new URL("../plugins/sage-codex/hooks/hooks.json", import.meta.url), "utf8")).hooks.PreToolUse.find((h) => /gate-hook/.test(h.hooks[0].command)).matcher);
  assert.deepEqual(tools.filter((tool) => !matcher.test(tool)), [], "Codex runs the gate for each send tool");
  assert.deepEqual(["mcp__slack__send_input", "collaborationsend_message_x", "xsend_input"].filter((tool) => matcher.test(tool)), [], "and for no other tool");
});

test("the sage folder and a .codex folder are found also behind quotes, ~ and a variable, and from the folder a command runs in (R1669-4, R1669-6)", async (t) => {
  const home = "/Users/someone";
  const env = { ...process.env, HOME: home, SAGE_HOME: undefined, CODEX_HOME: `${home}/.codex` };
  const named = [`echo x > "$HOME"/.co""dex/sa""ge/m.json`, `cat ~/".codex/sage/x"`, `cat "\${CODEX_HOME}"/sage/x`, `ls "${home}/.codex"/sessions`];
  assert.deepEqual(named.filter((c) => !namesSageFolder(c, env, CWD)), []);
  assert.equal(namesSageFolder("cat sage/.hooks/x.json", env, `${home}/.codex`), true, "from the Codex home");
  assert.deepEqual(["cat sage/notes.md", "ls sessions", "echo sage mode", `cat "${home}/.codex/config.toml"`].filter((c) => namesSageFolder(c, env, CWD)), []);
  const g = fixed({ sage: false });
  for (const command of [`touch ".co"dex/config.toml`, "echo x > .co''dex/config.toml"]) {
    assert.match(denied(await g.run(pre("Bash", command))) ?? "", /^sage: no agent changes files under a \.codex folder/, command);
  }
  assert.equal(await g.run(pre("Bash", `cat ".co"dex/config.toml`)), undefined, "a read");
});
