const SHARED_PIXELS_OF_A_CROSSING = 6;

export function samplePath(d) {
  const tokens = d.match(/[MLQC]|-?[\d.]+(?:e-?\d+)?/g), points = [];
  let i = 0, x = 0, y = 0, command;
  const take = () => [Number(tokens[i++]), Number(tokens[i++])];
  const curve = (controls, end) => {
    const steps = Math.max(2, Math.ceil([[x, y], ...controls, end].reduce((sum, p, k, all) => k ? sum + Math.hypot(p[0] - all[k - 1][0], p[1] - all[k - 1][1]) : 0, 0)));
    for (let k = 1; k <= steps; k++) {
      const t = k / steps, u = 1 - t;
      const weights = controls.length === 1 ? [u * u, 2 * u * t, t * t] : [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
      points.push([[x, y], ...controls, end].reduce(([px, py], p, k) => [px + weights[k] * p[0], py + weights[k] * p[1]], [0, 0]));
    }
    [x, y] = end;
  };
  while (i < tokens.length) {
    if (/[MLQC]/.test(tokens[i])) command = tokens[i++];
    if (command === "M") { [x, y] = take(); points.push([x, y]); }
    else if (command === "L") { const end = take(), steps = Math.max(1, Math.ceil(Math.hypot(end[0] - x, end[1] - y))); for (let k = 1; k <= steps; k++) points.push([x + (end[0] - x) * k / steps, y + (end[1] - y) * k / steps]); [x, y] = end; }
    else if (command === "Q") { const control = take(); curve([control], take()); }
    else if (command === "C") { const one = take(), two = take(); curve([one, two], take()); }
    else throw new Error(`unknown path command in ${d}`);
  }
  return points;
}

export function graphProblems({ boxes, links }) {
  const through = [], shared = [], owners = new Map();
  for (const [index, link] of links.entries()) {
    const points = samplePath(link.d), boxesHit = new Set();
    for (const [px, py] of points) {
      for (const box of boxes) if (px > box.x + 2 && px < box.x + box.w - 2 && py > box.y + 2 && py < box.y + box.h - 2) boxesHit.add(box.id);
      const cell = Math.round(px) * 100_000 + Math.round(py);
      (owners.get(cell) ?? owners.set(cell, new Set()).get(cell)).add(index);
    }
    for (const id of boxesHit) through.push(`${link.id} passes through ${id}`);
  }
  const common = new Map();
  for (const indexes of owners.values()) if (indexes.size > 1) for (const a of indexes) for (const b of indexes) if (a < b) common.set(`${a} ${b}`, (common.get(`${a} ${b}`) ?? 0) + 1);
  for (const [pair, pixels] of common) if (pixels > SHARED_PIXELS_OF_A_CROSSING) { const [a, b] = pair.split(" ").map(Number); shared.push(`${links[a].id} and ${links[b].id} share ${pixels} px`); }
  return { through, shared };
}
