import { beforeEach, describe, expect, it } from "vitest";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";
import { Packs } from "../src/main/instances/manager";
import { Registry } from "../src/main/instances/registry";
import { Journal } from "../src/main/instances/journal";
import { SettingsStore } from "../src/main/settings";
import { ModrinthClient, MODRINTH_API, Throttle, type ModrinthVersion } from "../src/main/sources/modrinth";
import { clearLoaderCache, PRISM_META } from "../src/main/loaders";
import { fakeHttp, fixture, hashes, tempDir } from "./helpers";

const XAERO = "1bokaNcj", FAPI = "P7dR8mSH";
const XAERO_URL = "https://cdn.modrinth.com/data/1bokaNcj/versions/x/xaerominimap-fabric-1.21.1-26.6.0.jar";
const FAPI_URL = "https://cdn.modrinth.com/data/P7dR8mSH/versions/y/fabric-api-0.116.17+1.21.1.jar";
const NEWER_URL = "https://cdn.modrinth.com/data/1bokaNcj/versions/z/xaerominimap-fabric-1.21.1-27.0.0.jar";
const xaeroJar = Buffer.from("fake xaero jar bytes");
const fapiJar = Buffer.from("fake fabric api jar");
const newerJar = Buffer.from("fake newer xaero jar");

const exists = (p: string) => access(p).then(() => true, () => false);

async function world(opts: { prism: boolean; prismRunning?: { value: boolean }; withUpdate?: boolean }) {
  const dataDir = await tempDir("ps-data-");
  const prismRoot = await tempDir("ps-prism-");
  await writeFile(join(prismRoot, "prismlauncher.cfg"), "[General]\nInstanceDir=instances\n");
  // Decoy: the user's own instance + their groups. packsmith must never change a byte (AC-12).
  const decoy = join(prismRoot, "instances/My Survival");
  await mkdir(join(decoy, "minecraft/mods"), { recursive: true });
  await writeFile(join(decoy, "instance.cfg"), "[General]\nname=My Survival\n");
  await writeFile(join(decoy, "mmc-pack.json"), '{"formatVersion":1,"components":[]}');
  await writeFile(join(decoy, "minecraft/mods/theirs.jar"), "their jar");
  await writeFile(join(prismRoot, "instances/instgroups.json"), JSON.stringify({ formatVersion: "1", groups: { Fav: { hidden: false, instances: ["My Survival"] } } }));

  const xaeroVersions = (await fixture("versions.json")) as ModrinthVersion[];
  xaeroVersions[0]!.files = [{ url: XAERO_URL, filename: "xaerominimap-fabric-1.21.1-26.6.0.jar", primary: true, size: xaeroJar.length, hashes: hashes(xaeroJar) }];
  const fapiVersion: ModrinthVersion = { ...structuredClone(xaeroVersions[0]!), id: "Mys3P7lK", project_id: FAPI, version_number: "0.116.17+1.21.1", dependencies: [], files: [{ url: FAPI_URL, filename: "fabric-api-0.116.17+1.21.1.jar", primary: true, size: fapiJar.length, hashes: hashes(fapiJar) }] };
  const newer: ModrinthVersion = { ...structuredClone(xaeroVersions[0]!), id: "NEWERxae", version_number: "fabric-1.21.1-27.0.0", date_published: "2026-11-01T00:00:00Z", files: [{ url: NEWER_URL, filename: "xaerominimap-fabric-1.21.1-27.0.0.jar", primary: true, size: newerJar.length, hashes: hashes(newerJar) }] };
  const allVersions = [...xaeroVersions, fapiVersion, newer];
  const project = (await fixture("project.json")) as Record<string, unknown>;
  const fabricApi = { ...project, id: FAPI, slug: "fabric-api", title: "Fabric API" };
  const projects = [project, fabricApi] as Array<{ id: string; slug: string }>;
  const byHash = new Map<string, ModrinthVersion>([[hashes(xaeroJar).sha512, xaeroVersions[0]!], [hashes(fapiJar).sha512, fapiVersion], [hashes(newerJar).sha512, newer]]);
  const neo = (JSON.parse(await readFile(join(__dirname, "fixtures/prism-meta.json"), "utf8")) as { neoforge: unknown }).neoforge;

  const { http, calls } = fakeHttp({
    json: {
      "https://meta.fabricmc.net/v2/versions/loader/1.21.1": [{ loader: { version: "0.16.14", stable: true } }],
      [`${PRISM_META}/net.neoforged/index.json`]: neo,
      [`${MODRINTH_API}/`]: (url: string, o?: { body?: unknown }) => {
        const u = new URL(url);
        const path = u.pathname.replace(/^\/v2/, "");
        const ids = () => JSON.parse(u.searchParams.get("ids")!) as string[];
        if (path === "/projects") return projects.filter((p) => ids().includes(p.id) || ids().includes(p.slug));
        if (path === "/versions") return allVersions.filter((v) => ids().includes(v.id));
        if (path === `/project/${XAERO}/version`) return xaeroVersions;
        if (path === `/project/${FAPI}/version`) return [fapiVersion];
        if (path === `/project/${XAERO}`) return project;
        if (path.startsWith("/version/")) return allVersions.find((v) => v.id === path.slice(9));
        const asked = (JSON.parse(String(o?.body)) as { hashes: string[] }).hashes;
        if (path === "/version_files/update") return opts.withUpdate ? Object.fromEntries(asked.filter((h) => h === hashes(xaeroJar).sha512).map((h) => [h, newer])) : {};
        if (path === "/version_files") return Object.fromEntries(asked.filter((h) => byHash.has(h)).map((h) => [h, byHash.get(h)]));
        throw new Error(`unexpected ${url}`);
      },
    },
    files: { [XAERO_URL]: xaeroJar, [FAPI_URL]: fapiJar, [NEWER_URL]: newerJar },
  });
  const settings = new SettingsStore(dataDir);
  if (opts.prism) await settings.update((s) => ({ ...s, launcher: { kind: "prism", root: prismRoot, prismWriteAllowed: true } }));
  const running = opts.prismRunning ?? { value: false };
  const make = () => new Packs({ dataDir, http, modrinth: new ModrinthClient(http, new Throttle(10_000)), registry: new Registry(dataDir), journal: new Journal(dataDir), settings, prismRunning: async () => running.value });
  return { dataDir, prismRoot, decoy, packs: make(), make, running, settings, calls };
}

