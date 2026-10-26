// Checks the sources and that the generated files match them. Fails with a list of every problem.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { GENERATED, ROOT, outputs, filesUnder, parseSource } from "./build.mjs";
import { changelog } from "./changelog.mjs";
import { checkWords, flaggedWords, yamlText } from "./dictionary.mjs";
import { MOMENTS } from "../plugins/sage/hooks/principles-hook.mjs";
import { BRIEF_FIELDS as CORE_BRIEF_FIELDS } from "../packages/sage-core/index.mjs";
import { TASK_KINDS } from "../packages/sage-core/logbook-fields.mjs";
import { BRIEF_FIELDS, FINDING_FORM, REPORT_FIELDS } from "../plugins/sage/hooks/sage-hook.mjs";
import { handle as codexModeHook } from "../plugins/sage-codex/hooks/sage-codex-hook.mjs";
import { chiefInstructionParts } from "../plugins/sage-codex/runtime/chief-output.mjs";
import { fingerprint, overrides } from "./sync-pstack.mjs";
import { withoutPrinciplesTable } from "./principles-table.mjs";
import { PRINCIPLES_PAGE } from "./dictionary.mjs";
import { files as graphics } from "./graphics.mjs";
import { packageBoundaryProblems } from "./package-boundaries.mjs";
import { docFiles, linkProblems, paragraphProblems, readmeProblems } from "./readme-checks.mjs";
import { SHOTS, SHOTS_RECORD, sampleHash } from "./board-shots.mjs";

const problems = [];
try { problems.push(...packageBoundaryProblems(ROOT)); }
catch { problems.push("package dependency analysis failed; check that imports resolve and package sources are valid"); }
const words = (s) => s.split(/\s+/).filter(Boolean).length;

for (const f of readdirSync(join(ROOT, "principles")).filter((f) => f.endsWith(".md") && f !== "README.md")) {
  try {
    const { meta, body } = parseSource(readFileSync(join(ROOT, "principles", f), "utf8"), f);
    for (const k of ["id", "name", "applyWhen", "source"]) if (!meta[k]) problems.push(`principles/${f}: missing "${k}"`);
    if (meta.id && `${meta.id}.md` !== f) problems.push(`principles/${f}: id "${meta.id}" does not match the file name`);
    if (meta.id && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(meta.id)) problems.push(`principles/${f}: id must be lowercase words joined by hyphens`);
    if (words(body) > 200) problems.push(`principles/${f}: ${words(body)} words; the limit is 200`);
    if (/^pstack /.test(meta.source ?? "") && !/^[0-9a-f]{16}$/.test(meta.upstream ?? "")) problems.push(`principles/${f}: overrides pstack, so it needs upstream: <the fingerprint of the pstack text it was reviewed against>`);
  } catch (e) { problems.push(String(e.message)); }
}

// Every skill, generated or own, follows the shared agentskills.io core: name (= folder, ≤64, lowercase-hyphen) and description (≤1024).
const skillsDir = join(ROOT, "plugins/sage/skills");
for (const d of readdirSync(skillsDir)) {
  const f = join(skillsDir, d, "SKILL.md");
  if (!existsSync(f)) { problems.push(`skills/${d}: no SKILL.md`); continue; }
  const m = /^---\n([\s\S]*?)\n---\n/.exec(readFileSync(f, "utf8"));
  if (!m) { problems.push(`skills/${d}/SKILL.md: no frontmatter`); continue; }
  const name = /^name:\s*(.+)$/m.exec(m[1])?.[1]?.trim();
  const desc = /^description:\s*(.+)$/m.exec(m[1])?.[1]?.trim();
  if (name !== d) problems.push(`skills/${d}/SKILL.md: name "${name}" must equal the folder name`);
  if (!name || name.length > 64 || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) problems.push(`skills/${d}/SKILL.md: name must be lowercase words joined by hyphens, at most 64 characters`);
  if (!desc) problems.push(`skills/${d}/SKILL.md: missing description`);
  else if (yamlText(desc).length > 1024) problems.push(`skills/${d}/SKILL.md: description over 1024 characters`);
  // The shared skill format (agentskills.io) has only these top-level keys.
  for (const key of m[1].split("\n").filter((l) => /^[A-Za-z-]+:/.test(l)).map((l) => l.split(":")[0])) {
    if (!["name", "description", "license", "allowed-tools", "metadata"].includes(key)) problems.push(`skills/${d}/SKILL.md: key "${key}" is not in the shared skill format`);
  }
}

