import { existsSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { ROOT, filesUnder } from "./build.mjs";

const SOURCE_DIRS = ["principles", "writing", "preferences", "packages", "docs", "scripts"];
const SOURCE_FILES = ["README.md", "AGENTS.md", "CONTRIBUTING.md", "SECURITY.md"];
const TEXT = /\.(md|mjs|js|json|ya?ml|sh|txt)$/;
const OWN = /^scripts\/npx-pin(\.test)?\.mjs$/;

export const pinnedVersion = (read = (path) => readFileSync(join(ROOT, path), "utf8")) => JSON.parse(read("package.json")).devDependencies["@ast-grep/cli"];

export function npxAstGrepProblems(path, text, pin) {
  const problems = [];
  text.split("\n").forEach((line, i) => {
    const where = `${path}:${i + 1}`;
    if (/\bnpx\b/.test(line) && /\bast-grep\b/.test(line) && !line.includes(`--package=@ast-grep/cli@${pin} ast-grep`)) {
      problems.push(`${where}: npx runs the bare name ast-grep, which on npm is an unrelated package (ast-grep@0.1.0): write npx --yes --package=@ast-grep/cli@${pin} ast-grep (T1024)`);
    }
    for (const [, version] of line.matchAll(/@ast-grep\/cli@([\w.-]+)/g)) {
      if (version !== pin) problems.push(`${where}: @ast-grep/cli@${version} differs from the pin ${pin} in package.json (T1024)`);
    }
    for (const [, version] of line.matchAll(/\bast-grep (\d+\.\d+\.\d+)\b/g)) {
      if (version !== pin) problems.push(`${where}: ast-grep ${version} differs from the pin ${pin} in package.json (T1024)`);
    }
  });
  return problems;
}

export function sourceFiles(root = ROOT) {
  const dirs = SOURCE_DIRS.map((d) => join(root, d)).filter((d) => existsSync(d)).flatMap((d) => filesUnder(d));
  return [...SOURCE_FILES.map((f) => join(root, f)).filter((f) => existsSync(f) && statSync(f).isFile()), ...dirs]
    .map((f) => relative(root, f).replace(/\\/g, "/"))
    .filter((f) => TEXT.test(f) && !f.split("/").includes("node_modules") && !OWN.test(f));
}

export function npxPinProblems(root = ROOT) {
  const pin = pinnedVersion((path) => readFileSync(join(root, path), "utf8"));
  return sourceFiles(root).flatMap((f) => npxAstGrepProblems(f, readFileSync(join(root, f), "utf8"), pin));
}
