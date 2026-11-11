import { describe, expect, it } from "vitest";
import type { ContentItem } from "@shared/schema";
import { groupItems, groupOf, searchText } from "../src/renderer/lib/categories";

const mod = (title: string, categories: string[]): ContentItem => ({
  relpath: `minecraft/mods/${title.toLowerCase()}.jar`, kind: "mod", enabled: true, sha1: "a".repeat(40), sha512: "b".repeat(128), bytes: 1,
  match: { status: "modrinth", projectId: title, versionId: "v", title, summary: `${title} does things`, versionNumber: "1", categories, clientSide: "required", serverSide: "required" },
  reason: { kind: "unknown", of: [] },
} as ContentItem);

describe("category chips (S06)", () => {
  it("gives each mod one group: libraries first, then its first known category, else Other", () => {
    expect(groupOf(mod("Balm", ["utility", "library"]))).toBe("Libraries");
    expect(groupOf(mod("Sodium", ["optimization", "utility"]))).toBe("Performance");
    expect(groupOf(mod("Odd", ["fabric", "forge"]))).toBe("Other");
    expect(groupOf({ ...mod("x", []), match: { status: "unmatched", reason: "not-on-modrinth" } })).toBe("Not on Modrinth");
  });
  it("counts add up to the pack, groups in a stable order, search covers title, summary and file name", () => {
    const items = [mod("Balm", ["library"]), mod("Map", ["utility"]), mod("Sodium", ["optimization"]), mod("Lithium", ["optimization"]), mod("Thing", [])];
    const groups = groupItems(items);
    expect(groups.map((g) => `${g.name}:${g.items.length}`)).toEqual(["Performance:2", "Utility:1", "Other:1", "Libraries:1"]);
    expect(groups.reduce((n, g) => n + g.items.length, 0)).toBe(items.length);
    expect(searchText(items[1]!)).toContain("map does things");
    expect(searchText(items[1]!)).toContain("map.jar");
  });
});
