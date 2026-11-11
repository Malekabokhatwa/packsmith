import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContentItem, InstanceRecord } from "@shared/schema";
import type { ModrinthVersion } from "../src/main/sources/modrinth";
import { licenceManifest, mrpackIndex, writeFolder, writeMrpack } from "../src/main/export/export";
import { ZipWriter, safeEntryName } from "../src/main/export/zipWriter";
import { withZip } from "../src/main/archive/zip";

const h = (c: string, n: number) => c.repeat(n);
function mod(name: string, over: Partial<ContentItem> & { license?: string; client?: "required" | "unsupported" | "optional" } = {}): ContentItem {
  const sha512 = h(name[0]!, 128);
  return {
    relpath: `minecraft/mods/${name}.jar`, kind: "mod", enabled: true, sha1: h(name[0]!, 40), sha512, bytes: 1234,
    match: { status: "modrinth", projectId: `P${name}`, versionId: `V${name}`, title: name, summary: "", versionNumber: "1.0", categories: [], license: over.license ?? "MIT", clientSide: over.client ?? "required", serverSide: "optional" },
    reason: { kind: "requested", of: [] },
    ...over,
  } as ContentItem;
}
const version = (c: ContentItem): ModrinthVersion => ({
  id: "v", project_id: "p", version_number: "1.0", game_versions: [], loaders: [], dependencies: [], date_published: "2026-01-01T00:00:00Z", version_type: "release", name: "x",
  files: [{ url: `https://cdn.modrinth.com/data/${c.relpath}`, filename: "x.jar", primary: true, size: c.bytes, hashes: { sha1: c.sha1, sha512: c.sha512 } }],
} as unknown as ModrinthVersion);

const record = (path: string): InstanceRecord => ({ id: "packsmith-1.21.1-trail", origin: "own", launcher: "app-managed", path, name: "Trail / Pack", mcVersion: "1.21.1", loader: "fabric", loaderVersion: "0.20.1", createdAt: "2026-11-03T00:00:00.000Z", groupPending: false });

