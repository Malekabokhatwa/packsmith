import { describe, expect, it } from "vitest";
import { compareMcVersions, newestFirst } from "@shared/mcVersion";
import { resolve, toDownload, findCycles, type ResolveInput } from "../src/main/resolver/resolve";
import { resolveFromModrinth } from "../src/main/resolver/fetch";
import { ModrinthClient, MODRINTH_API, Throttle, type ModrinthProject, type ModrinthVersion } from "../src/main/sources/modrinth";
import { fakeHttp, fixture } from "./helpers";

// Recorded from api.modrinth.com (fabric, 1.21.1): Waystones -> Fabric API + Balm -> Fabric API;
// Sodium Extra -> Sodium (required) + three optional projects.
const WAYSTONES = "LOpKHB2A", BALM = "MBAkmtvl", FAPI = "P7dR8mSH", SODIUM = "AANobbMI", EXTRA = "PtjYWJkn";

async function data() {
  const f = (await fixture("resolver.json")) as { projects: ModrinthProject[]; versions: Record<string, ModrinthVersion[]> };
  return { projects: Object.fromEntries(f.projects.map((p) => [p.id, p])), versions: f.versions };
}

async function input(selection: ResolveInput["selection"], over: Partial<ResolveInput> = {}): Promise<ResolveInput> {
  const d = await data();
  return { mcVersion: "1.21.1", loader: "fabric", selection, projects: d.projects, candidates: structuredClone(d.versions), versionsById: {}, supported: {}, installed: [], ...over };
}

function synthetic(id: string, deps: ModrinthVersion["dependencies"], over: Partial<ModrinthVersion> = {}): ModrinthVersion {
  return { id: `v-${id}`, project_id: id, version_number: "1.0", version_type: "release", loaders: ["fabric"], game_versions: ["1.21.1"], date_published: "2026-01-01T00:00:00Z", dependencies: deps, files: [{ url: `https://cdn.modrinth.com/data/${id}/x.jar`, filename: `${id}.jar`, primary: true, size: 10, hashes: { sha1: "a", sha512: "b" } }], ...over };
}
const proj = (id: string, title = id): ModrinthProject => ({ id, slug: id.toLowerCase(), title, description: "", project_type: "mod", categories: [], client_side: "required", server_side: "required" });

describe("Minecraft version order", () => {
  it("puts year-based versions after every 1.x version", () => {
    expect(compareMcVersions("26.2", "1.21.11")).toBeGreaterThan(0);
    expect(compareMcVersions("1.21.10", "1.21.9")).toBeGreaterThan(0);
    expect(compareMcVersions("26.1.2", "26.1")).toBeGreaterThan(0);
    expect(newestFirst(["1.20.1", "26.2", "1.21.4", "26.1.2", "1.21.4"])).toEqual(["26.2", "26.1.2", "1.21.4", "1.20.1"]);
  });
});

