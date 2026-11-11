// Milestone (g) done-check, AC-13 (SPEC 11.4): adopt a seeded vanilla Prism instance from the Packs
// screen (read-only until Manage), add a loader in place plus one mod through the agent, verify the
// world is intact, roll both back from the Journal byte for byte, then stop managing it: the agent's
// next write is refused and nothing changes. A decoy instance never changes. Real Electron build on
// Xvfb, real Modrinth, scripted model.
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";
import { FABRIC_API_JAR } from "./upstream";

const SHOTS = join(__dirname, "../replica/clone-screens");
test.describe.configure({ mode: "serial" });

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

let app: ElectronApplication;
let win: Page;
let prismRoot: string;
let vanilla: string, decoy: string;
let vanillaBefore: Record<string, string>, decoyBefore: Record<string, string>;
const consoleErrors: string[] = [];
const PACK_JSON = JSON.stringify({ formatVersion: 1, components: [{ uid: "org.lwjgl3", version: "3.3.3" }, { uid: "net.minecraft", version: "1.21.1", important: true }] }, null, 4);

test.beforeAll(async () => {
  const userData = await mkdtemp(join(tmpdir(), "ps-e2e-g-data-"));
  prismRoot = await mkdtemp(join(tmpdir(), "ps-e2e-g-prism-"));
  await writeFile(join(prismRoot, "prismlauncher.cfg"), "[General]\nInstanceDir=instances\n");
  vanilla = join(prismRoot, "instances/Vanilla World");
  await mkdir(join(vanilla, "minecraft/saves/Home/region"), { recursive: true });
  await writeFile(join(vanilla, "instance.cfg"), "[General]\nname=Vanilla World\n");
  await writeFile(join(vanilla, "mmc-pack.json"), PACK_JSON);
  await writeFile(join(vanilla, "minecraft/options.txt"), "renderDistance:12\n");
  await writeFile(join(vanilla, "minecraft/saves/Home/level.dat"), "a world someone loves");
  await writeFile(join(vanilla, "minecraft/saves/Home/region/r.0.0.mca"), "chunks");
  decoy = join(prismRoot, "instances/My Survival");
  await mkdir(join(decoy, "minecraft/mods"), { recursive: true });
  await writeFile(join(decoy, "instance.cfg"), "[General]\nname=My Survival\n");
  await writeFile(join(decoy, "mmc-pack.json"), JSON.stringify({ formatVersion: 1, components: [{ uid: "net.minecraft", version: "1.21.1" }, { uid: "net.fabricmc.fabric-loader", version: "0.16.14" }] }));
  await writeFile(join(decoy, "minecraft/mods/theirs.jar"), "their jar");
  vanillaBefore = await snapshot(vanilla);
  decoyBefore = await snapshot(decoy);
  await writeFile(join(userData, "settings.json"), JSON.stringify({ launcher: { kind: "prism", root: prismRoot, prismWriteAllowed: true } }));
  await mkdir(SHOTS, { recursive: true });
  app = await electron.launch({
    args: [join(__dirname, "../out/main/index.js")],
    env: { ...process.env, PACKSMITH_USER_DATA: userData, PACKSMITH_PRISM_ROOT: prismRoot, PACKSMITH_FAKE_PROVIDER: join(__dirname, "fixtures/agent-script-g.json") },
  });
  win = await app.firstWindow();
  win.on("console", (m) => { if (m.type() === "error" && !m.location().url.startsWith("psicon:")) consoleErrors.push(m.text()); });
  win.on("pageerror", (e) => consoleErrors.push(String(e)));
  await win.setViewportSize({ width: 1440, height: 900 });
});

test.afterAll(async () => { await app?.close(); });

const packsList = () => win.getByRole("complementary", { name: "Packs list" });

