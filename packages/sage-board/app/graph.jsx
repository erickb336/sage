import "react-dom/client";
import { useMemo } from "react";
import { BaseEdge, Controls, Handle, MarkerType, Position, ReactFlow } from "@xyflow/react";
import { H, W, layout } from "./layout.js";

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

export default function Graph({ data }) {
  const { placed, edges, height } = useMemo(() => {
    const { boxes, links, height } = layout(data);
    const placed = boxes.map(({ node, x, y }) => ({ id: node.key, type: "item", position: { x, y }, data: node, width: W, height: H, ...fixed }))
      .sort((a, b) => a.position.x - b.position.x || a.position.y - b.position.y);
    const edges = links.map(link => ({ id: link.id, source: link.source, target: link.target, sourceHandle: "out", targetHandle: "in", type: "route", className: link.kind, data: link, label: link.label,
      ...(link.kind !== "conflict" && { markerEnd: { type: MarkerType.ArrowClosed } }), ...fixed }));
    return { placed, edges, height };
  }, [data]);
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
