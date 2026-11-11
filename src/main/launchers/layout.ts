import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ContentKind } from "@shared/schema";

// Folder for each kind of content, relative to the instance root. Both modes use Prism's
// layout (game files under minecraft/), so a pack moves between modes unchanged.
export const GAME_DIR = "minecraft";
export const CONTENT_DIR: Record<Exclude<ContentKind, "datapack">, string> = {
  mod: "minecraft/mods",
  shader: "minecraft/shaderpacks",
  resourcepack: "minecraft/resourcepacks",
};

export async function createGameFolders(root: string): Promise<void> {
  for (const d of [...Object.values(CONTENT_DIR), "minecraft/config"]) await mkdir(join(root, d), { recursive: true });
}
