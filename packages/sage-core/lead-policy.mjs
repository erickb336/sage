import { TEAM } from "./role-policy.mjs";

export const LEAD_COMMANDS = ["run add", "run done", "finding add", "finding close", "finding triage", "verdict", "lint", "round", "task set", "pages"];
const LEAD_KINDS = ["review-clean", "security-clean", "ux-clean", "qa-pass", "qa-fail", "findings"];
const LEAD_FIELDS = ["state", "branch", "pr"];
const LEAD_MOVES = { framed: ["briefed"], briefed: ["building"], building: ["reviewing"], reviewing: ["verifying"], repairing: ["reviewing"], verifying: ["verified", "reviewing"], verified: ["reviewing"] };
const LEAD_STOPS = ["held", "replan", "merged", "concluded", "abandoned"];
const WORDS = { "run add": 2, "run done": 2, "finding add": 2, "finding close": 3, "finding triage": 4, verdict: 1, lint: 1, round: 1 };
const LIST = `A lead records only its own task, with ${LEAD_COMMANDS.slice(0, -1).filter((c) => c !== "task set").join(", ")}, pages, and task set of ${LEAD_FIELDS.join(", ")}. Put what else the logbook needs in your report.`;
const TEAM_TEXT = [...TEAM].join(", ");

export function leadRequest(cmd, pos, opt) {
  const sub = /^[a-z]+$/.test(pos[0] ?? "") ? [pos[0]] : [];
  const set = cmd === "task" && pos[1] === "set", command = set ? "task set" : [`${cmd} ${pos[0]}`, cmd].find((name) => LEAD_COMMANDS.includes(name)) ?? [cmd, ...sub].join(" ");
  const odd = Object.hasOwn(WORDS, command) && pos.length !== WORDS[command];
  if (set) {
    const pairs = pos.slice(2), fields = Object.fromEntries(pairs.map((kv) => [kv.slice(0, kv.indexOf("=")), kv.slice(kv.indexOf("=") + 1)]));
    return { command, task: pos[0], fields, odd: !pairs.length || pairs.some((kv) => !kv.includes("=")) || Object.keys(fields).length !== pairs.length };
  }
  const [first, second, third] = command.includes(" ") ? pos.slice(1) : pos;
  if (command === "run done") return { command, run: first, status: opt.status, odd };
  if (command === "finding close" || command === "finding triage") return { command, task: first, key: second, decision: third, reason: opt.reason, proof: opt.proof, odd };
  return { ...opt, command, task: first, odd: odd || command === "task set" || (command === "pages" && pos.length > 3) };
}

export function leadStopped(own, task) {
  if (!task) return `the logbook has no task ${own}, so its lead records nothing and starts no agent. Report to your chief.`;
  return LEAD_STOPS.includes(task.state) ? `${own} is ${task.state}, so its lead records nothing and starts no agent. Report to your chief.` : undefined;
}