describe("resolver (DEP-1..5)", () => {
  it("pulls in required libraries, once each, with who needs them", async () => {
    const set = resolve(await input([{ projectId: WAYSTONES }]));
    expect(set.conflicts).toEqual([]);
    expect(set.mods.map((m) => m.title)).toEqual(["Waystones", "Fabric API", "Balm"]);
    const fapi = set.mods.find((m) => m.projectId === FAPI)!;
    expect(fapi.reason).toMatchObject({ kind: "dependency", of: [WAYSTONES, BALM] });
    expect(set.edges).toEqual(expect.arrayContaining([
      { from: WAYSTONES, to: FAPI, kind: "required" }, { from: WAYSTONES, to: BALM, kind: "required" }, { from: BALM, to: FAPI, kind: "required" },
    ]));
    expect(set.mods[0]).toMatchObject({ versionNumber: "21.1.46+fabric-1.21.1", alreadyInstalled: false, reason: { kind: "requested" } });
    expect(set.mods.every((m) => m.bytes > 0)).toBe(true);
  });

  it("keeps optional dependencies as edges only", async () => {
    const set = resolve(await input([{ projectId: EXTRA }]));
    expect(set.mods.map((m) => m.projectId)).toEqual([EXTRA, SODIUM]);
    expect(set.edges.filter((e) => e.kind === "optional")).toHaveLength(3);
  });

  it("doesn't download what the pack already has", async () => {
    const set = resolve(await input([{ projectId: WAYSTONES }], { installed: [{ projectId: FAPI, versionId: "Mys3P7lK" }] }));
    expect(set.mods.find((m) => m.projectId === FAPI)).toMatchObject({ alreadyInstalled: true, reason: { kind: "dependency" } });
    expect(toDownload(set).map((m) => m.title)).toEqual(["Waystones", "Balm"]);
  });

  it("keeps the installed copy when an exact other version of it is asked for (never two jars)", async () => {
    // Installed: Fabric API 0.116.16 (fpB2VatZ). Asked for: exactly 0.116.17 (Mys3P7lK).
    const d = await data();
    const versionsById = Object.fromEntries(d.versions[FAPI]!.map((v) => [v.id, v]));
    const set = resolve(await input([{ projectId: FAPI, versionId: "Mys3P7lK" }], { installed: [{ projectId: FAPI, versionId: "fpB2VatZ" }], versionsById }));
    expect(set.conflicts).toEqual([]);
    expect(set.mods[0]).toMatchObject({ projectId: FAPI, versionId: "fpB2VatZ", alreadyInstalled: true });
    expect(toDownload(set)).toEqual([]);
    expect(set.unknowns.map((u) => u.what)).toContain("The pack already has Fabric API 0.116.16+1.21.1, so packsmith kept it instead of adding 0.116.17+1.21.1 as a second copy. Update or remove it to change the version.");
  });

  it("explains an incompatibility and proposes a fix, also against installed mods", async () => {
    const d = await data();
    const extra = structuredClone(d.versions[EXTRA]!);
    extra[0]!.dependencies.push({ project_id: WAYSTONES, version_id: null, file_name: null, dependency_type: "incompatible" });
    const set = resolve(await input([{ projectId: WAYSTONES }, { projectId: EXTRA }], { candidates: { ...d.versions, [EXTRA]: extra } }));
    expect(set.conflicts).toHaveLength(1);
    expect(set.conflicts[0]!.explanation).toBe("Sodium Extra doesn't work together with Waystones (its Modrinth page says so).");
    expect(set.conflicts[0]!.proposedFix).toBe("Keep one of them: Sodium Extra or Waystones.");
    expect(set.edges).toContainEqual({ from: EXTRA, to: WAYSTONES, kind: "incompatible" });

    const installedV = extra[0]!;
    const later = resolve(await input([{ projectId: WAYSTONES }], { installed: [{ projectId: EXTRA, versionId: installedV.id }], versionsById: { [installedV.id]: installedV } }));
    expect(later.conflicts[0]!.proposedFix).toBe("Leave out Waystones, or remove Sodium Extra from the pack first.");
  });

  it("names the versions a project does support when it has none for this pack (DEP-5)", async () => {
    const set = resolve(await input([{ projectId: WAYSTONES }], { candidates: { [WAYSTONES]: [] }, supported: { [WAYSTONES]: ["1.20.1", "26.2", "1.21.4", "1.21.4"] } }));
    expect(set.conflicts[0]).toMatchObject({
      explanation: "Waystones has no version for Fabric 1.21.1.",
      proposedFix: "Waystones has versions for Fabric 26.2, 1.21.4, 1.20.1. Move the pack to one of those, or leave Waystones out.",
    });
  });

  it("explains a dependency with no fitting version through the project that needs it", async () => {
    const d = await data();
    const set = resolve(await input([{ projectId: WAYSTONES }], { candidates: { ...d.versions, [BALM]: [] }, supported: { [BALM]: [] } }));
    expect(set.conflicts[0]!.explanation).toBe("Waystones needs Balm, and Balm has no version for Fabric 1.21.1.");
    expect(set.conflicts[0]!.proposedFix).toBe("Leave Waystones out, or try another loader.");
  });

  it("detects a dependency cycle, reports it and stops", async () => {
    const a = synthetic("A", [{ project_id: "B", version_id: null, file_name: null, dependency_type: "required" }]);
    const b = synthetic("B", [{ project_id: "A", version_id: null, file_name: null, dependency_type: "required" }]);
    const set = resolve({ mcVersion: "1.21.1", loader: "fabric", selection: [{ projectId: "A" }], projects: { A: proj("A"), B: proj("B") }, candidates: { A: [a], B: [b] }, versionsById: {}, supported: {}, installed: [] });
    expect(set.mods.map((m) => m.projectId)).toEqual(["A", "B"]);
    expect(set.cycles).toEqual([["A", "B"]]);
    expect(findCycles([{ from: "x", to: "y" }])).toEqual([]);
  });

  it("honours an exact pin that fits; a dependency pinned to another game version gets the newest fitting one, flagged", async () => {
    const good = synthetic("B", [], { id: "B-good", version_number: "2.0" });
    const newer = synthetic("B", [], { id: "B-new", version_number: "3.0" });
    const old = synthetic("B", [], { id: "B-old", version_number: "0.9", game_versions: ["1.20.1"] });
    const a = synthetic("A", [{ project_id: "B", version_id: "B-old", file_name: null, dependency_type: "required" }]);
    const base = { mcVersion: "1.21.1", loader: "fabric" as const, projects: { A: proj("A"), B: proj("B", "Bee") }, candidates: { A: [a], B: [newer, good] }, versionsById: { "B-good": good, "B-old": old }, supported: {}, installed: [] };
    expect(resolve({ ...base, selection: [{ projectId: "B", versionId: "B-good" }] }).mods[0]!.versionNumber).toBe("2.0");
    const set = resolve({ ...base, selection: [{ projectId: "A" }] });
    expect(set.mods[1]!.versionNumber).toBe("3.0");
    expect(set.unknowns[0]!.what).toBe("A asks for a specific Bee version that isn't for Fabric 1.21.1; using 3.0 instead.");
    expect(resolve({ ...base, selection: [{ projectId: "B", versionId: "B-old" }] }).conflicts[0]!.explanation).toBe("The chosen version of Bee isn't for Fabric 1.21.1.");
  });

  it("follows a dependency given only as a version id; flags one that isn't on Modrinth", async () => {
    const b = synthetic("B", []);
    const a = synthetic("A", [
      { project_id: null, version_id: "v-B", file_name: null, dependency_type: "required" },
      { project_id: null, version_id: null, file_name: "secret-lib.jar", dependency_type: "required" },
    ]);
    const set = resolve({ mcVersion: "1.21.1", loader: "fabric", selection: [{ projectId: "A" }], projects: { A: proj("A"), B: proj("B") }, candidates: { A: [a], B: [b] }, versionsById: { "v-B": b }, supported: {}, installed: [] });
    expect(set.mods.map((m) => m.projectId)).toEqual(["A", "B"]);
    expect(set.unknowns.map((u) => u.what)).toContain("A needs secret-lib.jar that isn't on Modrinth, so packsmith can't add it.");
  });

  it("flags unknown sides instead of guessing (DEP-4), and refuses mods in a pack without a loader", async () => {
    const odd = { ...proj("A"), client_side: "unknown" };
    const set = resolve({ mcVersion: "1.21.1", loader: "fabric", selection: [{ projectId: "A" }], projects: { A: odd }, candidates: { A: [synthetic("A", [])] }, versionsById: {}, supported: {}, installed: [] });
    expect(set.unknowns[0]!.what).toBe("Modrinth doesn't say whether A is needed on the client, the server or both.");
    const plain = resolve({ ...(await input([{ projectId: WAYSTONES }])), loader: "vanilla" });
    expect(plain.conflicts[0]!.explanation).toBe("Waystones is a mod, and this pack has no mod loader.");
  });
});

