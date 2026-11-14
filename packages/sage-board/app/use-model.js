import { useEffect, useState } from "react";

const RETRY_MS = 5000;

export const when = at => new Date(at).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const localName = chief => chief.named || !chief.startedAt ? chief : { ...chief, name: chief.name.replace(/\d{4}-\d\d-\d\d \d\d:\d\d UTC/, when(chief.startedAt)) };

export function useModel(url) {
  const [state, setState] = useState({ model: null, link: "connecting", receivedAt: null });
  useEffect(() => {
    let source, timer, closed = false;
    const open = () => {
      source = new EventSource(url);
      source.addEventListener("model", event => {
        let model;
        try { model = JSON.parse(event.data); model.chiefs = (model.chiefs ?? []).map(localName); } catch { return; }
        setState({ model, link: "live", receivedAt: Date.now() });
      });
      source.addEventListener("error", () => {
        setState(previous => ({ ...previous, link: "lost" }));
        if (source.readyState === EventSource.CLOSED && !closed) timer = setTimeout(open, RETRY_MS);
      });
    };
    open();
    return () => { closed = true; clearTimeout(timer); source.close(); };
  }, [url]);
  return state;
}
