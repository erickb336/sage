import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const BACKER = { "review-clean": "code-reviewer", "security-clean": "security-reviewer", "ux-clean": "ux-reviewer", "qa-pass": "qa", findings: "code-reviewer", "qa-fail": "qa" };

export function reportFor(kind, { result, findings } = {}) {
  const problem = ["findings", "qa-fail"].includes(kind), qa = BACKER[kind] === "qa";
  const word = result ?? (problem ? (qa ? "FAIL" : "FINDINGS") : qa ? "PASS" : "CLEAN");
  return ["STATUS done", `RESULT ${word}`, "EVIDENCE the test's review", `FINDINGS ${findings ?? (problem ? "\n- K1 medium the test's finding" : "none")}`, "QUESTIONS none", "NOT VERIFIED none", "BRANCH none"].join("\n");
}

export function linkFinding(dir, task, run) {
  const file = join(dir, "findings.tsv"), [head, ...rows] = readFileSync(file, "utf8").split("\n"), cols = head.split("\t");
  const of = (row, col) => row.split("\t")[cols.indexOf(col)];
  const k = rows.findLastIndex((row) => of(row, "task") === task && of(row, "status") === "open" && of(row, "severity") !== "low");
  if (k >= 0) rows[k] = rows[k].split("\t").with(cols.indexOf("run"), run).join("\t");
  writeFileSync(file, [head, ...rows].join("\n"));
}

const valueOf = (args, name) => {
  const k = args.findIndex((a) => a === name || a.startsWith(`${name}=`));
  return k < 0 ? undefined : args[k] === name ? args[k + 1] : args[k].slice(name.length + 1);
};

export function backed(args, { cli, keep, link }) {
  const kind = valueOf(args, "--kind"), role = BACKER[kind];
  if (args[0] !== "verdict" || !role || valueOf(args, "--run") !== undefined) return args;
  const task = args[1], sha = String(valueOf(args, "--sha") ?? "");
  let id;
  try {
    id = /^(R[1-9]\d*) running/.exec(cli("run", "add", task, "--role", role))?.[1];
    if (!id) return args;
    keep({ task, run: id, role, sha: /^[0-9a-f]{40}$/i.test(sha) ? sha.toLowerCase() : "", text: reportFor(kind) });
    cli("run", "done", id, "--status", "done", "--tokens", "1");
    if (["findings", "qa-fail"].includes(kind)) link?.(task, id);
  } catch {
    return args;
  }
  return [...args, "--run", id];
}

export const backedSage = (tool, project, env) => {
  const sage = (...args) => tool.sage([...args, "--project", project], env);
  return (...args) => sage(...backed(args, { cli: sage, keep: (fields) => tool.keepReport(project, fields, env) }));
};
