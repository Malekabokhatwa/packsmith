// Milestone (d) done-check: quests. A scripted run makes two packs. In "Quest Trail" the user
// picks Heracles in the Quests tab (installed for real from Modrinth, QST-1: only on that pick);
// the agent's first chapter names a wrong item id and is refused with a "did you mean" (QST-3/4);
// the corrected chapter is written, shows in the Quests tab, its Edit button prefills the chat,
// and the write undoes from the Journal tab. "Book Test" holds an FTB Quests book packsmith didn't
// write: it is shown, read-only. Real Electron build on Xvfb, scripted model (8.2).
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";
import { clientJar, modJar } from "../test/support/fakeJars";

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
const TRAIL = () => join(prismRoot, "instances/packsmith-1.21.1-quest-trail");
const BOOK = () => join(prismRoot, "instances/packsmith-1.21.1-book-test");
const consoleErrors: string[] = [];
const nav = (name: string) => win.getByRole("navigation", { name: "Main" }).getByRole("button", { name });

test.beforeAll(async () => {
  const userData = await mkdtemp(join(tmpdir(), "ps-e2e-d-data-"));
  prismRoot = await mkdtemp(join(tmpdir(), "ps-e2e-d-prism-"));
  await writeFile(join(prismRoot, "prismlauncher.cfg"), "[General]\nInstanceDir=instances\n");
  decoy = join(prismRoot, "instances/My Survival");
  await mkdir(join(decoy, "minecraft/config/heracles"), { recursive: true });
  await writeFile(join(decoy, "instance.cfg"), "[General]\nname=My Survival\n");
  await writeFile(join(decoy, "minecraft/config/heracles/groups.txt"), "Their Quests\n");
  decoyBefore = await snapshot(decoy);
  // Stand-in for Minecraft's client jar where Prism keeps it (vanilla ids, advancement shapes).
  const libs = join(prismRoot, "libraries/com/mojang/minecraft/1.21.1");
  await mkdir(libs, { recursive: true });
  await writeFile(join(libs, "minecraft-1.21.1-client.jar"), clientJar("1.21"));
  await writeFile(join(userData, "settings.json"), JSON.stringify({ launcher: { kind: "prism", root: prismRoot, prismWriteAllowed: true } }));
  await mkdir(SHOTS, { recursive: true });
  app = await electron.launch({
    args: [join(__dirname, "../out/main/index.js")],
    env: { ...process.env, PACKSMITH_USER_DATA: userData, PACKSMITH_PRISM_ROOT: prismRoot, PACKSMITH_FAKE_PROVIDER: join(__dirname, "fixtures/agent-script-d.json") },
  });
  win = await app.firstWindow();
  win.on("console", (m) => { if (m.type() === "error" && !m.location().url.startsWith("psicon:")) consoleErrors.push(m.text()); });
  win.on("pageerror", (e) => consoleErrors.push(String(e)));
  await win.setViewportSize({ width: 1440, height: 900 });
});

test.afterAll(async () => { await app?.close(); });

test("the agent makes two packs; one gets an FTB Quests book it didn't write", async () => {
  await win.getByLabel("Describe a pack").fill("Make me two small Fabric 1.21.1 packs");
  await win.keyboard.press("Enter");
  await expect(win.getByText("Made Quest Trail and Book Test.")).toBeVisible({ timeout: 60_000 });
  // As if the player had added FTB Quests and its book by hand.
  await writeFile(join(BOOK(), "minecraft/mods/ftbquests.jar"), modJar("ftbquests", [], { neoforge: true }));
  const q = join(BOOK(), "minecraft/config/ftbquests/quests");
  await mkdir(join(q, "chapters"), { recursive: true });
  await mkdir(join(q, "lang"), { recursive: true });
  await writeFile(join(q, "chapters/start.snbt"), '{\n\tid: "C1"\n\torder_index: 0\n\tquests: [\n\t\t{\n\t\t\tid: "Q1"\n\t\t\ttasks: [{ id: "T1", item: { count: 1, id: "minecraft:oak_log" }, type: "item", count: 16L }]\n\t\t}\n\t\t{\n\t\t\tdependencies: ["Q1"]\n\t\t\tid: "Q2"\n\t\t\ttasks: [{ id: "T2", type: "checkmark" }]\n\t\t}\n\t]\n}\n');
  await writeFile(join(q, "lang/en_us.snbt"), '{\n\tchapter.C1.title: "Their Welcome"\n\tquest.Q2.title: "Read the Rules"\n}\n');
});

test("the Quests tab of a pack with no engine offers one; picking Heracles adds it from Modrinth and prefills the chat", async () => {
  await nav("Packs").click();
  await win.getByRole("button", { name: /^Quest Trail/ }).click();
  await win.getByRole("tab", { name: "Quests" }).click();
  await expect(win.getByText("No quests in this pack.")).toBeVisible({ timeout: 30_000 });
  await expect(win.getByText("No quest engine yet")).toBeVisible();
  await win.getByRole("button", { name: "Create a quest line" }).click();
  const dialog = win.getByRole("dialog", { name: "Pick a quest engine" });
  await expect(dialog.getByText("FTB Quests isn't on Modrinth, so packsmith can't add it.")).toBeVisible({ timeout: 60_000 });
  await expect(dialog.getByRole("radio", { name: /^FTB Quests/ })).toBeDisabled();
  await expect(dialog.getByRole("radio", { name: /^Heracles/ })).toBeChecked(); // preselected: the engine packsmith can add
  await expect(dialog.getByText(/Adds Odyssey Quests/)).toBeVisible();
  await win.screenshot({ path: join(SHOTS, "S08-engine-picker.png") });
  await dialog.getByRole("button", { name: "Add Heracles" }).click();
  await expect(win.getByLabel("Describe a pack")).toHaveValue('Write a quest line for "Quest Trail" with Heracles: ', { timeout: 90_000 });
  const mods = (await readdir(join(TRAIL(), "minecraft/mods"))).join(" ");
  expect(mods).toMatch(/heracles/i);
  expect(mods).toMatch(/resourceful/i);
});

