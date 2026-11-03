// The chiefs of a shared logbook and the writer class of each command (T306 design, PR 3). A legacy logbook has neither:
// it has no chiefs.tsv, and no command there names a chief.
//   chiefs.tsv: one row for each chief: id (C<n>), provider, native (the provider's session identity), at.
// A resume keeps its session id on both providers, so it is the same chief. Claude's /clear starts a new id, so a new chief.
import { join } from "node:path";

const COLUMNS = ["id", "provider", "native", "at"];
export const CHIEF = /^C[1-9]\d*$/;
const NATIVE = /^[A-Za-z0-9_.:-]{1,256}$/;
const TASK = /^T[1-9]\d*$/;
/** A table of short rows: a bigger file is not a table of this tool. */
const TABLE_MAX = 1024 * 1024;

const READ = { kind: "read" }, ANY = { kind: "any" }, NEW = { kind: "new" }, OWNER = { kind: "owner" };
const onTask = (task) => ({ kind: "task", task });
/**
 * What a command writes, from its words: the design's table of writer classes, in one place.
 *   read: no guard. owner: the owner's own act, so no chief: a gate answer, which a hook checks, and a logbook repair or
 *   projects rebuild, which the owner may run in a terminal with no hook. any: any chief. new: a chief that gets the task.
 *   task: the owning chief of task, or of the task of run; with recipient, also the chief that the task's open offer
 *   names, so that it can decline the offer. program: the owning chief of each task that it names.
 * A task on an any class is only the place of a lead: such a command changes no task. link is a read here, because a
 * checkout has no chief until it has a row.
 */
export function writerClass(cmd, [sub, id] = []) {
  switch (cmd) {
    case "task": return sub === "add" ? NEW : id === "set" ? onTask(sub) : READ;
    case "claim": case "accept": return NEW;
    case "offer": case "release": return onTask(sub);
    case "cancel": return { ...onTask(sub), recipient: true };
    case "task-adopt": case "round": case "verdict": return onTask(sub);
    case "finding": return onTask(id);
    case "program": return { kind: "program" };
    case "run": return sub === "add" ? onTask(id) : sub === "done" ? { kind: "task", run: id } : sub === "usage" ? ANY : READ;
    case "gate": return sub === "answer" ? OWNER : sub === "replace" ? ANY : sub === "add" ? (id === undefined ? ANY : onTask(id)) : READ;
    case "log": return TASK.test(sub ?? "") ? onTask(sub) : ANY;
    case "observe": return { ...ANY, task: sub };
    case "pages": return id === "record" ? { ...ANY, task: sub } : READ;
    case "standing": return sub === "add" ? ANY : READ;
    case "logbook": return sub === "repair" ? OWNER : READ;
    case "projects": return OWNER;
    case "config": return sub === undefined ? READ : ANY;
    case "init": return ANY;
    default: return READ;
  }
}

/** A command that only a shared logbook has: it moves a task between chiefs. */
export const chiefOnly = (cmd, [sub] = []) => ["claim", "offer", "cancel", "accept", "release"].includes(cmd) || (cmd === "gate" && sub === "replace");

/** The open offer of a task's row: { id, from, to }. An empty cell has none, and so has a cell that does not read as one. */
export function offerOf(task) {
  try {
    const offer = JSON.parse(task.offer || "null");
    return typeof offer?.id === "string" && CHIEF.test(offer.from) && CHIEF.test(offer.to) ? offer : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A replace gate's question, which only gate replace writes, on one line. The owner decides from it with no other page,
 * and the answer reads it back (replaceOf). The title comes last, and replaceOf reads only the fixed start, so a title cannot pass for a rule.
 */
export const replaceQuestion = ({ from, to, task, title, runs, label }) => `Replace chief ${label(from)} of ${task} with ${label(to)}? Runs that end as failed: ${runs.map((r) => `${r.id} (${r.role})`).join(", ") || "none"}. Replace: ${to} owns ${task}, each of those runs ends as failed and work that it did not report may be lost, ${from} can no longer write ${task}, and an open offer is cleared. Then ${to} goes on with ${task}. Keep: nothing changes, and ${from} stays the owning chief. Title of ${task}: ${title}`;
export function replaceOf(gate) {
  const [, from, to, runs] = /^Replace chief (C[1-9]\d*)(?: \(\S+\))? of T[1-9]\d* with (C[1-9]\d*)(?: \(\S+\))?\? Runs that end as failed: (none|R[1-9]\d* \([^)]*\)(?:, R[1-9]\d* \([^)]*\))*)\. Replace: /.exec(gate.question) ?? [];
  return from && { from, to, runs: runs === "none" ? [] : runs.split(", ").map((r) => r.split(" ")[0]) };
}

/**
 * Does chiefs.tsv read as the table: its column names, a cell for each column, a chief id and a session identity on each
 * row, and no id or identity twice? The state tool and the board read the table with this one rule.
 */
export const chiefsWhole = (cols, lines, rows) => cols.join("\t") === COLUMNS.join("\t") && lines.every((line) => line.split("\t").length === COLUMNS.length)
  && rows.every((r) => CHIEF.test(r.id) && r.provider && NATIVE.test(r.native))
  && new Set(rows.map((r) => r.id)).size === rows.length && new Set(rows.map((r) => `${r.provider}\t${r.native}`)).size === rows.length;

export function createChiefs({ now, provider, readRegular, refuse, rowsOf, sheetText, swap }) {
  /** The rows of a logbook's chiefs.tsv. A missing file has no rows. Anything else that does not read as the table refuses. */
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
  /** This session's row, added when it has none. The caller holds the logbook's lock. */
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
