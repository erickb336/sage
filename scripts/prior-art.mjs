// The prior-art rule (owner 2026-11-12, T1016): every design or structural choice names 2 or 3 existing stacks or tools,
// and the one that it follows, or how and why it differs (the "Considered Options" of a MADR record). The texts below ask
// for it; the core role texts render both providers' agents and chief. npm run check fails when one of them loses its asking
// line: one line that names the prior art, asks for 2 or 3 existing stacks, products or tools, and asks how and why the
// choice differs. The words "prior art" alone elsewhere in a text, such as in a report's RESULT, do not count (F-T1016-6).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./build.mjs";

/** The source texts that must ask for the prior art, from the repository's root. */
export const PRIOR_ART_TEXTS = Object.freeze([
  "packages/sage-core/roles/designer.md",
  "packages/sage-core/roles/pe.md",
  "packages/sage-core/roles/investigate.md",
  "packages/sage-core/roles/chief-of-staff.md",
  "packages/sage-core/references/playbooks/design.md",
  "packages/sage-core/references/playbooks/architecture.md",
]);

/** The asking line, in each of the texts: "." matches no line end, so the three parts are on one line. */
const ASKING_LINE = /\bprior art\b.*\b2 or 3 existing (?:stacks|products) or tools\b.*\bhow and why\b/i;

/** The problems: one for each text that does not ask for the prior art. `read` gives a text by its path from the root. */
export function priorArtProblems(read = (path) => readFileSync(join(ROOT, path), "utf8")) {
  return PRIOR_ART_TEXTS.filter((path) => !ASKING_LINE.test(read(path)))
    .map((path) => `${path}: no "prior art" line; ask for 2 or 3 existing stacks or tools, and the one that the choice follows, or how and why it differs (T1016)`);
}
