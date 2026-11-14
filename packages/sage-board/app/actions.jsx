import { useEffect, useRef, useState } from "react";
import { when } from "./use-model.js";

const TOKEN_KEY = "board-token";
const stored = { get: () => { try { return localStorage.getItem(TOKEN_KEY) ?? ""; } catch { return ""; } }, set: value => { try { value ? localStorage.setItem(TOKEN_KEY, value) : localStorage.removeItem(TOKEN_KEY); } catch {} } };
const on = document.querySelector('meta[name="sage-writes"]')?.content === "on";
const access = { writes: !on ? "off" : stored.get() ? "paired" : "unpaired" };
const listeners = new Set();
const setAccess = writes => { access.writes = writes; listeners.forEach(fn => fn()); };
addEventListener("storage", event => { if (on && (event.key === TOKEN_KEY || event.key === null)) setAccess(stored.get() ? "paired" : "unpaired"); });
const VIA = { board: "on the board", chat: "in the chat", "claude-card": "on a Claude card", "codex-card": "on a Codex card" };
const encodeKey = key => btoa(String.fromCharCode(...new TextEncoder().encode(key))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const clock = at => Number.isFinite(Date.parse(at)) ? new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }) : "an unknown time";
const clocks = text => String(text).replace(/\b\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?Z\b/g, clock);
export const questionLink = key => `#question?key=${encodeURIComponent(key)}`;
export const chiefOf = (chiefs, logbook, id) => chiefs.find(chief => chief.logbook === logbook && chief.id === id) ?? null;
export const chiefLabel = (chiefs, logbook, id) => { const chief = chiefOf(chiefs, logbook, id); return chief ? `${chief.id} · ${chief.name}` : id ?? "the chief"; };

export function useAccess() {
  const [state, setState] = useState(access.writes);
  useEffect(() => { const changed = () => setState(access.writes); listeners.add(changed); return () => listeners.delete(changed); }, []);
  return state;
}