describe("resolveFromModrinth", () => {
  it("loads exactly what the resolver asks for, by slug, and gives the same answer", async () => {
    const d = await data();
    const calls: string[] = [];
    const { http } = fakeHttp({
      json: {
        [`${MODRINTH_API}/`]: (url: string) => {
          const u = new URL(url);
          calls.push(u.pathname);
          if (u.pathname === "/v2/projects") {
            const ids = JSON.parse(u.searchParams.get("ids")!) as string[];
            return Object.values(d.projects).filter((p) => ids.includes(p.id) || ids.includes(p.slug));
          }
          const m = /^\/v2\/project\/([^/]+)\/version$/.exec(u.pathname);
          if (m) return d.versions[m[1]!] ?? [];
          throw new Error(`unexpected ${url}`);
        },
      },
    });
    const { set } = await resolveFromModrinth(new ModrinthClient(http, new Throttle(1000)), [{ project: "waystones" }], "1.21.1", "fabric");
    expect(set.mods.map((m) => m.title)).toEqual(["Waystones", "Fabric API", "Balm"]);
    expect(set.conflicts).toEqual([]);
    // One project lookup per round, one version list per project, nothing fetched twice.
    expect(calls.filter((c) => c.endsWith("/version"))).toHaveLength(3);
    expect(new Set(calls.filter((c) => c.endsWith("/version"))).size).toBe(3);
  });
});
