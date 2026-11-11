// packsmith storage schemas (D-6: JSON files, no database). Every file on disk is parsed with
// these before use; a parse failure is an error, never a silent default. IPC contracts: ipc.ts.
import { z } from "zod";

export const Id = z.string().min(1).max(128).regex(/^[a-z0-9][a-z0-9._-]*$/);
const IsoTime = z.iso.datetime(); // UTC, ISO-8601
export const RelPath = z.string().min(1).max(512).refine((p) => !p.startsWith("/") && !p.split("/").includes(".."), "relative path inside the instance");
const Sha1 = z.string().regex(/^[0-9a-f]{40}$/);
const Sha512 = z.string().regex(/^[0-9a-f]{128}$/);

export const Loader = z.enum(["vanilla", "fabric", "forge", "neoforge"]);
export const McVersion = z.string().regex(/^(\d+\.\d+(\.\d+)?|\d{2}\.\d+(\.\d+)?)$/); // 1.20.1 and year-based 26.2
export const Side = z.enum(["required", "optional", "unsupported", "unknown"]);
export const ContentKind = z.enum(["mod", "shader", "resourcepack", "datapack"]);

// ---------- settings.json ----------
export const ProviderId = z.enum(["deepseek", "openrouter", "anthropic", "openai", "gemini", "ollama"]);
// zod 4: `.prefault({})` (not `.default({})`) so nested field defaults are applied.
export const LauncherKind = z.enum(["app-managed", "prism", "official"]);
export const Settings = z.object({
  schemaVersion: z.literal(1).prefault(1),
  provider: z.object({
    id: ProviderId,
    model: z.string(),
    // only for ollama: the one HTTP-guard exception (8.5), always user-entered
    localEndpoint: z.url().optional(),
  }).optional(),                          // set in milestone (b)
  search: z.object({ provider: z.enum(["none", "brave", "tavily", "provider-native"]).default("none") }).prefault({}),
  budgets: z.object({
    wallClockMin: z.number().int().positive().default(30),
    diskMb: z.number().int().positive().default(4096),
    spendUsd: z.number().positive().optional(), // only where the provider exposes cost
    testRuns: z.number().int().positive().default(6),
    attemptsPerIssue: z.number().int().positive().default(5),
    stagnationRepeats: z.number().int().positive().default(3),
  }).prefault({}),
  launcher: z.object({
    kind: LauncherKind.default("app-managed"),  // INS-1: app-managed is the default mode
    root: z.string().optional(),               // Prism root, auto-detected or user-picked
    prismWriteAllowed: z.boolean().default(false), // INS-2 one-time permission
  }).prefault({}),
  instanceDir: z.string().optional(),
  theme: z.enum(["system", "light", "dark"]).default("dark"),
  eulaAcceptedAt: IsoTime.optional(),     // 8.8, never auto-set
});
export type Settings = z.infer<typeof Settings>;

// ---------- instance marker (.packsmith-instance.json in every instance we create) ----------
export const InstanceMarker = z.object({
  createdBy: z.literal("packsmith"),
  version: z.literal(1),
  instanceId: Id,
  kind: z.enum(["pack", "staging-copy"]),
  mcVersion: McVersion,
  loader: Loader,
  loaderVersion: z.string().optional(),
  packName: z.string(),
  createdAt: IsoTime,
});

// ---------- packs.json (registry) ----------
// What the user let packsmith change in an instance it didn't make (ADP-2, D-33).
export const AdoptionScope = z.enum(["mods", "configs", "settings", "shaders", "resourcepacks", "quests", "loader"]);
export const InstanceRecord = z.object({
  id: Id,
  origin: z.enum(["own", "adopted"]),
  launcher: LauncherKind,
  path: z.string(),                      // absolute; checked by assertWritable on every write
  name: z.string(),
  mcVersion: McVersion,
  loader: Loader,
  loaderVersion: z.string().optional(),
  createdAt: IsoTime,
  // Prism group "packsmith" (INS-2) is written only while Prism is closed; true = still to do
  groupPending: z.boolean().default(false),
  adoptionId: Id.optional(),
  scope: z.array(AdoptionScope).optional(), // adopted only: enforced by assertWritable
  chatId: Id.optional(),                 // the pack's own chat (prefills go here)
});
export const PacksFile = z.object({ schemaVersion: z.literal(1).prefault(1), instances: z.array(InstanceRecord).default([]) });

