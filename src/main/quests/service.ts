// M-7 quests for a pack: read every engine's book (Quests tab), offer engines (QST-1: added only
// when the user picks one), write and remove chapters packsmith owns. A write is validated
// against the pack's own jars first (QST-4) and runs through the journal, so it can be undone.
import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ChapterSpec, InstanceRecord, JournalEntry, QuestBook, QuestEngineId, QuestEngineOption } from "@shared/schema";
import type { Http } from "../net/http";
import type { Packs } from "../instances/manager";
import type { Journal } from "../instances/journal";
import type { ModrinthClient } from "../sources/modrinth";
import { resolveFromModrinth } from "../resolver/fetch";
import { toDownload } from "../resolver/resolve";
import { listText } from "../instances/manager";
import { writeFileAtomic } from "../store/jsonFile";
import { CONTENT_DIR } from "../launchers/layout";
import { buildRegistry, itemIcon, type GameRegistry } from "./registry";
import { clientJar, defaultLocations, localClientJar } from "../mojang";
import { validateChapters } from "./validate";
import { heracles } from "./heracles";
import { ftbquests } from "./ftbquests";
import { vanilla } from "./vanilla";
import type { QuestEngine } from "./engine";
import { readManifest } from "./manifest";
import { AppError } from "../errors";

export const ENGINES: Record<QuestEngineId, QuestEngine> = { heracles, ftbquests, vanilla };
// Heracles is published on Modrinth as "Odyssey Quests".
export const HERACLES_PROJECT = "odyssey-quests";

// The only places a quest write may touch (on top of assertWritable's pack boundary).
const QUEST_PATHS = [
  /^minecraft\/config\/heracles\/[^]+$/,
  /^minecraft\/packsmith-datapacks\/packsmith_quests\/[^]+$/,
  /^minecraft\/saves\/[^/]+\/datapacks\/packsmith_quests\/[^]+$/,
];

export function questPathAllowed(relpath: string): boolean {
  return !relpath.split("/").includes("..") && QUEST_PATHS.some((re) => re.test(relpath));
}

export interface QuestsDeps {
  dataDir: string;
  http: Http;
  modrinth: ModrinthClient;
  packs: Packs;
  journal: Journal;
  prismRoot: () => Promise<string | null>;
  now?: () => Date;
}

export class Quests {
  private cache = new Map<string, { key: string; reg: GameRegistry; jar: string | null }>();
  private icons = new Map<string, string | null>();
  constructor(private readonly d: QuestsDeps) {}

  private async record(id: string, own = false): Promise<InstanceRecord> {
    const r = (await this.d.packs.list()).find((x) => x.id === id);
    if (!r) throw new AppError("unknown-pack", "That pack isn't in packsmith's list any more.");
    // Own packs and adopted ones (whose scope assertWritable checks per path) are both in the registry.
    if (own && r.origin !== "own" && r.origin !== "adopted") throw new AppError("not-writable", `packsmith only changes packs it made or you let it manage. "${r.name}" isn't one of them.`);
    return r;
  }

  // The pack's registry, rebuilt when its mods change. download: fetch Minecraft's game file
  // from Mojang if it isn't on this computer (for writing; viewing never downloads 25 MB).
  async registry(r: InstanceRecord, download: boolean): Promise<{ reg: GameRegistry; jar: string | null }> {
    const dir = join(r.path, CONTENT_DIR.mod);
    const names = (await readdir(dir).catch(() => [] as string[])).filter((n) => n.endsWith(".jar")).sort();
    const sig = await Promise.all(names.map(async (n) => { const s = await stat(join(dir, n)).catch(() => null); return `${n}:${s?.size}:${s?.mtimeMs}`; }));
    const loc = defaultLocations(this.d.dataDir, await this.d.prismRoot());
    let jar = await localClientJar(r.mcVersion, loc);
    if (!jar && download) jar = await clientJar(this.d.http, r.mcVersion, loc).catch(() => null);
    const key = `${r.mcVersion}|${jar ?? "-"}|${sig.join(",")}`;
    const hit = this.cache.get(r.id);
    if (hit?.key === key) return hit;
    const reg = await buildRegistry(r.path, r.mcVersion, jar);
    const entry = { key, reg, jar };
    this.cache.set(r.id, entry);
    return entry;
  }

