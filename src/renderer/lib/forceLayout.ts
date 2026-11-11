// A small deterministic force layout for the pack graph (S09): repulsion between all nodes,
// springs along edges, a pull to the centre that is stronger for libraries (they sit in the
// middle). Same input, same picture: no randomness, a fixed number of steps.
export interface LayoutNode { id: string; library: boolean }
export interface Point { x: number; y: number }

export function forceLayout(nodes: LayoutNode[], edges: Array<{ from: string; to: string }>, steps = 300): Map<string, Point> {
  const n = nodes.length;
  const pos = nodes.map((node, i) => {
    // Start on a golden-angle spiral: spread out, no overlaps, deterministic.
    const r = 30 * Math.sqrt(i + 1) * (node.library ? 0.5 : 1);
    const a = i * 2.399963;
    return { x: r * Math.cos(a), y: r * Math.sin(a) };
  });
  const index = new Map(nodes.map((node, i) => [node.id, i]));
  const links = edges.flatMap((e) => {
    const a = index.get(e.from), b = index.get(e.to);
    return a === undefined || b === undefined || a === b ? [] : [[a, b] as const];
  });
  const ideal = 70;
  for (let step = 0; step < steps; step++) {
    const heat = 1 - step / steps;
    const fx = new Float64Array(n), fy = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let dx = pos[i]!.x - pos[j]!.x, dy = pos[i]!.y - pos[j]!.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 0.01) { dx = (i - j) * 0.1; dy = 0.1; d2 = dx * dx + dy * dy; }
        if (d2 > 250_000) continue; // far apart: no effect worth computing
        const f = (ideal * ideal) / d2;
        fx[i]! += dx * f; fy[i]! += dy * f; fx[j]! -= dx * f; fy[j]! -= dy * f;
      }
    }
    for (const [a, b] of links) {
      const dx = pos[b]!.x - pos[a]!.x, dy = pos[b]!.y - pos[a]!.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const f = (d - ideal) / d * 0.5;
      fx[a]! += dx * f; fy[a]! += dy * f; fx[b]! -= dx * f; fy[b]! -= dy * f;
    }
    for (let i = 0; i < n; i++) {
      const g = nodes[i]!.library ? 0.08 : 0.02;
      fx[i]! -= pos[i]!.x * g; fy[i]! -= pos[i]!.y * g;
      const len = Math.sqrt(fx[i]! * fx[i]! + fy[i]! * fy[i]!) || 1;
      const move = Math.min(len, 20 * heat + 0.5);
      pos[i]!.x += (fx[i]! / len) * move; pos[i]!.y += (fy[i]! / len) * move;
    }
  }
  return new Map(nodes.map((node, i) => [node.id, pos[i]!]));
}
