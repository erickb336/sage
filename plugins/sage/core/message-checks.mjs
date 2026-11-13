import { createHash } from "node:crypto";
import { CHIEF } from "./chiefs.mjs";
import { KINDS, INCIDENT_STATUS, LONG_WIDTH, TREE, WIDTH, messageText, partsOf, pictureProblems, prepareMessage } from "./message.mjs";
import { PAGE_POLICY, messagePage } from "./message-page.mjs";
import { GATE_ID, MILESTONE_ID, TASK_ID } from "./milestone-rules.mjs";
import { PR } from "./pull-request.mjs";
import { pictureSvg } from "./picture.mjs";

const bare = (re) => re.source.replace(/^\^|\$$/g, "");
const PRODUCT = String.raw`(?!\s+(?:Mac|MacBook|iMac|chips?|Pro|Max|Ultra|servers?|chords?)\b)`;
const RAW_ID = new RegExp(`(?<![\\w-])(?:${bare(TASK_ID)}|(?:${[MILESTONE_ID, GATE_ID, CHIEF].map(bare).join("|")})(?![\\w-])${PRODUCT}|R[1-9]\\d*|F-T[1-9]\\d*-[1-9]\\d*|PR ?#?${bare(PR)})(?![\\w-])`, "g");
const CODE_SPAN = /`(?:[^`\n]|\n(?!\s*\n))*`/g;
const HEADS = Object.entries(KINDS).map(([kind, k]) => [kind, k.head]);
const BOX_MARK = /[─-╿]/u;
const FENCE = /^\s*(`{3,}|~{3,})/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const SHOWN = 20;

export function kindOf(text) {
  const first = String(text).split("\n").find((l) => l.trim() && !RULE.test(l))?.trim().replace(/^#+\s*|\*\*/g, "") ?? "";
  const hit = HEADS.find(([, head]) => first === head || (head === "INCIDENT" && INCIDENT_STATUS.some((s) => first === `${head} · ${s}`)));
  return hit ? hit[0] : null;
}

function partsOfText(text) {
  const lines = String(text).split("\n"), out = { lines: [], pictures: [], code: [] };
  for (let i = 0; i < lines.length; i++) {
    if (/^\*\*sage board\*\*/.test(lines[i])) break;
    const open = FENCE.exec(lines[i]);
    if (!open) { out.lines.push(lines[i]); continue; }
    const body = [], titled = i > 0 && lines[i - 1].trim() !== "";
    for (i++; i < lines.length && !lines[i].trim().startsWith(open[1]); i++) body.push(lines[i]);
    (titled || body.some((l) => BOX_MARK.test(l)) ? out.pictures : out.code).push(body);
  }
  return out;
}

function ownWords(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^Ref:/.test(lines[i])) continue;
    if (/^Page · /.test(lines[i])) {
      while (i + 1 < lines.length && lines[i + 1].trim()) i++;
      continue;
    }
    out.push(lines[i]);
  }
  return out;
}

