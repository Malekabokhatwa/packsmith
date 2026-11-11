// Layered layout of a chapter's quest graph: a quest's column is the length of the longest
// "after" chain leading to it, so branches meet at gates further right. Used by the Quests tab's
// map and for quest positions written into engines that store them. Links to quests outside the
// chapter, and links that would form a cycle, are ignored for layout.
export interface LayoutNode { id: string; dependsOn: string[] }
export interface Placed { col: number; row: number }

export function layoutQuests(nodes: LayoutNode[]): { pos: Map<string, Placed>; cols: number; rows: number } {
  const ids = new Set(nodes.map((n) => n.id));
  const deps = new Map(nodes.map((n) => [n.id, n.dependsOn.filter((d) => ids.has(d) && d !== n.id)]));
  const col = new Map<string, number>();
  const visiting = new Set<string>();
  const depth = (id: string): number => {
    const known = col.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return 0; // cycle: break it here
    visiting.add(id);
    const d = Math.max(-1, ...(deps.get(id) ?? []).map(depth)) + 1;
    visiting.delete(id);
    col.set(id, d);
    return d;
  };
  for (const n of nodes) depth(n.id);
  const perCol = new Map<number, number>();
  const pos = new Map<string, Placed>();
  for (const n of nodes) {
    const c = col.get(n.id)!;
    const r = perCol.get(c) ?? 0;
    perCol.set(c, r + 1);
    pos.set(n.id, { col: c, row: r });
  }
  return { pos, cols: Math.max(0, ...col.values()) + 1, rows: Math.max(0, ...perCol.values()) };
}

// Edges of the longest "after" chain (the chapter's length in steps, e.g. "8 steps long").
export function longestChain(nodes: LayoutNode[]): number {
  return nodes.length ? layoutQuests(nodes).cols : 0;
}