export function leadProblem(request, { lead, view, ofTask, branchOfTask, head }) {
  const own = lead.task, { command } = request;
  if (!LEAD_COMMANDS.includes(command) || request.odd) return `"${command}" is not on a lead's list${request.odd ? ", or it has other words" : ""}. ${LIST}`;
  const notOwn = (id, what) => (id === undefined || id === "" ? `"${command}" names no ${what}: a lead names ${what === "task" ? `its own task, ${own}` : `a ${what} of ${own}`}.`
    : `${id} is not of ${own}, and a lead records only its own task. Report to your chief what ${id} needs.`);
  const named = command === "finding close" || command === "finding triage", run = request.run ? view.row(String(request.run)) : undefined, finding = named ? view.row(String(request.key)) : undefined;
  if (command !== "run done" && request.task !== own) return notOwn(request.task, "task");
  if ((request.run || command === "run done") && run?.task !== own) return notOwn(request.run, "run");
  if (named && finding?.task !== own) return notOwn(request.key, "finding");
  const task = view.task(own), stopped = leadStopped(own, task);
  if (stopped) return stopped;
  const roundKeys = String(task.keys ?? "").split(",").filter(Boolean);
  const repair = command === "finding close" || (command === "verdict" && !view.shas(own).has(String(request.sha ?? "").toLowerCase()));
  if (repair && task.state !== "repairing" && view.findings(own).some((f) => f.status === "open" && f.triage === "fix" && f.severity !== "low")) {
    const moves = [];
    for (let at = task.state; !["reviewing", "verifying"].includes(at) && LEAD_MOVES[at] && moves.length < 3; ) moves.push((at = LEAD_MOVES[at].includes("reviewing") ? "reviewing" : LEAD_MOVES[at][0]));
    const first = ["reviewing", "verifying"].includes(task.state) ? `run round ${own} first` : moves.at(-1) === "reviewing" ? `move ${own} to ${moves.join(", then to ")} first (task ${own} set state=${moves.join(", then state=")}), then run round ${own}` : `ask your chief to move ${own} to reviewing, then run round ${own}`;
    return `${own} has a medium or high finding triaged fix and is not repairing: ${first}, then repair.`;
  }
  switch (command) {
    case "run add":
      if (!TEAM.has(request.role)) return `a lead adds only runs of its team (${TEAM_TEXT}), not ${JSON.stringify(request.role ?? "no role")}.`;
      return (request.branch === undefined ? undefined : runBranch(request.branch, own, task, view, ofTask)) ?? gap(view, own, (g) => g.role === request.role);
    case "run done":
      return TEAM.has(run.role) ? gap(view, own, (g) => g.run === run.id) : `${run.id} is a ${run.role} run: only the chief ends it.`;
    case "finding add":
      return request.key === undefined ? undefined : "only the chief opens a known finding again: leave out the key.";
    case "finding close":
      if (finding.triage !== "fix") return `${finding.key} is not triaged fix, so a lead does not close it.`;
      return task.state === "repairing" && !roundKeys.includes(finding.key) ? `${finding.key} is not a fix of ${own}'s round: it waits for the next round.` : undefined;
    case "finding triage":
      if (finding.triage === "ask") return `${finding.key} is triaged ask: only the chief changes it, with the owner's answer.`;
      if (request.decision === "ask") return "a lead asks the owner nothing: report the question.";
      if (request.decision === "fix") return finding.severity !== "low" && ["reviewing", "verifying"].includes(task.state) && request.proof === undefined ? `${finding.key} is ${finding.severity}: in a cycle, a lead triages it fix only with --proof R<n>, the done proof check whose report says ${finding.key} reproduced or could not run. Run the proof check first (the proof-check reference).` : undefined;
      if (request.decision !== "dismiss") return undefined;
      if (finding.severity === "high") return `${finding.key} is high: a lead never dismisses it, also when the proof check did not reproduce it. Report it, or triage it fix: the chief decides.`;
      if (finding.severity === "medium" && request.proof === undefined) return `${finding.key} is medium: a lead dismisses it only with --proof R<n>, the done proof check whose report says ${finding.key} not reproduced. Else report it, or triage it fix.`;
      return finding.triage === "fix" && (roundKeys.includes(finding.key) || Number(finding.round) < Number(task.round)) ? `${finding.key} is a fix key of a round: only the chief dismisses it.` : undefined;
    case "verdict":
      if (!LEAD_KINDS.includes(request.kind)) return `the ${request.kind ?? "unnamed"} verdict is the chief's: give what it needs in your report.`;
      if (!task.pr || String(request.pr) !== task.pr) return `a lead's verdict names its task's PR (${task.pr ? `pr ${task.pr}` : `${own} has none yet: set it with task set pr=`}).`;
      return run && String(run.round) === String(task.round) ? undefined : `a lead's verdict names a run of ${own} in its current round ${task.round}, whose kept report backs it; ${JSON.stringify(request.run ?? "no run")} is not one.`;
    case "task set":
      for (const [key, value] of Object.entries(request.fields ?? {})) {
        const why = !LEAD_FIELDS.includes(key) ? `a lead sets only ${LEAD_FIELDS.join(", ")} of its task, not ${key}.`
          : key === "state" ? gap(view, own, () => true) ?? stateMove(value, own, task, view, head, roundKeys)
          : key === "branch" ? taskBranch(value, own, task, view, branchOfTask)
          : /^[1-9]\d*$/.test(value) && !task.pr && [...view.prTasks(value)].every((id) => id === own) ? undefined : `a lead gives ${own} one PR, once, that no other task has or had.`;
        if (why) return why;
      }
      return undefined;
    case "round":
      return gap(view, own, () => true);
    default:
      return undefined;
  }
}

