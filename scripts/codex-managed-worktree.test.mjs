import "./test-env.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { linkSync, mkdtempSync, mkdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gate } from "../plugins/sage-codex/hooks/gate-hook.mjs";
import { checkoutContains, resolveCheckoutPath, verifiedCheckout } from "../plugins/sage-codex/core/index.mjs";

function fixture(t, homeName = ".codex") {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "sage-managed-admission-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const main = join(dir, "main"), home = join(dir, homeName);
  const linked = join(home, "worktrees", "id", "project");
  const git = (...args) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { stdio: "pipe" });
  git("init", "-q", main);
  git("-C", main, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-qm", "fixture");
  mkdirSync(join(home, "worktrees", "id"), { recursive: true });
  git("-C", main, "worktree", "add", "-qb", "fixture", linked);
  const transcript = join(dir, "fixture.jsonl");
  writeFileSync(transcript, JSON.stringify({ type: "session_meta", payload: { id: "child", agent_path: "/root/sage_implementer_t1_r1", source: { subagent: { thread_spawn: { depth: 1 } } } } }) + "\n");
  const env = { HOME: dir, CODEX_HOME: home, SAGE_HOME: join(dir, "logbook"), SAGE_SHARED_HOME: join(dir, "shared") };
  const send = (path, extra = {}, sage = false) => gate({ hook_event_name: "PreToolUse", session_id: "session", cwd: main,
    tool_name: "apply_patch", tool_input: { command: `*** Begin Patch\n*** Add File: ${path}\n+x\n*** End Patch` },
    agent_id: "child", transcript_path: transcript, ...extra }, { env, mode: () => ({ sage, autopilot: false }) });
  return { dir, main, home, linked, send, git, env, transcript };
}

test("T119: ordinary source in a verified managed sibling passes patch checks", async t => {
  const w = fixture(t);
  assert.equal(await w.send(join(w.linked, "src", "new.mjs")), undefined);
  writeFileSync(join(w.linked, "existing"), "x");
  for (const operation of ["Update", "Delete"]) {
    const body = operation === "Update" ? "\n@@\n-x\n+y" : "";
    assert.equal(await w.send("unused", { tool_input: { command: `*** Begin Patch\n*** ${operation} File: ${w.linked}/existing${body}\n*** End Patch` } }), undefined);
  }
  assert.match((await w.send(join(w.linked, ".codex", "config.toml")))?.hookSpecificOutput?.permissionDecisionReason ?? "", /codex|protected/i);
});

for (const homeName of ["codex-home", ".codex"]) {
  test(`T119: ${homeName} retains the original managed checkout across escaping symlinks`, async t => {
    const w = fixture(t, homeName);
    const outside = homeName === "codex-home" ? join(w.dir, "ordinary") : join(w.home, "worktrees", "other", "project");
    if (homeName === "codex-home") mkdirSync(outside);
    else w.git("-C", w.main, "worktree", "add", "-qb", "other", outside);
    mkdirSync(join(outside, "deep"));
    symlinkSync(outside, join(w.linked, "escape"));
    symlinkSync(join(outside, "deep"), join(w.linked, "ordered-escape"));
    assert.equal(await w.send(join(outside, "new.mjs")), undefined);
    for (const sage of [false, true]) {
      for (const [cwd, path] of [
        [w.main, `${w.linked}/escape/new.mjs`],
        [w.main, `${w.linked}/ordered-escape/../new.mjs`],
        [w.linked, "escape/new.mjs"],
        [w.linked, "ordered-escape/../new.mjs"],
      ]) {
        assert.equal(resolveCheckoutPath(path, cwd).canonicalTarget, join(outside, "new.mjs"));
        const out = await w.send(path, { cwd }, sage);
        assert.equal(out?.hookSpecificOutput?.permissionDecision, "deny", `${cwd}: ${path}`);
        assert.match(out.hookSpecificOutput.permissionDecisionReason, /codex|protected/i);
      }
    }
  });
}

test("T119: exact identity, symlink order, forged backlink and absent Git", t => {
  const w = fixture(t);
  mkdirSync(join(w.linked, "inside"));
  mkdirSync(join(w.dir, "outside", "deep"), { recursive: true });
  symlinkSync(join(w.dir, "outside", "deep"), join(w.linked, "ordered"));
  assert.equal(resolveCheckoutPath(`${w.linked}/ordered/../new`).canonicalTarget, join(w.dir, "outside", "new"));
  assert.equal(checkoutContains(w.linked, resolveCheckoutPath(`${w.linked}/ordered/../new`).canonicalTarget), false);
  assert.equal(checkoutContains(w.linked, `${w.linked}-suffix/new`), false);
  assert.equal(verifiedCheckout(w.linked).verified, true);
  assert.equal(verifiedCheckout(w.dir).verified, false);
  const forged = join(w.dir, "forged");
  mkdirSync(forged);
  symlinkSync(join(w.linked, ".git"), join(forged, ".git"));
  assert.equal(verifiedCheckout(forged).verified, false);
  const gitDir = verifiedCheckout(w.linked).gitDir;
  writeFileSync(join(gitDir, "gitdir"), join(w.dir, "forged", ".git"));
  assert.equal(verifiedCheckout(w.linked).verified, false);
});

