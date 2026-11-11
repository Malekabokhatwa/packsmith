// Milestone (e) done-check, AC-2 (SPEC CRS-2): a built pack is proven by a real server boot; a
// required library is then removed; in "Fix a crash" mode the agent's boot test fails, the
// diagnosis from the boot log names the missing library, it is restored, and the retest proves
// the pack again. Real Electron build on Xvfb, real Modrinth, Mojang's real server and Java;
// scripted model (8.2). The EULA is accepted through Settings' own button (DECISIONS D-30).
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { access, copyFile, mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const SHOTS = join(__dirname, "../replica/clone-screens");
// Mojang's server jar (52 MB) is kept between e2e runs, outside the repo.
const KEEP = join(homedir(), ".cache/packsmith-e2e");
test.describe.configure({ mode: "serial" });

let app: ElectronApplication;
let win: Page;
let userData: string;
const consoleErrors: string[] = [];
const exists = (p: string) => access(p).then(() => true, () => false);
const MODS = () => join(userData, "instances/packsmith-1.21.1-waystone-test/minecraft/mods");

test.beforeAll(async () => {
  userData = await mkdtemp(join(tmpdir(), "ps-e2e-e-data-"));
  await writeFile(join(userData, "settings.json"), JSON.stringify({ launcher: { kind: "app-managed" } }));
  const cached = join(KEEP, "1.21.1-server.jar");
  if (await exists(cached)) {
    await mkdir(join(userData, "cache/minecraft"), { recursive: true });
    await copyFile(cached, join(userData, "cache/minecraft/1.21.1-server.jar"));
  }
  await mkdir(SHOTS, { recursive: true });
  app = await electron.launch({
    args: [join(__dirname, "../out/main/index.js")],
    env: { ...process.env, PACKSMITH_USER_DATA: userData, PACKSMITH_PRISM_ROOT: join(userData, "no-prism"), PACKSMITH_EXPORT_DIR: join(userData, "exports"), PACKSMITH_FAKE_PRISM: join(userData, "prism-calls.txt"), PACKSMITH_FAKE_PROVIDER: join(__dirname, "fixtures/agent-script-e.json") },
  });
  win = await app.firstWindow();
  win.on("console", (m) => { if (m.type() === "error" && !m.location().url.startsWith("psicon:")) consoleErrors.push(m.text()); });
  win.on("pageerror", (e) => consoleErrors.push(String(e)));
  await win.setViewportSize({ width: 1440, height: 900 });
});

test.afterAll(async () => {
  const jar = join(userData, "cache/minecraft/1.21.1-server.jar");
  if (await exists(jar) && !(await exists(join(KEEP, "1.21.1-server.jar")))) { await mkdir(KEEP, { recursive: true }); await copyFile(jar, join(KEEP, "1.21.1-server.jar")); }
  await app?.close();
});

test("the EULA is accepted with Settings' button, never by default", async () => {
  await win.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Settings" }).click();
  const section = win.getByRole("region", { name: "Boot tests" });
  await expect(section.getByRole("link", { name: "read it" })).toHaveAttribute("href", "https://www.minecraft.net/en-us/eula");
  await section.getByRole("button", { name: "I accept the Minecraft EULA" }).click();
  await expect(section.getByText(/You accepted the Minecraft EULA on/)).toBeVisible();
  await win.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Forge" }).click();
});

test("a built pack is proven by a real server boot, with the proving log lines", async () => {
  await win.getByLabel("Task").selectOption("custom-pack");
  await win.getByLabel("Describe a pack").fill("A small Fabric 1.21.1 pack with waystones");
  await win.keyboard.press("Enter");
  await expect(win.getByText("is built and the server test loaded a world")).toBeVisible({ timeout: 6 * 60_000 });
  // The Done card: name, the ladder, what wasn't checked, and what to do next.
  const done = win.getByRole("region", { name: "Waystone Test is ready" });
  await expect(done).toBeVisible();
  await expect(done.getByText(/The game itself: Log in once/)).toBeVisible();
  await expect(done.getByText(/Playing it: recipes, quests and balance/)).toBeVisible();
  await done.getByRole("button", { name: "Open in Prism" }).click();
  await expect(done.getByText(/Prism Launcher is asking to import the pack/)).toBeVisible({ timeout: 60_000 });
  const { readFile } = await import("node:fs/promises");
  expect(await readFile(join(userData, "prism-calls.txt"), "utf8")).toMatch(/--import \S*cache\/prism-import\/Waystone Test\.mrpack/);
  // Inline mod cards from the answer's {{mod:id}} tokens (S04), names from live Modrinth.
  const answer = win.getByRole("region", { name: "packsmith's answer" }).last();
  await expect(answer.getByRole("link", { name: "Waystones on Modrinth" })).toBeVisible({ timeout: 30_000 });
  await expect(answer.getByRole("link", { name: "Balm on Modrinth" })).toBeVisible();
  await expect(answer.getByText("{{mod:", { exact: false })).toHaveCount(0);
  await win.screenshot({ path: join(SHOTS, "S04-done-card.png") });
  const ladder = win.getByRole("region", { name: "Evidence: Proven up to: Loads a world (server)" });
  await expect(ladder).toBeVisible();
  await expect(ladder.getByText(/Not tested: Log in once with your Minecraft account/)).toBeVisible();
  await ladder.getByRole("button", { name: /Show the log lines/ }).click();
  await expect(ladder.getByText(/Done \(\d/)).toBeVisible();
  const mods = await readdir(MODS());
  expect(mods.some((m) => /^balm/i.test(m))).toBe(true);
  await win.screenshot({ path: join(SHOTS, "S04-evidence.png") });
});

test("removing a required library breaks the pack", async () => {
  await win.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Packs" }).click();
  await expect(win.getByText("Found in Prism (read-only)")).toHaveCount(0); // the test never sees the real machine's Prism
  await expect(win.getByRole("region", { name: /Last test.*Proven up to: Loads a world \(server\)/ })).toBeVisible();
  await win.getByRole("button", { name: "Remove Balm" }).click();
  await expect(win.getByText("Removed Balm.")).toBeVisible();
  await expect(win.getByText("The pack changed after this test.")).toBeVisible();
  expect((await readdir(MODS())).some((m) => /^balm/i.test(m))).toBe(false);
  await win.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Forge" }).click();
});

test("AC-2: Fix a crash finds the missing library from the boot log, restores it, and the retest proves it", async () => {
  await win.getByLabel("Task").selectOption("fix-crash");
  await win.getByLabel("Describe a pack").fill("My Waystone Test pack crashes now. Fix it.");
  await win.keyboard.press("Enter");
  await expect(win.getByText("Fixed: Balm was missing.")).toBeVisible({ timeout: 6 * 60_000 });
  const answer = win.getByRole("region", { name: "packsmith's answer" }).last();
  await answer.getByRole("button", { name: /steps/ }).click();
  const failed = answer.getByText(/balm \(missing, needed by waystones, Modrinth project/);
  await expect(failed).toBeVisible();
  // Rung 1 sees it too: the resolver check of the pack as it is.
  await expect(answer.getByText(/Resolved: no \(Balm is missing \(needed by Waystones\)/)).toBeVisible();
  await expect(answer.getByRole("region", { name: "Evidence: Proven up to: Loads a world (server)" })).toBeVisible();
  expect((await readdir(MODS())).some((m) => /^balm/i.test(m))).toBe(true);
  await win.screenshot({ path: join(SHOTS, "S04-fix-crash.png") });
});

test("the Packs header shows the latest proof, and Test now runs it again", async () => {
  await win.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Packs" }).click();
  await expect(win.getByRole("region", { name: /Last test.*Proven up to: Loads a world \(server\)/ })).toBeVisible();
  await win.getByRole("button", { name: "Test now" }).click();
  // Per-step progress while it runs (polled from the Tester).
  await expect(win.getByRole("status").filter({ hasText: /Testing: (checking libraries|booting a server|booting the game)/ })).toBeVisible({ timeout: 30_000 });
  await expect(win.getByRole("region", { name: /Last test.*Proven up to: Loads a world \(server\)/ })).toBeVisible({ timeout: 3 * 60_000 });
  await win.screenshot({ path: join(SHOTS, "S05-evidence.png") });
});

test("the Mods tab's graph shows every mod and its dependency links from Modrinth (GRP-1/2)", async () => {
  await win.getByRole("radio", { name: "Graph" }).click();
  const g = win.getByRole("group", { name: "Pack graph" });
  await expect(g).toBeVisible({ timeout: 30_000 });
  await expect(g.getByRole("button")).toHaveCount(3);
  await g.getByRole("button", { name: /^Waystones/ }).click();
  const why = win.getByRole("complementary", { name: "Why Waystones is here" });
  await expect(why).toContainText(/Requires: .*Balm/);
  await expect(why).toContainText(/Fabric API/);
  await win.screenshot({ path: join(SHOTS, "S09-graph.png") });
  await win.getByRole("radio", { name: "List" }).click();
});

test("Export writes a .mrpack that references every mod by URL and hash (EXP-1, EXP-4)", async () => {
  await mkdir(join(userData, "exports"), { recursive: true });
  await win.getByRole("button", { name: "Export" }).click();
  await win.getByRole("menuitem", { name: /\.mrpack file/ }).click();
  await expect(win.getByRole("status").filter({ hasText: /Exported to .*Waystone Test\.mrpack\. 3 files from Modrinth/ })).toBeVisible({ timeout: 60_000 });
  const { withZip } = await import("../src/main/archive/zip");
  await withZip(join(userData, "exports", "Waystone Test.mrpack"), async (z) => {
    expect(z.names()).toContain("LICENSES.md");
    expect(z.names().some((n) => n.endsWith(".jar"))).toBe(false);
    const index = JSON.parse((await z.read("modrinth.index.json"))!.toString());
    expect(index.dependencies.minecraft).toBe("1.21.1");
    expect(index.files).toHaveLength(3);
    for (const f of index.files) {
      expect(f.downloads[0]).toMatch(/^https:\/\/cdn\.modrinth\.com\//);
      expect(f.hashes.sha512).toMatch(/^[0-9a-f]{128}$/);
    }
  });
  await win.screenshot({ path: join(SHOTS, "S05-export.png") });
});

test("no test server is left running, and no console errors", async () => {
  const { execSync } = await import("node:child_process");
  const java = execSync("pgrep -af java || true").toString();
  expect(java).not.toContain(userData);
  expect(consoleErrors).toEqual([]);
});
