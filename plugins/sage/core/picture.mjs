// Pictures in sage's messages (T984). A picture is fixed-width text first: lines of at most 46 columns (66 on a long
// page), with sage's box rules. The image is drawn from the same lines, so the two forms cannot differ (T999).
//   Boxes: rounded ╭ ╮ ╰ ╯ for a part, double ╔ ╗ ╚ ╝ for the part in focus, dashed ┄ ┆ for a group.
//   Arrows: a line (│ ─) with one head (▼ ▲ ▶ ◀). ● is a start, ━ a bar. No tree marks (├ └ ┬ ┴ ┼).
// Pure functions: no file access.
import { createHash } from "node:crypto";

/** East Asian wide and full-width code points take two columns in a terminal; box marks count one (F7: a known limit). */
const wide = (cp) => (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff)
  || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1faff);
/** The columns that a terminal gives a line. */
export const columns = (s) => [...String(s)].reduce((n, ch) => n + (wide(ch.codePointAt(0)) ? 2 : 1), 0);
const padTo = (s, n) => s + " ".repeat(Math.max(0, n - columns(s)));
export const escapeHtml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
/** The source mark of a picture: the first 16 hex of the sha256 of its lines. */
export const sourceOf = (lines) => createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 16);

/** Wrap words to a width. A word longer than the width stays whole on its own line. */
export function wrap(text, width) {
  const out = [];
  for (const para of String(text).split("\n")) {
    let line = "";
    for (const word of para.split(/ +/)) {
      if (!word) continue;
      if (!line) line = word;
      else if (columns(line) + 1 + columns(word) <= width) line += ` ${word}`;
      else { out.push(line); line = word; }
    }
    out.push(line);
  }
  return out;
}

const STYLES = { round: "╭╮╰╯─│", double: "╔╗╚╝═║", dashed: "╭╮╰╯┄┆" };

/**
 * A box of exactly w columns, with its title on the top edge. Each item is a text (wrapped to the inside) or an array of
 * rows that goes in as it is (a nested box). Throws a plain message when a title or a row does not fit.
 */
export function box({ w, title = "", lines = [], style = "round" }) {
  const [tl, tr, bl, br, h, v] = [...STYLES[style]];
  const inner = w - 4;
  const top = title ? `${tl}${h} ${title} ` : tl;
  if (columns(top) > w - 1) throw new Error(`the box title "${title}" is too long for a box of ${w} columns: shorten it to ${w - 6} columns or fewer`);
  const out = [top + h.repeat(w - 1 - columns(top)) + tr];
  for (const item of lines) {
    for (const row of Array.isArray(item) ? item : wrap(item, inner)) {
      if (columns(row) > inner) throw new Error(`"${row}" is too wide for a box of ${w} columns: at most ${inner} columns inside`);
      out.push(`${v} ${padTo(row, inner)} ${v}`);
    }
  }
  out.push(bl + h.repeat(w - 2) + br);
  return out;
}

// ---------------------------------------------------------------- reading the text: the boxes

const TL = "╭╔", TR = "╮╗", BL = "╰╚", BR = "╯╝", CORNERS = TL + TR + BL + BR;
const HEDGE = "─┄═", VEDGE = "│┆║";
const CROSS_H = "│┆▼▲"; // a vertical connector that crosses a top or bottom edge
const CROSS_V = "─┄▶◀"; // a horizontal connector that crosses a side edge
const CONNECT = "│─┆┄╭╮╰╯▼▲▶◀●━";
const BOX_MARKS = /[─-╿]/u;
/** The six state words (T1002), as a box's first line starts with them, and the class that colours them. */
const STATE_CLASS = [["Not started", "st-not"], ["Waiting", "st-wait"], ["Needs you", "st-need"], ["In progress", "st-prog"], ["Done", "st-done"], ["Stopped", "st-stop"]];

const grid = (lines) => {
  const W = Math.max(0, ...lines.map((l) => [...l].length));
  return { W, H: lines.length, g: lines.map((l) => [...l, ...Array(W - [...l].length).fill(" ")]) };
};

function findBoxes({ g, W, H }) {
  const boxes = [];
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
    if (!TL.includes(g[r][c])) continue;
    let c2 = c + 1;
    while (c2 < W && !CORNERS.includes(g[r][c2])) c2++;
    if (c2 >= W || !TR.includes(g[r][c2])) continue;
    let rb = r + 1;
    while (rb < H && (VEDGE.includes(g[rb][c]) || CROSS_V.includes(g[rb][c]))) rb++;
    if (rb >= H || !BL.includes(g[rb][c]) || !BR.includes(g[rb][c2])) continue;
    let ok = true;
    for (let rr = r + 1; rr < rb && ok; rr++) ok = VEDGE.includes(g[rr][c2]) || CROSS_V.includes(g[rr][c2]);
    for (let cc = c + 1; cc < c2 && ok; cc++) ok = HEDGE.includes(g[rb][cc]) || CROSS_H.includes(g[rb][cc]);
    if (!ok) continue;
    const top = g[r].slice(c + 1, c2);
    const style = g[r][c] === "╔" ? "double" : top.includes("┄") || g[r + 1][c] === "┆" ? "dashed" : "round";
    const label = top.map((ch) => (HEDGE.includes(ch) || CROSS_H.includes(ch) ? " " : ch)).join("");
    boxes.push({ r, c, rb, c2, style, label: label.trim(), labelCol: label.trim() ? c + 1 + label.search(/\S/) : -1 });
  }
  return boxes;
}

