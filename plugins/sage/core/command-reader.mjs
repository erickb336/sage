import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { programName } from "./program-name.mjs";

/**
 * Programs that run a later word as a program, each with its options that take a value (that value is not the program).
 * A key of two words is a program and its subcommand.
 */
const PACKAGE_RUNNER = /^-(?:p|c|-package|-call)$/;
const WRAPPER = new Map([
  ["sudo", /^-(?:[acugpCDrtUTRh]|-(?:auth-type|login-class|user|group|prompt|close-from|chdir|chroot|role|type|other-user|command-timeout|host))$/],
  ["doas", /^-[uC]$/],
  ["env", /^-(?:[aCPSu]|-(?:argv0|chdir|split-string|unset))$/],
  ["nice", /^-(?:n|-adjustment)$/],
  ["timeout", /^-(?:[sk]|-(?:signal|kill-after))$/],
  ["gtimeout", /^-(?:[sk]|-(?:signal|kill-after))$/],
  ["xargs", /^-(?:[IJLnPsEdaRS]|-(?:replace|max-lines|max-args|max-procs|max-chars|eof|delimiter|arg-file))$/],
  ["exec", /^-a$/],
  ["stdbuf", /^-(?:[ioe]|-(?:input|output|error))$/],
  ["caffeinate", /^-[tw]$/],
  ["watch", /^-(?:[nqs]|-(?:interval|equexit|shotsdir))$/],
  ["npm", undefined],
  ...["npx", "bunx", "npm exec", "npm x", "pnpm dlx"].map((name) => [name, PACKAGE_RUNNER]),
  ...["nohup", "command", "builtin", "time", "noglob", "nocorrect"].map((name) => [name, undefined]),
]);
// Include flag-only names too, so an abbreviated long option must be unique across the wrapper's options.
const WRAPPER_LONG_OPTIONS = new Map([
  ["sudo", "background preserve-env edit set-home login remove-timestamp list preserve-groups shell other-user validate askpass auth-type bell close-from login-class chdir group help host reset-timestamp no-update non-interactive prompt chroot role stdin command-timeout type user version"],
  ["env", "argv0 ignore-environment null unset chdir default-signal ignore-signal block-signal list-signal-handling debug split-string help version"],
  ["nice", "adjustment help version"],
  ...["timeout", "gtimeout"].map(name => [name, "signal kill-after foreground preserve-status verbose help version"]),
  ["xargs", "replace max-lines max-args max-procs max-chars eof delimiter arg-file null interactive no-run-if-empty verbose exit show-limits open-tty help version"],
  ["stdbuf", "input output error help version"],
  ["watch", "beep color no-color differences help interval errexit follow chgexit equexit exec precise no-rerun shotsdir no-title no-wrap version"],
  ...["npx", "bunx", "npm exec", "pnpm dlx"].map(name => [name, "package call yes no quiet bun help version"]),
  ["nohup", "help version"],
].map(([name, options]) => [name, options.split(" ")]));

function longOptionName(option, names = []) {
  const prefix = option.slice(2).split("=")[0];
  if (names.includes(prefix)) return prefix;
  const matches = names.filter(name => name.startsWith(prefix));
  if (matches.length !== 1) throw new Error(`unknown or ambiguous wrapper option ${option}`);
  return matches[0];
}

/** Shell keywords before a command: the command after them runs in the same shell. After for, select or case come words, not a program. */
const KEYWORD = /^(?:!|\{|\}|if|then|elif|else|fi|while|until|do|done|esac|coproc)$/;
const LIST = /^(?:for|select|case)$/;
const SHELLS = /^(?:sh|bash|zsh|dash|ksh|fish)$/;

/**
 * The programs that a command line runs, for the hook's rules on agents (agentProblem) and on the state tool (T83).
 * Each is { word, file, args, dir, path, stdin, piped }, in the order of the command line:
 *   - word: the program as written, after shell keywords (if, while, do, !, {), assignments (X=1), redirections
 *     (2>/dev/null, >out) and wrappers with their options (sudo, env, timeout, xargs, nice, watch, npx, npm exec,
 *     pnpm dlx, bunx and others in WRAPPER). After for, select and case come words, not a program; a case pattern is not one.
 *   - file: the real file that runs, found through PATH (a PATH=… before it, or an earlier export PATH=…) and links,
 *     from dir. Undefined for a bare kill (the shell's builtin, unless a wrapper such as sudo or xargs runs it), for a
 *     word with a variable, ~ or a substitution, and for a program that is not found.
 *   - args: the words after the program, without their quotes and redirections.
 *   - dir: the folder it runs in, after an earlier literal "cd <dir>", "pushd <dir>" or "popd" of the same line (~ is
 *     home, which defaults to HOME). After a cd that the reader cannot follow (cd $X, cd -), the folder is uncertain.
 *   - path: its effective PATH, after assignments and wrappers.
 *   - stdin: its heredoc and here-string bodies, and the words of the command piped into it.
 *   - piped: whether another command supplies its stdin through a pipe; a heredoc alone is not a pipe.
 * It also reads the text that other programs run as commands, up to 3 levels deep: the -c text of a shell (sh, bash,
 * zsh, dash, ksh, fish) and its stdin heredoc when it has no script, the words of eval, PowerShell's -Command text,
 * npx --call, and the program of find -exec. The words after a script (bash ./x.sh kill) are the script's arguments,
 * not programs. Each $( ) or backtick is a command of its own, and so is each <( ) and >( ). It cannot see a program in a
 * variable ($P), in a shell function's call, in watch's or env -S's text, in text piped into a shell, or inside a script.
 * With executableEvidence, also retain external wrappers. With redirectEvidence, return { redirect, dir } and optional
 * uncertainDirectory for each shell redirection. With redirectParts, each redirection also includes its separate
 * operator and target. With contextEvidence, return programs with their wrapper and directory certainty, plus those redirects.
 * Throws when the shell reader cannot read the line (see shellCommands), and for text nested more than 3 levels deep.
 */
