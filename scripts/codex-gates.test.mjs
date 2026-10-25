import "./test-env.mjs"; // first: no variable of the developer's shell changes a result
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// The Codex gates (T456), through Codex's PreToolUse and PermissionRequest input and output shapes. The pure tests give
// the gate a fixed mode and merge check; the process tests run the built hook with a mode file, a logbook and a fake gh.
const HOOK = fileURLToPath(new URL("../plugins/sage-codex/hooks/gate-hook.mjs", import.meta.url));
const TOOL = fileURLToPath(new URL("../plugins/sage-codex/skills/sage/sage.mjs", import.meta.url));
const { gate, readMode, typedModes, namesSageFolder, resumesSession, UNREADABLE } = await import(HOOK);
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

test("in sage mode the chief changes no file, and a child may", async () => {
  const p = patch("*** Update File: src/a.js", "@@", "-a", "+b");
  assert.equal(denied(await fixed({ sage: true }).run(pre("apply_patch", p))), 'sage: sage mode is on, so the chief does not change files. Brief an implementer to make this change. The user ends sage mode with the message "sage mode off", alone.');
  assert.equal(await fixed({ sage: true }).run(pre("apply_patch", p, CHILD)), undefined, "a child edits");
  assert.equal(await fixed({ sage: true }).run(pre("apply_patch", p, { agent_id: "" })), undefined, "an empty agent_id is a child too");
  assert.equal(await fixed({ sage: false }).run(pre("apply_patch", p)), undefined, "outside sage mode the root edits");
});

test("a merge runs only on the root thread, with autopilot on and a passing merge check", async () => {
  const off = fixed({ autopilot: false });
  assert.equal(denied(await off.run(pre("Bash", MERGE))), 'sage: autopilot is off, so the user merges. Report the pull request as ready. The user turns it on with the message "autopilot on", alone.');
  assert.equal(off.checks.length, 0, "autopilot off refuses before the merge check");
  const failing = fixed({ autopilot: true, ok: false });
  assert.equal(denied(await failing.run(pre("Bash", MERGE))), "sage: the merge check refuses: no verdicts recorded");
  assert.deepEqual(failing.checks, [{ pr: "41", sha: SHA }]);
  const passing = fixed({ autopilot: true });
  assert.equal(await passing.run(pre("Bash", MERGE)), undefined, "the verified merge runs");
  assert.equal(denied(await passing.run(pre("Bash", MERGE, CHILD))), "sage: an agent never merges. Report the pull request as ready.");
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
function world(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "sage-codex-gate-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const project = join(dir, "project"), bin = join(dir, "bin");
  mkdirSync(bin);
  spawnSync("git", ["init", "-q", "-b", "sage/t1", project]);
  spawnSync("git", ["-C", project, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "start"]);
  writeFileSync(join(bin, "gh"), `#!/bin/sh\necho "$@" >> "${dir}/gh-calls.log"\n[ "$1 $2" = "pr view" ] && printf '{"headRefName":"sage/t1","isCrossRepository":false}'\nexit 0\n`);
  chmodSync(join(bin, "gh"), 0o755);
  for (const name of ["ps", "pgrep", "kill"]) writeFileSync(join(bin, name), `#!/bin/sh\necho ${name} >> "${dir}/fake-calls.log"\n`, { mode: 0o755 }); // order 14
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: join(dir, "home"), SAGE_HOME: join(dir, "sage"), CODEX_HOME: join(dir, "codex-home") };
  const sage = (...args) => spawnSync(process.execPath, [TOOL, ...args, "--project", project], { encoding: "utf8", env });
  // Codex's transcript of the root thread: the user's typed messages, as item_completed events with a UserMessage item.
  const transcript = join(dir, "rollout.jsonl");
  const typed = (...messages) => writeFileSync(transcript, [{ type: "session_meta", payload: { id: base.session_id } },
    ...messages.map((text) => ({ type: "event_msg", payload: { type: "item_completed", thread_id: base.session_id, item: { type: "UserMessage", content: [{ type: "text", text }] } } }))]
    .map((line) => JSON.stringify(line)).join("\n") + "\n");
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
  assert.equal(w.sage("task", "add", "--title", "t", "--size", "small").status, 0);
  for (const kind of ["checks-pass", "review-clean", "qa-pass"]) assert.equal(w.sage("verdict", "T1", "--sha", SHA, "--kind", kind, "--cycle", "1", "--pr", "41").status, 0);
  assert.equal(w.send(pre("Bash", MERGE)), undefined, "the verified merge runs");
  assert.deepEqual(w.send(ask(MERGE)), ALLOW, "and Codex shows no prompt for it");
  assert.match(denied(w.send(pre("Bash", MERGE, CHILD))) ?? "", /^sage: an agent never merges/);
  w.mode({ sage: false, autopilot: true });
  assert.equal(w.send(ask(MERGE)), undefined, "autopilot counts only in sage mode");
  assert.match(denied(w.send(pre("apply_patch", patch("*** Add File: .codex/config.toml", "+x")))) ?? "", /^sage: no agent changes files under a \.codex folder/);
  assert.equal(denied(w.send("{not json")), UNREADABLE);
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
  assert.equal(w.sage("task", "add", "--title", "t", "--size", "small").status, 0);
  for (const kind of ["checks-pass", "review-clean", "qa-pass"]) assert.equal(w.sage("verdict", "T1", "--sha", SHA, "--kind", kind, "--cycle", "1", "--pr", "41").status, 0);
  const cases = [["no transcript", null], ["no typed phrase", []], ["sage mode only", ["sage mode"]], ["autopilot before sage mode", ["autopilot on", "sage mode"]],
    ["autopilot off last", ["sage mode", "autopilot on", "autopilot off"]], ["sage mode off last", ["sage mode", "autopilot on", "sage mode off"]], ["a phrase inside a message", ["sage mode", "please autopilot on now"]], ["typed", ["sage mode", "autopilot on"]]];
  const got = cases.map(([why, messages]) => {
    if (messages) w.typed(...messages);
    const input = messages ? {} : { transcript_path: join(w.dir, "none.jsonl") };
    return [why, denied(w.send(pre("Bash", MERGE, input)))?.slice(0, 25) ?? "runs", w.send(ask(MERGE, input))?.hookSpecificOutput?.decision?.behavior ?? "prompt"];
  });
  const off = "sage: autopilot is off, s";
  assert.deepEqual(got, [["no transcript", off, "prompt"], ["no typed phrase", off, "prompt"], ["sage mode only", off, "prompt"], ["autopilot before sage mode", off, "prompt"],
    ["autopilot off last", off, "prompt"], ["sage mode off last", off, "prompt"], ["a phrase inside a message", off, "prompt"], ["typed", "runs", "allow"]]);
  const other = { type: "event_msg", payload: { type: "item_completed", thread_id: "another-thread", item: { type: "UserMessage", content: [{ type: "text", text: "autopilot on" }] } } };
  writeFileSync(w.transcript, ["sage mode"].map((text) => JSON.stringify({ ...other, payload: { ...other.payload, thread_id: base.session_id, item: { ...other.payload.item, content: [{ type: "text", text }] } } })).concat(JSON.stringify(other)).join("\n"));
  assert.deepEqual(typedModes(w.transcript, base.session_id), { sage: true, autopilot: false }, "a message of another thread (a fork's copied history) does not count");
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
  const resumes = ["codex resume --last", "codex exec resume abc 'autopilot on'", "/opt/homebrew/bin/codex fork abc", "FOO=1 codex resume", "cd /p && env codex exec --json resume --last hi"];
  const others = ["codex exec 'hello'", "git commit -m 'codex resume notes'", "echo codex resume", "codex --version"];
  assert.deepEqual(resumes.filter((c) => !resumesSession(c)), []);
  assert.deepEqual(others.filter((c) => resumesSession(c)), []);
  for (const mode of [{ sage: false, autopilot: false }, { sage: true, autopilot: true }]) {
    w.mode(mode);
    for (const extra of [{}, CHILD]) {
      assert.match(denied(w.send(pre("Bash", `cat ${w.env.SAGE_HOME}/.hooks/codex/x.json`, extra))) ?? "", /^sage: no agent runs a shell command that names the Codex sage folder/);
      assert.match(denied(w.send(pre("Bash", "codex exec resume --last 'autopilot on'", extra))) ?? "", /^sage: no agent resumes or forks a Codex session/);
    }
  }
});

