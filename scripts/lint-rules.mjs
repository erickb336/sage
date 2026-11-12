import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

export const RULE_SET = fileURLToPath(new URL("../packages/sage-core/lint", import.meta.url));

const binary = createRequire(import.meta.url)("@ast-grep/cli/postinstall.js").resolveBinaryPath();

export function astGrep(args, dir = RULE_SET) {
  if (!binary) throw new Error("@ast-grep/cli has no binary for this platform: it ships one for macOS, Windows and Linux with glibc");
  return spawnSync(binary, [...args, "--config", `${dir}/sgconfig.yml`, "--color", "never"], { cwd: dir, encoding: "utf8" });
}

export function ruleTestProblems(dir = RULE_SET) {
  const run = astGrep(["test", "--skip-snapshot-tests"], dir);
  if (run.status === 0) return [];
  const output = `${run.stdout}${run.stderr}`, lines = output.split("\n").filter((line) => /^(FAIL|\[|Error|  \S)/.test(line));
  const files = [...output.matchAll(/^FAIL (\S+)/gm)].map(([, id]) => `rules/${id}.yml or rule-tests/${id}-test.yml`);
  return [`packages/sage-core/lint: ast-grep test failed (exit ${run.status ?? run.error?.code}); fix ${files.join(", ") || "the file that the error names"}, as "Change the rule set" in packages/sage-core/lint/README.md says:\n${lines.join("\n")}`];
}