  async book(id: string): Promise<QuestBook> {
    const r = await this.record(id);
    const { reg } = await this.registry(r, false);
    const installed = (Object.values(ENGINES) as QuestEngine[]).filter((e) => e.installed(reg)).map((e) => e.id);
    const chapters = [];
    const notes: string[] = [];
    for (const e of [ftbquests, heracles, vanilla]) {
      const b = await e.read(r.path, reg);
      chapters.push(...b.chapters);
      if (b.chapters.length) notes.push(...b.notes);
    }
    const names: Record<string, string> = {};
    for (const c of chapters) for (const q of c.quests) {
      const ids = [q.icon, ...q.tasks.map((t) => (t.kind === "item" ? t.item : t.kind === "kill" ? t.entity : t.kind === "dimension" ? t.dimension : undefined)), ...q.rewards.map((x) => (x.kind === "item" ? x.item : undefined))];
      for (const i of ids) if (i && !i.startsWith("#")) { const n = reg.items.get(i) || reg.entities.get(i); if (n) names[i] = n; }
    }
    return { installed, chapters: chapters.map((c, i) => ({ ...c, order: i })), notes, names };
  }

  // The chapter specs packsmith wrote (from its manifests), so a rewrite starts from them.
  async specs(id: string): Promise<Array<{ engine: QuestEngineId; spec: ChapterSpec }>> {
    const r = await this.record(id);
    const out: Array<{ engine: QuestEngineId; spec: ChapterSpec }> = [];
    for (const e of [heracles, vanilla]) for (const c of (await readManifest(r.path, e.manifestPath)).chapters) out.push({ engine: e.id, spec: c.spec });
    return out;
  }

  async engines(id: string): Promise<QuestEngineOption[]> {
    const r = await this.record(id);
    const { reg } = await this.registry(r, false);
    const own = r.origin === "own";
    const out: QuestEngineOption[] = [];
    // Heracles: offered when Modrinth has a build for this Minecraft version and loader.
    let heraclesNote = "Light and simple. Quests open from a book in the game.";
    let canInstall = false;
    if (!heracles.installed(reg)) {
      if (r.loader === "vanilla") heraclesNote = "Needs a mod loader. This pack has none.";
      else {
        const installed = (await this.d.packs.scan(r.id).catch(() => [])).flatMap((c) => (c.match.status === "modrinth" ? [{ projectId: c.match.projectId, versionId: c.match.versionId }] : []));
        const { set } = await resolveFromModrinth(this.d.modrinth, [{ project: HERACLES_PROJECT }], r.mcVersion, r.loader, installed).catch(() => ({ set: null }));
        canInstall = !!set && set.conflicts.length === 0;
        if (!set) heraclesNote = "Couldn't check Modrinth just now.";
        else if (!canInstall) heraclesNote = `Not available for ${r.loader} ${r.mcVersion}. It has builds for Minecraft 1.20.1 and 1.21.1.`;
        else heraclesNote += ` Adds ${listText(toDownload(set).map((m) => m.title))} from Modrinth.`;
      }
    }
    out.push({ id: "heracles", label: "Heracles", installed: heracles.installed(reg), canInstall: own && canInstall, canWrite: own && heracles.installed(reg), note: heraclesNote });
    out.push({ id: "vanilla", label: "Vanilla advancements", installed: true, canInstall: false, canWrite: own,
      note: "No mods needed. Shows up as advancement tabs; added to the worlds this pack has." });
    out.push({ id: "ftbquests", label: "FTB Quests", installed: ftbquests.installed(reg), canInstall: false, canWrite: false,
      note: ftbquests.installed(reg) ? "In this pack. packsmith shows its book; writing FTB chapters comes later." : "FTB Quests isn't on Modrinth, so packsmith can't add it." });
    return out;
  }