export async function post(path, body) {
  try {
    const token = stored.get(), response = await fetch(`/api/${path}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Sage-Token": token }, body: JSON.stringify(body) });
    const json = await response.json().catch(() => ({}));
    if (path !== "pair" && (response.status === 401 || response.status === 403 && json.problem)) {
      if (response.status === 403 && stored.get() === token) stored.set("");
      setAccess(response.status === 403 && stored.get() ? "paired" : "unpaired");
    }
    return { ok: response.ok && json.ok !== false, text: clocks(json.text ?? json.problem ?? (response.ok ? "" : `The board refused the write (${response.status}).`)), json };
  } catch { return { ok: false, text: "The board cannot reach its server on this Mac. Nothing was written." }; }
}

export function PairBox() {
  const writes = useAccess(), [code, setCode] = useState(""), [problem, setProblem] = useState(null);
  if (writes === "paired") return null;
  if (writes === "off") return <p className="note">This board only reads: it runs without its config folder. Answer in the chief's chat.</p>;
  const pair = async event => {
    event.preventDefault();
    const result = await post("pair", { code });
    if (result.json.token) { stored.set(result.json.token); setAccess("paired"); }
    else setProblem(result.text);
  };
  return (
    <form className="card pair" onSubmit={pair} aria-labelledby="pair-h">
      <h2 id="pair-h">Pair this browser to act from the board</h2>
      <p className="hint">Run <code>board --pair</code> in Terminal on this Mac, then type the code that it prints. You do this once for each browser. Until then, the board only reads.</p>
      <label>Pairing code <input value={code} onChange={event => setCode(event.target.value)} autoComplete="off" spellCheck="false" placeholder="ABCD-EFGH" /></label>
      <button type="submit" className="btn primary" disabled={!code.trim()}>Pair</button>
      {problem && <p className="refused" role="alert">{problem}</p>}
    </form>
  );
}

const seen = { previous: undefined, started: false, listeners: new Set() };
const look = () => post("seen", {}).then(result => { if (result.ok) { seen.previous = result.json.previous ?? null; seen.listeners.forEach(fn => fn()); } });
export function useSeen(writes) {
  const [previous, setPrevious] = useState(seen.previous);
  useEffect(() => { const changed = () => setPrevious(seen.previous); seen.listeners.add(changed); return () => seen.listeners.delete(changed); }, []);
  useEffect(() => {
    if (writes !== "paired" || seen.started) return;
    seen.started = true;
    let hidden = false;
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") hidden = true; else if (hidden) { hidden = false; look(); } });
    look();
  }, [writes]);
  return previous;
}

const dot = chief => chief.stopped ? "stopped" : chief.waitsForOwner ? "waits" : chief.stopped === false ? "live" : "unknown";
const STATE = { live: "live", stopped: "stopped", waits: "waits for you", unknown: "liveness not known" };

function ChiefMenu({ chief, onFilter, close }) {
  const [name, setName] = useState(chief.named ? chief.name.replace(new RegExp(` · ${chief.id}$`), "") : ""), [said, setSaid] = useState(null);
  const writes = useAccess();
  const save = async event => {
    event.preventDefault();
    const result = await post("name", { logbook: chief.logbook, chief: chief.id, name });
    setSaid(result);
  };
  return (
    <div className="menu" role="dialog" aria-label={`${chief.id} · ${chief.provider}`}>
      <p className="menu-h"><span className={`dot ${dot(chief)}`} aria-hidden="true" />{chief.id} · {chief.provider}<span className="grow" />{STATE[dot(chief)]}</p>
      <dl className="facts">
        <dt>Started</dt><dd>{chief.startedAt ? when(chief.startedAt) : "not known"}</dd>
        <dt>Last event</dt><dd>{chief.heartbeat ? clock(chief.heartbeat) : "not known"}</dd>
        <dt>Agents</dt><dd>{chief.agents} running</dd>
        <dt>Autopilot</dt><dd>{chief.autopilot === null ? "not known" : chief.autopilot ? "on" : "off"} · you switch it in the chief's chat</dd>
      </dl>
      {writes === "paired" ? (
        <form onSubmit={save} className="rename">
          <label>Name <input value={name} maxLength={60} onChange={event => setName(event.target.value)} placeholder="Empty: the default name" /></label>
          <button type="submit" className="btn">Rename</button>
          {said && <p className={said.ok ? "done" : "refused"} role="status">{said.text}</p>}
        </form>
      ) : <p className="hint">Pair this browser to rename the chief.</p>}
      <button type="button" className="btn" onClick={() => { onFilter(chief.key); close(); }}>Show only {chief.id}'s work</button>
    </div>
  );
}

export function ChiefChips({ chiefs, filter, setFilter, many }) {
  const [open, setOpen] = useState(null);
  useEffect(() => {
    if (!open) return;
    const key = event => { if (event.key === "Escape") setOpen(null); };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, [open]);
  if (!chiefs.length) return null;
  return (
    <div className="chips" role="group" aria-label="Chiefs">
      <button type="button" className="chip all" aria-pressed={!filter} onClick={() => setFilter(null)}>All chiefs</button>
      {chiefs.map(chief => (
        <span className="chip-wrap" key={chief.key}>
          <button type="button" className="chip" aria-pressed={filter === chief.key} data-chief={chief.key} onClick={() => setFilter(filter === chief.key ? null : chief.key)}
            title={`${STATE[dot(chief)]} · show only this chief's work`}>
            <span className={`dot ${dot(chief)}`} aria-hidden="true" /><b>{chief.id}</b> {chief.named && `${chief.provider} `}<span className="faint">{chief.name}</span>
            {many && <span className="faint"> · {chief.project}</span>}
            <span className="state">{STATE[dot(chief)]}{dot(chief) === "live" && chief.autopilot !== null && ` · autopilot ${chief.autopilot ? "on" : "off"}`}</span>
          </button>
          <button type="button" className="chip caret" aria-expanded={open === chief.key} aria-label={`More about ${chief.id}`} onClick={() => setOpen(open === chief.key ? null : chief.key)}>▾</button>
          {open === chief.key && <ChiefMenu chief={chief} onFilter={setFilter} close={() => setOpen(null)} />}
        </span>
      ))}
    </div>
  );
}

