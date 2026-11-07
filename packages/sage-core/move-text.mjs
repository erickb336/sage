// The texts of the move (T640, PR 7b of the shared logbook), as the owner reads them in the chat: the preview, the move
// gate, the steps and the end check, the stopped move and the map page. Each function takes the plan that the state tool
// made (state.mjs, "The move") and returns text; nothing here reads or writes a file. The words follow the approved
// design (pages/T640/designs/7-move/chat-text.md).

/** A provider's name as a person reads it. */
export const title = (provider) => (provider ? provider[0].toUpperCase() + provider.slice(1) : "Unnamed");
/** The six steps after the gate. Their numbers stay: a stopped move names "step 2 of 6". */
export const STEPS = 6;
const DONE = ["plan saved, new logbook not built yet", "new logbook built, old logbooks not marked yet", "old logbooks marked, checkouts not linked yet", "checkouts linked, plan not removed yet"];
/**
 * New numbers as the preview shows them: each run of numbers in a row as "T4–T6", the runs joined by commas. A finished
 * task of a program takes a number between the open ones, so the open tasks are not always one run (F-T647-3).
 */
const range = (ids) => {
  if (!ids.length) return "none";
  const n = (id) => Number(String(id).replace(/^\D+/, "")), runs = [];
  for (const id of ids) {
    const last = runs.at(-1);
    if (last && n(id) === n(last.at(-1)) + 1) last.push(id);
    else runs.push([id]);
  }
  return runs.map((r) => (r.length === 1 ? r[0] : `${r[0]}–${r.at(-1)}`)).join(", ");
};
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const two = (n) => String(n).padStart(2, "0");
/** The zone of a local time as its offset from UTC ("UTC+05:30", or "UTC"), the clock that the board's times use. */
const zone = (d) => {
  const m = -d.getTimezoneOffset();
  return m ? `UTC${m > 0 ? "+" : "-"}${two(Math.floor(Math.abs(m) / 60))}:${two(Math.abs(m) % 60)}` : "UTC";
};
/**
 * A saved time (UTC, as the tables keep it) in the Mac's own time zone, as the chat shows it (F-T640-15): its clock with
 * its zone ("15:43 UTC+09:00"), so that it agrees with the board's UTC times (F-T640-26), its day ("3 Nov") and its date
 * ("2026-11-03"). A cell that is no time gives empty text.
 */
export function localTime(at) {
  const d = new Date(String(at ?? ""));
  if (Number.isNaN(d.getTime())) return { clock: "", day: "", date: "" };
  return { clock: `${two(d.getHours())}:${two(d.getMinutes())} ${zone(d)}`, day: `${d.getDate()} ${MONTHS[d.getMonth()]}`, date: `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}` };
}
const clock = (at) => localTime(at).clock;
/** The providers of the plan, in its order, each once. */
export const providersOf = (plan) => [...new Set(plan.sources.map((s) => s.provider))];
const by = (rows, provider) => rows.filter((r) => r.provider === provider);
/** "both logbooks", "the logbook" or "the 4 logbooks". */
const books = (n) => (n === 1 ? "the logbook" : n === 2 ? "both logbooks" : `the ${n} logbooks`);
const shortPlan = (plan) => plan.digest.slice(0, 8);

/** The open tasks of a map: not an adopted task, which moves in the row of the task that adopted it, and not a finished task of a program (F-T640-59). */
const opened = (tasks) => tasks.filter((m) => !m.adopted && !m.finished);
/** The counts of the plan, by provider: what the preview shows and what the end check compares. */
export function countsOf(plan, provider) {
  const { map } = plan;
  return {
    tasks: opened(by(map.tasks, provider)).length,
    findings: by(map.findings, provider).length,
    gates: by(map.gates, provider).filter((m) => m.open).length,
    programs: by(map.programs, provider).length,
    standing: by(map.standing, provider).reduce((n, s) => n + s.count, 0),
    // The lines of a later logbook's standing orders that have no number: a continuation or a note under the list (F-T640-21).
    notes: by(map.standing, provider).reduce((n, s) => n + (s.notes ?? 0), 0),
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
    row("open tasks", providers.map((p) => [countsOf(plan, p).tasks, range(ids(opened(by(plan.map.tasks, p))))])),
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
    ...checks.map(([mark, text, ...more]) => [`${mark.padEnd(6)}${text}`, ...more.map((line) => `      ${line}`)].join("\n")),
  ];
  return lines.join("\n");
}

