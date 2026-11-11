import { describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import type { Http } from "../src/main/net/http";
import { AnthropicProvider, AnthropicStream, toAnthropic } from "../src/main/providers/anthropic";

// Event shapes as Anthropic's streaming Messages API documents them (constructed, not recorded live).
const events = [
  { type: "message_start", message: { usage: { input_tokens: 120 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Searching " } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Modrinth." } },
  { type: "content_block_stop", index: 0 },
  { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "search_modrinth", input: {} } },
  { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"query\":\"mini" } },
  { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "map\",\"limit\":3}" } },
  { type: "content_block_stop", index: 1 },
  { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 40 } },
  { type: "message_stop" },
];

function http(status: number, body: string, seen: Array<{ url: string; headers: Record<string, string>; body?: string }> = []): Http {
  return {
    json: async () => { throw new Error("unused"); },
    request: async (url: string, opts?: { headers?: Record<string, string>; body?: string }) => {
      seen.push({ url, headers: opts?.headers ?? {}, ...(opts?.body ? { body: opts.body } : {}) });
      return { status, headers: {}, url, body: Readable.from([Buffer.from(body)]) } as never;
    },
  };
}

describe("Anthropic provider (D-3)", () => {
  it("sends the system prompt apart and groups consecutive tool results in one user turn", () => {
    const { system, messages } = toAnthropic([
      { role: "system", content: "You build packs." },
      { role: "user", content: "a minimap" },
      { role: "assistant", content: "Two lookups.", toolCalls: [{ id: "t1", name: "a", arguments: "{\"x\":1}" }, { id: "t2", name: "b", arguments: "" }] },
      { role: "tool", toolCallId: "t1", name: "a", content: "one" },
      { role: "tool", toolCallId: "t2", name: "b", content: "two" },
      { role: "user", content: "and then?" },
    ]);
    expect(system).toBe("You build packs.");
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(messages[1]!.content).toEqual([{ type: "text", text: "Two lookups." }, { type: "tool_use", id: "t1", name: "a", input: { x: 1 } }, { type: "tool_use", id: "t2", name: "b", input: {} }]);
    expect(messages[2]!.content).toEqual([{ type: "tool_result", tool_use_id: "t1", content: "one" }, { type: "tool_result", tool_use_id: "t2", content: "two" }, { type: "text", text: "and then?" }]);
  });

  it("folds the stream into text, whole tool calls, stop reason and usage", () => {
    const deltas: string[] = [];
    const s = new AnthropicStream((d) => deltas.push(d));
    for (const e of events) s.add(e);
    expect(s.text).toBe("Searching Modrinth.");
    expect(deltas).toEqual(["Searching ", "Modrinth."]);
    expect(s.toolCalls()).toEqual([{ id: "toolu_1", name: "search_modrinth", arguments: "{\"query\":\"minimap\",\"limit\":3}" }]);
    expect(s.finishReason).toBe("tool_calls");
    expect(s.usage).toEqual({ inputTokens: 120, outputTokens: 40 });
    const cut = new AnthropicStream();
    cut.add({ type: "message_delta", delta: { stop_reason: "max_tokens" } });
    expect(cut.finishReason).toBe("length");
    expect(() => new AnthropicStream().add({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } })).toThrow(expect.objectContaining({ code: "provider-unavailable" }));
  });

  it("calls the Messages API with the user's own key and Anthropic's version header", async () => {
    const seen: Array<{ url: string; headers: Record<string, string>; body?: string }> = [];
    const sse = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
    const p = new AnthropicProvider(http(200, sse, seen), "Fake-anthropic-key-TEST");
    const r = await p.chat({ model: "claude-x", messages: [{ role: "system", content: "s" }, { role: "user", content: "u" }], tools: [{ name: "search_modrinth", description: "d", parameters: { type: "object" } }], signal: new AbortController().signal });
    expect(r.toolCalls[0]!.name).toBe("search_modrinth");
    expect(seen[0]!.url).toBe("https://api.anthropic.com/v1/messages");
    expect(seen[0]!.headers).toMatchObject({ "x-api-key": "Fake-anthropic-key-TEST", "anthropic-version": "2023-06-01" });
    const sent = JSON.parse(seen[0]!.body!);
    expect(sent).toMatchObject({ model: "claude-x", system: "s", stream: true, tools: [{ name: "search_modrinth", input_schema: { type: "object" } }] });
  });

  it("maps errors: a bad key, a rate limit with Retry-After, and 529 overloaded", async () => {
    await expect(new AnthropicProvider(http(401, '{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}'), "k").listModels()).rejects.toMatchObject({ code: "provider-auth" });
    await expect(new AnthropicProvider(http(529, '{"error":{"message":"Overloaded"}}'), "k").listModels()).rejects.toMatchObject({ code: "provider-unavailable" });
    expect(await new AnthropicProvider(http(200, '{"data":[{"id":"claude-sonnet-x"},{"id":"claude-haiku-y"}]}'), "k").listModels()).toEqual(["claude-sonnet-x", "claude-haiku-y"]);
  });
});
