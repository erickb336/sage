// Draws the README's graphics as SVG, each in a light and a dark version (docs/assets/<name>-light.svg, -dark.svg).
// The README shows the version that matches the reader's GitHub theme. Run `npm run graphics` after a change here.
// The look is "ink and seal": an ink-wash scroll painting. Washes of ink fade into the paper as mist over misty peaks,
// the hooded toad sage meditates at the centre, its team are seal stamps on one brush circle (an ensō), and hanging
// scrolls carry the dojo mood. All shapes are original: no characters, logos, symbols or eye markings from any series.
// Each text is 7 px or more on a phone, where a graphic is 324 px wide: `npm run check` checks it. So the smallest
// text is SMALL (24) in a graphic 1100 wide, and 28 in the hero, which is 1280 wide.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isMain } from "./is-main.mjs";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "../docs/assets");

/** The two themes: ink on warm paper in light, and pale ink on a night slate in dark. One accent: vermilion. */
const THEMES = {
  light: { dark: false, bg: "#F3EEE5", ink: "#1E1B18", muted: "#655C54", line: "#9C9188", edge: "#3A342E", head: "#B4412C", bad: "#B4412C", loop: "#8A6420", tile: "#FBF8F2", panel: "#EEE7DA", chip: "#EFE8DC", accent: "#B4412C", onAccent: "#FBF8F2", wash: "#2A2724", border: "#DDD3C4", paper: "#FBF8F2" },
  dark: { dark: true, bg: "#131518", ink: "#ECE6DC", muted: "#A0988E", line: "#5E636A", edge: "#D9D2C6", head: "#E0674C", bad: "#E0674C", loop: "#D9A54A", tile: "#1B1E22", panel: "#171A1E", chip: "#22262B", accent: "#D0533A", onAccent: "#1A1310", wash: "#A9B4BF", border: "#2A2E33", paper: "#F3EEE5" },
};
/** The toad sage's colours in each theme. */
const SAGE_INK = {
  light: { robe: "#2F2B27", fold: "#47413B", trim: "#B4412C", bead: "#3F3934", hood: "#38332E", rim: "#9A9086", shadow: "#100E0C", skin: "#4B4737", wart: "#38352A", brow: "#2A2720", lid: "#3F3C30", eye: "#D6A243", pupil: "#14110D", line: "#14110D", glint: "#FFF6DE", hand: "#5B5445", pad: "#8C8370", seed: "#E2AE4C" },
  dark: { robe: "#2B2E33", fold: "#43484F", trim: "#D0533A", bead: "#3B3F45", hood: "#34383E", rim: "#CFC6BA", shadow: "#0B0C0D", skin: "#504E3D", wart: "#3D3B2F", brow: "#2D2B23", lid: "#444133", eye: "#E2AE4C", pupil: "#14110D", line: "#0E0D0C", glint: "#FFF6DE", hand: "#625B4B", pad: "#968C78", seed: "#E9B656" },
};
const sageInk = (t) => SAGE_INK[t.dark ? "dark" : "light"];
const SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, Helvetica, Arial, sans-serif";
const SERIF = "'Iowan Old Style', 'Palatino Linotype', Palatino, Georgia, 'Times New Roman', serif";
const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
const SMALL = 24;

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const attrs = (o) => Object.entries(o).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => `${k}="${v}"`).join(" ");
const f1 = (n) => +(+n).toFixed(1);

/** Text, one tspan per line. halo draws a ring of that colour under the letters, so that a line behind them stops short. */
function text(x, y, lines, { size = 16, weight = 400, fill, anchor = "start", mono = false, serif = false, italic = false, lh = 1.35, opacity, ls, halo } = {}) {
  const ts = [].concat(lines).map((l, i) => `<tspan x="${x}" dy="${i === 0 ? 0 : size * lh}">${esc(l)}</tspan>`).join("");
  const ring = halo ? { stroke: halo, "stroke-width": 7, "stroke-linejoin": "round", "paint-order": "stroke" } : {};
  return `<text ${attrs({ x, y, "font-family": mono ? MONO : serif ? SERIF : SANS, "font-size": size, "font-weight": weight, "font-style": italic ? "italic" : undefined, fill, "text-anchor": anchor, opacity, "letter-spacing": ls, ...ring })}>${ts}</text>`;
}
/** The width of a line of text, a little more than the widest of the system font and Arial measure. */
const tw = (s, size, bold) => Math.round(s.length * size * (bold ? 0.58 : 0.48));
const rect = (x, y, w, h, o = {}) => `<rect ${attrs({ x, y, width: w, height: h, rx: o.rx ?? 4, fill: o.fill ?? "none", stroke: o.stroke, "stroke-width": o.sw, "stroke-dasharray": o.dash, opacity: o.opacity })}/>`;
const path = (d, o = {}) => `<path ${attrs({ d, fill: o.fill ?? "none", stroke: o.stroke, "stroke-width": o.sw ?? 2, "stroke-dasharray": o.dash, "stroke-linecap": "round", "stroke-linejoin": "round", opacity: o.opacity })}/>`;
const circle = (cx, cy, r, o = {}) => `<circle ${attrs({ cx, cy, r, fill: o.fill ?? "none", stroke: o.stroke, "stroke-width": o.sw, opacity: o.opacity })}/>`;
const ellipse = (cx, cy, rx, ry, o = {}) => `<ellipse ${attrs({ cx, cy, rx, ry, fill: o.fill ?? "none", stroke: o.stroke, "stroke-width": o.sw, opacity: o.opacity })}/>`;

/** A seeded random generator, so that each run draws the same file. */
const seeded = (seed) => () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
/** Maps a path in local units (absolute M, L, Q, C and Z only) onto the canvas: x → ox + x·s·flip, y → oy + y·s. */
const tp = (d, ox, oy, s, flip = 1) => { let i = 0; return d.replace(/-?\d*\.?\d+/g, (n) => String(f1(i++ % 2 === 0 ? ox + +n * s * flip : oy + +n * s))); };

/** The ink washes: a wash colour that fades into the paper towards the foot of a ridge, so that the mist is the paper. */
const washDefs = (id, t) => [["w1", 0.14], ["w2", 0.22], ["w3", 0.34]].map(([n, op]) => `<linearGradient id="${id}-${n}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${t.wash}" stop-opacity="${op}"/><stop offset="0.85" stop-color="${t.wash}" stop-opacity="0"/></linearGradient>`).join("\n");

/** Karst peaks: a row of steep pillars with round tops, from base up by hMin..hMax, filled down to the bottom H. */
function ridge(r, W, H, base, hMin, hMax, wMin, wMax) {
  let x = -60, y = base, d = `M-60 ${H} L-60 ${base}`;
  while (x < W + 60) {
    const w = wMin + r() * (wMax - wMin), top = base - hMin - r() * (hMax - hMin), y1 = base - r() * 40;
    d += ` C${f1(x + w * 0.2)} ${f1(y - (y - top) * 0.55)} ${f1(x + w * 0.25)} ${f1(top)} ${f1(x + w * 0.5)} ${f1(top)}`;
    d += ` C${f1(x + w * 0.75)} ${f1(top)} ${f1(x + w * 0.8)} ${f1(y1 - (y1 - top) * 0.55)} ${f1(x + w)} ${f1(y1)}`;
    x += w;
    y = y1;
  }
  return d + ` L${f1(x)} ${H} Z`;
}

