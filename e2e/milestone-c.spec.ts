// Milestone (c) done-check (SPEC 12c, CLAUDE.md): a scripted run proposes a plan; on "Forge it"
// it installs a mod whose library is resolved automatically, then edits a config; the edit is
// rolled back from the Journal tab; a removal is undone from the toast; a decoy Prism instance
// doesn't change by a byte. Real Electron build on Xvfb, real Modrinth, scripted model (8.2).
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";
import { FABRIC_API_JAR, FABRIC_API_JAR_OFF } from "./upstream";

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
let decoy: string;
let decoyBefore: Record<string, string>;
const PACK = () => join(prismRoot, "instances/packsmith-1.21.1-trail-test");
const consoleErrors: string[] = [];

test.beforeAll(async () => {
  const userData = await mkdtemp(join(tmpdir(), "ps-e2e-c-data-"));
  prismRoot = await mkdtemp(join(tmpdir(), "ps-e2e-c-prism-"));
  await writeFile(join(prismRoot, "prismlauncher.cfg"), "[General]\nInstanceDir=instances\n");
  decoy = join(prismRoot, "instances/My Survival");
  await mkdir(join(decoy, "minecraft/mods"), { recursive: true });
  await mkdir(join(decoy, "minecraft/config"), { recursive: true });
  await writeFile(join(decoy, "instance.cfg"), "[General]\nname=My Survival\n");
  await writeFile(join(decoy, "minecraft/mods/theirs.jar"), "their jar");
  await writeFile(join(decoy, "minecraft/options.txt"), "renderDistance:32\n");
  decoyBefore = await snapshot(decoy);
  await writeFile(join(userData, "settings.json"), JSON.stringify({ launcher: { kind: "prism", root: prismRoot, prismWriteAllowed: true } }));
  await mkdir(SHOTS, { recursive: true });
  app = await electron.launch({
    args: [join(__dirname, "../out/main/index.js")],
    env: { ...process.env, PACKSMITH_USER_DATA: userData, PACKSMITH_PRISM_ROOT: prismRoot, PACKSMITH_FAKE_PROVIDER: join(__dirname, "fixtures/agent-script-c.json") },
  });
  win = await app.firstWindow();
  win.on("console", (m) => { if (m.type() === "error" && !m.location().url.startsWith("psicon:")) consoleErrors.push(m.text()); });
  win.on("pageerror", (e) => consoleErrors.push(String(e)));
  await win.setViewportSize({ width: 1440, height: 900 });
});

test.afterAll(async () => { await app?.close(); });

test("a request gets a resolved plan card first; nothing is built yet", async () => {
  await win.getByLabel("Describe a pack").fill("A small Fabric 1.21.1 pack with a minimap");
  await win.keyboard.press("Enter");
  const plan = win.getByRole("region", { name: "Plan: Trail Test" });
  await expect(plan).toBeVisible({ timeout: 60_000 });
  await expect(plan.getByText("A minimap in the corner, with waypoints.")).toBeVisible();
  await expect(plan.getByText("Needed by Xaero's Minimap.")).toBeVisible(); // Fabric API, resolved from Modrinth
  await expect(plan.getByText(/^2 files to download · /)).toBeVisible();
  await expect(win.getByText("Press Forge it to build this, or tell me what to change.")).toBeVisible();
  await expect(plan.getByRole("button", { name: "Forge it" })).toBeVisible();
  expect(await readdir(join(prismRoot, "instances"))).toEqual(["My Survival"]);
  await win.screenshot({ path: join(SHOTS, "S04-plan.png") });
});

test("Forge it builds the plan: the mod with its library, then a checked config edit", async () => {
  await win.getByRole("region", { name: "Plan: Trail Test" }).getByRole("button", { name: "Forge it" }).click();
  await expect(win.getByText("is built: Fabric, Minecraft 1.21.1.")).toBeVisible({ timeout: 90_000 });
  // The old plan card stays as a record but can't be answered again.
  await expect(win.getByRole("button", { name: "Forge it" })).toHaveCount(0);
  const answer = win.getByRole("region", { name: "packsmith's answer" }).last();
  await answer.getByRole("button", { name: /steps/ }).click();
  const feed = answer.getByRole("list", { name: "Activity" });
  await expect(feed.getByText("Xaero's Minimap fabric-1.21.1-26.6.0 + Fabric API")).toBeVisible();
  await expect(feed.getByText(/isn't valid options\.txt\. Line 1 isn't key:value/)).toBeVisible(); // refused, not written
  await win.screenshot({ path: join(SHOTS, "S04-built.png") });
  const mods = (await readdir(join(PACK(), "minecraft/mods"))).sort();
  expect(mods).toEqual([expect.stringMatching(FABRIC_API_JAR), "xaerominimap-fabric-1.21.1-26.6.0.jar"]);
  expect(await readFile(join(PACK(), "minecraft/options.txt"), "utf8")).toBe("renderDistance:8\nparticles:2\n");
});