  // QST-1: the engine is added only on the user's pick (the UI calls this; the agent can't).
  async installEngine(id: string, engine: QuestEngineId): Promise<{ entryId?: string }> {
    const r = await this.record(id, true);
    if (engine === "vanilla") return {};
    if (engine !== "heracles") throw new AppError("cannot-install", "FTB Quests isn't on Modrinth, so packsmith can't add it.");
    const res = await this.d.packs.installProject(r.id, HERACLES_PROJECT, { reason: "Quest engine you picked" });
    return { entryId: res.entryId };
  }

  async write(id: string, engine: QuestEngineId, specs: ChapterSpec[], runId?: string): Promise<{ entry: JournalEntry; warnings: string[]; unverified: string[] }> {
    const r = await this.record(id, true);
    const e = ENGINES[engine];
    if (!e.planWrite) throw new AppError("cannot-write", `packsmith doesn't write ${e.label} chapters yet. Pick Heracles or vanilla advancements in the Quests tab.`);
    const { reg } = await this.registry(r, true);
    if (!e.installed(reg)) {
      throw new AppError("engine-missing", `${e.label} isn't in "${r.name}". Ask the user to pick a quest engine in the pack's Quests tab first; packsmith never adds one on its own.`);
    }
    const existing = await e.read(r.path, reg);
    const foreign = new Set(existing.chapters.filter((c) => c.writtenBy !== "packsmith").map((c) => c.title.toLowerCase()));
    const check = validateChapters(specs, engine, reg, foreign);
    if (check.errors.length) throw new AppError("invalid-quests", `Nothing was written. ${check.errors.join(" ")}`);
    const plan = await e.planWrite(r.path, specs, reg, (this.d.now?.() ?? new Date()).toISOString()).catch((err: Error) => { throw new AppError("cannot-write", err.message); });
    const entry = await this.apply(r, e, plan, `Wrote ${specs.length === 1 ? `the "${specs[0]!.title}" chapter` : `${specs.length} chapters`} (${e.label})`, runId);
    return { entry, warnings: check.warnings, unverified: check.unverified };
  }

  async removeChapter(id: string, engine: QuestEngineId, title: string): Promise<JournalEntry> {
    const r = await this.record(id, true);
    const e = ENGINES[engine];
    if (!e.planRemove) throw new AppError("cannot-write", `packsmith doesn't change ${e.label} books.`);
    const { reg } = await this.registry(r, true);
    const plan = await e.planRemove(r.path, title, reg).catch((err: Error) => { throw new AppError("not-ours", err.message); });
    return this.apply(r, e, plan, `Removed the "${title}" chapter (${e.label})`);
  }

  private async apply(r: InstanceRecord, e: QuestEngine, plan: Awaited<ReturnType<NonNullable<QuestEngine["planWrite"]>>>, reason: string, runId?: string): Promise<JournalEntry> {
    const paths = [...plan.files.keys(), ...plan.remove, e.manifestPath];
    for (const p of paths) if (!questPathAllowed(p)) throw new AppError("bad-path", `Refused a quest file outside the quest folders: ${p}`);
    const { entry } = await this.d.journal.record(r, { action: "write-quests", reason, runId }, paths, async (abs) => {
      for (const [rel, content] of plan.files) await writeFileAtomic(abs.get(rel)!, content);
      for (const rel of plan.remove) await rm(abs.get(rel)!, { force: true });
      await writeFileAtomic(abs.get(e.manifestPath)!, JSON.stringify(plan.manifest, null, 2) + "\n");
    });
    return entry;
  }

  // Item textures from the pack's own jars, as data URLs (null: none found; the tab shows initials).
  async iconsFor(id: string, items: string[]): Promise<Record<string, string | null>> {
    const r = await this.record(id);
    const { reg, jar } = await this.registry(r, false);
    const out: Record<string, string | null> = {};
    for (const item of items.slice(0, 200)) {
      const key = `${r.id}|${item}`;
      if (!this.icons.has(key)) {
        const png = await itemIcon(reg, item, jar);
        this.icons.set(key, png && png.length < 64 * 1024 ? `data:image/png;base64,${png.toString("base64")}` : null);
      }
      out[item] = this.icons.get(key)!;
    }
    return out;
  }
}
