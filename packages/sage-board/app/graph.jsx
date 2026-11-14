import "react-dom/client";
import { useMemo } from "react";
import { BaseEdge, Controls, Handle, MarkerType, Position, ReactFlow } from "@xyflow/react";

const W = 240, H = 104, GAP_X = 96, GAP_Y = 30;
const ORDER = ["merged", "ready", "review", "repair", "need", "wait"];
const fixed = { draggable: false, selectable: false, connectable: false, focusable: false };
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function Item({ data }) {
  return (
    <>
      <Handle type="target" id="in" position={Position.Left} isConnectable={false} />
      <a className={`gnode ${data.group}${data.nopr ? " nopr" : ""}`} href={data.href} data-task={data.key}>
        <span className="g-head"><b className="mono">{data.head}</b><span>{data.chief}</span></span>
        <span className="g-title">{data.title}</span>
        <span className="g-state">{data.state}</span>
        <span className="g-sub">{data.sub}</span>
      </a>
      <Handle type="source" id="out" position={Position.Right} isConnectable={false} />
    </>
  );
}
const TYPES = { item: Item };
const Route = ({ data, label, markerEnd }) => <BaseEdge path={data.path} label={label} labelX={data.x} labelY={data.y} markerEnd={markerEnd} />;
const ROUTES = { route: Route };
const FIT = { maxZoom: 1, minZoom: 0.6, padding: "56px" };

