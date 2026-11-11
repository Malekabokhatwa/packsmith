import { describe, expect, it } from "vitest";
import type { ContentItem } from "@shared/schema";
import type { ModrinthVersion } from "../src/main/sources/modrinth";
import { packGraph } from "../src/main/instances/graph";

function mod(projectId: string, over: Partial<ContentItem> = {}): ContentItem {
  return {
    relpath: `minecraft/mods/${projectId}.jar`, kind: "mod", enabled: true, sha1: "a".repeat(40), sha512: "b".repeat(128), bytes: 1,
    match: { status: "modrinth", projectId, versionId: `v-${projectId}`, title: `Mod ${projectId}`, summary: "", versionNumber: "1", categories: [], clientSide: "required", serverSide: "required" },
    reason: { kind: "requested", of: [] }, ...over,
  } as ContentItem;
}
type Dep = ModrinthVersion["dependencies"][number];
const version = (projectId: string, dependencies: Dep[]): ModrinthVersion => ({ id: `v-${projectId}`, project_id: projectId, dependencies } as unknown as ModrinthVersion);

describe("pack graph (GRP-1/2)", () => {
  it("has a node per mod and an edge per dependency of the installed versions, typed", () => {
    const items = [mod("way"), mod("balm", { reason: { kind: "dependency", of: ["way"] } }), mod("fapi"), mod("map")];
    const g = packGraph(items, [
      version("way", [{ project_id: "balm", dependency_type: "required" }, { project_id: "fapi", dependency_type: "required" }, { project_id: "map", dependency_type: "optional" }]),
      version("balm", [{ project_id: "fapi", dependency_type: "required" }, { project_id: "balm", dependency_type: "required" }]), // self-reference ignored
      version("map", [{ project_id: "jei", dependency_type: "optional" }, { project_id: "way", dependency_type: "incompatible" }, { project_id: "lib", dependency_type: "embedded" }]),
    ], () => undefined, new Map());
    expect(g.nodes.map((n) => `${n.id}:${n.kind}`).sort()).toEqual(["balm:library", "fapi:library", "map:mod", "way:mod"]);
    expect(g.edges.map((e) => `${e.from}>${e.to}:${e.type}`).sort()).toEqual(["balm>fapi:required", "map>way:incompatible", "way>balm:required", "way>fapi:required", "way>map:optional"]);
    expect(g.nodes.find((n) => n.id === "balm")!.reason).toEqual({ kind: "dependency", of: ["way"] });
  });

  it("resolves dependencies given only by version id, shows a missing required library, keeps unknown files", () => {
    const local: ContentItem = { ...mod("x"), relpath: "minecraft/mods/homemade.jar", match: { status: "unmatched", reason: "not-on-modrinth" } };
    const g = packGraph([mod("way"), local], [version("way", [{ version_id: "v-of-balm", dependency_type: "required" }, { project_id: "gone", dependency_type: "optional" }])],
      (vid) => (vid === "v-of-balm" ? "balm" : undefined), new Map([["balm", "Balm"]]));
    expect(g.nodes.find((n) => n.id === "balm")).toMatchObject({ kind: "missing", title: "Balm", enabled: false });
    expect(g.nodes.find((n) => n.id === "file:minecraft/mods/homemade.jar")).toMatchObject({ kind: "unknown", title: "homemade.jar" });
    expect(g.nodes.some((n) => n.id === "gone")).toBe(false); // an absent optional isn't part of the pack
    expect(g.edges).toEqual([{ from: "way", to: "balm", type: "required" }]);
  });
});
