import { join } from "node:path";

const COLUMNS = ["id", "provider", "native", "at"];
export const CHIEF = /^C[1-9]\d*$/;
const NATIVE = /^[A-Za-z0-9_.:-]{1,256}$/;
const TASK = /^T[1-9]\d*$/;
const TABLE_MAX = 1024 * 1024;

const READ = { kind: "read" }, ANY = { kind: "any" }, NEW = { kind: "new" }, OWNER = { kind: "owner" };
const onTask = (task) => ({ kind: "task", task });
export function writerClass(cmd, [sub, id] = []) {
  switch (cmd) {
    case "task": return sub === "add" ? NEW : id === "set" ? onTask(sub) : READ;
    case "claim": case "accept": return NEW;
    case "offer": case "unclaim": return onTask(sub);
    case "release": return TASK.test(sub ?? "") ? onTask(sub) : sub === "add" ? ANY : READ;
    case "cancel": return { ...onTask(sub), recipient: true };
    case "task-adopt": case "round": case "verdict": return onTask(sub);
    case "finding": return onTask(id);
    case "milestone": case "program": return id === "set" ? ANY : { kind: "milestone" };
    case "run": return sub === "add" ? onTask(id) : sub === "done" ? { kind: "task", run: id } : sub === "usage" ? ANY : READ;
    case "gate": return sub === "answer" ? OWNER : sub === "replace" ? ANY : sub === "add" ? (id === undefined ? ANY : onTask(id)) : READ;
    case "log": return TASK.test(sub ?? "") ? onTask(sub) : ANY;
    case "observe": return { ...ANY, task: sub };
    case "pages": return id === "record" ? { ...ANY, task: sub } : READ;
    case "standing": return sub === "add" ? ANY : READ;
    case "logbook": return sub === "repair" ? OWNER : READ;
    case "projects": return OWNER;
    case "move": return OWNER;
    case "config": return sub === undefined ? READ : ANY;
    case "init": return ANY;
    default: return READ;
  }
}

export const chiefOnly = (cmd, [sub] = []) => ["claim", "offer", "cancel", "accept", "unclaim"].includes(cmd) || (cmd === "release" && TASK.test(sub ?? "")) || (cmd === "gate" && sub === "replace");

export function offerOf(task) {
  try {
    const offer = JSON.parse(task.offer || "null");
    return typeof offer?.id === "string" && CHIEF.test(offer.from) && CHIEF.test(offer.to) ? offer : undefined;
  } catch {
    return undefined;
  }
}

