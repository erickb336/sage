import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const SKIP = {
  ".git": "git's own files",
  ".claude": "local agent worktrees: other checkouts of this repository",
  node_modules: "installed packages",
  plugins: "the build of packages/: its test files are copies, and npm test runs their sources",
};

const testFiles = (root, dir = "") => readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) => {
  const path = dir ? `${dir}/${entry.name}` : entry.name;
  if (entry.isDirectory()) return Object.hasOwn(SKIP, path) || entry.name === "node_modules" ? [] : testFiles(root, path);
  return entry.name.endsWith(".test.mjs") ? [path] : [];
});

const glob = (word) => new RegExp(`^${word.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", "[^/]*")}$`);

export function unrunTestFiles(root) {
  const { scripts } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const named = `${scripts.test ?? ""} ${scripts["test:browser"] ?? ""}`.split(/\s+/).filter((word) => word.endsWith(".test.mjs")).map(glob);
  return testFiles(root).filter((file) => !named.some((pattern) => pattern.test(file))).sort();
}
