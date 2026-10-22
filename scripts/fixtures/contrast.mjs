// Shared test helper (T349): the WCAG AA text contrast of board pages in a real browser, the SAMPLE DATA pages that
// the contrast tests read, and the theme that a page shows. The ratio is measured on the colour that the page paints behind each text: the backgrounds
// from the root down to the element, with their opacity. A gradient counts by its colour stops, and the worst stop
// gives the ratio. A url() image refuses: its colours are unknown, so it needs a check of its own.
import { buildBoardModel } from "../../packages/sage-core/board-model.mjs";
import assert from "node:assert/strict";
import * as render from "../../packages/sage-core/board-render.mjs";
import { NOW, programsSource } from "./board-programs.mjs";

const { renderAgentsHtml, renderBoardHtml, renderProgramsHtml } = render;
const b64 = value => Buffer.from(value).toString("base64url");
/** The value of one theme token as the board's CSS sets it, for example themeToken("light", "--bg"). */
export const themeToken = (theme, name) => (theme === "light" ? render.LIGHT : render.DARK).split(";").find(item => item.startsWith(`${name}:`)).slice(name.length + 1);
/** The theme that the page shows now: its --scheme ("dark" or "light") and its --bg token. */
export const shownTheme = page => page.locator("body").evaluate(body => ["--scheme", "--bg"].map(name => getComputedStyle(body).getPropertyValue(name).trim()));
/** Asserts that the page shows this theme: first its scheme, then the background token of that theme. */
export async function expectTheme(page, theme, message = "") {
  const [scheme, bg] = await shownTheme(page);
  assert.equal(scheme, theme, message);
  assert.equal(bg, themeToken(theme, "--bg"), message);
}

/**
 * Runs in the page (pass it to page.evaluate). With a list of [kind, selector], it measures each visible element of each
 * selector and throws when a selector finds none. With no list, it measures every visible element with its own text.
 * Each result: { kind, text, ratio, need }, where need is 3 for large text (24 px, or 18.66 px bold) and 4.5 otherwise.
 * A list item [kind, selector, "edge"] measures the control itself (WCAG 1.4.11, need 3): the better of its fill and its
 * border against the colour behind it.
 */
export function measureContrast(list = null) {
  const rgba = text => { const v = text.match(/[\d.]+/g).map(Number); return [v[0], v[1], v[2], v[3] ?? 1]; };
  const over = (front, back) => front.slice(0, 3).map((value, i) => value * front[3] + back[i] * (1 - front[3]));
  const luminance = rgb => rgb.map(value => value / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4).reduce((sum, value, i) => sum + value * [0.2126, 0.7152, 0.0722][i], 0);
  const ratio = (a, b) => { const [low, high] = [luminance(a), luminance(b)].sort((x, y) => x - y); return (high + 0.05) / (low + 0.05); };
  // Every colour that can be behind the element: a gradient gives one candidate for each stop.
  const backs = element => {
    const chain = [];
    for (let node = element; node; node = node.parentElement) chain.unshift(node);
    let bases = [[255, 255, 255]];
    for (const node of chain) {
      const style = getComputedStyle(node);
      const color = rgba(style.backgroundColor);
      if (color[3] > 0) bases = bases.map(base => over(color, base));
      if (style.backgroundImage === "none") continue;
      if (style.backgroundImage.includes("url(")) throw new Error(`An image needs a separate contrast check: ${node.tagName.toLowerCase()}.${node.className}`);
      const stops = [...style.backgroundImage.matchAll(/rgba?\([^)]*\)/g)].map(match => rgba(match[0]));
      if (stops.length) bases = bases.flatMap(base => stops.map(stop => over(stop, base)));
    }
    return bases;
  };
  const measure = (kind, element) => {
    const style = getComputedStyle(element);
    let opacity = 1;
    for (let node = element; node; node = node.parentElement) opacity *= Number(getComputedStyle(node).opacity);
    const color = rgba(style.color), size = parseFloat(style.fontSize);
    const need = size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 700) ? 3 : 4.5;
    const worst = Math.min(...backs(element).map(back => ratio(over([...color.slice(0, 3), color[3] * opacity], back), back)));
    return { kind, text: element.textContent.trim().slice(0, 60), ratio: Math.round(worst * 100) / 100, need };
  };
  const edge = (kind, element) => {
    const style = getComputedStyle(element), looks = [rgba(style.backgroundColor)];
    if (parseFloat(style.borderTopWidth) > 0) looks.push(rgba(style.borderTopColor));
    const worst = Math.min(...backs(element.parentElement).map(back => Math.max(...looks.map(look => ratio(over(look, back), back)))));
    return { kind, text: element.textContent.trim().slice(0, 60), ratio: Math.round(worst * 100) / 100, need: 3 };
  };
  const shown = element => element.getClientRects().length && element.checkVisibility({ visibilityProperty: true, opacityProperty: true }) && !element.closest(".vh");
  if (list) return list.map(([kind, selector, part = "text"]) => {
    const elements = [...document.querySelectorAll(selector)].filter(element => element.getClientRects().length);
    if (!elements.length) throw new Error(`No sample ${kind} ${part}`);
    return elements.map(element => (part === "edge" ? edge : measure)(kind, element));
  });
  return [...document.querySelectorAll("body *")]
    .filter(element => !["SCRIPT", "STYLE", "OPTION"].includes(element.tagName) && !(element instanceof SVGElement) && [...element.childNodes].some(node => node.nodeType === 3 && node.textContent.trim()) && shown(element))
    .map(element => measure(`${element.tagName.toLowerCase()}${element.className ? "." + String(element.className).trim().split(/\s+/).join(".") : ""}`, element));
}

