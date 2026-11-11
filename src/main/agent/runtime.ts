// M-1 agent runtime: the tool loop (spec 5.1). Stops only when the model gives a final answer,
// a budget is hit, the same failure repeats (stagnation), one issue exceeds its attempt cap,
// STOP is pressed, or the provider fails. Every stop is reported with its reason.
import type { RunEvent } from "@shared/agent";
import type { LlmProvider, Message, ToolCall } from "../providers/types";
import type { ToolContext, ToolDef } from "./tools";
import { toolSpecs } from "./tools";
import { AppError } from "../errors";

export interface Budgets {
  wallClockMs: number;
  maxSteps: number;          // model turns per run
  stagnationRepeats: number; // same failure this many times -> stop (spec default 3)
  attemptsPerIssue: number;  // failures of one tool this many times -> stop (spec default 5)
}

export interface RunDeps {
  provider: LlmProvider;
  model: string;
  fallbackModels?: string[]; // tried in order when the model stays overloaded after retries
  tools: readonly ToolDef[];
  ctx: ToolContext;
  redact: (s: string) => string;
  budgets: Budgets;
  emit: (e: RunEvent) => void;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  retryDelaysMs?: number[]; // waits before each retry of a busy provider (CHT-4)
  contextBudget?: number;   // characters of transcript a run may send (tests use a small one)
  pauseRequested?: () => boolean; // CHT-3: checked between turns, when every step so far is complete
}

const RETRYABLE = new Set(["provider-unavailable", "provider-rate-limit", "network"]);
const DEFAULT_RETRY_DELAYS = [2_000, 6_000, 15_000];
// When the provider says how long to wait (Gemini's free tier: a few requests per minute), wait
// that long and allow more attempts; a wait longer than this (a daily quota) stops the run.
const MAX_HINTED_WAIT_MS = 120_000;
const HINTED_ATTEMPTS = 8;

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new AppError("stopped", "Stopped."));
    const t = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(new AppError("stopped", "Stopped.")); };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

