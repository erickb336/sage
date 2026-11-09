// The principles page's list of principles comes from the files in principles/ (their applyWhen and source).
// scripts/build.mjs writes it, and `npm run check` fails on a page that differs.
import { PRINCIPLES_PAGE, withBlock } from "./dictionary.mjs";

export const PRINCIPLES_START = "<!-- The principles table comes from principles/: edit them there, then run npm run build. -->";
export const PRINCIPLES_END = "<!-- The end of the principles table. -->";

const ADAPTED = "pstack, adapted", OWN = "sage's own";
const cell = (s) => s.replace(/\|/g, "\\|");

/** One row for each principle, by id, from the files of principles/ ({ id, applyWhen, source }). */
export function principleRows(principles) {
  return principles
    .map((p) => ({ id: p.id, applyWhen: p.applyWhen.replace(/\.$/, ""), text: /^pstack /.test(p.source) ? ADAPTED : OWN }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** The README's text about the principles' count and origin, and the table of all of them. */
export function principlesTable(rows) {
  const own = rows.filter((r) => r.text === OWN).length;
  return [
    `There are ${rows.length} principles: ${rows.length - own} come from pstack, by Lauren Tan (MIT), and ${own} ${own === 1 ? "is" : "are"} sage's own. sage keeps its own text of each one. The baseline below compares each text with pstack's latest text.`,
    "",
    "<details>",
    `<summary><strong>All ${rows.length} principles</strong></summary>`,
    "",
    "| Principle | Apply when |",
    "| --- | --- |",
    ...rows.map((r) => `| ${r.id}<br>*${r.text}* | ${cell(r.applyWhen)} |`), // two columns, so that the table fits a phone
    "",
    "Under each name, a note says where its text comes from:",
    "",
    `- "${ADAPTED}" is sage's text of a pstack principle: it is shorter, and it follows sage's writing standard. Its \`source\` line names the pstack version and commit that its text was checked against.`,
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
