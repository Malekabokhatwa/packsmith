// M-2 Modrinth client, the first SourceProvider (spec D-4). Read-only public API v2, no key.
// PERF-1: identifying User-Agent and a client-side throttle well under the 300 req/min limit.
import { z } from "zod";
import type { Http } from "../net/http";
import type { Loader } from "@shared/schema";
import type { ProjectType, SearchHit } from "@shared/ipc";
import { AppError } from "../errors";

export const MODRINTH_API = "https://api.modrinth.com/v2";
export const MODRINTH_HOSTS = ["api.modrinth.com"] as const;
export const MODRINTH_CDN_HOSTS = ["cdn.modrinth.com"] as const;
export const USER_AGENT = "packsmith/0.1.0 (github.com/Malekabokhatwa/packsmith)";

const SearchResponse = z.object({
  hits: z.array(z.object({
    project_id: z.string(), slug: z.string(), title: z.string(), description: z.string(),
    icon_url: z.string().nullish(), downloads: z.number(), project_type: z.string(),
    categories: z.array(z.string()), client_side: z.string(), server_side: z.string(), license: z.string().nullish(),
  })),
});

export const ModrinthFile = z.object({
  url: z.string(), filename: z.string(), primary: z.boolean(), size: z.number(),
  hashes: z.object({ sha1: z.string(), sha512: z.string() }),
});
export const ModrinthVersion = z.object({
  id: z.string(), project_id: z.string(), version_number: z.string(), version_type: z.enum(["release", "beta", "alpha"]),
  loaders: z.array(z.string()), game_versions: z.array(z.string()), date_published: z.string(),
  dependencies: z.array(z.object({
    version_id: z.string().nullish(), project_id: z.string().nullish(), file_name: z.string().nullish(),
    dependency_type: z.enum(["required", "optional", "incompatible", "embedded"]),
  })),
  files: z.array(ModrinthFile),
});
export type ModrinthVersion = z.infer<typeof ModrinthVersion>;

export const ModrinthProject = z.object({
  id: z.string(), slug: z.string(), title: z.string(), description: z.string(), project_type: z.string(),
  icon_url: z.string().nullish(), categories: z.array(z.string()), client_side: z.string(), server_side: z.string(),
  license: z.object({ id: z.string() }).nullish(),
});
export type ModrinthProject = z.infer<typeof ModrinthProject>;

const GameVersionTag = z.array(z.object({ version: z.string(), version_type: z.string(), date: z.string() }));

// Sliding-window throttle shared by all calls from this client.
export class Throttle {
  private stamps: number[] = [];
  constructor(private readonly perMinute: number, private readonly now = () => Date.now(),
    private readonly sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))) {}
  async take(): Promise<void> {
    for (;;) {
      const t = this.now();
      this.stamps = this.stamps.filter((s) => t - s < 60_000);
      if (this.stamps.length < this.perMinute) { this.stamps.push(t); return; }
      await this.sleep(60_000 - (t - this.stamps[0]!) + 5);
    }
  }
}

function parse<S extends z.ZodType>(schema: S, data: unknown, what: string): z.output<S> {
  const r = schema.safeParse(data);
  if (!r.success) throw new AppError("modrinth-format", `Modrinth sent ${what} in a format packsmith doesn't understand.`, { cause: r.error });
  return r.data;
}

export class ModrinthClient {
  private readonly throttle: Throttle;
  constructor(private readonly http: Http, throttle?: Throttle) {
    this.throttle = throttle ?? new Throttle(200);
  }

  private async get(path: string): Promise<unknown> {
    await this.throttle.take();
    return this.http.json(`${MODRINTH_API}${path}`, { allowHosts: MODRINTH_HOSTS, headers: { "user-agent": USER_AGENT } });
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    await this.throttle.take();
    return this.http.json(`${MODRINTH_API}${path}`, {
      method: "POST", allowHosts: MODRINTH_HOSTS, body: JSON.stringify(body),
      headers: { "user-agent": USER_AGENT, "content-type": "application/json" },
    });
  }

  async search(query: string, f: { mcVersion: string; loader: Loader; projectType: ProjectType; limit?: number }): Promise<SearchHit[]> {
    const facets: string[][] = [[`project_type:${f.projectType}`], [`versions:${f.mcVersion}`]];
    // Loader categories only apply to mods; shaders and resource packs use their own categories.
    if (f.projectType === "mod") facets.push([`categories:${f.loader}`]);
    const qs = new URLSearchParams({ query, limit: String(f.limit ?? 20), index: "relevance", facets: JSON.stringify(facets) });
    const data = parse(SearchResponse, await this.get(`/search?${qs}`), "search results");
    return data.hits.map((h) => ({
      projectId: h.project_id, slug: h.slug, title: h.title, summary: h.description, iconUrl: h.icon_url ?? undefined,
      downloads: h.downloads, projectType: h.project_type, categories: h.categories,
      clientSide: h.client_side, serverSide: h.server_side, license: h.license ?? undefined,
    }));
  }