export function GiveBox({ task, logbook, from, chiefs, close }) {
  const others = chiefs.filter(chief => chief.logbook === logbook && chief.id !== from && !chief.stopped);
  const fromProvider = chiefOf(chiefs, logbook, from)?.provider;
  const sorted = [...others].sort((a, b) => (b.provider === fromProvider) - (a.provider === fromProvider) || (b.stopped === false) - (a.stopped === false));
  const [to, setTo] = useState(sorted[0]?.id ?? null), [said, setSaid] = useState(null);
  const give = async () => setSaid(await post("give", { logbook, task: task.id, to }));
  return (
    <div className="give" role="group" aria-label={`Give ${task.id} to another chief`}>
      {sorted.length ? sorted.map((chief, i) => (
        <label key={chief.id} className="pickable">
          <input type="radio" name={`give-${task.key}`} checked={to === chief.id} onChange={() => setTo(chief.id)} />
          <span><b>{chief.id}</b> · {chief.provider} · {chief.name}{i === 0 && <span className="badge pick">Recommended</span>}</span>
        </label>
      )) : <p className="hint">No other chief of this project is live. Start a chief, then give the task to it.</p>}
      <p className="hint">The board opens the takeover question. Nothing moves until you answer it in Needs you.</p>
      <span className="row-btns">
        <button type="button" className="btn" onClick={close}>Cancel</button>
        <button type="button" className="btn primary" disabled={!to || said?.ok} onClick={give}>Open the takeover question</button>
      </span>
      {said && <p className={said.ok ? "done" : "refused"} role="status">{said.ok ? `${said.text.split(" Runs that end")[0]} Answer it in Needs you.` : said.text}</p>}
    </div>
  );
}

function Blocks({ blocks }) {
  return (blocks ?? []).map((block, i) => {
    if (block.t === "field") return <section key={i}><h3 className="lbl">{block.label}</h3><p>{block.text}</p></section>;
    if (block.t === "p") return <p key={i}>{block.text}</p>;
    if (block.t === "section") return <section key={i}><h3 className="lbl">{block.label}</h3><Blocks blocks={block.body} /></section>;
    if (block.t === "list" || block.t === "steps") return <ul key={i}>{block.items.map((item, k) => <li key={k}>{typeof item === "string" ? item : item.text}</li>)}</ul>;
    if (block.t === "code" || block.t === "picture") return <pre key={i}>{(block.lines ?? []).join("\n")}</pre>;
    if (block.t === "table") return <table key={i}><thead><tr>{block.head.map(cell => <th key={cell}>{cell}</th>)}</tr></thead><tbody>{block.rows.map((row, k) => <tr key={k}>{row.map((cell, c) => <td key={c}>{cell}</td>)}</tr>)}</tbody></table>;
    return null;
  });
}

const same = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
function answerRows(message) {
  const found = { head: ["Answer", "What happens next", "Cost"], rows: [] };
  const walk = blocks => (blocks ?? []).forEach(block => { if (block.t === "section") walk(block.body); if (block.t === "table" && same(block.head[0], "Answer")) { found.head = block.head; found.rows.push(...block.rows); } });
  walk(message?.blocks);
  return found;
}

function useGate(key, at) {
  const [state, setState] = useState({ key, gate: null, problem: null });
  useEffect(() => {
    const controller = new AbortController();
    fetch(`/app/gate/${encodeKey(key)}`, { signal: controller.signal })
      .then(response => response.ok ? response.json() : Promise.reject(response.status))
      .then(gate => setState({ key, gate, problem: null }))
      .catch(error => { if (!controller.signal.aborted) setState(previous => ({ key, gate: previous.key === key ? previous.gate : null, problem: error === 404 ? "gone" : "read" })); });
    return () => controller.abort();
  }, [key, at]);
  return state.key === key ? state : { gate: null, problem: null };
}

export function Answered({ gate, chiefs }) {
  const owner = chiefLabel(chiefs, gate.logbook, gate.owner);
  if (gate.answered?.via === "board" && !gate.answer) return <>You answered {gate.id} on the board at {clock(gate.answered.at)}: <b>{gate.answered.answer}</b>. It waits for {owner} to pick it up.</>;
  if (gate.picked?.chief && gate.answered?.via === "board") return <>You answered {gate.id} on the board: <b>{gate.answer}</b>. {gate.picked.chief} picked it up at {clock(gate.picked.at)}, so it has no Undo now. To change it, tell the chief in its chat.</>;
  const where = gate.answered?.via === "chat" ? `in ${gate.owner ?? "the chief"}'s chat` : VIA[gate.answered?.via] ?? "in a place that sage did not record";
  return <>Answered first {where} at {clock(gate.answered?.at)}: <b>{gate.answer}</b>. The first answer wins; to change it, tell the chief in its chat.</>;
}

export function UndoButton({ logbook, gate, onDone }) {
  const [said, setSaid] = useState(null);
  return (
    <>
      <button type="button" className="btn" onClick={async () => { const result = await post("undo", { logbook, gate }); setSaid(result); onDone?.(result); }}>Undo</button>
      {said && !said.ok && <span className="refused" role="alert">{said.text}</span>}
    </>
  );
}

