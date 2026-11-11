// FTB Quests: read-only (D-26). FTB Quests isn't on Modrinth, so packsmith can't install it; but
// big packs ship FTB books (ATM10 has 66 chapters); a pack's own book must never look empty. packsmith shows
// them. Layout under the game folder's config/ftbquests/quests/: chapters/*.snbt (structure),
// titles inline (older books) or in lang/en_us.snbt / lang/en_us/** (1.21, keys like
// "quest.<ID>.title"). Writing FTB chapters comes with managed packs (milestone g).
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Chapter, Quest, QuestReward, QuestTask } from "@shared/schema";
import { taskText } from "@shared/questText";
import type { QuestEngine } from "./engine";
import { parseSnbt } from "./snbt";

const DIR = "minecraft/config/ftbquests/quests";

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown, d = 1): number => (typeof v === "number" && Number.isFinite(v) ? Math.max(1, Math.round(v)) : d);
// FTB text uses & colour codes and {image:...} tags; the tab shows plain words.
const plain = (s: string) => s.replace(/&[0-9a-fk-or]/gi, "").replace(/\{image:[^}]*\}/g, "").replace(/\\n/g, "\n").trim();

function itemId(v: unknown): string | undefined {
  return str(v) ?? str(obj(v).id) ?? str(obj(v).item);
}

function readTask(t: Obj): QuestTask {
  const type = str(t.type) ?? "";
  if (type === "item" && itemId(t.item)) return { kind: "item", item: itemId(t.item)!, count: num(t.count) };
  if (type === "kill" && str(t.entity)) return { kind: "kill", entity: str(t.entity)!, count: num(t.value) };
  if (type === "dimension" && str(t.dimension)) return { kind: "dimension", dimension: str(t.dimension)! };
  if (type === "checkmark") return { kind: "check", text: "Tick it off" };
  return { kind: "other", text: type.replace(/_/g, " ") || "task" };
}

function readReward(r: Obj): QuestReward {
  const type = str(r.type) ?? "";
  if (type === "item" && itemId(r.item)) return { kind: "item", item: itemId(r.item)!, count: num(r.count, num(obj(r.item).count)) };
  if (type === "xp") return { kind: "xp", amount: num(r.xp) };
  if (type === "xp_levels") return { kind: "other", text: `${num(r.xp_levels)} levels` };
  return { kind: "other", text: type.replace(/_/g, " ") || "reward" };
}

// Every key/value from the lang file(s), flattened: "quest.<ID>.title" -> "..."
async function readLang(root: string): Promise<Map<string, string>> {
  const lang = new Map<string, string>();
  const add = (text: string) => {
    try {
      for (const [k, v] of Object.entries(obj(parseSnbt(text)))) {
        const s = str(v) ?? arr(v).filter((x): x is string => typeof x === "string").join("\n");
        if (s) lang.set(k, s);
      }
    } catch { /* a broken lang file only costs titles */ }
  };
  const single = await readFile(join(root, DIR, "lang/en_us.snbt"), "utf8").catch(() => null);
  if (single) add(single);
  const walk = async (rel: string) => {
    for (const e of await readdir(join(root, rel), { withFileTypes: true }).catch(() => [])) {
      if (e.isDirectory()) await walk(`${rel}/${e.name}`);
      else if (e.name.endsWith(".snbt")) add(await readFile(join(root, rel, e.name), "utf8"));
    }
  };
  await walk(`${DIR}/lang/en_us`);
  return lang;
}

export const ftbquests: QuestEngine = {
  id: "ftbquests",
  label: "FTB Quests",
  manifestPath: `${DIR}/.packsmith-quests.json`,
  installed: (reg) => reg.modIds.has("ftbquests"),

  async read(root, reg) {
    const lang = await readLang(root);
    const names = Object.fromEntries(reg.items);
    const files = (await readdir(join(root, DIR, "chapters")).catch(() => [] as string[])).filter((f) => f.endsWith(".snbt")).sort();
    // Book order: chapter groups as listed in chapter_groups.snbt (ungrouped first), then order_index.
    let groupOrder: string[] = [];
    try {
      groupOrder = arr(obj(parseSnbt(await readFile(join(root, DIR, "chapter_groups.snbt"), "utf8"))).chapter_groups).map((g) => str(obj(g).id) ?? "");
    } catch { /* no groups */ }
    const rank = (group: string | undefined, index: number) => (group ? groupOrder.indexOf(group) + 1 : 0) * 10_000 + index;
    const chapters: Chapter[] = [];
    for (const f of files) {
      let c: Obj;
      try { c = obj(parseSnbt(await readFile(join(root, DIR, "chapters", f), "utf8"))); } catch { continue; }
      const cid = str(c.id) ?? f;
      const quests: Quest[] = arr(c.quests).map((qv) => {
        const q = obj(qv);
        const id = str(q.id) ?? "";
        const tasks = arr(q.tasks).map((t) => readTask(obj(t)));
        const title = str(q.title) ?? lang.get(`quest.${id}.title`) ?? (tasks[0] ? taskText(tasks[0], names) : "Quest");
        const desc = lang.get(`quest.${id}.quest_desc`) ?? arr(q.description).filter((d): d is string => typeof d === "string").join("\n");
        const quest: Quest = {
          id, title: plain(title),
          description: desc ? plain(desc).split("\n").filter(Boolean) : [],
          icon: itemId(q.icon) ?? (tasks[0]?.kind === "item" && !tasks[0].item.startsWith("#") ? tasks[0].item : undefined),
          tasks, rewards: arr(q.rewards).map((r) => readReward(obj(r))),
          dependsOn: arr(q.dependencies).filter((d): d is string => typeof d === "string"),
        };
        return quest;
      });
      const title = str(c.title) ?? lang.get(`chapter.${cid}.title`) ?? str(c.filename) ?? f.replace(/\.snbt$/, "");
      const index = typeof c.order_index === "number" ? c.order_index : chapters.length;
      chapters.push({ id: cid, title: plain(title), order: rank(str(c.group), index), quests, engine: "ftbquests", writtenBy: "other" });
    }
    chapters.sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
    const notes = chapters.length ? ["This book came with the pack. packsmith shows it as written and doesn't track anyone's progress."] : [];
    return { chapters, notes };
  },
};