function gap(view, own, of) {
  const [first, ...more] = view.unrecorded(own).filter(of);
  if (!first) return undefined;
  if (first.problem) return `${first.run}'s report cannot be read (${first.problem}), and ${first.run} still runs: your chief ends it before this lead's next ${first.role} run, its run done, a state move or a round. Name it in FINDINGS of your report.`;
  const keys = first.missing.map((f) => `${f.key} (${f.severity})`).join(", "), [{ severity }] = first.missing;
  const one = first.missing.every((f) => f.severity === severity) ? severity : "<its severity>";
  return `${first.run}'s ${first.role} report has ${first.missing.length === 1 ? "a medium or high finding" : "medium or high findings"} with no row on ${own}: ${keys}. Record each one first with finding add, one row for each key: task ${own}, source ${first.role}, severity ${one} or above, run ${first.run}, its class and a summary.${more.length ? ` Then do the same for ${more.map((g) => g.run).join(", ")}.` : ""}`;
}

function runBranch(branch, own, task, view, ofTask) {
  if (!ofTask(own, branch) && branch !== task.branch) return `${branch} is not a branch of ${own}.`;
  const others = branch.toLowerCase() === String(task.branch).toLowerCase() ? [] : [...view.branchTasks(branch)].filter((id) => id !== own);
  const way = task.branch ? `to ${task.branch}: add the run on ${task.branch}` : `and cleared its branch=: add the run on a branch named for ${own} that no other task uses`;
  return others.length ? `${branch} is shared with ${others.join(", ")}, and the chief moved ${own} off it ${way}, or ask your chief to move ${own} back.` : undefined;
}

function taskBranch(branch, own, task, view, branchOfTask) {
  if (!(branch !== "" && branchOfTask(task, branch) && (!task.branch || branchOfTask(task, task.branch)))) return `${JSON.stringify(branch)} is not a branch named for ${own}, or ${own} is on a branch of another task: only the chief sets that.`;
  if (branch === task.branch) return undefined;
  const shared = [task.branch, branch].find((name) => name && [...view.branchTasks(name)].some((id) => id !== own));
  return shared ? `${shared} is shared with ${[...view.branchTasks(shared)].filter((id) => id !== own).join(", ")}: only the chief moves a task onto a shared branch or off it.` : undefined;
}

function stateMove(state, own, task, view, head, roundKeys) {
  const next = LEAD_MOVES[task.state] ?? [];
  if (!next.includes(state)) return `${own} is ${task.state}: ${next.length ? `a lead moves it only to ${next.join(" or ")}` : "only the chief moves it from there"}.`;
  if (task.state === "framed" && String(task.route ?? "").split(",").includes("design")) return `${own} is framed, and its route has a design step: the chief runs the design before the brief. Report to your chief.`;
  const back = ["verifying", "verified"].includes(task.state) && state === "reviewing";
  if (back || state === "verifying") {
    const tip = head();
    if (!tip) return `the head of ${own}'s branch cannot be read, so ${own} stays at ${task.state}.`;
    const clean = view.cleanCycles(own, tip);
    if (back && clean > 0) return `${own}'s head ${tip.slice(0, 7)} has a full clean cycle, so ${own} stays at ${task.state}: a lead moves it back to reviewing only after the head moved.`;
    if (!back && clean === 0) return `${own}'s head ${tip.slice(0, 7)} has no full clean cycle yet (a clean verdict of each review and QA of its route on it), so ${own} stays at ${task.state}: record them first.`;
  }
  const open = task.state === "repairing" && view.findings(own).some((f) => f.status === "open" && f.triage === "fix" && roundKeys.includes(f.key));
  return open ? `${own} has an open fix finding of its round: close each one after the repair's commit (finding close), then move it to reviewing. When the re-check did not confirm one, run round ${own}: it starts the next round.` : undefined;
}
