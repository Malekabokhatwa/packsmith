// Pack lifecycle: create packs, install Modrinth projects with their dependencies resolved (M-3),
// and change what's inside (on/off, update, remove, loader, config files). Every change runs
// through the journal (spec 4.3) and every path through assertWritable (INS-3). The UI (IPC)
// and the agent tools call these same functions.
import { join } from "node:path";
import { access, mkdir, readdir, readFile, rename, rm } from "node:fs/promises";
import type { ContentItem, InstanceRecord, JournalEntry, Loader } from "@shared/schema";
import type { Http } from "../net/http";
import { primaryFile, type ModrinthClient, type ModrinthVersion } from "../sources/modrinth";
import { latestLoaderVersion } from "../loaders";
import { addToPrismGroup, createPrismInstance, detectPrismRoot, prismInstancesDir, readPackComponents, withLoader } from "../launchers/prism";
import { CONTENT_DIR, createGameFolders } from "../launchers/layout";
import { downloadVerified, safeFilename } from "../download";
import { MARKER_FILE, readMarker, writeMarker } from "./marker";
import { scanInstance } from "./scan";
import type { Registry } from "./registry";
import type { Journal } from "./journal";
import type { SettingsStore } from "../settings";
import { resolveFromModrinth, type SelectionRef } from "../resolver/fetch";
import { explainConflicts, toDownload } from "../resolver/resolve";
import { checkConfig, formatFor } from "../config/formats";
import { writeFileAtomic } from "../store/jsonFile";
import { AppError } from "../errors";
import { ReasonStore, withReasons } from "./reasons";

export interface PackDeps {
  dataDir: string;
  http: Http;
  modrinth: ModrinthClient;
  registry: Registry;
  journal: Journal;
  settings: SettingsStore;
  prismRunning: () => Promise<boolean>;
  prismRoot?: () => Promise<string | null>;
  now?: () => Date;
}

export interface Installed { title: string; versionNumber: string; relpath: string }
export interface InstallResult {
  title: string;              // the requested project
  versionNumber: string;
  alreadyInstalled: boolean;  // nothing was downloaded for the requested project itself
  added: Installed[];         // every file downloaded, requested first, then what it needs
  unknowns: string[];         // DEP-4: things packsmith couldn't decide and says so
  entryId?: string;           // the journal entry (undo)
}
export interface Change { entry: JournalEntry }

