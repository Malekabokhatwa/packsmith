// The I/O half of M-3: load from Modrinth exactly the data the pure resolver asks for, run it
// again, repeat until it asks for nothing more. Batched where Modrinth allows (projects and
// versions by id); throttled by the client (PERF-1).
import type { Loader, ResolvedSet } from "@shared/schema";
import type { ModrinthClient, ModrinthProject, ModrinthVersion } from "../sources/modrinth";
import { checkPack, noNeeds, resolve, type Installed, type PackCheck, type ResolveInput } from "./resolve";
import { AppError } from "../errors";

export interface SelectionRef { project?: string; versionId?: string; reasonText?: string } // project = id or slug

const MAX_ROUNDS = 25; // dependency depth; real chains are a handful deep

export interface Resolution { set: ResolvedSet; version: (id: string) => ModrinthVersion | undefined }

export async function resolveFromModrinth(modrinth: ModrinthClient, refs: SelectionRef[], mcVersion: string, loader: Loader, installed: Installed[] = []): Promise<Resolution> {
  const input: ResolveInput = { mcVersion, loader, selection: [], projects: {}, candidates: {}, versionsById: {}, supported: {}, installed };
  const tried = { projects: new Set<string>(), versions: new Set<string>(), candidates: new Set<string>(), supported: new Set<string>() };

  const addProjects = (ps: ModrinthProject[]) => { for (const p of ps) input.projects[p.id] = p; };
  const addVersions = (vs: ModrinthVersion[]) => { for (const v of vs) input.versionsById[v.id] = v; };

  // Selection: versions named directly tell us their project; slugs become ids.
  const pins = refs.flatMap((r) => (r.versionId ? [r.versionId] : []));
  if (pins.length) { addVersions(await modrinth.versionsByIds(pins)); pins.forEach((id) => tried.versions.add(id)); }
  const named = refs.map((r) => r.project ?? (r.versionId ? input.versionsById[r.versionId]?.project_id : undefined));
  const lookups = [...new Set(named.filter((x): x is string => !!x))];
  if (lookups.length) { addProjects(await modrinth.projects(lookups)); lookups.forEach((id) => tried.projects.add(id)); }
  const bySlug = new Map(Object.values(input.projects).map((p) => [p.slug, p.id]));
  input.selection = refs.map((r, i) => {
    const ref = named[i];
    if (!ref) throw new AppError("bad-selection", "Each pick needs a Modrinth project or version id.");
    return { projectId: input.projects[ref]?.id ?? bySlug.get(ref) ?? ref, versionId: r.versionId, reasonText: r.reasonText };
  });

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const needs = noNeeds();
    const set = resolve(input, needs);
    const fresh = <K extends keyof typeof tried>(k: K) => [...needs[k]].filter((x) => !tried[k].has(x));
    const projects = fresh("projects");
    const versions = fresh("versions");
    const candidates = fresh("candidates");
    const supported = fresh("supported");
    if (!projects.length && !versions.length && !candidates.length && !supported.length) {
      const all = new Map(Object.values(input.candidates).flat().concat(Object.values(input.versionsById)).map((v) => [v.id, v]));
      return { set, version: (id) => all.get(id) };
    }

    if (versions.length) { addVersions(await modrinth.versionsByIds(versions)); versions.forEach((x) => tried.versions.add(x)); }
    if (projects.length) { addProjects(await modrinth.projects(projects)); projects.forEach((x) => tried.projects.add(x)); }
    for (const id of candidates) {
      tried.candidates.add(id);
      const type = input.projects[id]?.project_type;
      // Mods filter by loader; shaders and resource packs only by game version.
      input.candidates[id] = type === "mod" && loader === "vanilla" ? [] : await modrinth.versions(id, { loaders: type === "mod" ? [loader] : undefined, gameVersions: [mcVersion] });
    }
    for (const id of supported) {
      tried.supported.add(id);
      const type = input.projects[id]?.project_type;
      const all = type === "mod" && loader === "vanilla" ? [] : await modrinth.versions(id, { loaders: type === "mod" ? [loader] : undefined });
      input.supported[id] = all.flatMap((v) => v.game_versions);
    }
  }
  throw new AppError("resolve-too-deep", "The dependency chain went deeper than packsmith follows. Try adding fewer projects at once.");
}

// checkPack with its data loaded: the installed versions, and the projects of dependencies that
// name only a version. Titles come back for everything it reports.
export async function checkInstalled(modrinth: ModrinthClient, installed: Installed[]): Promise<PackCheck & { title: (id: string) => string }> {
  const versions = installed.length ? await modrinth.versionsByIds(installed.map((i) => i.versionId)) : [];
  const byVersionOnly = [...new Set(versions.flatMap((v) => v.dependencies.flatMap((d) => (!d.project_id && d.version_id ? [d.version_id] : []))))];
  const depVersions = byVersionOnly.length ? await modrinth.versionsByIds(byVersionOnly) : [];
  const projectOf = new Map(depVersions.map((v) => [v.id, v.project_id]));
  const check = checkPack(versions, (id) => projectOf.get(id));
  const ids = [...new Set([...check.missing.flatMap((m) => [m.projectId, ...m.neededBy]), ...check.incompatible.flat()])];
  const titles = new Map((ids.length ? await modrinth.projects(ids) : []).map((p) => [p.id, p.title]));
  return { ...check, title: (id) => titles.get(id) ?? id };
}
