import { StateIcon } from "./icons.jsx";
import { milestoneLink, readLink, taskLink } from "./panel.jsx";

const plural = (count, one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

export function ago(from, to) {
  const minutes = Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 60000));
  if (!Number.isFinite(minutes)) return null;
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} h ago`;
  return `${Math.round(minutes / 1440)} days ago`;
}

function Counts({ counts }) {
  const items = [
    ["merged", counts.merged, "Merged", "tasks merged into main"],
    ["stuck", counts.stuck, "Stuck", "runs that failed, or agents silent for 30 min"],
    ["added", counts.added, "New tasks", counts.added === null ? "not known: the logbook keeps no time when a task is added" : "tasks added to the logbook"],
  ];
  return (
    <section className="counts" aria-labelledby="counts-h">
      <h2 id="counts-h">In the last 24 hours</h2>
      <div className="kpis">
        {items.map(([kind, count, label, hint]) => (
          <div className={`kpi ${kind}`} key={kind} data-count={kind}>
            <div className="n">{count ?? "–"}</div>
            <div className="l"><span className="dot" aria-hidden="true" />{label}</div>
            <div className="h">{hint}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

function NeedRow({ need, at, many }) {
  const asked = need.askedAt ? ago(need.askedAt, at) : null;
  return (
    <li data-need={need.key}>
      <span className="bullet" aria-hidden="true" />
      <div>
        <p className="q">{need.task || need.milestone ? <a href={need.task && need.gate ? readLink(need.task.key, "question", need.gate) : need.task ? taskLink(need.task.key) : milestoneLink(need.milestone)}>{need.question}</a> : need.question}</p>
        {need.more.length > 0 && <p className="more">{need.more.join(" ")}</p>}
        {need.recommendation && <p className="pick">Recommended: <b>{need.recommendation}</b></p>}
        <p className="meta">
          {need.chief && <span>{need.chief}</span>}
          {need.gate && <span className="mono">{need.gate}</span>}
          {need.task && <span>{need.task.id} · {need.task.title}</span>}
          {many && need.project && <span>{need.project}</span>}
          <span>{asked ? `asked ${asked}` : "time not recorded"}</span>
        </p>
      </div>
    </li>
  );
}

function NeedsYou({ needs, at, many }) {
  return (
    <section className="card" aria-labelledby="needs-h">
      <div className="card-h">
        <h2 id="needs-h">Needs you</h2>
        {needs.length > 0 && <span className="badge need" aria-label={`${needs.length} open`}>{needs.length}</span>}
        <span className="grow" />
        <span className="hint">Oldest first · open one for its full context · answer in the chief's chat</span>
      </div>
      {needs.length
        ? <ul className="needs">{needs.map(need => <NeedRow key={need.key} need={need} at={at} many={many} />)}</ul>
        : <p className="empty">Nothing needs you now.</p>}
    </section>
  );
}

function Bar({ merged, moving, total }) {
  const width = part => total ? `${(100 * part) / total}%` : "0%";
  return (
    <svg className="bar" aria-hidden="true" focusable="false">
      <rect className="track" width="100%" height="100%" rx="3" />
      <rect className="moving" width={width(merged + moving)} height="100%" rx="3" />
      <rect className="merged" width={width(merged)} height="100%" rx="3" />
    </svg>
  );
}

function MilestoneRow({ milestone, many }) {
  const parts = [
    milestone.needsYou > 0 && <span className="need" key="need">{milestone.needsYou} {milestone.needsYou === 1 ? "needs" : "need"} you</span>,
    milestone.moving > 0 && <span key="moving">{milestone.moving} in progress</span>,
    milestone.waiting > 0 && <span key="waiting">{milestone.waiting} waiting</span>,
    <span key="pilot">Pilot {milestone.pilot}</span>,
    many && <span key="project">{milestone.project}</span>,
  ].filter(Boolean);
  return (
    <li data-milestone={milestone.key}>
      <StateIcon state={milestone.state} />
      <div>
        <div className="name">
          <a href={milestoneLink(milestone.key)}>{milestone.title}</a>
          {milestone.priority && <span className={`badge prio ${milestone.priority.toLowerCase()}`}>{milestone.priority}</span>}
          <span className="badge">{milestone.word}</span>
        </div>
        {milestone.goal && <p className="goal">{milestone.goal}</p>}
        <p className="sub">{parts}</p>
      </div>
      <Bar merged={milestone.merged} moving={milestone.moving} total={milestone.total} />
      <span className="of">{milestone.merged} of {milestone.total} merged</span>
    </li>
  );
}

function Milestones({ milestones, hiddenDone, many }) {
  return (
    <section className="card" aria-labelledby="milestones-h">
      <div className="card-h">
        <h2 id="milestones-h">Milestones</h2>
        <span className="grow" />
        <span className="hint">By priority · {plural(milestones.length, "milestone")}</span>
      </div>
      {milestones.length
        ? <ul className="ms">{milestones.map(milestone => <MilestoneRow key={milestone.key} milestone={milestone} many={many} />)}</ul>
        : <p className="empty">No milestones yet. A milestone starts when you ask for work that needs two or more tasks.</p>}
      {hiddenDone > 0 && <p className="more-done">{plural(hiddenDone, "milestone")} done more than 7 days ago {hiddenDone === 1 ? "is" : "are"} not shown.</p>}
    </section>
  );
}

export function Overview({ model }) {
  const many = model.projects.length > 1;
  return (
    <>
      <div className="page-h">
        <h1>Overview</h1>
        <p>What needs you, and where each milestone stands. This page only reads the logbook.</p>
      </div>
      <Counts counts={model.counts} />
      <div className="grid">
        <NeedsYou needs={model.needs} at={model.at} many={many} />
        <Milestones milestones={model.milestones} hiddenDone={model.hiddenDone} many={many} />
      </div>
    </>
  );
}
