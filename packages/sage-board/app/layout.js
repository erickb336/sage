export const W = 240, H = 104;
const GAP_X = 96, GAP_Y = 30, STEP = 8;
const ORDER = ["merged", "ready", "review", "repair", "need", "wait"];

export function layout({ nodes, waits, conflicts }) {
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

  const pools = new Map();
  const want = (pool, rank = 0) => { const slot = { rank }; (pools.get(pool) ?? pools.set(pool, []).get(pool)).push(slot); return slot; };
  const plan = (id, a, b, kind, label) => {
    const [ca, cb, ra, rb] = [columnOf(a), columnOf(b), row.get(a), row.get(b)];
    const beside = kind === "conflict" && ca === cb, near = beside || cb === ca + 1, lane = Math.floor((ra + rb) / 2);
    return { id, source: a, target: b, kind, label, near, beside, lane,
      out: want(`port ${ca} ${ra}`, near ? rb : lane + 0.5), into: want(`port ${beside ? cb : cb - 1} ${rb}`, (near ? ra : lane + 0.5) + 0.1),
      first: want(`gap ${ca}`), ...(!near && { last: want(`gap ${cb - 1}`), track: want(`row ${lane}`) }) };
  };
  const planned = [
    ...waits.map(link => plan(`wait:${link.from}>${link.to}`, link.from, link.to, link.met ? "met" : "waits", link.from === link.to ? "waits for itself" : isBack(link) ? "loop" : undefined)),
    ...conflicts.map(link => {
      const [a, b] = [link.from, link.to].sort((a, b) => columnOf(a) - columnOf(b) || row.get(a) - row.get(b));
      return plan(`conflict:${a}|${b}`, a, b, "conflict", "may conflict");
    }),
  ];
  for (const list of pools.values()) list.sort((p, q) => p.rank - q.rank).forEach((slot, i) => Object.assign(slot, { i, n: list.length }));

  const count = pool => pools.get(pool)?.length ?? 0;
  const wide = g => Math.max(GAP_X, (count(`gap ${g}`) + 3) * STEP), high = r => Math.max(GAP_Y, (count(`row ${r}`) + 2) * STEP);
  const left = [], top = [];
  for (let c = 0, at = wide(-1); c <= Math.max(0, ...column.values()); c++) { left[c] = at; at += W + wide(c); }
  for (let r = 0, at = 0; r <= Math.max(0, ...row.values()); r++) { top[r] = at; at += H + high(r); }
  const spread = (middle, slot) => middle + (slot.i - (slot.n - 1) / 2) * STEP;
  const trackX = (g, slot) => spread((g < 0 ? 0 : left[g] + W) + wide(g) / 2, slot);
  const portY = (key, slot) => top[row.get(key)] + H * (slot.i + 1) / (slot.n + 1);
  const corners = points => points.map(([px, py], i) => {
    if (i === 0) return `M ${px} ${py}`;
    if (i === points.length - 1) return `L ${px} ${py}`;
    const near = ([qx, qy]) => { const k = Math.min(8, Math.hypot(qx - px, qy - py) / 2) / (Math.hypot(qx - px, qy - py) || 1); return `${px + (qx - px) * k} ${py + (qy - py) * k}`; };
    return `L ${near(points[i - 1])} Q ${px} ${py} ${near(points[i + 1])}`;
  }).join(" ");
  const links = planned.map(({ id, source, target, kind, label, near, beside, lane, out, into, first, last, track }) => {
    const xa = left[columnOf(source)] + W, ya = portY(source, out), xb = left[columnOf(target)] + (beside ? W : 0), yb = portY(target, into), x1 = trackX(columnOf(source), first);
    if (near) return { id, source, target, kind, label, path: corners([[xa, ya], [x1, ya], [x1, yb], [xb, yb]]), x: trackX(columnOf(source), { i: 0, n: 1 }), y: (ya + yb) / 2 };
    const x2 = trackX(columnOf(target) - 1, last), ly = spread(top[lane] + H + high(lane) / 2, track);
    return { id, source, target, kind, label, path: corners([[xa, ya], [x1, ya], [x1, ly], [x2, ly], [x2, yb], [xb, yb]]), x: (x1 + x2) / 2, y: ly };
  });
  const boxes = nodes.map(node => ({ node, x: left[columnOf(node.key)], y: top[row.get(node.key)] }));
  const bottom = top.at(-1) + H + high(top.length - 1);
  return { boxes, links, height: Math.min(640, Math.max(260, bottom + 112)) };
}