/** A plain pagoda silhouette with three tiers of upturned eaves. (x, base) is the middle of its foot. */
function pagoda(x, base, s, fill, op) {
  const P = (d) => tp(d, x, base, s);
  const parts = [P("M-30 0 L30 0 L26 -6 L-26 -6 Z")];
  [[-6, 34, 20], [-30, 28, 15], [-52, 22, 11]].forEach(([y0, rw, bw]) => {
    parts.push(P(`M${-bw} ${y0} L${bw} ${y0} L${bw} ${y0 - 14} L${-bw} ${y0 - 14} Z`));
    parts.push(P(`M${-rw} ${y0 - 18} Q${-rw * 0.55} ${y0 - 15} ${-rw * 0.32} ${y0 - 21} L0 ${y0 - 27} L${rw * 0.32} ${y0 - 21} Q${rw * 0.55} ${y0 - 15} ${rw} ${y0 - 18} Q${rw * 0.5} ${y0 - 11} 0 ${y0 - 12} Q${-rw * 0.5} ${y0 - 11} ${-rw} ${y0 - 18} Z`));
  });
  parts.push(P("M-1 -79 L1 -79 L1 -94 L-1 -94 Z"));
  return `<path d="${parts.join(" ")}" fill="${fill}" opacity="${op}"/>`;
}

/** The kanji 仙 ("sage", a common word) as strokes in a 100-unit box, centred on (cx, cy). */
const XIAN = ["M35 22 C32 31 27 40 20 49", "M28 40 L28 79", "M61 21 L61 79", "M44 42 L44 79", "M78 42 L78 79", "M43 79 L79 79"];
const xian = (cx, cy, size, color, w = 0.075) => path(XIAN.map((d) => tp(d, cx - size / 2, cy - size / 2, size / 100)).join(" "), { stroke: color, sw: f1(size * w) });

/** A hanging scroll: a cord, two rods, paper with a few brush strokes, an optional 仙, and a seal. */
function scroll(t, x, y, w, h, glyphed) {
  const c = x + w / 2, r = seeded(x);
  const strokes = Array.from({ length: 5 }, (_, i) => { const y0 = y + (glyphed ? 110 : 50) + i * 52, len = 20 + r() * 18; return `M${f1(c - 6 + r() * 4)} ${f1(y0)} C${f1(c - 2)} ${f1(y0 + len * 0.4)} ${f1(c + 2)} ${f1(y0 + len * 0.7)} ${f1(c + 5)} ${f1(y0 + len)}`; }).join(" ");
  return [
    path(`M${x + 8} ${y - 4} L ${c} ${y - 34} L ${x + w - 8} ${y - 4}`, { stroke: t.line, sw: 1.4 }),
    rect(x, y, w, h, { rx: 0, fill: t.tile, stroke: t.line, sw: 1 }),
    glyphed ? xian(c, y + 56, 40, t.ink, 0.07) : "",
    path(strokes, { stroke: t.ink, sw: 3, opacity: 0.4 }),
    rect(c - 8, y + h - 52, 16, 16, { rx: 2, fill: t.accent }),
    rect(x - 6, y - 6, w + 12, 10, { rx: 5, fill: t.edge, opacity: 0.85 }),
    rect(x - 6, y + h - 4, w + 12, 10, { rx: 5, fill: t.edge, opacity: 0.85 }),
  ].join("");
}

// The toad sage, in local units: the origin is between the eyes; the hero draws it at 1 unit = 1 px.
const SAGE = {
  robe: "M-132 92 C-168 100 -206 118 -222 170 C-236 222 -242 300 -256 364 C-262 396 -246 414 -206 420 C-110 432 110 432 206 420 C246 414 262 396 256 364 C242 300 236 222 222 170 C206 118 168 100 132 92 Z",
  bust: "M-132 92 C-168 100 -206 118 -222 170 L-230 236 L230 236 L222 170 C206 118 168 100 132 92 Z",
  lap: "M-282 384 C-266 338 -150 324 0 336 C150 324 266 338 282 384 C290 414 258 432 216 434 L-216 434 C-258 432 -290 414 -282 384 Z",
  hood: "M0 -178 C26 -168 94 -142 124 -64 C142 -18 148 40 154 98 C122 116 70 124 0 124 C-70 124 -122 116 -154 98 C-148 40 -142 -18 -124 -64 C-94 -142 -26 -168 0 -178 Z",
  hoodRim: "M-150 70 C-146 20 -140 -20 -124 -64 C-94 -142 -26 -168 0 -178 C26 -168 94 -142 124 -64 C140 -20 146 20 150 70",
  opening: "M0 -102 C58 -102 98 -62 106 -12 C112 34 108 84 98 112 C70 128 -70 128 -98 112 C-108 84 -112 34 -106 -12 C-98 -62 -58 -102 0 -102 Z",
  face: "M-104 -16 C-110 16 -106 52 -90 82 C-68 112 -30 122 0 122 C30 122 68 112 90 82 C106 52 110 16 104 -16 C98 -66 -98 -66 -104 -16 Z",
  brow: "M-72 -17 C-58 -26 -36 -26 -20 -17",
  mouth: "M-98 72 C-70 60 -34 58 0 60 C34 58 70 60 98 72",
  corner: "M-98 72 C-101 78 -100 85 -96 90",
  sleeve: "M-214 172 C-242 236 -242 304 -208 326 C-170 344 -118 312 -80 284 L-80 222 C-112 232 -146 238 -168 224 C-184 212 -190 194 -188 172 Z",
  cuff: "M-80 284 C-96 272 -96 236 -80 222 C-64 232 -64 270 -80 284 Z",
  palm: "M-68 254 C-74 228 -62 200 -42 192 C-28 196 -20 212 -18 230 C-24 248 -44 260 -68 254 Z",
  fingers: [["M-58 222 C-58 210 -56 200 -52 190", -52, 190, 5], ["M-52 212 C-48 198 -44 186 -38 174", -38, 174, 5.6], ["M-46 204 C-40 186 -32 170 -22 155", -22, 155, 6], ["M-40 198 C-30 176 -18 156 -6 140", -6, 140, 6.5], ["M-28 232 C-20 230 -12 228 -4 226", -4, 226, 6]],
  warts: [[-72, 30, 3.2], [-60, 50, 2.4], [-82, 58, 2.2], [-88, 12, 2], [64, 28, 3], [76, 46, 2.6], [58, 62, 2.1], [88, 14, 2.2], [-34, 94, 2.2], [30, 98, 2.4], [2, 106, 2], [-14, 82, 1.8], [44, 84, 1.8]],
};

/** The toad sage, calm: a hooded robe, a wide toad face with a few warts, two half-closed gold eyes with horizontal
 *  pupils, and toad hands joined in a triangle around a seed of light. No markings around the eyes. (cx, cy) is the
 *  point between the eyes; P is the palette (sageInk); bust draws only the hood, the face and the shoulders. */
