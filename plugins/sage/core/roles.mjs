import { readFileSync } from "node:fs";

export const ROLES = new Set(["lead", "implementer", "pe", "designer", "arena-judge", "code-reviewer", "security-reviewer", "ux-reviewer", "qa", "investigate", "evidence-review"]);

export const ROLE_PRINCIPLES = Object.freeze({
  "chief-of-staff": ["never-block-on-the-human", "encode-lessons-in-structure", "contextualize-and-write-for-the-reader", "guard-the-context-window"],
  lead: ["never-block-on-the-human", "prove-it-works"],
  implementer: ["laziness-protocol", "subtract-before-you-add", "test-behavior-not-implementation", "migrate-callers-then-delete-legacy-apis", "prove-it-works", "fix-root-causes", "attack-the-premise", "build-the-lever", "sequence-verifiable-units"],
  pe: ["foundational-thinking", "exhaust-the-design-space", "boundary-discipline", "laziness-protocol", "explain-the-number", "make-operations-idempotent", "model-the-domain", "outcome-oriented-execution", "redesign-from-first-principles", "separate-before-serializing-shared-state", "type-system-discipline"],
  designer: ["experience-first", "exhaust-the-design-space", "contextualize-and-write-for-the-reader"],
  "arena-judge": ["exhaust-the-design-space", "experience-first", "laziness-protocol", "prove-it-works"],
  "code-reviewer": ["laziness-protocol", "test-behavior-not-implementation", "migrate-callers-then-delete-legacy-apis", "minimize-reader-load"],
  "security-reviewer": ["boundary-discipline"],
  "ux-reviewer": ["experience-first"],
  qa: ["prove-it-works", "test-behavior-not-implementation", "explain-the-number"],
  investigate: ["build-the-lever", "explain-the-number", "guard-the-context-window"],
  "evidence-review": ["explain-the-number"],
});
const render = (name, bindings) => {
  const text = readFileSync(new URL(`./roles/${name}.md`, import.meta.url), "utf8").trim();
  const keys = [...new Set([...text.matchAll(/\{\{([A-Z_]+)\}\}/g)].map(match => match[1]))];
  if (!bindings || typeof bindings !== "object" || Array.isArray(bindings)
    || Object.keys(bindings).length !== keys.length || keys.some(key => !Object.hasOwn(bindings, key)
      || typeof bindings[key] !== "string" || !bindings[key].trim() || bindings[key].length > 16 * 1024
      || /\{\{|\}\}|\0/.test(bindings[key]))) throw Error("Role instructions require exact provider bindings");
  return text.replace(/\{\{([A-Z_]+)\}\}/g, (_, key) => bindings[key]);
};

export function renderRoleInstructions(role, bindings = {}) {
  if (!ROLES.has(role)) throw Error("Unknown child role");
  return render(role, bindings);
}

export function renderReportInstructions(bindings) {
  return render("report", bindings);
}

export function renderChiefInstructions(bindings) {
  return render("chief-of-staff", bindings);
}
