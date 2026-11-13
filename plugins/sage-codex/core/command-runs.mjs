import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { programsRun } from "./command-reader.mjs";
import { commandWrites, readerDispatch, uniqWrites } from "./shell-write-policy.mjs";
import { outputDispatchWrites } from "./output-writes.mjs";
import { programName } from "./program-name.mjs";
import { ghApiMethod, ghWords, gitSubcommand } from "./command-policy.mjs";

const fold = (text) => text.normalize("NFKC").toLowerCase();

function realRoot(path) {
  try { return realpathSync.native(path); } catch { return dirname(path) === path ? path : join(realRoot(dirname(path)), basename(path)); }
}

const DATA = /^(?:echo|printf|cat|grep|egrep|fgrep|rg|head|tail|wc|jq|ls|diff|cut|stat|file|cd|pushd|popd|true|test|\[|:|tr|uniq|git|gh|node|nodejs|g?sed|g?awk|sort)$/;
const GIT_WRITES = /^(?:clean|checkout|restore|reset|rm|mv|stash|apply|am|merge|rebase|pull|cherry-pick|revert|clone|init|worktree|switch|archive|checkout-index)$/;
function judged(word, args, entry = { run: { word, args } }) {
  const name = word.includes("/") ? "" : programName(word);
  if (!DATA.test(name) || readerDispatch(entry) || outputDispatchWrites(entry)) return true;
  if (name === "git") return GIT_WRITES.test(gitSubcommand(args, 0));
  if (/^(?:node|nodejs)$/.test(name)) return args.some((a) => /^(?:-e|--eval|-p|--print)$|^--(?:eval|print)=/.test(a));
  if (/^g?sed$/.test(name)) return args.some((a) => /^-[a-zA-Z]*i|^--in-place/.test(a));
  if (/^g?awk$/.test(name)) return args.some((a) => a === "inplace" || /^-i/.test(a));
  if (name === "sort") return args.some((a) => /^-[a-zA-Z]*o|^--o/.test(a));
  if (name === "uniq") return uniqWrites([word, ...args], [word, ...args].map(programName));
  return false;
}
const toFile = (operator, target) => !(operator === "<" || operator === "<&" || (operator === ">&" && /^(?:\d+-?|-)$/.test(target))) && !/^\/dev\/(?:null|stdout|stderr)$/.test(target);
const REDIRECT = /^(&>>?|>>|>\||>&|<>|<&|>|<)([^]*)$/;
function wholeWords(name, args) {
  if (/^(?:g?rm|rmdir|unlink|shred)$/.test(name)) return args;
  if (/^g?mv$/.test(name)) return args.slice(0, -1);
  if (name === "rsync") return args.some((a) => /^--(?:del|delete|remove-source-files)/.test(a)) ? args : [];
  return [];
}
const recursiveWords = (name, args) => /^(?:chmod|chown|chgrp|chflags)$/.test(name) && args.some((a) => /^-[a-zA-Z]*R|^--recursive$/.test(a)) ? args : [];

export function logbookWrite(command, cwd, roots, home = process.env.HOME) {
  if (typeof command !== "string") return undefined;
  const writes = commandWrites(command, cwd);
  const forms = [...new Set(roots.filter((r) => typeof r === "string" && isAbsolute(r)).flatMap((r) => [fold(r), fold(realRoot(r))]))];
  const into = (path) => forms.some((r) => path === r || path.startsWith(r.endsWith(sep) ? r : r + sep));
  const holder = (path) => forms.some((r) => r === path || r.startsWith(path.endsWith(sep) ? path : path + sep));
  const holds = (text) => {
    const low = fold(text);
    return forms.some((r) => { for (let at = low.indexOf(r); at >= 0; at = low.indexOf(r, at + 1)) if (!/[\w.-]/.test(low[at + r.length] ?? "")) return true; return false; });
  };
  const path = (word, dir) => {
    const cut = word.search(/[$`*?[{]/);
    if (cut === 0 && /^[$`]/.test(word)) return undefined;
    let lit = cut < 0 ? word : word.slice(0, cut) || ".";
    if (/^~(?=\/|$)/.test(lit)) { if (!home) return undefined; lit = home + lit.slice(1); }
    if (lit.startsWith("-") || lit.length > 4096 || lit.includes("\0")) return undefined;
    if (!isAbsolute(lit)) { if (!dir) return undefined; lit = `${dir}/${lit}`; }
    return fold(resolve(lit));
  };
  const named = (word, dir) => {
    const value = /^(?:--?[\w-]+|\w+)=(.+)$/s.exec(word)?.[1];
    return [word, ...(value ? [value] : [])].some((v) => holds(v) || into(path(v, dir) ?? "\0"));
  };
  const above = (word, dir) => {
    const cut = word.search(/[$`*?[{]/);
    if (cut === 0 && /^[$`]/.test(word)) return false;
    const p = path(cut < 0 ? word : word.slice(0, word.lastIndexOf("/", cut) + 1) || ".", dir);
    return p !== undefined && holder(p);
  };
  const whole = (word, args, dir) => wholeWords(programName(word), args).find((w) => above(w, dir) || named(w, dir))
    ?? recursiveWords(programName(word), args).find((w) => named(w, dir));
  let evidence;
  try {
    evidence = programsRun(command, cwd, undefined, { contextEvidence: true, redirectParts: true, home });
  } catch {
    return undefined;
  }
  const clobber = evidence.redirects.some(({ operator, target }) => /^&?>>?$/.test(operator) && target.startsWith("!"));
  for (const entry of evidence.programs) {
    const { run, uncertainDirectory } = entry;
    const dir = uncertainDirectory ? undefined : run.dir ?? cwd;
    const top = entry.wrapper ? undefined : whole(run.word, run.args, dir);
    if (top !== undefined) return top;
    if (!writes || (!clobber && !judged(run.word, run.args, entry))) continue;
    const word = [run.word, ...run.args].find((w) => named(w, dir));
    if (word !== undefined) return word;
  }
  if (!writes) return undefined;
  for (const { operator, target, dir, uncertainDirectory } of evidence.redirects) {
    if (toFile(operator, target) && named(target, uncertainDirectory ? undefined : dir ?? cwd)) return target;
  }
  return undefined;
}
const NODE_VALUE = /^(?:-e|--eval|-p|--print|-r|--require|--import|--loader|--experimental-loader|-C|--conditions|--input-type|--title)$/;
const TOOL_FILE = /(?:^|[/\\])sage\.mjs$/i;
export function stateToolRun(command, cwd) {
  const { programs } = programsRun(command, cwd, undefined, { contextEvidence: true });
  const found = [];
  for (const { run, wrapper, uncertainDirectory } of programs) {
    if (wrapper) continue;
    let script = run.word, args = run.args;
    if (/^(?:node|nodejs)$/.test(programName(run.word))) {
      let k = 0;
      for (; k < run.args.length && /^-./.test(run.args[k]) && run.args[k] !== "--"; k++) if (NODE_VALUE.test(run.args[k])) k++;
      if (run.args[k] === "--") k++;
      let j = k;
      while (j < run.args.length && !TOOL_FILE.test(run.args[j]) && /^--?[^=]+$/.test(run.args[j - 1] ?? "") && !run.args[j].startsWith("-")) j++;
      if (TOOL_FILE.test(run.args[j] ?? "")) k = j;
      [script, ...args] = run.args.slice(k);
    }
    if (TOOL_FILE.test(script ?? "")) found.push({ script, args, dir: uncertainDirectory ? undefined : run.dir });
  }
  return found;
}

export function ghRuns(command, cwd, path) {
  const { programs } = programsRun(command, cwd, path, { contextEvidence: true });
  return programs.filter(({ run, wrapper }) => !wrapper && programName(run.word) === "gh").map(({ run }) => {
    const [group, sub] = ghWords(run.args);
    return { group, sub, method: group === "api" ? ghApiMethod(run.args) : undefined, args: run.args };
  });
}
export const AGENT_GH = Object.freeze({
  pr: Object.freeze(["create", "view", "comment", "edit", "checks", "diff", "list", "status"]),
  issue: Object.freeze(["view", "list"]),
  run: Object.freeze(["view", "list", "watch"]),
  repo: Object.freeze(["view"]),
});
export const agentGh = ({ group, sub, method }) => (group === "api" ? method === "GET" : Object.hasOwn(AGENT_GH, group ?? "") && AGENT_GH[group].includes(sub));
