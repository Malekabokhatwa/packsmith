// OpenAI-compatible chat completions provider. Gemini (default, free tier), DeepSeek, OpenRouter
// and OpenAI all speak this protocol; only base URL, host and key differ (providers/catalog.ts).
// Every request goes through the HTTP guard (spec 8.5) with the provider's host allowlisted.
import { z } from "zod";
import type { Http } from "../net/http";
import { readAll } from "../net/guard";
import { AppError } from "../errors";
import { sseData, ToolCallAccumulator } from "./sse";
import type { ChatRequest, ChatResult, LlmProvider, Message } from "./types";

export interface CompatConfig {
  baseUrl: string; // e.g. https://generativelanguage.googleapis.com/v1beta/openai
  host: string;
  apiKey: string;
  label: string; // for error messages, e.g. "Gemini"
}

function toWire(m: Message): Record<string, unknown> {
  switch (m.role) {
    case "assistant":
      return {
        role: "assistant",
        content: m.content || null,
        ...(m.toolCalls?.length ? { tool_calls: m.toolCalls.map((c) => ({
          id: c.id, type: "function", function: { name: c.name, arguments: c.arguments },
          ...(c.extra !== undefined ? { extra_content: c.extra } : {}), // e.g. Gemini thought signatures, echoed unchanged
        })) } : {}),
      };
    case "tool":
      return { role: "tool", tool_call_id: m.toolCallId, name: m.name, content: m.content };
    default:
      return { role: m.role, content: m.content };
  }
}

const Chunk = z.object({
  choices: z.array(z.object({
    finish_reason: z.string().nullish(),
    delta: z.object({
      content: z.string().nullish(),
      tool_calls: z.array(z.object({
        index: z.number().optional(), id: z.string().nullish().transform((v) => v ?? undefined),
        function: z.object({ name: z.string().nullish().transform((v) => v ?? undefined), arguments: z.string().nullish().transform((v) => v ?? undefined) }).optional(),
        extra_content: z.unknown().optional(),
      })).nullish(),
    }).default({}),
  })).default([]),
  usage: z.object({ prompt_tokens: z.number(), completion_tokens: z.number() }).nullish(),
});

// Error bodies come as {"error":{...}} or, from Gemini, as [{"error":{...}}]. Gemini's 429s say
// how long to wait, in details[].retryDelay ("4s") and in the message ("Please retry in 4.6s").
const ErrorObj = z.object({ error: z.object({ message: z.string(), details: z.array(z.looseObject({ retryDelay: z.string().optional() })).optional() }) });
const ErrorBody = z.union([ErrorObj, z.array(ErrorObj).min(1).transform((a) => a[0]!)]);

export class OpenAiCompatProvider implements LlmProvider {
  constructor(private readonly http: Http, private readonly cfg: CompatConfig) {}

  private headers(): Record<string, string> {
    // A local model server needs no key: no empty "Bearer " header then.
    return { ...(this.cfg.apiKey ? { authorization: `Bearer ${this.cfg.apiKey}` } : {}), "content-type": "application/json" };
  }

  private async fail(status: number, body: Buffer, headers: Record<string, string | string[] | undefined> = {}): Promise<never> {
    let detail = "";
    let retryAfterMs = retryAfterHeader(headers["retry-after"]);
    try {
      const e = ErrorBody.safeParse(JSON.parse(body.toString("utf8")));
      if (e.success) {
        detail = `: ${e.data.error.message}`;
        const hinted = e.data.error.details?.find((d) => d.retryDelay)?.retryDelay ?? /retry in ([\d.]+)s/i.exec(e.data.error.message)?.[1];
        if (retryAfterMs === undefined && hinted) retryAfterMs = Math.ceil(Number.parseFloat(hinted) * 1000);
      }
    } catch { /* not JSON */ }
    if (retryAfterMs !== undefined && !Number.isFinite(retryAfterMs)) retryAfterMs = undefined;
    if (status === 401 || status === 403) throw new AppError("provider-auth", `${this.cfg.label} rejected the API key${detail}`);
    if (status === 429) throw new AppError("provider-rate-limit", `${this.cfg.label}'s rate limit was reached${detail}`, { retryAfterMs });
    if ([500, 502, 503, 504].includes(status)) throw new AppError("provider-unavailable", `${this.cfg.label} is overloaded or down right now (${status}${detail})`, { retryAfterMs });
    throw new AppError("provider-error", `${this.cfg.label} answered ${status}${detail}`);
  }