export function programsRun(command, cwd, path = process.env.PATH ?? "", { executableEvidence = false, redirectEvidence = false, contextEvidence = false, uncertainDirectory = false, redirectParts = false, home = process.env.HOME } = {}) {
  const found = { redirects: [], contexts: [], redirectParts, home };
  readPrograms(command, cwd, path, 0, found, uncertainDirectory);
  if (contextEvidence) return { programs: found.contexts, redirects: found.redirects };
  return redirectEvidence ? found.redirects : found.contexts.filter(entry => executableEvidence || !entry.wrapper).map(entry => entry.run);
}

// npm-exec documents these command, workspace, cache and install options. Values have different roles:
// call runs shell text; a package or workspace value is data; Boolean options do not take a command word.
const NPM_OPTIONS = new Map([
  ..."package workspace cache registry loglevel allow-scripts ca".split(" ").map(name => [name, "value"]),
  ...("yes no no-install quiet silent verbose help version parseable offline prefer-offline prefer-online " +
    "workspaces include-workspace-root ignore-scripts strict-allow-scripts dangerously-allow-all-scripts audit fund all long").split(" ").map(name => [name, "flag"]),
  ["call", "call"],
  // nopt treats unregistered --check as Boolean unless it has =value. npx does not register it as a switch.
  ["check", "unregistered"],
]);
const NPM_ALIASES = { c: "call", w: "workspace", ws: "workspaces", y: "yes", q: "quiet", a: "all", l: "long" };
const NPM_WRAPPERS = new Set(["npx", "npm", "npm exec", "npm x"]);

const NPM_LOGLEVEL_ALIASES = { quiet: "warn", q: "warn", silent: "silent", verbose: "verbose" };

// npx inserts -- before its first original positional argument, before nopt splits option=value.
function npxBoundary(words, start) {
  for (let i = start; i < words.length; i++) {
    const option = words[i];
    if (option === "--") break;
    if (!option.startsWith("-")) { words.splice(i, 0, "--"); break; }
    const split = option.indexOf("=");
    const raw = option.replace(/^-+/, "").split("=")[0];
    const value = split < 0 ? undefined : option.slice(split + 1);
    if (raw === "p") words[i] = `--package${value === undefined ? "" : `=${value}`}`;
    else if (raw === "no-install") words[i] = "--yes=false";
    else {
      const loglevel = NPM_LOGLEVEL_ALIASES[raw];
      const alias = NPM_ALIASES[raw] ?? (raw === "no" ? "no-yes" : undefined);
      if (loglevel || alias) {
        words.splice(i, 1, ...(loglevel ? ["--loglevel", loglevel] : [`--${alias}`]), ...(value === undefined ? [] : [value]));
        i--;
        continue;
      }
    }
    const kind = NPM_OPTIONS.get(raw === "p" ? "package" : raw);
    if (value === undefined && kind !== "flag" &&
        (kind === "value" || kind === "call" || !words[i + 1]?.startsWith("-"))) i++;
  }
}

function npmArguments(words, start, wrapper) {
  if (wrapper === "npx") npxBoundary(words, start);
  const operands = [];
  let next = start, call, operation = wrapper !== "npm";
  while (next < words.length) {
    let option = words[next++];
    if (/^-{2,}$/.test(option)) {
      if (!operation && !/^(?:exec|x)$/.test(words[next++] ?? "")) return { ordinary: true };
      operation = true;
      operands.push(...words.slice(next));
      break;
    }
    if (!/^-./.test(option)) {
      if (!operation) {
        if (!/^(?:exec|x)$/.test(option)) return { ordinary: true };
        operation = true;
        continue;
      }
      operands.push(option);
      continue; // npm reads options anywhere before --; npxBoundary has already placed its delimiter.
    }
    const split = option.indexOf("=");
    if (split >= 0) {
      words.splice(next, 0, option.slice(split + 1));
      option = option.slice(0, split);
    }
    const raw = option.slice(option.startsWith("--") ? 2 : 1);
    let name = raw === "p" ? "parseable" : NPM_ALIASES[raw] ?? raw;
    const negated = name.startsWith("no-") && NPM_OPTIONS.get(name.slice(3)) === "flag";
    if (negated) name = name.slice(3);
    if (!NPM_OPTIONS.has(name)) {
      // nopt recognizes exact names, then shorthand clusters, with either one or two dashes.
      // Do not guess an abbreviation from this bounded option table: npm may have another matching option.
      const cluster = [...raw].map(char => char === "p" ? "parseable" : NPM_ALIASES[char]);
      if (cluster.some(flag => !flag)) throw new Error(`unknown package runner option ${option}`);
      words.splice(next, 0, ...cluster.map(flag => `--${flag}`));
      continue;
    }
    const registeredKind = NPM_OPTIONS.get(name);
    const kind = registeredKind === "unregistered" ? (split < 0 ? "flag" : "value") : registeredKind;
    if (/^-{2,}$/.test(words[next] ?? "")) {
      // nopt keeps the sentinel in argv; a missing call value becomes the string "true".
      if (kind === "call") call = "true";
      continue;
    }
    if (kind === "flag") {
      // Only accepted Boolean values belong to the option. Other tokens retain their argv role.
      const booleanValue = /^(?:true|false)$/.test(words[next] ?? "") ||
        (words[next] === "null" && /^(?:yes|no|workspaces)$/.test(name));
      if ((negated || !NPM_LOGLEVEL_ALIASES[name]) && booleanValue) next++;
      continue;
    }
    let value;
    if (kind === "call" && (words[next] === undefined || /^-./.test(words[next]))) value = "";
    else {
      if (registeredKind !== "unregistered" && /^-./.test(words[next] ?? "")) throw new Error("package runner option has no value");
      value = words[next++];
    }
    if (value === undefined) throw new Error("package runner option has no value");
    if (kind === "call") call = value.trim();
  }
  if (!operation) return { ordinary: true };
  words.splice(start, words.length - start, ...operands);
  return { next: start, call };
}

