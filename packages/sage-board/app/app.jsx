import { useEffect, useState } from "react";
import { AgentsIcon, AlertIcon, LeafIcon, MoonIcon, OverviewIcon, PullsIcon, SunIcon, TasksIcon } from "./icons.jsx";
import { Overview } from "./overview.jsx";
import { useModel } from "./use-model.js";

const THEME_KEY = "board-theme";
const PAGES = [
  { hash: "", name: "Overview", Icon: OverviewIcon },
  { hash: "tasks", name: "Tasks", Icon: TasksIcon, classic: "/", what: "every task by its step, with its dev cycle and what its agents made" },
  { hash: "agents", name: "Agents", Icon: AgentsIcon, classic: "/agents", what: "each running agent, for each chief, against the limit" },
  { hash: "pull-requests", name: "Pull requests", Icon: PullsIcon, classic: "/", what: "each open, merged or waiting pull request, and what depends on what" },
];

const clock = at => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const pageOf = hash => PAGES.find(page => page.hash === hash.replace(/^#\/?/, "")) ?? PAGES[0];

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

export function App() {
  const { model, link, receivedAt } = useModel("/app/events");
  const page = useHashPage();
  const [theme, flip] = useTheme();
  const crumb = model?.projects.length === 1 ? model.projects[0] : "All projects";
  const next = theme === "dark" ? "light" : "dark";
  return (
    <div className="app">
      <aside className="side">
        <div className="brand"><span className="mark"><LeafIcon /></span>sage board</div>
        <nav aria-label="Pages">
          <ul className="nav">
            {PAGES.map(item => (
              <li key={item.hash}>
                <a href={`#${item.hash}`} aria-current={item === page ? "page" : undefined}>
                  <item.Icon />{item.name}
                  {!item.hash && model && model.needs.length > 0 && <span className="count need" aria-label={`${model.needs.length} need you`}>{model.needs.length}</span>}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <p className="foot">Read-only. The logbook on this Mac is the source of each line.</p>
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
        <main className="main">
          {page.hash ? <ComesNext page={page} /> : model
            ? <><Banner model={model} link={link} receivedAt={receivedAt} /><Overview model={model} /></>
            : <NoData link={link} />}
        </main>
      </div>
    </div>
  );
}