// "A", "A and B", "A, B and C"
export function listText(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

export function slugify(name: string): string {
  const s = name.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return s || "pack";
}

const DIR_FOR_TYPE: Record<string, string> = { mod: CONTENT_DIR.mod, shader: CONTENT_DIR.shader, resourcepack: CONTENT_DIR.resourcepack };
const LOADER_NAME: Record<Loader, string> = { vanilla: "no mod loader", fabric: "Fabric", forge: "Forge", neoforge: "NeoForge" };
const CONTENT_FILE = /^minecraft\/(mods|shaderpacks|resourcepacks)\/[^/]+\.(jar|zip)(\.disabled)?$/i;

// Where the agent's file tools may act: the game folder, never the instance's own files (the
// marker, instance.cfg, mmc-pack.json: only set_loader changes those) and never worlds (NG-8).
function gameFile(relpath: string): void {
  if (!relpath.startsWith("minecraft/") || relpath.startsWith("minecraft/saves/")) {
    throw new AppError("bad-path", `packsmith only changes files in the pack's game folder (minecraft/), not worlds: ${relpath}`);
  }
}

// Shared by every download of one agent run (PERF-5).
export interface DownloadBudget { usedBytes: number; limitBytes: number }

export class Packs {
  private readonly reasons: ReasonStore;
  constructor(private readonly d: PackDeps) { this.reasons = new ReasonStore(d.dataDir); }

  private async resolvePrismRoot(): Promise<string> {
    const s = await this.d.settings.get();
    const root = s.launcher.root ?? (await (this.d.prismRoot ?? detectPrismRoot)());
    if (!root) throw new AppError("no-prism", "Couldn't find Prism Launcher. Pick its folder in Settings, or keep packs inside packsmith.");
    return root;
  }

  list(): Promise<InstanceRecord[]> {
    return this.d.registry.all();
  }

  // A pack packsmith may change: its own, or one the user adopted (each path is still checked
  // against the adoption's scope by assertWritable). Prism rewrites an instance's files while it
  // runs, so an adopted Prism instance waits until Prism is closed (D-33).
  private async own(id: string): Promise<InstanceRecord> {
    const r = await this.d.registry.get(id);
    if (r.origin !== "own" && r.origin !== "adopted") throw new AppError("not-writable", `packsmith only changes packs it made or you let it manage. "${r.name}" isn't one of them.`);
    if (r.origin === "adopted" && r.launcher === "prism" && (await this.d.prismRunning())) {
      throw new AppError("prism-running", `Close Prism Launcher first: it rewrites "${r.name}"'s files while it runs.`);
    }
    return r;
  }

  async create(input: { name: string; mcVersion: string; loader: Loader }): Promise<InstanceRecord> {
    const name = input.name.replace(/[\x00-\x1f\x7f]/g, "").trim();
    if (!name) throw new AppError("bad-name", "Give the pack a name.");
    const settings = await this.d.settings.get();
    const kind = settings.launcher.kind;
    if (kind === "official") throw new AppError("unsupported-launcher", "The Minecraft Launcher arrives in a later milestone. Choose Prism or keep packs inside packsmith.");
    if (kind === "prism" && !settings.launcher.prismWriteAllowed) {
      throw new AppError("prism-permission", "Allow packsmith to create instances in Prism (Settings → Launcher) first.");
    }
    const loaderVersion = await latestLoaderVersion(this.d.http, input.loader, input.mcVersion);

    const baseDir = kind === "prism" ? await prismInstancesDir(await this.resolvePrismRoot()) : join(this.d.dataDir, "instances");
    const existing = new Set([...(await this.d.registry.all()).map((r) => r.id), ...(await readdir(baseDir).catch(() => []))]);
    const stem = `packsmith-${input.mcVersion}-${slugify(name)}`;
    let id = stem;
    for (let n = 2; existing.has(id); n++) id = `${stem}-${n}`;
    const dir = join(baseDir, id);
    const createdAt = (this.d.now?.() ?? new Date()).toISOString();

    if (kind === "prism") {
      await createPrismInstance({ dir, name, mcVersion: input.mcVersion, loader: input.loader, loaderVersion });
    } else {
      await mkdir(baseDir, { recursive: true });
      await mkdir(dir); // not recursive: never reuse a folder that already exists
    }
    await createGameFolders(dir);
    await writeMarker(dir, { createdBy: "packsmith", version: 1, instanceId: id, kind: "pack", mcVersion: input.mcVersion, loader: input.loader, loaderVersion, packName: name, createdAt });

    const record: InstanceRecord = { id, origin: "own", launcher: kind, path: dir, name, mcVersion: input.mcVersion, loader: input.loader, loaderVersion, createdAt, groupPending: kind === "prism" };
    await this.d.registry.mutate((list) => { list.push(record); });
    if (kind === "prism") await this.syncPrismGroups();
    return this.d.registry.get(id);
  }

  // Add pending packs to Prism's "packsmith" group, but only while Prism is closed (it rewrites
  // the group file itself while running). Safe to call any time.
  async syncPrismGroups(): Promise<void> {
    if (await this.d.prismRunning()) return;
    const pending = (await this.d.registry.all()).filter((r) => r.launcher === "prism" && r.groupPending);
    if (pending.length === 0) return;
    const instancesDir = await prismInstancesDir(await this.resolvePrismRoot());
    for (const r of pending) {
      if (join(instancesDir, r.id) !== r.path) continue; // Prism folder moved; leave it ungrouped
      await addToPrismGroup(instancesDir, r.id);
      await this.d.registry.mutate((list) => {
        const x = list.find((i) => i.id === r.id);
        if (x) x.groupPending = false;
      });
    }
  }

  async scan(id: string): Promise<ContentItem[]> {
    const r = await this.d.registry.get(id);
    const items = await scanInstance(r.path, this.d.modrinth, { mcVersion: r.mcVersion, loader: r.loader });
    return withReasons(items, await this.reasons.all(r.id));
  }

  // ---------- installing (DEP-1..5) ----------

  // UI "Add": the newest version of a project that fits the pack, plus everything it needs.
  install(id: string, projectId: string, onProgress?: (done: number, total: number) => void): Promise<InstallResult> {
    return this.installSelection(id, [{ project: projectId }], { onProgress, by: "user" });
  }

  // The agent's download_file tool by project: the newest version that fits, with a reason.
  installProject(id: string, project: string, opts: { runId?: string; reason?: string; budget?: DownloadBudget } = {}): Promise<InstallResult> {
    return this.installSelection(id, [{ project, reasonText: opts.reason }], { ...opts, by: "agent" });
  }

  // The agent's download_file tool by version: an exact version, after checking it fits the pack.
  installVersionById(id: string, versionId: string, opts: { runId?: string; reason?: string; budget?: DownloadBudget } = {}): Promise<InstallResult> {
    return this.installSelection(id, [{ versionId, reasonText: opts.reason }], { ...opts, by: "agent" });
  }

  private async installSelection(id: string, refs: SelectionRef[], opts: { runId?: string; onProgress?: (done: number, total: number) => void; by: "user" | "agent"; budget?: DownloadBudget }): Promise<InstallResult> {
    const r = await this.own(id);
    const installed = (await this.scan(r.id)).flatMap((c) => (c.match.status === "modrinth" ? [{ projectId: c.match.projectId, versionId: c.match.versionId }] : []));
    const { set, version } = await resolveFromModrinth(this.d.modrinth, refs, r.mcVersion, r.loader, installed);
    if (set.conflicts.length) throw new AppError("conflict", explainConflicts(set));
    const requested = set.mods[0];
    if (!requested) throw new AppError("not-found", set.unknowns[0]?.what ?? "Modrinth has no such project.");

    const files: Array<{ title: string; versionNumber: string; relpath: string; file: NonNullable<ReturnType<typeof primaryFile>> }> = [];
    for (const m of toDownload(set)) {
      const dir = DIR_FOR_TYPE[m.projectType];
      if (!dir) throw new AppError("unsupported-type", `${m.title} is a ${m.projectType}, which packsmith can't install yet.`);
      const v = version(m.versionId);
      const file = v && primaryFile(v);
      if (!file) throw new AppError("no-file", `${m.title} ${m.versionNumber} has no file to download.`);
      files.push({ title: m.title, versionNumber: m.versionNumber, relpath: `${dir}/${safeFilename(file.filename)}`, file });
    }
    const result: InstallResult = {
      title: requested.title, versionNumber: requested.versionNumber, alreadyInstalled: requested.alreadyInstalled,
      added: files.map(({ title, versionNumber, relpath }) => ({ title, versionNumber, relpath })),
      unknowns: set.unknowns.map((u) => u.what),
    };
    if (!files.length) return result;

    // PERF-5: a run's download budget is checked with the real sizes, before anything downloads.
    const bytes = files.reduce((n, f) => n + f.file.size, 0);
    if (opts.budget && opts.budget.usedBytes + bytes > opts.budget.limitBytes) {
      const mb = (b: number) => Math.ceil(b / 1_048_576);
      throw new AppError("budget-disk", `Stopped: this download (${mb(bytes)} MB) would take the run past its download budget of ${mb(opts.budget.limitBytes)} MB (${mb(opts.budget.usedBytes)} MB used). Raise it in Settings to let runs download more.`);
    }
    const extra = files.slice(1).map((f) => f.title);
    const reason = `Added ${files[0]!.title}${extra.length ? `, plus ${listText(extra)}` : ""}`;
    const { entry } = await this.d.journal.record(r, { action: "download", reason, runId: opts.runId }, files.map((f) => f.relpath), async (abs) => {
      const total = files.reduce((n, f) => n + f.file.size, 0);
      let before = 0;
      for (const f of files) {
        await downloadVerified(this.d.http, f.file, abs.get(f.relpath)!, (done) => opts.onProgress?.(before + done, total));
        before += f.file.size;
      }
    });
    if (opts.budget) opts.budget.usedBytes += bytes;
    // GRP-1: why each new file is here, once it's really in the pack.
    await this.reasons.record(r.id, toDownload(set).map((m) => ({
      projectId: m.projectId,
      reason: m.reason.kind === "dependency" ? m.reason
        : opts.by === "agent" ? { kind: "agent-chosen" as const, of: [], ...(m.reason.text ? { text: m.reason.text } : {}) }
        : { kind: "requested" as const, of: [], ...(m.reason.text ? { text: m.reason.text } : {}) },
    })));
    return { ...result, entryId: entry.id };
  }

  // ---------- changing content (INT-2) ----------

  async setEnabled(id: string, relpath: string, enabled: boolean, opts: { runId?: string; label?: string } = {}): Promise<Change | null> {
    const r = await this.own(id);
    if (!CONTENT_FILE.test(relpath)) throw new AppError("bad-path", "Only mods, shaders and resource packs can be turned on or off.");
    const isOff = relpath.endsWith(".disabled");
    if (isOff === !enabled) return null; // already in that state
    const target = enabled ? relpath.slice(0, -".disabled".length) : `${relpath}.disabled`;
    const name = opts.label ?? target.split("/").pop()!.replace(/\.disabled$/, "");
    if (await access(join(r.path, target)).then(() => true, () => false)) {
      throw new AppError("exists", `${target} already exists, so packsmith didn't overwrite it.`);
    }
    const { entry } = await this.d.journal.record(r, { action: enabled ? "enable" : "disable", reason: `${enabled ? "Turned on" : "Turned off"} ${name}`, runId: opts.runId }, [relpath, target], async (abs) => {
      await rename(abs.get(relpath)!, abs.get(target)!);
    });
    return { entry };
  }

  async remove(id: string, relpath: string, opts: { runId?: string; label?: string } = {}): Promise<Change> {
    const r = await this.own(id);
    gameFile(relpath);
    const { entry } = await this.d.journal.record(r, { action: "remove", reason: `Removed ${opts.label ?? relpath.split("/").pop()}`, runId: opts.runId }, [relpath], async (abs) => {
      // The journal kept a copy before this line runs; undo puts it back.
      await rm(abs.get(relpath)!);
    });
    return { entry };
  }

  // Replace one installed file with the newest fitting version, plus anything new it needs.
  async update(id: string, relpath: string, runId?: string): Promise<InstallResult> {
    const r = await this.own(id);
    const items = await this.scan(r.id);
    const item = items.find((i) => i.relpath === relpath);
    if (!item || item.match.status !== "modrinth") throw new AppError("not-found", "That file isn't a Modrinth project packsmith can update.");
    const m = item.match;
    if (!m.update) throw new AppError("up-to-date", `${m.title} is already the newest version for this pack.`);
    const installed = items.flatMap((c) => (c.match.status === "modrinth" && c.relpath !== relpath ? [{ projectId: c.match.projectId, versionId: c.match.versionId }] : []));
    const { set, version } = await resolveFromModrinth(this.d.modrinth, [{ versionId: m.update.versionId }], r.mcVersion, r.loader, installed);
    if (set.conflicts.length) throw new AppError("conflict", explainConflicts(set));
    const files = toDownload(set).map((x) => {
      const file = primaryFile(version(x.versionId) as ModrinthVersion);
      if (!file) throw new AppError("no-file", `${x.title} ${x.versionNumber} has no file to download.`);
      return { title: x.title, versionNumber: x.versionNumber, relpath: `${DIR_FOR_TYPE[x.projectType] ?? CONTENT_DIR.mod}/${safeFilename(file.filename)}`, file };
    });
    const keepOff = !item.enabled; // an update keeps a turned-off file off
    const targets = files.map((f, i) => (i === 0 && keepOff ? { ...f, relpath: `${f.relpath}.disabled` } : f));
    const { entry } = await this.d.journal.record(r, { action: "update", reason: `Updated ${m.title} to ${m.update.versionNumber}`, runId }, [relpath, ...targets.map((f) => f.relpath)], async (abs) => {
      for (const f of targets) await downloadVerified(this.d.http, f.file, abs.get(f.relpath)!);
      if (!targets.some((f) => f.relpath === relpath)) await rm(abs.get(relpath)!);
    });
    return {
      title: m.title, versionNumber: m.update.versionNumber, alreadyInstalled: false, entryId: entry.id,
      added: targets.map(({ title, versionNumber, relpath: p }) => ({ title, versionNumber, relpath: p })), unknowns: set.unknowns.map((u) => u.what),
    };
  }

  // set_loader (D-11): change the pack's loader or loader version. Switching between loaders is
  // refused while mods are installed: they are built for one loader and wouldn't start.
  async setLoader(id: string, loader: Loader, loaderVersion?: string, runId?: string): Promise<{ entry: JournalEntry; loaderVersion?: string }> {
    const r = await this.own(id);
    if (r.origin === "adopted") return this.setAdoptedLoader(r, loader, loaderVersion, runId);
    if (loader !== r.loader && r.loader !== "vanilla") {
      const mods = (await this.scan(r.id)).filter((i) => i.kind === "mod");
      if (mods.length) throw new AppError("loader-has-mods", `"${r.name}" has ${mods.length} mod${mods.length === 1 ? "" : "s"} made for ${LOADER_NAME[r.loader]}. Remove them first, or make a new pack for ${LOADER_NAME[loader]}.`);
    }
    const version = loaderVersion ?? (await latestLoaderVersion(this.d.http, loader, r.mcVersion));
    const marker = await readMarker(r.path);
    if (!marker) throw new AppError("not-writable", `"${r.name}" no longer carries packsmith's marker, so packsmith won't change it.`);
    const files = r.launcher === "prism" ? [MARKER_FILE, "mmc-pack.json"] : [MARKER_FILE];
    const label = loader === "vanilla" ? "Removed the mod loader" : `Set the loader to ${LOADER_NAME[loader]} ${version}`;
    const { entry } = await this.d.journal.record(r, { action: "set-loader", reason: label, runId }, files, async (abs) => {
      if (r.launcher === "prism") await writeFileAtomic(abs.get("mmc-pack.json")!, withLoader(await readFile(abs.get("mmc-pack.json")!, "utf8"), loader, version));
      await writeMarker(r.path, { ...marker, loader, loaderVersion: version });
    });
    await this.syncFromMarker(r.id);
    return { entry, loaderVersion: version };
  }

  // ADP-4: a loader in place on a vanilla instance the user manages; its worlds are never touched.
  // A modded instance keeps its loader (its mods were made for it).
  private async setAdoptedLoader(r: InstanceRecord, loader: Loader, loaderVersion?: string, runId?: string): Promise<{ entry: JournalEntry; loaderVersion?: string }> {
    if (r.loader !== "vanilla") throw new AppError("loader-in-place", `"${r.name}" already runs ${LOADER_NAME[r.loader]}. packsmith only adds a loader to a vanilla instance; make a new pack for ${LOADER_NAME[loader]}.`);
    if (loader === "vanilla") throw new AppError("loader-in-place", `"${r.name}" is already vanilla.`);
    const version = loaderVersion ?? (await latestLoaderVersion(this.d.http, loader, r.mcVersion));
    const label = `Added ${LOADER_NAME[loader]} ${version} in place`;
    const { entry } = await this.d.journal.record(r, { action: "set-loader", reason: label, runId }, ["mmc-pack.json"], async (abs) => {
      await writeFileAtomic(abs.get("mmc-pack.json")!, withLoader(await readFile(abs.get("mmc-pack.json")!, "utf8"), loader, version));
    });
    await this.syncFromMarker(r.id);
    return { entry, loaderVersion: version };
  }

  // write_file (CFG-1/2): a config or game-settings file, parsed before it is written.
  async writeConfig(id: string, relpath: string, content: string, opts: { runId?: string; reason?: string } = {}): Promise<{ entry: JournalEntry; validated: boolean }> {
    const r = await this.own(id);
    gameFile(relpath);
    if (/^minecraft\/(mods|shaderpacks|resourcepacks)\//.test(relpath)) throw new AppError("bad-path", "Mods, shaders and resource packs are installed from Modrinth, not written as text.");
    const format = formatFor(relpath);
    if (!format) throw new AppError("unsupported-format", `packsmith only writes config files (.toml, .json, .json5, .properties, .snbt, .yaml, .txt, .cfg, .ini): ${relpath}`);
    const check = checkConfig(format, content);
    if (!check.ok) throw new AppError("invalid-config", `Didn't write ${relpath}: it isn't valid ${format === "options" ? "options.txt" : format}. ${check.error}`);
    const { entry } = await this.d.journal.record(r, { action: "write", reason: opts.reason ?? `Edited ${relpath.replace(/^minecraft\//, "")}`, runId: opts.runId }, [relpath], async (abs) => {
      await writeFileAtomic(abs.get(relpath)!, content);
    });
    return { entry, validated: format !== "plain" };
  }

  // ---------- journal ----------

  async history(id: string): Promise<JournalEntry[]> {
    return this.d.journal.list(await this.d.registry.get(id));
  }

  async undo(id: string, entryId: string): Promise<JournalEntry> {
    const r = await this.own(id);
    const e = await this.d.journal.rollback(r, entryId);
    if (e.action === "set-loader") await this.syncFromMarker(id);
    return e;
  }

  // Startup: roll back changes interrupted by a crash or quit (4.3), for every pack we own.
  async recoverAll(): Promise<number> {
    let n = 0;
    for (const r of await this.d.registry.all()) {
      if (r.origin !== "own" && r.origin !== "adopted") continue;
      try {
        const k = await this.d.journal.recover(r);
        if (k) await this.syncFromMarker(r.id);
        n += k;
      } catch (err) {
        console.error(`journal recovery for ${r.id} failed`, err); // the pack shows its journal; nothing else is touched
      }
    }
    return n;
  }

  // The marker is the pack's own record of its loader (an adopted Prism instance: its
  // mmc-pack.json); the registry follows it.
  private async syncFromMarker(id: string): Promise<void> {
    const r = await this.d.registry.get(id);
    const m = r.origin === "adopted"
      ? readPackComponents(await readFile(join(r.path, "mmc-pack.json"), "utf8"))
      : await readMarker(r.path);
    const loader = m?.loader;
    if (!loader) return;
    await this.d.registry.mutate((list) => {
      const x = list.find((i) => i.id === id);
      if (x) { x.loader = loader; x.loaderVersion = m.loaderVersion; }
    });
  }
}
