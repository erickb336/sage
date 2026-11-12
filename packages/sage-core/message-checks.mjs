// The pure checks of sage's messages (T984). textProblems reads the text form of a message, as the chat shows it, so a
// hook can run it on a message that the chief wrote by hand (T1004, T1005, in note mode). pageProblems reads a message's
// page. Each returns a list of problems, empty when the message passes.
import { createHash } from "node:crypto";
import { CHIEF } from "./chiefs.mjs";
import { KINDS, INCIDENT_STATUS, LONG_WIDTH, TREE, WIDTH, messageText, partsOf, pictureProblems, prepareMessage } from "./message.mjs";
import { PAGE_POLICY, messagePage } from "./message-page.mjs";
import { GATE_ID, MILESTONE_ID, TASK_ID } from "./milestone-rules.mjs";
import { PR } from "./pull-request.mjs";
import { pictureSvg } from "./picture.mjs";

// The ids of the state tool, in its own forms: a task, a milestone, a gate, a chief, a run, a finding's key and a pull
// request (PR 12). A message names work by its words; its ids go only in the Ref line. A milestone, gate or chief form
// that a product name follows is that product, not an id: "the M4 Mac", "an M2 chip", "a G5 server", "a C3 chord".
// Only these three forms, and only before these words, so that M12, G7 and C2 alone stay ids.
const bare = (re) => re.source.replace(/^\^|\$$/g, "");
const PRODUCT = String.raw`(?!\s+(?:Mac|MacBook|iMac|chips?|Pro|Max|Ultra|servers?|chords?)\b)`;
const RAW_ID = new RegExp(`(?<![\\w-])(?:${bare(TASK_ID)}|(?:${[MILESTONE_ID, GATE_ID, CHIEF].map(bare).join("|")})(?![\\w-])${PRODUCT}|R[1-9]\\d*|F-T[1-9]\\d*-[1-9]\\d*|PR ?#?${bare(PR)})(?![\\w-])`, "g");
// A code span: in one paragraph, and it may wrap onto the next line.
const CODE_SPAN = /`(?:[^`\n]|\n(?!\s*\n))*`/g;
const HEADS = Object.entries(KINDS).map(([kind, k]) => [kind, k.head]);
const BOX_MARK = /[─-╿]/u;
const FENCE = /^\s*(`{3,}|~{3,})/;

