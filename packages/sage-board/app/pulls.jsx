import { Suspense, lazy, useMemo, useState } from "react";
import { ago } from "./overview.jsx";
import { Panel, chiefName, taskLink } from "./panel.jsx";
import { ChiefDot, ofChief } from "./tasks.jsx";

const PAGE = "pull-requests", RECENT_DAYS = 7, DAY = 86_400_000;
const GROUPS = [
  ["need", "Needs you", "Your answer or your merge moves it on. Answer in the chief's chat."],
  ["review", "In review", "Checks, reviews and QA run on the current head."],
  ["repair", "Repairing", "Agents fix what a check or a review found."],
  ["ready", "Ready to merge", "Every clean cycle passed. A chief with autopilot on merges it."],
  ["wait", "Waiting for another task", "It merges only after the task that it waits for."],
  ["merged", "Merged recently", `Merged in the last ${RECENT_DAYS} days.`],
];
const CI = { pass: "CI passes", fail: "CI fails" };
const Graph = lazy(() => import("./graph.jsx").catch(() => ({ default: GraphFailed })));

function GraphFailed() {
  return <p className="empty card" role="alert">The graph could not load from the board server. Reload the page to try again.</p>;
}

const unmet = task => task.waitsFor.some(wait => !wait.met);
function groupOf(task, at) {
  if (task.ended) return task.state === "merged" && task.pr && Date.parse(task.doneAt) > Date.parse(at) - RECENT_DAYS * DAY ? "merged" : null;
  if (!task.pr && !unmet(task)) return null;
  if (task.word === "needs you") return "need";
  if (task.state === "repairing") return "repair";
  if (unmet(task)) return "wait";
  return ["verified", "pr-ready"].includes(task.state) && !task.why ? "ready" : "review";
}

function cyclesText({ cycles }) {
  if (!cycles.reviews) return "No review step";
  return cycles.clean === null ? `Clean cycles not known · ${cycles.required} needed` : `${cycles.clean} of ${cycles.required} clean cycles`;
}


