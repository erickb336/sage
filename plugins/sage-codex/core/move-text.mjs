// The texts of the move (T640, PR 7b of the shared logbook), as the owner reads them in the chat: the preview, the move
// gate, the steps and the end check, the stopped move and the map page. Each function takes the plan that the state tool
// made (state.mjs, "The move") and returns text; nothing here reads or writes a file. The words follow the approved
// design (pages/T640/designs/7-move/chat-text.md).

/** A provider's name as a person reads it. */
export const title = (provider) => (provider ? provider[0].toUpperCase() + provider.slice(1) : "Unnamed");
/** The six steps after the gate. Their numbers stay: a stopped move names "step 2 of 6". */
export const STEPS = 6;
const DONE = ["plan saved, new logbook not built yet", "new logbook built, old logbooks not marked yet", "old logbooks marked, checkouts not linked yet", "checkouts linked, plan not removed yet"];
const range = (ids) => (!ids.length ? "none" : ids.length === 1 ? ids[0] : `${ids[0]}–${ids.at(-1)}`);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** HH:MM of a saved time (UTC, as the tables keep it). */
const clock = (at) => String(at ?? "").slice(11, 16);
/** The providers of the plan, in its order, each once. */
export const providersOf = (plan) => [...new Set(plan.sources.map((s) => s.provider))];
const by = (rows, provider) => rows.filter((r) => r.provider === provider);
/** "both logbooks", "the logbook" or "the 4 logbooks". */
const books = (n) => (n === 1 ? "the logbook" : n === 2 ? "both logbooks" : `the ${n} logbooks`);
const shortPlan = (plan) => plan.digest.slice(0, 8);

/** The counts of the plan, by provider: what the preview shows and what the end check compares. */
export function countsOf(plan, provider) {
  const { map } = plan;
  return {
    tasks: by(map.tasks, provider).filter((m) => !m.adopted).length,
    findings: by(map.findings, provider).length,
    gates: by(map.gates, provider).filter((m) => m.open).length,
    programs: by(map.programs, provider).length,
    standing: by(map.standing, provider).reduce((n, s) => n + s.count, 0),
    waits: map.waits[provider] ?? 0,
    marked: by(map.tasks, provider).length,
  };
}

/** The preview: what moves by provider, what stays, the next numbers and the checks. Read only. */
export function previewText(plan, checks) {
  const providers = providersOf(plan), name = plan.folder.slice(0, -7);
  const row = (label, cells) => `${label.padEnd(18)}${cells.map(([n, text], i) => `${i ? "  " : ""}${String(n).padStart(3)}  ${i < cells.length - 1 ? text.padEnd(11) : text}`).join("")}`;
  const ids = (rows) => rows.map((m) => m.new);
  const standing = (p) => {
    const parts = by(plan.map.standing, p), count = parts.reduce((n, s) => n + s.count, 0);
    if (!count) return [0, "none"];
    const first = parts.find((s) => s.count)?.first, last = parts.filter((s) => s.count).at(-1)?.last;
    return [count, `${parts.some((s) => s.base) ? "keep" : "become"} ${first}–${last}`];
  };
  const lines = [
    `${`Move preview · project ${name}`.padEnd(39)}plan ${shortPlan(plan)}`,
    "Read only. Nothing changed.",
    "",
    `${"What moves".padEnd(21)}${providers.map((p) => title(p).padEnd(17)).join("").trimEnd()}`,
    row("open tasks", providers.map((p) => [countsOf(plan, p).tasks, range(ids(by(plan.map.tasks, p).filter((m) => !m.adopted)))])),
    row("open findings", providers.map((p) => [countsOf(plan, p).findings, "new keys"])),
    row("open gates", providers.map((p) => [countsOf(plan, p).gates, range(ids(by(plan.map.gates, p).filter((m) => m.open)))])),
    ...(plan.map.gates.some((m) => !m.open) ? [row("answered gates", providers.map((p) => [by(plan.map.gates, p).filter((m) => !m.open).length, range(ids(by(plan.map.gates, p).filter((m) => !m.open)))]))] : []),
    row("programs", providers.map((p) => [countsOf(plan, p).programs, range(ids(by(plan.map.programs, p)))])),
    row("standing orders", providers.map(standing)),
    "",
    `What stays (read-only, "Old" on the board)`,
    `${"finished tasks".padEnd(18)}${providers.map((p, i) => String(plan.map.finished[p] ?? 0).padStart(i ? 18 : 3)).join("")}`,
    "runs, verdicts and kept reports never move",
    `${"next numbers".padEnd(18)}${["T", "R", "G", "PG"].map((p) => plan.next[p]).join(" · ")}`,
    "",
    "Checks",
    ...checks.map(([mark, text, more]) => `${mark.padEnd(6)}${text}${more ? `\n      ${more}` : ""}`),
  ];
  return lines.join("\n");
}

