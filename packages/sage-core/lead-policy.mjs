// The one lead policy (T928): what a lead may record in the logbook, for both providers. The state tool's guard applies it
// to every write with --lead, the Claude hook to a lead's Bash command, and the Codex gate and state server to a lead's
// sage tool call. So a lead's honest mistake gets the same plain reason in Claude and in Codex. The guards keep a lead on
// its brief; a lead that acts against its brief on purpose is a documented limit (standing orders 49 and 70). The gap
// rule (gap) reads the kept reports, so a lead learns a left-out finding at its next step in both providers. Verdict
// backing (a kept report of a done run), the clean cycles and the merge check are the guards of the merge.
import { TEAM } from "./role-policy.mjs";

/** The commands of a lead, as the state tool's words; a Codex tool's name is the same words joined by _. */
export const LEAD_COMMANDS = ["run add", "run done", "finding add", "finding close", "finding triage", "verdict", "round", "task set", "pages"];
/** The verdict kinds of a lead: each has a kept report of a review or QA behind it. A checks verdict is the chief's. */
const LEAD_KINDS = ["review-clean", "security-clean", "ux-clean", "qa-pass", "qa-fail", "findings"];
/** The keys of task set that a lead sets on its task. */
const LEAD_FIELDS = ["state", "branch", "pr"];
/** The state moves of a cycle that a lead makes, by the task's state. Only the chief moves a task from any other state. */
const LEAD_MOVES = { briefed: ["building"], building: ["reviewing"], reviewing: ["verifying"], repairing: ["reviewing"], verifying: ["verified", "reviewing"], verified: ["reviewing"] };
/** The states in which a lead records nothing and starts no agent. */
const LEAD_STOPS = ["held", "replan", "merged", "concluded", "abandoned"];
/** The number of words of each command, so that no word goes past the policy unread. */
const WORDS = { "run add": 2, "run done": 2, "finding add": 2, "finding close": 3, "finding triage": 4, verdict: 1, round: 1 };
const LIST = `A lead records only its own task, with ${LEAD_COMMANDS.slice(0, -1).filter((c) => c !== "task set").join(", ")}, pages, and task set of ${LEAD_FIELDS.join(", ")}. Put what else the logbook needs in your report.`;
const TEAM_TEXT = [...TEAM].join(", ");

/**
 * A lead's state tool command, as its words give it, in the form of a Codex tool call: { command, task, run, key,
 * decision, reason, role, branch, kind, pr, sha, status, fields }. odd: the command has other words than its form (also
 * task set T1 state=…, with its words in the wrong order), or a task set key twice or with no value.
 */
export function leadRequest(cmd, pos, opt) {
  const set = cmd === "task" && pos[1] === "set", command = set ? "task set" : [`${cmd} ${pos[0]}`, cmd].find((name) => LEAD_COMMANDS.includes(name)) ?? [cmd, ...pos.slice(0, 1)].join(" ");
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

/**
 * Why the lead of task own records nothing and starts no agent, or undefined: task (its row) is missing, held, in replan
 * or ended. Both providers give this reason, for a write and for a start of an agent.
 */
export function leadStopped(own, task) {
  if (!task) return `the logbook has no task ${own}, so its lead records nothing and starts no agent. Report to your chief.`;
  return LEAD_STOPS.includes(task.state) ? `${own} is ${task.state}, so its lead records nothing and starts no agent. Report to your chief.` : undefined;
}

/**
 * Why a lead may not make this request, or undefined. lead is its running lead run ({ id, task }); view is the
 * logbook's read-only view (logbookView); head() gives the commit at the head of the task's branch, or "". The order: the
 * list, the lead's own task, a task that records nothing, the round order, then the values of the command.
 */
export function leadProblem(request, { lead, view, ofTask, branchOfTask, head }) {
  const own = lead.task, { command } = request;
  if (!LEAD_COMMANDS.includes(command) || request.odd) return `"${command}" is not on a lead's list${request.odd ? ", or it has other words" : ""}. ${LIST}`;
  // Each id that the request names is of the lead's task: its task, a run, a finding key.
  const notOwn = (id) => `${id} is not of ${own}, and a lead records only its own task. Report to your chief what ${id} needs.`;
  // finding add takes no key (below); an empty run is the state tool's to refuse.
  const named = command === "finding close" || command === "finding triage", run = request.run ? view.row(String(request.run)) : undefined, finding = named ? view.row(String(request.key)) : undefined;
  if (command !== "run done" && request.task !== own) return notOwn(request.task ?? "no task");
  if ((request.run || command === "run done") && run?.task !== own) return notOwn(request.run || "no run");
  if (named && finding?.task !== own) return notOwn(request.key);
  const task = view.task(own), stopped = leadStopped(own, task);
  if (stopped) return stopped;
  const roundKeys = String(task.keys ?? "").split(",").filter(Boolean);
  // The round order (F5): a repair goes through round, so the rounds count and a task can reach held. While a medium or
  // high finding is triaged fix and the task is not repairing, a lead closes no finding and records no verdict on a new commit.
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
      // Proof by run (T947): in a cycle, a medium or high finding goes to a fix, and a medium one to a drop, only after the
      // proof check reran its proof on the head (--proof, which the state tool checks). A high one is never the lead's to drop.
      if (request.decision === "fix") return finding.severity !== "low" && ["reviewing", "verifying"].includes(task.state) && request.proof === undefined ? `${finding.key} is ${finding.severity}: in a cycle, a lead triages it fix only with --proof R<n>, the done proof check whose report says ${finding.key} reproduced or could not run. Run the proof check first (the proof-check reference).` : undefined;
      if (request.decision !== "dismiss") return undefined; // a word that the state tool refuses
      if (finding.severity === "high") return `${finding.key} is high: a lead never dismisses it, also when the proof check did not reproduce it. Report it, or triage it fix: the chief decides.`;
      if (finding.severity === "medium" && request.proof === undefined) return `${finding.key} is medium: a lead dismisses it only with --proof R<n>, the done proof check whose report says ${finding.key} not reproduced. Else report it, or triage it fix.`;
      // A fix key of the round, or of an earlier round, stays for the chief: the next round, a replan or its own dismissal.
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
    default:
      return undefined; // round and pages: the state tool's own rules
  }
}