async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  async function walk(d: string) {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else out[relative(dir, p)] = createHash("sha256").update(await readFile(p)).digest("hex");
    }
  }
  await walk(dir);
  return out;
}

beforeEach(() => clearLoaderCache());

describe("Packs: creating", () => {
  it("creates an app-managed pack (INS-1 default) with the marker and game folders", async () => {
    const w = await world({ prism: false });
    const r = await w.packs.create({ name: "Hearthwood", mcVersion: "1.21.1", loader: "fabric" });
    expect(r).toMatchObject({ id: "packsmith-1.21.1-hearthwood", origin: "own", launcher: "app-managed", loaderVersion: "0.16.14" });
    expect(r.path).toBe(join(w.dataDir, "instances/packsmith-1.21.1-hearthwood"));
    expect(JSON.parse(await readFile(join(r.path, ".packsmith-instance.json"), "utf8"))).toMatchObject({ createdBy: "packsmith", instanceId: r.id });
    expect((await readdir(join(r.path, "minecraft"))).sort()).toEqual(["config", "mods", "resourcepacks", "shaderpacks"]);
    const again = await w.packs.create({ name: "Hearthwood", mcVersion: "1.21.1", loader: "fabric" });
    expect(again.id).toBe("packsmith-1.21.1-hearthwood-2");
  });

  it("creates a NeoForge pack in Prism with the recommended build (LDR-1/2)", async () => {
    const w = await world({ prism: true });
    const r = await w.packs.create({ name: "Neo", mcVersion: "1.21.1", loader: "neoforge" });
    expect(r.loaderVersion).toBe("21.1.265");
    expect(JSON.parse(await readFile(join(r.path, "mmc-pack.json"), "utf8")).components[1]).toEqual({ uid: "net.neoforged", version: "21.1.265" });
  });

  it("waits to write Prism's group file until Prism is closed", async () => {
    const running = { value: true };
    const w = await world({ prism: true, prismRunning: running });
    const r = await w.packs.create({ name: "Later", mcVersion: "1.21.1", loader: "fabric" });
    let groups = JSON.parse(await readFile(join(w.prismRoot, "instances/instgroups.json"), "utf8"));
    expect(groups.groups.packsmith).toBeUndefined();
    expect((await w.packs.list())[0]!.groupPending).toBe(true);
    running.value = false;
    await w.packs.syncPrismGroups();
    groups = JSON.parse(await readFile(join(w.prismRoot, "instances/instgroups.json"), "utf8"));
    expect(groups.groups.packsmith.instances).toEqual([r.id]);
    expect((await w.packs.list())[0]!.groupPending).toBe(false);
  });

  it("refuses Prism mode without the one-time permission", async () => {
    const w = await world({ prism: true });
    await w.settings.update((s) => ({ ...s, launcher: { ...s.launcher, prismWriteAllowed: false } }));
    await expect(w.packs.create({ name: "No", mcVersion: "1.21.1", loader: "fabric" })).rejects.toMatchObject({ code: "prism-permission" });
  });
});