test("the Journal tab lists every change; undoing the config edit puts the old file back", async () => {
  await win.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Packs" }).click();
  await expect(win.getByRole("heading", { name: "Trail Test" })).toBeVisible();
  await win.getByRole("tab", { name: "Journal" }).click();
  const journal = win.getByRole("list", { name: "Journal" });
  await expect(journal.getByRole("listitem")).toHaveCount(3);
  await expect(journal.getByRole("listitem").nth(0)).toContainText("Lower the render distance");
  await expect(journal.getByRole("listitem").nth(2)).toContainText("Added Xaero's Minimap, plus Fabric API");
  await win.screenshot({ path: join(SHOTS, "S05-journal.png") });

  // Undoing the older edit first would lose the newer one: refused, with the reason, nothing touched.
  await journal.getByRole("button", { name: "Undo: Start with a far view" }).click();
  const dialog = win.getByRole("dialog", { name: "Undo this change?" });
  await dialog.getByRole("button", { name: "Undo change" }).click();
  await expect(dialog.getByRole("alert")).toContainText("minecraft/options.txt changed after this step");
  await win.screenshot({ path: join(SHOTS, "S05-undo-refused.png") });
  await dialog.getByRole("button", { name: "Cancel" }).click();
  expect(await readFile(join(PACK(), "minecraft/options.txt"), "utf8")).toBe("renderDistance:8\nparticles:2\n");

  await journal.getByRole("button", { name: "Undo: Lower the render distance" }).click();
  await expect(dialog.getByText("minecraft/options.txt")).toBeVisible();
  await win.screenshot({ path: join(SHOTS, "S05-undo-confirm.png") });
  await dialog.getByRole("button", { name: "Undo change" }).click();
  await expect(dialog).toBeHidden();
  await expect(journal.getByRole("listitem").nth(0)).toContainText("Undone");
  expect(await readFile(join(PACK(), "minecraft/options.txt"), "utf8")).toBe("renderDistance:12\nparticles:0\n");
});

test("remove a mod from its row, then undo it from the toast; turn a library off", async () => {
  await win.getByRole("tab", { name: /Mods/ }).click();
  const row = win.getByRole("listitem").filter({ hasText: "Xaero's Minimap" });
  await row.hover();
  await row.getByRole("button", { name: "Remove Xaero's Minimap" }).click();
  const toast = win.getByRole("status").filter({ hasText: "Removed Xaero's Minimap." });
  await expect(toast).toBeVisible({ timeout: 30_000 });
  await expect(win.getByRole("tab", { name: /Mods\s*1/ })).toBeVisible();
  await win.screenshot({ path: join(SHOTS, "S06-removed-toast.png") });
  await toast.getByRole("button", { name: "Undo" }).click();
  await expect(win.getByRole("tab", { name: /Mods\s*2/ })).toBeVisible({ timeout: 30_000 });
  expect((await readdir(join(PACK(), "minecraft/mods"))).sort()).toEqual([expect.stringMatching(FABRIC_API_JAR), "xaerominimap-fabric-1.21.1-26.6.0.jar"]);

  const lib = win.getByRole("listitem").filter({ hasText: "Fabric API" });
  await lib.getByRole("switch", { name: "Turn off Fabric API" }).click();
  await expect(win.getByRole("status").filter({ hasText: "Turned off Fabric API." })).toBeVisible({ timeout: 30_000 });
  await expect(lib.getByText("Off", { exact: true })).toBeVisible();
  await expect(lib.getByRole("switch", { name: "Turn on Fabric API" })).toHaveAttribute("aria-checked", "false");
  expect((await readdir(join(PACK(), "minecraft/mods"))).sort()).toEqual([expect.stringMatching(FABRIC_API_JAR_OFF), "xaerominimap-fabric-1.21.1-26.6.0.jar"]);
  await lib.hover();
  await win.screenshot({ path: join(SHOTS, "S06-actions.png") });
  await win.getByRole("tab", { name: "Journal" }).click();
  await expect(win.getByRole("list", { name: "Journal" }).getByRole("listitem").first()).toContainText("Turned off Fabric API");
  await win.getByRole("tab", { name: /Mods/ }).click();
});

test("the New pack dialog offers Fabric, NeoForge, Forge and none", async () => {
  await win.getByRole("button", { name: "New pack" }).first().click();
  const dialog = win.getByRole("dialog", { name: "New pack" });
  for (const name of [/^Fabric/, /^NeoForge/, /^Forge/, /^None/]) await expect(dialog.getByRole("radio", { name })).toBeVisible();
  await win.screenshot({ path: join(SHOTS, "S05-new-pack-loaders.png") });
  await win.keyboard.press("Escape");
});

test("the decoy Prism instance is unchanged, byte for byte (AC-12)", async () => {
  expect(await snapshot(decoy)).toEqual(decoyBefore);
});

test("no console errors", async () => { expect(consoleErrors).toEqual([]); });
