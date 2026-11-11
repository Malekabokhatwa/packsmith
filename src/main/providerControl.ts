// Settings-side control of the AI provider: pick a provider, store/test its key, choose the model,
// and build the provider the agent uses. A key is only saved after the provider accepted it (key
// test, UX-1). Each provider keeps its own key in the keyring, so switching back needs no re-paste.
import type { ProviderStatus } from "@shared/agent";
import type { Http } from "./net/http";
import type { KeyStore } from "./keys";
import type { SettingsStore } from "./settings";
import { OpenAiCompatProvider } from "./providers/openaiCompat";
import { LOCAL, PROVIDERS, PROVIDER_ORDER, fallbackModels, pickDefaultModel, type CompatProviderId, type ProviderInfo } from "./providers/catalog";
import { localEndpointHttp, parseLocalEndpoint } from "./net/local";
import { AnthropicProvider } from "./providers/anthropic";
import type { LlmProvider } from "./providers/types";
import { AppError } from "./errors";

// Only chat models belong in the picker and the fallback list: drop image, speech,
// transcription, video, music and embedding models.
export function chatModels(models: string[], info?: ProviderInfo): string[] {
  return models.filter((m) => !/(embed|image|tts|audio|live|imagen|veo|aqa|robotics|banana|transcribe|lyria|whisper|dall-e|moderation|realtime)/.test(m) && (!info || info.chatModel.test(m)));
}

export class ProviderControl {
  private models: string[] = [];
  private modelsFor: CompatProviderId | "ollama" | null = null;
  constructor(
    private readonly http: Http,
    private readonly keys: KeyStore,
    private readonly settings: SettingsStore,
    private readonly fake?: LlmProvider, // tests only (PACKSMITH_FAKE_PROVIDER)
    private readonly fakeNeedsKey = false, // tests only (PACKSMITH_FAKE_NEEDS_KEY): walk the first-run path
  ) {}
  private fakeKeySet = false;
  private get fakeReady(): boolean { return Boolean(this.fake) && (!this.fakeNeedsKey || this.fakeKeySet); }

  private async isLocal(): Promise<boolean> { return (await this.settings.get()).provider?.id === "ollama"; }

  private async local(): Promise<{ url: URL; provider: OpenAiCompatProvider } | null> {
    const ep = (await this.settings.get()).provider?.localEndpoint;
    if (!ep) return null;
    const url = parseLocalEndpoint(ep);
    return { url, provider: new OpenAiCompatProvider(localEndpointHttp(url), { baseUrl: `${url.origin}${url.pathname}`, host: url.hostname, apiKey: "", label: "The local model" }) };
  }

  private choices(): ProviderStatus["choices"] {
    return [...PROVIDER_ORDER.map((id) => ({ id, label: PROVIDERS[id].label, cost: PROVIDERS[id].cost })), { id: LOCAL.id, label: LOCAL.label, cost: LOCAL.cost }];
  }

  // The provider picked in Settings; one packsmith can't drive yet falls back to Gemini.
  private async active(): Promise<ProviderInfo> {
    const id = (await this.settings.get()).provider?.id;
    return id && id in PROVIDERS ? PROVIDERS[id as CompatProviderId] : PROVIDERS.gemini;
  }

  private build(info: ProviderInfo, key: string): LlmProvider {
    if (info.id === "anthropic") return new AnthropicProvider(this.http, key);
    return new OpenAiCompatProvider(this.http, { baseUrl: info.baseUrl, host: info.host, apiKey: key, label: info.label });
  }

  async status(): Promise<ProviderStatus> {
    if (!this.fake && await this.isLocal()) return this.localStatus();
    const info = await this.active();
    const s = await this.settings.get();
    if (this.modelsFor !== info.id) { this.models = []; this.modelsFor = info.id; }
    const hasKey = this.fake ? this.fakeReady : await this.keys.has(info.id);
    if (hasKey && this.models.length === 0) {
      try {
        this.models = chatModels(this.fake ? await this.fake.listModels() : await this.build(info, (await this.keys.get(info.id))!).listModels(), this.fake ? undefined : info);
      } catch { /* offline: show the saved model only */ }
    }
    return {
      provider: info.id, label: info.label, cost: info.cost, pricingUrl: info.pricingUrl, keyUrl: info.keyUrl, keyHint: info.keyHint,
      hasKey, persistent: this.fake ? true : await this.keys.persistent(),
      model: s.provider?.id === info.id || (!s.provider && info.id === "gemini") ? (s.provider?.model ?? (this.fake ? this.models[0] : undefined)) : undefined,
      models: this.models,
      choices: this.choices(),
    };
  }