/**
 * The gap rule (T956, from the Claude hook's F-T289-17 and F-T289-18): a lead goes on only after it records the findings
 * of its helpers' reports. Each medium or high finding of a kept review or QA report of the task needs its row with the
 * run (finding add --run), at its severity or above, in any status; a low finding needs none. The rule holds the lead's
 * next run add of that role, its run done of that run and its state move (of, the runs that hold this request). A report
 * that cannot be read holds them while its run runs, until the chief ends it. Any run of the task counts, also one that
 * the chief or an earlier lead added: a finding of the task is not lost between leads. The reason, or undefined.
 */
function gap(view, own, of) {
  const [first, ...more] = view.unrecorded(own).filter(of);
  if (!first) return undefined;
  if (first.problem) return `${first.run}'s report cannot be read (${first.problem}), and ${first.run} still runs: your chief ends it before this lead's next ${first.role} run, its run done or a state move. Name it in FINDINGS of your report.`;
  const keys = first.missing.map((f) => `${f.key} (${f.severity})`).join(", "), [{ severity }] = first.missing;
  const one = first.missing.every((f) => f.severity === severity) ? severity : "<its severity>";
  return `${first.run}'s ${first.role} report has ${first.missing.length === 1 ? "a medium or high finding" : "medium or high findings"} with no row on ${own}: ${keys}. Record each one first, one row for each key, at its severity or above and with the run: sage finding add ${own} --source ${first.role} --severity ${one} --summary=<word> --run ${first.run} --class <class>.${more.length ? ` Then do the same for ${more.map((g) => g.run).join(", ")}.` : ""}`;
}

/** A run's --branch: a branch named for the task, or the task's branch=, and not one that the chief moved the task off. */
function runBranch(branch, own, task, view, ofTask) {
  if (!ofTask(own, branch) && branch !== task.branch) return `${branch} is not a branch of ${own}.`;
  const others = branch.toLowerCase() === String(task.branch).toLowerCase() ? [] : [...view.branchTasks(branch)].filter((id) => id !== own);
  const way = task.branch ? `to ${task.branch}: add the run on ${task.branch}` : `and cleared its branch=: add the run on a branch named for ${own} that no other task uses`;
  return others.length ? `${branch} is shared with ${others.join(", ")}, and the chief moved ${own} off it ${way}, or ask your chief to move ${own} back.` : undefined;
}

/** task set branch=: only a branch named for the task, and only the chief moves a task onto a shared branch or off it. */
function taskBranch(branch, own, task, view, branchOfTask) {
  if (!(branch !== "" && branchOfTask(task, branch) && (!task.branch || branchOfTask(task, task.branch)))) return `${JSON.stringify(branch)} is not a branch named for ${own}, or ${own} is on a branch of another task: only the chief sets that.`;
  if (branch === task.branch) return undefined;
  const shared = [task.branch, branch].find((name) => name && [...view.branchTasks(name)].some((id) => id !== own));
  return shared ? `${shared} is shared with ${[...view.branchTasks(shared)].filter((id) => id !== own).join(", ")}: only the chief moves a task onto a shared branch or off it.` : undefined;
}

/**
 * task set state=: the next move of a cycle. To verifying only with a full clean cycle on the head; back to reviewing
 * from verifying or verified only when the head moved past its clean cycles; out of repairing only after each fix of
 * the round is closed.
 */
function stateMove(state, own, task, view, head, roundKeys) {
  const next = LEAD_MOVES[task.state] ?? [];
  if (!next.includes(state)) return `${own} is ${task.state}: ${next.length ? `a lead moves it only to ${next.join(" or ")}` : "only the chief moves it from there"}.`;
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
