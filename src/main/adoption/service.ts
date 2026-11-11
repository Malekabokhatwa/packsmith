// M-14 adoption (SPEC 6.13, D-33): read-only discovery of the user's Prism instances, explicit
// adoption with scopes and a snapshot before the first write, and revoking. Discovery reads only
// instance.cfg, mmc-pack.json and the number of files in minecraft/mods (ADP-1, INS-3).
import { lstat, readdir, realpath } from "node:fs/promises";
import { join, relative } from "node:path";
import { AdoptionManifest, type AdoptionScope, type InstanceRecord, type Loader } from "@shared/schema";
import { prismInstancesDir, readPrismInstance } from "../launchers/prism";
import { MARKER_FILE } from "../instances/marker";
import { sha256File } from "../instances/journal";
import type { Registry } from "../instances/registry";
import { readJson, writeJsonAtomic } from "../store/jsonFile";
import { AppError } from "../errors";

export interface DiscoveredInstance {
  ref: string;            // the instance's folder name inside Prism's instances folder
  name: string;
  mcVersion?: string;
  loader?: Loader;
  modFiles: number;
  adoptable: boolean;
  reason?: string;        // why it can't be managed, when it can't
}

export interface AdoptionDeps {
  dataDir: string;
  registry: Registry;
  prismRoot: () => Promise<string | null>;
  now?: () => Date;
}

// Folders (or files) each scope covers, relative to the instance root: what the snapshot hashes.
const SCOPE_PATHS: Record<AdoptionScope, string[]> = {
  mods: ["minecraft/mods"], configs: ["minecraft/config"], settings: ["minecraft/options.txt"],
  shaders: ["minecraft/shaderpacks"], resourcepacks: ["minecraft/resourcepacks"],
  quests: ["minecraft/config/heracles", "minecraft/config/ftbquests"], loader: ["mmc-pack.json"],
};

export class Adoptions {
  constructor(private readonly d: AdoptionDeps) {}

  private file(id: string) { return join(this.d.dataDir, "adoptions", `${id}.json`); }

  private async instancesDir(): Promise<string> {
    const root = await this.d.prismRoot();
    if (!root) throw new AppError("no-prism", "Couldn't find Prism Launcher. Pick its folder in Settings.");
    return prismInstancesDir(root);
  }

  // Every Prism instance packsmith neither made nor manages, as metadata only.
  async discover(): Promise<DiscoveredInstance[]> {
    const dir = await this.instancesDir();
    const known = new Set(await Promise.all((await this.d.registry.all()).map((r) => realpath(r.path).catch(() => r.path))));
    const out: DiscoveredInstance[] = [];
    for (const ref of (await readdir(dir).catch(() => [] as string[])).sort()) {
      const path = join(dir, ref);
      if (!(await lstat(path).catch(() => null))?.isDirectory()) continue;
      if (known.has(await realpath(path).catch(() => path))) continue;
      if (await lstat(join(path, MARKER_FILE)).catch(() => null)) continue; // packsmith's own (even if its marker is damaged)
      const info = await readPrismInstance(path);
      if (!info) continue; // not an instance (Prism's own folders like _LAUNCHER_TEMP)
      const game = await lstat(join(path, "minecraft")).catch(() => null);
      const modFiles = (await readdir(join(path, "minecraft", "mods")).catch(() => [] as string[])).length;
      const reason = !game?.isDirectory() ? "Its game folder isn't minecraft/ (older Prism layout), which packsmith can't manage yet."
        : !info.mcVersion ? "Its mmc-pack.json doesn't name a Minecraft version."
        : !info.loader ? "It uses a mod loader packsmith doesn't support (only Fabric, Forge and NeoForge)."
        : undefined;
      out.push({ ref, name: info.name, mcVersion: info.mcVersion, loader: info.loader, modFiles, adoptable: !reason, reason });
    }
    // By the name the user sees in Prism, not the folder name (folder names often differ from it).
    return out.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  }

  // The user's click (never the model's): record the scope, snapshot what it covers, register.
  async adopt(ref: string, scope: AdoptionScope[]): Promise<InstanceRecord> {
    if (!/^[^/\\]+$/.test(ref) || ref === "." || ref === "..") throw new AppError("bad-path", "That isn't an instance folder name.");
    if (!scope.length) throw new AppError("no-scope", "Pick at least one thing packsmith may change.");
    const found = (await this.discover()).find((x) => x.ref === ref);
    if (!found) throw new AppError("unknown-instance", "That instance isn't in Prism's list any more, or packsmith already manages it.");
    if (!found.adoptable) throw new AppError("not-adoptable", found.reason!);
    const path = join(await this.instancesDir(), ref);
    const at = (this.d.now?.() ?? new Date()).toISOString();
    // Readable and stable: a-<name>, numbered only when another managed instance has the name.
    const taken = new Set((await this.d.registry.all()).map((r) => r.id));
    let id = `a-${slug(found.name)}`;
    for (let n = 2; taken.has(id); n++) id = `a-${slug(found.name)}-${n}`;
    const snapshot = await snapshotOf(path, scope);
    const manifest = AdoptionManifest.parse({ id, instancePath: path, launcher: "prism", scope, adoptedAt: at, snapshot });
    await writeJsonAtomic(this.file(id), manifest);
    const record: InstanceRecord = {
      id, origin: "adopted", launcher: "prism", path, name: found.name, mcVersion: found.mcVersion!, loader: found.loader!,
      createdAt: at, groupPending: false, adoptionId: id, scope,
    };
    await this.d.registry.mutate((list) => { if (!list.some((r) => r.id === id)) list.push(record); });
    return record;
  }

  // Back to INS-3's hard boundary: no record, nothing can write it. The manifest stays as history.
  async revoke(id: string): Promise<void> {
    const r = await this.d.registry.get(id);
    if (r.origin !== "adopted") throw new AppError("not-adopted", `"${r.name}" is a pack packsmith made, not one it manages.`);
    await this.d.registry.mutate((list) => { const i = list.findIndex((x) => x.id === id); if (i >= 0) list.splice(i, 1); });
    const m = await readJson(this.file(id), AdoptionManifest.nullable(), null);
    if (m) await writeJsonAtomic(this.file(id), { ...m, revokedAt: (this.d.now?.() ?? new Date()).toISOString() });
  }

  manifest(id: string): Promise<AdoptionManifest | null> {
    return readJson(this.file(id), AdoptionManifest.nullable(), null);
  }
}

const slug = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "instance";

// ADP-6: every file the scopes cover, hashed before packsmith writes anything. Links aren't followed.
async function snapshotOf(root: string, scope: AdoptionScope[]): Promise<AdoptionManifest["snapshot"]> {
  const out: AdoptionManifest["snapshot"] = [];
  const seen = new Set<string>();
  async function walk(abs: string): Promise<void> {
    const st = await lstat(abs).catch(() => null);
    if (!st || st.isSymbolicLink()) return;
    if (st.isDirectory()) {
      for (const n of (await readdir(abs)).sort()) await walk(join(abs, n));
      return;
    }
    const rel = relative(root, abs);
    if (!st.isFile() || seen.has(rel)) return;
    seen.add(rel);
    out.push({ relpath: rel, sha256: (await sha256File(abs))!, bytes: st.size });
  }
  for (const s of scope) for (const p of SCOPE_PATHS[s]) await walk(join(root, p));
  return out;
}