function toadSage(cx, cy, s, P, { bust = false } = {}) {
  const T = (d, fl = 1) => tp(d, cx, cy, s, fl);
  const X = (x) => f1(cx + x * s), Y = (y) => f1(cy + y * s), R = (n) => f1(n * s);
  const both = (d, a) => [-1, 1].map((fl) => `<path d="${T(d, -fl)}" ${a}/>`).join("");
  const fold = `fill="none" stroke="${P.fold}" stroke-width="${R(2.5)}" stroke-linecap="round"`;
  const o = [`<path d="${T(bust ? SAGE.bust : SAGE.robe)}" fill="${P.robe}"/>`];
  if (!bust) {
    o.push(both("M-200 206 C-212 262 -216 322 -228 374", fold));
    o.push(`<path d="${T(SAGE.lap)}" fill="${P.robe}" stroke="${P.fold}" stroke-width="${R(1.5)}"/>`);
    o.push(both("M-262 398 C-200 372 -120 366 -40 380", fold));
  }
  // The lapels with a vermilion trim, and the prayer beads.
  o.push(both("M-120 104 C-92 132 -60 170 -26 226", `fill="none" stroke="${P.trim}" stroke-width="${R(3)}" stroke-linecap="round" opacity="0.85"`));
  if (!bust) for (let i = 0; i <= 14; i++) {
    const u = i / 14;
    o.push(circle(X(-86 + 172 * u), Y(112 + 38 * Math.sin(Math.PI * u)), R(5.4), { fill: i === 7 ? P.trim : P.bead }));
  }
  // The hood, with folds and a pale rim, and the shadow inside it.
  o.push(`<path d="${T(SAGE.hood)}" fill="${P.hood}"/>`);
  o.push(both("M-62 -148 C-92 -112 -114 -62 -124 0", fold), path(T("M0 -178 C3 -152 2 -128 0 -106"), { stroke: P.fold, sw: R(2.5) }));
  o.push(path(T(SAGE.hoodRim), { stroke: P.rim, sw: R(2), opacity: 0.75 }));
  o.push(`<path d="${T(SAGE.opening)}" fill="${P.shadow}"/>`);
  // The face: a wide toad head with a few warts, calm brows, half-closed eyes, nostrils and a long, flat mouth.
  o.push(`<path d="${T(SAGE.face)}" fill="${P.skin}"/>`);
  o.push(SAGE.warts.map(([x, y, r]) => circle(X(x), Y(y), R(r), { fill: P.wart })).join(""));
  o.push(both(SAGE.brow, `fill="none" stroke="${P.brow}" stroke-width="${R(2.4)}" stroke-linecap="round"`));
  for (const ex of [-46, 46]) {
    const ey = 2;
    const almond = `M${ex - 26} ${ey} C${ex - 14} ${ey - 13} ${ex + 14} ${ey - 13} ${ex + 26} ${ey} C${ex + 14} ${ey + 11} ${ex - 14} ${ey + 11} ${ex - 26} ${ey} Z`;
    o.push(`<path d="${T(almond)}" fill="${P.eye}"/>`);
    o.push(ellipse(X(ex), Y(ey + 2), R(11), R(2.8), { fill: P.pupil }));
    o.push(`<path d="${T(`M${ex - 27} ${ey} C${ex - 14} ${ey - 14} ${ex + 14} ${ey - 14} ${ex + 27} ${ey} C${ex + 14} ${ey - 5} ${ex - 14} ${ey - 5} ${ex - 27} ${ey} Z`)}" fill="${P.lid}"/>`);
    o.push(path(T(`M${ex - 26} ${ey} C${ex - 14} ${ey - 5} ${ex + 14} ${ey - 5} ${ex + 26} ${ey}`), { stroke: P.line, sw: R(2.4) }));
    o.push(`<path d="${T(almond)}" fill="none" stroke="${P.line}" stroke-width="${R(2)}"/>`);
    o.push(circle(X(ex + 6), Y(ey + 4), R(1.6), { fill: P.glint, opacity: 0.85 }));
  }
  o.push([-1, 1].map((sd) => ellipse(X(sd * 11), Y(34), R(3.2), R(2), { fill: P.line })).join(""));
  o.push(path(T(SAGE.mouth), { stroke: P.line, sw: R(3.2) }));
  o.push(both(SAGE.corner, `fill="none" stroke="${P.line}" stroke-width="${R(2.6)}" stroke-linecap="round"`));
  if (bust) return o.join("");
  // The sleeves, and the toad hands joined in a triangle. The hands are drawn 1.2 times larger, about (0, 196).
  o.push(both(SAGE.sleeve, `fill="${P.hood}" stroke="${P.fold}" stroke-width="${R(1.5)}"`));
  o.push(both("M-200 304 C-166 306 -124 290 -92 270", fold));
  o.push(both(SAGE.cuff, `fill="${P.shadow}"`));
  o.push(circle(X(0), Y(194), R(5.5), { fill: P.seed }));
  const k = 1.2 * s, hy = cy + 196 * s * (1 - 1.2);
  for (const sd of [-1, 1]) {
    const Q = (d) => tp(d, cx, hy, k, sd);
    o.push(`<path d="${Q(SAGE.palm)}" fill="${P.hand}"/>`);
    o.push(SAGE.fingers.map(([d, tx, ty, pr]) => `<path d="${Q(d)}" fill="none" stroke="${P.hand}" stroke-width="${f1(8 * k)}" stroke-linecap="round"/>` + circle(f1(cx + sd * tx * k), f1(hy + ty * k), f1(pr * 0.9 * k), { fill: P.pad })).join(""));
  }
  return o.join("");
}

/** The role glyphs: plain line drawings in a 24-unit box around (0, 0). */
const GLYPH = {
  brush: `<path d="M8 -10 L-1 1"/><path d="M-1 1 C-4 3 -7 7 -9 10 C-5 10 -1 8 1 4 Z" fill="currentColor"/>`,
  square: `<path d="M-8 8 L8 8 L-8 -8 Z"/><path d="M-4 4 L1 4 L-4 -1 Z"/>`,
  hammer: `<path d="M-8 9 L2 -1"/><path d="M-1 -9 L9 1 L6 4 L-4 -6 Z"/>`,
  scales: `<path d="M0 -9 L0 9 M-5 9 L5 9 M-9 -6 L9 -6 M-12 2 L-9 -6 L-6 2 M12 2 L9 -6 L6 2 M-12 2 Q-9 6 -6 2 M6 2 Q9 6 12 2"/>`,
  lens: `<circle cx="-2" cy="-2" r="6.5"/><path d="M3 3 L9 9"/>`,
  shield: `<path d="M0 -10 C4 -7 7 -7 9 -7 C9 2 6 7 0 10 C-6 7 -9 2 -9 -7 C-7 -7 -4 -7 0 -10 Z"/><path d="M0 -3 L0 3"/>`,
  mirror: `<ellipse cx="0" cy="-3" rx="6" ry="7"/><path d="M0 4 L0 10 M-3 10 L3 10"/>`,
  check: `<circle cx="0" cy="0" r="8.5"/><path d="M-4 0 L-1 3 L4.5 -3.5"/>`,
};
const glyph = (tool, x, y, k, color, sw) =>
  `<g transform="translate(${x} ${y}) scale(${f1(k * 100) / 100})" fill="none" stroke="${color}" color="${color}" stroke-width="${f1(sw / k)}" stroke-linecap="round" stroke-linejoin="round">${GLYPH[tool]}</g>`;

