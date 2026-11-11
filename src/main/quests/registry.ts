// What exists in a pack, read from the jars themselves (QST-4: "every referenced item/entity id
// exists in the installed mods or vanilla"): item ids (item models), item tags, entity ids and
// display names (the jar's en_us lang file), dimensions, mod ids (to detect quest engines), and,
// from Minecraft's client jar, the data pack format and folder names. Nothing is guessed: a
// missing client jar makes vanilla ids "unverified", it doesn't make them pass.
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { CONTENT_DIR } from "../launchers/layout";
import { withZip, type ZipReader } from "../archive/zip";

export interface DataFormat { major: number; minor: number }

export interface GameRegistry {
  mcVersion: string;
  vanilla: boolean;                       // the client jar was read
  items: Map<string, string>;             // id -> display name ("" if the jar has no name for it)
  itemTags: Set<string>;                  // without the leading "#"
  entities: Map<string, string>;
  dimensions: Set<string>;
  modIds: Set<string>;
  dataFormat: DataFormat | null;          // from the client jar's version.json
  advancementDir: "advancement" | "advancements"; // renamed in 1.21
  lootDir: "loot_table" | "loot_tables";
  // How this version writes advancements, copied from Minecraft's own (story/root, story/mine_stone).
  advancementStyle: { iconKey: "item" | "id"; itemsAsList: boolean; background: string; formatSplit: boolean } | null;
  jarsByNamespace: Map<string, string[]>; // where to look for a texture
}

const VANILLA_DIMENSIONS = ["minecraft:overworld", "minecraft:the_nether", "minecraft:the_end"];
const ITEM_MODEL = /^assets\/([a-z0-9_.-]+)\/(?:models\/item|items)\/([a-z0-9_./-]+)\.json$/;
const ITEM_TAG = /^data\/([a-z0-9_.-]+)\/tags\/items?\/([a-z0-9_./-]+)\.json$/;
const DIMENSION = /^data\/([a-z0-9_.-]+)\/dimension\/([a-z0-9_./-]+)\.json$/;
const LANG = /^assets\/([a-z0-9_.-]+)\/lang\/en_us\.json$/;
// Item model files that are templates, not items.
const NOT_ITEMS = /^(generated|handheld|handheld_rod|handheld_mace|template_.*|.*_in_hand)$/;

export function emptyRegistry(mcVersion: string): GameRegistry {
  return {
    mcVersion, vanilla: false, items: new Map(), itemTags: new Set(), entities: new Map(), dimensions: new Set(VANILLA_DIMENSIONS),
    modIds: new Set(), dataFormat: null, advancementDir: "advancement", lootDir: "loot_table", advancementStyle: null, jarsByNamespace: new Map(),
  };
}

async function readJar(reg: GameRegistry, path: string, isClient: boolean): Promise<void> {
  await withZip(path, async (z) => {
    const namespaces = new Set<string>();
    for (const name of z.names()) {
      let m = ITEM_MODEL.exec(name);
      if (m && !NOT_ITEMS.test(m[2]!)) {
        const id = `${m[1]}:${m[2]}`;
        if (!reg.items.has(id)) reg.items.set(id, "");
        namespaces.add(m[1]!);
        continue;
      }
      if ((m = ITEM_TAG.exec(name))) { reg.itemTags.add(`${m[1]}:${m[2]}`); continue; }
      if ((m = DIMENSION.exec(name))) { reg.dimensions.add(`${m[1]}:${m[2]}`); continue; }
    }
    for (const name of z.names()) {
      const m = LANG.exec(name);
      if (m) await readLang(reg, z, name);
    }
    for (const ns of namespaces) reg.jarsByNamespace.set(ns, [...(reg.jarsByNamespace.get(ns) ?? []), path]);
    if (isClient) {
      // Vanilla's item model folder also holds variant models (bow_pulling_0, ...): a real
      // vanilla item always has a name in the lang file, so keep only named ones.
      for (const [id, name] of reg.items) if (id.startsWith("minecraft:") && !name) reg.items.delete(id);
      await readClientFacts(reg, z);
    } else await readModIds(reg, z);
  });
}

async function readLang(reg: GameRegistry, z: ZipReader, name: string): Promise<void> {
  let lang: Record<string, unknown>;
  try {
    lang = JSON.parse((await z.text(name)) ?? "{}") as Record<string, unknown>;
  } catch {
    return; // a broken lang file only costs display names
  }
  for (const [key, value] of Object.entries(lang)) {
    if (typeof value !== "string") continue;
    const m = /^(item|block|entity)\.([a-z0-9_.-]+)\.([a-z0-9_/]+)$/.exec(key);
    if (!m) continue;
    const id = `${m[2]}:${m[3]}`;
    if (m[1] === "entity") reg.entities.set(id, value);
    else if (reg.items.has(id) && (m[1] === "item" || !reg.items.get(id))) reg.items.set(id, value);
  }
}

