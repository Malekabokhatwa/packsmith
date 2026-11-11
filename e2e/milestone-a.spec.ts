// Milestone (a) done-check (SPEC 12): a one-mod pack installs into a scratch Prism instance and
// appears in the Installed tab. Drives the real Electron build on Xvfb (npm run e2e) against the
// real Modrinth API, with a throwaway data folder and a throwaway Prism root holding a decoy
// instance that must not change by a single byte (AC-12).
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";

const SHOTS = join(__dirname, "../replica/clone-screens");
// The tests share one app; after a failure the rest are skipped, not re-run against fresh state.
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
let decoy: string;
let decoyBefore: Record<string, string>;
const consoleErrors: string[] = [];
const mainLog: string[] = [];

test.beforeAll(async () => {
  const userData = await mkdtemp(join(tmpdir(), "ps-e2e-data-"));
  prismRoot = await mkdtemp(join(tmpdir(), "ps-e2e-prism-"));
  await writeFile(join(prismRoot, "prismlauncher.cfg"), "[General]\nInstanceDir=instances\n");
  decoy = join(prismRoot, "instances/My Survival");
  await mkdir(join(decoy, "minecraft/mods"), { recursive: true });
  await writeFile(join(decoy, "instance.cfg"), "[General]\nname=My Survival\n");
  await writeFile(join(decoy, "minecraft/mods/theirs.jar"), "their jar");
  await writeFile(join(prismRoot, "instances/instgroups.json"), JSON.stringify({ formatVersion: "1", groups: { Fav: { hidden: false, instances: ["My Survival"] } } }));
  decoyBefore = await snapshot(join(prismRoot, "instances"));
  delete decoyBefore["instgroups.json"]; // the group file may change, but only by adding ours (checked below)

  await mkdir(SHOTS, { recursive: true });
  app = await electron.launch({
    args: [join(__dirname, "../out/main/index.js")],
    env: { ...process.env, PACKSMITH_USER_DATA: userData, PACKSMITH_PRISM_ROOT: prismRoot },
  });
  app.process().stdout?.on("data", (d) => mainLog.push(String(d)));
  app.process().stderr?.on("data", (d) => mainLog.push(String(d)));
  win = await app.firstWindow();
  win.on("console", (m) => {
    // A project icon that fails to load over the network is expected degradation: the UI shows
    // initials instead. Every other console error fails the run (see the last test).
    if (m.type() === "error" && !m.location().url.startsWith("psicon:")) consoleErrors.push(m.text());
  });
  win.on("pageerror", (e) => consoleErrors.push(String(e)));
  await win.setViewportSize({ width: 1440, height: 900 });
});

test.afterAll(async () => {
  await app?.close();
});

test("first run: the Packs screen is empty", async () => {
  await win.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Packs" }).click();
  await expect(win.getByText("No packs yet. Make one, then add mods from Modrinth.")).toBeVisible();
  await win.screenshot({ path: join(SHOTS, "S05-empty.png") });
});

