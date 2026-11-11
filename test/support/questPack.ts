// A scratch pack for quest tests: packsmith's marker, a fake Minecraft client jar and fake mod
// jars (fakeJars.ts). No real game files.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { InstanceRecord } from "@shared/schema";
import { writeMarker } from "../../src/main/instances/marker";
import { clientJar } from "./fakeJars";
import { tempDir } from "../helpers";

export async function questPack(opts: { mods?: Record<string, Buffer>; client?: "1.21" | "1.20" | null; worlds?: string[] } = {}) {
  const dataDir = await tempDir("ps-q-data-");
  const prismRoot = await tempDir("ps-q-prism-");
  const root = join(await tempDir("ps-q-pack-"), "packsmith-1.21.1-q");
  for (const d of ["minecraft/mods", "minecraft/config"]) await mkdir(join(root, d), { recursive: true });
  for (const w of opts.worlds ?? []) await mkdir(join(root, "minecraft/saves", w, "region"), { recursive: true });
  const createdAt = new Date().toISOString();
  await writeMarker(root, { createdBy: "packsmith", version: 1, instanceId: "packsmith-1.21.1-q", kind: "pack", mcVersion: "1.21.1", loader: "fabric", packName: "Quest Test", createdAt });
  if (opts.client !== null) {
    const libs = join(prismRoot, "libraries/com/mojang/minecraft/1.21.1");
    await mkdir(libs, { recursive: true });
    await writeFile(join(libs, "minecraft-1.21.1-client.jar"), clientJar(opts.client ?? "1.21"));
  }
  for (const [name, jar] of Object.entries(opts.mods ?? {})) await writeFile(join(root, "minecraft/mods", name), jar);
  const record: InstanceRecord = { id: "packsmith-1.21.1-q", origin: "own", launcher: "app-managed", path: root, name: "Quest Test", mcVersion: "1.21.1", loader: "fabric", createdAt, groupPending: false };
  return { dataDir, prismRoot, root, record };
}