describe("Packs: installing with dependencies (DEP, milestone c)", () => {
  it("installs a mod and the library it needs in one undoable step, never touching the decoy (AC-12)", async () => {
    const w = await world({ prism: true });
    const decoyBefore = await snapshot(w.decoy);
    const r = await w.packs.create({ name: "Cozy Test", mcVersion: "1.21.1", loader: "fabric" });
    const groups = JSON.parse(await readFile(join(w.prismRoot, "instances/instgroups.json"), "utf8"));
    expect(groups.groups.Fav.instances).toEqual(["My Survival"]);

    const res = await w.packs.install(r.id, XAERO);
    expect(res).toMatchObject({ title: "Xaero's Minimap", alreadyInstalled: false });
    expect(res.added.map((a) => a.relpath)).toEqual(["minecraft/mods/xaerominimap-fabric-1.21.1-26.6.0.jar", "minecraft/mods/fabric-api-0.116.17+1.21.1.jar"]);
    expect(await readFile(join(r.path, res.added[1]!.relpath))).toEqual(fapiJar);

    const items = await w.packs.scan(r.id);
    expect(items.map((i) => i.match.status === "modrinth" && i.match.title).sort()).toEqual(["Fabric API", "Xaero's Minimap"]);
    // GRP-1: the scan says why each file is here (the user asked; the library is needed by it).
    const why = Object.fromEntries(items.map((i) => [i.match.status === "modrinth" ? i.match.title : i.relpath, i.reason]));
    expect(why["Xaero's Minimap"]).toEqual({ kind: "requested", of: [] });
    expect(why["Fabric API"]).toEqual({ kind: "dependency", of: [XAERO] });

    const history = await w.packs.history(r.id);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ id: res.entryId, action: "download", state: "committed", reason: "Added Xaero's Minimap, plus Fabric API" });

    // Asking again changes nothing.
    const again = await w.packs.install(r.id, XAERO);
    expect(again).toMatchObject({ alreadyInstalled: true, added: [] });
    expect(await w.packs.history(r.id)).toHaveLength(1);

    await w.packs.undo(r.id, res.entryId!);
    expect(await readdir(join(r.path, "minecraft/mods"))).toEqual([]);
    expect(await snapshot(w.decoy)).toEqual(decoyBefore);
  });

  it("refuses a download past the run's download budget before writing anything (PERF-5)", async () => {
    const w = await world({ prism: true });
    const r = await w.packs.create({ name: "Budget Test", mcVersion: "1.21.1", loader: "fabric" });
    const tight = { usedBytes: 0, limitBytes: 10 };
    await expect(w.packs.installProject(r.id, XAERO, { budget: tight })).rejects.toMatchObject({ code: "budget-disk" });
    await expect(w.packs.installProject(r.id, XAERO, { budget: tight })).rejects.toThrow(/download budget of 1 MB/);
    expect(await readdir(join(r.path, "minecraft/mods"))).toEqual([]);
    expect(await w.packs.history(r.id)).toEqual([]);
    const roomy = { usedBytes: 0, limitBytes: 1024 * 1_048_576 };
    const res = await w.packs.installProject(r.id, XAERO, { budget: roomy });
    expect(res.added).toHaveLength(2);
    expect(roomy.usedBytes).toBeGreaterThan(0);
  });

  it("skips a library the pack already has", async () => {
    const w = await world({ prism: false });
    const r = await w.packs.create({ name: "Lib", mcVersion: "1.21.1", loader: "fabric" });
    await writeFile(join(r.path, "minecraft/mods/fabric-api.jar"), fapiJar);
    const res = await w.packs.install(r.id, XAERO);
    expect(res.added.map((a) => a.title)).toEqual(["Xaero's Minimap"]);
  });

  it("refuses a mod in a pack without a loader, with the fix", async () => {
    const w = await world({ prism: false });
    const r = await w.packs.create({ name: "Plain", mcVersion: "1.21.1", loader: "vanilla" });
    await expect(w.packs.install(r.id, XAERO)).rejects.toThrow("Xaero's Minimap is a mod, and this pack has no mod loader. Add a loader to the pack");
  });

  it("explains which versions exist when a project has none for the pack (DEP-5)", async () => {
    const w = await world({ prism: false });
    const r = await w.packs.create({ name: "Old", mcVersion: "1.20.1", loader: "fabric" }).catch(() => null);
    // The fake Fabric service only knows 1.21.1, so make the 1.20.1 pack by hand-editing nothing: use a 1.21.1 pack
    // and a project whose versions are all for other game versions.
    expect(r).toBeNull();
    const p = await w.packs.create({ name: "New", mcVersion: "1.21.1", loader: "fabric" });
    const { http } = fakeHttp({
      json: {
        [`${MODRINTH_API}/`]: async (url: string) => {
          const path = new URL(url).pathname.replace(/^\/v2/, "");
          if (path === "/projects") return [await fixture("project.json")];
          if (path === `/project/${XAERO}/version`) return new URL(url).searchParams.has("game_versions") ? [] : [{ ...((await fixture("versions.json")) as ModrinthVersion[])[0]!, game_versions: ["1.20.1", "26.2"] }];
          if (path === "/version_files") return {};
          throw new Error(url);
        },
      },
    });
    const packs = new Packs({ dataDir: w.dataDir, http, modrinth: new ModrinthClient(http, new Throttle(1000)), registry: new Registry(w.dataDir), journal: new Journal(w.dataDir), settings: w.settings, prismRunning: async () => false });
    await expect(packs.install(p.id, XAERO)).rejects.toThrow("Xaero's Minimap has no version for Fabric 1.21.1. Xaero's Minimap has versions for Fabric 26.2, 1.20.1. Move the pack to one of those, or leave Xaero's Minimap out.");
  });
});

