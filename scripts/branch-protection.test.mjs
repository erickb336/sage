// T547: Claude warns on unprotected activation; Codex refuses activation without reading protection. Both hooks
// run as their hosts run them (one process for each event), with a fake gh on PATH: no test reaches GitHub.
import "./test-env.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const CLAUDE_HOOK = fileURLToPath(new URL("../plugins/sage/hooks/sage-hook.mjs", import.meta.url));
const CODEX_HOOK = fileURLToPath(new URL("../plugins/sage-codex/hooks/sage-codex-hook.mjs", import.meta.url));
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "sage-protection-")));
after(() => rmSync(scratch, { recursive: true, force: true }));

// The fake gh answers FAKE_GH_MODE: rules (a ruleset needs a pull request), classic (a branch protection rule does),
// status (protection with no pull request rule), none, or broken (every read fails). private answers HTTP 403 "Upgrade to
// GitHub Pro" to both protection reads, and private-classic only to the classic read. slow waits 3 seconds before each answer
// and then answers as none. It logs each call to FAKE_GH_LOG.
const BIN = join(scratch, "bin");
mkdirSync(BIN);
writeFileSync(join(BIN, "gh"), `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_GH_LOG, args.join(" ") + "\\n");
const mode = process.env.FAKE_GH_MODE;
const path = args.at(-1);
const reply = (body, status = 0) => { process.stdout.write(JSON.stringify(body)); process.exitCode = status; };
const UPGRADE = { message: "Upgrade to GitHub Pro or make this repository public to enable this feature.", status: "403" };
if (mode === "slow") Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000);
if (args[0] === "pr") { reply({ headRefName: "claude/t1", isCrossRepository: false }); }
else if (mode === "broken" || args.join(" ").includes("-X")) process.exitCode = 1;
else if (mode === "private" && path.startsWith("repos/o/r/")) reply(UPGRADE, 1);
else if (mode === "private-classic" && path === "repos/o/r/branches/main/protection") reply(UPGRADE, 1);
else if (path === "repos/{owner}/{repo}") reply({ full_name: "o/r", default_branch: "main" });
else if (path === "repos/o/r/rules/branches/main") reply(mode === "rules" ? [{ type: "pull_request" }] : mode === "status" ? [{ type: "required_status_checks" }] : []);
else if (path === "repos/o/r/branches/main/protection") {
  if (mode === "classic") reply({ required_pull_request_reviews: { required_approving_review_count: 0 } });
  else if (mode === "status") reply({ required_status_checks: { strict: true } });
  else reply({ message: "Branch not protected" }, 1);
} else process.exitCode = 1;
`);
chmodSync(join(BIN, "gh"), 0o755);