// End a message with exactly one full stop, whatever the provider's text ended with.
function sentence(s: string): string {
  return /[.!?]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`;
}

function waitText(ms: number): string {
  const min = Math.ceil(ms / 60_000);
  if (min < 90) return `${min} minutes`;
  return `${Math.round(min / 60)} hours`;
}

export interface RunResult {
  outcome: "done" | "stopped" | "blocked" | "error" | "full" | "paused";
  message?: string;
}

const MAX_RESULT_CHARS = 16_000;
const CONTEXT_CHAR_BUDGET = 150_000;

function truncate(s: string, max = MAX_RESULT_CHARS): string {
  return s.length <= max ? s : `${s.slice(0, max)}\n[truncated ${s.length - max} characters]`;
}

// PERF-4: keep the transcript under budget by blanking the oldest tool results first.
// Returns false when the chat is still over budget with every old tool result trimmed: it is
// full (CHT-2), and the run says so instead of failing at the provider.
export function trimContext(messages: Message[], budget = CONTEXT_CHAR_BUDGET): boolean {
  const size = () => messages.reduce((n, m) => n + m.content.length, 0);
  for (const m of messages) {
    if (size() <= budget) return true;
    if (m.role === "tool" && m.content !== "[older result trimmed]") m.content = "[older result trimmed]";
  }
  return size() <= budget;
}

export const CHAT_FULL = "This chat is full: older steps were trimmed and there's no room left to continue here. Start a new chat to go on.";

export async function runAgent(d: RunDeps, transcript: Message[], signal: AbortSignal): Promise<RunResult> {
  const now = d.now ?? Date.now;
  const start = now();
  const specs = toolSpecs(d.tools);
  const byName = new Map(d.tools.map((t) => [t.name, t]));
  const failureCounts = new Map<string, number>(); // signature -> count (stagnation)
  const toolFailures = new Map<string, number>();  // tool name -> count (attempts per issue)
  let stepSeq = 0;
  let model = d.model;
  const fallbacks = [...(d.fallbackModels ?? [])];
  const tried = [model];
  let continuations = 0;
  let lastLabel: string | undefined;
  const MAX_CONTINUATIONS = 2;

  d.emit({ type: "started" });
  try {
    for (let turn = 0; turn < d.budgets.maxSteps; turn++) {
      if (signal.aborted) return { outcome: "stopped", message: "Stopped." };
      // Between turns every tool call has finished and its result is in the transcript: a resume
      // continues from exactly here.
      if (turn > 0 && d.pauseRequested?.()) return { outcome: "paused", message: `Paused${lastLabel ? ` after the step "${lastLabel}"` : ""}. Nothing is half-written.` };
      if (now() - start > d.budgets.wallClockMs) {
        return { outcome: "blocked", message: `Stopped: the ${Math.round(d.budgets.wallClockMs / 60000)}-minute time budget ran out. Raise it in Settings to let runs go longer.` };
      }
      if (!trimContext(transcript, d.contextBudget)) return { outcome: "full", message: CHAT_FULL };
      let turnText = "";
      const delays = d.retryDelaysMs ?? DEFAULT_RETRY_DELAYS;
      let res: Awaited<ReturnType<LlmProvider["chat"]>> | undefined;
      for (let attempt = 0; !res; attempt++) {
        try {
          res = await d.provider.chat({
            model, messages: transcript, tools: specs, signal,
            onText: (delta) => { turnText += delta; d.emit({ type: "text", delta }); },
          });
        } catch (err) {
          // Retry a busy provider, but only if nothing streamed yet (no duplicated text).
          const retryable = err instanceof AppError && RETRYABLE.has(err.code) && turnText === "" && !signal.aborted;
          const hint = retryable ? (err as AppError).retryAfterMs : undefined;
          if (hint !== undefined && hint > MAX_HINTED_WAIT_MS) {
            throw new AppError((err as AppError).code, `${sentence((err as AppError).message)} It asks for a wait of about ${waitText(hint)}, so this run stops here. Try again later, or pick another model in Settings.`);
          }
          const maxAttempts = hint !== undefined ? Math.max(delays.length, HINTED_ATTEMPTS) : delays.length;
          // Gemini signs tool calls per model; once signed calls are in the history, switching
          // models could invalidate them, so fallback is only allowed before that.
          const signedHistory = transcript.some((m) => m.role === "assistant" && m.toolCalls?.some((c) => c.extra !== undefined));
          if (retryable && attempt >= maxAttempts && fallbacks.length && !signedHistory) {
            // This model stayed busy through every retry: switch to the next one the key offers.
            const next = fallbacks.shift()!;
            d.emit({ type: "step", step: { id: `switch${stepSeq++}`, tool: "provider", label: "Switching model", detail: `${model} → ${next}`, state: "done", result: `${model} stayed busy` } });
            model = next;
            tried.push(next);
            attempt = -1;
            continue;
          }
          if (!retryable || attempt >= maxAttempts) {
            if (retryable) {
              const which = tried.length > 1 ? `Tried ${tried.join(", ")}, each ${maxAttempts + 1} times.` : `packsmith tried ${attempt + 1} times.`;
              throw new AppError((err as AppError).code, `${sentence((err as AppError).message)} ${which} Try again in a minute, or pick another model in Settings.`);
            }
            throw err;
          }
          const id = `wait${stepSeq++}`;
          const label = (err as AppError).code === "provider-rate-limit" ? "Rate limit reached, waiting" : (err as AppError).code === "network" ? "Connection trouble, trying again" : "Model is busy, trying again";
          const base = delays[Math.min(attempt, delays.length - 1)]!;
          const wait = hint !== undefined ? Math.max(base, hint + 500) : base;
          const step = { id, tool: "provider", label, detail: `attempt ${attempt + 2} of ${maxAttempts + 1}${hint !== undefined ? ` · waiting ${Math.ceil(wait / 1000)} s as asked` : ""}`, state: "running" as const, result: (err as AppError).message };
          d.emit({ type: "step", step });
          await (d.sleep ?? abortableSleep)(wait, signal);
          d.emit({ type: "step", step: { ...step, state: "done" } });
        }
      }
      transcript.push({ role: "assistant", content: res.text, toolCalls: res.toolCalls.length ? res.toolCalls : undefined });
      if (res.toolCalls.length === 0) {
        if (res.finishReason === "content_filter" || res.finishReason === "safety") {
          return { outcome: "blocked", message: "The provider's safety filter stopped this answer. Try rewording the request." };
        }
        // An answer that ran out of tokens or whose stream ended without a reason was cut off:
        // ask the model to carry on from where it stopped, so the text continues seamlessly.
        if ((res.finishReason === undefined || res.finishReason === "length") && continuations < MAX_CONTINUATIONS) {
          continuations++;
          transcript.push({ role: "user", content: "[packsmith] Your previous message was cut off. Continue exactly where it stopped, without repeating anything." });
          continue;
        }
        return { outcome: "done" };
      }
      if (turnText.trim()) d.emit({ type: "text", delta: "\n\n" });

      // One turn may carry several calls (a whole repair and its retest): they run in order, and
      // once one fails the rest of that turn is answered as skipped, never run on a broken state.
      let failedInTurn: string | null = null;
      for (const call of res.toolCalls) {
        if (signal.aborted) return { outcome: "stopped", message: "Stopped." };
        if (failedInTurn) {
          transcript.push({ role: "tool", toolCallId: call.id, name: call.name, content: JSON.stringify({ skipped: `Not run: ${failedInTurn} failed earlier in this turn. Deal with that first, then call this again if it's still needed.` }) });
          continue;
        }
        const outcome = await runTool(d, byName, call, `s${stepSeq++}`);
        lastLabel = byName.get(call.name)?.label ?? lastLabel;
        transcript.push({ role: "tool", toolCallId: call.id, name: call.name, content: d.redact(truncate(outcome.content)) });
        if (outcome.failed) {
          failedInTurn = call.name;
          const sig = `${call.name}|${outcome.error}`;
          const n = (failureCounts.get(sig) ?? 0) + 1;
          failureCounts.set(sig, n);
          const t = (toolFailures.get(call.name) ?? 0) + 1;
          toolFailures.set(call.name, t);
          if (n >= d.budgets.stagnationRepeats) {
            return { outcome: "blocked", message: `Stopped after the same problem came up ${n} times: ${outcome.error}` };
          }
          if (t >= d.budgets.attemptsPerIssue) {
            return { outcome: "blocked", message: `Stopped after ${t} failed attempts at "${byName.get(call.name)?.label ?? call.name}". Last error: ${outcome.error}` };
          }
        }
      }
    }
    return { outcome: "blocked", message: `Stopped: the run reached its limit of ${d.budgets.maxSteps} steps.` };
  } catch (err) {
    if (signal.aborted || (err instanceof AppError && err.code === "stopped")) return { outcome: "stopped", message: "Stopped." };
    return { outcome: "error", message: err instanceof AppError ? err.message : `Unexpected problem: ${(err as Error).message}` };
  }
}

