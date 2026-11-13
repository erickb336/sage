import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, join, matchesGlob } from "node:path";
import { fileURLToPath } from "node:url";
import { LINT_CONFIG, astGrepScan, skippedText } from "../packages/sage-core/lint.mjs";

export const RULE_SET = fileURLToPath(new URL("../packages/sage-core/lint", import.meta.url));

export const AST_GREP = createRequire(import.meta.url)("@ast-grep/cli/postinstall.js").resolveBinaryPath();

const binary = () => AST_GREP || (() => { throw new Error("@ast-grep/cli has no binary for this platform: it ships one for macOS, Windows and Linux with glibc"); })();

export function astGrep(args, dir = RULE_SET, cwd = dir, paths = []) {
  return spawnSync(binary(), [...args, "--config", `${dir}/sgconfig.yml`, "--color", "never", "--", ...paths], { cwd, encoding: "utf8", maxBuffer: 1 << 28 });
}

export function ruleTestProblems(dir = RULE_SET) {
  const run = astGrep(["test", "--skip-snapshot-tests"], dir);
  if (run.status === 0) return [];
  const output = `${run.stdout}${run.stderr}`, lines = output.split("\n").filter((line) => /^(FAIL|\[|Error|  \S)/.test(line));
  const files = [...output.matchAll(/^FAIL (\S+)/gm)].map(([, id]) => `rules/${id}.yml or rule-tests/${id}-test.yml`);
  return [`packages/sage-core/lint: ast-grep test failed (exit ${run.status ?? run.error?.code}); fix ${files.join(", ") || "the file that the error names"}, as "Change the rule set" in packages/sage-core/lint/README.md says:\n${lines.join("\n")}`];
}

export const SCAN_FOLDERS = ["packages", "scripts", ".github"];

export function scanExclusions(root) {
  const file = join(root, ".gitattributes");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split(/\r?\n/).map((line) => line.trim().split(/\s+/))
    .filter(([glob, ...attributes]) => glob && !glob.startsWith("#") && attributes.some((a) => /^linguist-(generated|vendored)(=true)?$/.test(a)))
    .map(([glob]) => glob);
}

export function excludedPaths(root, paths) {
  const globs = scanExclusions(root);
  return paths.filter((path) => globs.some((glob) => matchesGlob(glob.includes("/") ? path : basename(path), glob)));
}

const NO_IGNORE_FILES = ["hidden", "dot", "exclude", "global", "parent", "vcs"].flatMap((kind) => ["--no-ignore", kind]);

export function commentScan(root, paths = SCAN_FOLDERS) {
  const excluded = excludedPaths(root, paths), kept = paths.filter((path) => !excluded.includes(path));
  if (!kept.length) return [];
  const globs = ["!.git", "!node_modules", ...scanExclusions(root).map((glob) => `!${glob}`)].flatMap((glob) => ["--globs", glob]);
  const config = existsSync(join(root, LINT_CONFIG)) ? join(root, LINT_CONFIG) : join(RULE_SET, LINT_CONFIG);
  const { matches, files } = astGrepScan(binary(), { config, cwd: root, paths: kept, args: [...NO_IGNORE_FILES, ...globs] });
  const skipped = [...files].filter(([, f]) => f.skipped && f.skipped !== "emptyFile").map(([file, f]) => `${file}: ${skippedText(f.skipped)}`);
  if (skipped.length) throw new Error(skipped.join("\n"));
  if (matches.some((m) => m.severity !== "error")) throw new Error(`ast-grep scan gave a match with a severity other than error; give each rule in ${RULE_SET}/rules severity: error`);
  return matches;
}

export function commentProblems(root, paths = SCAN_FOLDERS) {
  return commentScan(root, paths).map((m) => `${m.file}:${m.range.start.line + 1}: a comment (${m.ruleId}), ${JSON.stringify(m.text.replace(/\s+/g, " ").slice(0, 120))}; remove it, or run node scripts/strip-comments.mjs; put a reason that a reader needs in a name, a test name or a doc (packages/sage-core/lint/README.md)`);
}