function wrapperOptionKind(wrapper, flag) {
  if (wrapper === "sudo" && flag === "-h") return "host-or-help";
  if (wrapper === "xargs" && /^-(?:[ile]|-(?:replace|max-lines|eof))$/.test(flag)) return "optional-attached";
  return WRAPPER.get(wrapper)?.test(flag) ? "value" : "flag";
}

const pathAssignment = (word, path) => word.slice(5).replace(/\$\{?PATH\}?(?!\w)/g, path);

function wrapperArguments(words, next, wrapper, path, dir) {
  if (NPM_WRAPPERS.has(wrapper)) return { ...npmArguments(words, next, wrapper), path, dir };
  let chdir;
  while (next < words.length) {
    const word = words[next];
    // sudo resumes option parsing after an assignment. env consumes assignments only after its options.
    if (wrapper === "sudo" && !word.startsWith("-") && word[0] !== "/" && word[0] !== "=" && word.includes("=")) {
      if (/^PATH=/.test(word)) path = pathAssignment(word, path);
      next++;
      continue;
    }
    if (!/^-./.test(word)) break;
    const option = words[next++];
    if (option === "--") break;
    let flag = option.split("=")[0], value;
    if (option.startsWith("--")) {
      flag = `--${longOptionName(option, WRAPPER_LONG_OPTIONS.get(wrapper))}`;
      if (option.includes("=")) value = option.slice(option.indexOf("=") + 1);
    } else {
      const index = [...option].findIndex((char, i) => i > 0 && wrapperOptionKind(wrapper, `-${char}`) !== "flag");
      if (wrapper === "sudo" && !/^[AaBbCcDEegHhiKklNnPpRrSsTtUuVv]+$/.test(option.slice(1, index < 0 ? undefined : index + 1))) {
        throw new Error(`unknown sudo option ${option}`);
      }
      if (index >= 0) {
        flag = `-${option[index]}`;
        value = option.slice(index + 1) || undefined;
      }
    }
    const kind = wrapperOptionKind(wrapper, flag);
    if (kind === "value") {
      value ??= words[next++];
      if (value === undefined) throw new Error(`${wrapper} option has no value`);
    } else if (kind === "host-or-help" && value === undefined && option === "-h") {
      // sudo -h alone is help; exact -h followed by a non-option, non-assignment is a host.
      const following = words[next];
      if (following !== undefined && !following.startsWith("-") &&
          !(following[0] !== "/" && following[0] !== "=" && following.includes("="))) value = words[next++];
    } // optional-attached values never consume the next command word.
    if (/^(?:sudo|env)$/.test(wrapper) && (flag === "--chdir" || flag === (wrapper === "sudo" ? "-D" : "-C"))) chdir = value;
    if (wrapper === "env" && flag === "-P") path = value;
  }
  if (wrapper === "timeout" || wrapper === "gtimeout") next++; // only timeout owns a duration operand
  if (wrapper === "env" && words[next] === "-") next++;
  if (wrapper === "env") {
    while (words[next]?.includes("=")) {
      const word = words[next++];
      if (/^PATH=/.test(word)) path = pathAssignment(word, path);
    }
  }
  return { next, path, dir: chdir === undefined ? dir : resolve(dir, chdir), absoluteDir: chdir?.startsWith("/") };
}