test("Settings: choose Prism and grant the one-time permission (INS-2)", async () => {
  await win.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Settings" }).click();
  await win.getByRole("radio", { name: /Prism Launcher/ }).check();
  await expect(win.getByLabel("Prism folder")).toHaveValue(prismRoot);
  await win.getByRole("checkbox", { name: /create new instances in Prism/ }).check();
  await win.screenshot({ path: join(SHOTS, "S10.png") });
  await win.getByRole("button", { name: "Save", exact: true }).click();
  await expect(win.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
});

test("create a Fabric 1.21.1 pack in Prism, using only the keyboard in the dialog", async () => {
  await win.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Packs" }).click();
  await win.getByRole("button", { name: "New pack" }).first().click();
  const dialog = win.getByRole("dialog", { name: "New pack" });
  await expect(dialog.getByText('It goes into Prism Launcher, in its "packsmith" group.')).toBeVisible();
  await expect(dialog.getByLabel("Minecraft version")).toBeEnabled({ timeout: 30_000 });
  await dialog.getByLabel("Minecraft version").selectOption("1.21.1");
  await dialog.getByLabel("Name").focus();
  await win.keyboard.type("Cozy E2E");
  await win.screenshot({ path: join(SHOTS, "S05-new-pack.png") });
  await win.keyboard.press("Enter");
  await expect(dialog).toBeHidden({ timeout: 30_000 });
  await expect(win.getByRole("heading", { name: "Cozy E2E" })).toBeVisible();
  await expect(win.getByText("No mods in this pack yet.")).toBeVisible({ timeout: 30_000 });
});

test("add one mod from Modrinth; the library it needs comes along; adding that library again changes nothing", async () => {
  test.setTimeout(240_000);
  await win.getByRole("button", { name: "Add mods" }).first().click();
  const panel = win.getByRole("complementary", { name: "Add mods" });
  await panel.getByLabel("Search Modrinth").fill("xaero's minimap");
  await panel.getByRole("button", { name: "Add Xaero's Minimap", exact: true }).click({ timeout: 30_000 });
  // A real download: Modrinth's CDN served an uncached 2 MB jar in 34 s on 2026-11-10 (0.9 s once cached).
  await expect(win.getByText("Added Xaero's Minimap, plus Fabric API it needs.", { exact: true })).toBeVisible({ timeout: 180_000 });
  await panel.getByLabel("Search Modrinth").fill("fabric api");
  await panel.getByRole("button", { name: "Add Fabric API", exact: true }).click({ timeout: 30_000 });
  await expect(win.getByText("Fabric API is already in this pack.", { exact: true })).toBeVisible({ timeout: 60_000 });
  await win.screenshot({ path: join(SHOTS, "S06-add-panel.png") });
});

test("the Installed list shows both mods, matched on Modrinth, with real counts", async () => {
  await win.getByRole("complementary", { name: "Add mods" }).getByRole("button", { name: "Close" }).click();
  const list = win.getByRole("tabpanel");
  await expect(list.getByText("Xaero's Minimap", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(list.getByText("Fabric API", { exact: true })).toBeVisible();
  await expect(win.getByText("Fabric · Minecraft 1.21.1 · 2 mods")).toBeVisible();
  await expect(win.getByRole("tab", { name: /Mods\s*2/ })).toBeVisible();
  await win.screenshot({ path: join(SHOTS, "S06.png") });
});

test("on disk: a marked Prism instance with verified jars, the group added, the decoy untouched (AC-12)", async () => {
  const dir = join(prismRoot, "instances/packsmith-1.21.1-cozy-e2e");
  const marker = JSON.parse(await readFile(join(dir, ".packsmith-instance.json"), "utf8"));
  expect(marker).toMatchObject({ createdBy: "packsmith", instanceId: "packsmith-1.21.1-cozy-e2e", loader: "fabric", mcVersion: "1.21.1" });
  const pack = JSON.parse(await readFile(join(dir, "mmc-pack.json"), "utf8"));
  expect(pack.components.map((c: { uid: string }) => c.uid)).toEqual(["net.minecraft", "net.fabricmc.fabric-loader"]);
  const mods = (await readdir(join(dir, "minecraft/mods"))).sort();
  expect(mods).toHaveLength(2);
  expect(mods.every((m) => m.endsWith(".jar"))).toBe(true);
  const groups = JSON.parse(await readFile(join(prismRoot, "instances/instgroups.json"), "utf8"));
  expect(groups.groups.Fav).toEqual({ hidden: false, instances: ["My Survival"] });
  expect(groups.groups.packsmith.instances).toEqual(["packsmith-1.21.1-cozy-e2e"]);
  const after = await snapshot(join(prismRoot, "instances"));
  for (const [k, v] of Object.entries(decoyBefore)) expect(after[k], k).toBe(v);
});

test("a narrow, tiled window (941 px) shows everything; the add panel slides over the list", async () => {
  // 1) The window itself accepts the tiled width (at the old 1024 minimum, Hyprland cropped it).
  const size = await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]!; w.setSize(941, 900); return w.getSize(); });
  expect(size[0]).toBe(941);
  // 2) The layout fits that width with no horizontal overflow.
  await win.setViewportSize({ width: 941, height: 900 });
  await win.waitForTimeout(300);
  expect(await win.evaluate(() => [window.innerWidth, document.documentElement.scrollWidth])).toEqual([941, 941]);
  await win.getByRole("button", { name: "Add mods" }).first().click();
  const panel = win.getByRole("complementary", { name: "Add mods" });
  const box = (await panel.boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(941);
  expect(await panel.evaluate((el) => getComputedStyle(el).position)).toBe("absolute");
  await win.screenshot({ path: join(SHOTS, "S06-narrow.png") });
  await panel.getByRole("button", { name: "Close" }).click();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1440, 900));
  await win.setViewportSize({ width: 1440, height: 900 });
});

test("no console errors during the whole run, and no icon refused by packsmith's own checks", async () => {
  expect(consoleErrors, `main process log:\n${mainLog.join("")}`).toEqual([]);
  expect(mainLog.join("")).not.toContain("[icons] refused");
});
