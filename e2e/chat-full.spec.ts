// UX-4: the chat-full (CHT-2) and pause/resume (CHT-3) states. A tiny context budget (test hook)
// forces "full" on the first message; a second app runs a slow scripted model to pause. 8.2: no
// live model.
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SHOTS = join(__dirname, "../replica/clone-screens");
test.describe.configure({ mode: "serial" });
let app: ElectronApplication;
let win: Page;
let userData: string;
const consoleErrors: string[] = [];

test.beforeAll(async () => {
  userData = await mkdtemp(join(tmpdir(), "ps-e2e-full-data-"));
  app = await electron.launch({
    args: [join(__dirname, "../out/main/index.js")],
    env: { ...process.env, PACKSMITH_USER_DATA: userData, PACKSMITH_PRISM_ROOT: join(userData, "no-prism"), PACKSMITH_CONTEXT_BUDGET: "2000", PACKSMITH_FAKE_PROVIDER: join(__dirname, "fixtures/agent-script.json") },
  });
  win = await app.firstWindow();
  win.on("console", (m) => { if (m.type() === "error" && !m.location().url.startsWith("psicon:")) consoleErrors.push(m.text()); });
  win.on("pageerror", (e) => consoleErrors.push(String(e)));
  await win.setViewportSize({ width: 1440, height: 900 });
});

test.afterAll(async () => { await app?.close(); await rm(userData, { recursive: true, force: true }); });

test("a full chat says so and starts a new chat with the last request (CHT-2)", async () => {
  const request = `A Fabric 1.21.1 pack with ${"a very long wish list, ".repeat(120)}`;
  await win.getByLabel("Describe a pack").fill(request);
  await win.keyboard.press("Enter");
  const notice = win.getByRole("status").filter({ hasText: "This chat is full" });
  await expect(notice).toBeVisible({ timeout: 30_000 });
  await expect(win.getByText(/went wrong|Unexpected problem/)).toHaveCount(0);
  await win.screenshot({ path: join(SHOTS, "S04-chat-full.png") });
  await notice.getByRole("button", { name: "Start a new chat" }).click();
  await expect(win.getByRole("heading", { name: "What should we forge?" })).toBeVisible();
  await expect(win.getByLabel("Describe a pack")).toHaveValue(request.trimEnd());
});

test("Pause stops after the current step; Resume carries on in the same chat (CHT-3)", async () => {
  await app.close();
  app = await electron.launch({
    args: [join(__dirname, "../out/main/index.js")],
    env: { ...process.env, PACKSMITH_USER_DATA: userData, PACKSMITH_PRISM_ROOT: join(userData, "no-prism"), PACKSMITH_FAKE_PROVIDER: join(__dirname, "fixtures/agent-script-pause.json") },
  });
  win = await app.firstWindow();
  win.on("pageerror", (e) => consoleErrors.push(String(e)));
  await win.setViewportSize({ width: 1440, height: 900 });
  await win.getByLabel("Describe a pack").fill("Is there a minimap for Fabric 1.21.1?");
  await win.keyboard.press("Enter");
  await win.getByRole("button", { name: "Pause" }).click();
  const paused = win.getByRole("status").filter({ hasText: "Paused after the step \"Searching Modrinth\". Nothing is half-written." });
  await expect(paused).toBeVisible({ timeout: 30_000 });
  await expect(win.getByRole("button", { name: "Pause" })).toHaveCount(0);
  await win.screenshot({ path: join(SHOTS, "S04-paused.png") });
  await paused.getByRole("button", { name: "Resume" }).click();
  await expect(win.getByText("Picking up where I paused")).toBeVisible({ timeout: 30_000 });
  await expect(win.getByText("Nothing was installed.")).toBeVisible({ timeout: 30_000 });
  await expect(win.getByRole("button", { name: "Resume" })).toHaveCount(0); // only the latest paused answer offers it, and it isn't the latest now
});

test("Settings: budgets per run are saved within bounds; web search says it's off (PERF-5, WEB-3)", async () => {
  await win.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Settings" }).click();
  const budgets = win.getByRole("region", { name: "Budgets per run" });
  const time = budgets.getByRole("spinbutton", { name: "Time", exact: true });
  await expect(time).toHaveValue("30");
  await time.fill("0");
  await expect(budgets.getByText("Time: use a whole number from 1 to 240.")).toBeVisible();
  await expect(budgets.getByRole("button", { name: "Save budgets" })).toBeDisabled();
  await time.fill("45");
  await budgets.getByRole("spinbutton", { name: "Downloads", exact: true }).fill("2048");
  await budgets.getByRole("button", { name: "Save budgets" }).click();
  await expect(budgets.getByText("Saved. New runs use these limits.")).toBeVisible();
  const { readFile } = await import("node:fs/promises");
  const saved = JSON.parse(await readFile(join(userData, "settings.json"), "utf8"));
  expect(saved.budgets).toMatchObject({ wallClockMin: 45, diskMb: 2048, testRuns: 6 });
  const search = win.getByRole("region", { name: "Web search" });
  await expect(search).toContainText("Off. Picks come from Modrinth's data only");
  await budgets.scrollIntoViewIfNeeded();
  await win.screenshot({ path: join(SHOTS, "S10-budgets.png") });
  // WEB-2/3: each option says what it costs; an option missing its key stays visibly off.
  await search.getByRole("radio", { name: /Tavily/ }).check();
  await expect(search.getByRole("status").first()).toHaveText("Off. Tavily needs its key below.");
  await expect(search.getByLabel(/Tavily key/)).toBeVisible();
  await expect(search.getByRole("button", { name: "Test and save" })).toBeDisabled();
  await search.scrollIntoViewIfNeeded();
  await win.screenshot({ path: join(SHOTS, "S10-search.png") });
  expect(JSON.parse(await readFile(join(userData, "settings.json"), "utf8")).search).toEqual({ provider: "tavily" });
  await search.getByRole("radio", { name: /^Off/ }).check();
  await expect(search.getByRole("status").first()).toContainText("Off. Picks come from Modrinth's data only");
});

test("no console errors", async () => { expect(consoleErrors).toEqual([]); });