/** The move gate's question: its fixed first line holds the plan, and the next lines are the facts that the owner reads. */
export function gateQuestion(plan, finished) {
  const open = plan.map.tasks.filter((m) => !m.adopted).length;
  return [
    `move · plan ${shortPlan(plan)}`,
    `Move the ${plan.folder.slice(0, -7)} project into one shared logbook?`,
    `${open} open tasks move with new numbers. ${finished} finished tasks stay, read-only.`,
    "Hard to undo. No command undoes the move. Each old logbook keeps a backup copy of its task table, and I give you the steps to restore by hand.",
    "Start no work in Claude or Codex until I report the end.",
    // F-T641-16: plugins.tsv shows the last command of each provider, so a session that started before the update can still run old code.
    "Before you answer, check that every Claude and Codex session of this project restarted after the update.",
  ];
}

const OPTION_TEXT = {
  move: "Moves the project now, exactly as in the preview.",
  keep: "Nothing changes. Both logbooks keep working. Ask again any time.",
};
/** The gate as the chief puts it to the owner word for word: the question's lines, the options, the default and the plan box. */
export function gateText(gate, lines, { unused, recommendation, why }) {
  const options = String(gate.options).split("|");
  const about = (o) => OPTION_TEXT[o] ?? `Only if you do not use ${title(unused)} on this project. Sage writes "${title(unused)}: unused" and does not wait for the ${title(unused)} plugin.`;
  return [
    `${gate.id} · ${lines[0]}`, ...lines.slice(1),
    ...options.flatMap((o, i) => [`${i + 1} · ${o}${o === gate.recommendation ? " RECOMMENDED" : ""}`, about(o)]),
    `Default: ${gate.default}. Recommendation: ${recommendation}${why}`,
    `What is "plan ${lines[0].slice(-8)}"? A fingerprint of the preview above. You do not need to read it. The move runs only if both logbooks still match it, so your answer covers exactly what you saw. If anything changed, nothing moves and you get a new preview.`,
  ].join("\n");
}

/** What changed between the plan that the owner saw and the plan of the logbooks now. */
export function changedText(asked, plan, shown) {
  const lines = [];
  for (const p of [...new Set([...(asked ? providersOf(asked) : []), ...providersOf(plan)])]) {
    const was = asked ? countsOf(asked, p) : null, now = countsOf(plan, p);
    if (!was) continue;
    const olds = (m) => new Set(by(m.tasks, p).filter((t) => !t.adopted).map((t) => t.old));
    const before = olds(asked.map), after = olds(plan.map);
    const added = [...after].filter((id) => !before.has(id)), gone = [...before].filter((id) => !after.has(id));
    const diffs = [
      added.length && `${added.length} more open ${added.length === 1 ? "task" : "tasks"} (${added.join(", ")})`,
      gone.length && `${gone.length} fewer open ${gone.length === 1 ? "task" : "tasks"} (${gone.join(", ")})`,
      ...["findings", "gates", "programs", "standing"].map((k) => now[k] !== was[k] && `${Math.abs(now[k] - was[k])} ${now[k] > was[k] ? "more" : "fewer"} ${{ findings: "open findings", gates: "open gates", programs: "programs", standing: "standing orders" }[k]}`),
    ].filter(Boolean);
    if (diffs.length) lines.push(`  ${title(p)}: ${diffs.join(", ")}`);
  }
  if (!lines.length) lines.push(asked ? "  other rows changed: titles, states, waits, numbers or text" : `  the preview now gives plan ${shortPlan(plan)}`);
  return [`refused: the logbooks changed after plan ${shown}`, ...lines, "Nothing changed."].join("\n");
}

