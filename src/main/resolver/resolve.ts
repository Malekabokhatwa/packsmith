// M-3 resolver (spec 6.2, DEP-1..5): a pure function from a selection plus the Modrinth data
// fetched for it (fetch.ts) to a ResolvedSet. No I/O here, so every rule is unit-tested on
// recorded data. One version per project; required dependencies are pulled in, optional ones
// become edges only, incompatible ones become conflicts with an explanation and a proposed fix.
// Cycles are detected and reported, never looped on: a project is visited once.
import type { Loader, ResolvedMod, ResolvedSet } from "@shared/schema";
import { newestFirst } from "@shared/mcVersion";
import { pickVersion, primaryFile, type ModrinthProject, type ModrinthVersion } from "../sources/modrinth";

export interface Selected { projectId: string; versionId?: string; reasonText?: string }
export interface Installed { projectId: string; versionId: string }

export interface ResolveInput {
  mcVersion: string;
  loader: Loader;
  selection: Selected[];                         // project ids (not slugs), see fetch.ts
  projects: Record<string, ModrinthProject>;
  candidates: Record<string, ModrinthVersion[]>; // versions that fit this pack, newest first
  versionsById: Record<string, ModrinthVersion>; // pinned versions, installed versions
  supported: Record<string, string[]>;           // Minecraft versions a project has for this loader (for fixes)
  installed: Installed[];
}

const SIDES = new Set(["required", "optional", "unsupported", "unknown"]);
const side = (s: string | undefined) => (s && SIDES.has(s) ? s : "unknown") as ResolvedMod["clientSide"];
const LOADER_NAME: Record<Loader, string> = { vanilla: "no mod loader", fabric: "Fabric", forge: "Forge", neoforge: "NeoForge" };

// A version fits the pack when it is for this Minecraft version and, for mods, this loader.
export function fits(v: ModrinthVersion, projectType: string, mc: string, loader: Loader): boolean {
  if (!v.game_versions.includes(mc)) return false;
  return projectType !== "mod" || v.loaders.includes(loader);
}

// Data the resolver wanted but wasn't given. fetch.ts loads exactly this and runs again until
// nothing is missing, so the fetching never needs its own copy of the picking rules.
export interface ResolveNeeds { projects: Set<string>; versions: Set<string>; candidates: Set<string>; supported: Set<string> }
export const noNeeds = (): ResolveNeeds => ({ projects: new Set(), versions: new Set(), candidates: new Set(), supported: new Set() });