/**
 * The boxes that do not close, by row and column (1-based), so that an agent who draws a picture by hand can fix it (C6).
 * A corner that starts a top edge of two or more marks, or a title, must start a whole box. A lone ╭ or ╰ is a curve.
 */
export function openBoxes(lines) {
  const at = grid(lines), boxes = findBoxes(at), problems = [];
  for (let r = 0; r < at.H; r++) for (let c = 0; c < at.W; c++) {
    if (!TL.includes(at.g[r][c]) || boxes.some((b) => b.r === r && b.c === c)) continue;
    const next = at.g[r].slice(c + 1, c + 3).join("");
    if (/^[─┄═]{2}$/.test(next) || /^[─┄═] $/.test(next)) problems.push(`the box that starts at line ${r + 1}, column ${c + 1} does not close: each corner needs its edge and the three other corners`);
  }
  return problems;
}

// ---------------------------------------------------------------- the image: SVG from the text

const CW = 9, CH = 19; // one cell, in SVG units
const DIGITLESS_TAG = /\[(new|was: [^\]]+)\]/g;

/**
 * The SVG of a text picture. The lines are its only source: boxes become rectangles, connectors lines and heads, and
 * every other character text at its own column. A mark that the reader does not understand (a corner of a box that
 * does not close) stays as fixed-width text in its cell, so the image loses nothing of the text (C6).
 */
export function pictureSvg(lines, { title = "" } = {}) {
  const at = grid(lines), { g, W, H } = at;
  const used = g.map((row) => row.map(() => false));
  const boxes = findBoxes(at);
  for (const b of boxes) {
    for (let cc = b.c; cc <= b.c2; cc++) for (const rr of [b.r, b.rb]) if (!CROSS_H.includes(g[rr][cc])) used[rr][cc] = true;
    for (let rr = b.r; rr <= b.rb; rr++) for (const cc of [b.c, b.c2]) if (!CROSS_V.includes(g[rr][cc])) used[rr][cc] = true;
  }
  const inside = (b, r, c) => r > b.r && r < b.rb && c > b.c && c < b.c2;
  for (const b of boxes) {
    b.depth = boxes.filter((o) => o !== b && o.r <= b.r && o.rb >= b.rb && o.c <= b.c && o.c2 >= b.c2).length;
    for (let rr = b.r + 1; rr < b.rb; rr++) {
      const row = g[rr].slice(b.c + 1, b.c2).join("").replace(/[│┆║╭╮╰╯╔╗╚╝─┄═]/g, " ").trim();
      if (!row) continue;
      b.state = STATE_CLASS.find(([word]) => row.toLowerCase().startsWith(word.toLowerCase()))?.[1] ?? "";
      break;
    }
  }
  const x = (c) => c * CW, y = (r) => r * CH, base = (r) => y(r) + CH * 0.68;
  const out = [];
  for (const b of [...boxes].sort((a, z) => a.depth - z.depth)) {
    const cls = ["pic-box", b.style, `d${b.depth % 2}`, b.state].filter(Boolean).join(" ");
    out.push(`<rect class="${cls}" x="${x(b.c) + CW / 2}" y="${y(b.r) + CH / 2}" width="${(b.c2 - b.c) * CW}" height="${(b.rb - b.r) * CH}" rx="${b.style === "double" ? 4 : 7}"/>`);
  }
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
    const ch = g[r][c];
    if (used[r][c] || !CONNECT.includes(ch)) continue;
    used[r][c] = true;
    const cx = x(c) + CW / 2, cy = y(r) + CH / 2, l = x(c), rt = x(c + 1), t = y(r), bt = y(r + 1);
    const dash = "┆┄".includes(ch) ? " dash" : "";
    const line = (x1, y1, x2, y2) => out.push(`<line class="pic-line${dash}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`);
    const path = (d) => out.push(`<path class="pic-line" d="${d}"/>`);
    const head = (pts) => out.push(`<polygon class="pic-head" points="${pts}"/>`);
    if ("│┆".includes(ch)) line(cx, t, cx, bt);
    else if ("─┄".includes(ch)) line(l, cy, rt, cy);
    else if (ch === "╭") path(`M${rt} ${cy} Q${cx} ${cy} ${cx} ${bt}`);
    else if (ch === "╮") path(`M${l} ${cy} Q${cx} ${cy} ${cx} ${bt}`);
    else if (ch === "╰") path(`M${cx} ${t} Q${cx} ${cy} ${rt} ${cy}`);
    else if (ch === "╯") path(`M${cx} ${t} Q${cx} ${cy} ${l} ${cy}`);
    else if (ch === "▼") { line(cx, t, cx, cy - 1); head(`${cx - 4.5},${cy - 2} ${cx + 4.5},${cy - 2} ${cx},${cy + 6}`); }
    else if (ch === "▲") { line(cx, bt, cx, cy + 1); head(`${cx - 4.5},${cy + 2} ${cx + 4.5},${cy + 2} ${cx},${cy - 6}`); }
    else if (ch === "▶") { line(l, cy, cx - 1, cy); head(`${cx - 3},${cy - 4.5} ${cx - 3},${cy + 4.5} ${cx + 5},${cy}`); }
    else if (ch === "◀") { line(rt, cy, cx + 1, cy); head(`${cx + 3},${cy - 4.5} ${cx + 3},${cy + 4.5} ${cx - 5},${cy}`); }
    else if (ch === "●") out.push(`<circle class="pic-head" cx="${cx}" cy="${cy}" r="5"/>`);
    else if (ch === "━") out.push(`<rect class="pic-bar" x="${l}" y="${cy - 4}" width="${CW + 0.4}" height="8"/>`);
  }
  for (const b of boxes) {
    if (!b.label) continue;
    out.push(`<rect class="pic-labelbg ${b.style} d${b.depth % 2}" x="${x(b.labelCol) - 3}" y="${y(b.r) + 3}" width="${columns(b.label) * CW * 0.75 + 6}" height="${CH - 6}" rx="3"/>`);
    out.push(`<text class="pic-text pic-label${b.style === "double" ? " here" : ""}" x="${x(b.labelCol)}" y="${base(b.r)}">${escapeHtml(b.label)}</text>`);
  }
  // Text: runs of characters, split at two spaces or at a drawn cell. A box mark left in a run is fixed-width text.
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W;) {
      if (used[r][c] || g[r][c] === " ") { c++; continue; }
      let e = c;
      while (e < W && !used[r][e] && !(g[r][e] === " " && (e + 1 >= W || g[r][e + 1] === " " || used[r][e + 1]))) e++;
      const text = g[r].slice(c, e).join("").trimEnd();
      const owner = boxes.filter((b) => inside(b, r, c)).sort((a, z) => z.depth - a.depth)[0];
      textRun(out, text, c, r, { first: owner && r === owner.r + 1 && !owner.label, x, y, base });
      c = e;
    }
  }
  return `<svg class="pic" viewBox="0 0 ${W * CW} ${H * CH}" width="${W * CW}" role="img" aria-label="${escapeHtml(title)}" data-source="${sourceOf(lines)}" xmlns="http://www.w3.org/2000/svg">${out.join("")}</svg>`;
}

