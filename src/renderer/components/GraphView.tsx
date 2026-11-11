// S09 pack graph (GRP-1/2): every mod a node, every edge from Modrinth's metadata of the installed
// version. Hover a mod to focus its links; click (or Enter) to pin it and read why it's here.
// Solid = requires, dashed = optional, red dotted = can't run with; arrows point to the dependency.
import { useMemo, useRef, useState, type PointerEvent, type WheelEvent } from "react";
import { Maximize2, X } from "lucide-react";
import type { Out } from "@shared/ipc";
import { iconSrc } from "../lib/api";
import { forceLayout } from "../lib/forceLayout";
import { Button } from "./Button";

export type Graph = Out<"packs:graph">;
type Node = Graph["nodes"][number];

const R = 15;

// "Why it's here" in words, from the scan's reason and the graph's own edges.
export function whyHere(node: Node, graph: Graph): string {
  const title = (id: string) => graph.nodes.find((n) => n.id === id)?.title ?? id;
  const neededBy = graph.edges.filter((e) => e.to === node.id && e.type === "required").map((e) => title(e.from));
  if (node.kind === "missing") return `Required by ${neededBy.join(", ") || "a mod in the pack"}, but it isn't in the pack.`;
  if (node.kind === "unknown") return "This file isn't on Modrinth, so packsmith has no dependency data for it.";
  const r = node.reason;
  if (r?.kind === "requested") return r.text ? `You asked for it: ${r.text}` : "You asked for it.";
  if (r?.kind === "agent-chosen") return r.text ? `packsmith picked it: ${r.text}` : "packsmith picked it for this pack.";
  if (r?.kind === "dependency") return `Needed by ${(r.of.length ? r.of.map(title) : neededBy).join(", ") || "another mod"}.`;
  if (r?.kind === "pre-existing") return "It was already in the pack.";
  return neededBy.length ? `Needed by ${neededBy.join(", ")}.` : "packsmith has no record of why it was added.";
}