function readPrograms(command, dir, path, depth, found, uncertainDirectory = false) {
  const emit = (run, wrapper = false, uncertain = false) => found.contexts.push({ run, wrapper, uncertainDirectory: uncertain });
  const inner = (text, at, here, uncertain) => {
    if (depth === 3) throw new Error("commands nested more than 3 levels deep");
    readPrograms(text, at, here, depth + 1, found, uncertain);
  };
  const commands = shellCommands(command);
  const execute = (c, state, scope) => {
    const { dir, stack } = state;
    let { path, uncertainDirectory: uncertain } = state;
    for (const child of COMMAND_CONTEXT.get(c).children) walkFlow(child, [state], execute);
    if (!COMMAND_CONTEXT.get(c).groupOwned) execute.redirects(c.redirects, [state]);
    if (COMMAND_CONTEXT.get(c).functionHeader) return { states: [state] };
    const { bodies, syntax } = c;
    const words = [...c.words];
    let launched = false;
    let here = path;
    let at = dir; // a wrapper chdir belongs to this command, not the following shell command
    let viaExec = false;
    let argv = false; // argv disables assignment/keyword grammar, not same-shell builtin lookup
    let nextDir = dir, nextStack = stack, status, negate = false, nextUncertain = uncertain;
    for (let k = 0; k < words.length; k++) {
      const w = words[k];
      const name = programName(w);
      const assignment = !argv && syntax[k]?.assignment;
      const keyword = !argv && !syntax[k]?.quoted;
      if (assignment && /^PATH=/.test(w)) here = pathAssignment(w, here);
      if (keyword && w === "!") negate = !negate;
      if (assignment || (keyword && KEYWORD.test(w))) continue;
      if (keyword && LIST.test(w)) break;
      if (keyword && w === "function" && ++k) continue; // the function name is not a program
      launched = true;
      const file = program(w, at, here, uncertain);
      // command/builtin consume argv but still dispatch through this shell. Native wrappers do not.
      const builtinWrapper = !viaExec && /^(?:command|builtin|exec)$/.test(w);
      const shellModifier = !viaExec && keyword && /^(?:time|noglob|nocorrect)$/.test(w);
      const shellWrapper = builtinWrapper || shellModifier;
      const wrapperNames = shellWrapper ? [name] : [file && programName(file), name].filter(Boolean);
      let wrapper = wrapperNames.flatMap(base => [`${base} ${words[k + 1]}`, base]).find(key =>
        WRAPPER.has(key) && (shellWrapper || !/^(?:command|builtin|exec|noglob|nocorrect)$/.test(key)) && (key !== "npm" || words.slice(k + 1).some(word => /(?:^|=)(?:exec|x)$/.test(word))));
      const originalArgs = words.slice(k + 1);
      const npmWords = wrapper === "npm" ? [...words] : undefined;
      const npm = npmWords && wrapperArguments(npmWords, k + 1, wrapper, here, at);
      if (npm?.ordinary) wrapper = undefined;
      else if (npm) words.splice(0, words.length, ...npmWords);
      if (wrapper) {
        if (!shellWrapper) emit({ word: w, file, args: originalArgs, dir: at, path: here, stdin: [], piped: false }, true, uncertain);
        if (wrapper.includes(" ")) k++;
        if (shellModifier) {
          if (name === "time" && words[k + 1] === "-p") k++;
          if (name === "time" && words[k + 1] === "--") k++;
          continue;
        }
        viaExec ||= !shellWrapper || w === "exec";
        argv = true;
        const wrapped = npm ?? wrapperArguments(words, k + 1, wrapper, here, at);
        // command -v and -V only look a name up: they run nothing (F-T815-17). command <program> runs it.
        if (wrapper === "command" && words.slice(k + 1, wrapped.next).some((o) => /^-[pvV]*[vV]/.test(o))) break;
        k = wrapped.next - 1;
        here = wrapped.path;
        if (wrapped.dir !== at && wrapped.absoluteDir) uncertain = false;
        at = wrapped.dir;
        if (wrapped.call) {
          inner(wrapped.call, at, here, uncertain);
          break;
        }
        continue;
      }
      const args = words.slice(k + 1);
      if (!viaExec && /^(?:cd|pushd|popd)$/.test(w)) {
        const to = args.map((word, i) => tilde(word, syntax[k + 1 + i]?.quoted, found.home));
        const change = w === "cd" ? cdDirectory(to, dir, found.home, uncertain) : stackDirectory(w, to, dir, stack, found.home, uncertain);
        nextDir = change.dir; status = change.ok; nextStack = change.stack ?? stack;
        scope.directoryEffect = true;
        nextUncertain = scope.opaque || change.uncertain;
      } else if (!viaExec && w === "export") {
        for (const word of args) if (word.startsWith("PATH=")) path = pathAssignment(word, path);
      }
      const pipes = commands.filter((p) => p.pipeTo === c);
      const stdin = [...bodies, ...pipes.map((p) => p.words.join(" "))];
      emit({ word: w, file: w === "kill" && !viaExec ? undefined : file, args, dir: at, path: here, stdin, piped: pipes.length > 0 }, false, uncertain);
      const texts = name === "eval" && (viaExec || w !== "eval") ? [] : commandText(name, args, bodies);
      for (const text of texts) inner(text, at, here, uncertain);
      const exec = [name, file && programName(file)].includes("find") ? args.findIndex((a) => /^-(?:exec|execdir|ok|okdir)$/.test(a)) : -1;
      if (exec >= 0 && args[exec + 1]) {
        const end = args.findIndex((a, j) => j > exec && /^[;+]$/.test(a));
        emit({ word: args[exec + 1], file: program(args[exec + 1], at, here, uncertain), args: args.slice(exec + 2, end < 0 ? undefined : end), dir: at, path: here, stdin: [], piped: false }, false, uncertain);
      }
      break;
    }
    if (!launched) path = here;
    return { states: [{ dir: nextDir, stack: nextStack, path, uncertainDirectory: nextUncertain }], status: negate && status !== undefined ? !status : status };
  };
  execute.redirects = (redirects, states) => {
    for (const state of states) for (let index = 0; index < redirects.length; index++) {
      const parts = found.redirectParts ? REDIRECT_PARTS.get(redirects)[index] : {};
      found.redirects.push({ redirect: redirects[index], ...parts, dir: state.dir,
        ...(state.uncertainDirectory ? { uncertainDirectory: true } : {}) });
    }
  };
  return walkFlow(FLOWS.get(commands), [{ dir, stack: null, path, uncertainDirectory }], execute);
}

