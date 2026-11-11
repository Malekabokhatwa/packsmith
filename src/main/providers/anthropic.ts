// Anthropic's Messages API (D-3, SPEC 8.2). Everything goes through the HTTP guard with
// api.anthropic.com allowlisted, like the other providers.
// Auth: each user's own Anthropic API key, never Claude.ai plan credentials: routing a distributed
// third-party app through those isn't permitted (SPEC 8.2). Don't "fix" this.
import { z } from "zod";
import type { Http } from "../net/http";
import { readAll } from "../net/guard";
import { AppError } from "../errors";
import { sseData } from "./sse";
import type { ChatRequest, ChatResult, LlmProvider, Message, ToolCall } from "./types";

export const ANTHROPIC_HOST = "api.anthropic.com";
const BASE = `https://${ANTHROPIC_HOST}/v1`;
const VERSION = "2023-06-01";

type Block = { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: unknown } | { type: "tool_result"; tool_use_id: string; content: string };

// Our transcript -> Anthropic's: the system prompt goes on its own; tool results become one user
// turn of tool_result blocks (consecutive results must share a message); empty text is dropped.
export function toAnthropic(messages: Message[]): { system: string; messages: Array<{ role: "user" | "assistant"; content: Block[] }> } {
  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const out: Array<{ role: "user" | "assistant"; content: Block[] }> = [];
  const push = (role: "user" | "assistant", blocks: Block[]) => {
    if (!blocks.length) return;
    const last = out.at(-1);
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  };
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "user") push("user", m.content ? [{ type: "text", text: m.content }] : []);
    else if (m.role === "tool") push("user", [{ type: "tool_result", tool_use_id: m.toolCallId, content: m.content }]);
    else {
      const blocks: Block[] = m.content ? [{ type: "text", text: m.content }] : [];
      for (const c of m.toolCalls ?? []) {
        let input: unknown = {};
        try { input = JSON.parse(c.arguments || "{}"); } catch { input = {}; }
        blocks.push({ type: "tool_use", id: c.id, name: c.name, input });
      }
      push("assistant", blocks);
    }
  }
  return { system, messages: out };
}

const Event = z.object({
  type: z.string(),
  index: z.number().optional(),
  content_block: z.object({ type: z.string(), id: z.string().optional(), name: z.string().optional() }).optional(),
  delta: z.object({ type: z.string().optional(), text: z.string().optional(), partial_json: z.string().optional(), stop_reason: z.string().nullish() }).optional(),
  message: z.object({ usage: z.object({ input_tokens: z.number() }).optional() }).optional(),
  usage: z.object({ output_tokens: z.number() }).optional(),
  error: z.object({ type: z.string(), message: z.string() }).optional(),
});

const STOP: Record<string, string> = { end_turn: "stop", stop_sequence: "stop", tool_use: "tool_calls", max_tokens: "length", refusal: "content_filter" };

// Folds the stream's events into a result. Pure, so recorded event sequences can be replayed.
export class AnthropicStream {
  text = "";
  private blocks = new Map<number, { id: string; name: string; json: string }>();
  finishReason: string | undefined;
  usage: ChatResult["usage"];
  constructor(private readonly onText?: (d: string) => void) {}
  add(raw: unknown): void {
    const e = Event.safeParse(raw);
    if (!e.success) return;
    const ev = e.data;
    if (ev.type === "error") throw new AppError(ev.error?.type === "overloaded_error" ? "provider-unavailable" : "provider-error", `Anthropic: ${ev.error?.message ?? "the stream failed"}`);
    if (ev.type === "message_start" && ev.message?.usage) this.usage = { inputTokens: ev.message.usage.input_tokens, outputTokens: 0 };
    if (ev.type === "content_block_start" && ev.content_block?.type === "tool_use" && ev.index !== undefined) {
      this.blocks.set(ev.index, { id: ev.content_block.id ?? `tool_${ev.index}`, name: ev.content_block.name ?? "", json: "" });
    }
    if (ev.type === "content_block_delta" && ev.delta) {
      if (ev.delta.type === "text_delta" && ev.delta.text) { this.text += ev.delta.text; this.onText?.(ev.delta.text); }
      if (ev.delta.type === "input_json_delta" && ev.index !== undefined) { const b = this.blocks.get(ev.index); if (b) b.json += ev.delta.partial_json ?? ""; }
    }
    if (ev.type === "message_delta") {
      if (ev.delta?.stop_reason) this.finishReason = STOP[ev.delta.stop_reason] ?? ev.delta.stop_reason;
      if (ev.usage && this.usage) this.usage.outputTokens = ev.usage.output_tokens;
    }
  }
  toolCalls(): ToolCall[] {
    return [...this.blocks.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => ({ id: b.id, name: b.name, arguments: b.json || "{}" }));
  }
}