/** A seal stamp for a role, of half-width r, a little turned as if stamped by hand. A writer's seal is filled with
 *  vermilion; a reader's is cut in outline. k picks the turn. */
function seal(t, x, y, r, tool, writes, k = 0) {
  const s = f1(r * 0.95), turn = [-2, 1.5, -1, 2, -1.5, 1, -2, 1.5][k % 8];
  const box = (inset, o) => rect(f1(x - s + inset), f1(y - s + inset), f1(2 * s - 2 * inset), f1(2 * s - 2 * inset), o);
  return `<g transform="rotate(${turn} ${x} ${y})">` + (writes
    ? box(0, { rx: 6, fill: t.accent }) + box(5, { rx: 3, stroke: t.paper, sw: 1.2, opacity: 0.7 }) + glyph(tool, x, y, s / 13, t.paper, 2.6)
    : box(0, { rx: 6, fill: t.tile, stroke: t.accent, sw: 2 }) + box(5, { rx: 3, stroke: t.accent, sw: 1, opacity: 0.5 }) + glyph(tool, x, y, s / 13, t.accent, 2.4)) + `</g>`;
}

/** The sage's bust in a round window of radius r, with a thin ink frame and a small seal. */
function emblem(t, cx, cy, r, id) {
  return [
    `<defs><clipPath id="${id}-emblem"><circle cx="${cx}" cy="${cy}" r="${r}"/></clipPath></defs>`,
    circle(cx, cy, r, { fill: t.panel }),
    `<g clip-path="url(#${id}-emblem)">${toadSage(cx, f1(cy - r * 0.08), r / 190, sageInk(t), { bust: true })}</g>`,
    circle(cx, cy, r, { stroke: t.edge, sw: 1.6 }),
    circle(cx, cy, r + 6, { stroke: t.line, sw: 1, opacity: 0.6 }),
    rect(f1(cx + r * 0.62), f1(cy + r * 0.52), f1(r * 0.24), f1(r * 0.24), { rx: 2, fill: t.accent }),
  ].join("");
}

// The roles on the ring, clockwise from one o'clock. The writers (true) work in their own worktrees.
const RING = [["Designer", true, "brush"], ["PE", false, "square"], ["Implementer", true, "hammer"], ["Arena judge", true, "scales"], ["Code reviewer", false, "lens"], ["Security reviewer", false, "shield"], ["UX reviewer", false, "mirror"], ["QA", false, "check"]];

/** Small arrowheads on an ellipse, clockwise, at the given angles (degrees clockwise from the top). */
const chevrons = (cx, cy, rx, ry, degs, color, size) => degs.map((deg) => {
  const a = (deg * Math.PI) / 180, px = cx + rx * Math.sin(a), py = cy - ry * Math.cos(a), k = size / 11;
  let dx = rx * Math.cos(a), dy = ry * Math.sin(a);
  const n = Math.hypot(dx, dy);
  dx /= n; dy /= n;
  return `<path d="M${f1(px + dx * 11 * k)} ${f1(py + dy * 11 * k)} L${f1(px - (dx * 7 + dy * 8) * k)} ${f1(py + (dx * 8 - dy * 7) * k)} L${f1(px - dx * 3 * k)} ${f1(py - dy * 3 * k)} L${f1(px - (dx * 7 - dy * 8) * k)} ${f1(py - (dy * 7 + dx * 8) * k)} Z" fill="${color}"/>`;
}).join("");

/** The loop of the team: one brush circle (an ensō) with a dry-brush edge, open at the top left, and vermilion arrows. */
function enso(t, cx, cy, rx, ry) {
  const pt = (deg, d = 0, e = 0) => { const a = (deg * Math.PI) / 180; return [f1(cx + (rx + d) * Math.sin(a)), f1(cy - (ry + e) * Math.cos(a))]; };
  const arc = (a0, a1, d, e) => `M${pt(a0, d, e).join(" ")} A${rx + d} ${ry + e} 0 1 1 ${pt(a1, d, e).join(" ")}`;
  return [
    path(arc(352, 326, 0, 0), { stroke: t.ink, sw: 6, opacity: 0.8 }),
    path(arc(356, 318, 5, 4), { stroke: t.ink, sw: 2, opacity: 0.3, dash: "70 9 140 6" }),
    path(arc(348, 300, -6, -5), { stroke: t.ink, sw: 1.4, opacity: 0.35, dash: "110 7 40 5" }),
    circle(...pt(352), 5, { fill: t.ink, opacity: 0.8 }),
    chevrons(cx, cy, rx, ry, [45, 135, 225, 315], t.accent, 13),
  ].join("");
}

