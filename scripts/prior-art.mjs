import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./build.mjs";

export const PRIOR_ART_TEXTS = Object.freeze([
  "packages/sage-core/roles/designer.md",
  "packages/sage-core/roles/pe.md",
  "packages/sage-core/roles/investigate.md",
  "packages/sage-core/roles/chief-of-staff.md",
  "packages/sage-core/references/playbooks/design.md",
  "packages/sage-core/references/playbooks/architecture.md",
]);

const ASKING_LINE = /\bprior art\b.*\b2 or 3 existing (?:stacks|products) or tools\b.*\bhow and why\b/i;

export function priorArtProblems(read = (path) => readFileSync(join(ROOT, path), "utf8")) {
  return PRIOR_ART_TEXTS.filter((path) => !ASKING_LINE.test(read(path)))
    .map((path) => `${path}: no "prior art" line; ask for 2 or 3 existing stacks or tools, and the one that the choice follows, or how and why it differs (T1016)`);
}
