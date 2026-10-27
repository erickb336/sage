import { execFileSync } from "node:child_process";

/** Local repository reads must not inherit selectors, fetch missing objects, or run transport helpers. */
export function readLocalGit(project, args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_NO_REPLACE_OBJECTS: "1",
    GIT_NO_LAZY_FETCH: "1", GIT_ALLOW_PROTOCOL: "", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0",
  });
  return execFileSync("git", ["--no-replace-objects", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null",
    "-c", "protocol.allow=never", "-C", project, ...args],
  { env, timeout: 5000, maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
}
