import { describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import { sseData, ToolCallAccumulator } from "../src/main/providers/sse";
import { OpenAiCompatProvider } from "../src/main/providers/openaiCompat";
import type { Http } from "../src/main/net/http";
import type { GuardOptions } from "../src/main/net/guard";

async function collect(chunks: string[]): Promise<string[]> {
  const out: string[] = [];
  for await (const d of sseData(Readable.from(chunks.map((c) => Buffer.from(c))))) out.push(d);
  return out;
}

describe("SSE parsing", () => {
  it("joins events split across network chunks and ignores non-data lines", async () => {
    expect(await collect(["data: {\"a\"", ":1}\n\n: keep-alive\nda", "ta: [DONE]\n"])).toEqual(['{"a":1}', "[DONE]"]);
  });
  it("handles CRLF and a final line without newline", async () => {
    expect(await collect(["data: x\r\n", "data: y"])).toEqual(["x", "y"]);
  });
});

describe("tool-call accumulation", () => {
  it("assembles OpenAI-style indexed fragments", () => {
    const a = new ToolCallAccumulator();
    a.add([{ index: 0, id: "c1", function: { name: "search_modrinth", arguments: '{"que' } }]);
    a.add([{ index: 0, function: { arguments: 'ry":"x"}' } }]);
    a.add([{ index: 1, id: "c2", function: { name: "get_project", arguments: "{}" } }]);
    expect(a.result()).toEqual([
      { id: "c1", name: "search_modrinth", arguments: '{"query":"x"}' },
      { id: "c2", name: "get_project", arguments: "{}" },
    ]);
  });
  it("accepts Gemini-style whole calls without an index", () => {
    const a = new ToolCallAccumulator();
    a.add([{ id: "g1", function: { name: "a", arguments: '{"x":1}' } }, { id: "g2", function: { name: "b", arguments: "{}" } }]);
    expect(a.result().map((c) => [c.id, c.name, c.arguments])).toEqual([["g1", "a", '{"x":1}'], ["g2", "b", "{}"]]);
  });
  it("gives ids to calls that arrive without one", () => {
    const a = new ToolCallAccumulator();
    a.add([{ function: { name: "a", arguments: "{}" } }]);
    expect(a.result()[0]!.id).toBe("call_0");
  });
});

function fakeStream(status: number, body: string, seen: Array<{ url: string; opts?: GuardOptions }>): Http {
  return {
    json: async () => ({}),
    request: async (url, opts) => {
      seen.push({ url, opts });
      return { status, headers: {}, url, body: Readable.from([Buffer.from(body)]) };
    },
  };
}

const cfg = { baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", host: "generativelanguage.googleapis.com", apiKey: "AIzaTESTKEY", label: "Gemini" };

describe("OpenAI-compatible provider", () => {
  it("streams text, returns tool calls and usage, and sends a well-formed guarded request", async () => {
    const sse = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: "Look" } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: "ing." } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ id: "g1", function: { name: "search_modrinth", arguments: '{"query":"sodium","mc_version":"1.21.1"}' } }] } }] })}`,
      `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } })}`,
      "data: [DONE]", "",
    ].join("\n");
    const seen: Array<{ url: string; opts?: GuardOptions }> = [];
    const deltas: string[] = [];
    const p = new OpenAiCompatProvider(fakeStream(200, sse, seen), cfg);
    const res = await p.chat({ model: "gemini-x", messages: [{ role: "user", content: "hi" }], tools: [{ name: "search_modrinth", description: "d", parameters: { type: "object" } }], signal: new AbortController().signal, onText: (d) => deltas.push(d) });
    expect(deltas.join("")).toBe("Looking.");
    expect(res.toolCalls).toEqual([{ id: "g1", name: "search_modrinth", arguments: '{"query":"sodium","mc_version":"1.21.1"}' }]);
    expect(res.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(res.finishReason).toBeUndefined(); // this stream never said why it ended
    expect(seen[0]!.url).toBe(`${cfg.baseUrl}/chat/completions`);
    expect(seen[0]!.opts?.allowHosts).toEqual([cfg.host]);
    expect(seen[0]!.opts?.headers?.authorization).toBe("Bearer AIzaTESTKEY");
    const body = JSON.parse(seen[0]!.opts!.body!);
    expect(body).toMatchObject({ model: "gemini-x", stream: true, tool_choice: "auto" });
    expect(body.tools[0]).toEqual({ type: "function", function: { name: "search_modrinth", description: "d", parameters: { type: "object" } } });
  });

  it("keeps Gemini's thought signature from the stream and sends it back unchanged on the next turn", async () => {
    const sig = { google: { thought_signature: "c2lnbmF0dXJlLWJ5dGVz" } };
    const sse = [
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ id: "g1", extra_content: sig, function: { name: "get_project", arguments: '{"project_id":"x"}' } }, { id: "g2", function: { name: "get_project", arguments: '{"project_id":"y"}' } }] } }] })}`,
      "data: [DONE]", "",
    ].join("\n");
    const seen: Array<{ url: string; opts?: GuardOptions }> = [];
    const p = new OpenAiCompatProvider(fakeStream(200, sse, seen), cfg);
    const res = await p.chat({ model: "m", messages: [], tools: [], signal: new AbortController().signal });
    expect(res.toolCalls[0]!.extra).toEqual(sig);
    expect(res.toolCalls[1]!.extra).toBeUndefined(); // only the first parallel call is signed
    await p.chat({ model: "m", messages: [{ role: "assistant", content: "", toolCalls: res.toolCalls }], tools: [], signal: new AbortController().signal });
    const sent = JSON.parse(seen[1]!.opts!.body!).messages[0].tool_calls;
    expect(sent[0].extra_content).toEqual(sig);
    expect("extra_content" in sent[1]).toBe(false);
  });

  it("maps a rejected key to a clear message, reading Gemini's array-shaped error body", async () => {
    const p = new OpenAiCompatProvider(fakeStream(400, JSON.stringify([{ error: { message: "API key not valid." } }]), []), cfg);
    await expect(p.listModels()).rejects.toMatchObject({ code: "provider-error", message: "Gemini answered 400: API key not valid." });
    const q = new OpenAiCompatProvider(fakeStream(401, JSON.stringify({ error: { message: "bad key" } }), []), cfg);
    await expect(q.listModels()).rejects.toMatchObject({ code: "provider-auth", message: "Gemini rejected the API key: bad key" });
  });

  it("reports the finish reason in lower case", async () => {
    const sse = `data: ${JSON.stringify({ choices: [{ delta: { content: "x" }, finish_reason: "STOP" }] })}\ndata: [DONE]\n`;
    const p = new OpenAiCompatProvider(fakeStream(200, sse, []), cfg);
    expect((await p.chat({ model: "m", messages: [], tools: [], signal: new AbortController().signal })).finishReason).toBe("stop");
  });

  it("names an overloaded provider with the reason it gave", async () => {
    const p = new OpenAiCompatProvider(fakeStream(503, JSON.stringify([{ error: { message: "The model is overloaded. Please try again later." } }]), []), cfg);
    await expect(p.chat({ model: "m", messages: [], tools: [], signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: "provider-unavailable", message: "Gemini is overloaded or down right now (503: The model is overloaded. Please try again later.)" });
  });

  it("reads how long Gemini asks to wait after a 429, from details or from the message", async () => {
    const chat = (body: string) => new OpenAiCompatProvider(fakeStream(429, body, []), cfg).chat({ model: "m", messages: [], tools: [], signal: new AbortController().signal });
    // Shape of Gemini's free-tier answer (array body, RetryInfo detail), recorded live 2026-11-03, text trimmed.
    const gemini = JSON.stringify([{ error: { code: 429, message: "You exceeded your current quota. Please retry in 4.644113895s.", details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "4s" }] } }]);
    await expect(chat(gemini)).rejects.toMatchObject({ code: "provider-rate-limit", retryAfterMs: 4_000 });
    await expect(chat(JSON.stringify({ error: { message: "Quota exceeded. Please retry in 4.6s." } }))).rejects.toMatchObject({ retryAfterMs: 4_600 });
    await expect(chat("{}")).rejects.toMatchObject({ retryAfterMs: undefined });
  });

  it("names the rate limit", async () => {
    const p = new OpenAiCompatProvider(fakeStream(429, "{}", []), cfg);
    await expect(p.chat({ model: "m", messages: [], tools: [], signal: new AbortController().signal })).rejects.toMatchObject({ code: "provider-rate-limit" });
  });

  it("lists models without the 'models/' prefix", async () => {
    const p = new OpenAiCompatProvider(fakeStream(200, JSON.stringify({ data: [{ id: "models/gemini-a" }, { id: "gemini-b" }] }), []), cfg);
    expect(await p.listModels()).toEqual(["gemini-a", "gemini-b"]);
  });
});