/** A move that stopped: every command of the project refuses with this, and the same command finishes it. */
export function stoppedText(plan, file) {
  if (!plan?.gate?.id || !Number.isInteger(plan.step)) return `refused: a move of this project did not finish, and its plan ${file} cannot be read. Nothing changed. Ask the user to check that file: sage never guesses a move.`;
  const [built, rest] = DONE[plan.step - 1].split(", ");
  return [
    `refused: the move of project ${plan.folder.slice(0, -7)} did not finish`,
    `  stopped after step ${plan.step} of ${STEPS} at ${clock(plan.at)} (${built},`,
    `  ${rest})`,
    "  The plan is saved. Nothing is lost.",
    `  To finish: sage move --gate ${plan.gate.id} (the same command)`,
  ].join("\n");
}

/** One line of a step, as the move prints it when the step ends. */
export function stepText(plan, step, others) {
  const n = plan.sources.length, many = n > 1;
  const linked = plan.checkouts.length;
  const extra = providersOf(plan).map((p) => [p, (others ?? []).filter((o) => o.provider === p).length]).filter(([, k]) => k);
  return `${step}/${STEPS} ${[
    "plan saved",
    `new logbook built: ${plan.folder}`,
    `old ${many ? "logbooks" : "logbook"} marked moved (backup ${many ? "copies" : "copy"} kept)`,
    `checkouts linked: ${linked}${others === null ? "" : ` (this one${extra.map(([p, k], i) => `${i === extra.length - 1 ? " and" : ","} ${k} ${title(p)}`).join("")})`}`,
    "plan removed",
    "new logbook read again and counted",
  ][step - 1]}`;
}

/** The first lines of a move: the plan matches, and the locks it holds. */
export function startText(plan, resumed) {
  if (resumed) return [`ok  saved plan found: plan ${shortPlan(plan)}, from step ${plan.step + 1}`];
  const names = providersOf(plan).map((p) => `${title(p)} ${by(plan.sources, p).length > 1 ? "logbooks" : "logbook"}`);
  return [`ok  plan ${shortPlan(plan)} matches ${books(plan.sources.length)}`, `ok  locks: shared root, ${names.join(", ")}`];
}

/**
 * The end check: each table, by provider, plan against found. found holds the same counts as countsOf, read from the new
 * logbook and the old tasks tables again. A mismatch names the rows that the new logbook lacks.
 */
export function reconciliationText(plan, found, missing) {
  const providers = providersOf(plan), wrong = [];
  const rows = [["tasks (open)", "tasks"], ["findings (open)", "findings"], ["gates (open)", "gates"], ["programs", "programs"], ["standing orders", "standing"], ["wait links", "waits"], ["old rows marked", "marked"]].map(([label, key]) => {
    const pairs = providers.map((p) => [countsOf(plan, p)[key], found[p]?.[key] ?? 0]), ok = pairs.every(([a, b]) => a === b);
    if (!ok) wrong.push(label);
    return `${label.padEnd(18)}${pairs.map(([a, b], i) => `${String(a).padStart(i ? 9 : 3)}${String(b).padStart(6)}`).join("")}   ${ok ? "match" : "MISMATCH"}`;
  });
  const finished = providers.map((p) => plan.map.finished[p] ?? 0).join(" + ");
  return [
    `Reconciliation · ${wrong.length ? `${plural(wrong.length, "count does", "counts do")} not match the plan` : "every count matches the plan"}`,
    `${"".padEnd(17)}${providers.map((p) => title(p).padEnd(15)).join("").trimEnd()}`,
    `${"table".padEnd(17)}${providers.map(() => "plan  found").join("    ")}`,
    ...rows,
    `stay, read-only: finished tasks ${finished}; runs, verdicts, reports`,
    ...(missing.length ? [`missing in the new logbook: ${missing.join(", ")}`] : []),
  ].join("\n");
}