describe("Packs: changing content (INT-2) and the journal (4.3)", () => {
  async function withMods() {
    const w = await world({ prism: true, withUpdate: true });
    const r = await w.packs.create({ name: "Edit", mcVersion: "1.21.1", loader: "fabric" });
    await w.packs.install(r.id, XAERO);
    return { w, r };
  }
  const JAR = "minecraft/mods/xaerominimap-fabric-1.21.1-26.6.0.jar";

  it("turns a mod off and on, and each step can be undone", async () => {
    const { w, r } = await withMods();
    const off = await w.packs.setEnabled(r.id, JAR, false);
    expect(await exists(join(r.path, `${JAR}.disabled`))).toBe(true);
    expect((await w.packs.scan(r.id)).find((i) => i.relpath === `${JAR}.disabled`)?.enabled).toBe(false);
    expect(await w.packs.setEnabled(r.id, `${JAR}.disabled`, false)).toBeNull(); // already off
    await w.packs.undo(r.id, off!.entry.id);
    expect(await exists(join(r.path, JAR))).toBe(true);
    await expect(w.packs.setEnabled(r.id, "minecraft/config/x.toml", false)).rejects.toMatchObject({ code: "bad-path" });
  });

  it("removes a mod into the journal and brings it back on undo", async () => {
    const { w, r } = await withMods();
    const res = await w.packs.remove(r.id, JAR, { label: "Xaero's Minimap" });
    expect(res.entry.reason).toBe("Removed Xaero's Minimap");
    expect(await exists(join(r.path, JAR))).toBe(false);
    await w.packs.undo(r.id, res.entry.id);
    expect(await readFile(join(r.path, JAR))).toEqual(xaeroJar);
  });

  it("updates a mod to the newest fitting version, keeping it off if it was off, undoable", async () => {
    const { w, r } = await withMods();
    const item = (await w.packs.scan(r.id)).find((i) => i.relpath === JAR)!;
    expect(item.match.status === "modrinth" && item.match.update).toEqual({ versionId: "NEWERxae", versionNumber: "fabric-1.21.1-27.0.0" });
    await w.packs.setEnabled(r.id, JAR, false);
    const res = await w.packs.update(r.id, `${JAR}.disabled`);
    expect(res.added.map((a) => a.relpath)).toEqual(["minecraft/mods/xaerominimap-fabric-1.21.1-27.0.0.jar.disabled"]);
    expect((await readdir(join(r.path, "minecraft/mods"))).sort()).toEqual(["fabric-api-0.116.17+1.21.1.jar", "xaerominimap-fabric-1.21.1-27.0.0.jar.disabled"]);
    await w.packs.undo(r.id, res.entryId!);
    expect((await readdir(join(r.path, "minecraft/mods"))).sort()).toEqual(["fabric-api-0.116.17+1.21.1.jar", "xaerominimap-fabric-1.21.1-26.6.0.jar.disabled"]);
  });

  it("writes a valid config, refuses an invalid one without touching the file, and undoes (CFG-1/2)", async () => {
    const { w, r } = await withMods();
    await writeFile(join(r.path, "minecraft/options.txt"), "renderDistance:12\nparticles:0\n");
    const res = await w.packs.writeConfig(r.id, "minecraft/options.txt", "renderDistance:8\nparticles:2\n", { reason: "Lower render distance" });
    expect(res).toMatchObject({ validated: true, entry: { action: "write", reason: "Lower render distance" } });
    await expect(w.packs.writeConfig(r.id, "minecraft/options.txt", "renderDistance = 4")).rejects.toMatchObject({ code: "invalid-config" });
    expect(await readFile(join(r.path, "minecraft/options.txt"), "utf8")).toBe("renderDistance:8\nparticles:2\n");
    await w.packs.undo(r.id, res.entry.id);
    expect(await readFile(join(r.path, "minecraft/options.txt"), "utf8")).toBe("renderDistance:12\nparticles:0\n");

    const created = await w.packs.writeConfig(r.id, "minecraft/config/new-mod.toml", "[client]\nfast = true\n");
    await w.packs.undo(r.id, created.entry.id);
    expect(await exists(join(r.path, "minecraft/config/new-mod.toml"))).toBe(false);
  });

  it("only writes config files in the game folder: not jars, worlds, or the instance's own files", async () => {
    const { w, r } = await withMods();
    for (const [path, code] of [
      [".packsmith-instance.json", "bad-path"], ["mmc-pack.json", "bad-path"], ["instance.cfg", "bad-path"],
      ["minecraft/saves/World/level.json", "bad-path"], ["minecraft/mods/evil.json", "bad-path"],
      ["minecraft/kubejs/startup.js", "unsupported-format"], ["minecraft/../../escape.txt", "bad-path"],
    ] as const) {
      await expect(w.packs.writeConfig(r.id, path, "{}"), path).rejects.toMatchObject({ code });
    }
    expect(await w.packs.history(r.id)).toHaveLength(1); // only the install
  });

  it("sets the loader in place on a vanilla pack and undoes it (set_loader); refuses a switch with mods", async () => {
    const w = await world({ prism: true });
    const r = await w.packs.create({ name: "Plain", mcVersion: "1.21.1", loader: "vanilla" });
    const res = await w.packs.setLoader(r.id, "neoforge");
    expect(res.loaderVersion).toBe("21.1.265");
    expect(JSON.parse(await readFile(join(r.path, "mmc-pack.json"), "utf8")).components.map((c: { uid: string }) => c.uid)).toEqual(["net.minecraft", "net.neoforged"]);
    expect(JSON.parse(await readFile(join(r.path, ".packsmith-instance.json"), "utf8"))).toMatchObject({ loader: "neoforge", loaderVersion: "21.1.265" });
    expect((await w.packs.list()).find((x) => x.id === r.id)).toMatchObject({ loader: "neoforge", loaderVersion: "21.1.265" });
    await w.packs.undo(r.id, res.entry.id);
    expect((await w.packs.list()).find((x) => x.id === r.id)).toMatchObject({ loader: "vanilla" });
    expect(JSON.parse(await readFile(join(r.path, "mmc-pack.json"), "utf8")).components).toHaveLength(1);

    const { w: w2, r: modded } = await withMods();
    await expect(w2.packs.setLoader(modded.id, "neoforge")).rejects.toThrow('"Edit" has 2 mods made for Fabric. Remove them first, or make a new pack for NeoForge.');
  });

  it("rolls back a change interrupted by a crash on the next start", async () => {
    const { w, r } = await withMods();
    await writeFile(join(r.path, "minecraft/options.txt"), "renderDistance:12\n");
    const before = await w.packs.history(r.id);
    // Simulate the crash: write an "open" entry the way the journal does, with the file half changed.
    const journal = new Journal(w.dataDir);
    const rec = (await w.packs.list()).find((x) => x.id === r.id)!;
    void journal.record(rec, { action: "write", reason: "crash" }, ["minecraft/options.txt"], async (abs) => {
      await writeFile(abs.get("minecraft/options.txt")!, "garbage");
      await new Promise(() => undefined);
    });
    await new Promise((res) => setTimeout(res, 100));
    const next = w.make(); // packsmith starts again
    expect(await next.recoverAll()).toBe(1);
    expect(await readFile(join(r.path, "minecraft/options.txt"), "utf8")).toBe("renderDistance:12\n");
    const after = await next.history(r.id);
    expect(after).toHaveLength(before.length + 1);
    expect(after[0]).toMatchObject({ reason: "crash", state: "rolled-back" });
  });
});
