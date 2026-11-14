import { useEffect, useState } from "react";

const RETRY_MS = 5000, TICK_MS = 60_000;

export const when = at => new Date(at).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const localName = chief => chief.named || !chief.startedAt ? chief : { ...chief, name: chief.name.replace(/\d{4}-\d\d-\d\d \d\d:\d\d UTC/, when(chief.startedAt)) };

export function useNow() {
  const [now, setNow] = useState(() => new Date().toISOString());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date().toISOString()), TICK_MS);
    return () => clearInterval(timer);
  }, []);
  return now;
}

export function useModel(url) {
  const [state, setState] = useState({ model: null, link: "connecting", lostAt: null });
  useEffect(() => {
    let source, timer, closed = false;
    const open = () => {
      source = new EventSource(url);
      source.addEventListener("model", event => {
        let model;
        try { model = JSON.parse(event.data); model.chiefs = (model.chiefs ?? []).map(localName); } catch { return; }
        setState({ model, link: "live", lostAt: null });
      });
      source.addEventListener("error", () => {
        setState(previous => ({ ...previous, link: "lost", lostAt: previous.lostAt ?? new Date().toISOString() }));
        if (source.readyState === EventSource.CLOSED && !closed) timer = setTimeout(open, RETRY_MS);
      });
    };
    open();
    return () => { closed = true; clearTimeout(timer); source.close(); };
  }, [url]);
  return state;
}
