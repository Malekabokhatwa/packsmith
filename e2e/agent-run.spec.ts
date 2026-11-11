// Milestone (b) done-check (SPEC 12): "a typed goal produces a real multi-step run with
// narration". A scripted provider stands in for the model (spec 8.2: no live provider calls in
// tests); the tools are real: real Modrinth, real downloads, a scratch Prism root with a decoy.
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FABRIC_API_JAR } from "./upstream";

const SHOTS = join(__dirname, "../replica/clone-screens");
// The tests share one app and one run; after a failure the rest are skipped, not re-run fresh.
test.describe.configure({ mode: "serial" });
let app: ElectronApplication;
let win: Page;
let prismRoot: string;
let userData: string;
const consoleErrors: string[] = [];

test.beforeAll(async () => {
  userData = await mkdtemp(join(tmpdir(), "ps-e2e-agent-data-"));
  prismRoot = await mkdtemp(join(tmpdir(), "ps-e2e-agent-prism-"));
  await writeFile(join(prismRoot, "prismlauncher.cfg"), "[General]\nInstanceDir=instances\n");
  await mkdir(join(prismRoot, "instances"), { recursive: true });
  // Prism mode with permission, set up as a user would have it after Settings.
  await writeFile(join(userData, "settings.json"), JSON.stringify({ launcher: { kind: "prism", root: prismRoot, prismWriteAllowed: true } }));
  await mkdir(SHOTS, { recursive: true });
  app = await electron.launch({
    args: [join(__dirname, "../out/main/index.js")],
    env: { ...process.env, PACKSMITH_USER_DATA: userData, PACKSMITH_PRISM_ROOT: prismRoot, PACKSMITH_FAKE_PROVIDER: join(__dirname, "fixtures/agent-script.json") },
  });
  win = await app.firstWindow();
  win.on("console", (m) => { if (m.type() === "error" && !m.location().url.startsWith("psicon:")) consoleErrors.push(m.text()); });
  win.on("pageerror", (e) => consoleErrors.push(String(e)));
  await win.setViewportSize({ width: 1440, height: 900 });
});

test.afterAll(async () => { await app?.close(); });

test("Forge opens empty, with prompt chips that fill the composer", async () => {
  await expect(win.getByRole("heading", { name: "What should we forge?" })).toBeVisible();
  await win.getByRole("button", { name: "A cozy farming pack for 1.21.1 with a minimap" }).click();
  await expect(win.getByLabel("Describe a pack")).toHaveValue("A cozy farming pack for 1.21.1 with a minimap");
  await win.screenshot({ path: join(SHOTS, "S01.png") });
});

test("a typed goal runs to the end with live narration, step by step", async () => {
  await win.getByLabel("Describe a pack").fill("A small Fabric 1.21.1 pack with a minimap");
  await win.keyboard.press("Enter");
  const feed = win.getByRole("list", { name: "Activity" });
  await expect(feed.getByText("Searching Modrinth")).toBeVisible({ timeout: 30_000 });
  await expect(win.getByRole("button", { name: "Stop" })).toBeVisible();
  await expect(feed.getByText("Creating the pack")).toBeVisible({ timeout: 30_000 });
  await win.screenshot({ path: join(SHOTS, "S04-running.png") });
  await expect(win.getByText("is ready: Fabric, Minecraft 1.21.1.")).toBeVisible({ timeout: 90_000 });
  // The opening words stream before the UI knows the new chat id; they must not be lost.
  await expect(win.getByText("I'll make a small Fabric 1.21.1 pack with a minimap.", { exact: true })).toBeVisible();
  await expect(win.getByRole("button", { name: "Send" })).toBeVisible();
});

test("the finished run folds its steps, including the rejected malformed call", async () => {
  const fold = win.getByRole("button", { name: /^6 steps, 1 failed$/ });
  await expect(fold).toBeVisible();
  await fold.click();
  const feed = win.getByRole("list", { name: "Activity" });
  await expect(feed.getByText("Invalid arguments (input: give project_id or version_id), so nothing was done.")).toBeVisible();
  await expect(feed.getByText("Xaero's Minimap fabric-1.21.1-26.6.0 + Fabric API")).toBeVisible();
  await expect(feed.getByText("Fabric API is already in the pack")).toBeVisible();
  await win.screenshot({ path: join(SHOTS, "S04-done.png") });
});

test("the pack is on disk with both verified jars, and History lists the chat by the pack's name", async () => {
  const mods = (await readdir(join(prismRoot, "instances/packsmith-1.21.1-agent-trail/minecraft/mods"))).sort();
  expect(mods).toEqual([expect.stringMatching(FABRIC_API_JAR), "xaerominimap-fabric-1.21.1-26.6.0.jar"]);
  const marker = JSON.parse(await readFile(join(prismRoot, "instances/packsmith-1.21.1-agent-trail/.packsmith-instance.json"), "utf8"));
  expect(marker.createdBy).toBe("packsmith");
  await win.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "History" }).click();
  await expect(win.getByRole("button", { name: /^Agent Trail/ })).toBeVisible();
  await win.getByRole("button", { name: /^Agent Trail/ }).click();
  await expect(win.getByText("is ready: Fabric, Minecraft 1.21.1.")).toBeVisible();
});

test("the chat file on disk holds no home-directory paths sent to the provider", async () => {
  const files = await readdir(join(userData, "chats"));
  expect(files).toHaveLength(1);
  const chat = await readFile(join(userData, "chats", files[0]!), "utf8");
  expect(chat).not.toContain(prismRoot.split("/").slice(0, 3).join("/") === "/tmp" ? "/home/" : prismRoot);
});

test("History renames a chat in place and deletes it after asking; the pack stays (S12)", async () => {
  await win.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "History" }).click();
  const chats = win.getByRole("list", { name: "Chats" });
  await chats.getByRole("button", { name: /^Rename "Agent Trail/ }).click();
  await win.getByLabel("Chat name").fill("My trail pack");
  await win.keyboard.press("Enter");
  await expect(chats.getByRole("button", { name: /^My trail pack/ })).toBeVisible();
  // Escape keeps the name.
  await chats.getByRole("button", { name: 'Rename "My trail pack"' }).click();
  await win.getByLabel("Chat name").fill("something else");
  await win.keyboard.press("Escape");
  await expect(chats.getByRole("button", { name: /^My trail pack/ })).toBeVisible();
  await win.screenshot({ path: join(SHOTS, "S12-history.png") });

  await chats.getByRole("button", { name: 'Delete "My trail pack"' }).click();
  const dialog = win.getByRole("dialog", { name: "Delete this chat?" });
  await expect(dialog).toContainText("Your packs stay exactly as they are.");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(chats.getByRole("button", { name: /^My trail pack/ })).toBeVisible();
  await chats.getByRole("button", { name: 'Delete "My trail pack"' }).click();
  await win.getByRole("dialog").getByRole("button", { name: "Delete", exact: true }).click();
  await expect(win.getByText("No chats yet.")).toBeVisible();
  expect(await readdir(join(userData, "chats"))).toEqual([]);
  expect((await readdir(join(prismRoot, "instances/packsmith-1.21.1-agent-trail/minecraft/mods"))).length).toBe(2);
});

test("no console errors", async () => { expect(consoleErrors).toEqual([]); });
