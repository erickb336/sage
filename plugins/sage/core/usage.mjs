import { HIDDEN } from "./logbook-fields.mjs";

// Usage declarations describe observation, not native authority or review approval.
export const USAGE_FIELDS = ["usage_provider", "usage_interface", "usage_capability", "usage_binding", "usage_reason", "usage_basis", "usage_status", "usage_source", "usage_evidence"];
export const tokenCount = value => /^[1-9]\d{0,11}$/.test(value ?? "");
export const usageText = value => typeof value === "string" && value.length > 0 && value.length <= 2048 && value.trim() === value && value.replace(HIDDEN, "") === value && !/[\p{Cc}\p{Cf}\u2028\u2029]/u.test(value);
const id = value => typeof value === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(value);
export function usageRegistry(entries) {
  if (!Array.isArray(entries)) throw new TypeError("usage interfaces must be an array");
  const result = new Map();
  for (const entry of entries) {
    if (!entry || Object.keys(entry).sort().join() !== "capability,interface,provider,reason,source" || !id(entry.provider) || !id(entry.interface)
      || !["measured", "unavailable"].includes(entry.capability) || !usageText(entry.reason) || !usageText(entry.source)
      || result.has(entry.interface)) throw new TypeError("invalid usage interface registry");
    result.set(entry.interface, Object.freeze({ ...entry }));
  }
  return result;
}
export function usageSnapshot(entry) {
  return { usage_provider: entry.provider, usage_interface: entry.interface, usage_capability: entry.capability,
    usage_binding: "chief-declared-unauthenticated", usage_reason: entry.reason, usage_basis: entry.source };
}
export function validUsageSnapshot(row) {
  return id(row.usage_provider) && id(row.usage_interface) && ["measured", "unavailable"].includes(row.usage_capability)
    && row.usage_binding === "chief-declared-unauthenticated" && usageText(row.usage_reason) && usageText(row.usage_basis);
}
export function usageCounts(runs) {
  const ended = runs.filter(r => r.status === "done");
  const measured = ended.filter(r => tokenCount(r.tokens)).length;
  const unavailable = ended.filter(r => !tokenCount(r.tokens) && r.usage_status === "unavailable").length;
  const legacy = ended.length - measured - unavailable;
  return { measured, unavailable, legacy, partial: unavailable + legacy > 0 };
}
export function usageSummary(runs) {
  const c = usageCounts(runs);
  return `${c.partial ? "partial measured total; " : ""}${c.measured} measured, ${c.unavailable} unavailable, ${c.legacy} legacy-unrecorded`;
}
