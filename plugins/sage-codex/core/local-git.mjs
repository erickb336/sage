import { execFileSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { dirname } from "node:path";

function trustedGit() {
  const candidates = process.platform === "darwin"
    ? ["/Library/Developer/CommandLineTools/usr/bin/git", "/Applications/Xcode.app/Contents/Developer/usr/bin/git"]
    : process.platform === "linux" ? ["/usr/bin/git", "/bin/git"] : [];
  for (const candidate of candidates) {
    try {
      const executable = realpathSync(candidate);
      for (let path = executable; ; path = dirname(path)) {
        const stat = lstatSync(path);
        if (stat.uid !== 0 || (stat.mode & 0o022)
          || (path === executable ? !stat.isFile() || !(stat.mode & 0o111) : !stat.isDirectory())) throw Error("untrusted Git path");
        if (path === dirname(path)) break;
      }
      return executable;
    } catch {}
  }
  throw Error("no trusted system Git executable is available");
}

export function readLocalGit(project, args, input, { timeout = 5000, maxBuffer = 32 * 1024 * 1024 } = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_NO_REPLACE_OBJECTS: "1", GIT_GRAFT_FILE: "/dev/null",
    GIT_NO_LAZY_FETCH: "1", GIT_ALLOW_PROTOCOL: "", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0",
  });
  return execFileSync(trustedGit(), ["--no-replace-objects", "-c", "core.commitGraph=false", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null",
    "-c", "protocol.allow=never", "-C", project, ...args],
  { env, input, timeout, maxBuffer, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "ignore"] });
}
