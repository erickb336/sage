#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { exactPhrase, PHRASES, readAdmission } from "../../core/index.mjs";
import { tool } from "./sage.mjs";

const source = fileURLToPath(import.meta.url);
const hash = value => createHash("sha256").update(value).digest("hex");
const fail = message => { throw Error(message); };
const text = value => typeof value === "string" && value.length > 0 && value.length <= 2048 && !/[\p{Cc}\p{Cf}]/u.test(value);
const sha = value => typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
const taskId = value => typeof value === "string" && /^T[1-9]\d*$/.test(value);
const keys = (value, required, optional = []) => value && typeof value === "object" && !Array.isArray(value)
  && required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => [...required, ...optional].includes(key));
function regular(file) {
  const st = lstatSync(file);
  if (!st.isFile() || st.size > 1024 * 1024) fail("Expected a regular file of at most 1 MiB");
  return readFileSync(file, "utf8");
}
function save(file, state) {
  const tmp = `${file}.${randomUUID()}`;
  const fd = openSync(tmp, "wx", 0o600);
  try { writeFileSync(fd, `${JSON.stringify(state)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, file);
  const dir = openSync(join(file, ".."), "r");
  try { fsyncSync(dir); } finally { closeSync(dir); }
}
function readState(file, project) {
  if (!existsSync(file)) return { version: 1, project, sessions: {}, publications: {} };
  const state = JSON.parse(regular(file));
  if (!keys(state, ["version", "project", "sessions", "publications"]) || state.version !== 1 || state.project !== project
    || !state.sessions || Array.isArray(state.sessions) || !state.publications || Array.isArray(state.publications)) fail("Invalid workflow state");
  return state;
}
function run(command, args, env) {
  return execFileSync(command, args, { env, encoding: "utf8", timeout: 30000, maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }).trim();
}
/**
 * The release check (T534). The build writes the sha256 of this file and of each file that it imports into
 * publisher.json beside it. The reviewed, CI-checked release is the verification; a changed or missing file refuses.
 */
function publisherFault() {
  const changed = [];
  try {
    const { files } = JSON.parse(readFileSync(join(dirname(source), "publisher.json"), "utf8"));
    if (!Object.hasOwn(files, "skills/sage/workflow.mjs")) changed.push("skills/sage/workflow.mjs");
    for (const [file, sum] of Object.entries(files)) {
      try { if (hash(readFileSync(join(dirname(source), "..", "..", file))) !== sum) changed.push(file); } catch { changed.push(file); }
    }
  } catch { changed.push("skills/sage/publisher.json"); }
  return changed.length ? `The installed publisher does not match its release (changed or missing: ${changed.join(", ")}); reinstall sage from its marketplace` : null;
}
const githubRepo = url => /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(url)?.[1]?.toLowerCase();

/** Chief-only procedural entry point. Caller declarations are not native authentication. */
export function workflow(input, { env = process.env, github = args => JSON.parse(run("gh", args, env)) } = {}) {
  const fields = {
    status: [], owner: ["text", "directOwner", "evidence"],
    register: ["task", "repo", "base", "admissionJournals", "manualConfirmed", "noKnownNativeAssignment"], publish: ["task", "sha"], reconcile: ["task"],
  };
  if (!input || !Object.hasOwn(fields, input.action) || !keys(input, ["action", "project", "session", ...fields[input.action]])
    || !text(input.project) || !isAbsolute(input.project) || !/^[A-Za-z0-9:_-]{1,256}$/.test(input.session ?? "")) fail("Invalid workflow request");
  const project = realpathSync(tool.projectRoot(realpathSync(input.project)));
  const dir = tool.storeDir(project, env);
  if (input.action === "status" && !lstatSync(dir, { throwIfNoEntry: false })) {
    // A missing leaf can hide a dangling ancestor link. Validate the existing ancestor before reporting off.
    let ancestor = dirname(dir);
    while (!lstatSync(ancestor, { throwIfNoEntry: false })) ancestor = dirname(ancestor);
    if (realpathSync(ancestor) !== ancestor || !lstatSync(ancestor).isDirectory()) fail("Invalid logbook location");
    const fault = publisherFault();
    return { project, session: input.session, sage: false, autopilot: false, publisherVerified: !fault, ...fault && { publisherFault: fault }, publications: {} };
  }
  if (realpathSync(dir) !== dir) fail("Invalid logbook location");
  const file = join(dir, "codex-workflow.json");
  const sessionKey = hash(input.session);
  const api = (path, extra = []) => github(["api", "--hostname", "github.com", path, ...extra]);
  const git = args => run("git", ["-C", input.project, ...args], Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith("GIT_"))));
  const evidence = value => {
    if (!text(value) || !isAbsolute(value) || !regular(value).trim()) fail("A nonempty local evidence file is required");
    return { path: realpathSync(value), sha256: hash(regular(value)) };
  };
  const task = id => {
    if (!taskId(id)) fail("Invalid task");
    const found = tool.read(dir, "tasks").filter(row => row.id === id);
    if (found.length !== 1) fail("Task is missing or ambiguous");
    return found[0];
  };
  const manual = (record, id) => {
    if (!record || record.manualConfirmed !== true || record.noKnownNativeAssignment !== true || !Array.isArray(record.admissionJournals)) fail("Task needs explicit manual registration");
    const runs = tool.read(dir, "runs").filter(row => row.task === id);
    if (!runs.length || runs.some(row => row.usage_provider !== "codex" || row.usage_interface !== "collaboration-tools"
      || row.usage_binding !== "chief-declared-unauthenticated")) fail("Native or ambiguous runs cannot use the manual publisher");
    for (const journal of record.admissionJournals) {
      const native = readAdmission(journal);
      if (native.preparations.some(row => row.task === id) || native.reservations.some(row => row.assignment.task === id))
        fail("A native assignment cannot use the manual publisher");
    }
    return runs;
  };
  const samePr = (pr, record, head) => {
    if (pr.number !== Number(record.pr) || pr.head?.sha !== head || pr.head?.ref !== record.branch || pr.base?.ref !== record.base
      || pr.base?.repo?.full_name?.toLowerCase() !== record.repo.toLowerCase()
      || pr.head?.repo?.full_name?.toLowerCase() !== record.repo.toLowerCase()) fail("Live PR identity or head changed");
  };
  const result = tool.withLock(dir, () => {
    const state = readState(file, project);
    const session = state.sessions[sessionKey] ?? { session: input.session, sage: false, autopilot: false, tasks: {} };
    if (session.session !== input.session || typeof session.sage !== "boolean" || typeof session.autopilot !== "boolean" || !session.tasks)
      fail("Invalid session state");
    const persist = () => { state.sessions[sessionKey] = session; save(file, state); };
    const status = () => { const fault = publisherFault(); return { project, session: input.session, sage: session.sage, autopilot: session.autopilot,
      publisherVerified: !fault, ...fault && { publisherFault: fault }, publications: state.publications }; };
    if (input.action === "status") return status();
    if (input.action === "owner") {
      if (input.directOwner !== true || typeof input.text !== "string") fail("The chief must record a direct owner instruction");
      const phrase = exactPhrase(input.text);
      if (!phrase || PHRASES[phrase].help) fail("Expected an exact owner mode phrase");
      const proof = evidence(input.evidence);
      if (phrase === "autopilot on" && !session.sage) fail("Autopilot needs Sage on");
      if (phrase === "autopilot on" && publisherFault()) fail(publisherFault());
      for (const key of ["sage", "autopilot"]) if (Object.hasOwn(PHRASES[phrase], key)) session[key] = PHRASES[phrase][key];
      session.ownerInstruction = { phrase, ...proof, at: new Date().toISOString() };
      persist(); return status();
    }
    if (input.action === "register") {
      if (!session.sage || input.manualConfirmed !== true || input.noKnownNativeAssignment !== true || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repo ?? "")
        || !text(input.base) || !Array.isArray(input.admissionJournals) || input.admissionJournals.some(path => !text(path) || !isAbsolute(path)))
        fail("Registration needs Sage on, manual confirmation, repository, base and known admission journals");
      const row = task(input.task);
      if (!tool.BRANCH.test(row.branch) || !/^[1-9]\d*$/.test(row.pr)) fail("Task needs its branch and PR number");
      const record = { task: input.task, branch: row.branch, pr: row.pr, repo: input.repo, base: input.base,
        manualConfirmed: true, noKnownNativeAssignment: true, admissionJournals: input.admissionJournals.map(path => realpathSync(path)) };
      manual(record, input.task);
      session.tasks[input.task] = record; persist(); return { registered: record };
    }
    const row = task(input.task);
    const previous = state.publications[input.task];
    if (input.action === "reconcile") {
      if (!previous) fail("No publication intent to reconcile");
      const pr = api(`repos/${previous.repo}/pulls/${previous.pr}`);
      samePr(pr, previous, previous.sha);
      if (pr.merged === true && sha(pr.merge_commit_sha)) {
        if (previous.responseCommit && previous.responseCommit !== pr.merge_commit_sha) fail("Merge commit differs from the recorded response");
        previous.outcome = "merged"; previous.mergeCommit = pr.merge_commit_sha; previous.reconciledAt = new Date().toISOString();
      }
      persist(); return { publication: previous };
    }
    if (previous) fail("Publication intent already exists; reconcile it without another submission");
    if (!sha(input.sha)) fail("Publish needs the reviewed full head SHA");
    if (!session.sage || !session.autopilot) fail("Publication needs active autopilot");
    if (publisherFault()) fail(publisherFault());
    const record = session.tasks[input.task];
    const runs = manual(record, input.task);
    const prTasks = new Set(tool.read(dir, "tasks").filter(task => task.id === row.id || task.pr === row.pr).map(task => task.id));
    const gate = tool.read(dir, "gates").find(gate => prTasks.has(gate.task) && !gate.answer);
    if (gate) fail(`Task ${gate.task} has unanswered gate ${gate.id}`);
    if (!["verified", "pr-ready"].includes(row.state) || row.branch !== record.branch || row.pr !== record.pr
      || runs.some(run => run.status === "running" && run.role !== "lead")) fail("Task is not ready or specialist ownership is active");
    if (git(["branch", "--show-current"]) !== record.branch || git(["rev-parse", "HEAD"]) !== input.sha) fail("Local branch or head changed");
    // The remote is found by its URL, not by its name: one remote of the checkout must point to the PR's repository.
    const remotes = git(["remote"]).split("\n").filter(Boolean)
      .filter(name => git(["remote", "get-url", "--all", name]).split("\n").some(url => githubRepo(url) === record.repo.toLowerCase()));
    if (remotes.length !== 1) fail(remotes.length ? `More than one remote (${remotes.sort().join(", ")}) points to github.com/${record.repo}; keep one`
      : `No remote of this checkout points to github.com/${record.repo}`);
    const eligible = tool.mergeCheck(input.sha, env, { pr: record.pr, head: record.branch, project, readOnly: true });
    if (!eligible.ok) fail(eligible.reason);
    const path = `repos/${record.repo}/pulls/${record.pr}`;
    const pr = api(path);
    samePr(pr, record, input.sha);
    if (pr.state !== "open" || pr.draft !== false || pr.merged !== false || pr.mergeable !== true || pr.mergeable_state !== "clean")
      fail("PR must be open, ready and mergeable without a queue");
    const checks = api(`repos/${record.repo}/commits/${input.sha}/check-runs?per_page=100`);
    const statuses = api(`repos/${record.repo}/commits/${input.sha}/status?per_page=100`);
    if (!Array.isArray(checks.check_runs) || checks.total_count !== checks.check_runs.length || checks.total_count > 100
      || !Array.isArray(statuses.statuses) || statuses.total_count !== statuses.statuses.length || statuses.total_count > 100
      || checks.total_count + statuses.total_count < 1
      || checks.check_runs.some(check => check.head_sha !== input.sha || check.status !== "completed" || check.conclusion !== "success")
      || statuses.statuses.some(status => status.state !== "success") || (statuses.total_count > 0 && statuses.state !== "success"))
      fail("All live checks must succeed; incomplete or empty check results refuse");
    const intent = { ...record, sha: input.sha, session: input.session, outcome: "unresolved", submittedAt: new Date().toISOString() };
    state.publications[input.task] = intent; persist();
    try {
      const response = api(`${path}/merge`, ["--method", "PUT", "-f", `sha=${input.sha}`, "-f", "merge_method=squash"]);
      if (response.merged !== true || !sha(response.sha)) fail("GitHub did not confirm the merge");
      intent.responseCommit = response.sha;
      const after = api(path); samePr(after, record, input.sha);
      if (after.merged !== true || after.merge_commit_sha !== response.sha) fail("Merge outcome needs reconciliation");
      intent.outcome = "merged"; intent.mergeCommit = response.sha;
    } catch (error) { intent.error = String(error.message).slice(0, 2048); }
    persist(); return { publication: intent };
  });
  // Core owns the transition and its lock. A crash here leaves a durable, reconcilable intent.
  if (result.publication?.outcome === "merged") {
    try {
      manual(result.publication, result.publication.task);
      const row = task(result.publication.task);
      if (row.branch !== result.publication.branch || row.pr !== result.publication.pr) fail("Task changed after publication");
      if (row.state !== "merged") tool.sage(["task", row.id, "set", "state=merged", "--project", project], env);
      result.localState = "merged";
    } catch (error) { result.localState = "unresolved"; result.localError = error.message; }
  }
  return result;
}

let entry;
try { if (process.argv[1]) entry = realpathSync(process.argv[1]); } catch { /* Import only. */ }
if (entry === source) {
  try { process.stdout.write(`${JSON.stringify(workflow(JSON.parse(readFileSync(0, "utf8"))))}\n`); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
