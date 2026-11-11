import { beforeEach, describe, expect, it } from "vitest";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";
import { Adoptions } from "../src/main/adoption/service";
import { Packs } from "../src/main/instances/manager";
import { Registry } from "../src/main/instances/registry";
import { Journal } from "../src/main/instances/journal";
import { assertWritable, scopeOf } from "../src/main/instances/writable";
import { SettingsStore } from "../src/main/settings";
import { ModrinthClient, Throttle } from "../src/main/sources/modrinth";
import { clearLoaderCache } from "../src/main/loaders";
import { cfgName, readPackComponents } from "../src/main/launchers/prism";
import { fakeHttp, tempDir } from "./helpers";

const VANILLA_PACK = JSON.stringify({ formatVersion: 1, components: [{ uid: "org.lwjgl3", version: "3.3.3" }, { uid: "net.minecraft", version: "1.21.1", important: true }] }, null, 4);

async function instance(root: string, dir: string, name: string, pack: string, files: Record<string, string> = {}) {
  const p = join(root, "instances", dir);
  await mkdir(join(p, "minecraft"), { recursive: true });
  await writeFile(join(p, "instance.cfg"), `[General]\nname="${name}"\n`);
  await writeFile(join(p, "mmc-pack.json"), pack);
  for (const [rel, text] of Object.entries(files)) { await mkdir(join(p, rel, ".."), { recursive: true }); await writeFile(join(p, rel), text); }
  return p;
}

async function tree(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  async function walk(d: string) {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p); else out[relative(dir, p)] = createHash("sha256").update(await readFile(p)).digest("hex");
    }
  }
  await walk(dir);
  return out;
}

async function world() {
  const dataDir = await tempDir("ps-adopt-data-");
  const prismRoot = await tempDir("ps-adopt-prism-");
  await writeFile(join(prismRoot, "prismlauncher.cfg"), "[General]\nInstanceDir=instances\n");
  const vanilla = await instance(prismRoot, "Vanilla Survival", "Vanilla \\\"Survival\\\"", VANILLA_PACK, {
    "minecraft/options.txt": "renderDistance:12\n", "minecraft/saves/My World/level.dat": "precious world", "minecraft/config/x.json": "{}",
  });
  const modded = await instance(prismRoot, "Modded", "Modded", JSON.stringify({ formatVersion: 1, components: [{ uid: "net.minecraft", version: "1.21.1" }, { uid: "net.fabricmc.fabric-loader", version: "0.16.14" }] }), { "minecraft/mods/a.jar": "a", "minecraft/mods/b.jar": "b" });
  await instance(prismRoot, "Quilty", "Quilty", JSON.stringify({ formatVersion: 1, components: [{ uid: "net.minecraft", version: "1.21.1" }, { uid: "org.quiltmc.quilt-loader", version: "0.26" }] }));
  await instance(prismRoot, "zz-folder", "Alpha", VANILLA_PACK); // folder sorts last, name first
  const own = await instance(prismRoot, "packsmith-own", "Own", VANILLA_PACK);
  await writeFile(join(own, ".packsmith-instance.json"), JSON.stringify({ createdBy: "packsmith", instanceId: "own" }));
  const { http } = fakeHttp({ json: { "https://meta.fabricmc.net/v2/versions/loader/1.21.1": [{ loader: { version: "0.16.14", stable: true } }] } });
  const settings = new SettingsStore(dataDir);
  await settings.update((s) => ({ ...s, launcher: { kind: "prism", root: prismRoot, prismWriteAllowed: true } }));
  const registry = new Registry(dataDir);
  const running = { value: false };
  const packs = new Packs({ dataDir, http, modrinth: new ModrinthClient(http, new Throttle(10_000)), registry, journal: new Journal(dataDir), settings, prismRunning: async () => running.value });
  const adoptions = new Adoptions({ dataDir, registry, prismRoot: async () => prismRoot, now: () => new Date("2026-11-10T12:00:00Z") });
  return { dataDir, prismRoot, vanilla, modded, packs, adoptions, registry, running };
}

beforeEach(() => clearLoaderCache());

describe("reading Prism instances", () => {
  it("reads names (quoted, escaped) and the loader from mmc-pack.json", () => {
    expect(cfgName('[General]\nname="A \\"B\\""\n')).toBe('A "B"');
    expect(cfgName("[General]\nname=Plain\n")).toBe("Plain");
    expect(readPackComponents(VANILLA_PACK)).toEqual({ mcVersion: "1.21.1", loader: "vanilla", loaderVersion: undefined });
    expect(readPackComponents(JSON.stringify({ formatVersion: 1, components: [{ uid: "net.minecraft", version: "1.20.1" }, { uid: "net.neoforged", version: "47.1.106" }] }))).toMatchObject({ loader: "neoforge", loaderVersion: "47.1.106" });
  });
});

