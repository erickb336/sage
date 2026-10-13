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
    if (args[i] === "--") {
      const prior = args[i - 1] ?? "";
      if (/^--?[^=]+$/.test(prior) && !/^--?(?:hex|binary|r|c|list|help|debug|text|noout)$/.test(prior)) continue;
      break;
    }
    if (!args[i].startsWith("-")) continue;
    const option = args[i].replace(/^--?/, "");
    if (/^(?:out|keyout|writerand)(?:=|$)/.test(option)) return true;
    if (/^(?:in|inform|outform|hmac|mac|macopt|sigopt|signature|verify|prverify|passin|passout|inkey|keyform|digest|provider|provider-path|propquery|engine)$/.test(option)) i++;
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
  if (entry.wrapper || entry.shellFunction || entry.resolvedDeclaration) return false;
  const name = programName(entry.run.word), args = entry.run.args;
  if (WRITERS.has(name)) return true;
  if (name === "curl") return curlWrites(args);
  if (name === "openssl") return opensslWrites(args);
  if (name !== "git") return false;
  let i = 0;
  while (args[i]?.startsWith("-")) i += GIT_VALUE.test(args[i]) ? 2 : 1;
  if (!["diff", "show", "log"].includes(args[i++])) return false;
  for (; i < args.length; i++) {
    if (args[i] === "--") {
      // An unknown option may consume '--' as its value. Do not hide a later output option.
      const prior = args[i - 1] ?? "";
      if (/^-[^=]+$/.test(prior) && !GIT_FLAGS.has(prior)) continue;
      break;
    }
    if (gitOutput(args[i])) return true;
    if (GIT_VALUE_OPTION.test(args[i])) i++;
  }
  return false;
}
