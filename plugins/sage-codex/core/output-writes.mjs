import { programName, GIT_VALUE } from "./command-policy.mjs";

// These programs can write with ordinary operands, including through config or SQL.
const WRITERS = new Set(["ditto", "scp", "wget", "sqlite3"]);
const CURL_WRITE = new Set("output output-dir remote-name remote-name-all remote-header-name dump-header cookie-jar trace trace-ascii stderr libcurl etag-save alt-svc hsts ssl-sessions config write-out create-dirs xattr".split(" "));
const CURL_VALUE = new Set("url user user-agent header proxy-header data data-ascii data-binary data-raw data-urlencode json form form-string request request-target referer cookie range upload-file max-time connect-timeout retry retry-delay retry-max-time proxy proxy-user noproxy cacert capath cert key pass resolve connect-to unix-socket interface variable url-query".split(" "));
const CURL_FLAG = new Set("silent show-error location location-trusted fail fail-with-body head include show-headers verbose insecure compressed globoff get disable no-progress-meter progress-bar version help http1.0 http1.1 http2 http2-prior-knowledge http3 ipv4 ipv6 next".split(" "));
const GIT_VALUE_OPTION = /^(?:--grep|--grep-reflog|--author|--committer|--since|--after|--until|--before|--format|--date|--encoding|--diff-filter|--find-object|--src-prefix|--dst-prefix|--line-prefix|--output-indicator-new|--output-indicator-old|--output-indicator-context|--word-diff-regex|--diff-algorithm|--anchored|--order-file|--rotate-to|--skip-to|--max-count|--skip|-S|-G|-L|-O|-n)$/;
const GIT_FLAGS = new Set("--no-index --stat --numstat --shortstat --name-only --name-status --check --raw --patch --no-patch --oneline --all --no-ext-diff --no-color --color --no-prefix --relative --reverse --text --binary --exit-code --quiet --no-renames --find-renames --find-copies --ignore-space-change --ignore-all-space --ignore-space-at-eol --ignore-blank-lines -p -s -w -b -a -R".split(" "));
const gitOutput = arg => /^--o(?:u(?:t(?:p(?:u(?:t)?)?)?)?)?(?:=|$)/.test(arg);

function opensslWrites(args) {
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--" || !args[i].startsWith("-") || args[i] === "-") break;
    const option = args[i].replace(/^--?/, "");
    if (/^(?:out|keyout|writerand)(?:=|$)/.test(option)) return true;
    if (/^(?:in|inform|outform|hmac|mac|macopt|sigopt|signature|verify|prverify|passin|passout|inkey|keyform|digest|provider|provider-path|propquery|engine)$/.test(option)) i++;
    else if (!/^(?:hex|binary|r|c|list|help|debug|text|noout|md4|md5|sha1|sha224|sha256|sha384|sha512|sha512-224|sha512-256|sha3-224|sha3-256|sha3-384|sha3-512|shake128|shake256|blake2b512|blake2s256|ripemd160|sm3)$/.test(option)) return true;
  }
  return false;
}

/** Inspect actual argv, preserving option case and values. Unknown curl options are conservative. */
function curlWrites(args) {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") break;
    if (arg.startsWith("--")) {
      const name = arg.slice(2).split("=", 1)[0];
      if (CURL_WRITE.has(name)) return true;
      if (CURL_VALUE.has(name)) { if (!arg.includes("=")) i++; }
      else if (!CURL_FLAG.has(name)) return true;
    } else if (arg.startsWith("-") && arg !== "-") {
      for (let k = 1; k < arg.length; k++) {
        const flag = arg[k];
        if ("oODcKJw".includes(flag)) return true;
        if ("AHdbFueXrTumxUPzCYytEQ".includes(flag)) { if (k === arg.length - 1) i++; break; }
        if (!"sSLfIvkiGgqN#Vh012346BZ:".includes(flag)) return true;
      }
    }
  }
  return false;
}

