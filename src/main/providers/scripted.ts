// Deterministic provider for tests (spec 8.2: provider tests use mocks, never live calls).
// Enabled only when PACKSMITH_FAKE_PROVIDER points at a script file. Each chat() call plays the
// next turn: streamed text, then tool calls.
import { readFileSync } from "node:fs";
import { z } from "zod";
import { AppError } from "../errors";
import type { ChatRequest, ChatResult, LlmProvider } from "./types";

const Script = z.object({
  models: z.array(z.string()).default(["scripted-model"]),
  delayMs: z.number().default(15),
  turns: z.array(z.object({
    text: z.string().default(""),
    finishReason: z.string().optional(),
    toolCalls: z.array(z.object({ name: z.string(), arguments: z.unknown() })).default([]),
  })),
});
export type Script = z.input<typeof Script>; // what callers write; defaults fill the rest

export class ScriptedProvider implements LlmProvider {
  private turn = 0;
  readonly script: z.output<typeof Script>;
  constructor(script: Script | string) {
    this.script = typeof script === "string" ? Script.parse(JSON.parse(readFileSync(script, "utf8"))) : Script.parse(script);
  }
  async listModels(): Promise<string[]> {
    return this.script.models;
  }
  async chat(req: ChatRequest): Promise<ChatResult> {
    const t = this.script.turns[this.turn++] ?? { text: "(script ended)", toolCalls: [], finishReason: "stop" };
    for (let i = 0; i < t.text.length; i += 12) {
      if (req.signal.aborted) throw new AppError("stopped", "Stopped.");
      req.onText?.(t.text.slice(i, i + 12));
      await new Promise((r) => setTimeout(r, this.script.delayMs));
    }
    if (req.signal.aborted) throw new AppError("stopped", "Stopped.");
    return {
      finishReason: t.finishReason ?? (t.toolCalls.length ? "tool_calls" : "stop"),
      text: t.text,
      toolCalls: t.toolCalls.map((c, i) => ({ id: `call_${this.turn}_${i}`, name: c.name, arguments: typeof c.arguments === "string" ? c.arguments : JSON.stringify(c.arguments) })),
    };
  }
}
