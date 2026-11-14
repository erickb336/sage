import { useEffect, useRef, useState } from "react";

export const taskLink = (key, page = "tasks") => `#${page}?task=${encodeURIComponent(key)}`;
export const milestoneLink = key => `#tasks?milestone=${encodeURIComponent(key)}`;
export const chiefName = chief => chief ? [chief.id, chief.provider].filter(Boolean).join(" · ") || "Chief not known" : "No chief";
const MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");
const pad = n => String(n).padStart(2, "0");
function when(at, now) {
  const date = new Date(at), today = new Date(now);
  if (!at || Number.isNaN(date.getTime())) return "time not recorded";
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return date.toDateString() === today.toDateString() ? clock : `${date.getDate()} ${MONTHS[date.getMonth()]} ${clock}`;
}
const hex = c => c.codePointAt(0).toString(16).padStart(4, "0");
export const controlsShown = text => String(text ?? "").replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, c => ({ "\n": "\\n", "\r": "\\r", "\t": "\\t" })[c] ?? (c.length > 1 ? `\\u{${hex(c)}}` : `\\u${hex(c)}`));
const encodeKey = key => btoa(String.fromCharCode(...new TextEncoder().encode(key))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const STATUS = { done: "done", run: "running", stale: "no news", need: "needs you", fail: "failed", idle: "no agent at work", wait: "", unknown: "not known" };
const TABS = ["Artifacts", "Log", "Decisions"];

function usePanel(key, at) {
  const [state, setState] = useState({ key, data: null, problem: null });
  useEffect(() => {
    const controller = new AbortController();
    fetch(`/app/task/${encodeKey(key)}`, { signal: controller.signal })
      .then(response => response.ok ? response.json() : Promise.reject(response.status))
      .then(data => setState({ key, data, problem: null }))
      .catch(error => { if (!controller.signal.aborted) setState(previous => ({ key, data: previous.key === key ? previous.data : null, problem: error === 404 ? "gone" : "read" })); });
    return () => controller.abort();
  }, [key, at]);
  return state.key === key ? state : { data: null, problem: null };
}

function Cycle({ task }) {
  const { clean, required, reviews } = task.cycles;
  return (
    <section aria-labelledby="cycle-h">
      <div className="sec-h"><h3 id="cycle-h">Dev cycle</h3>
        <span className="hint">{!task.route.length ? "Route not known" : !reviews ? "This route has no review step." : clean === null ? `Clean cycles: not known · ${required} needed` : `Clean cycles: ${clean} of ${required}`}</span>
      </div>
      <ol className="steps">
        {task.steps.map(step => (
          <li key={step.key} className={`st ${step.status}`} aria-current={!["done", "wait"].includes(step.status) ? "step" : undefined}>
            <span className="mark" aria-hidden="true" />
            <div>
              <p className="lbl">{step.label}{STATUS[step.status] && <span className="sw">{STATUS[step.status]}</span>}</p>
              {step.detail && <p className="detail">{step.detail}</p>}
              {step.parts.length > 0 && <p className="parts">{step.parts.map(part => `${part.name}: ${STATUS[part.status] || "waits"}`).join(" · ")}</p>}
            </div>
          </li>
        ))}
      </ol>
      <p className="now">{task.now}{task.next && <> Next: {task.next}</>}</p>
    </section>
  );
}

function Artifacts({ task }) {
  const { files } = task, base = `/pages/${task.logbook}/${task.id}/`;
  const empty = !task.artifacts.length && !files.pages?.length && !files.kept.length && !files.briefs.length && !files.reports.length;
  return (
    <div>
      {empty && <p className="none">No artifact is recorded for this task yet.</p>}
      {files.pages?.length > 0 && <>
        <h4>Pages folder</h4>
        <ul className="files">{files.pages.map(page => <li key={page.name}><a href={`${base}${page.name}`} target="_blank" rel="noopener noreferrer">{page.name}</a><span className="faint">{Math.max(1, Math.round(page.size / 1024))} KB</span></li>)}</ul>
        {files.more && <p className="none">The list stops here: the folder holds more files.</p>}
        <p><a href={base} target="_blank" rel="noopener noreferrer">Open the pages index</a></p>
      </>}
      {task.artifacts.length > 0 && <>
        <h4>Recorded artifacts</h4>
        <ul className="files">{task.artifacts.map(item => (
          <li key={item.id}>
            {item.url ? <a href={item.url} target="_blank" rel="noopener noreferrer">{item.label}</a> : <span>{item.label}</span>}
            <span className="faint">{[item.type, item.run, when(item.at, task.at), item.path && (item.verified ? "in the logbook · digest checked" : "in the logbook · not checked")].filter(Boolean).join(" · ")}</span>
            {item.path && <code>{controlsShown(item.path)}</code>}
          </li>
        ))}</ul>
      </>}
      {files.kept.length > 0 && <>
        <h4>Kept reports</h4>
        <ul className="files">{files.kept.map(item => (
          <li key={item.run}>
            <span>{item.run} · {item.role}{item.status && ` · ${item.status}`}</span>
            {item.result && <span className="detail">{item.result}</span>}
            <span className="faint">{[when(item.at, task.at), item.sha && `on ${item.sha.slice(0, 7)}`].filter(Boolean).join(" · ")}</span>
          </li>
        ))}</ul>
      </>}
      {[["Briefs", files.briefs], ["Reports", files.reports]].map(([name, list]) => list.length > 0 && (
        <div key={name}>
          <h4>{name}</h4>
          <ul className="files">{list.map(item => <li key={item.name}><code>{controlsShown(item.name)}</code>{item.run && <span className="faint">{item.run}</span>}</li>)}</ul>
        </div>
      ))}
      {(files.kept.length > 0 || files.briefs.length > 0 || files.reports.length > 0) && <p className="none">Kept reports, briefs and reports are in the logbook. The board's reader for them comes later.</p>}
    </div>
  );
}

function Log({ task }) {
  if (!task.log.length) return <p className="none">No event recorded.</p>;
  return (
    <>
      <ol className="log">{task.log.map((event, i) => <li key={i}><span className="t">{when(event.at, task.at)}</span><span className="who">{event.who}</span><span>{event.text}</span></li>)}</ol>
      {task.logMore > 0 && <p className="none">{task.logMore} older events are not shown.</p>}
    </>
  );
}

function Decisions({ task }) {
  if (!task.decisions.length) return <p className="none">No question was asked about this task.</p>;
  return (
    <ul className="decs">{task.decisions.map(gate => (
      <li key={gate.id}>
        <p>{gate.question}</p>
        <p className={gate.answer || gate.pending ? "by" : "by need"}>{gate.answer ? `You answered: ${gate.answer}` : gate.pending ? `You answered on the board: ${gate.pending}. It waits for the chief to pick it up.` : "Open: it waits for your answer."}{gate.recommendation && !gate.answer && !gate.pending && ` Recommended: ${gate.recommendation}.`}</p>
        <p className="faint">{gate.id} · {when(gate.at, task.at)}</p>
      </li>
    ))}</ul>
  );
}

export function Panel({ taskKey, at, back = "tasks" }) {
  const { data: task, problem } = usePanel(taskKey, at);
  const [tab, setTab] = useState(TABS[0]);
  const heading = useRef(null), tabs = useRef([]);
  const close = () => {
    location.hash = back;
    requestAnimationFrame(() => document.querySelector(`[data-task="${CSS.escape(taskKey)}"]`)?.focus());
  };
  useEffect(() => { heading.current?.focus(); }, [taskKey, !task]);
  useEffect(() => {
    const key = event => { if (event.key === "Escape") close(); };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  });
  const move = event => {
    const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
    if (!step) return;
    const next = TABS[(TABS.indexOf(tab) + step + TABS.length) % TABS.length];
    setTab(next); tabs.current[TABS.indexOf(next)]?.focus();
  };
  const counts = task && { Artifacts: task.artifacts.length + (task.files.pages?.length ?? 0) + task.files.kept.length + task.files.briefs.length + task.files.reports.length, Log: task.log.length + task.logMore, Decisions: task.decisions.length };
  return (
    <aside className="panel" role="dialog" aria-labelledby="panel-h">
      <div className="panel-top">
        <span className="mono">{task?.id ?? ""}</span>
        {task && <span className={`badge word ${(task.word ?? "unknown").replace(" ", "-")}`}>{task.word ?? "unknown"}</span>}
        <span className="grow" />
        <button type="button" className="close" onClick={close} aria-label="Close the task panel">×</button>
      </div>
      <div className="panel-body">
        <h2 id="panel-h" ref={heading} tabIndex={-1}>{task ? task.title : problem === "gone" ? "This task is not on the board" : problem ? "The board cannot read this task now" : "Reading the task"}</h2>
        {problem && !task && <p className="none" role="alert">{problem === "gone" ? "The logbook has no task with this name. Close the panel and pick a task from the list." : "It tries again when the logbook changes."}</p>}
        {problem && task && <p className="stale" role="status">{problem === "gone" ? "This task is no longer on the board. The panel shows what it read last." : "The panel could not refresh. It shows what it read last, and tries again when the logbook changes."}</p>}
        {task && <>
          {task.conflicts.map(other => (
            <div className="callout" key={other.key}>
              <p><strong>May conflict with {other.id}</strong> ({other.chief}). Both open branches change:</p>
              <ul>{other.paths.slice(0, 20).map(path => <li key={path}><code>{controlsShown(path)}</code></li>)}</ul>
              {other.paths.length > 20 && <p className="faint">and {other.paths.length - 20} more files.</p>}
              <p className="faint">A warning only: nothing waits. The pull request that merges second may need a rebase.</p>
            </div>
          ))}
          <dl className="facts">
            <dt>Chief</dt><dd>{chiefName(task.chief)}{task.chief?.stopped && " · stopped"}</dd>
            <dt>Priority</dt><dd>{task.priority ?? "None"}{task.kind && ` · ${task.kind}`}</dd>
            <dt>Size</dt><dd>{task.size ?? "not known"}{task.risk && ` · risk flag ${task.risk}`}</dd>
            <dt>Pull request</dt><dd>{task.pr ? task.prUrl ? <a href={task.prUrl} target="_blank" rel="noopener noreferrer">#{task.pr}</a> : `#${task.pr}` : "None yet"}</dd>
            <dt>Branch</dt><dd>{task.branch ? <code>{controlsShown(task.branch)}</code> : "None yet"}</dd>
            <dt>Milestone</dt><dd>{task.milestone?.title ?? "None"}</dd>
            {task.waits && <><dt>Waits</dt><dd>{task.waits}</dd></>}
          </dl>
          <Cycle task={task} />
          <section aria-labelledby="last-h">
            <h3 id="last-h">Last event</h3>
            <p className="last">{task.lastEvent ? <>{when(task.lastEvent.at, task.at)} · {task.lastEvent.who} · {task.lastEvent.text}</> : "No event recorded."}</p>
          </section>
          <div className="tabs" role="tablist" aria-label="Task details" onKeyDown={move}>
            {TABS.map((name, i) => <button type="button" role="tab" key={name} id={`tab-${name}`} ref={el => { tabs.current[i] = el; }} aria-selected={tab === name} aria-controls="tab-panel" tabIndex={tab === name ? 0 : -1} onClick={() => setTab(name)}>{name} <span className="faint">{counts[name]}</span></button>)}
          </div>
          <div id="tab-panel" role="tabpanel" aria-labelledby={`tab-${tab}`}>
            {tab === "Artifacts" ? <Artifacts task={task} /> : tab === "Log" ? <Log task={task} /> : <Decisions task={task} />}
          </div>
        </>}
      </div>
    </aside>
  );
}