// Every skill that the hook gives must exist, because the hook reads the text from it.
for (const [moment, { skills }] of Object.entries(MOMENTS)) {
  for (const s of skills) if (!existsSync(join(skillsDir, s, "SKILL.md"))) problems.push(`hooks: moment "${moment}" names "${s}", which has no skill`);
}

// Sage mode (Claude Code only). Agents: name equals the file, a description, preloaded skills that exist, sage names that exist.
const PLUGIN = join(ROOT, "plugins/sage");
const frontmatter = (file) => /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(readFileSync(file, "utf8"));
const agents = readdirSync(join(PLUGIN, "agents")).filter((f) => f.endsWith(".md"));
for (const f of agents) {
  const m = frontmatter(join(PLUGIN, "agents", f));
  if (!m) { problems.push(`agents/${f}: no frontmatter`); continue; }
  if (/^name:\s*(.+)$/m.exec(m[1])?.[1].trim() !== f.slice(0, -3)) problems.push(`agents/${f}: name must equal the file name`);
  if (!/^description:\s*\S/m.test(m[1])) problems.push(`agents/${f}: missing description`);
  for (const [, skill] of m[1].matchAll(/^\s+-\s+(\S+)\s*$/gm)) {
    const [ns, name] = skill.split(":");
    if (ns !== "sage" || !existsSync(join(skillsDir, name ?? "", "SKILL.md"))) problems.push(`agents/${f}: preloads ${skill}, which is not a sage skill`);
  }
  for (const [, name] of m[2].matchAll(/`sage:([a-z-]+)`/g)) {
    if (!agents.includes(`${name}.md`) && !existsSync(join(skillsDir, name, "SKILL.md"))) problems.push(`agents/${f}: names sage:${name}, which is neither an agent nor a skill`);
  }
  // Every agent writes for a person, in sage's words; every agent but the chief ends with the report.
  for (const skill of f === "chief-of-staff.md" ? ["dictionary"] : ["report", "dictionary"]) if (!new RegExp(`^  - sage:${skill}$`, "m").test(m[1])) problems.push(`agents/${f}: must preload sage:${skill}`);
}
// The chief's brief template and the report skill list the same fields as the hook's gates, in the same order.
const template = /## The brief[\s\S]*?```\n([\s\S]*?)```/.exec(frontmatter(join(PLUGIN, "agents/chief-of-staff.md"))?.[2] ?? "")?.[1] ?? "";
const briefFields = template.split("\n").map((l) => l.split(/\s+/)[0]).filter(Boolean);
if (CORE_BRIEF_FIELDS.join(" ") !== BRIEF_FIELDS.join(" ")) problems.push("the core brief fields differ from the hook contract");
if (briefFields.join(" ") !== BRIEF_FIELDS.join(" ")) problems.push(`agents/chief-of-staff.md: the brief template has ${briefFields.join(" ")}, the hook checks ${BRIEF_FIELDS.join(" ")}`);
const report = /```\n([\s\S]*?)```/.exec(readFileSync(join(skillsDir, "report/SKILL.md"), "utf8"))?.[1] ?? "";
const reportFields = report.split("\n").map((l) => l.split(/\s{2,}/)[0].trim()).filter(Boolean);
if (reportFields.join("|") !== REPORT_FIELDS.join("|")) problems.push(`skills/report: the template has ${reportFields.join(", ")}, the hook checks ${REPORT_FIELDS.join(", ")}`);
// The sage skill of each provider lists the task kinds that the state tool takes, in the same order (T314).
for (const file of ["plugins/sage/skills/sage/SKILL.md", "plugins/sage-codex/skills/sage/references/commands.md"])
  if (!readFileSync(join(ROOT, file), "utf8").includes(`A kind is one of: ${TASK_KINDS.join(", ")}.`)) problems.push(`${file}: the kind list is not "A kind is one of: ${TASK_KINDS.join(", ")}.", the kinds of the state tool`);