/** Known output forms, not a general guarantee that other commands cannot write. */
export function outputDispatchWrites(entry) {
  if (entry.wrapper) return false;
  const name = programName(entry.run.word), args = entry.run.args;
  if (WRITERS.has(name)) return true;
  if (name === "curl") return curlWrites(args);
  if (name === "openssl") return opensslWrites(args);
  if (name !== "git") return false;
  let i = 0;
  while (args[i]?.startsWith("-")) i += GIT_VALUE.test(args[i]) ? 2 : 1;
  if (!["diff", "show", "log"].includes(args[i++])) return false;
  let unknownOption = false;
  for (; i < args.length; i++) {
    if (args[i] === "--") {
      // An unknown option may consume '--' as its value. Do not hide a later output option.
      if (unknownOption) { unknownOption = false; continue; }
      break;
    }
    if (gitOutput(args[i])) return true;
    unknownOption = /^-[^=]+$/.test(args[i]) && !GIT_FLAGS.has(args[i]);
    if (GIT_VALUE_OPTION.test(args[i])) { i++; unknownOption = false; }
  }
  return false;
}

/** The options that take a value in the gh commands that ghTargets reads (gh 2.x help), short and long. */
const GH_VALUE = /^(?:-[uDOpAnRc]|--(?:upstream-remote-name|dir|output|pattern|archive|name|repo|codespace|profile|repo-owner|fork-name|remote-name|org|hostname))$/;
/** The folder that a clone of a repository makes: its last name, without .git. */
const cloneFolder = (repo) => repo.replace(/\/+$/, "").split(/[/:]/).pop().replace(/\.git$/, "");
/**
 * The paths that a gh command writes, in the folder that it runs in, or true when it changes files at no path that it
 * names (F-T948-1, F-T948-5, F-T960-2). gh's options come before, between or after its two command words, so
 * "gh -R o/r release download" is a release download. gh repo clone and gh gist clone write the folder that they name, or
 * else a folder named after the repository; gh repo fork --clone and gh repo create --clone write a folder named after
 * the repository (a fork with no repository changes the checkout's remotes: its folder). gh run download and gh release
 * download write into the folder of -D, the file of -O (- is the output) or else the command's folder; gh attestation
 * download writes into the command's folder; gh codespace cp writes its last operand when that is local. gh extension
 * install, upgrade, remove and create change gh's extensions or make a folder. Every other gh command writes no file of
 * its own: gh pr checkout changes the work tree as git checkout does, and the rules let git run.
 */
export function ghTargets(args) {
  const words = [], values = {};
  let clone = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") break; // gh repo clone: git's own options follow
    if (!arg.startsWith("-") || arg === "-") { words.push(arg); continue; }
    const equals = arg.indexOf("="), long = arg.startsWith("--");
    const name = long ? arg.slice(0, equals < 0 ? undefined : equals) : arg.slice(0, 2);
    // --clone and gh repo create's -c are flags; --clone=false clones nothing.
    if (name === "--clone" || (arg === "-c" && words[0] === "repo" && words[1] === "create")) { clone = equals < 0 || !/^false$/i.test(arg.slice(equals + 1)); continue; }
    if (!GH_VALUE.test(name)) continue;
    const value = long ? (equals < 0 ? args[++i] : arg.slice(equals + 1)) : arg.length > 2 ? arg.slice(arg[2] === "=" ? 3 : 2) : args[++i];
    values[name] = value ?? "";
  }
  const [group = "", command = "", ...operands] = words;
  if (/^(?:extension|extensions|ext)$/.test(group)) return /^(?:install|upgrade|remove|rm|create)$/.test(command) || [];
  const option = (short, long) => values[short] ?? values[long];
  const key = `${group} ${command}`;
  if (/^(?:repo|gist) clone$/.test(key)) {
    if (operands.length > 1) return [operands[1]];
    return operands.length ? [cloneFolder(operands[0])] : [];
  }
  if (key === "repo fork") return !clone ? [] : operands.length ? [values["--fork-name"] ?? cloneFolder(operands[0])] : ["."];
  if (key === "repo create") return clone ? [operands.length ? cloneFolder(operands[0]) : "."] : [];
  if (key === "run download") return [option("-D", "--dir") ?? "."];
  if (key === "release download") {
    const output = option("-O", "--output");
    return output === "-" ? [] : [output ?? option("-D", "--dir") ?? "."];
  }
  if (key === "attestation download") return ["."];
  if (/^(?:codespace|cs) cp$/.test(key)) return operands.length > 1 && !operands.at(-1).startsWith("remote:") ? [operands.at(-1)] : [];
  return [];
}