async function runTool(d: RunDeps, byName: Map<string, ToolDef>, call: ToolCall, id: string): Promise<{ content: string; failed: boolean; error?: string }> {
  const tool = byName.get(call.name);
  const fail = (error: string, label = call.name, detail = "") => {
    d.emit({ type: "step", step: { id, tool: call.name, label, detail, state: "failed", result: error } });
    return { content: JSON.stringify({ error }), failed: true, error };
  };
  if (!tool) return fail(`Unknown tool "${call.name}".`);
  let raw: unknown;
  try {
    raw = JSON.parse(call.arguments || "{}");
  } catch {
    return fail("The tool arguments were not valid JSON, so nothing was done.", tool.label);
  }
  const parsed = tool.input.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return fail(`Invalid arguments (${issue?.path.join(".") || "input"}: ${issue?.message}), so nothing was done.`, tool.label);
  }
  const detail = tool.detail(parsed.data);
  d.emit({ type: "step", step: { id, tool: tool.name, label: tool.label, detail, state: "running" } });
  try {
    const progress = (text: string) => d.emit({ type: "step", step: { id, tool: tool.name, label: tool.label, detail, state: "running", result: text } });
    const { data, summary } = await tool.run(parsed.data, { ...d.ctx, progress });
    d.emit({ type: "step", step: { id, tool: tool.name, label: tool.label, detail, state: "done", result: summary } });
    // Tool output is data, never instructions (spec 8.4); the system prompt says so too.
    return { content: JSON.stringify({ result: data }), failed: false };
  } catch (err) {
    const msg = err instanceof AppError ? err.message : `Unexpected problem: ${(err as Error).message}`;
    return fail(msg, tool.label, detail);
  }
}