export const replaceQuestion = ({ from, to, task, pr, title, runs, label, released, moved, fresh, offered }) => {
  const what = `${task}${pr ? ` and PR ${pr}` : ""}`;
  const ask = from ? `Hand ${what} from ${label(from)} to ${label(to)}?` : `Hand ${what} to ${label(to)}? ${task} has no owning chief${released ? `: ${label(released)} unclaimed it last` : moved ? `: it came in the move from the ${moved} logbook` : ""}.`;
  const approve = [`${to} owns ${task}.`, runs.length ? "Each of those runs ends as failed, and work that it did not report may be lost." : "", from ? `${from} can no longer write ${task}.` : "", "The answer clears an open offer.",
    `The branch keeps its name${pr ? `, and PR ${pr} keeps its number` : ""}.`, fresh ? `The verdicts stay, and ${to} runs one fresh cycle on its head before it merges.` : "The verdicts on its head still count."].filter(Boolean).join(" ");
  const decline = offered ? `${from} stays the owning chief, and ${OFFER_ENDS(to)}` : `nothing changes, and ${from ? `${from} stays the owning chief` : `${task} stays with no owning chief`}`;
  return `${ask} Runs that end as failed: ${runs.map((r) => `${r.id} (${r.role})`).join(", ") || "none"}. Approve: ${approve} Decline: ${decline}. Title of ${task}: ${title}`;
};
const OFFER_ENDS = (to) => `the offer to ${to} ends`;
export const TAKEOVER_OPTIONS = "approve|decline";
const ID = (c) => `(?<${c}>C[1-9]\\d*)(?: \\((?<${c}P>\\S+)\\))?`, RUNS = "(?<runs>none|R[1-9]\\d* \\([^)]*\\)(?:, R[1-9]\\d* \\([^)]*\\))*)";
const HAND = new RegExp(`^Hand T[1-9]\\d*(?: and PR [1-9]\\d*)? (?:from ${ID("from")} to ${ID("to")}\\?|to ${ID("to2")}\\? T[1-9]\\d* has no owning chief(?:: (?:${ID("rel")} (?:unclaimed|released) it last|it came in the move from the (?<moved>\\S+) logbook))?\\.) Runs that end as failed: ${RUNS}\\. Approve: (?<approve>.*?) Decline: (?<decline>[^.]*)\\. `);
const REPLACE = new RegExp(`^Replace chief ${ID("from")} of T[1-9]\\d* with ${ID("to")}\\? Runs that end as failed: ${RUNS}\\. Replace: `);
export function replaceOf(gate) {
  const { from = "", fromP, to, toP, to2, to2P, relP, moved, runs, approve, decline } = (HAND.exec(gate.question) ?? REPLACE.exec(gate.question))?.groups ?? {};
  const chief = to ?? to2;
  return chief && { from, to: chief, fromProvider: fromP ?? relP ?? moved, toProvider: toP ?? to2P, runs: runs === "none" ? [] : runs.split(", ").map((r) => r.split(" ")[0]),
    fresh: !!approve?.endsWith(`The verdicts stay, and ${chief} runs one fresh cycle on its head before it merges.`), offered: !!from && decline === `${from} stays the owning chief, and ${OFFER_ENDS(chief)}` };
}
export const crossed = (p) => (p.fromProvider || p.from ? p.fromProvider !== p.toProvider || !p.toProvider : false);

export const chiefsWhole = (cols, lines, rows) => cols.join("\t") === COLUMNS.join("\t") && lines.every((line) => line.split("\t").length === COLUMNS.length)
  && rows.every((r) => CHIEF.test(r.id) && r.provider && NATIVE.test(r.native))
  && new Set(rows.map((r) => r.id)).size === rows.length && new Set(rows.map((r) => `${r.provider}\t${r.native}`)).size === rows.length;

export function createChiefs({ now, provider, readRegular, refuse, rowsOf, sheetText, swap }) {
  function chiefs(dir) {
    const file = join(dir, "chiefs.tsv");
    const damaged = () => refuse(`${file} is damaged, so sage cannot tell which chief owns a task. Nothing changed. Ask the user to fix it, or update the sage plugin if a newer sage wrote it.`);
    let text;
    try {
      text = readRegular(file, { link: false, max: TABLE_MAX });
    } catch {
      damaged();
    }
    if (text === undefined) return [];
    const { cols, lines } = sheetText(text), rows = rowsOf({ cols, lines });
    if (!chiefsWhole(cols, lines, rows)) damaged();
    return rows;
  }
  const rowOf = (dir, native) => chiefs(dir).find((r) => r.provider === provider && r.native === native);
  function chiefRow(dir, native) {
    if (!provider || !NATIVE.test(native ?? "")) refuse("sage has no session identity for this chief, so it cannot name the chief of this write. Nothing changed.");
    const rows = chiefs(dir), found = rowOf(dir, native);
    if (found) return found;
    const row = { id: `C${Math.max(0, ...rows.map((r) => Number(r.id.slice(1)))) + 1}`, provider, native, at: now() };
    swap(join(dir, "chiefs.tsv"), `${[COLUMNS, ...[...rows, row].map((r) => COLUMNS.map((c) => r[c]))].map((cells) => cells.join("\t")).join("\n")}\n`);
    return row;
  }
  return { chiefs, chiefRow, rowOf };
}