/** The move gate's question: its fixed first line holds the plan, and the next lines are the facts that the owner reads. */
export function gateQuestion(plan, finished, others = [], forks = []) {
  const open = opened(plan.map.tasks).length;
  return [
    `move · plan ${shortPlan(plan)}`,
    `Move the ${plan.folder.slice(0, -7)} project into one shared logbook?`,
    `${open} open tasks move with new numbers. ${finished} finished tasks stay, read-only.`,
    // Each other checkout that the move links, by path, so that the owner can tell a clone from a fork (F-T640-6).
    ...(others.length ? [`The move also links ${others.length === 1 ? "1 other checkout" : `${others.length} other checkouts`} of this repository to the new logbook: ${others.join("; ")}. If one of them is a separate project, answer keep.`] : []),
    // A fork (another GitHub remote) stays out with its own logbook (T646).
    ...(forks.length ? [`The move leaves out ${forks.length === 1 ? "1 fork" : `${forks.length} forks`} of this repository with another GitHub remote: ${forks.join("; ")}. ${forks.length === 1 ? "It keeps its" : "They keep their"} own logbook.`] : []),
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
  const about = (o) => OPTION_TEXT[o] ?? `Only if you do not use ${title(unused)} on this project. Sage writes "${title(unused)}: unused" and does not wait for the ${title(unused)} plugin. This answer counts for every project of this shared root: a later move or a new project does not wait for the ${title(unused)} plugin either.`;
  return [
    `${gate.id} · ${lines[0]}`, ...lines.slice(1),
    ...options.flatMap((o, i) => [`${i + 1} · ${o}${o === gate.recommendation ? " RECOMMENDED" : ""}`, about(o)]),
    `Default: ${gate.default}. Recommendation: ${recommendation}${why}`,
    `What is "plan ${lines[0].slice(-8)}"? A fingerprint of the preview above. You do not need to read it. The move runs only if both logbooks still match it, so your answer covers exactly what you saw. If anything changed, nothing moves and you get a new preview.`,
  ].join("\n");
}

/**
 * What changed between the plan that the owner saw and the plan of the logbooks now. gate: the answered move gate at
 * --gate, which this refusal closes (F-T640-17, F-T640-58). With no gate (at --plan), the plan may also be one that was
 * typed wrong, so the text does not say that a logbook changed (F-T640-62).
 */
export function changedText(asked, plan, shown, gate) {
  if (!gate) return [`refused: plan ${shown} is not the plan of the logbooks now: the preview now gives plan ${shortPlan(plan)}`, `  If plan ${shown} was typed by hand, check its 8 hex. If not, a logbook changed after the preview.`, "Nothing changed. Show the owner the preview again (sage move --preview), then open the gate with its plan."].join("\n");
  const lines = [];
  for (const p of [...new Set([...(asked ? providersOf(asked) : []), ...providersOf(plan)])]) {
    const was = asked ? countsOf(asked, p) : null, now = countsOf(plan, p);
    if (!was) continue;
    const olds = (m) => new Set(opened(by(m.tasks, p)).map((t) => t.old));
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
  return [`refused: the logbooks changed after plan ${shown}`, ...lines, `Nothing changed. ${gate} is closed: its answer covers plan ${shown} only, and a move gate answers once. Show the owner a new preview (sage move --preview), then open a new gate (sage move --plan <plan>).`].join("\n");
}

/** The project name in a plan file's name, <project>-<6 hex>.json: the folder of the new logbook, without its hex. */
const projectOf = (file) => /^([a-z0-9-]+)-[0-9a-f]{6}\.json$/.exec(String(file).split("/").at(-1))?.[1];

/**
 * A move that stopped: every command of the project refuses with this. A plan that stopped at a step names the same
 * command, which finishes it; a plan whose end check did not match names no command (mismatchText). A plan that cannot be
 * read names no project, because sage cannot tell which project it moves (F-T640-22). The texts take the plan file's
 * name for the project, so a plan's own cells print only as numbers that they are checked to be (F-T640-10).
 */
export function stoppedText(plan, file) {
  if (plan === null || plan === undefined) return `refused: a move plan in the shared root cannot be read: ${file}. Sage cannot tell which project it moves, so every project of this shared root refuses. Nothing changed. Ask the owner to check that file: sage never guesses a move.`;
  const project = projectOf(file);
  if (!project || !/^G[1-9]\d*$/.test(plan.gate?.id ?? "") || !Number.isInteger(plan.step) || plan.step < 1 || plan.step > DONE.length) return `refused: a move of this project did not finish, and its plan ${file} is not a whole plan. Nothing changed. Ask the owner to check that file: sage never guesses a move.`;
  // The new logbook is <shared>/<folder>, beside the plan's folder <shared>/moves.
  const parts = String(file).split("/");
  if (plan.mismatch) return mismatchText({ project, file, dir: [...parts.slice(0, -2), parts.at(-1).slice(0, -5)].join("/"), missing: Array.isArray(plan.mismatch) ? plan.mismatch : [] }).join("\n");
  const [built, rest] = DONE[plan.step - 1].split(", ");
  return [
    `refused: the move of project ${project} did not finish`,
    `  stopped after step ${plan.step} of ${STEPS} at ${clock(plan.at)} (${built},`,
    `  ${rest})`,
    "  The plan is saved. Nothing is lost.",
    `  To finish: sage move --gate ${plan.gate.id} (the same command)`,
  ].join("\n");
}

/**
 * The end check did not match the plan (F-T640-11): the move ran steps 2 to 4, but the new logbook lacks a record of the
 * plan. No command fixes this, so the text names no command: it shows what is missing, says to start no work, and gives
 * the owner's steps to set the plan aside. missing: each missing record as "<new> (was <provider> <old>)". The move's own
 * print shows the missing records in its end check, so it leaves them out here (counted: false), and it prints the first
 * line before its steps, so that the refusal starts with it (F-T640-57).
 */
export function mismatchText({ project, file, dir, missing, counted = false }) {
  const shown = missing.filter((m) => /^[\w ().-]{1,80}$/.test(String(m)));
  return [
    `refused: the end check of the move of project ${project} does not match the plan`,
    ...(shown.length && !counted ? [`  missing in the new logbook: ${shown.join(", ")}`] : []),
    "  The move ran, but the new logbook does not hold every record of the plan. Nothing was deleted: each old logbook still holds its records.",
    `  Start no work in this project: every command of it refuses while the plan is at ${file}.`,
    "  Running the move again does not change this. To set the plan aside, the owner:",
    `  1. compares the new logbook ${dir} with the old logbooks and the map ${dir}/move-map.html;`,
    `  2. renames ${file} to ${file}.aside. The commands of this project then use the new logbook as it is.`,
    "  To use the old logbooks again instead, the owner follows the restore steps at the end of the map.",
  ];
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
  // The row of unnumbered standing lines shows only when a later logbook has such a line (F-T640-21).
  const notes = providers.some((p) => countsOf(plan, p).notes || found[p]?.notes) ? [["standing notes", "notes"]] : [];
  const rows = [["tasks (open)", "tasks"], ["findings (open)", "findings"], ["gates (open)", "gates"], ["programs", "programs"], ["standing orders", "standing"], ...notes, ["wait links", "waits"], ["old rows marked", "marked"]].map(([label, key]) => {
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

/**
 * The restore steps by hand, with the warning first. Step 6's dot name holds the plan, so a second restore of the same
 * project after a later move has a free name (F-T640-29).
 */
export function restoreSteps(plan, shown) {
  const { folder } = plan;
  return {
    warning: "To restore by hand (no command does this). Warning: work recorded after the move stays only in the new logbook, and these steps do not bring it back.",
    steps: [
      "Stop every session of this project in Claude and in Codex.",
      "In each old logbook folder, replace tasks.tsv with tasks.before-move.tsv.",
      "In each old logbook folder, delete moved.json.",
      `In ${shown("bindings.tsv")}, delete the rows that name ${folder}.`,
      `In ${shown("projects.tsv")}, delete the row of ${folder}.`,
      // A folder with a dot name is not a logbook to the board or to a later move, so no task shows twice (F-T640-19).
      `Rename the folder ${shown(folder)} to ${shown(`.${folder}.restored-${shortPlan(plan)}`)}: the board reads no folder whose name starts with a dot. Keep it until you are sure.`,
      // Last: while the plan is there, every command of the project refuses, also in the steps above (F-T640-45).
      `If the plan ${shown(`moves/${folder}.json`)} is there (an end check that did not match keeps it), rename it to ${folder}.json.aside: while it is there, every command of this project refuses.`,
    ],
  };
}

/** The end of a move: the map, the backups and the restore steps. */
export function endText(plan, map, backups, shown) {
  const { warning, steps } = restoreSteps(plan, shown);
  return [
    `map:     ${map}`,
    ...backups.map((b, i) => `${i ? "         " : "backups: "}${b}`),
    "",
    warning,
    ...steps.map((s, i) => `${i + 1}. ${s}`),
  ].join("\n");
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
/** Where the map page sends a finished task: a program with an open task moves whole, its finished tasks too (F-T640-59, F-T645-9). */
const FINISHED = "A finished task stays on the board under its old number, unless its program moved: then it moved with its program, and this page lists it.";

/** The old-to-new map as the Mac's own page, beside the new logbook: it may show paths, because it is no shared page. */
export function mapHtml(plan, { at, backups, shown }) {
  const { warning, steps } = restoreSteps(plan, shown);
  const rows = [
    ...plan.map.tasks.map((m) => ["tasks", m.provider, m.old, m.new, m.title + (m.adopted ? " (adopted by the task it moved with)" : "")]),
    ...plan.map.gates.map((m) => ["gates", m.provider, m.old, m.new, m.open ? "open gate" : "answered gate"]),
    ...plan.map.programs.map((m) => ["programs", m.provider, m.old, m.new, "program"]),
    ...plan.map.findings.map((m) => ["findings", m.provider, `${m.task} ${m.old}`, m.new, "open finding"]),
  ];
  // One tab for each kind of row, as the design's map page has them (F-T640-14). A search looks in every kind.
  const kinds = ["tasks", "gates", "programs", "findings"].map((k) => [k, rows.filter(([kind]) => kind === k).length]).filter(([, n]) => n);
  // The board prints the time of the move in UTC: the page says it too, so that both name the same day (F-T640-53).
  const local = localTime(at), utc = new Date(String(at ?? "")), board = Number.isNaN(utc.getTime()) || !/UTC[+-]/.test(local.clock) ? "" : ` (${utc.toISOString().slice(0, 10)} ${utc.toISOString().slice(11, 16)} UTC on the board)`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Move map · ${esc(plan.folder.slice(0, -7))}</title>
<style>
:root{color-scheme:light dark;--bg:#fff;--fg:#1d1d1f;--line:#d6d6d6;--muted:#666}
@media (prefers-color-scheme:dark){:root{--bg:#161616;--fg:#ececec;--line:#3a3a3a;--muted:#a0a0a0}}
body{background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif;margin:0 auto;max-width:960px;padding:16px}
table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}
input{font:inherit;padding:6px 8px;width:100%;max-width:360px;margin:8px 0;box-sizing:border-box}.muted{color:var(--muted)}li,code{overflow-wrap:anywhere}td{overflow-wrap:break-word}td b{white-space:nowrap}
.tabs{display:flex;flex-wrap:wrap;gap:6px;margin:4px 0 10px}.tabs button{font:inherit;padding:4px 12px;border-radius:999px;border:1px solid var(--line);background:var(--bg);color:var(--fg);cursor:pointer}.tabs button[aria-pressed=true]{background:var(--fg);color:var(--bg)}
</style></head><body>
<h1>The move of project ${esc(plan.folder.slice(0, -7))}</h1>
<p>The open tasks of the old logbooks moved into the shared logbook <code>${esc(plan.folder)}</code> on ${esc(local.date)} at ${esc(local.clock)}${esc(board)}. Each moved row has a new number. ${FINISHED}</p>
<label for="find">Find an old or a new number</label><br><input id="find" type="search" placeholder="for example Codex T94">
<div class="tabs" role="group" aria-label="Kind of row">${kinds.map(([k, n], i) => `<button type="button" data-tab="${k}" aria-pressed="${i ? "false" : "true"}">${k[0].toUpperCase()}${k.slice(1)} ${n}</button>`).join("")}</div>
<table><thead><tr><th>Old</th><th>New</th><th>What</th></tr></thead><tbody>
${rows.map(([kind, p, old, now, what]) => `<tr data-kind="${kind}" data-k="${esc(`${p} ${old} ${now}`.toLowerCase())}"${kind === kinds[0]?.[0] ? "" : " hidden"}><td>${esc(title(p))} ${esc(old)}</td><td><b>${esc(now)}</b></td><td>${esc(what)}</td></tr>`).join("\n")}
</tbody></table>
<p class="muted" id="none" hidden>No row has this number. ${FINISHED}</p>
<h2>Backups</h2><ul>${backups.map((b) => `<li><code>${esc(b)}</code></li>`).join("")}</ul>
<h2>Restore by hand</h2><p>${esc(warning)}</p><ol>${steps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>
<script>const f=document.getElementById("find"),n=document.getElementById("none"),tabs=[...document.querySelectorAll("[data-tab]")];let tab=tabs[0]?.dataset.tab;const show=()=>{const q=f.value.trim().toLowerCase();let k=0;for(const r of document.querySelectorAll("tbody tr")){r.hidden=q?!r.dataset.k.includes(q):r.dataset.kind!==tab;k+=!r.hidden}n.hidden=k>0||!q};f.oninput=show;for(const b of tabs)b.onclick=()=>{tab=b.dataset.tab;f.value="";for(const o of tabs)o.setAttribute("aria-pressed",String(o===b));show()}</script>
</body></html>
`;
}
