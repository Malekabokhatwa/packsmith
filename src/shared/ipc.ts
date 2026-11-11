// IPC contracts between the renderer and the main process. The main process parses every
// input with these schemas before acting (spec 4.1); the renderer gets typed results.
import { z } from "zod";
import { AdoptionScope, ContentItem, Id, InstanceRecord, JournalEntry, Loader, LauncherKind, McVersion, QuestBook, QuestEngineId, QuestEngineOption, RelPath, Settings, TestReport } from "./schema";
import { ChatSummary, ChatView, ProviderStatus, Selectors } from "./agent";

export const ProjectType = z.enum(["mod", "shader", "resourcepack"]);
export type ProjectType = z.infer<typeof ProjectType>;

export const SearchHit = z.object({
  projectId: z.string(),
  slug: z.string(),
  title: z.string(),
  summary: z.string(),
  iconUrl: z.string().optional(),
  downloads: z.number(),
  projectType: z.string(),
  categories: z.array(z.string()),
  clientSide: z.string(),
  serverSide: z.string(),
  license: z.string().optional(),
});
export type SearchHit = z.infer<typeof SearchHit>;

export const LauncherStatus = z.object({ prismRoot: z.string().nullable(), prismRunning: z.boolean() });
export type LauncherStatus = z.infer<typeof LauncherStatus>;
export const SearchStatus = z.object({
  provider: z.enum(["none", "provider-native", "tavily", "brave"]),
  active: z.boolean(),        // a run would really search (the provider is usable)
  geminiReady: z.boolean(),   // Gemini is the AI provider and has a key
  tavilyKey: z.boolean(),
});
export type SearchStatus = z.infer<typeof SearchStatus>;

// What an install or update did (DEP: dependencies are resolved and installed with it).
export const InstallResult = z.object({
  title: z.string(), versionNumber: z.string(), alreadyInstalled: z.boolean(),
  added: z.array(z.object({ title: z.string(), versionNumber: z.string(), relpath: z.string() })),
  unknowns: z.array(z.string()),
  entryId: z.string().optional(),
});
export type InstallResult = z.infer<typeof InstallResult>;
const Change = z.object({ entryId: z.string().nullable() });