// ---------- content scan (Installed tab) ----------
export const ContentItem = z.object({
  relpath: RelPath,
  kind: ContentKind,
  enabled: z.boolean(),
  sha1: Sha1, sha512: Sha512, bytes: z.number().int().nonnegative(),
  match: z.discriminatedUnion("status", [
    z.object({ status: z.literal("modrinth"), projectId: z.string(), versionId: z.string(), title: z.string(),
      summary: z.string(), iconUrl: z.url().optional(), versionNumber: z.string(), categories: z.array(z.string()),
      license: z.string().optional(), clientSide: Side, serverSide: Side,
      update: z.object({ versionId: z.string(), versionNumber: z.string() }).optional() }), // INT-2: newer fitting version
    z.object({ status: z.literal("unmatched"), reason: z.enum(["not-on-modrinth", "offline"]) }),
  ]),
  reason: z.object({ // GRP-1 "why it is here"
    kind: z.enum(["requested", "dependency", "agent-chosen", "pre-existing", "unknown"]),
    of: z.array(z.string()).default([]), // dependency of these project ids
    text: z.string().optional(),
  }),
});

// ---------- resolver output ----------
export const Edge = z.object({ from: z.string(), to: z.string(), kind: z.enum(["required", "optional", "incompatible", "embedded"]) });
export const ResolvedMod = z.object({
  projectId: z.string(), versionId: z.string(), title: z.string(), versionNumber: z.string(),
  projectType: z.string(), bytes: z.number().int().nonnegative(), iconUrl: z.string().optional(),
  clientSide: Side, serverSide: Side,
  alreadyInstalled: z.boolean(),         // in the pack already: nothing to download
  reason: ContentItem.shape.reason,
});
export const ResolvedSet = z.object({
  mcVersion: McVersion, loader: Loader,
  mods: z.array(ResolvedMod),            // requested first, then what they need, in discovery order
  edges: z.array(Edge),
  conflicts: z.array(z.object({ a: z.string(), b: z.string(), explanation: z.string(), proposedFix: z.string() })), // DEP-5
  unknowns: z.array(z.object({ projectId: z.string(), what: z.string() })), // DEP-4
  cycles: z.array(z.array(z.string())),
});

// ---------- journal.jsonl (append-only, 4.3) ----------
// One line per state change of an entry; the last line for an id is its current state.
// Lives in the app data folder (journal/<instanceId>/), never inside the instance (DECISIONS D-22).
export const JournalAction = z.enum(["write", "download", "update", "remove", "enable", "disable", "set-loader", "write-quests"]);
export const JournalEntry = z.object({
  id: Id,
  runId: z.string().optional(),
  at: IsoTime,
  state: z.enum(["open", "committed", "rolled-back"]), // "open" at startup = interrupted -> roll back
  action: JournalAction,
  reason: z.string(),             // one line for the Journal tab, e.g. "Added Xaero's Minimap and Fabric API"
  files: z.array(z.object({
    relpath: RelPath,
    beforeSha256: z.string().nullable(), // null = the file didn't exist
    afterSha256: z.string().nullable(),  // null = the file doesn't exist afterwards (or entry still open)
    backup: z.string().nullable(),       // copy of the before-state, relative to the entry's backup folder
  })),
});

// ---------- adoption (ADP-2/6) ----------
export const AdoptionManifest = z.object({
  id: Id,
  instancePath: z.string(),
  launcher: z.enum(["prism", "official"]),
  scope: z.array(AdoptionScope).min(1),
  adoptedAt: IsoTime,
  revokedAt: IsoTime.optional(),
  snapshot: z.array(z.object({ relpath: RelPath, sha256: z.string(), bytes: z.number().int() })), // taken before first write
});