function layout({ nodes, waits, conflicts }) {
  const after = new Map(nodes.map(node => [node.key, []])), back = new Set(), seen = new Map();
  for (const link of waits) if (link.from !== link.to) after.get(link.from).push(link.to);
  const visit = key => {
    seen.set(key, "open");
    for (const to of after.get(key)) if (seen.get(to) === "open") back.add(`${key}>${to}`); else if (!seen.has(to)) visit(to);
    seen.set(key, "done");
  };
  for (const node of nodes) if (!seen.has(node.key)) visit(node.key);
  const isBack = link => link.from === link.to || back.has(`${link.from}>${link.to}`), forward = waits.filter(link => !isBack(link));
  const column = new Map();
  const columnOf = key => column.get(key) ?? column.set(key, Math.max(-1, ...forward.filter(link => link.to === key).map(link => columnOf(link.from))) + 1).get(key);
  const grid = new Set(), row = new Map();
  for (const node of [...nodes].sort((a, b) => columnOf(a.key) - columnOf(b.key) || ORDER.indexOf(a.group) - ORDER.indexOf(b.group))) {
    const above = forward.filter(link => link.to === node.key).map(link => row.get(link.from));
    let r = above.length ? Math.round(above.reduce((sum, value) => sum + value, 0) / above.length) : 0;
    while (grid.has(`${columnOf(node.key)}:${r}`)) r++;
    grid.add(`${columnOf(node.key)}:${r}`);
    row.set(node.key, r);
  }
  const x = key => columnOf(key) * (W + GAP_X), y = key => row.get(key) * (H + GAP_Y) + H / 2, used = new Map();
  const next = slot => { const n = used.get(slot) ?? 0; used.set(slot, n + 1); return n; };
  const labelled = new Set(conflicts.filter(link => columnOf(link.from) === columnOf(link.to)).map(link => Math.min(row.get(link.from), row.get(link.to))));
  const lane = r => { const k = [r, r - 1, r + 1, r + 2].find(k => k >= 0 && !labelled.has(k)) ?? r; return k * (H + GAP_Y) + H + GAP_Y / 2 + [0, -5, 5, -10, 10][next(`lane${k}`) % 5]; };
  const stub = slot => 14 + 8 * (next(slot) % 4);
  const free = (r, from, to) => Array.from({ length: to - from - 1 }, (_, i) => from + 1 + i).every(c => !grid.has(`${c}:${r}`));
  const bend = (x0, y0, x1, y1) => `C ${(x0 + x1) / 2} ${y0} ${(x0 + x1) / 2} ${y1} ${x1} ${y1}`;
  const corners = points => points.map(([px, py], i) => {
    if (i === 0) return `M ${px} ${py}`;
    if (i === points.length - 1) return `L ${px} ${py}`;
    const near = ([qx, qy]) => { const k = Math.min(8, Math.hypot(qx - px, qy - py) / 2) / (Math.hypot(qx - px, qy - py) || 1); return `${px + (qx - px) * k} ${py + (qy - py) * k}`; };
    return `L ${near(points[i - 1])} Q ${px} ${py} ${near(points[i + 1])}`;
  }).join(" ");
  const ahead = (a, b) => {
    const [c1, c2, r1, r2] = [columnOf(a), columnOf(b), row.get(a), row.get(b)];
    const x0 = x(a) + W, y0 = y(a), x1 = x(b), y1 = y(b), x2 = x1 - GAP_X, x3 = x0 + GAP_X;
    if (c2 === c1 + 1) return { path: `M ${x0} ${y0} ${bend(x0, y0, x1, y1)}`, x: (x0 + x1) / 2, y: (y0 + y1) / 2 };
    if (free(r1, c1, c2)) return { path: `M ${x0} ${y0} L ${x2} ${y0} ${bend(x2, y0, x1, y1)}`, x: (x0 + x2) / 2, y: y0 };
    if (free(r2, c1, c2)) return { path: `M ${x0} ${y0} ${bend(x0, y0, x3, y1)} L ${x1} ${y1}`, x: (x3 + x1) / 2, y: y1 };
    const ly = lane(Math.floor((r1 + r2) / 2));
    return { path: `M ${x0} ${y0} ${bend(x0, y0, x3, ly)} L ${x2} ${ly} ${bend(x2, ly, x1, y1)}`, x: (x3 + x2) / 2, y: ly };
  };
  const behind = (a, b) => {
    const x0 = x(a) + W, x1 = x(b), out = x0 + stub(`out${columnOf(a)}`), into = x1 - stub(`in${columnOf(b)}`), ly = lane(Math.max(row.get(a), row.get(b)));
    return { path: corners([[x0, y(a)], [out, y(a)], [out, ly], [into, ly], [into, y(b)], [x1, y(b)]]), x: (out + into) / 2, y: ly };
  };
  const beside = (a, b) => {
    const x0 = x(a) + W, out = x0 + stub(`out${columnOf(a)}`);
    return { path: corners([[x0, y(a)], [out, y(a)], [out, y(b)], [x0, y(b)]]), x: x0 + GAP_X / 2, y: y(a) + (H + GAP_Y) / 2 };
  };
  const placed = nodes.map(node => ({ id: node.key, type: "item", position: { x: x(node.key), y: row.get(node.key) * (H + GAP_Y) }, data: node, width: W, height: H, ...fixed }))
    .sort((a, b) => a.position.x - b.position.x || a.position.y - b.position.y);
  const edge = (id, source, target, className, route, label, markerEnd) => ({ id, source, target, sourceHandle: "out", targetHandle: "in", type: "route", className, data: route, label, markerEnd, ...fixed });
  const edges = [
    ...waits.map(link => edge(`wait:${link.from}>${link.to}`, link.from, link.to, link.met ? "met" : "waits",
      isBack(link) ? behind(link.from, link.to) : ahead(link.from, link.to), link.from === link.to ? "waits for itself" : isBack(link) ? "loop" : undefined, { type: MarkerType.ArrowClosed })),
    ...conflicts.map(link => {
      const [a, b] = [link.from, link.to].sort((a, b) => columnOf(a) - columnOf(b) || row.get(a) - row.get(b));
      return edge(`conflict:${a}|${b}`, a, b, "conflict", columnOf(a) === columnOf(b) ? beside(a, b) : ahead(a, b), "may conflict");
    }),
  ];
  const tall = Math.max(1, ...[...row.values()].map(r => r + 1));
  return { placed, edges, height: Math.min(640, Math.max(260, tall * (H + GAP_Y) + 112)) };
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
          <ReactFlow nodes={placed} edges={edges} nodeTypes={TYPES} edgeTypes={ROUTES} fitView fitViewOptions={FIT} minZoom={0.2}
            nodesDraggable={false} nodesConnectable={false} nodesFocusable={false} edgesFocusable={false} elementsSelectable={false}
            zoomOnScroll={false} preventScrolling={false} zoomOnDoubleClick={false}>
            <Controls showInteractive={false} fitViewOptions={FIT} position="top-right" />
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