  async listModels(): Promise<string[]> {
    const res = await this.http.request(`${this.cfg.baseUrl}/models`, { allowHosts: [this.cfg.host], headers: this.headers(), timeoutMs: 20_000 });
    const body = await readAll(res.body);
    if (res.status !== 200) return this.fail(res.status, body, res.headers);
    const parsed = z.object({ data: z.array(z.object({ id: z.string() })) }).safeParse(JSON.parse(body.toString("utf8")));
    if (!parsed.success) throw new AppError("provider-format", `${this.cfg.label} sent a model list packsmith couldn't read.`);
    return parsed.data.data.map((m) => m.id.replace(/^models\//, ""));
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    const body = JSON.stringify({
      model: req.model,
      stream: true,
      stream_options: { include_usage: true },
      messages: req.messages.map(toWire),
      ...(req.tools.length ? { tools: req.tools.map((t) => ({ type: "function", function: t })), tool_choice: "auto" } : {}),
    });
    const res = await this.http.request(`${this.cfg.baseUrl}/chat/completions`, {
      method: "POST", body, allowHosts: [this.cfg.host], headers: this.headers(), timeoutMs: 180_000, maxBytes: 32 * 1024 * 1024, signal: req.signal,
    });
    if (res.status !== 200) return this.fail(res.status, await readAll(res.body), res.headers);
    if (req.signal.aborted) { res.body.destroy(); throw new AppError("stopped", "Stopped."); }
    const onAbort = () => res.body.destroy(new AppError("stopped", "Stopped."));
    req.signal.addEventListener("abort", onAbort, { once: true });
    let text = "";
    const calls = new ToolCallAccumulator();
    let usage: ChatResult["usage"];
    let finishReason: string | undefined;
    try {
      for await (const data of sseData(res.body)) {
        if (data === "[DONE]") break;
        let json: unknown;
        try { json = JSON.parse(data); } catch { continue; } // keep-alive or comment lines
        const chunk = Chunk.safeParse(json);
        if (!chunk.success) continue;
        if (chunk.data.usage) usage = { inputTokens: chunk.data.usage.prompt_tokens, outputTokens: chunk.data.usage.completion_tokens };
        for (const choice of chunk.data.choices) {
          if (choice.delta.content) { text += choice.delta.content; req.onText?.(choice.delta.content); }
          if (choice.delta.tool_calls) calls.add(choice.delta.tool_calls);
          if (choice.finish_reason) finishReason = choice.finish_reason.toLowerCase();
        }
      }
    } catch (err) {
      if (req.signal.aborted) throw new AppError("stopped", "Stopped.");
      if (err instanceof AppError) throw err;
      const timedOut = (err as Error).name === "AbortError" || (err as Error).name === "TimeoutError";
      throw new AppError("network", timedOut ? `${this.cfg.label} took too long to answer` : `Lost the connection to ${this.cfg.label}: ${(err as Error).message}`, { cause: err });
    } finally {
      req.signal.removeEventListener("abort", onAbort);
    }
    return { text, toolCalls: calls.result(), usage, finishReason };
  }
}

// Retry-After is seconds or an HTTP date.
function retryAfterHeader(v: string | string[] | undefined): number | undefined {
  const h = Array.isArray(v) ? v[0] : v;
  if (!h) return undefined;
  const secs = Number(h);
  if (Number.isFinite(secs)) return Math.ceil(secs * 1000);
  const at = Date.parse(h);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}
