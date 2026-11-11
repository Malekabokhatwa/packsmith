// Heracles ("Odyssey Quests" on Modrinth). Files under the game folder's
// config/heracles/: groups.txt (chapter order, one title per line) and quests/<folder>/<id>.json,
// one file per quest, which names its chapter(s) in display.groups. Same layout on 1.20.x and
// 1.21.1 (checked against Heracles' public source, 2026-11-03).
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Chapter, ChapterSpec, Quest, QuestReward, QuestTask } from "@shared/schema";
import { taskText, rewardText } from "@shared/questText";
import { layoutQuests } from "@shared/questLayout";
import type { QuestEngine, WritePlan } from "./engine";
import type { GameRegistry } from "./registry";
import { chapterSlug, readManifest, type QuestManifest } from "./manifest";

const DIR = "minecraft/config/heracles";
const QUESTS = `${DIR}/quests`;
const GROUPS = `${DIR}/groups.txt`;
const MANIFEST = `${DIR}/.packsmith-quests.json`;
const MAX_FILES = 5000;

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const int = (v: unknown, d = 1): number => (typeof v === "number" && Number.isFinite(v) ? Math.max(1, Math.round(v)) : d);
const text = (v: unknown): string => str(v) ?? str(obj(v).text) ?? "";

async function questFiles(root: string): Promise<Array<{ id: string; path: string }>> {
  const out: Array<{ id: string; path: string }> = [];
  const walk = async (dir: string) => {
    for (const e of await readdir(join(root, dir), { withFileTypes: true }).catch(() => [])) {
      if (out.length >= MAX_FILES) return;
      if (e.isDirectory()) await walk(`${dir}/${e.name}`);
      else if (e.name.endsWith(".json")) out.push({ id: e.name.slice(0, -5), path: `${dir}/${e.name}` });
    }
  };
  await walk(QUESTS);
  return out;
}

function readTask(t: Json): QuestTask {
  const type = str(t.type) ?? "";
  if (type === "heracles:item" && str(t.item)) return { kind: "item", item: str(t.item)!, count: int(t.amount) };
  if (type === "heracles:kill_entity" && str(obj(t.entity).type)) return { kind: "kill", entity: str(obj(t.entity).type)!, count: int(t.amount) };
  if (type === "heracles:changed_dimension" && str(t.to)) return { kind: "dimension", dimension: str(t.to)! };
  if (type === "heracles:check") return { kind: "check", text: str(t.title) || "Tick it off" };
  return { kind: "other", text: str(t.title) || type.replace(/^heracles:/, "").replace(/_/g, " ") };
}

function readReward(r: Json): QuestReward {
  const type = str(r.type) ?? "";
  if (type === "heracles:xp") return { kind: "xp", amount: int(r.amount) };
  const item = obj(r.item);
  if (type === "heracles:item" && str(item.id)) return { kind: "item", item: str(item.id)!, count: int(item.count) };
  return { kind: "other", text: str(r.title) || type.replace(/^heracles:/, "").replace(/_/g, " ") };
}

