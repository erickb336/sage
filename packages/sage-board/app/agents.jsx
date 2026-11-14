import { useEffect, useState } from "react";
import { Panel, taskLink } from "./panel.jsx";

const PAGE = "agents", MIN = 60_000;
const STATE = { stuck: "may be stuck", stop: "helper stopped", long: "running long", wait: "waits for its helpers", work: "working", unk: "running" };
const LOOK = ["stuck", "stop", "long"];
const ORDINAL = ["th", "st", "nd", "rd"];
const ordinal = n => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : ORDINAL[n % 10] ?? "th"}`;
const clock = at => Number.isFinite(Date.parse(at)) ? new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }) : "a time not recorded";
export function span(ms) {
  if (!Number.isFinite(ms)) return "–";
  const m = Math.max(0, Math.floor(ms / MIN));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}
const tokens = n => n === null ? "–" : n < 1000 ? `${n}` : `${Math.round(n / 1000)} k`;
const age = (run, now) => span((run.ended ? Date.parse(run.ended) : now) - Date.parse(run.started));
const chiefKey = id => id ?? "none";
const title = text => text ? `${text.charAt(0).toUpperCase()}${text.slice(1)}` : "provider not known";
const chiefTitle = chief => chief.id ? `${chief.id} · ${title(chief.provider)}` : chief.name;
const chiefSub = chief => { const head = `${title(chief.provider)} · `; return chief.name.startsWith(head) ? chief.name.slice(head.length) : chief.name; };

function useNow(at) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { setNow(Date.now()); const timer = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(timer); }, [at]);
  return Math.max(now, Date.parse(at) || 0);
}

export function LimitCounts({ agents }) {
  if (!agents?.length) return null;
  if (agents.length > 1) {
    const running = agents.reduce((n, book) => n + book.running, 0), queued = agents.reduce((n, book) => n + book.queued, 0);
    return <a className="limit" href="#agents">Agents <b>{running} running</b> in {agents.length} projects{queued > 0 && ` · ${queued} queued`}</a>;
  }
  const [book] = agents, full = book.running >= book.limit, leads = book.leads >= book.leadLimit;
  return (
    <>
      <a className={`limit${full ? " full" : ""}`} href="#agents" title="Running agents of every chief, against the project's one limit">
        Agents <b>{book.running} of {book.limit}</b>{book.byChief.map(item => <span key={chiefKey(item.chief)}> · {item.chief ?? "no chief"} {item.count}</span>)}{book.queued > 0 && <b> · {book.queued} queued</b>}
      </a>
      <a className={`limit${leads ? " full" : ""}`} href="#agents" title="Lead runs that run or wait in the queue, against the project's lead limit">Leads <b>{book.leads} of {book.leadLimit}</b></a>
    </>
  );
}

function StateBadge({ run }) {
  if (run.status === "queued") return <span className="badge queued">Queued · {ordinal(run.place ?? 0)}</span>;
  if (run.status !== "running") return <span className={`badge ${run.status === "done" ? "done" : "failed"}`}>{run.status === "done" ? "Done" : run.status}</span>;
  return <span className={`badge ${LOOK.includes(run.state) ? "look" : "running"}`} title={run.why ?? undefined}>{STATE[run.state] ?? "running"}</span>;
}

function AgentRow({ run, now, selected, task = true }) {
  return (
    <li>
      <a className={`arow${run.status === "running" ? "" : " ended"}`} href={taskLink(run.task.key, PAGE)} data-task={run.task.key} data-run={run.id} aria-current={selected ? "true" : undefined}>
        <span className="who"><span className="role">{run.role}</span><span className="mono faint">{run.id}</span></span>
        <span className="atask"><StateBadge run={run} />{task && <span className="tline">{run.task.id} · {run.task.title}</span>}{run.why && LOOK.includes(run.state) && <span className="why">{run.why}</span>}</span>
        <span className="mdl">{run.model ?? "model not recorded"}</span>
        <span className="num">{age(run, now)}</span>
        <span className="num">{tokens(run.tokens)}</span>
      </a>
    </li>
  );
}

function LeadCard({ lead, helpers, queued, now, selected }) {
  const [open, setOpen] = useState(false);
  const live = helpers.filter(run => run.status === "running"), ended = helpers.filter(run => run.status !== "running");
  return (
    <section className="acard" aria-label={`${lead.role} ${lead.id} on ${lead.task.id}`}>
      <a className="acard-h" href={taskLink(lead.task.key, PAGE)} data-task={lead.task.key} data-run={lead.id} aria-current={selected === lead.task.key ? "true" : undefined}>
        <span className="lead-id"><b className="mono">lead · {lead.id}</b> <StateBadge run={lead} /></span>
        <span className="big">{age(lead, now)}</span>
        <span className="tline">{lead.task.id} · {lead.task.title}</span>
        <span className="faint">{lead.model ?? "model not recorded"}</span>
      </a>
      {live.length > 0 && <ul className="arows">{live.map(run => <AgentRow key={run.id} run={run} now={now} selected={selected === run.task.key} task={false} />)}</ul>}
      <div className="acard-f">
        <span>{live.length ? `${live.length} ${live.length === 1 ? "helper" : "helpers"} running` : "No helper running"}{queued > 0 && ` · ${queued} queued`}</span>
        {ended.length > 0 && <button type="button" className="more-ended" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? "Hide" : "Show"} {ended.length} ended {ended.length === 1 ? "helper" : "helpers"}</button>}
      </div>
      {open && <ul className="arows">{ended.map(run => <AgentRow key={run.id} run={run} now={now} selected={false} task={false} />)}</ul>}
    </section>
  );
}

function Queued({ runs, now }) {
  if (!runs.length) return null;
  return (
    <section className="queue" aria-label="Queued">
      <p className="queue-h"><b>Queued</b> <span className="faint">Each run waits for an agent slot. The oldest starts first, when an agent of any chief ends.</span></p>
      <ol className="arows">{runs.map(run => (
        <li key={run.id}>
          <a className="arow" href={taskLink(run.task.key, PAGE)} data-task={run.task.key} data-run={run.id}>
            <span className="who"><span className="role">{run.role}</span><span className="mono faint">{run.id}</span></span>
            <span className="atask"><StateBadge run={run} /><span className="tline">{run.task.id} · {run.task.title}</span></span>
            <span className="mdl">queued {clock(run.started)}</span>
            <span className="num">waits {age(run, now)}</span>
            <span className="num">{ordinal(run.place ?? 0)} in line</span>
          </a>
        </li>
      ))}</ol>
    </section>
  );
}

function ChiefBox({ chief, runs, tasks, now, selected }) {
  const leads = runs.filter(run => run.role === "lead" && run.status === "running");
  const own = runs.filter(run => run.role !== "lead" && !run.lead && run.status === "running");
  const queued = runs.filter(run => run.status === "queued").sort((a, b) => a.place - b.place);
  const running = runs.filter(run => run.status === "running").length;
  const stopped = chief.stopped === true;
  const owned = stopped ? tasks.filter(task => !task.ended && task.chief?.id === chief.id && task.project === chief.project) : [];
  return (
    <section className={`card chief-box${stopped ? " stopped" : ""}`} data-chief={chief.key} aria-labelledby={`chief-${chief.key}`}>
      <div className="card-h">
        <span className={`dot ${stopped ? "stopped" : chief.stopped === false ? "live" : "unknown"}`} aria-hidden="true" />
        <h2 id={`chief-${chief.key}`}>{chiefTitle(chief)}</h2>
        {chief.id && <span className="faint">{chiefSub(chief)}</span>}
        {chief.autopilot !== null && chief.autopilot !== undefined && !stopped && <span className={`badge${chief.autopilot ? " pick" : ""}`}>Autopilot {chief.autopilot ? "on" : "off"}</span>}
        {stopped && <span className="badge">Stopped</span>}
        <span className="grow" />
        <span className="hint">{leads.length} {leads.length === 1 ? "lead" : "leads"} · {running} running{queued.length > 0 && ` · ${queued.length} queued`}</span>
      </div>
      {stopped && (
        <div className="stopped-note">
          <p>No agent runs. Last event {clock(chief.heartbeat)}: the heartbeat stopped. Nothing moves on its own.</p>
          {owned.length > 0 && <p>It owns {owned.map((task, i) => <span key={task.key}>{i > 0 && ", "}<a href={taskLink(task.key, PAGE)} data-task={task.key}>{task.id} · {task.title}</a></span>)}. To give a task to another chief, use the Overview.</p>}
        </div>
      )}
      {!stopped && !running && !queued.length && <p className="empty">No agent runs now.</p>}
      {(leads.length > 0 || own.length > 0) && (
        <div className="acards">
          {leads.map(lead => <LeadCard key={lead.id} lead={lead} helpers={runs.filter(run => run.lead === lead.id && run.status !== "queued")} queued={runs.filter(run => run.lead === lead.id && run.status === "queued").length} now={now} selected={selected} />)}
          {own.length > 0 && (
            <section className="acard own" aria-label={`${chief.id ?? "Chief"}'s own runs`}>
              <div className="acard-h plain"><b className="mono">{chief.id ?? "Chief"} own runs</b><span className="faint">steps that the chief runs with no lead, such as design and PE</span></div>
              <ul className="arows">{own.map(run => <AgentRow key={run.id} run={run} now={now} selected={selected === run.task.key} />)}</ul>
            </section>
          )}
        </div>
      )}
      <Queued runs={queued} now={now} />
    </section>
  );
}

