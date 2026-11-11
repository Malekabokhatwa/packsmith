import { app, dialog, ipcMain, shell, type IpcMainInvokeEvent } from "electron";
import { TavilySearch } from "./search/web";
import type { KeyStore } from "./keys";
import type { Http } from "./net/http";
import type { Adoptions } from "./adoption/service";
import { access, mkdir, open, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { diagnose } from "./crash/diagnose";
import { diagnosisText } from "./testing/report";
import { channels, type Channel, type InParsed, type IpcResult, type Out } from "@shared/ipc";
import { AppError } from "./errors";
import type { Packs } from "./instances/manager";
import type { Quests } from "./quests/service";
import type { SettingsStore } from "./settings";
import type { ModrinthClient } from "./sources/modrinth";
import { isPrismRunning, prismArgs, prismCommand } from "./launchers/prism";
import { spawn } from "node:child_process";
import type { Runs } from "./agent/runs";
import type { ChatStore } from "./chats/store";
import type { ProviderControl } from "./providerControl";
import type { Tester } from "./testing/service";
import type { ClientHarness } from "./testing/client";
import type { Exporter } from "./export/service";
import { packGraph } from "./instances/graph";

export interface IpcDeps {
  packs: Packs;
  keys: KeyStore;
  http: Http;
  adoptions: Adoptions;
  quests: Quests;
  settings: SettingsStore;
  modrinth: ModrinthClient;
  prismRoot: () => Promise<string | null>;
  isTrustedUrl: (url: string) => boolean;
  runs: Runs;
  chats: ChatStore;
  providers: ProviderControl;
  tester: Tester;
  client: ClientHarness;
  exporter: Exporter;
  exportDir?: string; // test hook (PACKSMITH_EXPORT_DIR): save there without a dialog
  cacheDir: string;   // <data>/cache: where the .mrpack handed to Prism's import goes
  startPrism?: (command: string, args: string[]) => void; // tests
}

function toError(err: unknown): { code: string; message: string } {
  if (err instanceof AppError) return { code: err.code, message: err.message };
  console.error(err); // full detail stays in the main-process log
  return { code: "internal", message: "packsmith hit an unexpected problem. The details are in the app log." };
}

export function registerIpc(d: IpcDeps): void {
  function handle<C extends Channel>(ch: C, fn: (input: Exclude<InParsed<C>, undefined>) => Promise<Out<C>>): void {
    ipcMain.handle(ch, async (event: IpcMainInvokeEvent, raw: unknown): Promise<IpcResult<Out<C>>> => {
      if (!d.isTrustedUrl(event.senderFrame?.url ?? "")) return { ok: false, error: { code: "untrusted", message: "Refused a request from an unknown page." } };
      const parsed = channels[ch].input.safeParse(raw);
      if (!parsed.success) return { ok: false, error: { code: "bad-input", message: parsed.error.issues[0]?.message ?? "Invalid input." } };
      try {
        return { ok: true, value: await fn(parsed.data as Exclude<InParsed<C>, undefined>) };
      } catch (err) {
        return { ok: false, error: toError(err) };
      }
    });
  }

  let gameVersions: string[] | null = null;

  handle("settings:get", () => d.settings.get());
  handle("settings:setLauncher", async (input) => {
    if (input.kind === "prism") {
      const root = input.root ?? (await d.prismRoot());
      if (!root) throw new AppError("no-prism", "Couldn't find Prism Launcher. Pick its folder.");
      await access(join(root, "prismlauncher.cfg")).catch(() => {
        throw new AppError("not-prism", `${root} doesn't look like a Prism Launcher folder (no prismlauncher.cfg).`);
      });
    }
    const next = await d.settings.update((s) => ({ ...s, launcher: { kind: input.kind, root: input.root ?? s.launcher.root, prismWriteAllowed: input.prismWriteAllowed } }));
    if (next.launcher.kind === "prism" && next.launcher.prismWriteAllowed) await d.packs.syncPrismGroups();
    return next;
  });
  // SPEC 8.8: only this click (the Settings button) records the user's EULA acceptance.
  handle("settings:setBudgets", (input) => d.settings.update((s) => ({ ...s, budgets: { ...s.budgets, ...input } })));
  handle("settings:acceptEula", () => d.settings.update((s) => ({ ...s, eulaAcceptedAt: s.eulaAcceptedAt ?? new Date().toISOString() })));
  handle("packs:export", async (input) => {
    const name = await d.exporter.suggestedName(input.id, input.kind);
    let dest: string | undefined;
    if (d.exportDir) dest = join(d.exportDir, name);
    else {
      const pick = await dialog.showSaveDialog({
        title: input.kind === "mrpack" ? "Export as .mrpack" : "Export as a folder",
        defaultPath: join(app.getPath("documents"), name),
        ...(input.kind === "mrpack" ? { filters: [{ name: "Modrinth modpack", extensions: ["mrpack"] }] } : {}),
      });
      if (pick.canceled || !pick.filePath) return null;
      // The file dialog adds the extension even when the name already had it (seen live).
      dest = pick.filePath.replace(/(\.mrpack)\.mrpack$/i, "$1");
    }
    return d.exporter.export(input.id, input.kind, dest);
  });
  handle("packs:openInPrism", async (input) => {
    const r = (await d.packs.list()).find((x) => x.id === input.id);
    if (!r) throw new AppError("unknown-pack", "That pack isn't in packsmith's list any more.");
    const prism = (await prismCommand()) ?? (d.startPrism ? { command: "prismlauncher", args: [] } : null);
    if (!prism) throw new AppError("no-prism", "Prism Launcher isn't installed. Export the pack as an .mrpack and open it in any launcher instead.");
    let mode: "show" | "import" = "show";
    let args: string[];
    if (r.launcher === "prism") args = prismArgs({ show: basename(r.path) });
    else {
      mode = "import";
      const file = join(d.cacheDir, "prism-import", await d.exporter.suggestedName(r.id, "mrpack"));
      await mkdir(join(d.cacheDir, "prism-import"), { recursive: true });
      await d.exporter.export(r.id, "mrpack", file);
      args = prismArgs({ import: file });
    }
    const start = d.startPrism ?? ((command: string, a: string[]) => spawn(command, a, { detached: true, stdio: "ignore" }).unref());
    start(prism.command, [...prism.args, ...args]);
    return { mode };
  });
  handle("crash:pick", async () => {
    const pick = await dialog.showOpenDialog({ title: "Pick a crash report or log", properties: ["openFile"], filters: [{ name: "Crash reports and logs", extensions: ["txt", "log"] }] });
    const file = pick.filePaths[0];
    if (pick.canceled || !file) return null;
    // The last 2 MB is where a crash is; the model gets the diagnosis and its lines, not the log.
    const size = (await stat(file)).size;
    const fh = await open(file, "r");
    const buf = Buffer.alloc(Math.min(size, 2_000_000));
    try { await fh.read(buf, 0, buf.length, size - buf.length); } finally { await fh.close(); }
    const d = diagnose(buf.toString("utf8"));
    const lines = d.evidence.slice(0, 12).map((e) => e.text);
    return { name: basename(file), text: `${diagnosisText(d)}${lines.length ? `\nLines:\n${lines.join("\n")}` : ""}` };
  });
  handle("client:status", async (input) => {
    // HeadlessMC (pinned, SHA-256 checked, ~90 MB) is fetched only when the user asks to set up.
    const ready = input.setUp ? await d.client.ensureBinary().then(() => true) : await d.client.hasBinary();
    return { loggedIn: ready && (await d.client.loggedIn()), ready, loginCommand: d.client.loginCommand() };
  });
  handle("tests:last", (input) => d.tester.last(input.id));
  handle("tests:run", (input) => d.tester.test(input.id));
  handle("tests:progress", async (input) => d.tester.progress(input.id));
  handle("launcher:status", async () => ({ prismRoot: await d.prismRoot(), prismRunning: await isPrismRunning() }));
  handle("mc:versions", async () => (gameVersions ??= await d.modrinth.releaseGameVersions()));
  handle("packs:list", async () => {
    await d.packs.syncPrismGroups().catch(() => undefined); // best effort; never blocks the list
    return d.packs.list();
  });
  handle("packs:create", (input) => d.packs.create(input));
  const searchStatus = async () => {
    const s = await d.settings.get();
    const geminiReady = s.provider?.id === "gemini" && (await d.keys.has("gemini"));
    const tavilyKey = await d.keys.has("tavily");
    const active = (s.search.provider === "provider-native" && geminiReady) || (s.search.provider === "tavily" && tavilyKey);
    return { provider: s.search.provider, active, geminiReady, tavilyKey };
  };
  handle("search:status", searchStatus);
  handle("search:set", async (input) => { await d.settings.update((s) => ({ ...s, search: { provider: input.provider } })); return searchStatus(); });
  handle("search:setKey", async (input) => {
    await new TavilySearch(d.http, input.key).search("minecraft fabric mod"); // a real search proves the key before it's kept
    await d.keys.set("tavily", input.key);
    await d.settings.update((s) => ({ ...s, search: { provider: "tavily" } }));
    return searchStatus();
  });
  handle("adoption:discover", () => d.adoptions.discover());
  handle("adoption:adopt", (input) => d.adoptions.adopt(input.ref, input.scope));
  handle("adoption:revoke", (input) => d.adoptions.revoke(input.id));
  handle("packs:scan", (input) => d.packs.scan(input.id));
  handle("packs:install", (input) => d.packs.install(input.id, input.projectId));
  handle("packs:setEnabled", async (input) => ({ entryId: (await d.packs.setEnabled(input.id, input.relpath, input.enabled, { label: input.label }))?.entry.id ?? null }));
  handle("packs:remove", async (input) => ({ entryId: (await d.packs.remove(input.id, input.relpath, { label: input.label })).entry.id }));
  handle("packs:update", (input) => d.packs.update(input.id, input.relpath));
  handle("quests:get", (input) => d.quests.book(input.id));
  handle("quests:engines", (input) => d.quests.engines(input.id));
  handle("quests:installEngine", (input) => d.quests.installEngine(input.id, input.engine));
  handle("quests:removeChapter", async (input) => ({ entryId: (await d.quests.removeChapter(input.id, input.engine, input.title)).id }));
  handle("quests:icons", (input) => d.quests.iconsFor(input.id, input.items));
  handle("journal:list", (input) => d.packs.history(input.id));
  handle("journal:undo", (input) => d.packs.undo(input.id, input.entryId));
  handle("packs:openFolder", async (input) => {
    const r = (await d.packs.list()).find((x) => x.id === input.id);
    if (!r) throw new AppError("unknown-pack", "That pack isn't in packsmith's list any more.");
    const err = await shell.openPath(r.path);
    if (err) throw new AppError("open-failed", `Couldn't open the folder: ${err}`);
  });
  handle("packs:graph", async (input) => {
    const items = await d.packs.scan(input.id);
    const installed = items.flatMap((c) => (c.kind === "mod" && c.match.status === "modrinth" ? [c.match.versionId] : []));
    const versions = installed.length ? await d.modrinth.versionsByIds(installed) : [];
    const byVersion = [...new Set(versions.flatMap((v) => v.dependencies.flatMap((dep) => (!dep.project_id && dep.version_id ? [dep.version_id] : []))))];
    const projectOf = new Map((byVersion.length ? await d.modrinth.versionsByIds(byVersion) : []).map((v) => [v.id, v.project_id]));
    const have = new Set(items.flatMap((c) => (c.match.status === "modrinth" ? [c.match.projectId] : [])));
    const missing = [...new Set(versions.flatMap((v) => v.dependencies.flatMap((dep) => (dep.dependency_type === "required" && dep.project_id && !have.has(dep.project_id) ? [dep.project_id] : []))))];
    const titles = new Map((missing.length ? await d.modrinth.projects(missing) : []).map((p) => [p.id, p.title]));
    return packGraph(items, versions, (vid) => projectOf.get(vid), titles);
  });
  handle("modrinth:search", (input) => d.modrinth.search(input.query, input));
  handle("modrinth:cards", async (input) => (await d.modrinth.projects([...new Set(input.ids)])).map((p) => ({ id: p.id, title: p.title, summary: p.description, ...(p.icon_url ? { iconUrl: p.icon_url } : {}) })));
  handle("provider:status", () => d.providers.status());
  handle("provider:setKey", (input) => d.providers.setKey(input.key));
  handle("provider:clearKey", () => d.providers.clearKey());
  handle("provider:setModel", (input) => d.providers.setModel(input.model));
  handle("provider:setProvider", (input) => d.providers.setProvider(input.id));
  handle("provider:setLocalEndpoint", (input) => d.providers.setLocalEndpoint(input.endpoint));
  handle("chat:list", () => d.chats.list());
  handle("chat:rename", (input) => d.chats.rename(input.id, input.title));
  handle("chat:delete", async (input) => {
    if (d.runs.isRunning(input.id)) throw new AppError("busy", "This chat is still working. Stop it first, then delete it.");
    await d.chats.remove(input.id);
  });
  // Chats that are working are kept (and counted), never deleted mid-run.
  handle("chat:deleteAll", async () => {
    let deleted = 0, kept = 0;
    for (const c of await d.chats.list()) {
      if (d.runs.isRunning(c.id)) { kept++; continue; }
      await d.chats.remove(c.id); deleted++;
    }
    return { deleted, kept };
  });
  handle("chat:get", async (input) => {
    // While a run is active, serve its in-memory chat (newer than disk) with the last event seq.
    const live = d.runs.live(input.id);
    if (live) return { ...structuredClone(d.chats.view(live.chat)), activeRunId: live.runId, seq: live.seq };
    const view = d.chats.view(await d.chats.load(input.id));
    const last = view.display.at(-1);
    // A run marked "running" with no live run was cut off when packsmith closed.
    if (last?.kind === "agent" && last.outcome === "running") {
      view.display[view.display.length - 1] = { ...last, outcome: "stopped", message: "Interrupted: packsmith was closed while this was running." };
    }
    return view;
  });
  handle("chat:send", (input) => d.runs.start(input));
  handle("run:stop", async (input) => d.runs.stop(input.runId));
  handle("run:pause", async (input) => d.runs.pause(input.runId));
}