test("in sage mode a child whose task name names a read-only role changes no file; an implementer and an unnamed child may", (t) => {
  const w = world(t);
  const p = patch("*** Update File: src/a.js", "@@", "-a", "+b");
  w.mode({ sage: true, autopilot: false });
  const got = ["sage_code_reviewer_t3", "sage_security_reviewer_t3", "sage_ux_reviewer_t3", "sage_qa_t3", "sage_pe_t3", "sage_lead_t3", "sage_implementer_t3", "sage_designer_t3", "worker_1", "sage_unknown_t3"]
    .map((name) => [name, denied(w.send(pre("apply_patch", p, w.child(`/root/${name}`)))) ?? "edits"]);
  const ro = (role) => `sage: a ${role} reviews and changes no files; report the finding instead.`;
  assert.deepEqual(got.slice(0, 9), [["sage_code_reviewer_t3", ro("code-reviewer")], ["sage_security_reviewer_t3", ro("security-reviewer")], ["sage_ux_reviewer_t3", ro("ux-reviewer")], ["sage_qa_t3", ro("qa")], ["sage_pe_t3", ro("pe")], ["sage_lead_t3", ro("lead")],
    ["sage_implementer_t3", "edits"], ["sage_designer_t3", "edits"], ["worker_1", "edits"]]);
  assert.match(got[9][1], /^sage: the hook could not read this agent's task name/, "a sage_ name with an unknown role fails closed");
  assert.match(denied(w.send(pre("apply_patch", p, { ...CHILD, transcript_path: join(w.dir, "none.jsonl") }))) ?? "", /^sage: the hook could not read this agent's task name/);
  assert.equal(w.send(pre("Bash", "npm test", w.child("/root/sage_qa_t3"))), undefined, "QA still runs commands");
  w.mode({ sage: false, autopilot: false });
  assert.equal(w.send(pre("apply_patch", p, w.child("/root/sage_qa_t3"))), undefined, "outside sage mode the role rule does not act");
});