// The hook reads a helper's findings only in its one line form (F-T289-11): the template's FINDINGS line gives that form.
if (!/^FINDINGS\s.*$/m.exec(report)?.[0].includes(FINDING_FORM)) problems.push(`skills/report: the FINDINGS line does not give the hook's finding form ${FINDING_FORM}`);
// The hook's reader takes a finding's detail only on indented lines under its line (F-T289-29): the report skill, and each
// agent that asks for detail for each finding, say where it goes.
for (const [name, text] of [["skills/report", readFileSync(join(skillsDir, "report/SKILL.md"), "utf8")], ...agents.map((f) => [`agents/${f}`, readFileSync(join(PLUGIN, "agents", f), "utf8")])]) {
  if ((name === "skills/report" || /For each finding, the/.test(text)) && !text.includes("on indented lines under")) problems.push(`${name}: a finding's detail must go on indented lines under the finding's line, the one form that the hook reads`);
}
// Every hook command runs a script that exists, in the shared hooks and in Claude's own.
for (const cfg of ["hooks.json", "claude.json"]) {
  for (const [event, groups] of Object.entries(JSON.parse(readFileSync(join(PLUGIN, "hooks", cfg), "utf8")).hooks)) for (const g of groups) for (const h of g.hooks) {
    const script = /\$\{CLAUDE_PLUGIN_ROOT\}\/([^"]+)"/.exec(h.command)?.[1];
    if (!script || !existsSync(join(PLUGIN, script))) problems.push(`hooks/${cfg} ${event}: runs ${script ?? h.command}, which does not exist`);
  }
}
if (JSON.parse(readFileSync(join(PLUGIN, ".claude-plugin/plugin.json"), "utf8")).hooks !== "./hooks/claude.json") problems.push("plugin.json: Claude Code must load hooks/claude.json, the sage mode hook");

// pstack: its licence ships with the vendored files, every link between skills resolves, and an override whose
// upstream text changed since its review is reported (the weekly sync's pull request waits for a person then).
if (!existsSync(join(ROOT, "upstream/pstack/LICENSE"))) problems.push("upstream/pstack/LICENSE: missing; pstack's MIT licence must ship with its text");
for (const d of readdirSync(skillsDir)) {
  const f = join(skillsDir, d, "SKILL.md");
  if (!existsSync(f)) continue;
  for (const [, target] of readFileSync(f, "utf8").matchAll(/\]\(\.\.\/([a-z0-9-]+)\/SKILL\.md\)/g)) if (!existsSync(join(skillsDir, target, "SKILL.md"))) problems.push(`skills/${d}: links to ${target}, which does not ship`);
}
for (const o of overrides(ROOT)) {
  const now = existsSync(join(ROOT, "upstream/pstack", o.upstream)) ? fingerprint(readFileSync(join(ROOT, "upstream/pstack", o.upstream))) : undefined;
  if (now && now !== o.reviewed) console.warn(`! ${o.file}: pstack changed ${o.upstream} since this override's review (now ${now})`);
}

// The README's graphics are exactly what scripts/graphics.mjs draws, so nobody edits or adds an SVG by hand. Each text
// stays 7 px or more on a phone, where GitHub shows a graphic 324 px wide (the README column on a 390 px screen).
const drawn = new Map(graphics());
for (const [f, svg] of drawn) {
  const file = join(ROOT, "docs/assets", f);
  if (!existsSync(file) || readFileSync(file, "utf8") !== svg) problems.push(`docs/assets/${f}: out of date; run npm run graphics`);
  const width = +/viewBox="0 0 ([\d.]+)/.exec(svg)[1];
  const small = Math.min(...[...svg.matchAll(/font-size="([\d.]+)"/g)].map((m) => +m[1]));
  const PHONE = 324;
  if ((small * PHONE) / width < 7) problems.push(`docs/assets/${f}: a ${small} px text is ${((small * PHONE) / width).toFixed(1)} px on a phone; make it ${Math.ceil((7 * width) / PHONE)} px or more`);
}
for (const f of readdirSync(join(ROOT, "docs/assets")).filter((f) => f.endsWith(".svg") && !drawn.has(f))) problems.push(`docs/assets/${f}: scripts/graphics.mjs does not draw it; draw it there, or delete it`);
// A page of the README or the docs shows each graphic in the reader's theme, with an alt text, inside a link to the SVG's
// file page, so that a tap opens it. Not to the raw SVG ("?raw=true"): GitHub's in-page navigation fails on the redirect
// to it and shows "Error loading page". The <a> line stands alone: on the same line as <picture>, GitHub makes it a
// paragraph and drops the dark version.
const readme = readFileSync(join(ROOT, "README.md"), "utf8");
const pages = docFiles(ROOT).map((f) => [relative(dirname(join(ROOT, f)), join(ROOT, "docs/assets")).replace(/\\/g, "/"), readFileSync(join(ROOT, f), "utf8")]);
for (const name of new Set([...drawn.keys()].map((f) => f.replace(/-(light|dark)\.svg$/, "")))) {
  const shown = ([assets, text]) => {
    const svg = (theme) => `${assets.replace(/[.]/g, "\\.")}/${name}-${theme}\\.svg`;
    return new RegExp(`<a href="${svg("light")}">\\n<picture>\\n\\s*<source media="\\(prefers-color-scheme: dark\\)" srcset="${svg("dark")}">\\n\\s*<img alt="[^"]+" src="${svg("light")}"[^>]*>\\n</picture>\\n</a>\\n`).test(text);
  };
  if (!pages.some(shown)) problems.push(`docs/assets/${name}-light.svg: no page shows it; show it in the README or a docs page as <a href="<path>/${name}-light.svg">, then <picture> with its dark <source> and an <img> with alt text, each on its own line`);
}

// The README is a short front page, every relative link of the README and the docs resolves, and no paragraph of the
// README or the guide has more than 3 sentences (T381).
problems.push(...readmeProblems(readme), ...linkProblems(ROOT));
for (const f of docFiles(ROOT).filter((f) => f === "README.md" || f.startsWith("docs/guide/"))) problems.push(...paragraphProblems(f, readFileSync(join(ROOT, f), "utf8")));
// The board screenshots come from scripts/board-shots.mjs with its sample logbook: both files exist, and the record
// names the sample that they show. It compares no pixels, so a renderer change does not fail the check by itself.
for (const f of [...Object.values(SHOTS), SHOTS_RECORD]) if (!existsSync(join(ROOT, f))) problems.push(`${f}: missing; run node scripts/board-shots.mjs (see CONTRIBUTING.md)`);
if (existsSync(join(ROOT, SHOTS_RECORD)) && JSON.parse(readFileSync(join(ROOT, SHOTS_RECORD), "utf8")).sample !== sampleHash()) problems.push(`${SHOTS_RECORD}: the sample logbook changed after the board screenshots; run node scripts/board-shots.mjs (see CONTRIBUTING.md)`);

// sage's words (writing/dictionary.md): no flagged word in the text that a person reads. The generated skills are left
// out: their words come from the principles, pstack and the dictionary itself. Code is left out too: its names stay.
let dictionary;
try { dictionary = checkWords(parseSource(readFileSync(join(ROOT, "writing/dictionary.md"), "utf8"), "writing/dictionary.md").body); } catch (e) { problems.push(e.message); }
const readByPeople = [
  ...agents.map((f) => `plugins/sage/agents/${f}`),
  ...readdirSync(skillsDir).map((d) => `plugins/sage/skills/${d}/SKILL.md`).filter((f) => existsSync(join(ROOT, f)) && !readFileSync(join(ROOT, f), "utf8").includes(GENERATED)),
  // The README and the docs: every page that docFiles reads for links, except the internal Codex probe notes.
  ...docFiles(ROOT).filter((f) => !f.startsWith("docs/verification/")),
  // The change log fragments, which CHANGELOG.md on main gets only later: so the task pull request that adds one fails.
  ...readdirSync(join(ROOT, "changes")).filter((f) => f.endsWith(".md")).map((f) => `changes/${f}`),
  ...["packages/sage-codex/runtime", "plugins/sage-codex/runtime"].flatMap(root =>
    ["automatic-workflow-design.md", "claude-parity-audit.md"].map(name => `${root}/${name}`)),
  ...readdirSync(join(ROOT, "docs/assets")).filter((f) => f.endsWith(".svg")).map((f) => `docs/assets/${f}`),
];
for (const f of dictionary ? readByPeople : []) {
  const text = readFileSync(join(ROOT, f), "utf8");
  // The principles table is generated from the principles, like the generated skills that this check leaves out.
  const found = flaggedWords(f === PRINCIPLES_PAGE ? withoutPrinciplesTable(text) : text, dictionary, { html: !f.endsWith(".md") });
  // A graphic's text comes from scripts/graphics.mjs, and nobody edits an SVG by hand.
  for (const h of found) problems.push(`${f}:${h.line}: "${h.word}" is a flagged word${h.use.length ? `; say ${h.use.join(" or ")}` : ""} (writing/dictionary.md)${f.startsWith("docs/assets/") ? "; fix it in scripts/graphics.mjs, then run npm run graphics" : ""}`);
}

let expected;
try {
  expected = outputs();
  for (const [rel, text] of expected) {
    const f = join(ROOT, rel);
    if (!existsSync(f) || readFileSync(f, "utf8") !== text) problems.push(`${rel}: out of date; run npm run build`);
  }
} catch (e) { problems.push(String(e.message)); } // a source that the build cannot read, such as a README without its markers

// T539: CHANGELOG.md is built on main only, so that two task pull requests never conflict in it. The diff of this
// checkout from its merge base with origin/main tells the two kinds of pull request apart: a diff that touches
// CHANGELOG.md must touch nothing else (a change-log pull request) and hold exactly the build of changes/; any
// other diff leaves CHANGELOG.md as main has it, which may lag behind changes/ (a warning, not a failure).
// A copy with no .git (a test fixture) has no diff to read, so only the build of changes/ is checked there.
try {
  const git = (...args) => spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
  const base = existsSync(join(ROOT, ".git")) ? git("merge-base", "origin/main", "HEAD") : null;
  if (base?.status) problems.push("CHANGELOG.md: no merge base with origin/main, so the check cannot see what this branch changes; run git fetch origin main (in CI, check out with fetch-depth: 0)");
  // The tracked files only, committed, staged or changed, as CI sees them: a stray new file does not change the kind.
  const touched = base?.status === 0 ? git("diff", "--name-only", base.stdout.trim()).stdout.split("\n").filter(Boolean) : [];
  if (touched.includes("CHANGELOG.md") && touched.length > 1) problems.push(`CHANGELOG.md: a task pull request carries only its changes/<task>.md and leaves CHANGELOG.md as main has it; put your text in changes/<task>.md and undo the edit of CHANGELOG.md (git fetch origin main, then git checkout ${base.stdout.trim()} -- CHANGELOG.md). The chief rebuilds it on main with npm run changelog, in a change-log pull request that changes only CHANGELOG.md`);
  else {
    const built = changelog(ROOT), current = readFileSync(join(ROOT, "CHANGELOG.md"), "utf8");
    if (touched.includes("CHANGELOG.md") && current !== built) problems.push("CHANGELOG.md: a change-log pull request holds exactly the build of changes/; run npm run changelog");
    else if (base && current !== built) console.warn("! CHANGELOG.md lags behind changes/ (allowed on main and on a task branch); the chief rebuilds it with npm run changelog in a change-log pull request");
  }
  // Each fragment's links resolve as from CHANGELOG.md, where they go, so the task pull request that adds a fragment fails.
  for (const f of readdirSync(join(ROOT, "changes")).filter((f) => f.endsWith(".md"))) {
    const text = readFileSync(join(ROOT, "changes", f), "utf8");
    problems.push(...linkProblems(ROOT, ["CHANGELOG.md"], () => text).map((p) => p.replace(/^CHANGELOG\.md:/, `changes/${f}:`)));
  }
} catch (e) { problems.push(String(e.message)); } // a fragment that the build cannot place, or a line written by hand
const core = readFileSync(join(ROOT, "instructions/core.md"), "utf8");
if (Buffer.byteLength(core) > 8 * 1024) problems.push(`instructions/core.md: ${Buffer.byteLength(core)} bytes; keep it under 8 KiB (it loads into every session, so each byte costs context there)`);

// T494: the chief in Codex must get every rule. Codex counts hook context at 4 bytes a token
// (codex-rs utils/string/src/truncate.rs) and cuts a text above the hook's limit (hooks/src/output_spill.rs).
try {
  const codexHooks = JSON.parse(readFileSync(join(ROOT, "plugins/sage-codex/hooks/hooks.json"), "utf8")).hooks;
  const tokens = Math.min(...["UserPromptSubmit", "SessionStart"].flatMap((e) => codexHooks[e].flatMap((g) => g.hooks))
    .filter((h) => h.command.endsWith('/hooks/sage-codex-hook.mjs"')).map((h) => h.additionalContextLimit ?? 2500));
  const limit = tokens * 4;
  const role = Buffer.byteLength(codexModeHook({ hook_event_name: "UserPromptSubmit", session_id: "check", prompt: "sage mode" }, {}).hookSpecificOutput.additionalContext);
  if (role > limit) problems.push(`Codex chief role: the sage hook gives ${role} bytes, ${role - limit} bytes over its limit of ${limit} bytes (0 bytes left; additionalContextLimit ${tokens} tokens at 4 bytes each, in packages/sage-codex/hooks/hooks.json), so Codex would cut the rules. Shorten the chief text (packages/sage-core/roles/chief-of-staff.md) or raise the limit`);
  chiefInstructionParts();
} catch (e) { problems.push(`Codex chief role: ${e.message} (packages/sage-core/roles/chief-of-staff.md)`); }

// A test must not hold wall-clock or CPU time under a tight fixed bound: load and machine differences can fail a
// correct test (T53, T188). A name takes the clock when it is set from a clock reading or from a
// name that took it, or when it is a function that returns one. A lower bound may stay: a busy machine only adds time.
const CLOCK = String.raw`(?:(?:Date\.now|performance\.now|process\.hrtime(?:\.bigint)?)\(\)|process\.cpuUsage\([^)]*\))`;
const FIX = 'assert CPU time (process.cpuUsage) as a ratio between two sizes with a generous bound, an order of events or a flag (for example: the lock holder still holds when the command returns), or a count. If none can, end the line with "// timing-ok: <reason>"';
let timingOk = 0;
// Every test source: each test file and each file of scripts/ that a test file imports, such as sage-hook-tests.mjs,
// which the six sage-hook-<n>.test.mjs parts run (F-T289-61).
const testFiles = readdirSync(join(ROOT, "scripts")).filter((f) => f.endsWith(".test.mjs"));
const imported = testFiles.flatMap((f) => [...readFileSync(join(ROOT, "scripts", f), "utf8").matchAll(/["']\.\/([\w.-]+\.mjs)["']/g)].map((m) => m[1]));
for (const f of [...new Set([...testFiles, ...imported])].filter((f) => existsSync(join(ROOT, "scripts", f)))) {
  const lines = readFileSync(join(ROOT, "scripts", f), "utf8").split("\n").map((l) => l.replace(/(["'`])(?:\\.|(?!\1)[^\\])*\1/g, '""').replace(/(^|\s)\/\/(?! timing-ok:).*$/, "$1")); // no strings, no comments
  const clocked = new Set();
  const takes = (text) => new RegExp(`${CLOCK}${clocked.size ? `|(?<![\\w$.])(?:${[...clocked].join("|")})(?![\\w$])` : ""}`).test(text);
  for (let before = -1; before !== clocked.size; ) {
    before = clocked.size;
    let fn;
    for (const line of lines) {
      // The function that a return line is in: the last one that a line named, or none after an unnamed one.
      const named = /(?:function\s+([\w$]+)|([\w$]+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[\w$]+)\s*=>)/.exec(line)?.slice(1).find(Boolean);
      fn = named ?? (/=>\s*\{|function\s*\(/.test(line) ? undefined : fn);
      const set = /(\[[^\]]*\]|\{[^}]*\}|[\w$]+)\s*=(?![=>])([^;]*)/.exec(line);
      if (set && takes(set[2])) for (const name of set[1].match(/[\w$]+/g)) clocked.add(name);
      if (fn && /\breturn\b/.test(line) && takes(line.replace(/^.*?\breturn\b/, ""))) clocked.add(fn);
    }
  }
  const term = `(?:${CLOCK}${clocked.size ? `|(?<![\\w$.])(?:${[...clocked].join("|")})(?![\\w$])` : ""})`;
  // The number must be the complete bound: `big < 30 * small` is a ratio, not a fixed cap.
  const number = String.raw`[\d_.]+`;
  const under = new RegExp(`${term}[^<>&|,;?]*?<=?\\s*${number}\\s*(?=[),;]|&&|\\|\\||$)|(?:^|[,(;]|&&|\\|\\|)\\s*${number}\\s*>=?[^<>&|,;?]*?${term}[^<>&|,;?]*`, "g");
  const ratio = new RegExp(`/\\s*\\(*\\s*${term}`); // divide by another measured size, not by a unit such as 1000
  lines.forEach((line, i) => {
    const comparisons = [...line.replace(/\/\/ timing-ok:.*$/, "").matchAll(under)];
    if (!comparisons.some(([comparison]) => !ratio.test(comparison))) return;
    if (/\/\/ timing-ok: \S/.test(line)) timingOk++;
    else problems.push(`scripts/${f}:${i + 1}: a test holds a wall-clock or CPU time under a fixed number, so a busy machine can break it. Instead, ${FIX}.`);
  });
}

// Each test file in scripts/ runs in CI: npm test or npm run test:browser names it (R1534-3).
{
  const { scripts } = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const named = new Set(`${scripts.test} ${scripts["test:browser"]}`.split(/\s+/));
  for (const f of readdirSync(join(ROOT, "scripts"))) if (f.endsWith(".test.mjs") && !named.has(`scripts/${f}`)) problems.push(`scripts/${f}: no test command runs it; add it to "test" or "test:browser" in package.json`);
}

// Provider build outputs must be exact, including the absence of obsolete or foreign files.
for (const dir of ["plugins/sage", "plugins/sage-codex"]) {
  for (const file of filesUnder(join(ROOT, dir))) {
    const rel = file.slice(ROOT.length + 1);
    if (expected && !expected.has(rel)) problems.push(`${rel}: not in the package; run npm run build`);
  }
}

// The build reads the dictionary too, so a problem in it comes twice: report it once.
if (problems.length) { console.error([...new Set(problems)].map((p) => `✗ ${p}`).join("\n")); process.exit(1); }
console.log(`✓ all checks pass (${timingOk} timing ${timingOk === 1 ? "bound carries" : "bounds carry"} "// timing-ok:")`);
