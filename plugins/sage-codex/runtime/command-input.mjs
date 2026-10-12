// Wire types from Codex rust-v0.160.0. Validation never grants command permission.
const unavailable = () => { throw Error("Codex command arguments are unavailable"); };
const object = value => value !== null && typeof value === "object" && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value))
  && Reflect.ownKeys(value).length === Object.keys(value).length
  && Object.values(Object.getOwnPropertyDescriptors(value)).every(row => Object.hasOwn(row, "value"));
const fields = (value, allowed, required = []) => object(value)
  && Object.keys(value).every(key => allowed.includes(key)) && required.every(key => Object.hasOwn(value, key));
const text = (value, limit = 4096) => typeof value === "string" && value.length <= limit && !value.includes("\0");
const path = value => text(value) && !/\p{Cc}/u.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const optional = (value, key, check) => !Object.hasOwn(value, key) || value[key] === null || check(value[key]);
const list = (value, check) => {
  if (!Array.isArray(value) || value.length > 256) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== value.length + 1) return false;
  for (let index = 0; index < value.length; index++) {
    const item = descriptors[index];
    if (!item || !Object.hasOwn(item, "value") || !item.enumerable || !check(item.value)) return false;
  }
  return true;
};

function permissionPath(value) {
  if (!object(value)) return false;
  if (value.type === "path") return fields(value, ["type", "path"], ["type", "path"]) && path(value.path) && value.path.length > 0;
  if (value.type === "glob_pattern") return fields(value, ["type", "pattern"], ["type", "pattern"]) && path(value.pattern);
  if (value.type !== "special" || !fields(value, ["type", "value"], ["type", "value"])) return false;
  const special = value.value;
  if (!object(special)) return false;
  if (["root", "minimal", "tmpdir", "slash_tmp"].includes(special.kind)) return fields(special, ["kind"], ["kind"]);
  if (["project_roots", "current_working_directory"].includes(special.kind))
    return fields(special, ["kind", "subpath"], ["kind"]) && optional(special, "subpath", path);
  return special.kind === "unknown" && fields(special, ["kind", "path", "subpath"], ["kind", "path"])
    && path(special.path) && optional(special, "subpath", path);
}
function permissionEntry(value) {
  return fields(value, ["path", "access", "missing_path_behavior"], ["path", "access"])
    && permissionPath(value.path) && ["read", "write", "deny", "none"].includes(value.access)
    && optional(value, "missing_path_behavior", item => item === "skip");
}
function filePermissions(value) {
  if (!object(value)) return false;
  // The native untagged union accepts either shape, never a mixture.
  if (Object.hasOwn(value, "read") || Object.hasOwn(value, "write"))
    return fields(value, ["read", "write"]) && ["read", "write"].every(key => optional(value, key,
      item => list(item, entry => path(entry) && entry.length > 0)));
  return fields(value, ["entries", "glob_scan_max_depth"])
    && (!Object.hasOwn(value, "entries") || list(value.entries, permissionEntry))
    && optional(value, "glob_scan_max_depth", item => integer(item) && item > 0);
}
function permissions(value) {
  return fields(value, ["network", "file_system"])
    && optional(value, "network", item => fields(item, ["enabled"]) && optional(item, "enabled", flag => typeof flag === "boolean"))
    && optional(value, "file_system", filePermissions);
}

/** Validate recovered arguments without normalizing omissions, paths, defaults, or permission intent.
 * The caller must still establish the effective shell/environment and apply every authorization rule. */
function decode(value) {
  if (!fields(value, ["cmd", "shell", "login", "tty", "yield_time_ms", "timeout_ms", "max_output_tokens",
    "sandbox_permissions", "additional_permissions", "justification", "prefix_rule", "environment_id", "workdir"], ["cmd"])
    || !text(value.cmd, 1024 * 1024) || !value.cmd.length
    || !optional(value, "shell", item => path(item) && item.length > 0)
    || !optional(value, "workdir", path)
    || !optional(value, "environment_id", item => text(item, 256) && item.length > 0 && !/\p{Cc}/u.test(item))
    || !optional(value, "login", item => typeof item === "boolean")
    || (Object.hasOwn(value, "tty") && typeof value.tty !== "boolean")
    || (Object.hasOwn(value, "yield_time_ms") && !integer(value.yield_time_ms))
    || !["timeout_ms", "max_output_tokens"].every(key => optional(value, key, integer))
    || !optional(value, "sandbox_permissions", item => ["use_default", "require_escalated", "with_additional_permissions"].includes(item))
    || !optional(value, "additional_permissions", permissions)
    || !optional(value, "justification", item => text(item, 16 * 1024))
    || !optional(value, "prefix_rule", item => list(item, entry => text(entry)))) unavailable();
  return structuredClone(value);
}

/** Inspection and cloning failures use the same public error as invalid wire data. */
export function decodeNativeCommand(value) {
  try { return decode(value); } catch { unavailable(); }
}