export function GraphView({ graph }: { graph: Graph }) {
  const layout = useMemo(() => forceLayout(graph.nodes.map((n) => ({ id: n.id, library: n.kind === "library" })), graph.edges), [graph]);
  const bounds = useMemo(() => {
    const ps = [...layout.values()];
    const xs = ps.map((p) => p.x), ys = ps.map((p) => p.y);
    const pad = 60;
    const minX = Math.min(0, ...xs) - pad, minY = Math.min(0, ...ys) - pad;
    const w = Math.max(0, ...xs) + pad - minX, h = Math.max(0, ...ys) + pad - minY;
    // A small pack isn't blown up to fill the frame: icons and labels keep their size.
    const W = Math.max(w, 640), H = Math.max(h, 384);
    return { x: minX - (W - w) / 2, y: minY - (H - h) / 2, w: W, h: H };
  }, [layout]);
  const [view, setView] = useState(bounds);
  const [hover, setHover] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const drag = useRef<{ x: number; y: number; view: typeof view } | null>(null);
  const svg = useRef<SVGSVGElement>(null);
  const focus = hover ?? selected;
  const near = useMemo(() => {
    if (!focus) return null;
    const s = new Set([focus]);
    for (const e of graph.edges) { if (e.from === focus) s.add(e.to); if (e.to === focus) s.add(e.from); }
    return s;
  }, [focus, graph.edges]);
  const many = graph.nodes.length > 40;
  const sel = graph.nodes.find((n) => n.id === selected) ?? null;
  const title = (id: string) => graph.nodes.find((n) => n.id === id)?.title ?? id;

  function onWheel(e: WheelEvent) {
    const rect = svg.current!.getBoundingClientRect();
    const k = e.deltaY > 0 ? 1.15 : 1 / 1.15;
    const px = view.x + ((e.clientX - rect.left) / rect.width) * view.w;
    const py = view.y + ((e.clientY - rect.top) / rect.height) * view.h;
    setView({ x: px - (px - view.x) * k, y: py - (py - view.y) * k, w: view.w * k, h: view.h * k });
  }
  function onDown(e: PointerEvent) { if ((e.target as Element).closest("[data-node]")) return; drag.current = { x: e.clientX, y: e.clientY, view }; (e.currentTarget as Element).setPointerCapture(e.pointerId); }
  function onMove(e: PointerEvent) {
    const d = drag.current;
    if (!d) return;
    const rect = svg.current!.getBoundingClientRect();
    setView({ ...d.view, x: d.view.x - ((e.clientX - d.x) / rect.width) * d.view.w, y: d.view.y - ((e.clientY - d.y) / rect.height) * d.view.h });
  }

  const edgeStyle = { required: { stroke: "var(--color-muted)", dash: undefined }, optional: { stroke: "var(--color-subtle)", dash: "5 4" }, incompatible: { stroke: "var(--color-danger)", dash: "2 3" } } as const;
  return (
    <div className="flex gap-3">
      <div className="relative min-w-0 flex-1 overflow-hidden rounded-lg border border-border bg-surface">
        <p id="graph-summary" className="sr-only">{graph.nodes.length} mods, {graph.edges.length} links. The list view shows the same mods.</p>
        <div className="absolute end-2 top-2 z-10 flex gap-2">
          <Button size="sm" icon={<Maximize2 className="size-3.5" aria-hidden />} onClick={() => setView(bounds)}>Fit</Button>
        </div>
        <svg ref={svg} role="group" aria-label="Pack graph" aria-describedby="graph-summary" viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
          className="block h-120 w-full cursor-grab touch-none select-none active:cursor-grabbing"
          onWheel={onWheel} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={() => { drag.current = null; }} onDoubleClick={() => setView(bounds)}>
          <defs>
            {(["required", "optional", "incompatible"] as const).map((t) => (
              <marker key={t} id={`arrow-${t}`} viewBox="0 0 8 8" refX="8" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M0,0 L8,4 L0,8 z" fill={edgeStyle[t].stroke} />
              </marker>
            ))}
          </defs>
          {graph.edges.map((e, i) => {
            const a = layout.get(e.from), b = layout.get(e.to);
            if (!a || !b) return null;
            const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1;
            const dim = near && !(near.has(e.from) && near.has(e.to) && (e.from === focus || e.to === focus));
            return <line key={i} x1={a.x + (dx / d) * R} y1={a.y + (dy / d) * R} x2={b.x - (dx / d) * (R + 2)} y2={b.y - (dy / d) * (R + 2)}
              stroke={edgeStyle[e.type].stroke} strokeDasharray={edgeStyle[e.type].dash} strokeWidth={1.4} opacity={dim ? 0.12 : 0.85} markerEnd={`url(#arrow-${e.type})`} />;
          })}
          {graph.nodes.map((n) => {
            const p = layout.get(n.id)!;
            const dim = near && !near.has(n.id);
            const icon = iconSrc(n.iconUrl);
            const ring = n.id === selected ? "var(--color-accent)" : n.kind === "missing" ? "var(--color-danger)" : "var(--color-border)";
            const label = many ? n.id === focus || near?.has(n.id) : true;
            return (
              <g key={n.id} data-node transform={`translate(${p.x} ${p.y})`} opacity={dim ? 0.2 : n.enabled || n.kind === "missing" ? 1 : 0.5}
                tabIndex={0} role="button" aria-label={`${n.title}${n.kind === "missing" ? ", missing" : n.kind === "library" ? ", library" : ""}`} aria-pressed={n.id === selected}
                className="cursor-pointer outline-none [&:focus-visible>circle]:stroke-(--color-focus)"
                onPointerEnter={() => setHover(n.id)} onPointerLeave={() => setHover(null)} onFocus={() => setHover(n.id)} onBlur={() => setHover(null)}
                onClick={() => setSelected(n.id === selected ? null : n.id)}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSelected(n.id === selected ? null : n.id); } }}>
                <circle r={R + 2} fill="var(--color-surface-2)" stroke={ring} strokeWidth={2} strokeDasharray={n.kind === "unknown" || n.kind === "missing" ? "3 3" : undefined} />
                {icon && n.kind !== "unknown" && n.kind !== "missing"
                  ? <image href={icon} x={-R + 2} y={-R + 2} width={2 * R - 4} height={2 * R - 4} clipPath="circle()" preserveAspectRatio="xMidYMid slice" />
                  : <text textAnchor="middle" dy="0.35em" fontSize="10" fill="var(--color-muted)">{n.kind === "unknown" ? "?" : n.title.slice(0, 2).toUpperCase()}</text>}
                {label && <text y={R + 14} textAnchor="middle" fontSize="11" fill="var(--color-text)" style={{ paintOrder: "stroke", stroke: "var(--color-surface)", strokeWidth: 3 }}>{n.title.length > 24 ? `${n.title.slice(0, 23)}…` : n.title}</text>}
              </g>
            );
          })}
        </svg>
        <p className="m-0 border-t border-border px-3 py-1.5 text-xs text-subtle">
          Scroll to zoom, drag to move, double-click to fit. Solid: requires · dashed: optional · red dotted: can't run with.
        </p>
      </div>
      {sel && (
        <aside aria-label={`Why ${sel.title} is here`} className="flex w-64 shrink-0 flex-col gap-2 rounded-lg border border-border bg-surface p-3 text-sm">
          <div className="flex items-start justify-between gap-2">
            <h3 className="m-0 text-sm font-semibold">{sel.title}</h3>
            <button type="button" aria-label="Close" className="text-muted hover:text-text" onClick={() => setSelected(null)}><X className="size-4" aria-hidden /></button>
          </div>
          <p className="m-0 text-xs font-medium text-muted">Why it's here</p>
          <p className="m-0">{whyHere(sel, graph)}</p>
          {(["required", "optional", "incompatible"] as const).map((t) => {
            const out = graph.edges.filter((e) => e.from === sel.id && e.type === t).map((e) => title(e.to));
            return out.length ? <p key={t} className="m-0 text-xs text-subtle">{t === "required" ? "Requires" : t === "optional" ? "Works with" : "Can't run with"}: {out.join(", ")}</p> : null;
          })}
          {sel.kind !== "unknown" && <a className="text-xs text-accent" href={`https://modrinth.com/project/${sel.id}`} target="_blank" rel="noreferrer">Open on Modrinth</a>}
        </aside>
      )}
    </div>
  );
}