/** A graphic: the defs (the ink washes and the arrowheads), the paper, the body, and a thin frame. */
function frame(t, w, h, id, body, label) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${esc(label)}">
<defs>
${washDefs(id, t)}
${markers(id, t)}
<clipPath id="${id}-frame"><rect width="${w}" height="${h}" rx="20"/></clipPath>
</defs>
<g clip-path="url(#${id}-frame)">
<rect width="${w}" height="${h}" fill="${t.bg}"/>
${body}
</g>
<rect x="0.75" y="0.75" width="${w - 1.5}" height="${h - 1.5}" rx="19.25" fill="none" stroke="${t.border}" stroke-width="1.5"/>
</svg>
`;
}

/** The arrowheads: hot (the main flow), muted, bad (back to the build) and loop. */
const markers = (id, t) => [["hot", t.edge], ["muted", t.line], ["bad", t.bad], ["loop", t.loop]].map(([name, color]) => `<marker id="${id}-${name}" viewBox="0 0 12 12" refX="10" refY="6" markerWidth="9" markerHeight="9" markerUnits="userSpaceOnUse" orient="auto-start-reverse"><path d="M0 0 L12 6 L0 12 L3 6 z" fill="${color}"/></marker>`).join("\n");

/** A line with an arrowhead at its end: marker is hot, muted, bad or loop (see markers). */
const flow = (id, d, color, marker, o = {}) => `<path d="${d}" fill="none" stroke="${color}" stroke-width="${o.sw ?? 2}"${o.dash ? ` stroke-dasharray="${o.dash}"` : ""} stroke-linecap="round" stroke-linejoin="round"${marker ? ` marker-end="url(#${id}-${marker})"` : ""}/>`;

/** A card with a serif title and a smaller line or two under it. A hot card has an ink edge and a vermilion tab. */
function tile(t, id, x, y, w, h, title, sub, hot, { titleY = 40, size = 26, subSize = SMALL, gap = 34, fill = t.tile, ink = t.ink, subInk = t.muted } = {}) {
  return rect(x, y, w, h, { fill, stroke: hot ? t.edge : t.line, sw: hot ? 1.4 : 1.2 }) +
    (hot && fill === t.tile ? path(`M${x + 12} ${y + 1} L ${x + 40} ${y + 1}`, { stroke: t.accent, sw: 3 }) : "") +
    text(x + w / 2, y + titleY, title, { size, weight: 600, fill: ink, anchor: "middle", serif: true }) +
    text(x + w / 2, y + titleY + gap, sub, { size: subSize, fill: subInk, anchor: "middle", lh: 1.25 });
}
/** The vermilion fill and inks of a card that is the chief's or yours. */
const chiefTile = (t) => ({ fill: t.accent, ink: t.onAccent, subInk: t.onAccent });

/** A flat label in a box. kind: "you" (a vermilion fill: a step for you), "hot" (an ink edge), "bad" (a vermilion
 *  edge), "wait" (a dashed edge), or "plain". */
function pill(t, id, x, y, w, h, label, kind = "plain", size = SMALL) {
  const box = kind === "you" ? rect(x, y, w, h, { fill: t.accent })
    : rect(x, y, w, h, { fill: t.tile, stroke: { hot: t.edge, bad: t.bad }[kind] ?? t.line, sw: kind === "hot" || kind === "bad" ? 2 : 1.2, dash: kind === "wait" ? "6 5" : undefined });
  return box + text(f1(x + w / 2), f1(y + h / 2 + size * 0.35), label, { size, weight: 600, fill: kind === "you" ? t.onAccent : t.ink, anchor: "middle" });
}

/** A label in capitals, the heading inside a graphic. */
const heading = (t, x, y, s) => text(x, y, s, { size: SMALL, weight: 700, fill: t.head, ls: 2 });

/** The world behind a graphic: a pale moon and two ink-wash ridges that fade into the paper, with optional pagodas.
 *  Draw it first, so that every label sits on top of it. seeds: the far and the near ridge. far and near: a ridge's
 *  base, its lowest and highest peak, and its narrowest and widest peak. */
function backdrop(t, id, W, H, { moon: [mx, my, mr], seeds: [s1, s2], far, near, pagodas = [] }) {
  return [
    circle(mx, my, mr, { fill: t.wash, opacity: 0.05 }),
    `<path d="${ridge(seeded(s1), W, H, ...far)}" fill="url(#${id}-w1)"/>`,
    ...pagodas.map(([x, base, s]) => pagoda(x, base, s, t.wash, 0.14)),
    `<path d="${ridge(seeded(s2), W, H, ...near)}" fill="url(#${id}-w2)"/>`,
  ].join("\n");
}

/** The hero: the hooded toad sage meditates on a stone, its eight roles are seals on a brush circle around it, in an
 *  ink-wash world of misty peaks, with a hanging scroll on each side. The words on top, the credits below. */
function hero(t, id) {
  const W = 1280, H = 1120, cx = 640, cy = 640, rx = 470, ry = 330, br = 42;
  const at = (k) => { const a = ((22.5 + k * 45) * Math.PI) / 180; return [f1(cx + rx * Math.sin(a)), f1(cy - ry * Math.cos(a))]; };
  const meds = RING.map(([name, writes, tool], k) => ({ name, writes, tool, k, xy: at(k) }));
  // A label sits outside its seal: beside the top pair, below the four at the sides, and below and outward for the
  // bottom pair, so that it stays off the sage's lap and the words "Chief of staff".
  const label = (x, y, s, anchor) => text(x, f1(y + 10), s, { size: 28, weight: 600, fill: t.ink, anchor, halo: t.bg });
  const labelOf = ({ name, k, xy: [x, y] }) =>
    k === 0 ? label(x + br + 18, y, name, "start") : k === 7 ? label(x - br - 18, y, name, "end")
      : k === 3 ? label(x - 30, y + br + 34, name, "start") : k === 4 ? label(x + 30, y + br + 34, name, "end")
        : label(x, y + br + 34, name, "middle");
  const body = [
    // The world: a pale moon, three ink-wash ridges, a far pagoda, and two hanging scrolls.
    circle(930, 300, 150, { fill: t.wash, opacity: 0.06 }),
    `<path d="${ridge(seeded(21), W, H, 650, 110, 270, 70, 150)}" fill="url(#${id}-w1)"/>`,
    pagoda(330, 612, 1.3, t.wash, 0.16),
    `<path d="${ridge(seeded(34), W, H, 800, 90, 240, 90, 170)}" fill="url(#${id}-w2)"/>`,
    `<path d="${ridge(seeded(55), W, H, 940, 60, 190, 110, 200)}" fill="url(#${id}-w3)"/>`,
    scroll(t, 34, 268, 60, 430, true), scroll(t, W - 94, 268, 60, 430, false),
    // The words.
    text(60, 172, "sage", { size: 150, weight: 400, fill: t.ink, serif: true, ls: -3 }),
    rect(352, 108, 64, 64, { rx: 6, fill: t.accent }), xian(384, 140, 48, t.paper),
    text(452, 92, ["Your chief of staff", "for Claude Code."], { size: 44, weight: 400, fill: t.ink, serif: true, lh: 1.15 }),
    `<text x="454" y="194" font-family="${SANS}" font-size="28" fill="${t.muted}"><tspan>Send </tspan><tspan font-weight="700" fill="${t.accent}">“sage mode”</tspan><tspan> as a message of its own.</tspan></text>`,
    // The stone, the sage, the loop and the team.
    `<path d="M392 1040 C404 990 440 958 500 951 L780 951 C840 958 876 990 888 1040 Z" fill="${t.wash}" opacity="0.16"/>`,
    path("M430 956 C540 946 740 946 850 956", { stroke: t.ink, sw: 3, opacity: 0.45 }),
    toadSage(cx, 520, 1, sageInk(t)),
    enso(t, cx, cy, rx, ry),
    ...meds.map((m) => seal(t, m.xy[0], m.xy[1], br, m.tool, m.writes, m.k)),
    ...meds.map(labelOf),
    text(cx, 1014, "Chief of staff", { size: 32, fill: t.ink, anchor: "middle", serif: true, italic: true, halo: t.bg }),
    // The credits.
    path(`M64 1060 L ${W - 64} 1060`, { stroke: t.line, sw: 1 }),
    text(64, 1101, "Claude Code plugin · MIT", { size: 28, weight: 600, fill: t.ink }),
    text(W - 64, 1101, "Built on pstack and poteto mode, by Lauren Tan", { size: 28, fill: t.muted, anchor: "end" }),
  ].join("\n");
  return frame(t, W, H, id, body, "sage: your chief of staff for Claude Code. Send sage mode as a message of its own. A hooded toad sage, the chief of staff, meditates in a misty mountain world, with calm gold toad eyes. Around it, its team on a loop: designer, PE, implementer, arena judge, code reviewer, security reviewer, UX reviewer and QA. Claude Code plugin, MIT. Built on pstack and poteto mode, by Lauren Tan.");
}

/** How it works: you, the chief of staff (the toad sage), the team's flow to a pull request, the logbook, and the outer
 *  loop, on the same ink-wash paper. */
function loop(t, id) {
  const W = 1100, H = 864;
  const line = (d, color, marker, o) => flow(id, d, color, marker, o);
  const label = (x, y, s, o = {}) => text(x, y, s, { size: SMALL, fill: o.fill ?? t.muted, anchor: o.anchor ?? "middle", weight: o.weight, lh: 1.2, ls: o.ls });
  // The team's steps, left to right, each with the seal of its role.
  let sx = 60;
  const S = [["Design", ["designer", "PE"], 140, "brush"], ["Build", "implementer", 160, "hammer"], ["Review", ["code", "security · UX"], 180, "lens"], ["QA", "the real app", 160, "check"]].map(([title, sub, w, tool]) => {
    const st = { title, sub, w, tool, x: sx, c: sx + w / 2 };
    sx += w + 30;
    return st;
  });
  const [, build, review, qa] = S;
  const ty = 514, th = 140, sr = 25, panelR = qa.x + qa.w + 20;
  const body = [
    backdrop(t, id, W, H, { moon: [560, 170, 170], seeds: [12, 77], far: [720, 60, 200, 70, 140], near: [880, 90, 240, 80, 170] }),
    // Row 1: you, the chief of staff, the logbook.
    tile(t, id, 40, 100, 200, 112, "You", "phone · desktop", false, { titleY: 46 }),
    line("M248 128 L 390 128", t.edge, "hot"), label(318, 114, "request"),
    line("M390 176 L 248 176", t.line, "muted"), label(318, 206, ["questions,", "results"]),
    // The chief of staff: a card with the toad sage's bust and a small seal.
    `<clipPath id="${id}-chiefclip"><rect x="402" y="26" width="296" height="276" rx="4"/></clipPath>`,
    rect(402, 26, 296, 276, { fill: t.tile, stroke: t.edge, sw: 1.6 }),
    `<g clip-path="url(#${id}-chiefclip)">${toadSage(550, 104, 0.36, sageInk(t), { bust: true })}</g>`,
    rect(664, 38, 22, 22, { rx: 3, fill: t.accent }),
    text(550, 226, "Chief of staff", { size: 32, fill: t.ink, anchor: "middle", serif: true, italic: true }),
    text(550, 258, ["routes · briefs", "ledger · gates"], { size: SMALL, fill: t.muted, anchor: "middle", lh: 1.2 }),
    line("M706 164 L 758 164", t.line, "muted"),
    `<path d="M766 104 L766 216 A148 18 0 0 0 1062 216 L1062 104" fill="${t.tile}" stroke="${t.line}" stroke-width="1.5"/>`,
    ellipse(914, 104, 148, 18, { fill: t.tile, stroke: t.line, sw: 1.5 }),
    text(914, 166, "Logbook", { size: 26, weight: 600, fill: t.ink, anchor: "middle", serif: true }),
    label(914, 200, "tasks · ledger · trail"),
    // The brief goes down to the team; the report comes back up.
    line("M520 310 L 520 356", t.edge, "hot"), label(506, 342, "brief", { anchor: "end" }),
    line("M580 356 L 580 310", t.line, "muted"), label(594, 342, "report + evidence", { anchor: "start" }),
    // The team.
    rect(40, 362, panelR - 40, 386, { rx: 6, fill: t.panel, stroke: t.line, sw: 1 }),
    heading(t, 64, 400, "THE TEAM · ONE WRITER AT A TIME"),
    line(`M${review.c} ${ty - sr - 4} C ${review.c} ${ty - sr - 44}, ${build.c} ${ty - sr - 44}, ${build.c} ${ty - sr - 6}`, t.bad, "bad"),
    label((review.c + build.c) / 2, ty - sr - 46, "findings", { fill: t.bad }),
    ...S.map((st, i) => tile(t, id, st.x, ty, st.w, th, st.title, st.sub, true, { titleY: 64 }) + (i < S.length - 1 ? line(`M${st.x + st.w + 5} ${ty + th / 2} L ${st.x + st.w + 28} ${ty + th / 2}`, t.edge, "hot") : "")),
    ...S.map((st, i) => seal(t, st.c, ty, sr, st.tool, false, i)),
    line(`M${qa.c} ${ty + th + 4} C ${qa.c} ${ty + th + 48}, ${build.c} ${ty + th + 48}, ${build.c} ${ty + th + 6}`, t.bad, "bad"),
    label((qa.c + build.c) / 2, ty + th + 62, "QA fail", { fill: t.bad }),
    // The pull request.
    line(`M${qa.x + qa.w + 5} ${ty + th / 2} L ${panelR + 30} ${ty + th / 2}`, t.edge, "hot"),
    tile(t, id, panelR + 36, ty - 20, W - 40 - panelR - 36, th + 40, "Pull request", ["you merge, or", "autopilot after", "its clean cycles"], true),
    // The outer loop: a mistake that comes back twice gets a lasting fix.
    line(`M1064 160 L 1072 160 Q 1080 160 1080 170 L 1080 770 Q 1080 780 1070 780 L 340 780 Q 330 780 330 770 L 330 756`, t.loop, "loop", { dash: "8 8" }),
    label(W / 2, 828, "a mistake that comes back twice → seal the lesson", { fill: t.loop, weight: 700 }),
  ].join("\n");
  return frame(t, W, H, id, body, "How sage works: you send a request to the chief of staff, the hooded toad sage, which briefs the team (design, build, review, QA) and keeps the logbook. Findings and QA failures go back to the build. A clean result becomes a pull request. In the outer loop, the chief seals the lesson: a mistake that comes back twice gets a lasting fix, a test or a check in code first, a principle or a standing order only when code cannot hold it.");
}

/** A panel in the reader's theme: the same frame as every graphic. */
const panel = (t, id, W, H, body, label) => frame(t, W, H, id, body, label);

/** Routes: the least route for each size of task. */
function routes(t, id) {
  const W = 1100, size = SMALL, ph = 48, gap = 26, x0 = 272;
  const STEP = { design: "Design", pe: "PE check", approve: "You approve", build: "Build", code: "Code review", security: "Security review", ux: "UX review", qa: "QA", evidence: "Gather evidence", review: "Evidence review", propose: "A proposal to you" };
  const rows = [
    ["tiny", ["one obvious edit"], [["build"]]],
    ["small", ["one bounded change"], [["build", "code", "qa"]]],
    ["large", ["new screens,", "flows or data"], [["design", "pe", "approve", "build"], ["code", "security", "ux", "qa"]]],
    ["investigate", ["the cause", "is unknown"], [["evidence", "review", "propose"]]],
  ];
  const out = [heading(t, 36, 62, "THE LEAST ROUTE FOR EACH SIZE")];
  let y = 96;
  for (const [name, sub, lines] of rows) {
    out.push(text(36, y + 32, name, { size: 28, weight: 600, fill: t.ink, serif: true }), text(36, y + 64, sub, { size, fill: t.muted, lh: 1.25 }));
    let end;
    lines.forEach((steps, li) => {
      const ly = y + li * 88;
      let x = x0;
      steps.forEach((k, j) => {
        const label = STEP[k], w = tw(label, size, true) + 28;
        if (li > 0 && j === 0) out.push(flow(id, `M${end.cx} ${end.y + ph + 4} L ${end.cx} ${end.y + ph + 20} L ${x + w / 2} ${end.y + ph + 20} L ${x + w / 2} ${ly - 6}`, t.edge, "hot", { sw: 2 }));
        out.push(pill(t, id, x, ly, w, ph, label, k === "approve" || k === "propose" ? "you" : "plain", size));
        if (j < steps.length - 1) out.push(flow(id, `M${x + w + 4} ${ly + ph / 2} L ${x + w + gap - 6} ${ly + ph / 2}`, t.edge, "hot", { sw: 2 }));
        else end = { cx: x + w / 2, y: ly };
        x += w + gap;
      });
    });
    y += Math.max(lines.length * 88 - 8, 40 + sub.length * size * 1.25) + 22;
  }
  const ny = y + 10, nh = 3 * size * 1.4 + 34, H = Math.round(ny + nh + 30);
  out.push(
    rect(36, ny, W - 72, nh, { fill: t.tile, stroke: t.line, sw: 1.2 }),
    seal(t, 100, ny + nh / 2, 34, "shield", false),
    text(160, ny + 42, ["A risk flag (auth, personal data, schema, money, secrets or outside", "input) adds the security review to every size except investigate,", "which changes no code. The chief may add steps, never remove these."], { size, fill: t.ink, lh: 1.4 }),
  );
  out.unshift(backdrop(t, id, W, H, { moon: [930, 150, 120], seeds: [23, 41], far: [H - 120, 60, 200, 70, 140], near: [H + 20, 90, 240, 80, 170] }));
  return panel(t, id, W, H, out.join("\n"), "Routes by size. Tiny: build. Small: build, code review, QA. Large: design, PE check, you approve, build, code review, security review, UX review, QA. Investigate: gather evidence, evidence review, a proposal to you. A risk flag adds the security review to every size except investigate, which changes no code.");
}

/** A task's life: the states, with the repair loop and the held state. */
function lifecycle(t, id) {
  const W = 1100, H = 564, size = SMALL, ph = 50, y = 104, by = 256;
  const names = ["framed", "briefed", "building", "reviewing", "verifying", "verified", "merged"];
  const ws = names.map((n) => tw(n, size, true) + 16);
  const gap = (W - 72 - ws.reduce((a, b) => a + b)) / (names.length - 1);
  let x = 36;
  const S = Object.fromEntries(names.map((n, i) => { const s = { x: f1(x), w: ws[i], cx: f1(x + ws[i] / 2) }; x += ws[i] + gap; return [n, s]; }));
  const { building: bu, reviewing: re, verifying: ve } = S;
  const held = { w: tw("held", size, true) + 64 }, rep = { w: tw("repairing", size, true) + 64 };
  held.x = f1(bu.cx - held.w / 2);
  rep.x = f1((re.cx + ve.cx) / 2 - rep.w / 2);
  const fy = 372, fh = 4 * size * 1.4 + 32;
  const body = [
    backdrop(t, id, W, H, { moon: [990, 250, 100], seeds: [17, 52], far: [H - 60, 60, 180, 70, 140], near: [H + 60, 90, 220, 80, 170] }),
    heading(t, 36, 62, "THE STATES OF A TASK"),
    ...names.map((n, i) => pill(t, id, S[n].x, y, S[n].w, ph, n, n === "verified" || n === "merged" ? "hot" : "plain", size) +
      (i < names.length - 1 ? flow(id, `M${f1(S[n].x + S[n].w + 4)} ${y + ph / 2} L ${f1(S[names[i + 1]].x - 6)} ${y + ph / 2}`, t.edge, "hot", { sw: 2 }) : "")),
    // A product question holds the build; the answer lets it go on.
    flow(id, `M${bu.cx - 14} ${y + ph + 4} L ${bu.cx - 14} ${by - 6}`, t.line, "muted", { sw: 2 }),
    flow(id, `M${bu.cx + 14} ${by - 4} L ${bu.cx + 14} ${y + ph + 6}`, t.line, "muted", { sw: 2 }),
    text(bu.cx - 28, 196, ["a product", "question"], { size, fill: t.muted, anchor: "end", lh: 1.25 }),
    text(bu.cx + 28, 196, ["your", "answer"], { size, fill: t.muted, lh: 1.25 }),
    pill(t, id, held.x, by, held.w, ph, "held", "wait", size),
    // Findings or a QA failure start a repair round; the next round is reviewed again.
    flow(id, `M${ve.cx + 20} ${y + ph + 4} C ${ve.cx + 40} ${by - 30}, ${ve.cx + 40} ${by + ph / 2}, ${f1(rep.x + rep.w + 6)} ${by + ph / 2}`, t.bad, "bad", { sw: 2 }),
    text(ve.cx + 52, 210, ["findings to fix,", "or QA fail"], { size, fill: t.bad, lh: 1.25 }),
    flow(id, `M${f1(rep.x - 4)} ${by + ph / 2} C ${re.cx - 40} ${by + ph / 2}, ${re.cx - 30} ${by - 40}, ${re.cx - 30} ${y + ph + 6}`, t.line, "muted", { sw: 2 }),
    pill(t, id, rep.x, by, rep.w, ph, "repairing", "bad", size),
    text(f1(rep.x + rep.w / 2), by + ph + 34, "next round, at most 3", { size, fill: t.muted, anchor: "middle" }),
    // The rules of the states.
    rect(36, fy, W - 72, fh, { fill: t.tile, stroke: t.line, sw: 1.2 }),
    text(64, fy + 40, ["Verified needs 1 clean cycle. Autopilot merges after the task's clean cycles:", "1 for a small task, 2 for a large task or a task with a risk flag."], { size, weight: 600, fill: t.ink, lh: 1.4 }),
    text(64, f1(fy + 40 + 2 * size * 1.4), ["A tiny task has no review and no QA: it is clean when its checks pass.", "The state tool checks each move. A new commit voids the verdicts."], { size, fill: t.muted, lh: 1.4 }),
  ].join("\n");
  return panel(t, id, W, H, body, "A task's life: framed, briefed, building, reviewing, verifying, verified, merged. A product question holds the task until your answer. Findings or a QA failure send it to repairing, then to review again, at most 3 rounds. Verified needs one clean cycle; autopilot merges after one for a small task, two for a large or risky one. A tiny task has no review and no QA: it is clean when its checks pass.");
}

/** The arena: one brief, N candidates on a mix of Claude models, a judge, one final version. */
function arena(t, id) {
  const W = 1100, H = 740, size = SMALL, my = 236, mr = 44, jx = 550, jy = 506, jr = 56;
  const cands = [["Candidate 1", "Opus · fewest taps", 190], ["Candidate 2", "Sonnet · most control", 550], ["Candidate 3", "Sonnet · reuse screens", 910]];
  const body = [
    backdrop(t, id, W, H, { moon: [jx, jy, 150], seeds: [29, 58], far: [H - 110, 60, 200, 70, 140], near: [H + 30, 90, 240, 80, 170], pagodas: [[1040, H - 130, 0.85], [92, H - 120, 0.75]] }),
    tile(t, id, 330, 36, 440, 100, "One brief", "+ a rubric the candidates don't see", true, { titleY: 42, ...chiefTile(t) }),
    ...cands.map(([, , cx], i) => flow(id, `M${550 + (i - 1) * 110} 140 C ${550 + (i - 1) * 110} 168, ${cx} 150, ${cx} ${my - mr - 14}`, t.edge, "hot", { sw: 2 })),
    ...cands.map(([name, sub, cx]) => seal(t, cx, my, mr, "brush", true, cx) + tile(t, id, cx - 150, 300, 300, 92, name, sub, false, { titleY: 36, size: 24 })),
    ...cands.map(([, , cx], i) => flow(id, `M${cx} 396 C ${cx} 424, ${jx + (i - 1) * 36} 410, ${jx + (i - 1) * 36} ${jy - jr - 14}`, t.edge, "hot", { sw: 2 })),
    seal(t, jx, jy, jr, "scales", true, 3),
    tile(t, id, 156, jy - 50, 300, 116, "Arena judge", ["scores, picks a base,", "grafts the best parts"], false, { titleY: 38, size: 24 }),
    flow(id, `M${jx + jr + 12} ${jy} L 660 ${jy}`, t.edge, "hot", { sw: 2 }),
    tile(t, id, 666, jy - 46, 220, 92, "Final version", "one design", true, { titleY: 36, size: 24 }),
    flow(id, `M892 ${jy} L 936 ${jy}`, t.edge, "hot", { sw: 2 }),
    text(946, jy - 6, ["reviews", "and QA"], { size, fill: t.muted, lh: 1.25 }),
    rect(36, 616, W - 72, 2 * size * 1.4 + 34, { fill: t.tile, stroke: t.line, sw: 1.2 }),
    text(W / 2, 656, ["All converge → keep the shared shape.", "Wildly different → re-frame the brief once, then ask you."], { size, fill: t.ink, anchor: "middle", lh: 1.4 }),
  ].join("\n");
  return panel(t, id, W, H, body, "The arena: one brief and a hidden rubric go to three candidates on a mix of Claude models, each with a different angle. The arena judge scores them, picks a base and grafts the best parts into one final version, which then goes through reviews and QA.");
}

/** Following pstack: a weekly sync, your overrides, one build. */
function pstack(t, id) {
  const W = 1100, H = 570;
  const body = [
    backdrop(t, id, W, H, { moon: [972, 140, 110], seeds: [37, 66], far: [H - 80, 60, 180, 70, 140], near: [H + 40, 90, 220, 80, 170], pagodas: [[150, H - 40, 0.9]] }),
    heading(t, 36, 62, "FOLLOWING PSTACK, EVERY WEEK"),
    tile(t, id, 36, 140, 180, 120, "pstack", ["by Lauren Tan", "(poteto)"], false, { titleY: 42 }),
    flow(id, "M222 200 L 322 200", t.edge, "hot"), text(272, 184, "weekly", { size: SMALL, fill: t.muted, anchor: "middle" }),
    tile(t, id, 330, 140, 240, 120, "upstream/pstack", ["pinned commit", "+ licence"], false, { titleY: 42 }),
    tile(t, id, 330, 300, 240, 100, "principles/", "local versions win", true, { titleY: 42 }),
    flow(id, "M576 200 C 606 200, 606 262, 634 262", t.line, "muted"),
    flow(id, "M576 350 C 606 350, 606 298, 634 298", t.line, "muted"),
    tile(t, id, 642, 224, 184, 112, "Build", "checks + tests", true, { titleY: 44, ...chiefTile(t) }),
    flow(id, "M832 280 L 872 280", t.edge, "hot"),
    emblem(t, 972, 140, 52, id),
    tile(t, id, 880, 224, 184, 112, "sage plugin", "25 principles", false, { titleY: 44 }),
    path("M734 342 L 734 446", { stroke: t.edge, sw: 2, dash: "5 6" }),
    rect(330, 452, 734, 96, { fill: t.tile, stroke: t.line, sw: 1.2 }),
    text(697, 490, "pstack changed a local version?", { size: SMALL, weight: 700, fill: t.ink, anchor: "middle" }),
    text(697, 524, "The update waits for review. Otherwise it merges.", { size: SMALL, fill: t.muted, anchor: "middle" }),
  ].join("\n");
  return panel(t, id, W, H, body, "Following pstack: every week, pstack's principles come into upstream/pstack at a pinned commit. Local versions in principles/ win. The build runs the checks and tests and makes the sage plugin. If pstack changed a principle that has a local version, the update waits for review; otherwise it merges.");
}

/** A tip from the toad sage: its emblem on the left, and the tip on a hanging scroll to the right. */
const tip = (lines, label) => (t, id) => {
  const W = 1100, H = 230 + Math.max(0, lines.length - 3) * 34, size = 24, lh = 1.4;
  const sx = 222, sy = 32, sw = W - 36 - sx, sh = H - 64;
  const ty = f1(sy + (sh - (34 + (lines.length - 1) * size * lh + size)) / 2 + 22);
  const body = [
    backdrop(t, id, W, H, { moon: [120, H / 2, 96], seeds: [31, 47], far: [H - 30, 30, 90, 60, 120], near: [H + 50, 40, 110, 80, 150] }),
    emblem(t, 120, H / 2, 74, id),
    rect(sx, sy, sw, sh, { rx: 0, fill: t.tile, stroke: t.line, sw: 1.2 }),
    rect(sx + 9, sy + 9, sw - 18, sh - 18, { rx: 2, stroke: t.line, sw: 1, opacity: 0.6 }),
    rect(sx - 9, sy - 10, 12, sh + 20, { rx: 6, fill: t.edge, opacity: 0.85 }),
    rect(sx + sw - 3, sy - 10, 12, sh + 20, { rx: 6, fill: t.edge, opacity: 0.85 }),
    rect(sx + sw - 50, sy + sh - 48, 20, 20, { rx: 2, fill: t.accent }),
    text(sx + 40, ty, "TIP", { size: SMALL, weight: 700, fill: t.head, ls: 2 }),
    text(sx + 40, ty + 36, lines, { size, weight: 600, fill: t.ink, lh }),
  ].join("\n");
  return panel(t, id, W, H, body, label);
};

const GRAPHICS = {
  hero, loop, routes, lifecycle, arena, pstack,
  "tip-start": tip(["Send “sage mode” alone to switch it on,", "and “sage mode off” alone to switch it off.", "With any other words, it does nothing."], "The toad sage's tip: send sage mode alone to switch it on, and sage mode off alone to switch it off. With any other words, it does nothing."),
  "tip-try": tip(["Try it on one small, real bug, from your phone.", "Then look at the result, not the code."], "The toad sage's tip: try it on one small, real bug from your phone, then look at the result, not the code."),
  "tip-seal": tip(["Seal the lesson: give a mistake that comes back twice", "a lasting fix. A test or a check in code first; a principle", "or a standing order only when code cannot hold it.", "That's how the dojo gets stronger."], "The toad sage's tip: seal the lesson. Give a mistake that comes back twice a lasting fix: a test or a check in code first; a principle or a standing order only when code cannot hold it. That is how the dojo gets stronger."),
};

/** Every graphic in both themes, as [file name, SVG]. The ids in a file start with its own name and theme, so that
 *  no file depends on another, or on the order in which they are drawn. */
export const files = () => Object.entries(GRAPHICS).flatMap(([name, draw]) => Object.entries(THEMES).map(([theme, t]) => [`${name}-${theme}.svg`, draw(t, `${name}-${theme[0]}`)]));

if (isMain(import.meta.url)) {
  mkdirSync(OUT, { recursive: true });
  const all = files();
  for (const [file, svg] of all) writeFileSync(join(OUT, file), svg);
  console.log(`drew ${all.length} files in docs/assets`);
}
