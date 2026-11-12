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
  const lines = `${run.stdout}${run.stderr}`.split("\n").filter((line) => /^(FAIL|\[|Error|  \S)/.test(line));
  return [`packages/sage-core/lint: ast-grep test failed (exit ${run.status ?? run.error?.code}); the rule set and its rule-tests disagree:\n${lines.join("\n")}`];
}
