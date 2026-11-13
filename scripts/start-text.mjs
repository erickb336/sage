import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./build.mjs";

const PLUGIN = join(ROOT, "plugins/sage");
export const START_LIMITS = Object.freeze({ "chief-of-staff": 48_000, lead: 45_000 });
export const REFERENCE_FOLDERS = Object.freeze(["skills/sage/references", "core/references"]);

const skillsOf = (agent) => [...(/^---\n([\s\S]*?)\n---\n/.exec(agent)?.[1] ?? "").matchAll(/^\s+-\s+sage:(\S+)\s*$/gm)].map((m) => m[1]);

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

export const referenceFiles = () => REFERENCE_FOLDERS.flatMap((dir) =>
  existsSync(join(PLUGIN, dir)) ? readdirSync(join(PLUGIN, dir)).filter((f) => f.endsWith(".md")).sort().map((f) => `${dir}/${f}`) : []);

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