/**
 * Directory changes belong to their execution scope; a branch keeps both possible outcomes. A subshell keeps none. After
 * an if, a loop, a case or a function body (opaque) that changes the folder, the folder is uncertain.
 */
function walkFlow(flow, initial, execute, opaque = false) {
  const opaqueKind = flow.kind === "opaque" || flow.kind === "function";
  const scope = { opaque: opaque || opaqueKind, directoryEffect: false };
  execute.redirects(flow.redirects ?? [], initial);
  const unique = states => {
    const result = [...new Map(states.map(state => [JSON.stringify(state), state])).values()];
    if (result.length > 64) throw new Error("too many possible command directories");
    return result;
  };
  const nodeResult = (node, states) => {
    if (node.cmd) {
      const results = states.flatMap(state => {
        const result = execute(node.cmd, state, scope);
        return result.states.map(state => ({ state, status: result.status }));
      });
      return { yes: unique(results.filter(r => r.status !== false).map(r => r.state)), no: unique(results.filter(r => r.status !== true).map(r => r.state)) };
    }
    const result = walkFlow(node, states, execute, scope.opaque);
    if (node.kind === "subshell") return { yes: states, no: states };
    scope.directoryEffect ||= node.directoryEffect;
    return { yes: result, no: result };
  };
  let states = initial;
  for (let k = 0; k < flow.nodes.length;) {
    const before = states;
    let result, connector;
    do {
      const input = !result ? states : connector === "&&" ? result.yes : result.no;
      const saved = result;
      const start = k;
      let pipe;
      do {
        if (!input.length) nodeResult(flow.nodes[k], before); // skipped text still receives policy checks, without changing its caller
        pipe = nodeResult(flow.nodes[k], input);
      } while (flow.nodes[k++].after === "|" && k < flow.nodes.length);
      if (k - start > 1) {
        // Bash isolates each stage; shells that run the last stage in the parent may retain its directory.
        const possible = unique([...input, ...pipe.yes, ...pipe.no]);
        pipe = { yes: possible, no: possible };
      }
      result = !saved ? pipe : connector === "&&"
        ? { yes: pipe.yes, no: unique([...saved.no, ...pipe.no]) }
        : { yes: unique([...saved.yes, ...pipe.yes]), no: pipe.no };
      connector = flow.nodes[k - 1].after;
    } while ((connector === "&&" || connector === "||") && k < flow.nodes.length);
    states = connector === "&" ? before : unique([...result.yes, ...result.no]);
  }
  if (opaqueKind && scope.directoryEffect) states = unique([...initial, ...states].map(state => ({ ...state, uncertainDirectory: true })));
  flow.directoryEffect = scope.directoryEffect;
  return states;
}

/** A word that starts with an unquoted ~ or ~/, with the home folder in its place when that is a known absolute path. */
const tilde = (word, quoted, home) => !quoted && /^~(?:\/|$)/.test(word) && typeof home === "string" && home.startsWith("/") ? home + word.slice(1) : word;