async function readClientFacts(reg: GameRegistry, z: ZipReader): Promise<void> {
  reg.vanilla = true;
  try {
    const v = JSON.parse((await z.text("version.json")) ?? "{}") as { pack_version?: Record<string, number> | number };
    const pv = v.pack_version;
    if (typeof pv === "number") reg.dataFormat = { major: pv, minor: 0 };
    else if (pv && typeof pv.data === "number") reg.dataFormat = { major: pv.data, minor: 0 };
    else if (pv && typeof pv.data_major === "number") reg.dataFormat = { major: pv.data_major, minor: pv.data_minor ?? 0 };
  } catch { /* unknown format: datapack writing will say so */ }
  const names = z.names();
  reg.advancementDir = names.some((n) => n.startsWith("data/minecraft/advancement/")) ? "advancement" : "advancements";
  reg.lootDir = names.some((n) => n.startsWith("data/minecraft/loot_table/")) ? "loot_table" : "loot_tables";
  try {
    const root = JSON.parse((await z.text(`data/minecraft/${reg.advancementDir}/story/root.json`)) ?? "") as { display?: { icon?: Record<string, unknown>; background?: string } };
    const stone = JSON.parse((await z.text(`data/minecraft/${reg.advancementDir}/story/mine_stone.json`)) ?? "") as { criteria?: Record<string, { conditions?: { items?: Array<{ items?: unknown }> } }> };
    const firstItems = Object.values(stone.criteria ?? {})[0]?.conditions?.items?.[0];
    const v = JSON.parse((await z.text("version.json")) ?? "{}") as { pack_version?: Record<string, number> };
    reg.advancementStyle = {
      iconKey: root.display?.icon && "item" in root.display.icon ? "item" : "id",
      itemsAsList: firstItems ? !("items" in firstItems) || Array.isArray(firstItems.items) : false,
      background: root.display?.background ?? "minecraft:textures/gui/advancements/backgrounds/stone.png",
      formatSplit: typeof v.pack_version === "object" && "data_major" in v.pack_version,
    };
  } catch { /* no templates: the vanilla engine says it can't write for this version */ }
}

async function readModIds(reg: GameRegistry, z: ZipReader): Promise<void> {
  const fabric = await z.text("fabric.mod.json");
  if (fabric) {
    try {
      const id = (JSON.parse(fabric) as { id?: unknown }).id;
      if (typeof id === "string") reg.modIds.add(id);
    } catch { /* ignore */ }
  }
  for (const toml of ["META-INF/neoforge.mods.toml", "META-INF/mods.toml"]) {
    const text = await z.text(toml);
    if (!text) continue;
    try {
      const mods = (parseToml(text) as { mods?: Array<{ modId?: unknown }> }).mods ?? [];
      for (const m of mods) if (typeof m.modId === "string") reg.modIds.add(m.modId);
    } catch { /* ignore */ }
  }
}

// Build the registry of a pack folder. clientJar: path to Minecraft's client jar, or null.
export async function buildRegistry(packRoot: string, mcVersion: string, clientJar: string | null): Promise<GameRegistry> {
  const reg = emptyRegistry(mcVersion);
  if (clientJar) await readJar(reg, clientJar, true);
  const dir = join(packRoot, CONTENT_DIR.mod);
  const names = (await readdir(dir).catch(() => [] as string[])).filter((n) => n.endsWith(".jar")).sort();
  for (const n of names) {
    const p = join(dir, n);
    if (!(await stat(p)).isFile()) continue;
    try {
      await readJar(reg, p, false);
    } catch {
      // A jar we can't read adds nothing; its ids then show up as unknown, never silently pass.
    }
  }
  return reg;
}

// "Did you mean": the closest known ids, best first (QST-3, CHT-4).
export function suggest(id: string, known: Iterable<string>, max = 3): string[] {
  const target = id.toLowerCase();
  const [ns, path = ""] = target.includes(":") ? target.split(":") : ["minecraft", target];
  const scored: Array<[number, string]> = [];
  for (const k of known) {
    const [kns, kpath = ""] = k.split(":");
    const d = distance(path, kpath) + (kns === ns ? 0 : 2);
    if (d <= Math.max(2, Math.floor(path.length / 3))) scored.push([d, k]);
  }
  return scored.sort((a, b) => a[0] - b[0] || a[1].localeCompare(b[1])).slice(0, max).map((s) => s[1]);
}

function distance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 6) return 99;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length]!;
}

// The texture of an item (PNG), looked up in the jar that adds it. null when there's none.
export async function itemIcon(reg: GameRegistry, id: string, clientJar: string | null): Promise<Buffer | null> {
  const [ns, path] = id.split(":");
  if (!ns || !path) return null;
  const jars = ns === "minecraft" ? (clientJar ? [clientJar] : []) : (reg.jarsByNamespace.get(ns) ?? []);
  for (const jar of jars) {
    const png = await withZip(jar, async (z) => {
      for (const p of [`assets/${ns}/textures/item/${path}.png`, `assets/${ns}/textures/block/${path}.png`, `assets/${ns}/textures/block/${path}_top.png`, `assets/${ns}/textures/block/${path}_front.png`]) {
        const b = await z.read(p);
        if (b) return b;
      }
      return null;
    }).catch(() => null);
    if (png) return png;
  }
  return null;
}
