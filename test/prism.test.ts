import { describe, expect, it } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { addToPrismGroup, createPrismInstance, detectPrismRoot, prismInstancesDir, withLoader } from "../src/main/launchers/prism";
import { latestLoaderVersion, pickPrismLoader, clearLoaderCache, PRISM_META } from "../src/main/loaders";
import { fakeHttp } from "./helpers";
import { tempDir } from "./helpers";

describe("Prism adapter (D-5, INS-2)", () => {
  it("writes instance.cfg and mmc-pack.json in Prism's format, with the loader as a component (LDR-2)", async () => {
    const dir = join(await tempDir(), "packsmith-1.21.1-cozy");
    await createPrismInstance({ dir, name: 'Cozy, "quoted" pack', mcVersion: "1.21.1", loader: "fabric", loaderVersion: "0.16.14" });
    const cfg = await readFile(join(dir, "instance.cfg"), "utf8");
    expect(cfg).toContain("InstanceType=OneSix");
    expect(cfg).toContain('name="Cozy, \\"quoted\\" pack"');
    expect(JSON.parse(await readFile(join(dir, "mmc-pack.json"), "utf8"))).toEqual({
      formatVersion: 1,
      components: [{ uid: "net.minecraft", version: "1.21.1", important: true }, { uid: "net.fabricmc.fabric-loader", version: "0.16.14" }],
    });
  });

  it("writes only net.minecraft for a vanilla pack, and refuses to reuse an existing folder", async () => {
    const dir = join(await tempDir(), "v");
    await createPrismInstance({ dir, name: "V", mcVersion: "1.21.1", loader: "vanilla" });
    expect(JSON.parse(await readFile(join(dir, "mmc-pack.json"), "utf8")).components).toHaveLength(1);
    await expect(createPrismInstance({ dir, name: "V", mcVersion: "1.21.1", loader: "vanilla" })).rejects.toMatchObject({ code: "exists" });
  });

  it("adds to the packsmith group and keeps every other group and field exactly", async () => {
    const dir = await tempDir();
    const before = { formatVersion: "1", groups: { Mine: { hidden: true, instances: ["ATM10"] } }, extraField: 7 };
    await writeFile(join(dir, "instgroups.json"), JSON.stringify(before));
    await addToPrismGroup(dir, "packsmith-1.21.1-a");
    await addToPrismGroup(dir, "packsmith-1.21.1-a"); // idempotent
    const after = JSON.parse(await readFile(join(dir, "instgroups.json"), "utf8"));
    expect(after.groups.Mine).toEqual(before.groups.Mine);
    expect(after.extraField).toBe(7);
    expect(after.groups.packsmith.instances).toEqual(["packsmith-1.21.1-a"]);
  });

  it("leaves a group file it can't parse untouched", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "instgroups.json"), '{"groups": "weird"}');
    await expect(addToPrismGroup(dir, "x")).rejects.toMatchObject({ code: "corrupt-file" });
    expect(await readFile(join(dir, "instgroups.json"), "utf8")).toBe('{"groups": "weird"}');
  });

  it("finds the root by prismlauncher.cfg and honours a custom InstanceDir", async () => {
    const root = await tempDir();
    await writeFile(join(root, "prismlauncher.cfg"), "[General]\nInstanceDir=/srv/mc/instances\n");
    expect(await detectPrismRoot(["/nonexistent", root])).toBe(root);
    expect(await prismInstancesDir(root)).toBe("/srv/mc/instances");
    await writeFile(join(root, "prismlauncher.cfg"), "[General]\n");
    expect(await prismInstancesDir(root)).toBe(join(root, "instances"));
    await mkdir(join(root, "x"));
    expect(await detectPrismRoot([join(root, "x")])).toBeNull();
  });

  it("writes Forge and NeoForge as Prism components with the uids Prism uses", async () => {
    // net.neoforged: as in a NeoForge 1.21.1 instance Prism made (read-only check, 2026-11-03);
    // net.minecraftforge: as listed by meta.prismlauncher.org.
    for (const [loader, uid] of [["forge", "net.minecraftforge"], ["neoforge", "net.neoforged"]] as const) {
      const dir = join(await tempDir(), loader);
      await createPrismInstance({ dir, name: loader, mcVersion: "1.20.1", loader, loaderVersion: "47.4.28" });
      expect(JSON.parse(await readFile(join(dir, "mmc-pack.json"), "utf8")).components[1]).toEqual({ uid, version: "47.4.28" });
    }
  });

  it("swaps only the loader component in an existing mmc-pack.json, keeping everything Prism added", () => {
    const prismMade = JSON.stringify({ formatVersion: 1, components: [
      { uid: "org.lwjgl3", version: "3.3.3", dependencyOnly: true },
      { uid: "net.minecraft", version: "1.21.1", important: true, cachedName: "Minecraft" },
      { uid: "net.fabricmc.intermediary", version: "1.21.1" },
      { uid: "net.fabricmc.fabric-loader", version: "0.16.14" },
    ] });
    const neo = JSON.parse(withLoader(prismMade, "neoforge", "21.1.265"));
    expect(neo.components).toEqual([
      { uid: "org.lwjgl3", version: "3.3.3", dependencyOnly: true },
      { uid: "net.minecraft", version: "1.21.1", important: true, cachedName: "Minecraft" },
      { uid: "net.neoforged", version: "21.1.265" },
    ]);
    expect(JSON.parse(withLoader(prismMade, "vanilla")).components.map((c: { uid: string }) => c.uid)).toEqual(["org.lwjgl3", "net.minecraft"]);
    expect(() => withLoader('{"components":"x"}', "fabric", "1")).toThrow(/mmc-pack.json/);
  });
});

describe("loader versions (M-4, LDR-1)", () => {
  it("picks the recommended Forge build, else the newest release, for the exact Minecraft version", async () => {
    const fx = JSON.parse(await readFile(join(__dirname, "fixtures/prism-meta.json"), "utf8"));
    expect(pickPrismLoader(fx.forge, "1.20.1")).toBe("47.4.28");
    expect(pickPrismLoader(fx.forge, "26.2")).toBe("65.1.5"); // recommended beats the newer 65.1.6
    expect(pickPrismLoader(fx.neoforge, "1.21.1")).toBe("21.1.265"); // none recommended: newest release
    expect(pickPrismLoader(fx.neoforge, "1.19.2")).toBeUndefined();
  });

  it("names the loader and version when there is no build", async () => {
    clearLoaderCache();
    const fx = JSON.parse(await readFile(join(__dirname, "fixtures/prism-meta.json"), "utf8"));
    const { http, calls } = fakeHttp({ json: { [`${PRISM_META}/net.neoforged/index.json`]: fx.neoforge } });
    await expect(latestLoaderVersion(http, "neoforge", "1.19.2")).rejects.toThrow("NeoForge has no build for Minecraft 1.19.2.");
    expect(await latestLoaderVersion(http, "neoforge", "26.2")).toBe("26.2.0.93");
    expect(calls).toHaveLength(1); // cached
    expect(calls[0]!.opts?.allowHosts).toEqual(["meta.prismlauncher.org"]);
    expect(await latestLoaderVersion(http, "vanilla", "1.21.1")).toBeUndefined();
  });
});
