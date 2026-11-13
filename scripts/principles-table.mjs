import { PRINCIPLES_PAGE, withBlock } from "./dictionary.mjs";

export const PRINCIPLES_START = "<!-- The principles table comes from principles/: edit them there, then run npm run build. -->";
export const PRINCIPLES_END = "<!-- The end of the principles table. -->";

const PSTACK = "from pstack", OWN = "sage's own";
const cell = (s) => s.replace(/\|/g, "\\|");

export function principleRows(principles) {
  return principles
    .map((p) => ({ id: p.id, applyWhen: p.applyWhen.replace(/\.$/, ""), text: /^pstack /.test(p.source) ? PSTACK : OWN }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

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
    ...rows.map((r) => `| ${r.id}<br>*${r.text}* | ${cell(r.applyWhen)} |`),
    "",
    "Under each name, a note says where its text comes from:",
    "",
    `- "${PSTACK}" is sage's text of a pstack principle, in sage's writing standard. Its status against pstack's latest text is in the [baseline](#baseline-against-pstack) below. Its \`source\` line names the pstack version and commit that its text was checked against.`,
    `- "${OWN}" has no pstack source.`,
    "",
    "</details>",
  ].join("\n");
}

export function withoutPrinciplesTable(readme) {
  const i = readme.indexOf(PRINCIPLES_START), j = readme.indexOf(PRINCIPLES_END);
  return i < 0 || j < i ? readme : readme.slice(0, i) + readme.slice(i, j).replace(/[^\n]/g, " ") + readme.slice(j);
}

export const withPrinciplesTable = (page, list) => withBlock(page, PRINCIPLES_START, PRINCIPLES_END, list, "the principles table", PRINCIPLES_PAGE);
