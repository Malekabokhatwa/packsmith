// Agent run events (main -> renderer, live) and the stored chat shape. Shared by main and UI.
import { z } from "zod";
import { Id, Loader, McVersion, TestReport } from "./schema";

export const Selectors = z.object({
  mc: McVersion.or(z.literal("auto")).default("auto"),
  loader: z.enum(["auto", "fabric", "forge", "neoforge", "vanilla"]).default("auto"),
  mode: z.enum(["auto", "mods", "custom-pack", "shaders", "resourcepacks", "settings", "fix-crash"]).default("auto"),
});
export type Selectors = z.infer<typeof Selectors>;

export const Step = z.object({
  id: z.string(),
  tool: z.string(),
  label: z.string(),        // "Searching Modrinth"
  detail: z.string(),       // "xaero's minimap · 1.21.1 · fabric"
  state: z.enum(["running", "done", "failed"]),
  result: z.string().optional(), // one-line outcome, e.g. "8 results" or the error message
});
export type Step = z.infer<typeof Step>;

// The plan card (F02: plan first, then build on the user's word). Resolved before it is
// shown, so the file count and size are real and every library is listed with who needs it.
export const PlanMod = z.object({
  projectId: z.string(), title: z.string(), versionNumber: z.string(), iconUrl: z.string().optional(),
  why: z.enum(["requested", "dependency", "already"]),
  reason: z.string().optional(),     // the agent's one-line reason for a pick (PKB-1)
  neededBy: z.array(z.string()),     // titles, for libraries
  bytes: z.number().int().nonnegative(),
});
export const Plan = z.object({
  name: z.string(), mcVersion: McVersion, loader: Loader,
  mods: z.array(PlanMod),
  unknowns: z.array(z.string()),
  files: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
});
export type Plan = z.infer<typeof Plan>;
export type PlanMod = z.infer<typeof PlanMod>;

export const RunEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("started") }),
  z.object({ type: z.literal("text"), delta: z.string() }),
  z.object({ type: z.literal("step"), step: Step }),
  z.object({ type: z.literal("plan"), plan: Plan }),
  z.object({ type: z.literal("evidence"), report: TestReport }), // a boot test finished (SPEC 11.3)
  z.object({ type: z.literal("finished"), outcome: z.enum(["done", "stopped", "blocked", "error", "full", "paused"]), message: z.string().optional() }),
]);
export type RunEvent = z.infer<typeof RunEvent>;

// seq increases by one per event within a run; a chat snapshot carries the seq it already includes,
// so the UI applies only newer events (none lost, none applied twice).
export const RunEnvelope = z.object({ runId: z.string(), chatId: Id, seq: z.number().int(), event: RunEvent });
export type RunEnvelope = z.infer<typeof RunEnvelope>;

// What the UI shows. The model-facing transcript is stored next to it, separately.
export const DisplayItem = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user"), text: z.string(), at: z.string() }),
  z.object({
    kind: z.literal("agent"), at: z.string(), text: z.string(), steps: z.array(Step),
    outcome: z.enum(["done", "stopped", "blocked", "error", "full", "paused", "running"]), message: z.string().optional(),
    plan: Plan.optional(),
    evidence: TestReport.optional(), // the latest boot test in this answer
  }),
]);
export type DisplayItem = z.infer<typeof DisplayItem>;

export const ChatSummary = z.object({ id: Id, title: z.string(), updatedAt: z.string() });
export type ChatSummary = z.infer<typeof ChatSummary>;

export const ChatView = z.object({ id: Id, title: z.string(), updatedAt: z.string(), selectors: Selectors, display: z.array(DisplayItem), activeRunId: z.string().optional(), seq: z.number().int().optional() });
export type ChatView = z.infer<typeof ChatView>;

export const ProviderStatus = z.object({
  provider: z.enum(["gemini", "deepseek", "openrouter", "anthropic", "openai", "ollama"]),
  label: z.string(),
  keyHint: z.string(),
  endpoint: z.string().optional(), // the local model's address, as the user typed it (ollama only)
  choices: z.array(z.object({ id: z.enum(["gemini", "deepseek", "openrouter", "anthropic", "openai", "ollama"]), label: z.string(), cost: z.string() })),
  cost: z.string(),
  pricingUrl: z.string(),
  keyUrl: z.string(),
  hasKey: z.boolean(),
  persistent: z.boolean(),   // stored in the OS keyring (true) or this session only (false)
  model: z.string().optional(),
  models: z.array(z.string()),
});
export type ProviderStatus = z.infer<typeof ProviderStatus>;