let sessions = 0;
/** A session of one host, with a fake gh in the given mode: prompt() sends one typed message, and calls() counts the gh reads. */
function session(host, mode) {
  const id = `s${++sessions}`;
  const dir = join(scratch, id);
  mkdirSync(dir);
  const log = join(dir, "gh.log");
  writeFileSync(log, "");
  const env = { PATH: `${BIN}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: join(dir, "home"), SAGE_HOME: join(dir, "sage"), SAGE_HOOKS_STATE: join(dir, "state"), CODEX_HOME: join(dir, "codex"), FAKE_GH_MODE: mode, FAKE_GH_LOG: log };
  const script = host === "claude" ? CLAUDE_HOOK : CODEX_HOOK;
  const base = host === "claude" ? { session_id: id, cwd: dir } : { session_id: `019a0000-0000-7000-8000-${String(sessions).padStart(12, "0")}`, cwd: dir, transcript_path: null, model: "fixture", permission_mode: "default", turn_id: "t" };
  const send = (fields) => {
    const r = spawnSync(process.execPath, [script], { input: JSON.stringify({ ...base, ...fields }), encoding: "utf8", env, timeout: 30_000, killSignal: "SIGKILL" });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout ? JSON.parse(r.stdout) : undefined;
  };
  const prompt = (text) => send({ hook_event_name: "UserPromptSubmit", prompt: text })?.hookSpecificOutput?.additionalContext ?? "";
  const calls = () => readFileSync(log, "utf8").split("\n").filter(Boolean);
  return { prompt, calls, send };
}

const WARNING = /Warning: the default branch of this repository \(main\) has no GitHub protection that requires a pull request, so a merge or a push can land with no lock\. Autopilot still runs\. On GitHub, open the repository, then Settings, Rules, and add a ruleset/;
const UNREADABLE = /sage could not check whether the default branch of this repository requires a pull request on GitHub\. Autopilot still runs\./;
const AUTOPILOT = /sage: autopilot is on\./;
const NO_PLAN = /Warning: GitHub offers no branch protection for this private repository on your plan, so nothing locks the default branch \(main\)\. A merge or a push can land with no lock\. Autopilot still runs\. To get a lock, make the repository public or upgrade to GitHub Pro\./;

for (const host of ["claude"]) {
  for (const [mode, expected] of [["rules", "no line"], ["classic", "no line"], ["unprotected", "warning"], ["status", "warning"], ["broken", "could not check"]]) {
    test(`T547 ${host}: autopilot on with GitHub in the state "${mode}" gives ${expected}, and autopilot stays on`, () => {
      const s = session(host, mode);
      s.prompt("sage mode");
      const note = s.prompt("autopilot on");
      assert.match(note, AUTOPILOT);
      assert.equal(WARNING.test(note), expected === "warning", note);
      assert.equal(UNREADABLE.test(note), expected === "could not check", note);
      assert.match(s.prompt("sage help"), /sage mode is on, and autopilot is on\./, "it lands: warn only");
      assert.ok(s.calls().every((call) => call.startsWith("api --hostname github.com repos/")), "only gh api reads, with no write flag");
    });
  }

  test(`T547 ${host}: the session reads GitHub once and warns once; a failed read tries again at the next autopilot on`, () => {
    const s = session(host, "unprotected");
    s.prompt("sage mode");
    assert.match(s.prompt("autopilot on"), WARNING);
    const reads = s.calls().length;
    assert.equal(reads, 3, "the repository, the rulesets and the classic rule");
    s.prompt("autopilot off");
    assert.doesNotMatch(s.prompt("autopilot on"), WARNING, "the second autopilot on does not warn again");
    assert.equal(s.calls().length, reads, "and reads nothing");

    const broken = session(host, "broken");
    broken.prompt("sage mode");
    assert.match(broken.prompt("autopilot on"), UNREADABLE);
    broken.prompt("autopilot off");
    assert.match(broken.prompt("autopilot on"), UNREADABLE, "an unknown answer is not kept");
  });

  for (const mode of ["private", "private-classic"]) {
    test(`T547 ${host}: a private repository on a free plan ("${mode}") gets its own line, once, with no setup steps`, () => {
      const s = session(host, mode);
      s.prompt("sage mode");
      const note = s.prompt("autopilot on");
      assert.match(note, AUTOPILOT);
      assert.match(note, NO_PLAN, note);
      assert.doesNotMatch(note, /Settings|ruleset|could not check|has no GitHub protection/, "no setup steps, and not the other lines");
      assert.match(s.prompt("sage help"), /sage mode is on, and autopilot is on\./, "it lands: warn only");
      const reads = s.calls().length;
      s.prompt("autopilot off");
      assert.doesNotMatch(s.prompt("autopilot on"), /Warning/, "the second autopilot on does not warn again");
      assert.equal(s.calls().length, reads, "and reads nothing");
    });
  }

  test(`T547 ${host}: slow reads stop at one deadline, so the hook returns inside its 10 second limit and says could not check`, () => {
    const s = session(host, "slow");
    s.prompt("sage mode");
    const start = Date.now();
    const note = s.prompt("autopilot on");
    const took = Date.now() - start;
    assert.match(note, AUTOPILOT, "autopilot still turns on");
    assert.match(note, UNREADABLE, note);
    assert.ok(took < 8000, `the hook took ${took} ms`); // timing-ok: the host kills a hook at 10 s; the deadline is 5 s, the old code took 9 s, and the fake gh is the slow part
    assert.ok(s.calls().length <= 2, "no read starts after the deadline");
  });

  test(`T547 ${host}: a normal session or another phrase reads nothing from GitHub`, () => {
    const s = session(host, "unprotected");
    s.prompt("fix the login bug");
    s.prompt("sage mode");
    s.prompt("sage help");
    s.prompt("autopilot off");
    assert.deepEqual(s.calls(), []);
  });
}

const CODEX_UNAVAILABLE = "sage: automatic merging is unavailable in Codex. Sage prepares the checks; the owner merges directly in GitHub.";

for (const mode of ["rules", "classic", "unprotected", "status", "broken", "private", "private-classic", "slow"]) {
  test(`T547 codex: autopilot stays off with GitHub in the state "${mode}", without protection reads`, () => {
    const s = session("codex", mode);
    s.prompt("sage mode");
    assert.equal(s.prompt("autopilot on"), CODEX_UNAVAILABLE);
    assert.match(s.prompt("sage help"), /Now: sage mode is on, and autopilot is off\./);
    assert.deepEqual(s.calls(), [], "unavailable activation never checks GitHub protection");
  });
}

test("T547 codex: repeated activation stays unavailable without protection reads or retries", () => {
  for (const mode of ["unprotected", "broken"]) {
    const s = session("codex", mode);
    s.prompt("sage mode");
    assert.equal(s.prompt("autopilot on"), CODEX_UNAVAILABLE);
    s.prompt("autopilot off");
    assert.equal(s.prompt("autopilot on"), CODEX_UNAVAILABLE);
    assert.match(s.prompt("sage help"), /Now: sage mode is on, and autopilot is off\./);
    assert.deepEqual(s.calls(), [], "neither a warning cache nor a failed read enables a protection lookup");
  }
});

test("T547 codex: a normal session or another phrase reads nothing from GitHub", () => {
  const s = session("codex", "unprotected");
  s.prompt("fix the login bug");
  s.prompt("sage mode");
  assert.match(s.prompt("sage help"), /Now: sage mode is on, and autopilot is off\./);
  s.prompt("autopilot off");
  assert.deepEqual(s.calls(), []);
});

test("T547 claude: a merge after the warning is judged by the merge check alone, not refused for protection", () => {
  const s = session("claude", "unprotected");
  s.prompt("sage mode");
  assert.match(s.prompt("autopilot on"), WARNING);
  const sha = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
  const out = s.send({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: `gh pr merge 41 --squash --delete-branch --match-head-commit ${sha}` } });
  const reason = out?.hookSpecificOutput?.permissionDecisionReason ?? "";
  assert.match(reason, /merge check/, "the merge check judges the merge");
  assert.doesNotMatch(reason, /protect/i, "protection never refuses it");
});
