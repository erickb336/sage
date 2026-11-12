import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

export const RULE_SET = fileURLToPath(new URL("../packages/sage-core/lint", import.meta.url));

const binary = createRequire(import.meta.url)("@ast-grep/cli/postinstall.js").resolveBinaryPath();

export function astGrep(args, dir = RULE_SET, cwd = dir) {
  if (!binary) throw new Error("@ast-grep/cli has no binary for this platform: it ships one for macOS, Windows and Linux with glibc");
  return spawnSync(binary, [...args, "--config", `${dir}/sgconfig.yml`, "--color", "never"], { cwd, encoding: "utf8", maxBuffer: 1 << 28 });
}

export function ruleTestProblems(dir = RULE_SET) {
  const run = astGrep(["test", "--skip-snapshot-tests"], dir);
  if (run.status === 0) return [];
  const output = `${run.stdout}${run.stderr}`, lines = output.split("\n").filter((line) => /^(FAIL|\[|Error|  \S)/.test(line));
  const files = [...output.matchAll(/^FAIL (\S+)/gm)].map(([, id]) => `rules/${id}.yml or rule-tests/${id}-test.yml`);
  return [`packages/sage-core/lint: ast-grep test failed (exit ${run.status ?? run.error?.code}); fix ${files.join(", ") || "the file that the error names"}, as "Change the rule set" in packages/sage-core/lint/README.md says:\n${lines.join("\n")}`];
}

export const SCAN_FOLDERS = ["packages", "scripts", ".github"];

export const SCAN_EXCLUSIONS = [
  { glob: "scripts/fixtures/sage-14c0d0c/**", reason: "a frozen copy of the state tool at commit 14c0d0c, which scripts/sage.test.mjs runs as the old version: its text is test data" },
  { glob: "packages/sage-core/lint/rule-tests/**", reason: "the rule set's own test cases, whose comments are the data that the rules must flag or pass" },
];

export function commentScan(root, paths = SCAN_FOLDERS) {
  const globs = ["!.git", ...SCAN_EXCLUSIONS.map(({ glob }) => `!${glob}`)].flatMap((glob) => ["--globs", glob]);
  const run = astGrep(["scan", "--no-ignore", "hidden", ...globs, "--json=compact", ...paths], RULE_SET, root);
  if (run.status !== 0 && run.status !== 1) throw new Error(`ast-grep scan exited with ${run.status ?? run.error?.code}: ${run.stderr.trim()}`);
  const matches = JSON.parse(run.stdout || "[]");
  if (matches.some((m) => m.severity !== "error")) throw new Error(`ast-grep scan gave a match with a severity other than error; give each rule in ${RULE_SET}/rules severity: error`);
  if ((run.status === 1) !== (matches.length > 0)) throw new Error(`ast-grep scan exited with ${run.status} and gave ${matches.length} matches`);
  return matches;
}

export function commentProblems(root, paths = SCAN_FOLDERS) {
  return commentScan(root, paths).map((m) => `${m.file}:${m.range.start.line + 1}: a comment (${m.ruleId}), ${JSON.stringify(m.text.replace(/\s+/g, " ").slice(0, 120))}; remove it, or run node scripts/strip-comments.mjs; put a reason that a reader needs in a name, a test name or a doc (packages/sage-core/lint/README.md)`);
}