export function QuestionView({ needKey, model, theme }) {
  const { gate, problem } = useGate(needKey, model.at), writes = useAccess();
  const [pick, setPick] = useState(null), [said, setSaid] = useState(null), [busy, setBusy] = useState(false), sending = useRef(false);
  useEffect(() => { document.getElementById("question-h")?.focus(); }, [needKey, !gate]);
  if (!gate) return <div className="page-h"><a href="#" className="back">Back to Needs you</a><h1 id="question-h" tabIndex={-1}>{problem === "gone" ? "This question is not on the board" : problem ? "The board cannot read this question now" : "Reading the question"}</h1></div>;
  const rows = answerRows(gate.message), open = !gate.answer && !gate.answered, owner = chiefLabel(model.chiefs, gate.logbook, gate.owner);
  const send = async () => {
    if (sending.current) return;
    sending.current = true; setBusy(true);
    setSaid(await post("answer", { logbook: gate.logbook, gate: gate.id, option: pick + 1, digest: gate.digest }));
    sending.current = false; setBusy(false);
  };
  return (
    <article className="question" aria-labelledby="question-h">
      <a href="#" className="back">Back to Needs you</a>
      <p className="facts-line">{owner} · <span className="mono">{gate.id}</span> · asked {gate.at ? clock(gate.at) : "at a time not recorded"} · <a href={`#tasks?task=${encodeURIComponent(gate.task.key)}`}>{gate.task.id} · {gate.task.title}</a> · <a href={`/read/${encodeKey(gate.task.key)}/question/${gate.id}${theme === "light" ? "?theme=light" : ""}`}>Read the full question</a></p>
      <h1 id="question-h" tabIndex={-1}>{gate.message?.title ?? gate.text ?? gate.question}</h1>
      {gate.message ? <div className="context"><Blocks blocks={gate.message.blocks.filter(block => !(block.t === "table" && same(block.head[0], "Answer")))} /></div>
        : <p className="hint">This question has no kept message, so the board shows its question and its options only.{gate.default && ` If you do not answer: ${gate.default}.`}</p>}
      <h2 className="lbl">The answers</h2>
      <div className="answers" role="radiogroup" aria-label="The answers">
        {gate.options.map((option, i) => {
          const row = rows.rows.find(item => same(item[0], option) || same(item[0].replace(/^[A-Z]\s*[·:.)-]\s*/, ""), option));
          const chosen = gate.answer === option || gate.answered?.answer === option;
          return (
            <label key={option} className={`answer${pick === i ? " picked" : ""}${chosen ? " chosen" : ""}`}>
              <input type="radio" name="answer" disabled={!open || writes !== "paired" || said?.ok} checked={pick === i} onChange={() => setPick(i)} />
              <span className="what"><b>{option}</b>{gate.recommendation === option && <span className="badge pick">{gate.owner ?? "The chief"}'s pick</span>}{chosen && <span className="badge done">The answer</span>}</span>
              {row && <span className="more">{row.slice(1).map((cell, k) => <span key={k}><span className="faint">{rows.head[k + 1]}</span> {cell}</span>)}</span>}
            </label>
          );
        })}
      </div>
      <div className="send" role="status">
        {said?.ok ? <p className="done">{said.text.startsWith(gate.id) ? `You answered ${gate.id}: ${gate.options[pick]}. Recorded in the logbook. It waits for ${owner} to pick it up, at its next step.` : said.text} <UndoButton logbook={gate.logbook} gate={gate.id} onDone={result => result.ok && setSaid(null)} /></p>
          : !open ? <p><span><Answered gate={gate} chiefs={model.chiefs} /></span>{gate.answered?.via === "board" && !gate.answer && <UndoButton logbook={gate.logbook} gate={gate.id} />}</p>
          : writes !== "paired" ? <PairBox />
          : <p>{pick === null ? "Pick one answer above." : <>Your answer: <b>{gate.options[pick]}</b></>} <span className="grow" />
              <button type="button" className="btn" onClick={() => setPick(null)}>Clear</button>
              <button type="button" className="btn primary" disabled={pick === null || busy} onClick={send}>Send answer</button></p>}
        {said && !said.ok && <p className={said.json?.pending ? "note" : "refused"} role="alert">{said.json?.pending ? "" : "Not recorded. "}{said.text}</p>}
        <p className="hint">The first answer wins: from the board or from the chief's chat. A later answer is refused and names the first one.</p>
      </div>
    </article>
  );
}