test("T119: unavailable trusted Git grants no checkout exception", async t => {
  const w = fixture(t);
  assert.equal(await w.send(join(w.linked, "new")), undefined);
  const original = fs.lstatSync;
  const mock = t.mock.method(fs, "lstatSync", (path, ...args) => {
    if (String(path).endsWith("/usr/bin/git") || String(path) === "/bin/git") return { uid: -1, mode: 0 };
    if (path === join(w.linked, "inaccessible")) throw Object.assign(Error("fixture permission refusal"), { code: "EACCES" });
    return original(path, ...args);
  });
  syncBuiltinESMExports();
  try {
    assert.equal(verifiedCheckout(w.main).verified, false);
    assert.throws(() => resolveCheckoutPath(join(w.linked, "inaccessible", "new")), /unavailable/);
    assert.match((await w.send(join(w.linked, "new")))?.hookSpecificOutput?.permissionDecisionReason ?? "", /codex|protected/i);
  } finally { mock.mock.restore(); syncBuiltinESMExports(); }
});

for (const [label, a, b] of [["case", "App", "app"], ["Unicode", "K", "K"], ["compatibility Unicode", "A", "Ａ"]]) {
  test(`T119: distinct ${label} filesystem identities stay distinct`, t => {
    const w = fixture(t), first = join(w.dir, a), second = join(w.dir, b);
    mkdirSync(first);
    try { mkdirSync(second); } catch (error) { if (error.code !== "EEXIST") throw error; }
    if (statSync(first).ino === statSync(second).ino) { t.skip("Unverified: filesystem does not support these distinct names"); return; }
    assert.equal(checkoutContains(resolveCheckoutPath(first).canonicalTarget, resolveCheckoutPath(second).canonicalTarget), false);
    symlinkSync(second, join(first, "escape"));
    assert.equal(checkoutContains(resolveCheckoutPath(first).canonicalTarget, resolveCheckoutPath(join(first, "escape", "new")).canonicalTarget), false);
  });
}

test("T119: protected endpoints, aliases, traversal and patch shapes refuse", async t => {
  const w = fixture(t), reason = out => out?.hookSpecificOutput?.permissionDecisionReason ?? "";
  const source = join(w.linked, "source.mjs");
  writeFileSync(source, "x");
  linkSync(source, join(w.linked, "hard.mjs"));
  symlinkSync(w.main, join(w.linked, "escape"));
  symlinkSync(join(w.linked, "absent"), join(w.linked, "dangling"));
  symlinkSync("loop", join(w.linked, "loop"));
  mkdirSync(join(w.linked, "safe"));
  mkdirSync(join(w.linked, "protected-parent", ".codex"), { recursive: true });
  mkdirSync(join(w.dir, ".claude", "sage"), { recursive: true });
  symlinkSync(join(w.dir, ".claude", "sage"), join(w.linked, "legacy-alias"));
  symlinkSync("safe", join(w.linked, "safe-link"));
  symlinkSync(join(w.home, "sessions"), join(w.linked, "private-link"));
  for (const path of [source, join(w.linked, "hard.mjs"), join(w.linked, "escape", "new"), join(w.linked, "dangling", "new"), join(w.linked, "loop", "new"),
    `${w.linked}/missing/../new`, `${w.linked}/.codex/../new`, `${w.linked}/.git/../new`, join(w.linked, "private-link", "new"),
    join(w.home, "config.toml"), join(w.home, "plugins", "new"), join(w.home, "cache", "new"), join(w.home, "sessions", "new"),
    w.home, join(w.linked, "protected-parent"), join(w.linked, "legacy-alias", "x"), join(w.dir, ".claude", "sage", "x"),
    join(w.linked, ".git"), join(w.main, ".git", "config"), join(w.env.SAGE_HOME, "x"), join(w.env.SAGE_SHARED_HOME, "x")]) {
    assert.match(reason(await w.send(path)), /codex|protected|git/i, path);
  }
  assert.equal(await w.send(join(w.linked, "safe-link", "new")), undefined);
  assert.equal(await w.send(`${w.linked}/safe-link/../new`), undefined);
  for (const body of ["", "*** Begin Patch\n*** End Patch", "*** Begin Patch\n*** Unknown: x\n*** End Patch",
    "x".repeat(1024 * 1024 + 1), "*** Begin Patch\n*** Add File: x\tbad\n+x\n*** End Patch",
    `*** Begin Patch\n*** Update File: ${w.linked}/new\n*** Move to: ${w.linked}/a\n*** Move to: ${w.linked}/b\n@@\n-x\n+y\n*** End Patch`,
    `*** Begin Patch\n*** Add File: ${w.linked}/new \n+x\n*** End Patch`,
    `*** Begin Patch\n*** Update File: ${w.linked}/new\n*** Move to: ${w.home}/config.toml\n@@\n-x\n+y\n*** End Patch`,
    `*** Begin Patch\n*** Delete File: ${w.home}/config.toml\n*** Add File: ${w.linked}/new\n+x\n*** End Patch`]) {
    assert.match(reason(await w.send("unused", { tool_input: { command: body } })), /patch|codex/i);
  }
  assert.match(reason(await w.send("new", { tool_input: { command: "*** Begin Patch\n*** Add File: new\n+x\n*** End Patch", workdir: w.linked } })), /patch/i);
  assert.equal(await w.send("unused", { tool_input: { command: `*** Begin Patch\n*** Update File: ${w.linked}/new\n*** Move to: ${w.linked}/moved\n@@\n-x\n+y\n*** End Patch` } }), undefined);
});