/** The kind that a text names on its first line (its head), or null. */
export function kindOf(text) {
  const first = String(text).split("\n").find((l) => l.trim())?.trim().replace(/^#+\s*|\*\*/g, "") ?? "";
  const hit = HEADS.find(([, head]) => first === head || (head === "INCIDENT" && INCIDENT_STATUS.some((s) => first === `${head} · ${s}`)));
  return hit ? hit[0] : null;
}

/**
 * The parts of a text: its fenced blocks, and its other lines. A fenced block is a picture when its fence comes right
 * under its title (the text form writes a picture so, and code after a blank line), or when it has box marks: a picture
 * may be only arrows, such as "Brief ▶ Run ▶ Report". The board's chat text, from its "**sage board**" line on, is not
 * the message's own text.
 */
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

/** The lines that may name ids: not the Ref line, nor a Page block (its first line, wrapped, and its path). */
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

/**
 * The problems of a message's text form: each picture over the width, a tree mark, a box that does not close, a raw id
 * outside the Ref line and the Page block, and a part of its kind that is missing or out of order. Only a message that
 * names its kind on its first line is checked: a message with no kind gives no problem.
 */
export const textProblems = (text, options) => namedProblems(text, options).problems.map(([, problem]) => problem);

/**
 * The kind of a text and its problems, each as [name, text]. A name has no word of the message, only words of sage's
 * checks and of the kind's parts, so that a count of the misses keeps no message text.
 */
function namedProblems(text, { width = WIDTH } = {}) {
  const kind = kindOf(text);
  if (!kind) return { kind, problems: [] };
  const { lines, pictures } = partsOfText(text), problems = [];
  pictures.forEach((pic, k) => problems.push(...pictureProblems(pic, width).map((p) => ["picture", `picture ${k + 1}: ${p}`])));
  if (lines.some((l) => TREE.test(l))) problems.push(["tree marks", "the message has tree marks (├ └ ┬ ┴ ┼ ┤ ┌ ┐ ┘): draw boxes inside boxes, or write a list"]);
  // A word in code is not an id: the text form keeps each code span's marks.
  const ids = [...new Set([ownWords(lines).join("\n").replace(CODE_SPAN, ""), ...pictures.flat()].flatMap((l) => [...l.matchAll(RAW_ID)].map((m) => m[0])))];
  if (ids.length) problems.push(["raw ids", `raw ids in the message: ${ids.join(", ")}. Name the work in words; put its ids in the Ref line`]);
  // The parts, in order: each labelled part that the kind needs, at the start of a line. A long message gives its main
  // point and its Page block: its parts are on its page.
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
  return { kind, problems };
}

/**
 * The check of a message that the chief wrote by hand, for a hook in note mode (T1004, T1005): undefined when the text
 * names no kind or fits its kind's shape, else { kind, names, note }. names are the problems' names, with no word of
 * the message, for the count of the misses. note is the line for the chief at its next prompt: the kind, and each problem.
 */
export function messageMiss(text) {
  const { kind, problems } = namedProblems(text);
  if (!problems.length) return undefined;
  return {
    kind,
    names: [...new Set(problems.map(([name]) => name))],
    note: [`sage: your last message names the kind "${kind}" on its first line, but it misses the shape of that kind:`,
      ...problems.map(([, problem]) => `- ${problem}`),
      "Fix this in your next message of that kind: the presentation skill gives each kind's parts, and sage's message command prints a message in its kind's shape."].join("\n"),
  };
}

const unescape = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
// LOADS and EVENT read a tag without its quoted values: a value is escaped text, such as a picture's title in its
// aria-label ("Where data = truth"), not an attribute. REFRESH reads the whole tag.
const LOADS = /\s(?:src|srcset|href|action|formaction|poster|data|xlink:href|background)\s*=|^<(?:link|iframe|object|embed|img|image|use|base|frame|audio|video|source|track|form)\b/i;
const EVENT = /\son[a-z]+\s*=/i, REFRESH = /^<meta\s+http-equiv="refresh"/i;
const withoutValues = (tag) => tag.replace(/"[^"]*"|'[^']*'/g, '""');

/**
 * The problems of a message's page: a load from outside the page, a policy other than sage's (each script and style
 * must match its hash), an image that is not drawn from a picture of the page's own text form, and the faults of that
 * text form. The text form is the page's "same message as plain text" block, at 66 columns on a long page.
 */
export function pageProblems(html) {
  const problems = [];
  // A tag is markup: the page escapes every text, so a "<" in the page starts a real tag.
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
  problems.push(...textProblems(plain, { width: wide ? LONG_WIDTH : WIDTH }).map((p) => `the text form: ${p}`));
  // Each image must be the one that pictureSvg draws from a picture of the text form, character for character.
  const drawn = new Set(partsOfText(plain).pictures.map((lines) => pictureSvg(lines).replace(/ aria-label="[^"]*"/, "")));
  const images = [...html.matchAll(/<svg class="pic"[\s\S]*?<\/svg>/g)].map((m) => m[0].replace(/ aria-label="[^"]*"/, ""));
  const strays = images.filter((svg) => !drawn.has(svg)).length;
  if (strays) problems.push(`${strays} of the page's ${images.length} images are not drawn from a picture of its text form`);
  if (images.length < drawn.size) problems.push("a picture of the text form has no image on the page");
  return problems;
}

/**
 * A message from its JSON, as the state tool's message command gives it: the text for the chat and, for a message with
 * a picture or a long message, its page. pagePath(name) gives the path of the page with that file name, and pageUrl(name)
 * the board's link to it. A message that fails
 * its shape or its checks gives only its problems, so that no message reaches the owner in another shape.
 */
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