export function resolve(input: ResolveInput, needs: ResolveNeeds = noNeeds()): ResolvedSet {
  const { mcVersion: mc, loader } = input;
  const out: ResolvedSet = { mcVersion: mc, loader, mods: [], edges: [], conflicts: [], unknowns: [], cycles: [] };
  const chosen = new Map<string, { mod: ResolvedMod; version?: ModrinthVersion }>();
  const installed = new Map(input.installed.map((i) => [i.projectId, i]));
  const title = (id: string) => input.projects[id]?.title ?? id;
  const where = `${LOADER_NAME[loader]} ${mc}`;
  const seenEdge = new Set<string>();
  const edge = (from: string, to: string, kind: ResolvedSet["edges"][number]["kind"]) => {
    const k = `${from}>${to}>${kind}`;
    if (!seenEdge.has(k)) { seenEdge.add(k); out.edges.push({ from, to, kind }); }
  };

  type Job = { projectId: string; pin?: string; of?: string; reasonText?: string };
  const queue: Job[] = input.selection.map((s) => ({ projectId: s.projectId, pin: s.versionId, reasonText: s.reasonText }));

  while (queue.length) {
    const job = queue.shift()!;
    const p = input.projects[job.projectId];
    const existing = chosen.get(job.projectId);
    if (existing) {
      if (job.of && !existing.mod.reason.of.includes(job.of)) existing.mod.reason.of.push(job.of);
      if (job.pin && existing.version && existing.version.id !== job.pin && !job.of && !existing.mod.reason.of.length) {
        out.conflicts.push({ a: job.projectId, b: job.projectId, explanation: `${title(job.projectId)} was asked for in two different versions.`, proposedFix: `Keep one version of ${title(job.projectId)}.` });
      }
      continue;
    }
    if (!p) {
      needs.projects.add(job.projectId);
      out.unknowns.push({ projectId: job.projectId, what: job.of ? `${title(job.of)} needs a project Modrinth didn't return (${job.projectId}).` : `Modrinth has no project ${job.projectId}.` });
      continue;
    }
    const reason: ResolvedMod["reason"] = job.of
      ? { kind: "dependency", of: [job.of], text: undefined }
      : { kind: "requested", of: [], text: job.reasonText };

    // Already in the pack: keep it as it is and don't walk its dependencies again. Also when an
    // exact other version is asked for: installing it would leave two jars of one mod. Changing
    // the version is Update's job (it replaces the file through the journal), so say so instead.
    const inst = installed.get(p.id);
    if (inst) {
      const v = input.versionsById[inst.versionId];
      if (!v) needs.versions.add(inst.versionId);
      if (job.pin && job.pin !== inst.versionId && !job.of) {
        const asked = input.versionsById[job.pin];
        if (!asked) needs.versions.add(job.pin);
        out.unknowns.push({ projectId: p.id, what: `The pack already has ${p.title} ${v?.version_number ?? "installed"}, so packsmith kept it instead of adding ${asked?.version_number ?? "another version"} as a second copy. Update or remove it to change the version.` });
      }
      const mod: ResolvedMod = {
        projectId: p.id, versionId: inst.versionId, title: p.title, versionNumber: v?.version_number ?? "installed",
        projectType: p.project_type, bytes: 0, clientSide: side(p.client_side), serverSide: side(p.server_side),
        alreadyInstalled: true, reason: job.of ? reason : { kind: "pre-existing", of: [], text: undefined },
      };
      chosen.set(p.id, { mod, version: v });
      continue;
    }
    if (p.project_type === "mod" && loader === "vanilla") {
      out.conflicts.push({ a: p.id, b: "loader", explanation: `${p.title} is a mod, and this pack has no mod loader.`, proposedFix: "Add a loader to the pack (Fabric, Forge or NeoForge), or make a new pack with one." });
      continue;
    }

    let v: ModrinthVersion | undefined;
    if (job.pin) {
      const pinned = input.versionsById[job.pin];
      if (!pinned) needs.versions.add(job.pin);
      if (input.candidates[p.id] === undefined) needs.candidates.add(p.id);
      if (pinned && fits(pinned, p.project_type, mc, loader)) v = pinned;
      else if (!job.of) {
        out.conflicts.push({ a: p.id, b: "version", explanation: `The chosen version of ${p.title} isn't for ${where}.`, proposedFix: `Use a ${p.title} version made for ${where}.` });
        continue;
      } else {
        // A dependency pinned to a version for another game version: authors often pin loosely.
        // Use the newest fitting version instead and say so (DEP-4: flagged, not hidden).
        v = pickVersion(input.candidates[p.id] ?? []);
        if (v) out.unknowns.push({ projectId: p.id, what: `${title(job.of)} asks for a specific ${p.title} version that isn't for ${where}; using ${v.version_number} instead.` });
      }
    } else {
      if (input.candidates[p.id] === undefined) needs.candidates.add(p.id);
      v = pickVersion(input.candidates[p.id] ?? []);
    }
    if (!v) {
      // Only worth asking which versions it does have once we know it has none that fit.
      if (input.candidates[p.id] !== undefined && input.supported[p.id] === undefined) needs.supported.add(p.id);
      const others = newestFirst(input.supported[p.id] ?? []).slice(0, 3);
      const need = job.of ? `${title(job.of)} needs ${p.title}, and ${p.title}` : p.title;
      out.conflicts.push({
        a: job.of ?? p.id, b: p.id,
        explanation: `${need} has no version for ${where}.`,
        proposedFix: others.length
          ? `${p.title} has versions for ${LOADER_NAME[loader]} ${others.join(", ")}. Move the pack to one of those, or leave ${job.of ? title(job.of) : p.title} out.`
          : `Leave ${job.of ? title(job.of) : p.title} out, or try another loader.`,
      });
      continue;
    }

    const file = primaryFile(v);
    const mod: ResolvedMod = {
      projectId: p.id, versionId: v.id, title: p.title, versionNumber: v.version_number, projectType: p.project_type,
      bytes: file?.size ?? 0, iconUrl: p.icon_url ?? undefined, clientSide: side(p.client_side), serverSide: side(p.server_side), alreadyInstalled: false, reason,
    };
    chosen.set(p.id, { mod, version: v });

    for (const d of v.dependencies) {
      const target = d.project_id ?? (d.version_id ? input.versionsById[d.version_id]?.project_id : undefined);
      if (!target && d.version_id && d.dependency_type === "required") needs.versions.add(d.version_id);
      if (!target) {
        if (d.dependency_type === "required") out.unknowns.push({ projectId: p.id, what: `${p.title} needs ${d.file_name ?? "a file"} that isn't on Modrinth, so packsmith can't add it.` });
        continue;
      }
      edge(p.id, target, d.dependency_type);
      if (d.dependency_type === "required") queue.push({ projectId: target, pin: d.version_id ?? undefined, of: p.id });
    }
  }

  // Incompatibilities between anything in the result and anything already in the pack.
  const present = new Map<string, { mod: Pick<ResolvedMod, "projectId" | "title" | "alreadyInstalled">; version?: ModrinthVersion }>(chosen);
  for (const i of input.installed) {
    if (present.has(i.projectId)) continue;
    const v = input.versionsById[i.versionId];
    if (!v) needs.versions.add(i.versionId);
    present.set(i.projectId, { mod: { projectId: i.projectId, title: title(i.projectId), alreadyInstalled: true }, version: v });
  }
  const reported = new Set<string>();
  for (const { mod, version } of present.values()) {
    for (const d of version?.dependencies ?? []) {
      if (d.dependency_type !== "incompatible" || !d.project_id || !present.has(d.project_id)) continue;
      const other = present.get(d.project_id)!.mod;
      if (mod.alreadyInstalled && other.alreadyInstalled) continue; // the pack's own business, not this change
      edge(mod.projectId, d.project_id, "incompatible");
      const key = [mod.projectId, d.project_id].sort().join("|");
      if (reported.has(key)) continue;
      reported.add(key);
      const [fresh, kept] = mod.alreadyInstalled ? [other, mod] : [mod, other];
      const keep = kept.alreadyInstalled ? `Leave out ${fresh.title}, or remove ${kept.title} from the pack first.` : `Keep one of them: ${mod.title} or ${other.title}.`;
      out.conflicts.push({ a: mod.projectId, b: d.project_id, explanation: `${mod.title} doesn't work together with ${other.title} (its Modrinth page says so).`, proposedFix: keep });
    }
  }

  // DEP-4: a side Modrinth doesn't know is flagged, never guessed.
  for (const { mod } of chosen.values()) {
    if (mod.clientSide === "unknown" || mod.serverSide === "unknown") out.unknowns.push({ projectId: mod.projectId, what: `Modrinth doesn't say whether ${mod.title} is needed on the client, the server or both.` });
  }

  out.cycles = findCycles(out.edges.filter((e) => e.kind === "required"));
  out.mods = [...chosen.values()].map((c) => c.mod);
  return out;
}

