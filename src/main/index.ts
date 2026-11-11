import { app, BrowserWindow, safeStorage, shell } from "electron";
import { webTools } from "./search/web";
import { Adoptions } from "./adoption/service";
import { join } from "node:path";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { guardedHttp } from "./net/http";
import { ModrinthClient } from "./sources/modrinth";
import { Registry } from "./instances/registry";
import { Packs } from "./instances/manager";
import { Journal } from "./instances/journal";
import { Quests } from "./quests/service";
import { Tester } from "./testing/service";
import { killAllTests } from "./testing/process";
import { ClientHarness } from "./testing/client";
import { Exporter } from "./export/service";
import { SettingsStore } from "./settings";
import { detectPrismRoot, isPrismRunning } from "./launchers/prism";
import { registerIpc } from "./ipc";
import { handleIcons, registerIconScheme } from "./icons";
import { KeyStore } from "./keys";
import { ProviderControl } from "./providerControl";
import { ScriptedProvider } from "./providers/scripted";
import { ChatStore } from "./chats/store";
import { Runs } from "./agent/runs";
import { makeRedactor } from "./redact";
import { RUN_EVENT_CHANNEL } from "@shared/channelNames";

// Test hooks: E2E runs point packsmith at a throwaway data folder and a throwaway Prism root,
// so tests never touch the real ones (spec AC-12).
// Fixed name, so the data folder is ~/.config/packsmith however the app is launched
// (`electron out/main/index.js` would otherwise call it "Electron").
app.setName("packsmith");
// Electron picks its keyring from the desktop name and falls back to plain "basic_text" on desktops
// it doesn't know (e.g. Hyprland). libsecret talks to any Secret Service (GNOME Keyring, KWallet,
// KeePassXC), so ask for it unless the user chose a store themselves. KeyStore still refuses
// anything weaker than a real keyring (spec 8.1).
if (!app.commandLine.hasSwitch("password-store")) app.commandLine.appendSwitch("password-store", "gnome-libsecret");
if (process.env.PACKSMITH_USER_DATA) app.setPath("userData", process.env.PACKSMITH_USER_DATA);
const prismRootOverride = process.env.PACKSMITH_PRISM_ROOT;

registerIconScheme(); // must run before the app is ready

const rendererUrl = process.env.ELECTRON_RENDERER_URL; // set by electron-vite in dev only
const rendererFile = join(__dirname, "../renderer/index.html");

function isTrustedUrl(url: string): boolean {
  if (rendererUrl) return url.startsWith(rendererUrl);
  return url === pathToFileURL(rendererFile).toString() || url.startsWith(pathToFileURL(rendererFile).toString() + "#");
}

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  const win = (mainWindow = new BrowserWindow({
    // 800 wide still fits half of a 1920 screen in tiling window managers (Hyprland ignores
    // larger minimums and crops the window instead).
    width: 1440, height: 900, minWidth: 800, minHeight: 600,
    show: false, backgroundColor: "#13161a", title: "packsmith", autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true,
    },
  }));
  win.on("closed", () => { mainWindow = null; });
  win.once("ready-to-show", () => win.show());
  // Lock navigation: the app never navigates away; https links open in the real browser.
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => {
    // Links open in the real browser, only for these sites.
    if (["https://modrinth.com/", "https://ai.google.dev/", "https://aistudio.google.com/", "https://www.minecraft.net/"].some((p) => url.startsWith(p))) void shell.openExternal(url);
    return { action: "deny" };
  });
  if (rendererUrl) void win.loadURL(rendererUrl);
  else void win.loadFile(rendererFile);
}

app.whenReady().then(async () => {
  const dataDir = app.getPath("userData");
  const modrinth = new ModrinthClient(guardedHttp);
  const settings = new SettingsStore(dataDir);
  const prismRoot = () => (prismRootOverride ? Promise.resolve(prismRootOverride) : detectPrismRoot());
  const journal = new Journal(dataDir);
  const registry = new Registry(dataDir);
  const packs = new Packs({ dataDir, http: guardedHttp, modrinth, registry, journal, settings, prismRunning: isPrismRunning, prismRoot });
  const quests = new Quests({ dataDir, http: guardedHttp, modrinth, packs, journal, prismRoot: async () => (await settings.get()).launcher.root ?? (await prismRoot()) });
  const client = new ClientHarness(dataDir, guardedHttp);
  const adoptions = new Adoptions({ dataDir, registry, prismRoot: async () => (await settings.get()).launcher.root ?? (await prismRoot()) });
  const tester = new Tester({ dataDir, http: guardedHttp, packs, modrinth, settings, client, prismRoot: async () => (await settings.get()).launcher.root ?? (await prismRoot()) });
  // Roll back any change a crash or forced quit left half done (spec 4.3), before the UI can ask
  // for anything.
  const recovered = await packs.recoverAll();
  if (recovered) console.log(`journal: rolled back ${recovered} interrupted change(s)`);
  const keys = new KeyStore(dataDir, {
    isEncryptionAvailable: () => safeStorage.isAsyncEncryptionAvailable(),
    backend: () => safeStorage.getSelectedStorageBackend(),
    encrypt: (plain) => safeStorage.encryptStringAsync(plain),
    decrypt: (cipher) => safeStorage.decryptStringAsync(cipher),
  });
  const fake = process.env.PACKSMITH_FAKE_PROVIDER ? new ScriptedProvider(process.env.PACKSMITH_FAKE_PROVIDER) : undefined;
  const providers = new ProviderControl(guardedHttp, keys, settings, fake, process.env.PACKSMITH_FAKE_NEEDS_KEY === "1");
  let liveKey = "";
  const redact = makeRedactor(() => [liveKey]);
  const chats = new ChatStore(dataDir);
  const runs = new Runs({
    chats, packs, quests, tester, adoptions, modrinth, settings, redact,
    web: async () => { const s = await settings.get(); return webTools(s.search.provider, { id: s.provider?.id, model: s.provider?.model }, keys, guardedHttp); },
    ...(process.env.PACKSMITH_CONTEXT_BUDGET ? { contextBudget: Number(process.env.PACKSMITH_CONTEXT_BUDGET) } : {}),
    provider: async () => {
      const p = await providers.forAgent();
      liveKey = p?.key ?? "";
      return p;
    },
    send: (env) => mainWindow?.webContents.send(RUN_EVENT_CHANNEL, env),
  });
  app.on("before-quit", () => { runs.stopAll(); killAllTests(); });
  const exporter = new Exporter({ packs, modrinth, http: guardedHttp });
  registerIpc({ packs, keys, http: guardedHttp, adoptions, quests, settings, modrinth, prismRoot, isTrustedUrl, runs, chats, providers, tester, client, exporter, exportDir: process.env.PACKSMITH_EXPORT_DIR, cacheDir: join(dataDir, "cache"),
    // Test hook: e2e must never start the real Prism; it records the command line instead.
    ...(process.env.PACKSMITH_FAKE_PRISM ? { startPrism: (command: string, args: string[]) => appendFileSync(process.env.PACKSMITH_FAKE_PRISM!, `${[command, ...args].join(" ")}\n`) } : {}) });
  handleIcons();
  createWindow();
});

app.on("window-all-closed", () => app.quit());