describe("discovery (ADP-1)", () => {
  it("lists other instances as metadata only, skips packsmith's own, says why one can't be managed", async () => {
    const w = await world();
    const before = await tree(w.prismRoot);
    const list = await w.adoptions.discover();
    expect(list.map((i) => i.name)).toEqual(["Alpha", "Modded", "Quilty", 'Vanilla "Survival"']); // by display name
    expect(list.find((i) => i.ref === "Modded")).toMatchObject({ name: "Modded", loader: "fabric", mcVersion: "1.21.1", modFiles: 2, adoptable: true });
    expect(list.find((i) => i.ref === "Quilty")).toMatchObject({ adoptable: false, reason: expect.stringMatching(/loader packsmith doesn't support/) });
    expect(await tree(w.prismRoot)).toEqual(before); // discovery writes nothing
  });
});

describe("adoption (ADP-2/6) and the write boundary", () => {
  it("adopting records the scope and snapshots only the scoped files (never worlds)", async () => {
    const w = await world();
    const r = await w.adoptions.adopt("Vanilla Survival", ["settings", "loader", "mods"]);
    expect(r).toMatchObject({ origin: "adopted", name: 'Vanilla "Survival"', loader: "vanilla", scope: ["settings", "loader", "mods"] });
    const m = (await w.adoptions.manifest(r.id))!;
    expect(m.snapshot.map((s) => s.relpath).sort()).toEqual(["minecraft/options.txt", "mmc-pack.json"]);
    expect(m.snapshot.every((s) => /^[0-9a-f]{64}$/.test(s.sha256))).toBe(true);
    expect((await w.adoptions.discover()).map((i) => i.ref)).not.toContain("Vanilla Survival");
  });

  it("maps paths to scopes; worlds and the instance's own files are never in one", () => {
    expect(scopeOf("minecraft/mods/x.jar")).toBe("mods");
    expect(scopeOf("minecraft/config/sodium.json")).toBe("configs");
    expect(scopeOf("minecraft/config/heracles/quests/a/b.json")).toBe("quests");
    expect(scopeOf("minecraft/saves/W/datapacks/packsmith_quests/pack.mcmeta")).toBe("quests");
    expect(scopeOf("minecraft/saves/W/level.dat")).toBeNull();
    expect(scopeOf("instance.cfg")).toBeNull();
    expect(scopeOf("mmc-pack.json")).toBe("loader");
  });

  it("writes only inside the allowed scopes", async () => {
    const w = await world();
    const r = await w.adoptions.adopt("Vanilla Survival", ["settings"]);
    await expect(assertWritable(r, "minecraft/options.txt")).resolves.toContain("options.txt");
    await expect(assertWritable(r, "minecraft/config/x.json")).rejects.toThrow(/haven't let packsmith change configs/);
    await expect(assertWritable(r, "minecraft/saves/My World/level.dat")).rejects.toThrow(/worlds never are/);
    await expect(assertWritable({ ...r, scope: undefined }, "minecraft/options.txt")).rejects.toThrow(/haven't let packsmith/);
  });

  it("a game setting by chat (CFG-1) on an adopted instance is journaled and undone exactly", async () => {
    const w = await world();
    const r = await w.adoptions.adopt("Vanilla Survival", ["settings"]);
    const before = await tree(w.vanilla);
    const { entry } = await w.packs.writeConfig(r.id, "minecraft/options.txt", "renderDistance:6\n");
    expect(await readFile(join(w.vanilla, "minecraft/options.txt"), "utf8")).toBe("renderDistance:6\n");
    await w.packs.undo(r.id, entry.id);
    expect(await tree(w.vanilla)).toEqual(before);
  });
});

describe("loader in place (ADP-4)", () => {
  it("adds Fabric to a vanilla instance, keeps its world and Prism's other components, and undoes byte for byte", async () => {
    const w = await world();
    const r = await w.adoptions.adopt("Vanilla Survival", ["loader", "mods"]);
    const before = await tree(w.vanilla);
    const { entry, loaderVersion } = await w.packs.setLoader(r.id, "fabric");
    expect(loaderVersion).toBe("0.16.14");
    const pack = JSON.parse(await readFile(join(w.vanilla, "mmc-pack.json"), "utf8")) as { components: Array<{ uid: string }> };
    expect(pack.components.map((c) => c.uid)).toEqual(["org.lwjgl3", "net.minecraft", "net.fabricmc.fabric-loader"]);
    expect((await w.registry.get(r.id)).loader).toBe("fabric");
    expect(await readFile(join(w.vanilla, "minecraft/saves/My World/level.dat"), "utf8")).toBe("precious world");
    await w.packs.undo(r.id, entry.id);
    expect(await tree(w.vanilla)).toEqual(before);
    expect((await w.registry.get(r.id)).loader).toBe("vanilla");
  });

  it("refuses on a modded instance, without the loader scope, and while Prism runs", async () => {
    const w = await world();
    const modded = await w.adoptions.adopt("Modded", ["loader", "mods"]);
    await expect(w.packs.setLoader(modded.id, "neoforge")).rejects.toThrow(/already runs Fabric/);
    const v = await w.adoptions.adopt("Vanilla Survival", ["mods"]);
    await expect(w.packs.setLoader(v.id, "fabric")).rejects.toThrow(/haven't let packsmith change the mod loader/);
    w.running.value = true;
    await expect(w.packs.writeConfig(v.id, "minecraft/options.txt", "x:1\n")).rejects.toThrow(/Close Prism Launcher first/);
  });
});

describe("revoking (ADP-2)", () => {
  it("takes the instance out of packsmith's hands: nothing can write it afterwards; the manifest keeps the history", async () => {
    const w = await world();
    const r = await w.adoptions.adopt("Vanilla Survival", ["settings"]);
    await w.adoptions.revoke(r.id);
    await expect(w.packs.writeConfig(r.id, "minecraft/options.txt", "x:1\n")).rejects.toThrow(/isn't in packsmith's list/);
    expect((await w.adoptions.manifest(r.id))?.revokedAt).toBe("2026-11-10T12:00:00.000Z");
    expect((await w.adoptions.discover()).map((i) => i.ref)).toContain("Vanilla Survival");
  });

  it("refuses bad folder names and instances it can't manage", async () => {
    const w = await world();
    await expect(w.adoptions.adopt("../etc", ["mods"])).rejects.toThrow(/isn't an instance folder/);
    await expect(w.adoptions.adopt("Quilty", ["mods"])).rejects.toThrow(/doesn't support/);
    await expect(w.adoptions.adopt("Vanilla Survival", [])).rejects.toThrow(/at least one/);
  });
});
