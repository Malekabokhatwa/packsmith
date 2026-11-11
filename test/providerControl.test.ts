import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { Http } from "../src/main/net/http";
import { KeyStore } from "../src/main/keys";
import { SettingsStore } from "../src/main/settings";
import { ProviderControl, chatModels } from "../src/main/providerControl";
import { PROVIDERS } from "../src/main/providers/catalog";

// Each provider's /models answers with its own list; the request's host and key are recorded.
function http(lists: Record<string, string[]>): Http & { seen: Array<{ host: string; auth: string }> } {
  const seen: Array<{ host: string; auth: string }> = [];
  return {
    seen,
    json: async () => { throw new Error("unused"); },
    request: async (url: string, opts?: { headers?: Record<string, string> }) => {
      const host = new URL(url).host;
      seen.push({ host, auth: opts?.headers?.authorization ?? "" });
      const ids = lists[host];
      return { status: ids ? 200 : 401, headers: {}, body: Readable.from([Buffer.from(JSON.stringify(ids ? { data: ids.map((id) => ({ id })) } : { error: { message: "bad key" } }))]) } as never;
    },
  };
}
const crypto = { isEncryptionAvailable: async () => true, backend: () => "gnome_libsecret", encrypt: async (s: string) => Buffer.from(s.split("").reverse().join("")), decrypt: async (b: Buffer) => ({ result: b.toString().split("").reverse().join(""), shouldReEncrypt: false }) };

describe("provider choice (D-3, S10)", () => {
  it("switches provider with its own key and models; switching back keeps the first key", async () => {
    const dir = await mkdtemp(join(tmpdir(), "packsmith-prov-"));
    try {
      const h = http({ "generativelanguage.googleapis.com": ["gemini-3.8-flash", "gemini-embedding-001"], "api.deepseek.com": ["deepseek-chat", "deepseek-reasoner"] });
      const keys = new KeyStore(dir, crypto);
      const settings = new SettingsStore(dir);
      const pc = new ProviderControl(h, keys, settings);
      expect((await pc.status()).provider).toBe("gemini"); // default
      await pc.setKey("Fake-gemini-key-TEST-123");
      expect((await pc.status())).toMatchObject({ provider: "gemini", hasKey: true, model: "gemini-3.8-flash", models: ["gemini-3.8-flash"] });

      const ds = await pc.setProvider("deepseek");
      expect(ds).toMatchObject({ provider: "deepseek", label: "DeepSeek", hasKey: false, keyHint: "Paste your DeepSeek API key" });
      expect(ds.choices.map((c) => c.id)).toEqual(["gemini", "deepseek", "openrouter", "anthropic", "openai", "ollama"]);
      expect(await pc.forAgent()).toBeNull(); // no DeepSeek key yet: the agent can't start
      await pc.setKey("Fake-deepseek-key-TEST-456");
      const a = await pc.forAgent();
      expect(a).toMatchObject({ model: "deepseek-chat", key: "Fake-deepseek-key-TEST-456" });
      expect(h.seen.at(-1)).toEqual({ host: "api.deepseek.com", auth: "Bearer Fake-deepseek-key-TEST-456" });

      const back = await pc.setProvider("gemini");
      expect(back).toMatchObject({ provider: "gemini", hasKey: true, model: "gemini-3.8-flash" });
      expect((await pc.forAgent())?.key).toBe("Fake-gemini-key-TEST-123");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("a rejected key is never saved", async () => {
    const dir = await mkdtemp(join(tmpdir(), "packsmith-prov-"));
    try {
      const keys = new KeyStore(dir, crypto);
      const pc = new ProviderControl(http({}), keys, new SettingsStore(dir));
      await pc.setProvider("openai");
      await expect(pc.setKey("Fake-openai-key-TEST-789")).rejects.toThrow();
      expect(await keys.has("openai")).toBe(false);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("offers each provider's chat models only", () => {
    expect(chatModels(["gpt-5", "gpt-5-mini", "o4", "text-embedding-3", "dall-e-3", "whisper-1", "gpt-realtime"], PROVIDERS.openai)).toEqual(["gpt-5", "gpt-5-mini", "o4"]);
    expect(chatModels(["deepseek/deepseek-chat", "openai/gpt-5", "router-auto"], PROVIDERS.openrouter)).toEqual(["deepseek/deepseek-chat", "openai/gpt-5"]);
  });
});
