// Vanilla advancements as quests: no mods needed (D-12). A data pack, one advancement tab per
// chapter, written in the shapes Minecraft itself uses for this version (icon key, item
// predicate, background, folder names, pack format: all read from the client jar).
// Data packs belong to worlds: packsmith keeps the pack in the game folder
// (packsmith-datapacks/packsmith_quests) and copies it into every world that exists when it
// writes; a world made later needs it added (the Quests tab says how). Only that one data pack
// folder is ever written inside a world, never the world itself.
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Chapter, ChapterSpec, QuestSpec } from "@shared/schema";
import { taskText } from "@shared/questText";
import type { QuestEngine, WritePlan } from "./engine";
import type { GameRegistry } from "./registry";
import { chapterSlug, readManifest, type QuestManifest } from "./manifest";

export const DATAPACK = "packsmith_quests";
const HOME = `minecraft/packsmith-datapacks/${DATAPACK}`;
const MANIFEST = `${HOME}/.packsmith-quests.json`;
const NS = "packsmith";

type Json = Record<string, unknown>;

async function worlds(root: string): Promise<string[]> {
  const saves = await readdir(join(root, "minecraft/saves"), { withFileTypes: true }).catch(() => []);
  return saves.filter((e) => e.isDirectory() && /^[^/\\]+$/.test(e.name) && !e.name.startsWith(".")).map((e) => e.name).sort();
}

function packFiles(chapters: QuestManifest["chapters"], reg: GameRegistry): Map<string, string> {
  const style = reg.advancementStyle!;
  const fmt = reg.dataFormat!;
  const files = new Map<string, string>();
  const json = (v: unknown) => JSON.stringify(v, null, 2) + "\n";
  const pack: Json = { description: "Quests written by packsmith" };
  if (style.formatSplit) Object.assign(pack, { pack_format: fmt.major, min_format: [fmt.major, fmt.minor], max_format: [fmt.major, fmt.minor] });
  else pack.pack_format = fmt.major;
  files.set("pack.mcmeta", json({ pack }));
  const names = Object.fromEntries([...reg.items, ...reg.entities]);
  const icon = (id: string) => (style.iconKey === "item" ? { item: id } : { id });
  const itemPredicate = (ref: string, count: number): Json => {
    const base: Json = ref.startsWith("#")
      ? (style.itemsAsList ? { tag: ref.slice(1) } : { items: ref })
      : (style.itemsAsList ? { items: [ref] } : { items: ref });
    return count > 1 ? { ...base, count: { min: count } } : base;
  };
  for (const ch of chapters) {
    const adv = (key: string) => `${NS}:quests/${ch.slug}/${key}`;
    const firstIcon = (q: QuestSpec) => q.icon ?? q.tasks.flatMap((t) => (t.kind === "item" && !t.item.startsWith("#") ? [t.item] : []))[0] ?? "minecraft:book";
    files.set(`data/${NS}/${reg.advancementDir}/quests/${ch.slug}/root.json`, json({
      criteria: { start: { trigger: "minecraft:tick" } },
      display: { icon: icon(firstIcon(ch.spec.quests[0]!)), title: ch.spec.title, description: "", background: style.background, frame: "task", show_toast: false, announce_to_chat: false },
    }));
    for (const q of ch.spec.quests) {
      const criteria: Json = {};
      q.tasks.forEach((t, i) => {
        const k = `task_${i + 1}`;
        if (t.kind === "item") criteria[k] = { trigger: "minecraft:inventory_changed", conditions: { items: [itemPredicate(t.item, t.count)] } };
        if (t.kind === "kill") criteria[k] = { trigger: "minecraft:player_killed_entity", conditions: { entity: [{ condition: "minecraft:entity_properties", entity: "this", predicate: { type: t.entity } }] } };
        if (t.kind === "dimension") criteria[k] = { trigger: "minecraft:changed_dimension", conditions: { to: t.dimension } };
      });
      const desc = [q.description ?? "", ...q.tasks.map((t) => taskText(t, names))];
      const extraAfter = q.after.slice(1).map((a) => ch.spec.quests.find((x) => x.key === a)?.title).filter(Boolean);
      if (extraAfter.length) desc.push(`Also after: ${extraAfter.join(", ")}.`);
      const rewards: Json = {};
      const xp = q.rewards.reduce((n, r) => n + (r.kind === "xp" ? r.amount : 0), 0);
      if (xp) rewards.experience = xp;
      const items = q.rewards.filter((r) => r.kind === "item");
      if (items.length) {
        rewards.loot = [`${NS}:quests/${ch.slug}/${q.key}`];
        files.set(`data/${NS}/${reg.lootDir}/quests/${ch.slug}/${q.key}.json`, json({
          type: "minecraft:advancement_reward",
          pools: items.map((r) => ({ rolls: 1, entries: [{ type: "minecraft:item", name: r.item, functions: [{ function: "minecraft:set_count", count: r.count }] }] })),
        }));
      }
      files.set(`data/${NS}/${reg.advancementDir}/quests/${ch.slug}/${q.key}.json`, json({
        parent: q.after[0] ? adv(q.after[0]) : adv("root"),
        criteria,
        requirements: Object.keys(criteria).map((k) => [k]),
        display: { icon: icon(firstIcon(q)), title: q.title, description: desc.filter(Boolean).join(" "), frame: q.after.length > 1 ? "goal" : "task" },
        ...(Object.keys(rewards).length ? { rewards } : {}),
      }));
    }
  }
  return files;
}

