import { describe, expect, it } from "vitest";
import { checkPack } from "../src/main/resolver/resolve";
import type { ModrinthVersion } from "../src/main/sources/modrinth";

type Dep = { project_id?: string | null; version_id?: string | null; dependency_type: "required" | "optional" | "incompatible" | "embedded" };
const v = (project: string, deps: Dep[] = []) => ({ id: `v-${project}`, project_id: project, dependencies: deps.map((d) => ({ project_id: null, version_id: null, file_name: null, ...d })) }) as unknown as ModrinthVersion;

describe("checkPack (evidence rung 1)", () => {
  const waystones = v("waystones", [{ project_id: "balm", dependency_type: "required" }, { project_id: "fabric-api", dependency_type: "required" }, { project_id: "jei", dependency_type: "optional" }]);
  it("a pack with every required library passes; optional ones don't count", () => {
    expect(checkPack([waystones, v("balm", [{ project_id: "fabric-api", dependency_type: "required" }]), v("fabric-api")], () => undefined)).toEqual({ missing: [], incompatible: [] });
  });
  it("names a removed library and who needs it (the AC-2 break)", () => {
    expect(checkPack([waystones, v("fabric-api")], () => undefined).missing).toEqual([{ projectId: "balm", neededBy: ["waystones"] }]);
  });
  it("follows dependencies given only by version id", () => {
    const m = v("mod", [{ version_id: "v-lib", dependency_type: "required" }]);
    expect(checkPack([m], (id) => (id === "v-lib" ? "lib" : undefined)).missing).toEqual([{ projectId: "lib", neededBy: ["mod"] }]);
  });
  it("reports two installed mods that refuse each other, once", () => {
    const a = v("embeddium", [{ project_id: "sodium", dependency_type: "incompatible" }]);
    const b = v("sodium", [{ project_id: "embeddium", dependency_type: "incompatible" }]);
    expect(checkPack([a, b], () => undefined).incompatible).toEqual([["embeddium", "sodium"]]);
  });
});
