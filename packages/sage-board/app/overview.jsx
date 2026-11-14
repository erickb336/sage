import { useState } from "react";
import { GiveBox, PairBox, UndoButton, chiefLabel, questionLink, useAccess, useSeen } from "./actions.jsx";
import { when } from "./use-model.js";
import { StateIcon } from "./icons.jsx";
import { milestoneLink, taskLink } from "./panel.jsx";

const plural = (count, one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

export function ago(from, to) {
  const minutes = Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 60000));
  if (!Number.isFinite(minutes)) return null;
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} h ago`;
  return `${Math.round(minutes / 1440)} days ago`;
}

const DAY = 86_400_000;
const after = (list, since) => list.filter(at => at && Date.parse(at) > since).length;
function Counts({ model, previous }) {
  const since = previous ? Date.parse(previous) : Date.parse(model.at) - DAY;
  const known = model.tasks.some(task => task.addedAt), unknown = model.tasks.some(task => !task.addedAt);
  const items = [
    ["merged", after(model.tasks.filter(task => task.state === "merged").map(task => task.doneAt), since), "Merged", "tasks merged into main"],
    ["stuck", after(model.failedAt, since) + model.counts.stuckNow, "Stuck", "runs that failed, or agents silent for 30 min"],
    ["added", known ? after(model.tasks.map(task => task.addedAt), since) : null, "New tasks", !known ? "not known: no task in the logbook has a time when it was added" : unknown ? "tasks added to the logbook; older tasks have no time" : "tasks added to the logbook"],
  ];
  return (
    <section className="counts" aria-labelledby="counts-h">
      <h2 id="counts-h">{previous ? <>Since you looked <span className="hint">· you last opened the board at {when(previous)}, {ago(previous, model.at)}</span></> : "In the last 24 hours"}</h2>
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
        <p className="q">{need.gate && need.logbook ? <a href={questionLink(need.key)}>{need.question}</a> : need.task || need.milestone ? <a href={need.task ? taskLink(need.task.key) : milestoneLink(need.milestone)}>{need.question}</a> : need.question}</p>
        {need.more.length > 0 && <p className="more">{need.more.join(" ")}</p>}
        {need.recommendation && <p className="pick">Recommended: <b>{need.recommendation}</b></p>}
        <p className="meta">
          {need.chief && <span>{need.chief}</span>}
          {need.gate && <span className="mono">{need.gate}</span>}
          {need.task && <a href={taskLink(need.task.key)}>{need.task.id} · {need.task.title}</a>}
          {many && need.project && <span>{need.project}</span>}
          <span>{asked ? `asked ${asked}` : "time not recorded"}</span>
        </p>
      </div>
    </li>
  );
}

function Waits({ answered, chiefs, at }) {
  if (!answered.length) return null;
  return (
    <div className="sub-list" aria-labelledby="waits-h">
      <h3 id="waits-h" className="lbl">Answered · waits for the chief</h3>
      <ul className="needs">{answered.map(item => (
        <li key={item.key} data-answered={item.key}>
          <span className="bullet done" aria-hidden="true" />
          <div>
            <p className="q"><a href={questionLink(item.key)}>{item.question}</a></p>
            <p className="meta"><span>You answered <b>{item.answer}</b> {ago(item.at, at)}</span><span>waits for {chiefLabel(chiefs, item.logbook, item.owner)} to pick it up</span></p>
          </div>
          <UndoButton logbook={item.logbook} gate={item.gateId} />
        </li>
      ))}</ul>
    </div>
  );
}

function Stopped({ model, shown }) {
  const [giving, setGiving] = useState(null);
  const stopped = model.chiefs.filter(chief => chief.stopped && shown(chief.logbook, chief.id));
  if (!stopped.length) return null;
  return (
    <div className="sub-list" aria-labelledby="stopped-h">
      <h3 id="stopped-h" className="lbl">Stopped chiefs</h3>
      <ul className="needs">{stopped.map(chief => {
        const tasks = model.tasks.filter(task => !task.ended && task.chief?.id === chief.id && task.project === chief.project);
        return (
          <li key={chief.key} data-stopped={chief.key}>
            <span className="bullet stopped" aria-hidden="true" />
            <div>
              <p className="q">{chief.id} · {chief.provider} · {chief.name}</p>
              <p className="meta"><span>stopped: no event since {chief.heartbeat ? new Date(chief.heartbeat).toLocaleString([], { hour: "2-digit", minute: "2-digit", day: "numeric", month: "short", hourCycle: "h23" }) : "a time not recorded"} and no running agent</span><span>nothing moves on its own</span></p>
              {tasks.length ? <ul className="owned">{tasks.map(task => {
                const need = model.needs.find(item => item.takeover && item.task?.key === task.key), answered = model.answered.find(item => item.takeover && item.task.key === task.key);
                return (
                  <li key={task.key}>
                    <a href={taskLink(task.key)}>{task.id} · {task.title}</a>
                    {giving === task.key ? <GiveBox task={task} logbook={chief.logbook} from={chief.id} chiefs={model.chiefs} close={() => setGiving(null)} />
                      : need ? <a href={questionLink(need.key)} className="btn">{need.gate} open</a>
                      : answered ? <a href={questionLink(answered.key)} className="btn">{answered.gateId} answered</a>
                      : <button type="button" className="btn" onClick={() => setGiving(task.key)}>Give to another chief</button>}
                  </li>
                );
              })}</ul> : <p className="hint">It owns no open task.</p>}
            </div>
          </li>
        );
      })}</ul>
    </div>
  );
}

function NeedsYou({ model, shown, many }) {
  const writes = useAccess();
  const needs = model.needs.filter(need => shown(need.logbook, need.owner));
  const answered = model.answered.filter(item => shown(item.logbook, item.owner));
  return (
    <section className="card" aria-labelledby="needs-h">
      <div className="card-h">
        <h2 id="needs-h">Needs you</h2>
        {needs.length > 0 && <span className="badge need" aria-label={`${needs.length} open`}>{needs.length}</span>}
        <span className="grow" />
        <span className="hint">Oldest first · {writes === "paired" ? "open a question to answer it here" : "answer in the chief's chat, or pair this browser"}</span>
      </div>
      {needs.length
        ? <ul className="needs">{needs.map(need => <NeedRow key={need.key} need={need} at={model.at} many={many} />)}</ul>
        : <p className="empty">Nothing needs you now.</p>}
      <Waits answered={answered} chiefs={model.chiefs} at={model.at} />
      <Stopped model={model} shown={shown} />
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

export function Overview({ model, shown }) {
  const many = model.projects.length > 1, writes = useAccess(), previous = useSeen(writes);
  return (
    <>
      <div className="page-h">
        <h1>Overview</h1>
        <p>What changed, what needs you, and where each milestone stands.</p>
      </div>
      <PairBox />
      <Counts model={model} previous={previous} />
      <div className="grid">
        <NeedsYou model={model} shown={shown} many={many} />
        <Milestones milestones={model.milestones} hiddenDone={model.hiddenDone} many={many} />
      </div>
    </>
  );
}
