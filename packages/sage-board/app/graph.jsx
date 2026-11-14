import "react-dom/client";
import { useMemo } from "react";
import { Controls, Handle, MarkerType, Position, ReactFlow } from "@xyflow/react";

const W = 240, H = 104, GAP_X = 80, GAP_Y = 22;
const ORDER = ["merged", "ready", "review", "repair", "need", "wait"];
const fixed = { draggable: false, selectable: false, connectable: false, focusable: false };
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function Item({ data }) {
  return (
    <>
      <Handle type="target" id="in" position={Position.Left} isConnectable={false} />
      <Handle type="target" id="top" position={Position.Top} isConnectable={false} />
      <a className={`gnode ${data.group}${data.nopr ? " nopr" : ""}`} href={data.href} data-task={data.key}>
        <span className="g-head"><b className="mono">{data.head}</b><span>{data.chief}</span></span>
        <span className="g-title">{data.title}</span>
        <span className="g-state">{data.state}</span>
        <span className="g-sub">{data.sub}</span>
      </a>
      <Handle type="source" id="out" position={Position.Right} isConnectable={false} />
      <Handle type="source" id="bottom" position={Position.Bottom} isConnectable={false} />
    </>
  );
}
const TYPES = { item: Item };

function layout({ nodes, waits, conflicts }) {
  const sources = new Map(nodes.map(node => [node.key, waits.filter(link => link.to === node.key).map(link => link.from)]));
  const level = new Map();
  const levelOf = (key, seen = new Set()) => {
    if (level.has(key)) return level.get(key);
    if (seen.has(key)) return 0;
    seen.add(key);
    const value = Math.max(-1, ...sources.get(key).map(from => levelOf(from, seen))) + 1;
    level.set(key, value);
    return value;
  };
  const rows = new Map(), columns = [];
  for (const node of [...nodes].sort((a, b) => levelOf(a.key) - levelOf(b.key) || ORDER.indexOf(a.group) - ORDER.indexOf(b.group))) {
    const column = columns[levelOf(node.key)] ??= [];
    const after = sources.get(node.key).map(from => rows.get(from)).filter(row => row !== undefined);
    let row = after.length ? Math.round(after.reduce((sum, value) => sum + value, 0) / after.length) : 0;
    while (column.includes(row)) row++;
    column.push(row);
    rows.set(node.key, row);
  }
  const placed = nodes.map(node => ({ id: node.key, type: "item", position: { x: levelOf(node.key) * (W + GAP_X), y: rows.get(node.key) * (H + GAP_Y) }, data: node, width: W, height: H, ...fixed }))
    .sort((a, b) => a.position.x - b.position.x || a.position.y - b.position.y);
  const edges = [
    ...waits.map(({ from, to, met }) => ({ id: `wait:${from}>${to}`, source: from, target: to, sourceHandle: "out", targetHandle: "in", className: met ? "met" : "waits", markerEnd: { type: MarkerType.ArrowClosed }, ...fixed })),
    ...conflicts.map(link => {
      const [from, to] = [link.from, link.to].sort((a, b) => levelOf(a) - levelOf(b) || rows.get(a) - rows.get(b)), column = levelOf(from) === levelOf(to);
      return { id: `conflict:${from}|${to}`, source: from, target: to, sourceHandle: column ? "bottom" : "out", targetHandle: column ? "top" : "in", type: column ? "straight" : "default", className: "conflict", label: "may conflict", ...fixed };
    }),
  ];
  const tall = Math.max(1, ...[...rows.values()].map(row => row + 1));
  return { placed, edges, height: Math.min(640, Math.max(260, tall * (H + GAP_Y) + 80)) };
}

export default function Graph({ data }) {
  const { placed, edges, height } = useMemo(() => layout(data), [data]);
  return (
    <section className="card graph" aria-labelledby="graph-h">
      <div className="card-h">
        <h2 id="graph-h">What waits for what</h2>
        <span className="grow" />
        <span className="hint">An arrow from A to B: B waits for A. A dashed box is a task with no PR yet.</span>
      </div>
      {placed.length > 0
        ? <div className="g-canvas" style={{ height }}>
          <ReactFlow nodes={placed} edges={edges} nodeTypes={TYPES} fitView fitViewOptions={{ maxZoom: 1, minZoom: 0.6, padding: 0.06 }} minZoom={0.2}
            nodesDraggable={false} nodesConnectable={false} nodesFocusable={false} edgesFocusable={false} elementsSelectable={false}
            zoomOnScroll={false} preventScrolling={false} zoomOnDoubleClick={false}>
            <Controls showInteractive={false} position="top-right" />
          </ReactFlow>
        </div>
        : <p className="empty">No pull request or task on this page waits for another, and none may conflict with another.</p>}
      <ul className="legend">
        {[["ready", "Ready to merge"], ["review", "In review"], ["repair", "Repairing"], ["need", "Needs you"], ["wait", "Waiting"], ["merged", "Merged"]].map(([key, name]) => <li key={key}><span className={`swatch ${key}`} aria-hidden="true" />{name}</li>)}
        <li><span className="line waits" aria-hidden="true" />waits for</li>
        <li><span className="line conflict" aria-hidden="true" />may conflict (a warning only)</li>
        {data.alone > 0 && <li>{plural(data.alone, "other item has", "other items have")} no link: the list shows {data.alone === 1 ? "it" : "them"}.</li>}
      </ul>
    </section>
  );
}
