import { AppError } from "../src/main/errors";
import { describe, expect, it } from "vitest";
import { ModrinthClient, MODRINTH_API, pickVersion, Throttle, USER_AGENT, type ModrinthVersion } from "../src/main/sources/modrinth";
import { fakeHttp, fixture } from "./helpers";

const noWait = new Throttle(1000);

describe("Modrinth client (M-2)", () => {
  it("searches mods with project type, version and loader facets, the identifying User-Agent and the host allowlist", async () => {
    const { http, calls } = fakeHttp({ json: { [`${MODRINTH_API}/search`]: await fixture("search.json") } });
    const hits = await new ModrinthClient(http, noWait).search("xaero's minimap", { mcVersion: "1.21.1", loader: "fabric", projectType: "mod" });
    expect(hits[0]).toMatchObject({ projectId: "1bokaNcj", title: "Xaero's Minimap", projectType: "mod" });
    const u = new URL(calls[0]!.url);
    expect(JSON.parse(u.searchParams.get("facets")!)).toEqual([["project_type:mod"], ["versions:1.21.1"], ["categories:fabric"]]);
    expect(calls[0]!.opts?.headers?.["user-agent"]).toBe(USER_AGENT);
    expect(calls[0]!.opts?.allowHosts).toEqual(["api.modrinth.com"]);
  });

  it("does not add a loader facet for shaders or resource packs", async () => {
    const { http, calls } = fakeHttp({ json: { [`${MODRINTH_API}/search`]: { hits: [] } } });
    await new ModrinthClient(http, noWait).search("", { mcVersion: "1.21.1", loader: "fabric", projectType: "shader" });
    expect(JSON.parse(new URL(calls[0]!.url).searchParams.get("facets")!)).toEqual([["project_type:shader"], ["versions:1.21.1"]]);
  });

  it("parses recorded project and versions responses", async () => {
    const { http, calls } = fakeHttp({ json: {
      [`${MODRINTH_API}/project/xaeros-minimap/version`]: await fixture("versions.json"),
      [`${MODRINTH_API}/project/xaeros-minimap`]: await fixture("project.json"),
    } });
    const c = new ModrinthClient(http, noWait);
    expect((await c.project("xaeros-minimap")).title).toBe("Xaero's Minimap");
    const vs = await c.versions("xaeros-minimap", { loaders: ["fabric"], gameVersions: ["1.21.1"] });
    expect(vs[0]!.files[0]!.hashes.sha512).toMatch(/^[0-9a-f]{128}$/);
    expect(new URL(calls[1]!.url).searchParams.get("loaders")).toBe('["fabric"]');
  });

  it("refuses a response in an unexpected shape with a clear error", async () => {
    const { http } = fakeHttp({ json: { [`${MODRINTH_API}/search`]: { nope: true } } });
    await expect(new ModrinthClient(http, noWait).search("x", { mcVersion: "1.21.1", loader: "fabric", projectType: "mod" }))
      .rejects.toMatchObject({ code: "modrinth-format" });
  });

  it("keeps only release game versions", async () => {
    const { http } = fakeHttp({ json: { [`${MODRINTH_API}/tag/game_version`]: await fixture("game_versions.json") } });
    const v = await new ModrinthClient(http, noWait).releaseGameVersions();
    expect(v.length).toBeGreaterThan(0);
    expect(v.every((x) => !/w|pre|rc/.test(x))).toBe(true);
  });

  it("batches hash lookups into one request per 500 files", async () => {
    let posts = 0;
    const { http } = fakeHttp({ json: { [`${MODRINTH_API}/version_files`]: () => { posts++; return {}; } } });
    await new ModrinthClient(http, noWait).versionsByHash(Array.from({ length: 501 }, (_, i) => String(i).padStart(128, "0")));
    expect(posts).toBe(2);
  });
});

describe("pickVersion", () => {
  const v = (id: string, version_type: ModrinthVersion["version_type"]) => ({ id, version_type }) as ModrinthVersion;
  it("prefers the newest release, then beta, then alpha", () => {
    expect(pickVersion([v("a1", "alpha"), v("b1", "beta"), v("r1", "release"), v("r0", "release")])?.id).toBe("r1");
    expect(pickVersion([v("a1", "alpha"), v("b1", "beta")])?.id).toBe("b1");
    expect(pickVersion([])).toBeUndefined();
  });
});

describe("Throttle (PERF-1)", () => {
  it("never allows more than the limit within a minute", async () => {
    let now = 0;
    const slept: number[] = [];
    const t = new Throttle(3, () => now, async (ms) => { slept.push(ms); now += ms; });
    for (let i = 0; i < 4; i++) await t.take();
    expect(slept).toEqual([60_005]);
  });

  it("turns a 404 for a wrong project or version id into a sentence the agent can act on", async () => {
    const { http } = fakeHttp({ json: { [`${MODRINTH_API}/`]: () => { throw new AppError("not-found", "api.modrinth.com answered 404."); } } });
    const m = new ModrinthClient(http, new Throttle(1000));
    await expect(m.versions("AANB3E16", { gameVersions: ["1.21.1"] })).rejects.toThrow('Modrinth has no project "AANB3E16". Use an id or slug exactly as search_modrinth returned it.');
    await expect(m.project("made-up")).rejects.toMatchObject({ code: "not-found" });
    await expect(m.version("nope")).rejects.toThrow('Modrinth has no version "nope".');
  });
});
