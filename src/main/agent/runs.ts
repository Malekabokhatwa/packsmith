// Starts agent runs for chats, streams their events to the renderer, persists the chat as the
// run progresses, and stops runs on request (spec 5.3: STOP halts mid-loop).
import type { WebTools } from "../search/web";
import type { ToolContext } from "./tools";
import { randomBytes } from "node:crypto";
import type { Plan, RunEnvelope, RunEvent, Selectors, Step } from "@shared/agent";
import type { TestReport } from "@shared/schema";
import type { LlmProvider } from "../providers/types";
import type { Packs } from "../instances/manager";
import type { Quests } from "../quests/service";
import type { ModrinthClient } from "../sources/modrinth";
import type { SettingsStore } from "../settings";
import type { Tester } from "../testing/service";
import { ChatStore, newChatId, titleFrom, type StoredChat } from "../chats/store";
import { runAgent } from "./runtime";
import { TOOLS } from "./tools";
import { systemPrompt, userContext } from "./prompt";
import { AppError } from "../errors";

export interface RunsDeps {
  chats: ChatStore;
  packs: Packs;
  quests?: Quests;
  tester?: Tester;
  adoptions?: ToolContext["adoptions"];
  modrinth: ModrinthClient;
  settings: SettingsStore;
  redact: (s: string) => string;
  web?: () => Promise<WebTools>;
  provider: () => Promise<{ provider: LlmProvider; model: string; fallbacks?: string[] } | null>;
  send: (env: RunEnvelope) => void;
  contextBudget?: number; // test hook (PACKSMITH_CONTEXT_BUDGET): force the chat-full state
}

export class Runs {
  private active = new Map<string, { controller: AbortController; chatId: string; chat: StoredChat; seq: () => number; pause?: boolean }>();
  constructor(private readonly d: RunsDeps) {}

  isRunning(chatId: string): boolean {
    return this.activeRunFor(chatId) !== undefined;
  }

  activeRunFor(chatId: string): string | undefined {
    for (const [runId, r] of this.active) if (r.chatId === chatId) return runId;
    return undefined;
  }

  // The in-memory chat of a running run (newer than the file on disk) and the last event seq in it.
  live(chatId: string): { chat: StoredChat; seq: number; runId: string } | undefined {
    for (const [runId, r] of this.active) if (r.chatId === chatId) return { chat: r.chat, seq: r.seq(), runId };
    return undefined;
  }

  async start(input: { chatId?: string; text: string; selectors: Selectors }): Promise<{ chatId: string; runId: string }> {
    const p = await this.d.provider();
    if (!p) throw new AppError("no-provider", "Add an AI provider key in Settings first.");
    if (input.chatId && this.isRunning(input.chatId)) throw new AppError("busy", "This chat is already working. Stop it or wait for it to finish.");

    const now = new Date().toISOString();
    const chat: StoredChat = input.chatId
      ? await this.d.chats.load(input.chatId)
      : { schemaVersion: 1, id: newChatId(), title: titleFrom(input.text), createdAt: now, updatedAt: now, selectors: input.selectors, display: [], transcript: [] };
    chat.selectors = input.selectors;
    chat.updatedAt = now;
    if (chat.transcript.length === 0) chat.transcript.push({ role: "system", content: systemPrompt() });
    chat.transcript.push({ role: "user", content: `${userContext(input.selectors, await this.d.packs.list())}\n\n${this.d.redact(input.text)}` });
    chat.display.push({ kind: "user", text: input.text, at: now });
    const agentItem = { kind: "agent" as const, at: now, text: "", steps: [] as Step[], outcome: "running" as const, message: undefined as string | undefined, plan: undefined as Plan | undefined, evidence: undefined as TestReport | undefined };
    chat.display.push(agentItem);
    await this.d.chats.save(chat);

    const runId = `r-${randomBytes(6).toString("hex")}`;
    const controller = new AbortController();
    let seq = 0;
    this.active.set(runId, { controller, chatId: chat.id, chat, seq: () => seq });
    const settings = await this.d.settings.get();

    // Saves run one after another, so an older snapshot can never land after a newer one.
    let saving: Promise<void> = Promise.resolve();
    const save = () => (saving = saving.then(() => this.d.chats.save(chat)).catch(() => undefined));

    const emit = (event: RunEvent) => {
      if (event.type === "text") agentItem.text += event.delta;
      if (event.type === "step") {
        // Name the chat after the pack once one is created (History then tells chats apart).
        if (event.step.tool === "create_instance" && event.step.state === "done" && event.step.result) chat.title = titleFrom(event.step.result);
        const i = agentItem.steps.findIndex((s) => s.id === event.step.id);
        if (i >= 0) agentItem.steps[i] = event.step;
        else agentItem.steps.push(event.step);
        void save();
      }
      if (event.type === "plan") { agentItem.plan = event.plan; void save(); }
      if (event.type === "evidence") { agentItem.evidence = event.report; void save(); }
      this.d.send({ runId, chatId: chat.id, seq: ++seq, event });
    };

    void (async () => {
      const web = await this.d.web?.().catch(() => undefined);
      const result = await runAgent({
        provider: p.provider, model: p.model, fallbackModels: p.fallbacks ?? [], tools: TOOLS,
        ctx: {
          packs: this.d.packs, quests: this.d.quests, modrinth: this.d.modrinth, searchConfigured: Boolean(web?.search), web, runId,
          plan: { pending: false, show: (plan) => emit({ type: "plan", plan }) },
          tester: this.d.tester, adoptions: this.d.adoptions, onTestReport: (report) => emit({ type: "evidence", report }),
          testRuns: { used: 0, limit: settings.budgets.testRuns }, downloads: { usedBytes: 0, limitBytes: settings.budgets.diskMb * 1_048_576 }, signal: controller.signal,
        },
        redact: this.d.redact,
        budgets: { wallClockMs: settings.budgets.wallClockMin * 60_000, maxSteps: 40, stagnationRepeats: settings.budgets.stagnationRepeats, attemptsPerIssue: settings.budgets.attemptsPerIssue },
        emit, contextBudget: this.d.contextBudget, pauseRequested: () => this.active.get(runId)?.pause === true,
      }, chat.transcript, controller.signal);
      (agentItem as { outcome: string }).outcome = result.outcome;
      agentItem.message = result.message;
      chat.updatedAt = new Date().toISOString();
      await save();
      this.active.delete(runId);
      this.d.send({ runId, chatId: chat.id, seq: ++seq, event: { type: "finished", outcome: result.outcome, message: result.message } });
    })();

    return { chatId: chat.id, runId };
  }

  // CHT-3: the run ends after the step in progress, ready to resume in the same chat.
  pause(runId: string): void {
    const r = this.active.get(runId);
    if (r) r.pause = true;
  }

  stop(runId: string): void {
    this.active.get(runId)?.controller.abort();
  }

  stopAll(): void {
    for (const r of this.active.values()) r.controller.abort();
  }
}