/** The restore steps by hand, with the warning first. */
export function restoreSteps(folder, shown) {
  return {
    warning: "To restore by hand (no command does this). Warning: work recorded after the move stays only in the new logbook, and these steps do not bring it back.",
    steps: [
      "Stop every session of this project in Claude and in Codex.",
      "In each old logbook folder, replace tasks.tsv with tasks.before-move.tsv.",
      "In each old logbook folder, delete moved.json.",
      `In ${shown("bindings.tsv")}, delete the rows that name ${folder}.`,
      `In ${shown("projects.tsv")}, delete the row of ${folder}. Keep its folder until you are sure.`,
    ],
  };
}

/** The end of a move: the map, the backups and the restore steps. */
export function endText(plan, map, backups, shown) {
  const { warning, steps } = restoreSteps(plan.folder, shown);
  return [
    `map:     ${map}`,
    ...backups.map((b, i) => `${i ? "         " : "backups: "}${b}`),
    "",
    warning,
    ...steps.map((s, i) => `${i + 1}. ${s}`),
  ].join("\n");
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
/** The old-to-new map as the Mac's own page, beside the new logbook: it may show paths, because it is no shared page. */
export function mapHtml(plan, { at, backups, shown }) {
  const { warning, steps } = restoreSteps(plan.folder, shown);
  const rows = [
    ...plan.map.tasks.map((m) => [m.provider, m.old, m.new, m.title + (m.adopted ? " (adopted by the task it moved with)" : "")]),
    ...plan.map.gates.map((m) => [m.provider, m.old, m.new, m.open ? "open gate" : "answered gate"]),
    ...plan.map.programs.map((m) => [m.provider, m.old, m.new, "program"]),
    ...plan.map.findings.map((m) => [m.provider, `${m.task} ${m.old}`, m.new, "open finding"]),
  ];
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Move map · ${esc(plan.folder.slice(0, -7))}</title>
<style>
:root{color-scheme:light dark;--bg:#fff;--fg:#1d1d1f;--line:#d6d6d6;--muted:#666}
@media (prefers-color-scheme:dark){:root{--bg:#161616;--fg:#ececec;--line:#3a3a3a;--muted:#a0a0a0}}
body{background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif;margin:0 auto;max-width:960px;padding:16px}
table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}
input{font:inherit;padding:6px 8px;width:100%;max-width:360px;margin:8px 0}.muted{color:var(--muted)}code{overflow-wrap:anywhere}
</style></head><body>
<h1>The move of project ${esc(plan.folder.slice(0, -7))}</h1>
<p>The open tasks of the old logbooks moved into the shared logbook <code>${esc(plan.folder)}</code> on ${esc(at.slice(0, 10))}. Each moved row has a new number. A finished task did not move: find it on the board under its old number.</p>
<label for="find">Find an old or a new number</label><br><input id="find" type="search" placeholder="for example Codex T94">
<table><thead><tr><th>Old</th><th>New</th><th>What</th></tr></thead><tbody>
${rows.map(([p, old, now, what]) => `<tr data-k="${esc(`${p} ${old} ${now}`.toLowerCase())}"><td>${esc(title(p))} ${esc(old)}</td><td><b>${esc(now)}</b></td><td>${esc(what)}</td></tr>`).join("\n")}
</tbody></table>
<p class="muted" id="none" hidden>No row has this number. A finished task did not move: find it on the board under its old number.</p>
<h2>Backups</h2><ul>${backups.map((b) => `<li><code>${esc(b)}</code></li>`).join("")}</ul>
<h2>Restore by hand</h2><p>${esc(warning)}</p><ol>${steps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>
<script>const f=document.getElementById("find"),n=document.getElementById("none");f.oninput=()=>{const q=f.value.trim().toLowerCase();let k=0;for(const r of document.querySelectorAll("tbody tr")){r.hidden=!!q&&!r.dataset.k.includes(q);k+=!r.hidden}n.hidden=k>0}</script>
</body></html>
`;
}