export class AnthropicProvider implements LlmProvider {
  constructor(private readonly http: Http, private readonly apiKey: string) {}

  private headers(): Record<string, string> {
    return { "x-api-key": this.apiKey, "anthropic-version": VERSION, "content-type": "application/json" };
  }

  private async fail(status: number, body: Buffer, retryAfter?: string | string[]): Promise<never> {
    let detail = "";
    try { const m = (JSON.parse(body.toString("utf8")) as { error?: { message?: string } }).error?.message; if (m) detail = `: ${m}`; } catch { /* not JSON */ }
    const ra = Number(Array.isArray(retryAfter) ? retryAfter[0] : retryAfter);
    const retryAfterMs = Number.isFinite(ra) ? Math.ceil(ra * 1000) : undefined;
    if (status === 401 || status === 403) throw new AppError("provider-auth", `Anthropic rejected the API key${detail}`);
    if (status === 429) throw new AppError("provider-rate-limit", `Anthropic's rate limit was reached${detail}`, { retryAfterMs });
    if ([500, 502, 503, 504, 529].includes(status)) throw new AppError("provider-unavailable", `Anthropic is overloaded or down right now (${status}${detail})`, { retryAfterMs });
    throw new AppError("provider-error", `Anthropic answered ${status}${detail}`);
  }

  async listModels(): Promise<string[]> {
    const res = await this.http.request(`${BASE}/models?limit=100`, { allowHosts: [ANTHROPIC_HOST], headers: this.headers(), timeoutMs: 20_000 });
    const body = await readAll(res.body);
    if (res.status !== 200) return this.fail(res.status, body, res.headers["retry-after"]);
    const parsed = z.object({ data: z.array(z.object({ id: z.string() })) }).safeParse(JSON.parse(body.toString("utf8")));
    if (!parsed.success) throw new AppError("provider-format", "Anthropic sent a model list packsmith couldn't read.");
    return parsed.data.data.map((m) => m.id);
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    const { system, messages } = toAnthropic(req.messages);
    const body = JSON.stringify({
      model: req.model, max_tokens: 8192, stream: true, ...(system ? { system } : {}), messages,
      ...(req.tools.length ? { tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })) } : {}),
    });
    const res = await this.http.request(`${BASE}/messages`, { method: "POST", body, allowHosts: [ANTHROPIC_HOST], headers: this.headers(), timeoutMs: 180_000, maxBytes: 32 * 1024 * 1024, signal: req.signal });
    if (res.status !== 200) return this.fail(res.status, await readAll(res.body), res.headers["retry-after"]);
    if (req.signal.aborted) { res.body.destroy(); throw new AppError("stopped", "Stopped."); }
    const onAbort = () => res.body.destroy(new AppError("stopped", "Stopped."));
    req.signal.addEventListener("abort", onAbort, { once: true });
    const s = new AnthropicStream(req.onText);
    try {
      for await (const data of sseData(res.body)) {
        let json: unknown;
        try { json = JSON.parse(data); } catch { continue; }
        s.add(json);
      }
    } catch (err) {
      if (req.signal.aborted) throw new AppError("stopped", "Stopped.");
      if (err instanceof AppError) throw err;
      throw new AppError("network", `Lost the connection to Anthropic: ${(err as Error).message}`, { cause: err });
    } finally {
      req.signal.removeEventListener("abort", onAbort);
    }
    return { text: s.text, toolCalls: s.toolCalls(), usage: s.usage, finishReason: s.finishReason };
  }
}