/** The folder after cd: a literal folder from dir, or home with no word. Any other form leaves the folder uncertain. */
function cdDirectory(args, dir, home, uncertain) {
  const unknown = { dir, ok: undefined, uncertain: true };
  let physical = false, k = 0;
  for (; /^-./.test(args[k] ?? "") && args[k] !== "--"; k++) {
    if (!/^-[LPe]+$/.test(args[k])) return unknown;
    for (const option of args[k].slice(1)) if (option !== "e") physical = option === "P";
  }
  if (args[k] === "--") k++;
  const target = args[k] ?? home;
  if (!target || args.length > k + 1 || /[$`~]/.test(target) || target === "-") return unknown;
  if (uncertain && !target.startsWith("/")) return unknown;
  try {
    const next = physical ? realpathSync.native(target.startsWith("/") ? target : `${dir}/${target}`) : resolve(dir, target);
    if (statSync(next).isDirectory()) {
      accessSync(next, constants.X_OK);
      return { dir: next, ok: true, uncertain: false };
    }
  } catch (error) {
    if (!["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes(error.code)) return unknown;
  }
  return { dir, ok: false, uncertain };
}

/**
 * pushd <dir> changes the folder as cd does and keeps the old folder on the line's stack; popd goes back to it
 * (F-T815-16). Any other form (pushd alone, +N, -N, popd with a word or past the line's own pushd) leaves the folder unknown.
 */
function stackDirectory(name, args, dir, stack, home, uncertain) {
  const kept = stack ?? [], unknown = { dir, ok: undefined, uncertain: true, stack: [] };
  if (name === "popd") {
    const top = kept.at(-1);
    return args.length || !top ? unknown : { dir: top.dir, ok: true, uncertain: top.uncertain, stack: kept.slice(0, -1) };
  }
  if (args.length !== 1 || /^[+-]/.test(args[0])) return unknown;
  const change = cdDirectory(args, dir, home, uncertain);
  return { ...change, stack: change.ok === false ? kept : [...kept, { dir, uncertain: uncertain || change.ok === undefined }] };
}

/** The text that a shell, eval or PowerShell runs as commands: -c text, eval's words, or stdin when there is no script. */
export function commandText(name, args, bodies) {
  if (name === "eval") return [args.join(" ")];
  if (/^(?:pwsh|powershell)(?:\.exe)?$/i.test(name)) {
    const c = args.findIndex((a) => /^-c(?:o(?:m(?:m(?:a(?:n(?:d)?)?)?)?)?)?$/i.test(a));
    return c >= 0 ? [args.slice(c + 1).join(" ")] : [];
  }
  if (!SHELLS.test(name)) return [];
  let k = 0;
  let text = false;
  let stdin = false;
  for (; /^[-+]./.test(args[k] ?? "") && args[k] !== "--"; k++) {
    if (/^-[a-zA-Z]*c/.test(args[k]) || args[k] === "--command") text = true;
    if (/^-[a-zA-Z]*s/.test(args[k])) stdin = true;
    if (/^[-+][a-zA-Z]*[oO]$|^--(?:rcfile|init-file)$/.test(args[k])) k++; // an option with a value: -o pipefail
  }
  if (args[k] === "--") k++;
  if (text) return args[k] === undefined ? [] : [args[k]]; // the words after it are $0, $1, …
  return stdin || args[k] === undefined ? bodies : []; // with a script, the words and stdin are the script's
}

/** The real file that a program word runs, through PATH and links; undefined when it has a variable or is not found. */
function program(word, dir, path, uncertain = false) {
  for (const file of word.includes("/") ? [word] : path.split(":").map((d) => `${d || "."}/${word}`)) {
    if (uncertain && !file.startsWith("/")) return undefined;
    if (/[$`~]/.test(file)) return undefined; // the shell would expand it, so the hook cannot tell which file runs
    try {
      const real = realpathSync.native(resolve(dir, file)); // native: the name on disk, so "PS" on macOS is ps
      if (statSync(real).isFile() && statSync(real).mode & 0o111) return real;
    } catch {}
  }
  return undefined;
}

/**
 * The simple commands of a shell command line: { words, bodies, host, piped, pipeTo, grouped, writes }. The words lose their
 * quotes and redirections (2>/dev/null, >out, <in, with their targets); syntax retains quote and assignment eligibility; the bodies are the command's heredocs and
 * here-strings, which stay text. The patterns of a case arm ("top)") are not commands. A command substitution, $( ) or a backtick, gives
 * commands of its own, whose host is the command and word they land in (index -1: a heredoc; quoted: true inside double
 * quotes, where the shell does not split the result), and so does a process substitution, <( ) or >( ). Throws when it cannot read the line: an open quote, substitution, heredoc, "(" or case,
 * or a ")" with no "(". The hook's rules then refuse a line that names what they guard (fail closed).
 * With provenance, wordLiterals, bodyLiterals and redirectLiterals identify data without shell expansion; redirectParts separates each
 * operator from its target. A quoted heredoc is literal even when its body contains shell syntax.
 */
const FLOWS = new WeakMap();
const COMMAND_CONTEXT = new WeakMap();
const REDIRECT_PARTS = new WeakMap();

export function shellCommands(src, { provenance = false } = {}) {
  const out = [], flow = { nodes: [] };
  FLOWS.set(out, flow);
  readCommands(src, 0, "", out, undefined, flow);
  if (provenance) for (const command of out) {
    const context = COMMAND_CONTEXT.get(command);
    command.wordLiterals = context.wordLiterals;
    command.bodyLiterals = context.bodyLiterals;
    command.redirectLiterals = context.redirectLiterals;
    command.redirectParts = REDIRECT_PARTS.get(command.redirects);
  }
  return out;
}

