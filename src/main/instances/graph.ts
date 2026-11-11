// GRP-1/2: the pack as a graph. Every installed mod is a node; every edge comes from the Modrinth
// metadata of the version that is installed (required, optional, incompatible), so each one can be
// traced. A required library that isn't in the pack becomes a "missing" node instead of vanishing.
import type { ContentItem } from "@shared/schema";
import type { ModrinthVersion } from "../sources/modrinth";

export interface GraphNode {
  id: string;                 // Modrinth project id, or "file:<relpath>" for a file not on Modrinth
  title: string;
  iconUrl?: string;
  kind: "mod" | "library" | "unknown" | "missing";
  enabled: boolean;
  relpath?: string;
  reason?: ContentItem["reason"];
}
export interface GraphEdge { from: string; to: string; type: "required" | "optional" | "incompatible" }
export interface PackGraph { nodes: GraphNode[]; edges: GraphEdge[] }

// `versions`: the installed versions; `projectOfVersion` resolves dependencies given only by version id.
export function packGraph(items: ContentItem[], versions: ModrinthVersion[], projectOfVersion: (versionId: string) => string | undefined, titles: Map<string, string>): PackGraph {
  const mods = items.filter((c) => c.kind === "mod");
  const nodes = new Map<string, GraphNode>();
  for (const c of mods) {
    if (c.match.status === "modrinth") {
      nodes.set(c.match.projectId, { id: c.match.projectId, title: c.match.title, ...(c.match.iconUrl ? { iconUrl: c.match.iconUrl } : {}), kind: "mod", enabled: c.enabled, relpath: c.relpath, reason: c.reason });
    } else {
      const id = `file:${c.relpath}`;
      nodes.set(id, { id, title: c.relpath.split("/").pop()!, kind: "unknown", enabled: c.enabled, relpath: c.relpath, reason: c.reason });
    }
  }
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  for (const v of versions) {
    if (!nodes.has(v.project_id)) continue;
    for (const d of v.dependencies) {
      if (d.dependency_type === "embedded") continue;
      const to = d.project_id ?? (d.version_id ? projectOfVersion(d.version_id) : undefined);
      if (!to || to === v.project_id) continue;
      if (!nodes.has(to)) {
        // Only a missing required library matters for the picture; absent optional/incompatible
        // projects aren't part of the pack.
        if (d.dependency_type !== "required") continue;
        nodes.set(to, { id: to, title: titles.get(to) ?? "A missing library", kind: "missing", enabled: false });
      }
      const key = `${v.project_id}>${to}>${d.dependency_type}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ from: v.project_id, to, type: d.dependency_type });
    }
  }
  // A mod others require is drawn as a library (they sit in the middle of the layout).
  const required = new Set(edges.filter((e) => e.type === "required").map((e) => e.to));
  for (const n of nodes.values()) if (n.kind === "mod" && required.has(n.id)) n.kind = "library";
  return { nodes: [...nodes.values()], edges };
}
