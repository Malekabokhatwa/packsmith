// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { forceLayout } from "../src/renderer/lib/forceLayout";
import { GraphView, whyHere, type Graph } from "../src/renderer/components/GraphView";

const graph: Graph = {
  nodes: [
    { id: "way", title: "Waystones", kind: "mod", enabled: true, reason: { kind: "requested", of: [] } },
    { id: "balm", title: "Balm", kind: "library", enabled: true, reason: { kind: "dependency", of: ["way"] } },
    { id: "fapi", title: "Fabric API", kind: "library", enabled: true, reason: { kind: "unknown", of: [] } },
    { id: "map", title: "Minimap", kind: "mod", enabled: true, reason: { kind: "agent-chosen", of: [], text: "a map in the corner" } },
    { id: "gone", title: "Cloth Config", kind: "missing", enabled: false },
    { id: "file:minecraft/mods/x.jar", title: "x.jar", kind: "unknown", enabled: true },
  ],
  edges: [
    { from: "way", to: "balm", type: "required" }, { from: "way", to: "fapi", type: "required" }, { from: "balm", to: "fapi", type: "required" },
    { from: "map", to: "way", type: "optional" }, { from: "map", to: "gone", type: "required" },
  ],
};

describe("pack graph view (S09)", () => {
  it("lays out deterministically, without overlaps, libraries nearer the middle", () => {
    const nodes = graph.nodes.map((n) => ({ id: n.id, library: n.kind === "library" }));
    const a = forceLayout(nodes, graph.edges), b = forceLayout(nodes, graph.edges);
    expect([...a.entries()]).toEqual([...b.entries()]);
    const ps = [...a.values()];
    for (const p of ps) expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
    for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) expect(Math.hypot(ps[i]!.x - ps[j]!.x, ps[i]!.y - ps[j]!.y)).toBeGreaterThan(30);
    const dist = (id: string) => Math.hypot(a.get(id)!.x, a.get(id)!.y);
    expect(dist("fapi")).toBeLessThan(dist("map"));
  });

  it("says why each mod is here", () => {
    const n = (id: string) => graph.nodes.find((x) => x.id === id)!;
    expect(whyHere(n("way"), graph)).toBe("You asked for it.");
    expect(whyHere(n("balm"), graph)).toBe("Needed by Waystones.");
    expect(whyHere(n("fapi"), graph)).toBe("Needed by Waystones, Balm."); // no record: falls back to the edges
    expect(whyHere(n("map"), graph)).toBe("packsmith picked it: a map in the corner");
    expect(whyHere(n("gone"), graph)).toBe("Required by Minimap, but it isn't in the pack.");
    expect(whyHere(n("file:minecraft/mods/x.jar"), graph)).toMatch(/isn't on Modrinth/);
  });

  it("every mod is a focusable node; Enter opens the why panel with its links", () => {
    render(<GraphView graph={graph} />);
    expect(screen.getAllByRole("button", { name: /Waystones|Balm|Fabric API|Minimap|Cloth Config|x\.jar/ })).toHaveLength(6);
    expect(screen.getByText("6 mods, 5 links. The list view shows the same mods.")).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("button", { name: "Waystones" }), { key: "Enter" });
    const panel = screen.getByRole("complementary", { name: "Why Waystones is here" });
    expect(panel.textContent).toContain("You asked for it.");
    expect(panel.textContent).toContain("Requires: Balm, Fabric API");
    expect(screen.getByRole("button", { name: "Cloth Config, missing" })).toBeTruthy();
  });
});