test("a wrong item id is refused with a 'did you mean'; the corrected chapter is written", async () => {
  await win.keyboard.type("a short starter chapter");
  await win.keyboard.press("Enter");
  await expect(win.getByText("They haven't been played in the game.")).toBeVisible({ timeout: 90_000 });
  const answer = win.getByRole("region", { name: "packsmith's answer" }).last();
  await answer.getByRole("button", { name: /steps/ }).click();
  await expect(answer.getByText(/Did you mean "minecraft:oak_log"\?/)).toBeVisible();
  await expect(answer.getByText("1 chapter, 4 quests")).toBeVisible();
  const night = JSON.parse(await readFile(join(TRAIL(), "minecraft/config/heracles/quests/getting_started/ps_getting_started_night.json"), "utf8"));
  expect(night.dependencies).toEqual(["ps_getting_started_bench", "ps_getting_started_bread"]);
  expect(await readFile(join(TRAIL(), "minecraft/config/heracles/groups.txt"), "utf8")).toBe("Getting Started\n");
});

test("the Quests tab shows the chapter, its map and a quest's detail; Edit prefills a new chat", async () => {
  await nav("Packs").click();
  await win.getByRole("button", { name: /^Quest Trail/ }).click();
  await win.getByRole("tab", { name: "Quests" }).click();
  await expect(win.getByRole("tab", { name: /Getting Started\s*4/ })).toBeVisible({ timeout: 30_000 });
  await expect(win.getByText("Quest engine: Heracles (in this pack)")).toBeVisible();
  const chapterPanel = win.getByRole("complementary", { name: "Chapter" });
  await expect(chapterPanel.getByText("Written here")).toBeVisible();
  await expect(chapterPanel.getByText("4 quests, 3 steps long.")).toBeVisible();
  await win.getByRole("list", { name: "Quests" }).getByRole("button", { name: /^First Night/ }).click();
  const detail = win.getByRole("complementary", { name: "Quest" });
  await expect(detail.getByText("Quest 4 of 4 · Getting Started")).toBeVisible();
  await expect(detail.getByText("Defeat Zombie")).toBeVisible();
  await expect(detail.getByText("Torch ×4")).toBeVisible();
  await expect(detail.getByRole("button", { name: "A Bench" })).toBeVisible();
  await expect(detail.getByRole("button", { name: "Bread" })).toBeVisible();
  await win.screenshot({ path: join(SHOTS, "S08-quests.png") });
  await detail.getByRole("button", { name: "Edit this quest" }).click();
  await expect(win.getByLabel("Describe a pack")).toHaveValue('In "Quest Trail", quest chapter "Getting Started", quest "First Night": ');
  await expect(win.getByRole("heading", { name: "What should we forge?" })).toBeVisible(); // a new chat
});

test("a book that came with the pack is shown read-only", async () => {
  await nav("Packs").click();
  await win.getByRole("button", { name: /^Book Test/ }).click();
  await win.getByRole("tab", { name: "Quests" }).click();
  await expect(win.getByRole("tab", { name: /Their Welcome\s*2/ })).toBeVisible({ timeout: 30_000 });
  await expect(win.getByText("Quest engine: FTB Quests (in this pack)")).toBeVisible();
  await expect(win.getByRole("list", { name: "Quests" }).getByText("Collect Oak Log ×16")).toBeVisible();
  await expect(win.getByRole("complementary", { name: "Chapter" }).getByText("Came with the pack")).toBeVisible();
  await expect(win.getByRole("button", { name: /^Edit/ })).toHaveCount(0);
  await win.getByRole("list", { name: "Quests" }).getByRole("button", { name: /^Read the Rules/ }).click();
  await expect(win.getByText("This chapter came with the pack, so packsmith only reads it.")).toBeVisible();
  await win.screenshot({ path: join(SHOTS, "S08-ftb-readonly.png") });
});

test("the quest write undoes from the Journal tab", async () => {
  await win.getByRole("button", { name: /^Quest Trail/ }).click();
  await win.getByRole("tab", { name: "Journal" }).click();
  const journal = win.getByRole("list", { name: "Journal" });
  await journal.getByRole("button", { name: 'Undo: Wrote the "Getting Started" chapter (Heracles)' }).click();
  await win.getByRole("dialog", { name: "Undo this change?" }).getByRole("button", { name: "Undo change" }).click();
  await expect(journal.getByRole("listitem").first()).toContainText("Undone");
  await win.getByRole("tab", { name: "Quests" }).click();
  await expect(win.getByText("No quests in this pack.")).toBeVisible({ timeout: 30_000 });
  await expect(win.getByText("Quest engine: Heracles (in this pack, no quests yet)")).toBeVisible();
  expect(await readdir(join(TRAIL(), "minecraft/config/heracles/quests/getting_started"))).toEqual([]);
});

test("the decoy Prism instance is unchanged, byte for byte (AC-12)", async () => {
  expect(await snapshot(decoy)).toEqual(decoyBefore);
});

test("no console errors", async () => { expect(consoleErrors).toEqual([]); });
