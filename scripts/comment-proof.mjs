import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Lang, parse } from "@ast-grep/napi";
import { transformSync } from "esbuild";
import { Lexer, parseAllDocuments } from "yaml";

function jsTokens(src) {
  const root = parse(Lang.JavaScript, src).root();
  if (root.find({ rule: { kind: "ERROR" } })) throw new Error("tree-sitter cannot parse the file");
  const out = [];
  let end = 0, gap = "", newline = false;
  const walk = (node) => {
    const children = node.children();
    if (children.length && node.kind() !== "comment") return children.forEach(walk);
    const range = node.range(), comment = node.kind() === "comment" || node.kind() === "html_comment";
    gap += src.slice(end, range.start.index);
    newline ||= src.slice(end, comment ? range.end.index : range.start.index).includes("\n");
    end = range.end.index;
    if (comment) return;
    if (gap.trim()) out.push(`gap:${gap.trim()}`);
    out.push(`${out.length && newline ? "NL " : ""}${node.kind()}:${node.text()}`);
    gap = "";
    newline = false;
  };
  walk(root);
  return out;
}

function yamlTokens(src) {
  const out = [];
  let lineStart = true, indent = 0;
  for (const token of new Lexer().lex(src)) {
    if (token.startsWith("#")) continue;
    if (token === "\n" || token === "\r\n") { lineStart = true; indent = 0; continue; }
    if (/^[ \t]+$/.test(token)) { if (lineStart) indent = token.length; continue; }
    out.push(`${out.length && lineStart ? `NL${indent} ` : ""}${JSON.stringify(token)}`);
    lineStart = token.endsWith("\n");
    indent = 0;
  }
  return out;
}

const minified = (src) => transformSync(src, { loader: "js", format: "esm", legalComments: "none", minifyWhitespace: true }).code;

function yamlValue(src) {
  const docs = parseAllDocuments(src);
  const errors = docs.flatMap((doc) => doc.errors);
  if (errors.length) throw new Error(`yaml: ${errors[0].message}`);
  return JSON.stringify(docs.map((doc) => doc.toJS()));
}

export const PROOFS = {
  js: { extensions: [".js", ".mjs", ".cjs", ".jsx"], tokens: jsTokens, canonical: minified },
  yaml: { extensions: [".yml", ".yaml"], tokens: yamlTokens, canonical: yamlValue },
};

export const proofFor = (file) => Object.values(PROOFS).find((proof) => proof.extensions.some((ext) => file.endsWith(ext)));

function same(fn, before, after) {
  let a, b;
  try { a = fn(before); b = fn(after); } catch (e) { return e.message.split("\n")[0]; }
  if (Array.isArray(a)) {
    const i = a.findIndex((token, k) => token !== b[k]);
    if (i >= 0 || a.length !== b.length) return `first difference at token ${i >= 0 ? i : a.length}: ${JSON.stringify(a[i] ?? null)} became ${JSON.stringify(b[i >= 0 ? i : a.length] ?? null)}`;
    return true;
  }
  return a === b || "the outputs differ";
}

export function prove(file, before, after) {
  const proof = proofFor(file);
  if (!proof) return { tokens: "no proof for this language", canonical: "no proof for this language" };
  return { tokens: same(proof.tokens, before, after), canonical: same(proof.canonical, before, after) };
}

const git = (root, args) => {
  const run = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 1 << 28 });
  if (run.status !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr.trim()}`);
  return run.stdout;
};

export function proveChanges(root, base, head) {
  const files = git(root, ["diff", "--name-only", "--diff-filter=M", base, ...(head ? [head] : []), "--"]).split("\n").filter(Boolean);
  return files.map((file) => {
    const before = git(root, ["show", `${base}:${file}`]);
    const after = head ? git(root, ["show", `${head}:${file}`]) : readFileSync(join(root, file), "utf8");
    return { file, ...prove(file, before, after), lines: before.split("\n").length - after.split("\n").length };
  });
}

const USAGE = `usage: node scripts/comment-proof.mjs [base] [head]
Checks that each file that changed from base (default HEAD) to head (default: the working tree) lost only comments.`;

function main(args) {
  const option = args.find((arg) => arg.startsWith("-"));
  if (option === "--help" || option === "-h") return console.log(USAGE);
  if (option || args.length > 2) {
    console.error(`comment-proof: ${option ? `unknown option ${option}` : "give at most two refs"}\n${USAGE}`);
    return process.exitCode = 2;
  }
  const [base = "HEAD", head] = args;
  const root = git(process.cwd(), ["rev-parse", "--show-toplevel"]).trim();
  const results = proveChanges(root, base, head);
  const failed = results.filter((r) => r.tokens !== true || r.canonical !== true);
  for (const r of failed) console.log(`✗ ${r.file}\n  tokens: ${r.tokens}\n  canonical: ${r.canonical}`);
  const pass = (key) => results.filter((r) => r[key] === true).length;
  const removed = results.reduce((n, r) => n + r.lines, 0);
  console.log(`${results.length} changed files from ${base} to ${head ?? "the working tree"}, ${removed} lines fewer: token proof passes for ${pass("tokens")}, canonical proof passes for ${pass("canonical")}, ${failed.length} failed`);
  process.exitCode = failed.length ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (error) {
    console.error(`comment-proof: ${error.message.split("\n")[0]}`);
    process.exitCode = 1;
  }
}