const labelAt = (line, label) => {
  const l = line.trim().replace(/^#+\s*|\*\*/g, "").replace(/^- /, "");
  return l === label || l.startsWith(`${label}:`);
};

export const textProblems = (text, options) => namedProblems(text, options).problems.map(([, problem]) => problem);

function namedProblems(text, { width = WIDTH } = {}) {
  const kind = kindOf(text);
  if (!kind) return { kind, problems: [] };
  const { lines, pictures } = partsOfText(text), problems = [];
  pictures.forEach((pic, k) => { for (const p of pictureProblems(pic, width)) problems.push(["picture", `picture ${k + 1}: ${p}`]); });
  if (lines.some((l) => TREE.test(l))) problems.push(["tree marks", "the message has tree marks (├ └ ┬ ┴ ┼ ┤ ┌ ┐ ┘): draw boxes inside boxes, or write a list"]);
  const ids = [...new Set([ownWords(lines).join("\n").replace(CODE_SPAN, ""), ...pictures.flat()].flatMap((l) => [...l.matchAll(RAW_ID)].map((m) => m[0])))];
  const some = ids.length > SHOWN ? `${ids.slice(0, SHOWN).join(", ")} and ${ids.length - SHOWN} more` : ids.join(", ");
  if (ids.length) problems.push(["raw ids", `raw ids in the message: ${some}. Name the work in words; put its ids in the Ref line`]);
  if (lines.some((l) => /^Main point:/.test(l)) && lines.some((l) => /^Page · /.test(l))) return { kind, problems };
  let at = 0;
  for (const part of partsOf(kind).filter((p) => p.need)) {
    if (!/^[A-Z]/.test(part.name)) {
      if (part.name === "picture" && !pictures.length) problems.push(["missing picture", `a ${kind} needs a picture, in a fenced block`]);
      continue;
    }
    const found = lines.findIndex((l, i) => i >= at && labelAt(l, part.name));
    if (found >= 0) at = found + 1;
    else if (lines.some((l) => labelAt(l, part.name))) problems.push([`out of order: ${part.name}`, `"${part.name}" is out of order in a ${kind}`]);
    else problems.push([`missing: ${part.name}`, `a ${kind} needs "${part.name}"`]);
  }
  if (KINDS[kind].pick && !/\(my\s+pick\)/i.test(text)) problems.push(["no pick", `a ${kind} marks your pick with "(my pick)"`]);
  const bold = (l, name) => l.trim().replace(/:?(\*\*):?$/, "$1") === `**${name}**`;
  for (const part of partsOf(kind).filter((p) => /^[A-Z]/.test(p.name))) {
    const label = lines.find((l) => labelAt(l, part.name) && !/^#{1,6} /.test(l));
    if (label === undefined) continue;
    problems.push(bold(label, part.name)
      ? [`bold label: ${part.name}`, `"${part.name}" is a bold line: use a ### heading, with its text under it`]
      : [`inline label: ${part.name}`, `"${part.name}" is in the line: use a ### heading on its own line, with its text under it`]);
  }
  const answersRow = (l) => TABLE_ROW.test(l) && (/\(my\s+pick\)/i.test(l) || l.split("|")[1].trim().replace(/\*\*/g, "") === KINDS[kind].tableHead[0]);
  if (KINDS[kind].pick && lines.some(answersRow)) problems.push(["table", `a ${kind} gives its answers as a numbered list, not a table: put what happens next and the cost under each answer`]);
  return { kind, problems };
}

export function messageMiss(text) {
  const { kind, problems } = namedProblems(text);
  if (!problems.length) return undefined;
  const more = problems.length - SHOWN;
  return {
    kind,
    names: [...new Set(problems.map(([name]) => name))],
    note: [`sage: your last message names the kind "${kind}" on its first line, but it misses the shape of that kind:`,
      ...problems.slice(0, SHOWN).map(([, problem]) => `- ${problem}`),
      ...(more > 0 ? [`- and ${more} more`] : []),
      "Fix this in your next message of that kind: the presentation skill gives each kind's parts, and sage's message command prints a message in its kind's shape."].join("\n"),
  };
}

const unescape = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
const LOADS = /\s(?:src|srcset|href|action|formaction|poster|data|xlink:href|background)\s*=|^<(?:link|iframe|object|embed|img|image|use|base|frame|audio|video|source|track|form)\b/i;
const EVENT = /\son[a-z]+\s*=/i, REFRESH = /^<meta\s+http-equiv="refresh"/i;
const withoutValues = (tag) => tag.replace(/"[^"]*"|'[^']*'/g, '""');

export function pageProblems(html) {
  const problems = [];
  const tags = String(html).match(/<[a-z][^>]*>/gi) ?? [], styles = (html.match(/<style\b[^>]*>([\s\S]*?)<\/style>/gi) ?? []).join("");
  const loads = [...tags.filter((t) => LOADS.test(withoutValues(t)) || REFRESH.test(t)), ...(/@import|url\(/i.test(styles) ? ["a style that loads a file"] : [])];
  if (loads.length) problems.push(`the page loads from outside itself: ${[...new Set(loads)].join(", ")}`);
  const policy = /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/.exec(html)?.[1];
  if (policy !== PAGE_POLICY) problems.push("the page's Content-Security-Policy is not sage's: nothing loads, and only the page's own style and its one script run");
  const scripts = tags.filter((t) => /^<script\b/i.test(t)).length, sheets = tags.filter((t) => /^<style\b/i.test(t)).length;
  if (scripts > 1 || sheets > 1) problems.push(`the page has ${scripts} scripts and ${sheets} styles: at most one of each, the ones that its policy names`);
  if (tags.some((t) => EVENT.test(withoutValues(t)))) problems.push("the page has an event attribute (on…=): its one script is the only code");
  const text = /<details class="text-form"><summary>[^<]*<\/summary><pre>([\s\S]*?)<\/pre><\/details>/.exec(html)?.[1];
  if (text === undefined) return [...problems, "the page has no plain-text form of its message, so no image can be checked against its text"];
  const plain = unescape(text), wide = /<main class="long">/.test(html);
  for (const p of textProblems(plain, { width: wide ? LONG_WIDTH : WIDTH })) problems.push(`the text form: ${p}`);
  const drawn = new Set(partsOfText(plain).pictures.map((lines) => pictureSvg(lines).replace(/ aria-label="[^"]*"/, "")));
  const images = [...html.matchAll(/<svg class="pic"[\s\S]*?<\/svg>/g)].map((m) => m[0].replace(/ aria-label="[^"]*"/, ""));
  const strays = images.filter((svg) => !drawn.has(svg)).length;
  if (strays) problems.push(`${strays} of the page's ${images.length} images are not drawn from a picture of its text form`);
  if (images.length < drawn.size) problems.push("a picture of the text form has no image on the page");
  return problems;
}

export function renderMessage(input, { pagePath = (name) => name, pageUrl = () => undefined } = {}) {
  const { problems, msg, width } = prepareMessage(input);
  if (problems.length) return { problems };
  const pictured = msg.long !== undefined || msg.blocks.some(function has(b) { return b.t === "picture" || b.t === "toggle" || (b.t === "section" && b.body.some(has)); });
  const name = `${msg.kind.replace(/ /g, "-")}-${createHash("sha256").update(JSON.stringify(msg)).digest("hex").slice(0, 8)}.html`;
  const page = pictured ? { title: msg.title, url: pageUrl(name), path: pagePath(name), name } : undefined;
  const text = messageText(msg, { width, page });
  const html = page && messagePage(msg, messageText(msg, { width, full: true, today: true }));
  const found = [...textProblems(text), ...(html ? pageProblems(html) : [])];
  return found.length ? { problems: found } : { text, page: page && { ...page, html } };
}
