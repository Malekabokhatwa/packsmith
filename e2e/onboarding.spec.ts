// UX-1 / AC-9: a fresh profile goes from first start to a typed first request without docs:
// the provider banner, the key (tested before it's saved), Start building, and the composer is
// ready. Scripted provider that wants a key (PACKSMITH_FAKE_NEEDS_KEY), so no live call (8.2).
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
  userData = await mkdtemp(join(tmpdir(), "ps-e2e-onboard-data-"));
  app = await electron.launch({
    args: [join(__dirname, "../out/main/index.js")],
    env: { ...process.env, PACKSMITH_USER_DATA: userData, PACKSMITH_PRISM_ROOT: join(userData, "no-prism"), PACKSMITH_FAKE_NEEDS_KEY: "1", PACKSMITH_FAKE_PROVIDER: join(__dirname, "fixtures/agent-script.json") },
  });
  win = await app.firstWindow();
  win.on("console", (m) => { if (m.type() === "error" && !m.location().url.startsWith("psicon:")) consoleErrors.push(m.text()); });
  win.on("pageerror", (e) => consoleErrors.push(String(e)));
  await win.setViewportSize({ width: 1440, height: 900 });
});
test.afterAll(async () => { await app?.close(); await rm(userData, { recursive: true, force: true }); });

test("first start to a typed first request in a few steps (UX-1)", async () => {
  const t0 = Date.now();
  const banner = win.getByRole("status").filter({ hasText: "packsmith needs an AI provider" });
  await expect(banner).toBeVisible();
  await expect(win.getByLabel("Describe a pack")).toBeDisabled();
  await win.waitForFunction(() => window.innerWidth === 1440);
  await win.waitForTimeout(200);
  await win.screenshot({ path: join(SHOTS, "S01-first-run.png") });
  await banner.getByRole("button", { name: "Add a provider" }).click();
  // The default provider's cost line is visible before anything is pasted (8.2).
  await expect(win.getByText("Free tier available with daily limits")).toBeVisible();
  await win.getByLabel("API key").fill("Fake-onboarding-key-TEST-0000");
  await win.getByRole("button", { name: "Test and save" }).click();
  await win.getByRole("button", { name: "Start building" }).click();
  const composer = win.getByLabel("Describe a pack");
  await expect(composer).toBeEnabled();
  await expect(composer).toBeFocused();
  await win.keyboard.type("A cozy Fabric 1.21.1 pack with a minimap");
  await expect(composer).toHaveValue("A cozy Fabric 1.21.1 pack with a minimap");
  // The app's own part of the 60 seconds: everything a person doesn't do by hand.
  expect(Date.now() - t0).toBeLessThan(15_000);
});

test("the composer grows with a long request, so no line is hidden (seen live 2026-11-10)", async () => {
  const composer = win.getByLabel("Describe a pack");
  const oneLine = await composer.evaluate((el) => el.clientHeight);
  await composer.fill("My pack fails its game test: the client crashes at boot. ".repeat(6));
  const grown = await composer.evaluate((el) => ({ h: el.clientHeight, scroll: el.scrollHeight }));
  expect(grown.h).toBeGreaterThan(oneLine * 2);
  expect(grown.scroll).toBeLessThanOrEqual(grown.h + 1); // everything typed is visible
  await composer.fill("");
});

test("no console errors", async () => { expect(consoleErrors).toEqual([]); });
