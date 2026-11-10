// The start texts of the Claude chief and lead (T934): what each one gets before its first step. The chief gets the sage
// hook's chief text and the skills that it names; the lead gets its agent file and the skills of its frontmatter. Each
// reference that a start text names is a file of the built plugin that the agent reads only when its trigger holds.
// npm run check holds each start text under its limit, and checks that every reference exists and has its trigger.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./build.mjs";

const PLUGIN = join(ROOT, "plugins/sage");
/** The most bytes that each start text may have. Lower a limit when a change makes its text smaller. */
export const START_LIMITS = Object.freeze({ "chief-of-staff": 113_400, lead: 110_100 });
/** The folders of the built plugin that hold references, from the plugin's folder. */
export const REFERENCE_FOLDERS = Object.freeze(["skills/sage/references", "core/references"]);

const skillsOf = (agent) => [...(/^---\n([\s\S]*?)\n---\n/.exec(agent)?.[1] ?? "").matchAll(/^\s+-\s+sage:(\S+)\s*$/gm)].map((m) => m[1]);

/** One role's start text: its parts (the agent text, then each skill) with their bytes, and the whole text. */
export async function startText(role) {
  const agent = readFileSync(join(PLUGIN, "agents", `${role}.md`), "utf8");
  const first = role === "chief-of-staff" ? (await import("../plugins/sage/hooks/sage-hook.mjs")).chiefText() : agent;
  const parts = [[role === "chief-of-staff" ? "chief text" : `agents/${role}.md`, first],
    ...skillsOf(agent).map((name) => [`sage:${name}`, readFileSync(join(PLUGIN, "skills", name, "SKILL.md"), "utf8")])];
  return {
    parts: parts.map(([name, text]) => ({ name, bytes: Buffer.byteLength(text) })),
    bytes: parts.reduce((sum, [, text]) => sum + Buffer.byteLength(text), 0),
    text: parts.map(([, text]) => text).join("\n\n"),
  };
}

/** Every reference file of the built plugin, from the plugin's folder. */
export const referenceFiles = () => REFERENCE_FOLDERS.flatMap((dir) =>
  existsSync(join(PLUGIN, dir)) ? readdirSync(join(PLUGIN, dir)).filter((f) => f.endsWith(".md")).sort().map((f) => `${dir}/${f}`) : []);

/**
 * The problems of the start texts: a text over its limit, a reference that a start text names and that does not exist,
 * a reference file that no start text names, and a line that names a reference with no trigger (no "read" with "when",
 * "before" or "for" in that line).
 */
export async function startTextProblems() {
  const problems = [], named = new Set();
  for (const [role, limit] of Object.entries(START_LIMITS)) {
    const { bytes, text } = await startText(role);
    if (bytes > limit) problems.push(`the ${role} start text has ${bytes} bytes, over its limit of ${limit} (START_LIMITS in scripts/start-text.mjs): move a rarely used part to a reference`);
    for (const line of text.split("\n")) {
      for (const [path] of line.matchAll(/(?:skills\/sage\/references|core\/references)\/[\w-]+\.md/g)) {
        named.add(path);
        if (!existsSync(join(PLUGIN, path))) problems.push(`the ${role} start text names ${path}, which plugins/sage does not have`);
        if (!/\bread\b/i.test(line) || !/\b(?:when|before|for)\b/i.test(line)) problems.push(`the ${role} start text names ${path} in a line with no trigger: say when to read it`);
      }
    }
  }
  for (const file of referenceFiles()) if (!named.has(file)) problems.push(`plugins/sage/${file}: no start text names it, so no agent reads it`);
  return problems;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  for (const role of Object.keys(START_LIMITS)) {
    const { bytes, parts } = await startText(role);
    console.log(`${role}: ${bytes} bytes (limit ${START_LIMITS[role]}) = ${parts.map((p) => `${p.name} ${p.bytes}`).join(" + ")}`);
  }
}