test("the user's Prism instances are listed read-only (ADP-1), names and versions only", async () => {
  await win.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Packs" }).click();
  await expect(packsList().getByText("Found in Prism (read-only)")).toBeVisible();
  await packsList().getByRole("button", { name: /Vanilla World/ }).click();
  await expect(win.getByRole("heading", { name: "Vanilla World" })).toBeVisible();
  await expect(win.getByText("No mod loader · Minecraft 1.21.1 · 0 files in mods")).toBeVisible();
  await expect(win.getByText(/only reading this instance's name and versions/)).toBeVisible();
  await win.screenshot({ path: join(SHOTS, "S05-found.png") });
  expect(await snapshot(vanilla)).toEqual(vanillaBefore);
});

test("Manage asks what packsmith may change, then the instance moves to Managed (ADP-2)", async () => {
  await win.getByRole("button", { name: "Manage this instance…" }).click();
  const dialog = win.getByRole("dialog", { name: "Let packsmith change Vanilla World?" });
  await expect(dialog.getByRole("checkbox", { name: /Mod loader/ })).toBeChecked(); // offered: it's vanilla
  await expect(dialog.getByRole("checkbox", { name: /Quests/ })).not.toBeChecked();
  await win.screenshot({ path: join(SHOTS, "S05-manage-dialog.png") });
  await dialog.getByRole("button", { name: "Allow selected changes" }).click();
  await expect(dialog).toBeHidden();
  await expect(packsList().getByText("Managed")).toBeVisible();
  await expect(win.getByText("Managed: packsmith may change mods, configs, game settings, the mod loader. Worlds never.")).toBeVisible();
  await expect(win.getByRole("button", { name: "Stop managing" })).toBeVisible();
  expect(await snapshot(vanilla)).toEqual(vanillaBefore); // adopting writes nothing into the instance
});

test("the agent adds Fabric in place and a mod; the world is intact (ADP-4, AC-13)", async () => {
  await win.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Forge" }).click();
  await win.getByLabel("Describe a pack").fill("Add Fabric and a minimap to my Vanilla World instance");
  await win.keyboard.press("Enter");
  await expect(win.getByText("now runs Fabric with Xaero's Minimap.")).toBeVisible({ timeout: 90_000 });
  const pack = JSON.parse(await readFile(join(vanilla, "mmc-pack.json"), "utf8")) as { components: Array<{ uid: string }> };
  expect(pack.components.map((c) => c.uid)).toEqual(["org.lwjgl3", "net.minecraft", "net.fabricmc.fabric-loader"]);
  expect((await readdir(join(vanilla, "minecraft/mods"))).sort()).toEqual([expect.stringMatching(FABRIC_API_JAR), "xaerominimap-fabric-1.21.1-26.6.0.jar"]);
  const now = await snapshot(vanilla);
  for (const k of Object.keys(vanillaBefore).filter((k) => k.includes("saves/"))) expect(now[k]).toBe(vanillaBefore[k]);
});

test("both changes undo from the Journal and the instance is back byte for byte (AC-13)", async () => {
  await win.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Packs" }).click();
  await packsList().getByRole("button", { name: /Vanilla World/ }).click();
  await win.getByRole("tab", { name: "Journal" }).click();
  const journal = win.getByRole("list", { name: "Journal" });
  await expect(journal.getByRole("listitem")).toHaveCount(2);
  await win.screenshot({ path: join(SHOTS, "S05-managed.png") });
  for (let i = 0; i < 2; i++) {
    await journal.getByRole("listitem").nth(i).getByRole("button", { name: /Undo/ }).click();
    await win.getByRole("dialog").getByRole("button", { name: "Undo change" }).click();
    await expect(win.getByRole("dialog")).toBeHidden();
  }
  await expect(journal.getByText("Undone")).toHaveCount(2);
  const after = await snapshot(vanilla);
  expect(after).toEqual(vanillaBefore);
});

test("Stop managing hands it back: the agent's next write is refused and nothing changes", async () => {
  await win.getByRole("button", { name: "Stop managing" }).click();
  await win.getByRole("dialog").getByRole("button", { name: "Stop managing" }).click();
  await expect(packsList().getByText("Managed")).toHaveCount(0);
  await expect(packsList().getByRole("button", { name: /Vanilla World/ })).toBeVisible(); // back under Found
  await win.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Forge" }).click();
  await win.getByRole("button", { name: "New chat" }).click();
  await win.getByLabel("Describe a pack").fill("Lower the render distance in Vanilla World");
  await win.keyboard.press("Enter");
  await expect(win.getByText("packsmith no longer manages it.")).toBeVisible({ timeout: 60_000 });
  expect(await snapshot(vanilla)).toEqual(vanillaBefore);
});

test("the decoy never changed and the renderer logged no errors", async () => {
  expect(await snapshot(decoy)).toEqual(decoyBefore);
  expect(consoleErrors).toEqual([]);
});
