import { useEffect, useMemo, useState } from "react";
import { ago } from "./overview.jsx";
import { Panel, chiefName, taskLink } from "./panel.jsx";

const PRIORITIES = ["P0", "P1", "P2", "P3"];
const WORDS = ["needs you", "in progress", "waiting", "not started", "done", "stopped"];
const NONE = "—";
const order = (list, value) => (list.indexOf(value) + 1 || list.length + 1);
const number = id => Number(String(id).replace(/^\D+/, "")) || 0;

const GROUPS = {
  milestone: { name: "Milestone", of: task => task.milestone?.key ?? "", title: task => task.milestone?.title ?? "No milestone" },
  priority: { name: "Priority", of: task => task.priority ?? "", title: task => task.priority ?? "No priority", rank: key => order(PRIORITIES, key) },
  chief: { name: "Chief", of: task => chiefName(task.chief), title: task => chiefName(task.chief), rank: key => key === "No chief" ? 1 : 0 },
  state: { name: "State", of: task => task.word ?? "", title: task => task.word ?? "State not known", rank: key => order(WORDS, key) },
};
const FILTERS = [
  ["chief", "Chief", task => chiefName(task.chief)],
  ["provider", "Provider", task => task.chief?.provider ?? NONE],
  ["priority", "Priority", task => task.priority ?? NONE],
  ["kind", "Kind", task => task.kind ?? NONE],
  ["word", "State", task => task.word ?? NONE],
];

const UNKNOWN = "Chief liveness not known";
export const ChiefDot = ({ stopped }) => stopped === false ? <span className="dot live" aria-hidden="true" />
  : stopped ? <span className="dot" aria-hidden="true" /> : <span className="dot unknown" role="img" aria-label={UNKNOWN} title={UNKNOWN} />;

function Row({ task, at, selected }) {
  const age = task.lastActivity ? ago(task.lastActivity, at) : null;
  return (
    <li>
      <a className={`row${task.ended ? " ended" : ""}`} href={taskLink(task.key)} data-task={task.key} aria-current={selected ? "true" : undefined}>
        <span className={`badge prio ${(task.priority ?? "none").toLowerCase()}`}>{task.priority ?? NONE}</span>
        <span className="mono id">{task.id}</span>
        <span className="title">
          <span className="text">{task.title}</span>
          {task.kind && <span className="kind">{task.kind}</span>}
          {task.conflicts.length > 0 && <span className="badge warn">may conflict · {task.conflicts.map(other => other.id).join(", ")}</span>}
          {task.waits && !task.ended && <span className="badge" title={task.waits}>waits</span>}
        </span>
        <span className={`badge word ${(task.word ?? "unknown").replace(" ", "-")}`}>{task.word ?? "unknown"}</span>
        <span className="chief">{task.chief && <ChiefDot stopped={task.chief.stopped} />}{chiefName(task.chief)}{task.chief?.stopped && " (stopped)"}{task.chief?.waits && " (waits for you)"}</span>
        <span className={`step ${task.step?.status ?? ""}`}>{task.step?.label ?? (task.ended ? "" : NONE)}</span>
        <span className="mono pr">{task.pr ? `#${task.pr}` : NONE}</span>
        <span className="age">{age ?? NONE}</span>
      </a>
    </li>
  );
}

function Group({ group, milestone, at, selected, focus, open, toggle }) {
  const ended = group.tasks.filter(task => task.ended), live = group.tasks.filter(task => !task.ended);
  return (
    <section className={`card group${focus ? " focus" : ""}`} data-group={group.key} aria-labelledby={`g-${group.id}`}>
      <div className="card-h">
        <h2 id={`g-${group.id}`}>{group.title}</h2>
        <span className="hint">{live.length} open</span>
        <span className="grow" />
        {milestone && <span className="hint">{milestone.merged} of {milestone.total} merged</span>}
      </div>
      {live.length > 0 && <ul className="rows">{live.map(task => <Row key={task.key} task={task} at={at} selected={task.key === selected} />)}</ul>}
      {ended.length > 0 && (
        <>
          <button type="button" className="more-ended" aria-expanded={open} onClick={toggle}>
            {open ? "Hide" : "Show"} {ended.length} ended {ended.length === 1 ? "task" : "tasks"} (merged, concluded or abandoned)
          </button>
          {open && <ul className="rows">{ended.map(task => <Row key={task.key} task={task} at={at} selected={task.key === selected} />)}</ul>}
        </>
      )}
    </section>
  );
}

