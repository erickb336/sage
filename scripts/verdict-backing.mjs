// A test helper (T483). The state tool records a review or QA verdict on a task with a build only when a report that a
// stop hook kept backs it. A test whose story records such a verdict as one of its steps first does what a review does:
// it adds the run, keeps its helper's report as the hook does, and ends the run, then names the run with --run.

/** The role of the run that backs each review or QA verdict kind in these tests. */
export const BACKER = { "review-clean": "code-reviewer", "security-clean": "security-reviewer", "ux-clean": "ux-reviewer", "qa-pass": "qa", findings: "code-reviewer", "qa-fail": "qa" };

/** A full report of a run's helper that backs the kind: clean, or with one medium finding. */
export function reportFor(kind, { result, findings } = {}) {
  const problem = ["findings", "qa-fail"].includes(kind), qa = BACKER[kind] === "qa";
  const word = result ?? (problem ? (qa ? "FAIL" : "FINDINGS") : qa ? "PASS" : "CLEAN");
  return ["STATUS done", `RESULT ${word}`, "EVIDENCE the test's review", `FINDINGS ${findings ?? (problem ? "\n- K1 medium the test's finding" : "none")}`, "QUESTIONS none", "NOT VERIFIED none", "BRANCH none"].join("\n");
}

/** The value of an option in a command's words, as --name value or --name=value. */
const valueOf = (args, name) => {
  const k = args.findIndex((a) => a === name || a.startsWith(`${name}=`));
  return k < 0 ? undefined : args[k] === name ? args[k + 1] : args[k].slice(name.length + 1);
};

/**
 * The words of a state tool command, with --run of a new run that backs the verdict when the command is a review or QA
 * verdict without --run; else the words as they are. cli(...words) runs a command and returns its output or throws;
 * keep(fields) keeps the run's report as a stop hook does. When a step cannot be made (the task is held, or it is not in
 * the logbook), the words stay as they are, so that the test sees the verdict's own refusal.
 */
export function backed(args, { cli, keep }) {
  const role = BACKER[valueOf(args, "--kind")];
  if (args[0] !== "verdict" || !role || valueOf(args, "--run") !== undefined) return args;
  const task = args[1], sha = String(valueOf(args, "--sha") ?? "");
  let id;
  try {
    id = /^(R[1-9]\d*) running/.exec(cli("run", "add", task, "--role", role))?.[1];
    if (!id) return args;
    keep({ task, run: id, role, sha: /^[0-9a-f]{40}$/i.test(sha) ? sha.toLowerCase() : "", text: reportFor(valueOf(args, "--kind")) });
    cli("run", "done", id, "--status", "done", "--tokens", "1");
  } catch {
    return args;
  }
  return [...args, "--run", id];
}

/** A state tool's command in this process (tool.sage), on one project, that backs a review or QA verdict first. */
export const backedSage = (tool, project, env) => {
  const sage = (...args) => tool.sage([...args, "--project", project], env);
  return (...args) => sage(...backed(args, { cli: sage, keep: (fields) => tool.keepReport(project, fields, env) }));
};