const STEPS = [15, 30, 60, 120, 240].map(m => m * MIN);
function Timeline({ groups, now }) {
  const shown = groups.flatMap(group => group.lanes.map(lane => lane.run));
  if (!shown.length) return null;
  const first = Math.min(...shown.map(run => Date.parse(run.started)).filter(Number.isFinite));
  const step = STEPS.find(ms => (now - Math.min(first, now - 30 * MIN)) / ms <= 6) ?? STEPS.at(-1);
  const start = Math.max(Math.floor(Math.min(first, now - 30 * MIN) / step) * step, now - 6 * step), width = now - start;
  const x = at => `${Math.max(0, Math.min(100, (100 * (at - start)) / width))}%`;
  const ticks = []; for (let at = Math.ceil(start / step) * step; at <= now; at += step) ticks.push(at);
  return (
    <section className="card timeline" aria-labelledby="timeline-h">
      <div className="card-h"><h2 id="timeline-h">Timeline</h2><span className="grow" /><span className="hint">{clock(new Date(start).toISOString())} to now · one lane for each agent, by chief</span></div>
      <div className="lanes">
        <div className="lane ticks" aria-hidden="true"><span /><div className="track">{ticks.map(at => <span key={at} className="tick" style={{ left: x(at) }}>{clock(new Date(at).toISOString())}</span>)}</div></div>
        {groups.map(group => (
          <div key={group.key} className="lane-group">
            <p className="lane-h">{group.title}</p>
            {group.lanes.map(({ run, indent }) => {
              const from = Date.parse(run.started), to = run.ended ? Date.parse(run.ended) : now;
              const bar = run.status === "queued" ? "queued" : run.status === "running" ? LOOK.includes(run.state) ? "look" : "running" : run.status === "done" ? "done" : "failed";
              return (
                <div className="lane" key={run.id}>
                  <span className={`lane-l${indent ? " in" : ""}`}>{run.role} <span className="mono faint">{run.id}</span></span>
                  <div className="track">
                    {ticks.map(at => <i key={at} className="gline" style={{ left: x(at) }} />)}
                    {to >= start && <span className={`lbar ${bar}`} style={{ left: x(from), width: `max(3px, calc(${x(to)} - ${x(from)}))` }} title={`${run.role} ${run.id} · ${run.status} · ${clock(run.started)}${run.ended ? ` to ${clock(run.ended)}` : ""}`} />}
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </div>
      <ul className="legend" aria-label="Bar colours">
        <li><span className="lbar running" />Running</li><li><span className="lbar done" />Done</li><li><span className="lbar failed" />Failed</li><li><span className="lbar look" />Needs a look</li><li><span className="lbar queued" />Queued</li>
      </ul>
    </section>
  );
}

function lanesOf(chief, runs) {
  const lanes = [];
  for (const lead of runs.filter(run => run.role === "lead" && run.status === "running")) lanes.push({ run: lead }, ...runs.filter(run => run.lead === lead.id).map(run => ({ run, indent: true })));
  lanes.push(...runs.filter(run => !lanes.some(lane => lane.run === run) && (run.status === "running" || run.status === "queued")).map(run => ({ run })));
  return { key: chief.key, title: chiefTitle(chief), lanes };
}

function Book({ book, model, chief, selected, now, many }) {
  const chiefs = model.chiefs.filter(item => item.logbook === book.key);
  const loose = book.runs.filter(run => !chiefs.some(item => item.id === run.chief));
  const boxes = [...chiefs, ...(loose.length ? [{ key: `${book.key}/none`, id: null, name: "No chief recorded", provider: null, stopped: null, autopilot: null }] : [])]
    .filter(item => !chief || item.key === chief.key)
    .map(item => ({ chief: item, runs: item.id ? book.runs.filter(run => run.chief === item.id) : loose }));
  const look = book.runs.filter(run => run.status === "running" && LOOK.includes(run.state)).length;
  const full = book.running >= book.limit, leads = book.leads >= book.leadLimit;
  return (
    <div className="book" data-book={book.key}>
      {many && <h2 className="book-h">{book.project}</h2>}
      <div className="kpis agents-kpis" aria-label="Counts against the limits">
        <div className={`kpi${full ? " full" : ""}`} data-count="agents"><div className="n">{book.running} <span>of {book.limit}</span></div><div className="l">agents running{full && " · at the limit"}</div></div>
        <div className={`kpi${leads ? " full" : ""}`} data-count="leads"><div className="n">{book.leads} <span>of {book.leadLimit}</span></div><div className="l">leads{leads && " · at the limit"}</div></div>
        <div className={`kpi${book.queued ? " full" : ""}`} data-count="queued"><div className="n">{book.queued}</div><div className="l">queued</div></div>
        <div className={`kpi${look ? " look" : ""}`} data-count="look"><div className="n">{look}</div><div className="l">{look === 1 ? "needs" : "need"} a look</div></div>
      </div>
      <p className="hint limits-note">One limit for the whole project, shared by every chief in Claude and Codex, from the project's logbook. Chiefs do not count; only running agents do. A lead counts while it runs or waits in the queue.</p>
      {boxes.length ? boxes.map(({ chief: item, runs }) => <ChiefBox key={item.key} chief={item} runs={runs} tasks={model.tasks} now={now} selected={selected} />)
        : <p className="empty card">{chief ? `${chief.id} has no agent in this project.` : "No agent runs now. When a chief starts an agent, it shows here within a few seconds."}</p>}
      <Timeline groups={boxes.map(({ chief: item, runs }) => lanesOf(item, runs)).filter(group => group.lanes.length)} now={now} />
    </div>
  );
}

export function Agents({ model, params, chief = null }) {
  const now = useNow(model.at), selected = params.get("task");
  return (
    <>
      <div className="page-h">
        <h1>Agents</h1>
        <p>Each chief, then its leads, then each lead's helpers, against the project's limits. Open a row to see its task.</p>
      </div>
      {model.agents.length
        ? model.agents.map(book => <Book key={book.key} book={book} model={model} chief={chief} selected={selected} now={now} many={model.agents.length > 1} />)
        : <p className="empty card">No project has a logbook that the board can read for agents.</p>}
      {selected && <Panel taskKey={selected} at={model.at} back={PAGE} />}
    </>
  );
}