export const heracles: QuestEngine = {
  id: "heracles",
  label: "Heracles",
  manifestPath: MANIFEST,
  installed: (reg) => reg.modIds.has("heracles"),

  async read(root) {
    const manifest = await readManifest(root, MANIFEST);
    const ours = new Set(manifest.chapters.map((c) => c.title));
    const order = (await readFile(join(root, GROUPS), "utf8").catch(() => "")).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const byGroup = new Map<string, Quest[]>();
    for (const f of await questFiles(root)) {
      let q: Json;
      try { q = obj(JSON.parse(await readFile(join(root, f.path), "utf8"))); } catch { continue; }
      const display = obj(q.display);
      const quest: Quest = {
        id: f.id,
        title: text(display.title) || f.id,
        description: Array.isArray(display.description) ? display.description.filter((d): d is string => typeof d === "string") : [],
        icon: str(obj(display.icon).item),
        tasks: Object.values(obj(q.tasks)).map((t) => readTask(obj(t))),
        rewards: Object.values(obj(q.rewards)).map((r) => readReward(obj(r))),
        dependsOn: Array.isArray(q.dependencies) ? q.dependencies.filter((d): d is string => typeof d === "string") : [],
      };
      for (const g of Object.keys(obj(display.groups))) byGroup.set(g, [...(byGroup.get(g) ?? []), quest]);
    }
    const titles = [...order.filter((t) => byGroup.has(t)), ...[...byGroup.keys()].filter((t) => !order.includes(t))];
    const chapters: Chapter[] = titles.map((title, i) => {
      const quests = byGroup.get(title)!;
      // Same order as the map: by column, then as listed.
      const { pos } = layoutQuests(quests.map((q) => ({ id: q.id, dependsOn: q.dependsOn })));
      quests.sort((a, b) => pos.get(a.id)!.col - pos.get(b.id)!.col || pos.get(a.id)!.row - pos.get(b.id)!.row);
      return { id: title, title, order: i, quests, engine: "heracles", writtenBy: ours.has(title) ? "packsmith" : "other" };
    });
    return { chapters, notes: [] };
  },

  async planWrite(root, specs, reg, now) {
    const manifest = await readManifest(root, MANIFEST);
    const groups = (await readFile(join(root, GROUPS), "utf8").catch(() => "")).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const taken = new Set([...manifest.chapters.map((c) => c.slug), ...(await readdir(join(root, QUESTS)).catch(() => []))]);
    const plan: WritePlan = { files: new Map(), remove: [], manifest: { version: 1, chapters: [...manifest.chapters] } };
    const names = Object.fromEntries(reg.items);
    for (const spec of specs) {
      const prev = manifest.chapters.find((c) => c.title.toLowerCase() === spec.title.toLowerCase());
      const slug = prev?.slug ?? chapterSlug(spec.title, taken);
      taken.add(slug);
      const qid = (key: string) => `ps_${slug}_${key}`;
      const { pos } = layoutQuests(spec.quests.map((q) => ({ id: q.key, dependsOn: q.after })));
      const rowsInCol = new Map<number, number>();
      for (const p of pos.values()) rowsInCol.set(p.col, (rowsInCol.get(p.col) ?? 0) + 1);
      const files: string[] = [];
      for (const q of spec.quests) {
        const p = pos.get(q.key)!;
        const firstItem = q.tasks.find((t) => t.kind === "item" && !t.item.startsWith("#"));
        const icon = q.icon ?? (firstItem && firstItem.kind === "item" ? firstItem.item : "minecraft:book");
        const json = {
          display: {
            icon: { type: "heracles:item", item: icon },
            title: { text: q.title },
            description: q.description ? q.description.split(/\n+/).filter(Boolean) : [],
            groups: { [spec.title]: { position: [p.col * 64, Math.round((p.row - ((rowsInCol.get(p.col) ?? 1) - 1) / 2) * 40)] } },
          },
          settings: { individual_progress: false, hidden: "LOCKED", unlockNotification: true, showDependencyArrow: true, repeatable: false, autoClaimRewards: false },
          dependencies: q.after.map(qid),
          tasks: Object.fromEntries(q.tasks.map((t, i) => [`task_${i + 1}`, writeTask(t, names)])),
          rewards: Object.fromEntries(q.rewards.map((r, i) => [`reward_${i + 1}`, writeReward(r, names)])),
        };
        const rel = `${QUESTS}/${slug}/${qid(q.key)}.json`;
        plan.files.set(rel, JSON.stringify(json, null, 2) + "\n");
        files.push(rel);
      }
      if (prev) plan.remove.push(...prev.files.filter((f) => !files.includes(f)));
      if (!groups.includes(spec.title)) groups.push(spec.title);
      const entry: QuestManifest["chapters"][number] = { title: spec.title, slug, files, questIds: spec.quests.map((q) => qid(q.key)), spec, writtenAt: now };
      plan.manifest.chapters = [...plan.manifest.chapters.filter((c) => c !== prev), entry];
    }
    plan.files.set(GROUPS, groups.join("\n") + "\n");
    return plan;
  },

  async planRemove(root, title) {
    const manifest = await readManifest(root, MANIFEST);
    const ch = manifest.chapters.find((c) => c.title === title);
    if (!ch) throw new Error(`"${title}" isn't a chapter packsmith wrote.`);
    const groups = (await readFile(join(root, GROUPS), "utf8").catch(() => "")).split(/\r?\n/).map((l) => l.trim()).filter((l) => l && l !== title);
    return {
      files: new Map([[GROUPS, groups.length ? groups.join("\n") + "\n" : ""]]),
      remove: ch.files,
      manifest: { version: 1, chapters: manifest.chapters.filter((c) => c !== ch) },
    };
  },
};

function writeTask(t: Exclude<QuestTask, { kind: "other" }>, names: Record<string, string>): Json {
  const title = taskText(t, names);
  switch (t.kind) {
    case "item": return { type: "heracles:item", title, item: t.item, amount: t.count, collection: "AUTOMATIC" };
    case "kill": return { type: "heracles:kill_entity", title, entity: { type: t.entity }, amount: t.count };
    case "dimension": return { type: "heracles:changed_dimension", title, to: t.dimension };
    case "check": return { type: "heracles:check", title };
  }
}

function writeReward(r: Exclude<QuestReward, { kind: "other" }>, names: Record<string, string>): Json {
  if (r.kind === "xp") return { type: "heracles:xp", title: rewardText(r), xptype: "points", amount: r.amount };
  return { type: "heracles:item", title: rewardText(r, names), item: { id: r.item, count: r.count } };
}

