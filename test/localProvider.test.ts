import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { localEndpointHttp, parseLocalEndpoint } from "../src/main/net/local";
import { OpenAiCompatProvider } from "../src/main/providers/openaiCompat";
import { ProviderControl } from "../src/main/providerControl";
import { KeyStore } from "../src/main/keys";
import { SettingsStore } from "../src/main/settings";

let server: Server;
let base = "";
const hits: string[] = [];
beforeAll(async () => {
  server = createServer((req, res) => {
    hits.push(`${req.method} ${req.url} auth=${req.headers.authorization ?? "-"}`);
    if (req.url === "/v1/models") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ data: [{ id: "qwen-9b" }, { id: "nomic-embed-text" }] })); return; }
    if (req.url === "/v1/hang/chat/completions") return; // never answers: a provider stuck on a request
    if (req.url === "/v1/redirect/models") { res.statusCode = 302; res.setHeader("location", "https://example.com/"); res.end(); return; }
    res.statusCode = 404; res.end("no");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("local model endpoint: the one HTTP-guard exception (SPEC 8.5)", () => {
  it("accepts loopback and LAN addresses only, never link-local, cloud metadata or the internet", () => {
    for (const ok of ["http://127.0.0.1:11434/v1", "http://localhost:1234/v1/", "http://192.168.1.20:11434/v1", "http://10.0.0.5:8080", "http://[::1]:11434/v1"]) expect(() => parseLocalEndpoint(ok)).not.toThrow();
    for (const bad of ["http://169.254.169.254/latest", "http://example.com/v1", "http://8.8.8.8/v1", "http://[fe80::1]/v1", "ftp://127.0.0.1/", "http://user:pw@127.0.0.1/v1", "http://127.0.0.1/v1?x=1", "not a url"]) expect(() => parseLocalEndpoint(bad)).toThrow();
    expect(parseLocalEndpoint("http://localhost:1234/v1/").pathname).toBe("/v1");
  });

  it("Stop ends a request the provider never answers, at once, as a stop (not a timeout)", async () => {
    // Live 2026-11-10: Gemini hung for the full 180 s per attempt and Stop waited for it.
    const url = parseLocalEndpoint(`${base}/hang`);
    const provider = new OpenAiCompatProvider(localEndpointHttp(url), { baseUrl: `${base}/hang`, host: url.hostname, apiKey: "", label: "The local model" });
    const stop = new AbortController();
    const started = Date.now();
    const call = provider.chat({ model: "m", messages: [{ role: "user", content: "hi" }], tools: [], signal: stop.signal });
    setTimeout(() => stop.abort(), 100);
    await expect(call).rejects.toMatchObject({ code: "stopped" });
    expect(Date.now() - started).toBeLessThan(2_000);
    await expect(localEndpointHttp(url).request(`${base}/hang/chat/completions`, { signal: stop.signal })).rejects.toMatchObject({ code: "stopped" });
    await expect(localEndpointHttp(url).request(`${base}/hang/chat/completions`, { timeoutMs: 100 })).rejects.toMatchObject({ code: "network" });
  });

  it("reaches only the configured address and path, and never follows a redirect", async () => {
    const http = localEndpointHttp(parseLocalEndpoint(base));
    const res = await http.request(`${base}/models`);
    expect(res.status).toBe(200);
    await expect(http.request(`${base.replace("/v1", "")}/admin`)).rejects.toMatchObject({ code: "blocked-url" });
    await expect(http.request("https://example.com/v1/models")).rejects.toMatchObject({ code: "blocked-url" });
    await expect(localEndpointHttp(parseLocalEndpoint(`${base}/redirect`)).request(`${base}/redirect/models`)).rejects.toThrow(/redirect/);
  });

  it("connects by address with no key, offers chat models only, and runs the agent against it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "packsmith-local-"));
    try {
      const keys = new KeyStore(dir, { isEncryptionAvailable: async () => true, backend: () => "gnome_libsecret", encrypt: async (s) => Buffer.from(s), decrypt: async (b) => ({ result: b.toString(), shouldReEncrypt: false }) });
      const pc = new ProviderControl({ json: async () => { throw new Error("no public HTTP expected"); }, request: async () => { throw new Error("no public HTTP expected"); } }, keys, new SettingsStore(dir));
      const picked = await pc.setProvider("ollama");
      expect(picked).toMatchObject({ provider: "ollama", hasKey: false }); // the address is never guessed
      expect(await pc.forAgent()).toBeNull();
      await expect(pc.setLocalEndpoint("http://example.com/v1")).rejects.toMatchObject({ code: "bad-endpoint" });
      hits.length = 0;
      const st = await pc.setLocalEndpoint(base);
      expect(st).toMatchObject({ provider: "ollama", hasKey: true, endpoint: base, models: ["qwen-9b"], model: "qwen-9b" });
      expect(hits[0]).toBe("GET /v1/models auth=-"); // no empty Bearer header
      const a = await pc.forAgent();
      expect(a?.model).toBe("qwen-9b");
      expect(await keys.has("ollama")).toBe(false); // nothing secret stored
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
