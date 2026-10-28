import { resolve, sep } from "node:path";
import { checkoutIdentity } from "./board-identity.mjs";
import { readBoardSources } from "./board-reader.mjs";
import { buildBoardModel, projectName } from "./board-model.mjs";
import { renderBoardHtml, renderBoardText, renderTaskText, renderBoardStatus } from "./board-render.mjs";
import { createStateTool } from "./state.mjs";

/**
 * T280: the landing rule of each board source, for buildBoardModel: (source id, head SHA, PR) to { ok, reason }. It is
 * the state tool's own merge check, read-only, on that source's root, so the board never has a second copy of the rule.
 * The root's path leaves the reason: a remote board page shows it.
 */
export function landingRule(sources, logbookKey = null) {
  const { mergeCheck, boardLandingCheck } = createStateTool({ defaultRoot: () => { throw new Error("the board names each root"); } });
  const roots = new Map(sources.map(source => [source.id, source.path]));
  return (id, sha, pr) => {
    const root = roots.get(id), result = logbookKey === null
      ? mergeCheck(sha, { SAGE_HOME: root }, { pr, readOnly: true })
      : boardLandingCheck(sha, { SAGE_HOME: root }, logbookKey.slice(id.length + 1), pr);
    return { ok: result.ok, scope: logbookKey === null ? "all" : "project", reason: result.reason.split(`${root}${sep}`).join("") };
  };
}

const fold = value => String(value).normalize("NFC").toLowerCase();
export function boardView({ sources, scope = "all", project = null, logbookKey = null, taskId = null, format = "chat", now = new Date().toISOString() }) {
  if (!["chat", "task", "status", "html"].includes(format)) throw new TypeError("unknown board format");
  if (taskId !== null && !/^T[1-9]\d*$/.test(taskId)) throw new TypeError("task id must be T followed by a positive number");
  const snapshots = readBoardSources(sources, { now: Date.parse(now), logbookKey });
  const projects = snapshots.flatMap(source => source.projects);
  const current = project && (scope === "this" || logbookKey !== null)
    ? checkoutIdentity(createStateTool({ defaultRoot: () => { throw new Error("the board names each root"); } }).projectRoot(resolve(project))) : null;
  let keys = new Set(projects.map(book => book.key));
  // An exact logbook key (source/folder) chooses that one logbook. Any other scope chooses projects as the board shows them:
  // the Claude and the Codex logbook of one checkout are one project (R1069-3), and two clones stay two.
  if (logbookKey !== null) {
    if (!projects.some(book => book.key === logbookKey && book.checkoutIdentity && book.checkoutIdentity === current)) throw new RangeError("No recorded logbook matches this project.");
    keys = new Set([logbookKey]);
  }
  else if (projects.some(book => book.key === scope && book.checkoutIdentity)) keys = new Set([scope]);
  else if (scope !== "all") {
    const groups = buildBoardModel(snapshots, { now }).projects, bare = name => name.replace(/-[0-9a-f]{6}$/, "");
    let selected;
    if (scope === "this") {
      if (!project) throw new RangeError("this board needs the current project");
      const here = projects.filter(book => book.checkoutIdentity && book.checkoutIdentity === current);
      keys = new Set(here.map(book => book.key));
      selected = [];
    // A scope is any name that the board shows or that the logbook has: its key, its folder with or without the hash, its
    // checkout's folder, or its shown name (the display name, else the upstream or origin repository's name).
    } else selected = groups.filter(group => group.books.every(key => projects.some(book => book.key === key && book.checkoutIdentity)) && [group.key, group.name, ...group.terms, ...group.terms.map(bare), ...projects.filter(book => group.books.includes(book.key)).map(projectName)].some(name => fold(name) === fold(scope)));
    if (scope !== "this") {
      if (!selected.length || selected.length !== 1) throw new RangeError(selected.length ? `The project is ambiguous. Choose: ${selected.flatMap(group => group.books).join(", ")}` : "No recorded project matches this board scope.");
      keys = new Set(selected.flatMap(group => group.books));
    }
  }
  const model = buildBoardModel(snapshots.map(source => ({ ...source, projects: source.projects.filter(book => keys.has(book.key)) })), { now, landing: landingRule(sources, logbookKey) });
  if (taskId) {
    const tasks = model.tasks.filter(task => task.id === taskId);
    if (tasks.length !== 1) {
      if (tasks.length) throw new RangeError(`The task is ambiguous. Choose its project: ${tasks.map(task => task.project).join(", ")}`);
      const nearby = [...new Set(model.tasks.map(task => task.id))].sort((a,b) => Math.abs(Number(a.slice(1)) - Number(taskId.slice(1))) - Math.abs(Number(b.slice(1)) - Number(taskId.slice(1)))).slice(0, 3);
      throw new RangeError(`Unknown task ${taskId}. Nearest recorded ids: ${nearby.join(", ") || "none"}. No task was opened.`);
    }
    return format === "html" ? renderBoardHtml(model, { taskKey: tasks[0].key }) : renderTaskText(tasks[0]);
  }
  if (format === "task") throw new TypeError("task view needs a task id");
  return format === "html" ? renderBoardHtml(model) : format === "status" ? renderBoardStatus(model) : renderBoardText(model);
}
