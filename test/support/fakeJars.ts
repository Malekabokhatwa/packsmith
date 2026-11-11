// Fake jars for tests and e2e: a Minecraft client jar (1.21- or 1.20-style advancement templates,
// a few items, entities and tags) and mod jars. Standalone (no path aliases) so e2e can use it.
import { makeZip } from "./zipWriter";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da6360f8cf00000301010018dd8db00000000049454e44ae426082", "hex");

export function clientJar(style: "1.21" | "1.20" = "1.21"): Buffer {
  const adv = style === "1.21" ? "advancement" : "advancements";
  const items = ["oak_log", "torch", "book", "bread", "crafting_table", "wheat_seeds", "diamond", "furnace"];
  const files: Record<string, string | Buffer> = {
    "version.json": JSON.stringify({ id: "1.21.1", pack_version: style === "1.21" ? { resource: 34, data: 48 } : { resource: 15, data: 15 } }),
    "assets/minecraft/lang/en_us.json": JSON.stringify({
      ...Object.fromEntries(items.map((i) => [`item.minecraft.${i}`, i.split("_").map((w) => w[0]!.toUpperCase() + w.slice(1)).join(" ")])),
      "entity.minecraft.zombie": "Zombie", "entity.minecraft.skeleton": "Skeleton",
    }),
    "data/minecraft/tags/item/logs.json": "{}",
    [`data/minecraft/${adv}/story/root.json`]: JSON.stringify({ display: { icon: style === "1.21" ? { id: "minecraft:grass_block", count: 1 } : { item: "minecraft:grass_block" }, background: "minecraft:textures/gui/advancements/backgrounds/stone.png" } }),
    [`data/minecraft/${adv}/story/mine_stone.json`]: JSON.stringify({ criteria: { get_stone: { conditions: { items: [style === "1.21" ? { items: "#minecraft:stone_tool_materials" } : { tag: "minecraft:stone_tool_materials" }] } } } }),
    [`data/minecraft/${style === "1.21" ? "loot_table" : "loot_tables"}/chests/x.json`]: "{}",
    "assets/minecraft/textures/item/diamond.png": PNG,
    "assets/minecraft/models/item/bow_pulling_0.json": "{}", // a variant model, not an item
  };
  for (const i of items) files[`assets/minecraft/models/item/${i}.json`] = "{}";
  return makeZip(files);
}

export function modJar(id: string, items: string[] = [], opts: { neoforge?: boolean } = {}): Buffer {
  const files: Record<string, string> = opts.neoforge
    ? { "META-INF/neoforge.mods.toml": `modLoader="javafml"\n[[mods]]\nmodId="${id}"\n` }
    : { "fabric.mod.json": JSON.stringify({ id }) };
  for (const i of items) files[`assets/${id}/models/item/${i}.json`] = "{}";
  if (items.length) files[`assets/${id}/lang/en_us.json`] = JSON.stringify(Object.fromEntries(items.map((i) => [`item.${id}.${i}`, i.replace(/_/g, " ")])));
  return makeZip(files);
}