  // A 404 here almost always means a wrong or made-up id: say so in words the model can act on.
  private async getProjectPath(idOrSlug: string, path: string): Promise<unknown> {
    try {
      return await this.get(`/project/${encodeURIComponent(idOrSlug)}${path}`);
    } catch (err) {
      if (err instanceof AppError && err.code === "not-found") throw new AppError("not-found", `Modrinth has no project "${idOrSlug}". Use an id or slug exactly as search_modrinth returned it.`);
      throw err;
    }
  }

  async project(idOrSlug: string): Promise<ModrinthProject> {
    return parse(ModrinthProject, await this.getProjectPath(idOrSlug, ""), "a project");
  }

  async projects(ids: string[]): Promise<ModrinthProject[]> {
    if (ids.length === 0) return [];
    const out: ModrinthProject[] = [];
    for (let i = 0; i < ids.length; i += 100) {
      const qs = new URLSearchParams({ ids: JSON.stringify(ids.slice(i, i + 100)) });
      out.push(...parse(z.array(ModrinthProject), await this.get(`/projects?${qs}`), "projects"));
    }
    return out;
  }

  async versions(projectId: string, f: { loaders?: string[]; gameVersions?: string[] } = {}): Promise<ModrinthVersion[]> {
    const qs = new URLSearchParams();
    if (f.loaders) qs.set("loaders", JSON.stringify(f.loaders));
    if (f.gameVersions) qs.set("game_versions", JSON.stringify(f.gameVersions));
    const q = qs.size ? `?${qs}` : "";
    return parse(z.array(ModrinthVersion), await this.getProjectPath(projectId, `/version${q}`), "versions");
  }

  async version(versionId: string): Promise<ModrinthVersion> {
    try {
      return parse(ModrinthVersion, await this.get(`/version/${encodeURIComponent(versionId)}`), "a version");
    } catch (err) {
      if (err instanceof AppError && err.code === "not-found") throw new AppError("not-found", `Modrinth has no version "${versionId}". Use a version id exactly as get_versions returned it.`);
      throw err;
    }
  }

  async versionsByIds(ids: string[]): Promise<ModrinthVersion[]> {
    const out: ModrinthVersion[] = [];
    for (let i = 0; i < ids.length; i += 100) {
      const qs = new URLSearchParams({ ids: JSON.stringify(ids.slice(i, i + 100)) });
      out.push(...parse(z.array(ModrinthVersion), await this.get(`/versions?${qs}`), "versions"));
    }
    return out;
  }

  // Newest version fitting a loader + game version, for each installed file (by hash): one
  // request for a whole pack (INT-2 update check).
  async latestByHash(sha512s: string[], loaders: string[] | undefined, gameVersions: string[]): Promise<Record<string, ModrinthVersion>> {
    const out: Record<string, ModrinthVersion> = {};
    for (let i = 0; i < sha512s.length; i += 500) {
      const res = await this.post("/version_files/update", { hashes: sha512s.slice(i, i + 500), algorithm: "sha512", ...(loaders ? { loaders } : {}), game_versions: gameVersions });
      Object.assign(out, parse(z.record(z.string(), ModrinthVersion), res, "updates"));
    }
    return out;
  }

  // Batch lookup of installed files by hash: one request for a whole instance (PERF-1).
  async versionsByHash(sha512s: string[]): Promise<Record<string, ModrinthVersion>> {
    const out: Record<string, ModrinthVersion> = {};
    for (let i = 0; i < sha512s.length; i += 500) {
      const res = await this.post("/version_files", { hashes: sha512s.slice(i, i + 500), algorithm: "sha512" });
      Object.assign(out, parse(z.record(z.string(), ModrinthVersion), res, "file matches"));
    }
    return out;
  }

  async releaseGameVersions(): Promise<string[]> {
    const tags = parse(GameVersionTag, await this.get("/tag/game_version"), "game versions");
    return tags.filter((t) => t.version_type === "release").map((t) => t.version);
  }
}

// Pick the version to install: newest release, else newest beta, else newest alpha.
// The API already filters by loader + game version and returns newest first.
export function pickVersion(versions: ModrinthVersion[]): ModrinthVersion | undefined {
  for (const type of ["release", "beta", "alpha"] as const) {
    const v = versions.find((x) => x.version_type === type);
    if (v) return v;
  }
  return undefined;
}

export function primaryFile(v: ModrinthVersion) {
  return v.files.find((f) => f.primary) ?? v.files[0];
}
