// The README's list of principles comes from the principles themselves: the files in principles/ (their applyWhen and
// source) and pstack's other principles in upstream/pstack/ (their description). scripts/build.mjs writes it, so a
// pstack sync followed by the build gives each new pstack principle its row, and `npm run check` fails on a README
// that differs.
import { PRINCIPLES_PAGE, withBlock } from "./dictionary.mjs";

export const PRINCIPLES_START = "<!-- The principles table comes from principles/ and upstream/pstack/: edit them there, then run npm run build. -->";
export const PRINCIPLES_END = "<!-- The end of the principles table. -->";

const ADAPTED = "pstack, adapted", AS_IS = "pstack", OWN = "sage's own";
const cell = (s) => s.replace(/\|/g, "\\|");

/** One row for each principle, by id. `own` holds the files of principles/ ({ id, applyWhen, source }); `upstream`
 * holds pstack's principles that no file overrides ({ id, description }), whose first sentence says when it applies. */
export function principleRows(own, upstream) {
  return [
    ...own.map((p) => ({ id: p.id, applyWhen: p.applyWhen.replace(/\.$/, ""), text: /^pstack /.test(p.source) ? ADAPTED : OWN })),
    ...upstream.map((u) => ({ id: u.id, applyWhen: u.description.split(/(?<=\.)\s/)[0].replace(/^Apply (?:when |to )?/, "").replace(/\.$/, ""), text: AS_IS })),
  ].sort((a, b) => a.id.localeCompare(b.id));
}

/** The README's text about the principles' count and origin, and the table of all of them. */
export function principlesTable(rows) {
  const own = rows.filter((r) => r.text === OWN).length;
  return [
    `There are ${rows.length} principles: ${rows.length - own} are pstack's, by Lauren Tan (MIT), and ${own} ${own === 1 ? "is" : "are"} sage's own. Where sage has an adapted version of a pstack principle, sage uses it.`,
    "",
    "<details>",
    `<summary><strong>All ${rows.length} principles</strong></summary>`,
    "",
    "| Principle | Apply when | Text |",
    "| --- | --- | --- |",
    ...rows.map((r) => `| ${r.id} | ${cell(r.applyWhen)} | ${r.text} |`),
    "",
    "Every principle except sage's own is pstack's, by Lauren Tan (MIT). The Text column has three values:",
    "",
    `- "${AS_IS}" is pstack's text as it is, from \`upstream/pstack/\`.`,
    `- "${ADAPTED}" means that sage changed the wording: it is shorter, and it follows sage's writing standard. Its \`upstream:\` fingerprint records which pstack text it was checked against.`,
    `- "${OWN}" has no pstack source.`,
    "",
    "</details>",
  ].join("\n");
}

/** The README with its principles table blanked, line breaks kept, for the word check: the table quotes the principles'
 * own words, as the generated skills do, and the build rewrites any hand edit of it. */
export function withoutPrinciplesTable(readme) {
  const i = readme.indexOf(PRINCIPLES_START), j = readme.indexOf(PRINCIPLES_END);
  return i < 0 || j < i ? readme : readme.slice(0, i) + readme.slice(i, j).replace(/[^\n]/g, " ") + readme.slice(j);
}

/** The README with its principles table replaced by a new one. */
export const withPrinciplesTable = (page, list) => withBlock(page, PRINCIPLES_START, PRINCIPLES_END, list, "the principles table", PRINCIPLES_PAGE);