async function plan(root: string, chapters: QuestManifest["chapters"], reg: GameRegistry, old: QuestManifest): Promise<WritePlan> {
  if (!reg.advancementStyle || !reg.dataFormat) throw new Error("packsmith couldn't read Minecraft's own game file for this version, so it can't write advancements for it.");
  const inner = packFiles(chapters, reg);
  const targets = [HOME, ...(await worlds(root)).map((w) => `minecraft/saves/${w}/datapacks/${DATAPACK}`)];
  const files = new Map<string, string>();
  for (const t of targets) for (const [rel, content] of inner) files.set(`${t}/${rel}`, content);
  // Every file the data pack had before and doesn't have now is removed, in all copies.
  const before = new Set(old.chapters.flatMap((c) => c.files));
  const remove = [...before].filter((f) => !files.has(f));
  const all = [...files.keys()];
  return {
    files, remove,
    // The data pack is one unit: its files are recorded once, on the first chapter.
    manifest: { version: 1, chapters: chapters.map((c, i) => ({ ...c, files: i === 0 ? all : [] })) },
  };
}

export const vanilla: QuestEngine = {
  id: "vanilla",
  label: "Vanilla advancements",
  manifestPath: MANIFEST,
  installed: () => true,

  async read(root) {
    const manifest = await readManifest(root, MANIFEST);
    const chapters: Chapter[] = manifest.chapters.map((c, i) => ({
      id: c.slug, title: c.title, order: i, engine: "vanilla", writtenBy: "packsmith",
      quests: c.spec.quests.map((q) => ({
        id: `${c.slug}/${q.key}`, title: q.title,
        description: q.description ? q.description.split(/\n+/).filter(Boolean) : [],
        icon: q.icon, tasks: q.tasks, rewards: q.rewards, dependsOn: q.after.map((a) => `${c.slug}/${a}`),
      })),
    }));
    const notes = chapters.length ? ["Advancements live in a data pack. packsmith added it to the worlds that existed when it wrote them; for a new world, add the packsmith_quests folder from packsmith-datapacks under Data Packs when you create it."] : [];
    return { chapters, notes };
  },

  async planWrite(root, specs: ChapterSpec[], reg, now) {
    const old = await readManifest(root, MANIFEST);
    const chapters = [...old.chapters];
    const taken = new Set(chapters.map((c) => c.slug));
    for (const spec of specs) {
      const i = chapters.findIndex((c) => c.title.toLowerCase() === spec.title.toLowerCase());
      const slug = i >= 0 ? chapters[i]!.slug : chapterSlug(spec.title, taken);
      taken.add(slug);
      const entry = { title: spec.title, slug, files: [], questIds: spec.quests.map((q) => `${slug}/${q.key}`), spec, writtenAt: now };
      if (i >= 0) chapters[i] = entry; else chapters.push(entry);
    }
    return plan(root, chapters, reg, old);
  },

  async planRemove(root, title, reg) {
    const old = await readManifest(root, MANIFEST);
    if (!old.chapters.some((c) => c.title === title)) throw new Error(`"${title}" isn't a chapter packsmith wrote.`);
    const rest = old.chapters.filter((c) => c.title !== title);
    if (rest.length) return plan(root, rest, reg, old);
    return { files: new Map(), remove: [...new Set(old.chapters.flatMap((c) => c.files))], manifest: { version: 1, chapters: [] } };
  },
};