import { chatModels } from "../src/main/providerControl";
describe("model picker list", () => {
  it("keeps chat models and drops image, speech, transcription and embedding models", () => {
    const all = ["gemini-3.8-flash", "gemini-3.6-flash", "gemini-3.5-flash-lite", "gemini-3.1-pro-preview", "gemini-3.1-pro-preview-customtools",
      "gemini-3-pro-image", "nano-banana-pro-preview", "gemini-3.5-transcribe", "gemini-3.8-flash-tts", "gemini-embedding-001", "gemini-3.8-live", "veo-3", "lyria-3-pro-preview"];
    expect(chatModels(all)).toEqual(["gemini-3.8-flash", "gemini-3.6-flash", "gemini-3.5-flash-lite", "gemini-3.1-pro-preview", "gemini-3.1-pro-preview-customtools"]);
  });
});

describe("Gemini default model", () => {
  it("prefers the model that kept answering on the free tier (gemini-3.5-flash-lite), the 20/day ones as fallbacks", async () => {
    const { PROVIDERS, pickDefaultModel, fallbackModels } = await import("../src/main/providers/catalog");
    const gemini = PROVIDERS.gemini;
    const listed = ["gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.6-flash", "gemini-3.5-flash", "gemini-3.5-flash-lite"];
    expect(pickDefaultModel(gemini, listed)).toBe("gemini-3.5-flash-lite");
    expect(fallbackModels(gemini, listed, "gemini-3.5-flash-lite")).toEqual(["gemini-3.5-flash", "gemini-3.8-flash", "gemini-3.6-flash"]);
  });
});