/** One run of text: plain words, the change tags [new] and [was: …] as pills, and box marks as fixed-width cells. */
function textRun(out, text, c, r, { first, x, y, base }) {
  const chars = [...text];
  const plain = (from, to) => {
    let s = chars.slice(from, to).join("");
    const lead = s.length - s.trimStart().length;
    s = s.trim();
    if (!s) return;
    const at = c + from + lead;
    const hit = STATE_CLASS.find(([word]) => s.startsWith(word));
    const body = hit ? `<tspan class="${hit[1]} st">${escapeHtml(hit[0])}</tspan>${escapeHtml(s.slice(hit[0].length))}` : escapeHtml(s);
    out.push(`<text class="pic-text${first ? " pic-strong" : ""}" x="${x(at)}" y="${base(r)}">${body}</text>`);
  };
  const joined = chars.join("");
  const tags = [...joined.matchAll(DIGITLESS_TAG)].map((m) => ({ from: [...joined.slice(0, m.index)].length, len: [...m[0]].length, tag: m[1] }));
  let from = 0;
  const flush = (to) => {
    // Box marks inside the run are drawn one cell each, in a fixed-width font.
    let start = from;
    for (let i = from; i < to; i++) {
      if (!BOX_MARKS.test(chars[i])) continue;
      plain(start, i);
      out.push(`<text class="pic-text pic-raw" x="${x(c + i)}" y="${base(r)}">${escapeHtml(chars[i])}</text>`);
      start = i + 1;
    }
    plain(start, to);
  };
  for (const t of tags) {
    flush(t.from);
    const isNew = t.tag === "new", px = x(c + t.from);
    out.push(`<rect class="pic-tag ${isNew ? "new" : "was"}" x="${px}" y="${y(r) + 2}" width="${(isNew ? 3 : columns(t.tag)) * CW * 0.72 + 12}" height="${CH - 4}" rx="${(CH - 4) / 2}"/>`);
    const inner = isNew ? `<tspan class="tag-new">new</tspan>` : `<tspan class="tag-was">was: </tspan><tspan class="tag-old">${escapeHtml(t.tag.slice(5))}</tspan>`;
    out.push(`<text class="pic-text pic-tagtext" x="${px + 6}" y="${base(r)}">${inner}</text>`);
    from = t.from + t.len;
  }
  flush(chars.length);
}
