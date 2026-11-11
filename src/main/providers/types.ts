// M-10 provider layer: the agent talks to every model through this interface (spec D-3).

export interface ToolCall {
  id: string;
  name: string;
  arguments: string; // raw JSON text from the model; the runtime validates it (spec 5.1)
  // Provider data that must be sent back unchanged on the next turn, e.g. Gemini's
  // extra_content.google.thought_signature. Opaque: never parsed, never edited.
  extra?: unknown;
}

export type Message =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string };

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}

export interface ChatRequest {
  model: string;
  messages: Message[];
  tools: ToolSpec[];
  signal: AbortSignal;
  onText?: (delta: string) => void;
}

export interface ChatResult {
  text: string;
  toolCalls: ToolCall[];
  // "stop" | "tool_calls" | "length" | "content_filter" | ...; undefined = the stream ended
  // without saying why, which is treated as cut off.
  finishReason?: string;
  usage?: { inputTokens: number; outputTokens: number };
}

export interface LlmProvider {
  chat(req: ChatRequest): Promise<ChatResult>;
  listModels(): Promise<string[]>;
}