function readCommands(src, i, close, out, host, flow) {
  if (!flow) {
    flow = { nodes: [] };
    COMMAND_CONTEXT.get(host.cmd).children.push(flow);
  }
  const scopes = [];
  const openScope = kind => {
    const child = { nodes: [], kind };
    flow.nodes.push(child); scopes.push(flow); flow = child;
  };
  const fresh = () => {
    const command = { words: [], syntax: [], bodies: [], host, piped: false, grouped: false, writes: false, redirects: [], heredoc: false };
    COMMAND_CONTEXT.set(command, { children: [], wordLiterals: [], bodyLiterals: [], redirectLiterals: [] });
    REDIRECT_PARTS.set(command.redirects, []);
    return command;
  };
  let cmd = fresh();
  let word;
  let quoted = false, assignment = false, literal = true;
  let depth = 0;
  let target; // after a redirection: its operator, kept with its target in redirects, or "body" for the text of a here-string
  const cases = []; // each open case: { depth } where it opens, and pattern: true before an arm's ")", false after it
  const arm = () => (cases.at(-1)?.depth === depth ? cases.at(-1) : undefined); // the case whose arms are read at this depth
  const heredocs = [];
  const add = (text) => (word = (word ?? "") + text);
  const endWord = () => {
    if (word === undefined) return;
    if (target === "body") {
      cmd.bodies.push(word);
      COMMAND_CONTEXT.get(cmd).bodyLiterals.push(literal);
    }
    else if (target) {
      cmd.redirects.push(target + word);
      REDIRECT_PARTS.get(cmd.redirects).push({ operator: target, target: word });
      COMMAND_CONTEXT.get(cmd).redirectLiterals.push(literal);
    }
    else {
      if (!quoted && !cmd.words.length && /^(?:if|for|while|until|select|case)$/.test(word)) openScope("opaque");
      if (!quoted && !cmd.words.length && /^(?:fi|done|esac)$/.test(word) && flow.kind === "opaque") COMMAND_CONTEXT.get(cmd).closesScope = true;
      if (!quoted && word === "{" && (!cmd.words.length || cmd.words[0] === "function")) {
        const functionName = flow.pendingFunction ?? (cmd.words[0] === "function" ? cmd.words[1] : undefined);
        delete flow.pendingFunction;
        openScope(functionName ? "function" : "brace");
      }
      if (!quoted && !cmd.words.length && word === "}" && /^(?:brace|function)$/.test(flow.kind)) COMMAND_CONTEXT.get(cmd).closesScope = true;
      cmd.words.push(word); cmd.syntax.push({ quoted, assignment });
      COMMAND_CONTEXT.get(cmd).wordLiterals.push(literal);
    }
    word = target = undefined;
    quoted = assignment = false;
    literal = true;
    const [first, , third] = cmd.words;
    if (first === "case" && !cmd.syntax[0].quoted && cmd.words.length === 3 && third === "in" && !cmd.syntax[2].quoted) {
      endCommand();
      cases.push({ depth, pattern: true });
    } else if (first === "esac" && !cmd.syntax[0].quoted && cmd.words.length === 1 && arm()) cases.pop();
  };
  const endCommand = () => {
    endWord();
    if (target) throw new Error("a redirection with no target");
    cmd.grouped ||= depth > 0;
    if ((cmd.words.length || cmd.heredoc || cmd.redirects.length) && !arm()?.pattern) {
      out.push(cmd); flow.nodes.push({ cmd }); // retain the public flat view and the private execution scope
    }
    if (COMMAND_CONTEXT.get(cmd).closesScope) {
      COMMAND_CONTEXT.get(cmd).groupOwned = true;
      flow.redirects = cmd.redirects;
      flow = scopes.pop();
    }
    cmd = fresh();
  };
  const here = () => ({ cmd, index: cmd.words.length });
  while (i < src.length) {
    const c = src[i];
    const esac = word === "esac" && !quoted && !cmd.words.length; // "esac)" closes a $( ), and "esac |" pipes the case on
    if (arm()?.pattern && "()|".includes(c) && !esac) { // a case arm: "(a|b)" or "a)"; its pattern runs nothing
      endWord();
      if (cmd.words.length > 1) throw new Error("a case pattern of more than one word"); // a shell refuses it too
      cmd = fresh();
      if (c === ")") arm().pattern = false;
      i++;
      continue;
    }
    if (arm()?.pattern === false && c === ";" && ";&".includes(src[i + 1])) { // ;; ;& ;;& end an arm
      endCommand();
      arm().pattern = true;
      i += src.startsWith(";;&", i) ? 3 : 2;
      continue;
    }
    if (c === close && depth === 0) {
      if (heredocs.length) throw new Error("an open heredoc");
      endCommand();
      if (cases.length) throw new Error("a case with no esac");
      return i + 1;
    }
    if (c === "\\") {
      if (src[i + 1] !== "\n") { quoted = true; add(src[i + 1] ?? ""); }
      i += 2;
    } else if (c === "'") {
      quoted = true;
      const j = src.indexOf("'", i + 1);
      if (j < 0) throw new Error("an open quote");
      add(src.slice(i + 1, j));
      i = j + 1;
    } else if (c === '"') {
      quoted = true;
      const r = readExpanding(src, i + 1, '"', out, { ...here(), quoted: true });
      if (/[$`]/.test(r.text)) literal = false;
      add(r.text);
      i = r.i;
    } else if (c === "`" || (c === "$" && src[i + 1] === "(")) {
      literal = false;
      i = readCommands(src, i + (c === "`" ? 1 : 2), c === "`" ? "`" : ")", out, here());
      add("$(…)");
    } else if ((c === "<" || c === ">") && src[i + 1] === "(") { // a process substitution, <( ) or >( ): commands of its own
      literal = false;
      i = readCommands(src, i + 2, ")", out, here());
      add("$(…)");
    } else if (c === "#" && word === undefined) {
      while (i < src.length && src[i] !== "\n") i++;
    } else if (src.startsWith("<<<", i)) {
      endWord();
      target = "body";
      i += 3;
    } else if (src.startsWith("<<", i)) {
      endWord();
      cmd.heredoc = true;
      i = readDelimiter(src, i + 2, heredocs, cmd);
    } else if (c === "\n") {
      endCommand();
      i = readBodies(src, i + 1, heredocs, out);
    } else if (c === " " || c === "\t") {
      endWord();
      i++;
    } else if (c === ">" || c === "<" || (c === "&" && src[i + 1] === ">")) {
      // A redirection: >, >>, >|, >&, &>, &>>, <, <>, <&, with the number or {name} of its file descriptor before it.
      // It and its target are not words, so ps>out and 2>/dev/null ps run ps.
      if (!quoted && /^(?:\d+|\{\w+\})$/.test(word ?? "")) word = undefined;
      endWord();
      const op = /^(?:&>>?|>>|>\||>&|<>|<&|>|<)/.exec(src.slice(i, i + 3))[0];
      cmd.writes ||= op.includes(">");
      target = op;
      i += op.length;
    } else if (c === "|" && src[i + 1] !== "|") {
      const from = cmd;
      from.piped = true;
      endCommand();
      from.pipeTo = cmd;
      if (flow.nodes.length) flow.nodes.at(-1).after = "|";
      i++;
    } else if (c === ";" || c === "&" || c === "|" || c === "(" || c === ")") {
      if (c === ")" && !depth) throw new Error('a ")" with no "("');
      endCommand();
      if (c === "(") {
        const previous = flow.nodes.at(-1)?.cmd;
        const nameIndex = previous?.words.findIndex((word, index) => previous.syntax[index].quoted || !KEYWORD.test(word));
        const functionName = src[i + 1] === ")" && nameIndex >= 0 && nameIndex === previous.words.length - 1 && !previous.syntax[nameIndex].quoted && /^[A-Za-z_]\w*$/.test(previous.words[nameIndex]) ? previous.words[nameIndex] : undefined;
        if (functionName) COMMAND_CONTEXT.get(previous).functionHeader = true;
        depth++; openScope("subshell");
        flow.functionName = functionName;
      }
      if (c === ")") {
        if (cases.at(-1)?.depth === depth--) throw new Error("a case with no esac");
        const functionName = flow.functionName;
        flow = scopes.pop();
        if (functionName) flow.pendingFunction = functionName;
      }
      if (c === ";" || c === "&" || c === "|") {
        const after = src[i + 1] === c && c !== ";" ? c + c : c;
        if (flow.nodes.length) flow.nodes.at(-1).after = after;
      }
      i += (c === "|" || c === "&") && src[i + 1] === c ? 2 : 1;
    } else {
      if (c === "$" || /[*?\[\]{}~]/.test(c)) literal = false;
      if (c === "=" && !quoted && /^[A-Za-z_]\w*$/.test(word ?? "")) assignment = true;
      add(c);
      i++;
    }
  }
  if (close) throw new Error(close === ")" ? "an open $(" : "an open backtick");
  if (heredocs.length) throw new Error("an open heredoc");
  endCommand();
  if (depth) throw new Error('an open "("');
  if (cases.length) throw new Error("a case with no esac");
  return i;
}

/** Double-quoted text, or a heredoc body that expands (stop ""): its text, and the commands of its substitutions. */
function readExpanding(src, i, stop, out, host) {
  let text = "";
  while (i < src.length && src[i] !== stop) {
    const c = src[i];
    if (c === "\\" && i + 1 < src.length) {
      text += '$`"\\'.includes(src[i + 1]) ? src[i + 1] : src[i + 1] === "\n" ? "" : c + src[i + 1];
      i += 2;
    } else if (c === "`" || (c === "$" && src[i + 1] === "(")) {
      i = readCommands(src, i + (c === "`" ? 1 : 2), c === "`" ? "`" : ")", out, host);
      text += "$(…)";
    } else {
      text += c;
      i++;
    }
  }
  if (stop && i >= src.length) throw new Error("an open quote");
  return { text, i: i + 1 };
}

/** The delimiter after "<<" or "<<-". A quoted delimiter makes the body plain text, with no substitutions. */
function readDelimiter(src, i, heredocs, cmd) {
  const strip = src[i] === "-";
  if (strip) i++;
  while (src[i] === " " || src[i] === "\t") i++;
  let delimiter = "";
  let quoted = false;
  while (i < src.length && !/[\s;&|()<>]/.test(src[i])) {
    const c = src[i];
    if (c === "'" || c === '"') {
      const j = src.indexOf(c, i + 1);
      if (j < 0) throw new Error("an open quote");
      delimiter += src.slice(i + 1, j);
      i = j + 1;
      quoted = true;
    } else if (c === "\\") {
      delimiter += src[i + 1] ?? "";
      i += 2;
      quoted = true;
    } else {
      delimiter += c;
      i++;
    }
  }
  if (!delimiter) throw new Error("a heredoc with no delimiter");
  heredocs.push({ delimiter, strip, expand: !quoted, cmd });
  return i;
}

/** The bodies of the heredocs that the last line opened, read up to each delimiter line, given to their commands. */
function readBodies(src, i, heredocs, out) {
  for (const { delimiter, strip, expand, cmd } of heredocs.splice(0)) {
    const lines = [];
    for (;;) {
      if (i >= src.length) throw new Error("an open heredoc");
      const end = src.indexOf("\n", i) < 0 ? src.length : src.indexOf("\n", i);
      const line = src.slice(i, end);
      i = end + 1;
      if ((strip ? line.replace(/^\t+/, "") : line) === delimiter) break;
      lines.push(line);
    }
    const body = lines.join("\n");
    cmd.bodies.push(body);
    COMMAND_CONTEXT.get(cmd).bodyLiterals.push(!expand || !/[$`]/.test(body));
    if (expand) readExpanding(body, 0, "", out, { cmd, index: -1 });
  }
  return Math.min(i, src.length);
}
