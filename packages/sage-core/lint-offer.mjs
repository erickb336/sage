import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AST_GREP_VERSION, LINT_CONFIG, attributes } from "./lint.mjs";
import { readLocalGit } from "./local-git.mjs";

export const RULE_SET = fileURLToPath(new URL("./lint", import.meta.url));
export const LINT_LANGUAGES = JSON.parse(readFileSync(join(RULE_SET, "languages.json"), "utf8"));
export const TOOL_FILES = ["package.json", "package-lock.json"];
const REGULAR = /^100(644|755)$/;
const BIG = { maxBuffer: 1 << 28, timeout: 120_000 };

export function projectLanguages(top, main) {
  const git = (args, input) => readLocalGit(top, args, input, BIG);
  const byExtension = new Map(Object.entries(LINT_LANGUAGES).flatMap(([name, { extensions }]) => extensions.map((e) => [e, name])));
  const files = git(["ls-tree", "-r", "-z", "--full-tree", main]).toString("utf8").split("\0").filter(Boolean)
    .map((entry) => [entry.slice(0, entry.indexOf(" ")), entry.slice(entry.indexOf("\t") + 1)])
    .filter(([mode]) => REGULAR.test(mode)).map(([, path]) => path);
  const marked = attributes(git, main, files), counts = new Map();
  for (const path of files) {
    const name = basename(path), dot = name.lastIndexOf("."), language = dot > 0 && byExtension.get(name.slice(dot + 1));
    if (language && !marked.has(path)) counts.set(language, (counts.get(language) ?? 0) + 1);
  }
  return [...counts].sort(([a], [b]) => (a < b ? -1 : 1)).map(([name, count]) => ({ name, files: count, rules: LINT_LANGUAGES[name].rules ?? [], settings: LINT_LANGUAGES[name].settings ?? [] }));
}

export const languageList = (languages) => {
  const names = languages.map((l) => l.name);
  return names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
};

export function placeToolFiles(tools) {
  mkdirSync(tools, { recursive: true });
  for (const name of TOOL_FILES) writeFileSync(join(tools, name), readFileSync(join(RULE_SET, "tools", name)));
  return tools;
}

export function adoptBrief({ task, gate, top, main, languages, binary, standing }) {
  const branch = `${task.toLowerCase()}-lint-rules`;
  const each = languages.map((l) => `              - ${l.name} (${l.files} ${l.files === 1 ? "file" : "files"}): ${l.rules.length
    ? `copy ${l.rules.map((r) => `rules/${r}.yml and rule-tests/${r}-test.yml`).join(", ")}.`
    : `sage has no rule for it yet: write rules/no-comments-${l.name.toLowerCase()}.yml and rule-tests/no-comments-${l.name.toLowerCase()}-test.yml, as the README says.`}`);
  const settings = languages.flatMap((l) => l.settings.map((s) => `${l.name}: ${s}`));
  return [
    `GOAL        Add sage's no-comments lint rules to this project for its languages, ${languageList(languages) || "none found"}, and open a pull request against main.`,
    `SCOPE       Task ${task} only (small). Make the branch ${branch} from origin/main in your own worktree of ${top}. Files: a root ${LINT_CONFIG}, a lint/ folder (rules/, utils/, rule-tests/ and README.md), and the repository's linter settings that require comments. Keep the comments that the code has now.`,
    `CONTEXT     - sage's rule set: ${RULE_SET}. Its README.md, section "Adopt the rules", has the steps.`,
    `            - The languages of the files of origin/main ${main.slice(0, 7)}, by extension, as ast-grep ${AST_GREP_VERSION} reads them (languages.json in the rule set):`,
    ...each,
    `            - Linter settings that require comments, to look for: ${settings.join("; ") || "none known for these languages; look for any"}.`,
    `            - ast-grep ${AST_GREP_VERSION}: ${binary}.`,
    `DECISIONS   The owner said yes to the lint offer (gate ${gate}).`,
    "            - Turn off each linter setting that requires a comment or a doc comment, and list each one in the pull request.",
    "            - A directive stays only when a tool reads it and no free text follows it. Refuse a directive that demands free text, such as a reason.",
    "            - A file that ast-grep cannot parse is not checked: list each one in the pull request.",
    "            - The rules apply to the pull requests after this one, because lint reads them from origin/main.",
    `ACCEPTANCE  - ast-grep test --skip-snapshot-tests passes at the root, with valid and invalid cases for each rule.`,
    `            - ast-grep scan --config ${LINT_CONFIG} runs on the whole tree with no rule error. The pull request gives the count of the comments it finds now, which stay.`,
    "            - The pull request lists the languages, the rules, the linter settings that it turned off and the files that ast-grep skips.",
    `VERIFY      ${binary} test --skip-snapshot-tests; ${binary} scan --config ${LINT_CONFIG} . ; the project's own checks.`,
    "BUDGET      About 1 hour of agent time. On expiry, stop and report.",
    "FORBIDDEN   No merge, no force-push, no push to main, no changes out of scope. No install outside your scratch folder. No comment removed from the code.",
    "REPORT      The sage report. RESULT: the pull request, its rules and the settings that it turned off. BRANCH with the full 40-character head SHA.",
    `STANDING    The standing orders apply in full: read them with ${standing} before you start, and put the same pointer in every helper brief.`,
    "",
  ].join("\n");
}