export const ofChief = (task, chief) => !chief || task.project === chief.project && task.chief?.id === chief.id;

export function Tasks({ model, params, chief = null }) {
  const [group, setGroup] = useState("milestone");
  const [filters, setFilters] = useState({});
  const [opened, setOpened] = useState(() => new Set());
  const selected = params.get("task"), focus = params.get("milestone");
  useEffect(() => {
    if (!focus) return;
    setGroup("milestone");
    requestAnimationFrame(() => document.querySelector(`[data-group="${CSS.escape(focus)}"]`)?.scrollIntoView({ block: "start" }));
  }, [focus]);

  const options = useMemo(() => Object.fromEntries(FILTERS.map(([key, , value]) => [key, [...new Set(model.tasks.map(value))].sort((a, b) => key === "word" ? order(WORDS, a) - order(WORDS, b) : a.localeCompare(b))])), [model.tasks]);
  const shown = useMemo(() => model.tasks.filter(task => ofChief(task, chief) && FILTERS.every(([key, , value]) => !filters[key] || value(task) === filters[key])), [model.tasks, filters, chief]);
  const groups = useMemo(() => {
    const how = GROUPS[group], rank = new Map(model.milestones.map((milestone, i) => [milestone.key, i])), map = new Map();
    for (const task of shown) { const key = how.of(task); if (!map.has(key)) map.set(key, { key: key || "none", title: how.title(task), tasks: [] }); map.get(key).tasks.push(task); }
    const sortKey = item => group === "milestone" ? (item.key === "none" ? Infinity : rank.get(item.key) ?? 1e6 + number(item.key.split("/").at(-1))) : how.rank?.(item.key === "none" ? "" : item.key) ?? 0;
    const sorted = [...map.values()].sort((a, b) => (a.tasks.every(task => task.ended) - b.tasks.every(task => task.ended)) || sortKey(a) - sortKey(b) || a.title.localeCompare(b.title));
    for (const item of sorted) item.tasks.sort((a, b) => b.needsYou - a.needsYou || order(PRIORITIES, a.priority) - order(PRIORITIES, b.priority) || number(a.id) - number(b.id));
    return sorted.map((item, i) => ({ ...item, id: i }));
  }, [shown, group, model.milestones]);

  const open = shown.filter(task => !task.ended).length;
  const toggle = key => setOpened(previous => { const next = new Set(previous); next.has(`${group}:${key}`) ? next.delete(`${group}:${key}`) : next.add(`${group}:${key}`); return next; });
  const milestones = new Map(model.milestones.map(milestone => [milestone.key, milestone]));
  return (
    <>
      <div className="page-h">
        <h1>Tasks</h1>
        <p>Open a task to see where it is in its dev cycle, which chief owns it, and what its agents made.</p>
      </div>
      <div className="toolbar">
        <div className="seg" role="group" aria-label="Group by">
          <span className="lbl">Group by</span>
          {Object.entries(GROUPS).map(([key, item]) => <button type="button" key={key} aria-pressed={group === key} onClick={() => setGroup(key)}>{item.name}</button>)}
        </div>
        {FILTERS.map(([key, label]) => (
          <label className="filter" key={key}>{label}
            <select aria-label={label} value={filters[key] ?? ""} onChange={event => setFilters({ ...filters, [key]: event.target.value })}>
              <option value="">All</option>
              {options[key].map(value => <option key={value} value={value}>{value === NONE ? "None" : value}</option>)}
            </select>
          </label>
        ))}
        <span className="grow" />
        <span className="hint" role="status">{chief && `${chief.id}'s work · `}{open} open · {shown.length - open} ended</span>
      </div>
      {groups.length
        ? groups.map(item => <Group key={item.key} group={item} milestone={group === "milestone" ? milestones.get(item.key) : null} at={model.at} selected={selected} focus={group === "milestone" && item.key === focus} open={opened.has(`${group}:${item.key}`)} toggle={() => toggle(item.key)} />)
        : <p className="empty card">{model.tasks.length ? "No task matches these filters." : "No tasks yet. A task starts when you ask the chief for a change."}</p>}
      {selected && <Panel taskKey={selected} at={model.at} />}
    </>
  );
}
