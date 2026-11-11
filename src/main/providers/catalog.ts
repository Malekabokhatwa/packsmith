// The providers the user can pick, with honest cost lines shown BEFORE connecting (spec 8.2:
// anything that can bill money is named before it can bill money). Most speak the OpenAI-compatible
// protocol (openaiCompat.ts); Anthropic has its own (anthropic.ts); local models are LOCAL below.
// No prices are written here: they change, and the pricing link is the source.
export type CompatProviderId = "gemini" | "deepseek" | "openrouter" | "openai" | "anthropic";

export interface ProviderInfo {
  id: CompatProviderId;
  label: string;
  baseUrl: string;
  host: string;
  cost: string;
  pricingUrl: string;
  keyUrl: string;
  keyHint: string;            // placeholder of the key field
  preferredModels: string[];  // first one the account actually offers becomes the default
  chatModel: RegExp;          // which listed models are chat models worth offering
}

export const PROVIDERS: Record<CompatProviderId, ProviderInfo> = {
  gemini: {
    id: "gemini",
    label: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    host: "generativelanguage.googleapis.com",
    cost: "Free tier available with daily limits; no card needed. On the free tier Google may use your prompts to improve its products.",
    pricingUrl: "https://ai.google.dev/gemini-api/docs/pricing",
    keyUrl: "https://aistudio.google.com/apikey",
    keyHint: "Paste your Gemini API key",
    // Free-tier daily limits decide the order (2026-11-10): gemini-3.5-flash and 3.6-3.8 Flash were
    // counted in 20-a-day buckets; gemini-3.5-flash-lite kept answering (tool calls and all) after
    // those ran out, so it leads. The rest are fallbacks when it's busy.
    preferredModels: ["gemini-3.5-flash-lite", "gemini-3.5-flash", "gemini-3.8-flash", "gemini-3.6-flash", "gemini-2.5-flash"],
    chatModel: /gemini/,
  },
  deepseek: {
    id: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    host: "api.deepseek.com",
    cost: "Pay per use from a prepaid balance; among the cheapest capable models. No free tier.",
    pricingUrl: "https://api-docs.deepseek.com/quick_start/pricing",
    keyUrl: "https://platform.deepseek.com/api_keys",
    keyHint: "Paste your DeepSeek API key",
    preferredModels: ["deepseek-chat"],
    chatModel: /deepseek/,
  },
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    host: "openrouter.ai",
    cost: "One key for many models. Paid models bill per use from your credits; models marked free cost nothing but have tight rate limits.",
    pricingUrl: "https://openrouter.ai/models",
    keyUrl: "https://openrouter.ai/settings/keys",
    keyHint: "Paste your OpenRouter API key",
    preferredModels: ["deepseek/deepseek-chat", "google/gemini-2.5-flash"],
    chatModel: /\//,
  },
  anthropic: {
    id: "anthropic",
    label: "Anthropic Claude",
    baseUrl: "https://api.anthropic.com/v1",
    host: "api.anthropic.com",
    cost: "Pay per use with your own Anthropic API key, billed to your Anthropic Console account. A Claude.ai subscription can't be used here.",
    pricingUrl: "https://www.anthropic.com/pricing#api",
    keyUrl: "https://console.anthropic.com/settings/keys",
    keyHint: "Paste your Anthropic API key",
    preferredModels: [],
    chatModel: /^claude-/,
  },
  openai: {
    id: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    host: "api.openai.com",
    cost: "Pay per use, billed to your OpenAI account. No free tier for the API.",
    pricingUrl: "https://openai.com/api/pricing",
    keyUrl: "https://platform.openai.com/api-keys",
    keyHint: "Paste your OpenAI API key",
    preferredModels: [],
    chatModel: /^(gpt-|o\d)/,
  },
};

export const PROVIDER_ORDER: CompatProviderId[] = ["gemini", "deepseek", "openrouter", "anthropic", "openai"];

// A model server on this computer or the LAN (Ollama, LM Studio): same protocol, the user's own
// address (the HTTP-guard exception, SPEC 8.5), no key, no bill.
export const LOCAL = {
  id: "ollama" as const,
  label: "Local model (Ollama, LM Studio)",
  cost: "Free and offline: runs on your own computer. Small local models are much weaker at building packs than the hosted ones.",
  pricingUrl: "https://ollama.com",
  keyUrl: "https://lmstudio.ai",
  keyHint: "http://127.0.0.1:11434/v1 for Ollama, http://127.0.0.1:1234/v1 for LM Studio",
};

export function pickDefaultModel(info: ProviderInfo, available: string[]): string | undefined {
  return info.preferredModels.find((m) => available.includes(m))
    ?? available.find((m) => /flash|chat|mini|sonnet/.test(m) && !/(image|tts|live|audio|embed|realtime|search)/.test(m))
    ?? available[0];
}

// Other models to try, in order, when the chosen one stays overloaded (free-tier spikes).
export function fallbackModels(info: ProviderInfo, available: string[], chosen: string): string[] {
  return info.preferredModels.filter((m) => m !== chosen && available.includes(m));
}