// Required-dependency cycles (A needs B needs A). Reported so the user sees them; harmless to install.
export function findCycles(edges: Array<{ from: string; to: string }>): string[][] {
  const next = new Map<string, string[]>();
  for (const e of edges) next.set(e.from, [...(next.get(e.from) ?? []), e.to]);
  const cycles: string[][] = [];
  const seen = new Set<string>();
  const state = new Map<string, "open" | "done">();
  const stack: string[] = [];
  const visit = (n: string) => {
    state.set(n, "open");
    stack.push(n);
    for (const m of next.get(n) ?? []) {
      if (state.get(m) === "open") {
        const cycle = stack.slice(stack.indexOf(m));
        const key = [...cycle].sort().join("|");
        if (!seen.has(key)) { seen.add(key); cycles.push(cycle); }
      } else if (!state.has(m)) visit(m);
    }
    stack.pop();
    state.set(n, "done");
  };
  for (const n of next.keys()) if (!state.has(n)) visit(n);
  return cycles;
}

// What to download: everything resolved that isn't in the pack yet.
export function toDownload(set: ResolvedSet): ResolvedMod[] {
  return set.mods.filter((m) => !m.alreadyInstalled);
}

// One sentence per conflict, for errors shown to the user or the model (DEP-5).
export function explainConflicts(set: ResolvedSet): string {
  return set.conflicts.map((c) => `${c.explanation} ${c.proposedFix}`).join(" ");
}

// Rung 1 of the evidence ladder (SPEC 11.3): does a pack, as it is, have every required library
// and no two mods that refuse each other? Unlike resolve(), this walks the dependencies of what
// is already installed. `depProject` maps a dependency given only by version id to its project.
export interface PackCheck {
  missing: Array<{ projectId: string; neededBy: string[] }>;
  incompatible: Array<[string, string]>;
}
export function checkPack(installed: ModrinthVersion[], depProject: (versionId: string) => string | undefined): PackCheck {
  const present = new Set(installed.map((v) => v.project_id));
  const missing = new Map<string, string[]>();
  const incompatible: Array<[string, string]> = [];
  for (const v of installed) {
    for (const d of v.dependencies) {
      const target = d.project_id ?? (d.version_id ? depProject(d.version_id) : undefined);
      if (!target || target === v.project_id) continue;
      if (d.dependency_type === "required" && !present.has(target)) missing.set(target, [...(missing.get(target) ?? []), v.project_id]);
      if (d.dependency_type === "incompatible" && present.has(target) && !incompatible.some(([a, b]) => (a === target && b === v.project_id))) incompatible.push([v.project_id, target]);
    }
  }
  return { missing: [...missing].map(([projectId, neededBy]) => ({ projectId, neededBy })), incompatible };
}