  private async localStatus(): Promise<ProviderStatus> {
    const s = await this.settings.get();
    const l = await this.local().catch(() => null);
    if (l && (this.modelsFor !== "ollama" || this.models.length === 0)) {
      this.modelsFor = "ollama";
      try { this.models = chatModels(await l.provider.listModels()); } catch { this.models = []; }
    }
    return {
      provider: "ollama", label: LOCAL.label, cost: LOCAL.cost, pricingUrl: LOCAL.pricingUrl, keyUrl: LOCAL.keyUrl, keyHint: LOCAL.keyHint,
      hasKey: Boolean(l), persistent: true, model: s.provider?.model || undefined, models: this.models,
      ...(l ? { endpoint: `${l.url.origin}${l.url.pathname}` } : {}), choices: this.choices(),
    };
  }

  // The local server's address, typed by the user: tested by listing its models, then saved.
  async setLocalEndpoint(endpoint: string): Promise<ProviderStatus> {
    const url = parseLocalEndpoint(endpoint);
    const provider = new OpenAiCompatProvider(localEndpointHttp(url), { baseUrl: `${url.origin}${url.pathname}`, host: url.hostname, apiKey: "", label: "The local model" });
    const models = chatModels(await provider.listModels());
    if (!models.length) throw new AppError("no-models", "The local server answered but has no chat model. Download or load one in Ollama or LM Studio, then try again.");
    this.models = models; this.modelsFor = "ollama";
    await this.settings.update((s) => ({ ...s, provider: { id: "ollama", model: models[0]!, localEndpoint: `${url.origin}${url.pathname}` } }));
    return this.status();
  }

  // Switch provider: its own key (if one was saved before) and its own models; nothing is deleted.
  async setProvider(id: CompatProviderId | "ollama"): Promise<ProviderStatus> {
    if (id === "ollama") {
      const prev = (await this.settings.get()).provider;
      this.models = []; this.modelsFor = null;
      // The address is never guessed: kept only if the user set it before.
      await this.settings.update((s) => ({ ...s, provider: { id: "ollama", model: prev?.id === "ollama" ? prev.model : "", ...(prev?.id === "ollama" && prev.localEndpoint ? { localEndpoint: prev.localEndpoint } : {}) } }));
      return this.status();
    }
    const info = PROVIDERS[id];
    this.models = []; this.modelsFor = id;
    const key = this.fake ? null : await this.keys.get(id);
    let model: string | undefined;
    if (key) {
      this.models = chatModels(await this.build(info, key).listModels().catch(() => []), info);
      model = pickDefaultModel(info, this.models);
    }
    await this.settings.update((s) => ({ ...s, provider: { id, model: model ?? "" } }));
    return this.status();
  }

  async setKey(key: string): Promise<ProviderStatus> {
    if (this.fake) { this.fakeKeySet = true; this.models = await this.fake.listModels(); return this.status(); }
    const info = await this.active();
    const models = await this.build(info, key).listModels(); // throws a clear error if the key is rejected
    const chat = chatModels(models, info);
    const model = pickDefaultModel(info, chat);
    if (!model) throw new AppError("no-models", `The key works, but ${info.label} offered no chat models for it.`);
    await this.keys.set(info.id, key);
    this.models = chat; this.modelsFor = info.id;
    await this.settings.update((s) => ({ ...s, provider: { id: info.id, model } }));
    return this.status();
  }

  async clearKey(): Promise<ProviderStatus> {
    if (await this.isLocal()) {
      await this.settings.update((s) => ({ ...s, provider: { id: "ollama", model: "" } }));
      this.models = [];
      return this.status();
    }
    await this.keys.clear((await this.active()).id);
    this.models = [];
    return this.status();
  }

  async setModel(model: string): Promise<ProviderStatus> {
    if (this.models.length && !this.models.includes(model)) throw new AppError("bad-model", `${model} isn't offered for this key.`);
    if (await this.isLocal()) {
      await this.settings.update((s) => ({ ...s, provider: { ...s.provider!, model } }));
      return this.status();
    }
    const info = await this.active();
    await this.settings.update((s) => ({ ...s, provider: { id: info.id, model } }));
    return this.status();
  }

  async forAgent(): Promise<{ provider: LlmProvider; model: string; fallbacks: string[]; key: string } | null> {
    if (this.fake) {
      if (!this.fakeReady) return null;
      const models = await this.fake.listModels();
      return { provider: this.fake, model: models[0]!, fallbacks: models.slice(1), key: "" };
    }
    if (await this.isLocal()) {
      const l = await this.local();
      const model = (await this.settings.get()).provider?.model;
      if (!l) return null;
      if (!model) throw new AppError("no-model", "Pick a model in Settings first.");
      return { provider: l.provider, model, fallbacks: [], key: "" };
    }
    const info = await this.active();
    const key = await this.keys.get(info.id);
    if (!key) return null;
    const model = (await this.settings.get()).provider?.model;
    if (!model) throw new AppError("no-model", "Pick a model in Settings first.");
    const provider = this.build(info, key);
    if (this.models.length === 0 || this.modelsFor !== info.id) { this.models = chatModels(await provider.listModels().catch(() => []), info); this.modelsFor = info.id; }
    return { provider, model, fallbacks: fallbackModels(info, this.models, model), key };
  }
}