// ---------- chats/<id>.json ----------
export const RunEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("step"), step: z.string(), count: z.number().int().default(1), state: z.enum(["running", "done", "failed"]) }),
  z.object({ type: z.literal("progress"), label: z.string(), done: z.number(), total: z.number() }),
  z.object({ type: z.literal("evidence"), branch: z.enum(["server", "client"]), rung: z.union([z.number().int().min(0).max(4), z.literal("n/a")]), excerpt: z.string() }),
  z.object({ type: z.literal("budget"), which: z.string(), used: z.number(), limit: z.number() }),
  z.object({ type: z.literal("blocker"), message: z.string(), decision: z.array(z.string()).optional() }),
]);
export const ChatMessage = z.object({
  id: Id, at: IsoTime,
  role: z.enum(["user", "assistant", "tool"]),
  text: z.string(),
  events: z.array(RunEvent).default([]),
  quickReplies: z.array(z.string()).default([]), // e.g. ["Build it", "Change something"]
});
export const Chat = z.object({
  id: Id, title: z.string(), createdAt: IsoTime, updatedAt: IsoTime,
  instanceId: Id.optional(),
  selectors: z.object({ mc: McVersion.or(z.literal("auto")), loader: Loader.or(z.literal("auto")),
    mode: z.enum(["auto", "mods", "modpack", "custom-pack", "shaders", "resourcepacks", "settings", "fix-crash"]) }),
  trimmedBefore: Id.optional(), // CHT-2
  messages: z.array(ChatMessage),
});

// ---------- crash diagnosis (M-9) ----------
export const Diagnosis = z.object({
  kind: z.enum(["missing_dependency", "version_mismatch", "incompatible_mods", "mixin_failure", "duplicate_mod",
    "java_version", "out_of_memory", "config_parse", "wrong_side", "unknown"]),
  confidence: z.enum(["high", "medium", "low"]),
  // role: missing = not in the pack but needed; wrong_version = present in the wrong version (or
  // built for another Minecraft); conflict = clashes with another mod; cause = named by the log.
  culprits: z.array(z.object({
    modId: z.string(), role: z.enum(["missing", "wrong_version", "conflict", "cause"]),
    neededBy: z.array(z.string()).default([]), wanted: z.string().optional(),
    file: RelPath.optional(), projectId: z.string().optional(),
  })),
  evidence: z.array(z.object({ line: z.number().int(), text: z.string() })).max(40),
  suggested: z.array(z.string()),
  signature: z.string(), // stable hash for stagnation detection
});

// ---------- boot tests (M-8): the evidence ladder (SPEC 11.3) ----------
// Rungs: 1 Resolved, 2 Boots, 3 Loads a world, 4 Gameplay checks (later). `reached` is the highest
// rung whose proof was actually seen, never more. "not-tested" and "n/a" are not failures.
export const BranchReport = z.object({
  branch: z.enum(["server", "client"]),
  status: z.enum(["proven", "failed", "not-tested", "n/a"]),
  reached: z.number().int().min(0).max(4),
  failedAt: z.number().int().min(1).max(4).optional(), // the rung that was tried and not reached
  proof: z.array(z.string()).default([]),               // log lines proving the reached rungs
  tail: z.array(z.string()).default([]),                // the failing log tail
  note: z.string(),                                     // one line, e.g. "client-only pack"
  logPath: z.string().optional(),
  diagnosis: Diagnosis.optional(),
  durationMs: z.number().int().optional(),
});
export const TestReport = z.object({
  instanceId: Id,
  at: IsoTime,
  resolved: z.object({ ok: z.boolean(), note: z.string() }), // rung 1, shared by both branches
  branches: z.array(BranchReport),
});
export type BranchReport = z.infer<typeof BranchReport>;
export type TestReport = z.infer<typeof TestReport>;
export const RUNG_LABELS = ["", "Resolved", "Boots", "Loads a world", "Gameplay checks"] as const;

