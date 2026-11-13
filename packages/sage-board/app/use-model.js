import { useEffect, useState } from "react";

const RETRY_MS = 5000;

export function useModel(url) {
  const [state, setState] = useState({ model: null, link: "connecting", receivedAt: null });
  useEffect(() => {
    let source, timer, closed = false;
    const open = () => {
      source = new EventSource(url);
      source.addEventListener("model", event => {
        let model;
        try { model = JSON.parse(event.data); } catch { return; }
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