test("T119: event identity, configured home, nested boundaries and roles", async t => {
  const w = fixture(t), reason = out => out?.hookSpecificOutput?.permissionDecisionReason ?? "";
  const ordinary = join(w.dir, "ordinary"), other = join(w.dir, "other"), forged = join(w.home, "worktrees", "forged", "project");
  const alternate = join(w.home, "worktrees", "alternate", "project");
  w.git("-C", w.main, "worktree", "add", "-qb", "alternate", alternate);
  mkdirSync(join(alternate, ".codex"));
  symlinkSync(w.linked, join(alternate, ".codex", "alias"));
  assert.match(reason(await w.send(join(alternate, ".codex", "alias", "new"))), /codex|protected/i);
  w.git("-C", w.main, "worktree", "add", "-qb", "ordinary", ordinary);
  w.git("init", "-q", other);
  mkdirSync(forged, { recursive: true });
  writeFileSync(join(forged, ".git"), `gitdir: ${w.main}/.git/worktrees/project\n`);
  for (const sage of [false, true]) {
    for (const cwd of [w.main, w.linked]) {
      assert.equal(await w.send(join(w.linked, "new"), { cwd }, sage), undefined);
      assert.equal(await w.send(join(ordinary, "config.json"), { cwd }, sage), undefined);
    }
    for (const cwd of [other, w.dir]) assert.match(reason(await w.send(join(w.linked, "new"), { cwd }, sage)), /codex/i);
    assert.match(reason(await w.send(join(forged, "new"), {}, sage)), /codex/i);
  }
  assert.equal(await w.send("new", { cwd: w.linked }), undefined);
  const unsupported = join(w.home, "worktrees", "unsupported");
  w.git("-C", w.main, "worktree", "add", "-qb", "unsupported", unsupported);
  assert.match(reason(await w.send(join(unsupported, "new"))), /codex|protected/i);
  assert.match(reason(await w.send(join(w.linked, "new"), { agent_id: undefined, transcript_path: null }, true)), /read|role|hook/i);
  const chief = { hook_event_name: "PreToolUse", session_id: "session", cwd: w.main, tool_name: "apply_patch",
    tool_input: { command: `*** Begin Patch\n*** Add File: ${w.linked}/new\n+x\n*** End Patch` } };
  assert.match(reason(await gate(chief, { env: w.env, mode: () => ({ sage: true }) })), /chief/i);
  writeFileSync(w.transcript, JSON.stringify({ type: "session_meta", payload: { id: "child", agent_path: "/root/sage_code_reviewer_t1_r1", source: { subagent: { thread_spawn: { depth: 1 } } } } }) + "\n");
  assert.match(reason(await w.send(join(w.linked, "new"), {}, true)), /reviewer|read.only/i);
  w.git("init", "-q", join(w.linked, ".codex", "nested"));
  assert.match(reason(await w.send(join(w.linked, ".codex", "nested", "new"))), /codex/i);
  const wrongHome = { ...w.env, CODEX_HOME: join(w.dir, "another-home") };
  assert.match(reason(await gate(chief, { env: wrongHome, mode: () => ({ sage: false }) })), /codex|protected/i);
});
