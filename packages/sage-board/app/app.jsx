import { useEffect, useState } from "react";
import { ChiefChips, QuestionView } from "./actions.jsx";
import { AgentsIcon, AlertIcon, LeafIcon, MoonIcon, OverviewIcon, PullsIcon, SunIcon, TasksIcon } from "./icons.jsx";
import { Overview } from "./overview.jsx";
import { Pulls } from "./pulls.jsx";
import { Tasks } from "./tasks.jsx";
import { useModel } from "./use-model.js";

const THEME_KEY = "board-theme";
const PAGES = [
  { hash: "", name: "Overview", Icon: OverviewIcon },
  { hash: "tasks", name: "Tasks", Icon: TasksIcon },
  { hash: "agents", name: "Agents", Icon: AgentsIcon, classic: "/agents", what: "each running agent, for each chief, against the limit" },
  { hash: "pull-requests", name: "Pull requests", Icon: PullsIcon },
];
const QUESTION = { hash: "question", name: "Question", hidden: true };
const FILTER_KEY = "board-chief";

const clock = at => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
function pageOf(hash) {
  const [path, query = ""] = hash.replace(/^#\/?/, "").split("?");
  return { ...([...PAGES, QUESTION].find(page => page.hash === path) ?? PAGES[0]), params: new URLSearchParams(query) };
}

function useHashPage() {
  const [page, setPage] = useState(() => pageOf(location.hash));
  useEffect(() => {
    const changed = () => setPage(pageOf(location.hash));
    addEventListener("hashchange", changed);
    return () => removeEventListener("hashchange", changed);
  }, []);
  return page;
}

function useTheme() {
  const [theme, setTheme] = useState(() => {
    try { return localStorage.getItem(THEME_KEY) === "light" ? "light" : "dark"; } catch { return "dark"; }
  });
  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);
  const flip = () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    try { localStorage.setItem(THEME_KEY, next); } catch {}
  };
  return [theme, flip];
}

function Status({ model, link, receivedAt }) {
  if (link === "connecting" && !model) return <span className="live" role="status"><span className="dot" />Connecting</span>;
  if (!model) return <span className="live bad" role="status"><span className="dot" />Cannot reach the board</span>;
  if (link === "lost") return <span className="live bad" role="status"><span className="dot" />Not updated since {clock(receivedAt)} · trying again</span>;
  if (model.stale) return <span className="live bad" role="status"><span className="dot" />Not updated since {clock(model.at)}</span>;
  return <span className="live ok" role="status"><span className="dot" />Live · read {clock(model.at)}</span>;
}

function Banner({ model, link, receivedAt }) {
  if (link === "lost" && model) return (
    <div className="banner fail" role="alert"><AlertIcon />
      <div><b>The board lost its link to the server on this Mac.</b> The data below is from {clock(receivedAt)}. It tries again on its own.</div>
    </div>
  );
  if (model?.stale) return (
    <div className="banner fail" role="alert"><AlertIcon />
      <div><b>The board cannot read the logbook.</b> The data below is from {clock(model.at)}. It reads again when the logbook changes.
        {model.problems.length > 0 && <ul>{model.problems.slice(0, 3).map(problem => <li key={problem}>{problem}</li>)}</ul>}
      </div>
    </div>
  );
  return null;
}

function NoData({ link }) {
  if (link === "connecting") return <p className="loading" role="status">Reading the logbook.</p>;
  return (
    <div className="banner fail" role="alert"><AlertIcon />
      <div><b>The board cannot reach its server on this Mac.</b> It tries again every few seconds. If this lasts, check that the board service runs.</div>
    </div>
  );
}

function ComesNext({ page }) {
  return (
    <div className="next">
      <div className="page-h"><h1>{page.name}</h1></div>
      <p>This page comes next: it will show {page.what}. Until then, the <a href={page.classic}>classic board</a> shows it.</p>
    </div>
  );
}

function useChiefFilter() {
  const [filter, setFilter] = useState(() => { try { return sessionStorage.getItem(FILTER_KEY); } catch { return null; } });
  const set = value => { setFilter(value); try { value ? sessionStorage.setItem(FILTER_KEY, value) : sessionStorage.removeItem(FILTER_KEY); } catch {} };
  return [filter, set];
}

export function App() {
  const { model, link, receivedAt } = useModel("/app/events");
  const page = useHashPage();
  const [theme, flip] = useTheme();
  const [chosen, setFilter] = useChiefFilter();
  const filter = model?.chiefs.some(chief => chief.key === chosen) ? chosen : null;
  const picked = model?.chiefs.find(chief => chief.key === filter);
  const shown = (logbook, id) => !filter || `${logbook}/${id}` === filter;
  const crumb = model?.projects.length === 1 ? model.projects[0] : "All projects";
  const next = theme === "dark" ? "light" : "dark";
  const open = model ? model.tasks.filter(task => !task.ended).length : 0;
  const prs = model ? model.tasks.filter(task => task.pr && !task.ended).length : 0;
  const body = page.hash === "" ? <Overview model={model} shown={shown} /> : page.hash === "tasks" ? <Tasks model={model} params={page.params} chief={picked} />
    : page.hash === "pull-requests" ? <Pulls model={model} params={page.params} chief={picked} />
    : page.hash === "question" ? <QuestionView needKey={page.params.get("key") ?? ""} model={model} theme={theme} /> : null;
  return (
    <div className="app">
      <aside className="side">
        <div className="brand"><span className="mark"><LeafIcon /></span>sage board</div>
        <nav aria-label="Pages">
          <ul className="nav">
            {PAGES.map(item => (
              <li key={item.hash}>
                <a href={`#${item.hash}`} aria-current={item.hash === page.hash ? "page" : undefined}>
                  <item.Icon />{item.name}
                  {!item.hash && model && model.needs.length > 0 && <span className="count need" aria-label={`${model.needs.length} need you`}>{model.needs.length}</span>}
                  {item.hash === "tasks" && model && <span className="count" aria-label={`${open} open`}>{open}</span>}
                  {item.hash === "pull-requests" && model && <span className="count" aria-label={`${prs} open`}>{prs}</span>}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <p className="foot">The logbook on this Mac is the source of each line. Your answers and names write to it.</p>
      </aside>
      <div className="col">
        <header className="top">
          <span className="crumb">{crumb}<span aria-hidden="true">/</span><b>{page.name}</b></span>
          <span className="grow" />
          <Status model={model} link={link} receivedAt={receivedAt} />
          <button type="button" className="theme" onClick={flip} aria-label={`Switch to the ${next} theme`} title={`Switch to the ${next} theme`}>
            {theme === "dark" ? <SunIcon /> : <MoonIcon />}
          </button>
        </header>
        {model && <ChiefChips chiefs={model.chiefs} filter={filter} setFilter={setFilter} many={model.projects.length > 1} />}
        <main className="main">
          {!body ? <ComesNext page={page} /> : model
            ? <><Banner model={model} link={link} receivedAt={receivedAt} />{body}</>
            : <NoData link={link} />}
        </main>
      </div>
    </div>
  );
}