/**
 * The SAMPLE DATA pages of the contrast tests, from the T233 fixture logbook: the board, a task page, the programs list,
 * a program page waiting for approval, the Agents page with a lead, its helpers, a stuck agent and both providers, and
 * the offline snapshot. The snapshot holds its task and program pages; targets gives the address hash that opens each.
 */
export function contrastPages() {
  const source = programsSource(), codex = programsSource("codex", { gates: [], runs: [] }), tables = source.projects[0].tables;
  tables.runs = [
    { id: "R3", task: "T12", role: "lead", status: "running", started: "2026-10-20T11:20:00Z", tokens: "", model: "opus" },
    { id: "R1", task: "T12", role: "code-reviewer", status: "running", started: "2026-10-20T11:30:00Z", tokens: "" },
    { id: "R4", task: "T12", role: "qa", status: "running", started: "2026-10-20T11:40:00Z", tokens: "" },
    { id: "R2", task: "T40", role: "implementer", status: "running", started: "2026-10-20T11:00:00Z", tokens: "" },
  ];
  codex.projects[0].tables.runs = [{ id: "R9", task: "T40", role: "implementer", status: "running", started: "2026-10-20T11:50:00Z", tokens: "" }];
  const now = Date.parse(NOW), lead = "a".repeat(64);
  source.hooks = { present: true, problem: null, helpers: [], slots: [
    { name: "s1", at: now - 2 * 60000, marks: ["ok", "project-sage", "role-sage_lead", "run-R3", `bound-${lead}`] },
    { name: "s2", at: now - 60000, marks: ["ok", "project-sage", "role-sage_code-reviewer", "run-R1", `parent-${lead}`] },
    { name: "s3", at: now - 41 * 60000, marks: ["ok", "project-sage", "role-sage_qa", "run-R4", `parent-${lead}`] },
    { name: "s4", at: now - 3 * 60000, marks: ["ok", "project-sage", "role-sage_implementer", "run-R2"] },
  ] };
  const model = buildBoardModel([source, codex], { now: NOW });
  const task = model.tasks.find(item => item.id === "T12"), program = model.programs.find(item => item.id === "PG3");
  return {
    model,
    pages: {
      board: renderBoardHtml(model, { snapshot: false }),
      task: renderBoardHtml(model, { snapshot: false, taskKey: task.key }),
      programs: renderProgramsHtml(model),
      program: renderProgramsHtml(model, { programKey: program.key }),
      agents: renderAgentsHtml(model),
      snapshot: renderBoardHtml(model),
    },
    targets: { "snapshot task": `#task-${b64(task.key)}`, "snapshot programs": "#programs", "snapshot program": `#program-${b64(program.key)}` },
  };
}