export const channels = {
  "settings:get": { input: z.void(), output: Settings },
  "settings:setLauncher": {
    input: z.object({ kind: LauncherKind, root: z.string().optional(), prismWriteAllowed: z.boolean() }),
    output: Settings,
  },
  // PERF-5 budgets per run, with sane bounds.
  "settings:setBudgets": {
    input: z.object({
      wallClockMin: z.number().int().min(1).max(240), diskMb: z.number().int().min(64).max(65_536), testRuns: z.number().int().min(1).max(50),
      attemptsPerIssue: z.number().int().min(1).max(20), stagnationRepeats: z.number().int().min(2).max(10),
    }),
    output: Settings,
  },
  "settings:acceptEula": { input: z.object({ accept: z.literal(true) }), output: Settings }, // SPEC 8.8: the user's click only
  // Client tests: is a Minecraft account logged in through HeadlessMC, and the one-time login command.
  "client:status": { input: z.object({ setUp: z.boolean() }), output: z.object({ loggedIn: z.boolean(), ready: z.boolean(), loginCommand: z.string() }) },
  "tests:last": { input: z.object({ id: Id }), output: TestReport.nullable() },
  "tests:run": { input: z.object({ id: Id }), output: TestReport },
  // The step a running test is on ("booting a server", ...), null when none runs.
  "tests:progress": { input: z.object({ id: Id }), output: z.string().nullable() },
  // Fix a crash: the user picks a crash report or log; main reads and diagnoses it (null = cancelled).
  "crash:pick": { input: z.void(), output: z.object({ name: z.string(), text: z.string() }).nullable() },
  // Export (F08, EXP-1..4): the save dialog runs in main; null when the user cancelled.
  "packs:export": {
    input: z.object({ id: Id, kind: z.enum(["mrpack", "folder"]) }),
    output: z.object({ path: z.string(), referenced: z.number(), overrides: z.number(), leftOut: z.array(z.object({ relpath: z.string(), why: z.string() })), licenceFlags: z.array(z.string()) }).nullable(),
  },
  "launcher:status": { input: z.void(), output: LauncherStatus },
  "mc:versions": { input: z.void(), output: z.array(McVersion) },
  "packs:list": { input: z.void(), output: z.array(InstanceRecord) },
  "packs:create": {
    input: z.object({ name: z.string().trim().min(1).max(60), mcVersion: McVersion, loader: Loader }),
    output: InstanceRecord,
  },
  "packs:scan": { input: z.object({ id: Id }), output: z.array(ContentItem) },
  // GRP-1/2: mods as nodes, edges from the installed versions' Modrinth dependencies.
  "packs:graph": {
    input: z.object({ id: Id }),
    output: z.object({
      nodes: z.array(z.object({ id: z.string(), title: z.string(), iconUrl: z.string().optional(), kind: z.enum(["mod", "library", "unknown", "missing"]), enabled: z.boolean(), relpath: z.string().optional(), reason: ContentItem.shape.reason.optional() })),
      edges: z.array(z.object({ from: z.string(), to: z.string(), type: z.enum(["required", "optional", "incompatible"]) })),
    }),
  },
  "packs:install": { input: z.object({ id: Id, projectId: z.string().min(1).max(64) }), output: InstallResult },
  "packs:setEnabled": { input: z.object({ id: Id, relpath: RelPath, enabled: z.boolean(), label: z.string().max(120).optional() }), output: Change },
  "packs:remove": { input: z.object({ id: Id, relpath: RelPath, label: z.string().max(120).optional() }), output: Change },
  // Web search (WEB-1/2, D-34): off, Google Search through the Gemini key, or Tavily with its own key.
  "search:status": { input: z.void(), output: SearchStatus },
  "search:set": { input: z.object({ provider: z.enum(["none", "provider-native", "tavily"]) }), output: SearchStatus },
  "search:setKey": { input: z.object({ key: z.string().trim().min(8).max(200) }), output: SearchStatus },
  // M-14 (D-33): discovery is metadata only; adopt/revoke happen on the user's click.
  "adoption:discover": { input: z.void(), output: z.array(z.object({ ref: z.string(), name: z.string(), mcVersion: z.string().optional(), loader: Loader.optional(), modFiles: z.number().int(), adoptable: z.boolean(), reason: z.string().optional() })) },
  "adoption:adopt": { input: z.object({ ref: z.string().min(1).max(255), scope: z.array(AdoptionScope).min(1) }), output: InstanceRecord },
  "adoption:revoke": { input: z.object({ id: Id }), output: z.void() },
  "packs:update": { input: z.object({ id: Id, relpath: RelPath }), output: InstallResult },
  "quests:get": { input: z.object({ id: Id }), output: QuestBook },
  "quests:engines": { input: z.object({ id: Id }), output: z.array(QuestEngineOption) },
  "quests:installEngine": { input: z.object({ id: Id, engine: QuestEngineId }), output: z.object({ entryId: z.string().optional() }) },
  "quests:removeChapter": { input: z.object({ id: Id, engine: QuestEngineId, title: z.string().min(1).max(200) }), output: Change },
  "quests:icons": { input: z.object({ id: Id, items: z.array(z.string().max(200)).max(200) }), output: z.record(z.string(), z.string().nullable()) },
  "journal:list": { input: z.object({ id: Id }), output: z.array(JournalEntry) },
  "journal:undo": { input: z.object({ id: Id, entryId: Id }), output: JournalEntry },
  "packs:openFolder": { input: z.object({ id: Id }), output: z.void() },
  // A Prism pack opens in Prism; any other pack goes to Prism's own import dialog as an .mrpack.
  "packs:openInPrism": { input: z.object({ id: Id }), output: z.object({ mode: z.enum(["show", "import"]) }) },
  "provider:status": { input: z.void(), output: ProviderStatus },
  "provider:setKey": { input: z.object({ key: z.string().trim().min(10).max(400) }), output: ProviderStatus },
  "provider:clearKey": { input: z.void(), output: ProviderStatus },
  "provider:setModel": { input: z.object({ model: z.string().min(1).max(100) }), output: ProviderStatus },
  "provider:setProvider": { input: z.object({ id: z.enum(["gemini", "deepseek", "openrouter", "anthropic", "openai", "ollama"]) }), output: ProviderStatus },
  "provider:setLocalEndpoint": { input: z.object({ endpoint: z.string().trim().min(8).max(200) }), output: ProviderStatus },
  "chat:list": { input: z.void(), output: z.array(ChatSummary) },
  // S12: rename, delete one, delete all. A chat that is working can't be deleted.
  "chat:rename": { input: z.object({ id: Id, title: z.string().trim().min(1).max(80) }), output: z.void() },
  "chat:delete": { input: z.object({ id: Id }), output: z.void() },
  "chat:deleteAll": { input: z.void(), output: z.object({ deleted: z.number(), kept: z.number() }) },
  "chat:get": { input: z.object({ id: Id }), output: ChatView },
  "chat:send": {
    input: z.object({ chatId: Id.optional(), text: z.string().trim().min(1).max(8000), selectors: Selectors }),
    output: z.object({ chatId: Id, runId: z.string() }),
  },
  "run:stop": { input: z.object({ runId: z.string() }), output: z.void() },
  "run:pause": { input: z.object({ runId: z.string() }), output: z.void() },
  // Inline mod cards in answers (S04): ids come from the model's text, so only Modrinth-shaped ids.
  "modrinth:cards": {
    input: z.object({ ids: z.array(z.string().regex(/^[A-Za-z0-9]{8}$/)).min(1).max(50) }),
    output: z.array(z.object({ id: z.string(), title: z.string(), summary: z.string(), iconUrl: z.string().optional() })),
  },
  "modrinth:search": {
    input: z.object({
      query: z.string().max(100),
      mcVersion: McVersion,
      loader: Loader,
      projectType: ProjectType,
    }),
    output: z.array(SearchHit),
  },
} as const;

export type Channel = keyof typeof channels;
export type In<C extends Channel> = z.input<(typeof channels)[C]["input"]>;
export type InParsed<C extends Channel> = z.output<(typeof channels)[C]["input"]>; // what handlers receive
export type Out<C extends Channel> = z.output<(typeof channels)[C]["output"]>;

// Errors cross IPC as { error: { code, message } } so the UI can show the specific message
// (spec CHT-4: helpful errors, never "something went wrong").
export const IpcError = z.object({ code: z.string(), message: z.string() });
export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: z.infer<typeof IpcError> };

// Compile-time check: CHANNEL_NAMES (used by the preload) lists exactly the contract channels.
import type { CHANNEL_NAMES } from "./channelNames";
type Names = (typeof CHANNEL_NAMES)[number];
const _sameChannels: [Names, Channel] extends [Channel, Names] ? true : never = true;
void _sameChannels;