// ---------- quests (M-7) ----------
// One engine-neutral shape for every engine (D-12): what the Quests tab shows, and what the agent
// writes. Engines translate to and from their own files.
export const QuestEngineId = z.enum(["ftbquests", "heracles", "vanilla"]);
const ResId = z.string().regex(/^[a-z0-9_.-]+:[a-z0-9_./-]+$/, "a namespaced id like minecraft:oak_log");
const ItemRef = z.string().regex(/^#?[a-z0-9_.-]+:[a-z0-9_./-]+$/, "an item id like minecraft:oak_log, or a tag like #minecraft:logs");
const ItemTask = z.object({ kind: z.literal("item"), item: ItemRef, count: z.number().int().min(1).max(10_000).default(1) }); // collect
const KillTask = z.object({ kind: z.literal("kill"), entity: ResId, count: z.number().int().min(1).max(10_000).default(1) });
const DimensionTask = z.object({ kind: z.literal("dimension"), dimension: ResId });                                      // go there
const CheckTask = z.object({ kind: z.literal("check"), text: z.string().min(1).max(160) });                                // tick it yourself
const Other = z.object({ kind: z.literal("other"), text: z.string() });                                                    // read-only: not modelled
const ItemReward = z.object({ kind: z.literal("item"), item: ResId, count: z.number().int().min(1).max(10_000).default(1) });
const XpReward = z.object({ kind: z.literal("xp"), amount: z.number().int().min(1).max(100_000) });
export const QuestTask = z.discriminatedUnion("kind", [ItemTask, KillTask, DimensionTask, CheckTask, Other]);
export const QuestReward = z.discriminatedUnion("kind", [ItemReward, XpReward, Other]);
export const Quest = z.object({
  id: z.string(), title: z.string(), description: z.array(z.string()).default([]),
  icon: z.string().optional(),            // item id
  tasks: z.array(QuestTask), rewards: z.array(QuestReward),
  dependsOn: z.array(z.string()),         // quest ids (may be in another chapter)
});
export const Chapter = z.object({
  id: z.string(), title: z.string(), order: z.number().int(), quests: z.array(Quest),
  engine: QuestEngineId,
  writtenBy: z.enum(["packsmith", "other"]),   // from packsmith's manifest, never guessed
});
export const QuestBook = z.object({
  installed: z.array(QuestEngineId),      // engines present in the pack (vanilla always)
  chapters: z.array(Chapter),
  notes: z.array(z.string()).default([]), // e.g. "FTB titles come from the lang file"
  names: z.record(z.string(), z.string()).default({}), // display names of the ids the book uses
});

// What the agent writes (write_quests): a chapter with local quest keys; `after` names keys in
// the same chapter. Validated against the pack's registry before anything is written (QST-4).
export const QuestSpec = z.object({
  key: z.string().regex(/^[a-z0-9_]{1,40}$/, "lowercase letters, digits and _"),
  title: z.string().trim().min(1).max(80),
  description: z.string().max(600).optional(),
  icon: ResId.optional(),
  tasks: z.array(z.discriminatedUnion("kind", [ItemTask, KillTask, DimensionTask, CheckTask])).min(1).max(5),
  rewards: z.array(z.discriminatedUnion("kind", [ItemReward, XpReward])).max(5).default([]),
  after: z.array(z.string()).max(4).default([]),
});
export const ChapterSpec = z.object({
  title: z.string().trim().min(1).max(60),
  quests: z.array(QuestSpec).min(1).max(40),
});

// ---------- inferred types ----------
export type Loader = z.infer<typeof Loader>;
export type McVersion = z.infer<typeof McVersion>;
export type ContentKind = z.infer<typeof ContentKind>;
export type LauncherKind = z.infer<typeof LauncherKind>;
export type InstanceMarker = z.infer<typeof InstanceMarker>;
export type InstanceRecord = z.infer<typeof InstanceRecord>;
export type AdoptionScope = z.infer<typeof AdoptionScope>;
export type AdoptionManifest = z.infer<typeof AdoptionManifest>;
export type PacksFile = z.infer<typeof PacksFile>;
export type ContentItem = z.infer<typeof ContentItem>;
export type JournalEntry = z.infer<typeof JournalEntry>;
export type JournalAction = z.infer<typeof JournalAction>;
export type ResolvedMod = z.infer<typeof ResolvedMod>;
export type ResolvedSet = z.infer<typeof ResolvedSet>;
export type QuestEngineId = z.infer<typeof QuestEngineId>;
export type QuestTask = z.infer<typeof QuestTask>;
export type QuestReward = z.infer<typeof QuestReward>;
export type Quest = z.infer<typeof Quest>;
export type Chapter = z.infer<typeof Chapter>;
export type QuestBook = z.infer<typeof QuestBook>;
export type QuestSpec = z.infer<typeof QuestSpec>;
export type ChapterSpec = z.infer<typeof ChapterSpec>;

// An engine as offered for one pack (QST-1: shown, never installed without the user's pick).
export const QuestEngineOption = z.object({
  id: QuestEngineId, label: z.string(),
  installed: z.boolean(),
  canInstall: z.boolean(),
  canWrite: z.boolean(),
  note: z.string(),                       // one line: what it is, or why it isn't available
});
export type QuestEngineOption = z.infer<typeof QuestEngineOption>;