function Row({ task, group, at, prs, selected }) {
  const age = group === "merged" ? task.doneAt && `merged ${ago(task.doneAt, at)}` : task.lastActivity && ago(task.lastActivity, at);
  const line = task.why ?? (group === "wait" ? task.waits : null);
  return (
    <li className="prow" data-pr-task={task.key} aria-current={selected ? "true" : undefined}>
      <span className="num mono">{!task.pr ? <span className="faint">no PR</span> : task.prUrl
        ? <a href={task.prUrl} target="_blank" rel="noopener noreferrer" aria-label={`Pull request ${task.pr} on GitHub`}>#{task.pr}</a>
        : <span title="The logbook names no GitHub repository for this PR">#{task.pr}</span>}</span>
      <div className="what">
        <a className="ttl" href={taskLink(task.key, PAGE)} data-task={task.key}>{task.title}</a>
        <p className="meta">
          <span className="chief">{task.chief && <ChiefDot stopped={task.chief.stopped} />}{chiefName(task.chief)}{task.chief?.stopped && " (stopped)"}</span>
          <span className="mono">{task.id}</span>
          {task.milestone && <span>{task.milestone.title}</span>}
          {task.conflicts.map(other => <span className="badge warn" key={other.key}>may conflict · {other.id}{prs.get(other.key) ? ` #${prs.get(other.key)}` : ""}</span>)}
        </p>
        {line && <p className={`why ${group}`}>{line}</p>}
      </div>
      <span className={`badge word ${(task.word ?? "unknown").replace(" ", "-")}`}>{task.word ?? "unknown"}</span>
      <span className="cyc">{task.pr ? cyclesText(task) : "–"}</span>
      <span className={`ci ${task.ci ?? "unknown"}`}>{task.pr ? CI[task.ci] ?? "CI not known" : "–"}</span>
      <span className="age">{age || "–"}</span>
    </li>
  );
}

function graphData(groups) {
  const shown = new Map(groups.flatMap(group => group.tasks.map(task => [task.key, { task, group }])));
  const waits = [...shown.values()].flatMap(({ task }) => task.waitsFor.filter(wait => shown.has(wait.key)).map(wait => ({ from: wait.key, to: task.key, met: wait.met })));
  const conflicts = [...shown.values()].flatMap(({ task }) => task.conflicts.filter(other => shown.has(other.key) && task.key < other.key).map(other => ({ from: task.key, to: other.key })));
  const linked = new Set([...waits, ...conflicts].flatMap(link => [link.from, link.to]));
  const nodes = [...shown.values()].filter(({ task }) => linked.has(task.key)).map(({ task, group }) => ({
    key: task.key, group: group.key, state: group.title, nopr: !task.pr, href: taskLink(task.key, PAGE), title: task.title,
    head: task.pr ? `#${task.pr} · ${task.id}` : `${task.id} · no PR yet`, chief: chiefName(task.chief),
    sub: task.pr ? `${cyclesText(task)} · ${CI[task.ci] ?? "CI not known"}` : task.waits ?? "",
  }));
  return { nodes, waits, conflicts, alone: shown.size - nodes.length };
}

export function Pulls({ model, params, chief = null }) {
  const [view, setView] = useState("list");
  const selected = params.get("task");
  const prs = useMemo(() => new Map(model.tasks.filter(task => task.pr).map(task => [task.key, task.pr])), [model.tasks]);
  const groups = useMemo(() => {
    const map = new Map(GROUPS.map(([key]) => [key, []]));
    for (const task of model.tasks) if (ofChief(task, chief)) map.get(groupOf(task, model.at))?.push(task);
    const newest = (a, b) => (Date.parse(b.doneAt ?? b.lastActivity) || 0) - (Date.parse(a.doneAt ?? a.lastActivity) || 0);
    return GROUPS.map(([key, title, hint]) => ({ key, title, hint, tasks: map.get(key).sort(newest) })).filter(group => group.tasks.length);
  }, [model.tasks, model.at, chief]);
  const open = groups.filter(group => group.key !== "merged").reduce((n, group) => n + group.tasks.filter(task => task.pr).length, 0);
  return (
    <>
      <div className="page-h">
        <h1>Pull requests</h1>
        <p>Grouped by what happens next. A title opens its task; a number opens the PR on GitHub. CI shows what the logbook records.</p>
      </div>
      <div className="toolbar">
        <div className="seg" role="group" aria-label="View">
          {[["list", "List"], ["graph", "Graph"]].map(([key, name]) => <button type="button" key={key} aria-pressed={view === key} onClick={() => setView(key)}>{name}</button>)}
        </div>
        <span className="grow" />
        <span className="hint" role="status">{open} open {open === 1 ? "PR" : "PRs"}</span>
      </div>
      {!groups.length
        ? <p className="empty card">No pull request yet. A task opens one when its build starts.</p>
        : view === "graph"
          ? <Suspense fallback={<p className="loading" role="status">Loading the graph.</p>}><Graph data={graphData(groups)} /></Suspense>
          : groups.map(group => (
            <section className="card group" key={group.key} data-group={group.key} aria-labelledby={`pg-${group.key}`}>
              <div className="card-h">
                <h2 id={`pg-${group.key}`}>{group.title}</h2>
                <span className="hint">{group.tasks.length}</span>
                <span className="grow" />
                <span className="hint">{group.hint}</span>
              </div>
              <ul className="rows">{group.tasks.map(task => <Row key={task.key} task={task} group={group.key} at={model.at} prs={prs} selected={task.key === selected} />)}</ul>
            </section>
          ))}
      {view === "list" && groups.length > 0 && <p className="none">Older merged PRs and abandoned tasks are on the <a href="#tasks">Tasks page</a>.</p>}
      {selected && <Panel taskKey={selected} at={model.at} back={PAGE} />}
    </>
  );
}