describe("export (EXP-1..4)", () => {
  it("references every enabled Modrinth file by URL and both hashes, and lists the rest instead of embedding it", () => {
    const a = mod("alpha", { client: "unsupported" }), b = mod("beta", { enabled: false });
    const local: ContentItem = { ...mod("gamma"), match: { status: "unmatched", reason: "not-on-modrinth" } };
    const { index, leftOut } = mrpackIndex(record("/p"), "0.20.1", [a, b, local], { [a.sha512]: version(a), [b.sha512]: version(b) });
    expect(index.dependencies).toEqual({ minecraft: "1.21.1", "fabric-loader": "0.20.1" });
    expect(index.files).toEqual([{ path: "mods/alpha.jar", hashes: { sha1: a.sha1, sha512: a.sha512 }, env: { client: "unsupported", server: "required" }, downloads: ["https://cdn.modrinth.com/data/minecraft/mods/alpha.jar"], fileSize: 1234 }]);
    expect(leftOut.map((l) => [l.relpath, l.why.split(",")[0]])).toEqual([["minecraft/mods/beta.jar", "turned off"], ["minecraft/mods/gamma.jar", "not on Modrinth"]]);
    expect(() => mrpackIndex({ ...record("/p"), loaderVersion: undefined }, undefined, [], {})).toThrow(/doesn't know which fabric build/);
    // Offline is not "not on Modrinth": refuse instead of leaving real mods out.
    const offline: ContentItem = { ...mod("gamma"), match: { status: "unmatched", reason: "offline" } };
    expect(() => mrpackIndex(record("/p"), "0.20.1", [a, offline], { [a.sha512]: version(a) })).toThrow(/couldn't be reached/);
    expect(() => mrpackIndex(record("/p"), "0.20.1", [a], {})).toThrow(/didn't return the download link for alpha/);
  });

  it("flags missing, all-rights-reserved and non-Modrinth licences in the manifest", () => {
    const local: ContentItem = { ...mod("gamma"), match: { status: "unmatched", reason: "not-on-modrinth" } };
    const { text, flags } = licenceManifest(record("/p"), [mod("alpha"), mod("beta", { license: "LicenseRef-All-Rights-Reserved" }), mod("delta", { license: "" }), local]);
    expect(text).toContain("| alpha | 1.0 | https://modrinth.com/project/Palpha | MIT |");
    expect(flags).toHaveLength(3);
    expect(flags.join("\n")).toMatch(/beta: licence "LicenseRef-All-Rights-Reserved"[\s\S]*delta: licence missing[\s\S]*gamma\.jar: not on Modrinth/);
  });

  it("refuses archive entry names that could escape their folder", () => {
    for (const bad of ["../x", "/etc/x", "a/../../x", "C:/x", "a//b", ""]) expect(() => safeEntryName(bad)).toThrow();
    expect(safeEntryName("overrides\\config\\a.toml")).toBe("overrides/config/a.toml");
  });

  it("writes a .mrpack our own zip reader opens: index, licences, configs as overrides, no jars", async () => {
    const dir = await mkdtemp(join(tmpdir(), "packsmith-export-"));
    try {
      const root = join(dir, "pack");
      await mkdir(join(root, "minecraft/config/sub"), { recursive: true });
      await mkdir(join(root, "minecraft/mods"), { recursive: true });
      await writeFile(join(root, "minecraft/config/sub/a.toml"), "x = 1\n".repeat(200));
      await writeFile(join(root, "minecraft/options.txt"), "renderDistance:8\n");
      await writeFile(join(root, "minecraft/mods/alpha.jar"), "PK jar");
      const a = mod("alpha");
      const report = await writeMrpack(join(dir, "Trail.mrpack"), record(root), "0.20.1", [a], { [a.sha512]: version(a) });
      expect(report).toMatchObject({ referenced: 1, overrides: 2, leftOut: [] });
      await withZip(join(dir, "Trail.mrpack"), async (z) => {
        expect(z.names().sort()).toEqual(["LICENSES.md", "modrinth.index.json", "overrides/config/sub/a.toml", "overrides/options.txt"]);
        expect(JSON.parse((await z.read("modrinth.index.json"))!.toString()).files[0].path).toBe("mods/alpha.jar");
        expect((await z.read("overrides/config/sub/a.toml"))!.toString()).toBe("x = 1\n".repeat(200));
      });
      expect((await readdir(dir)).filter((n) => n.endsWith(".part"))).toEqual([]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("writes a Prism instance folder with the pack's loader, without packsmith's marker", async () => {
    const dir = await mkdtemp(join(tmpdir(), "packsmith-export-"));
    try {
      const root = join(dir, "pack");
      await mkdir(join(root, "minecraft/mods"), { recursive: true });
      await writeFile(join(root, "minecraft/mods/alpha.jar"), "PK jar");
      await writeFile(join(root, ".packsmith-instance.json"), "{}");
      await writeFolder(join(dir, "Trail"), record(root), "0.20.1", [mod("alpha")]);
      expect((await readdir(join(dir, "Trail"))).sort()).toEqual(["LICENSES.md", "instance.cfg", "minecraft", "mmc-pack.json"]);
      expect(JSON.parse(await readFile(join(dir, "Trail/mmc-pack.json"), "utf8")).components[1]).toEqual({ uid: "net.fabricmc.fabric-loader", version: "0.20.1" });
      await expect(writeFolder(join(dir, "Trail"), record(root), "0.20.1", [])).rejects.toMatchObject({ code: "exists" });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("an aborted zip leaves no file behind", async () => {
    const dir = await mkdtemp(join(tmpdir(), "packsmith-export-"));
    try {
      const z = ZipWriter.create(join(dir, "x.zip"));
      await z.add("a.txt", Buffer.from("a"));
      await z.abort();
      expect(await readdir(dir)).toEqual([]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
