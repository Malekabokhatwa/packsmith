import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { RunEvent } from "@shared/agent";
import { runAgent, trimContext, type Budgets } from "../src/main/agent/runtime";
import { AppError } from "../src/main/errors";
import type { ChatRequest, ChatResult, LlmProvider } from "../src/main/providers/types";
import { ScriptedProvider, type Script } from "../src/main/providers/scripted";
import { toolSpecs, TOOLS, type ToolDef } from "../src/main/agent/tools";
import type { Message } from "../src/main/providers/types";

const budgets: Budgets = { wallClockMs: 60_000, maxSteps: 20, stagnationRepeats: 3, attemptsPerIssue: 5 };
let calls = 0;
const echo: ToolDef = {
  name: "echo", label: "Echoing", description: "d", input: z.object({ say: z.string() }),
  detail: (a) => (a as { say: string }).say,
  run: async (a) => { calls++; return { data: { said: (a as { say: string }).say, home: "/home/someone/x" }, summary: "ok" }; },
};
const broken: ToolDef = {
  name: "broken", label: "Breaking", description: "d", input: z.object({}),
  detail: () => "", run: async () => { calls++; throw new Error("disk on fire"); },
};

function script(turns: Script["turns"]): ScriptedProvider {
  return new ScriptedProvider({ models: ["m"], delayMs: 0, turns });
}

async function run(turns: Script["turns"], opts: { budgets?: Partial<Budgets>; now?: () => number; signal?: AbortSignal } = {}) {
  calls = 0;
  const events: RunEvent[] = [];
  const transcript: Message[] = [{ role: "user", content: "go" }];
  const result = await runAgent({
    provider: script(turns), model: "m", tools: [echo, broken], ctx: {} as never,
    redact: (s) => s.replace(/\/home\/someone/g, "~"), budgets: { ...budgets, ...opts.budgets }, emit: (e) => events.push(e), now: opts.now,
  }, transcript, opts.signal ?? new AbortController().signal);
  return { result, events, transcript };
}

describe("agent runtime (spec 5.1)", () => {
  it("runs a multi-step loop to a final answer, narrating each step", async () => {
    const { result, events, transcript } = await run([
      { text: "Let me check.", toolCalls: [{ name: "echo", arguments: { say: "one" } }] },
      { text: "", toolCalls: [{ name: "echo", arguments: { say: "two" } }] },
      { text: "All done.", toolCalls: [] },
    ]);
    expect(result).toEqual({ outcome: "done" });
    expect(calls).toBe(2);
    const steps = events.filter((e) => e.type === "step").map((e) => e.type === "step" && `${e.step.label}:${e.step.detail}:${e.step.state}`);
    expect(steps).toEqual(["Echoing:one:running", "Echoing:one:done", "Echoing:two:running", "Echoing:two:done"]);
    expect(events.filter((e) => e.type === "text").map((e) => e.type === "text" && e.delta).join("")).toBe("Let me check.\n\nAll done.");
    const toolMsg = transcript.find((m) => m.role === "tool")!;
    expect(toolMsg.content).toContain("~/x"); // redacted before it can reach the provider
    expect(toolMsg.content).not.toContain("/home/someone");
  });

  it("a tool's progress updates its running step in the feed (boot test phases)", async () => {
    const slow: ToolDef = {
      name: "slow", label: "Test-booting", description: "d", input: z.object({}), detail: () => "server and game",
      run: async (_a, ctx) => { ctx.progress?.("booting a server"); ctx.progress?.("booting the game on a hidden screen"); return { data: {}, summary: "proven" }; },
    };
    const events: RunEvent[] = [];
    await runAgent({ provider: script([{ toolCalls: [{ name: "slow", arguments: {} }] }, { text: "ok" }]), model: "m", tools: [slow], ctx: {} as never, redact: (s) => s, budgets, emit: (e) => events.push(e) }, [{ role: "user", content: "go" }], new AbortController().signal);
    const steps = events.flatMap((e) => (e.type === "step" ? [`${e.step.state}:${e.step.result ?? ""}`] : []));
    expect(steps).toEqual(["running:", "running:booting a server", "running:booting the game on a hidden screen", "done:proven"]);
    expect(new Set(events.flatMap((e) => (e.type === "step" ? [e.step.id] : []))).size).toBe(1);
  });

  it("runs several calls of one turn in order; after a failure the rest of the turn is skipped, not run", async () => {
    const { result, transcript } = await run([
      { toolCalls: [{ name: "echo", arguments: { say: "a" } }, { name: "echo", arguments: { say: "b" } }] },
      { toolCalls: [{ name: "broken", arguments: {} }, { name: "echo", arguments: { say: "after" } }] },
      { text: "ok", toolCalls: [] },
    ]);
    expect(result.outcome).toBe("done");
    expect(calls).toBe(3); // a, b, broken; "after" never ran
    const tools = transcript.filter((m) => m.role === "tool").map((m) => m.content);
    expect(tools).toHaveLength(4); // every call id still gets an answer (providers require it)
    expect(tools[3]).toMatch(/"skipped":"Not run: broken failed earlier in this turn/);
  });

  it("rejects malformed and invalid tool calls without running the tool", async () => {
    const { events } = await run([
      { toolCalls: [{ name: "echo", arguments: "{not json" }] },
      { toolCalls: [{ name: "echo", arguments: { say: 5 } }] },
      { toolCalls: [{ name: "nope", arguments: {} }] },
      { text: "ok", toolCalls: [] },
    ]);
    expect(calls).toBe(0);
    const failed = events.flatMap((e) => (e.type === "step" && e.step.state === "failed" ? [e.step.result] : []));
    expect(failed[0]).toMatch(/not valid JSON/);
    expect(failed[1]).toMatch(/Invalid arguments \(say:/);
    expect(failed[2]).toMatch(/Unknown tool "nope"/);
  });

  it("stops on stagnation: the same failure three times", async () => {
    const { result } = await run(Array.from({ length: 6 }, () => ({ toolCalls: [{ name: "broken", arguments: {} }] })));
    expect(result.outcome).toBe("blocked");
    expect(result.message).toMatch(/same problem came up 3 times: Unexpected problem: disk on fire/);
    expect(calls).toBe(3);
  });

  it("stops at the attempt cap for one issue even when the errors differ", async () => {
    let n = 0;
    const varying: ToolDef = { ...broken, run: async () => { throw new Error(`variant ${n++}`); } };
    const events: RunEvent[] = [];
    const result = await runAgent({ provider: script(Array.from({ length: 8 }, () => ({ toolCalls: [{ name: "broken", arguments: {} }] }))), model: "m", tools: [varying], ctx: {} as never, redact: (s) => s, budgets, emit: (e) => events.push(e) }, [], new AbortController().signal);
    expect(result).toMatchObject({ outcome: "blocked", message: expect.stringMatching(/5 failed attempts at "Breaking"/) });
  });

  it("stops at the wall-clock budget and says which budget", async () => {
    let t = 0;
    const { result } = await run([{ toolCalls: [{ name: "echo", arguments: { say: "a" } }] }, { toolCalls: [{ name: "echo", arguments: { say: "b" } }] }],
      { budgets: { wallClockMs: 60_000 }, now: () => (t += 40_000) });
    expect(result).toMatchObject({ outcome: "blocked", message: expect.stringMatching(/1-minute time budget/) });
  });

  it("stops at the step limit", async () => {
    const { result } = await run(Array.from({ length: 5 }, (_, i) => ({ toolCalls: [{ name: "echo", arguments: { say: String(i) } }] })), { budgets: { maxSteps: 3 } });
    expect(result).toMatchObject({ outcome: "blocked", message: expect.stringMatching(/limit of 3 steps/) });
  });

  it("honours STOP", async () => {
    const c = new AbortController();
    c.abort();
    const { result } = await run([{ text: "hi", toolCalls: [] }], { signal: c.signal });
    expect(result.outcome).toBe("stopped");
  });

  it("pauses between turns with every step complete, and a resume carries on from there (CHT-3)", async () => {
    calls = 0;
    let pause = false;
    const events: RunEvent[] = [];
    const transcript: Message[] = [{ role: "user", content: "go" }];
    const turns: Script["turns"] = [
      { toolCalls: [{ name: "echo", arguments: { say: "one" } }] },
      { toolCalls: [{ name: "echo", arguments: { say: "two" } }] },
      { text: "Done.", toolCalls: [] },
    ];
    const provider = script(turns);
    const deps = { provider, model: "m", tools: [echo], ctx: {} as never, redact: (x: string) => x, budgets, emit: (e: RunEvent) => events.push(e), pauseRequested: () => pause };
    const echoOnce = echo.run;
    echo.run = async (a, c) => { pause = true; return echoOnce(a, c); }; // the user presses Pause during step one
    try {
      const first = await runAgent(deps, transcript, new AbortController().signal);
      expect(first).toEqual({ outcome: "paused", message: "Paused after the step \"Echoing\". Nothing is half-written." });
      expect(calls).toBe(1);
      expect(transcript.at(-1)).toMatchObject({ role: "tool" }); // the step's result is in, nothing dangling
    } finally { echo.run = echoOnce; }
    pause = false;
    transcript.push({ role: "user", content: "Continue where you paused." });
    const second = await runAgent(deps, transcript, new AbortController().signal);
    expect(second).toEqual({ outcome: "done" });
    expect(calls).toBe(2);
  });

  it("a chat still over budget after trimming ends as 'full' without calling the provider (CHT-2)", async () => {
    let called = 0;
    const provider = script([{ text: "never" }]);
    const orig = provider.chat.bind(provider);
    provider.chat = ((req: ChatRequest) => { called++; return orig(req); }) as typeof provider.chat;
    const events: RunEvent[] = [];
    const transcript: Message[] = [{ role: "user", content: "x".repeat(500) }, { role: "tool", toolCallId: "t", name: "echo", content: "y".repeat(500) }];
    const result = await runAgent({ provider, model: "m", tools: [echo], ctx: {} as never, redact: (s) => s, budgets, emit: (e) => events.push(e), contextBudget: 300 }, transcript, new AbortController().signal);
    expect(result.outcome).toBe("full");
    expect(result.message).toMatch(/This chat is full/);
    expect(called).toBe(0);
    expect(transcript[1]!.content).toBe("[older result trimmed]");
  });

  it("trims the oldest tool results first when the context grows too large", () => {
    const msgs: Message[] = [
      { role: "system", content: "s" },
      { role: "tool", toolCallId: "1", name: "x", content: "a".repeat(100) },
      { role: "tool", toolCallId: "2", name: "x", content: "b".repeat(100) },
      { role: "user", content: "u" },
    ];
    trimContext(msgs, 150);
    expect(msgs[1]!.content).toBe("[older result trimmed]");
    expect(msgs[2]!.content).toBe("b".repeat(100));
  });
});

describe("tool schemas for the model", () => {
  it("are portable JSON Schema objects without keywords Gemini rejects", () => {
    const specs = toolSpecs(TOOLS);
    expect(specs.map((s) => s.name)).toEqual(["search_modrinth", "get_project", "get_versions", "create_instance", "resolve_dependencies", "propose_plan", "download_file", "read_instance", "write_file", "remove_file", "set_enabled", "set_loader", "find_ids", "read_quests", "write_quests", "remove_quest_chapter", "discover_instances", "launch_test", "diagnose_crash", "web_search", "web_fetch"]);
    const text = JSON.stringify(specs);
    for (const bad of ["$schema", "additionalProperties", "\"default\"", "\"pattern\"", "\"anyOf\"", "\"oneOf\"", "\"$ref\""]) expect(text).not.toContain(bad);
    expect(specs[0]!.parameters).toMatchObject({ type: "object", required: expect.arrayContaining(["query", "mc_version"]) });
  });
});

describe("busy provider (CHT-4: retry with backoff, then a named blocker)", () => {
  function flaky(fails: number, opts: { streamFirst?: boolean } = {}): LlmProvider {
    let n = 0;
    return {
      listModels: async () => ["m"],
      async chat(req: ChatRequest): Promise<ChatResult> {
        if (n++ < fails) {
          if (opts.streamFirst) req.onText?.("partial ");
          throw new AppError("provider-unavailable", "Gemini is overloaded or down right now (503)");
        }
        req.onText?.("done");
        return { text: "done", toolCalls: [], finishReason: "stop" };
      },
    };
  }
  const go = (provider: LlmProvider) => {
    const events: RunEvent[] = [];
    const waits: number[] = [];
    return runAgent({ provider, model: "m", tools: [], ctx: {} as never, redact: (s) => s, budgets, emit: (e) => events.push(e),
      retryDelaysMs: [10, 20, 30], sleep: async (ms) => { waits.push(ms); } }, [], new AbortController().signal).then((r) => ({ r, events, waits }));
  };

  it("retries and succeeds, narrating each wait", async () => {
    const { r, events, waits } = await go(flaky(2));
    expect(r).toEqual({ outcome: "done" });
    expect(waits).toEqual([10, 20]);
    const labels = events.flatMap((e) => (e.type === "step" ? [`${e.step.label} ${e.step.detail} ${e.step.state}`] : []));
    expect(labels).toEqual(["Model is busy, trying again attempt 2 of 4 running", "Model is busy, trying again attempt 2 of 4 done",
      "Model is busy, trying again attempt 3 of 4 running", "Model is busy, trying again attempt 3 of 4 done"]);
  });

  it("gives up after the last retry with a message that says what to do", async () => {
    const { r, waits } = await go(flaky(9));
    expect(waits).toEqual([10, 20, 30]);
    expect(r).toEqual({ outcome: "error", message: "Gemini is overloaded or down right now (503). packsmith tried 4 times. Try again in a minute, or pick another model in Settings." });
  });

  it("switches to the next model when one stays busy through every retry", async () => {
    const seen: string[] = [];
    const provider: LlmProvider = {
      listModels: async () => ["a", "b"],
      async chat(req) {
        seen.push(req.model);
        if (req.model === "a") throw new AppError("provider-unavailable", "Gemini is overloaded or down right now (503)");
        return { text: "ok", toolCalls: [], finishReason: "stop" };
      },
    };
    const events: RunEvent[] = [];
    const r = await runAgent({ provider, model: "a", fallbackModels: ["b"], tools: [], ctx: {} as never, redact: (s) => s, budgets, emit: (e) => events.push(e),
      retryDelaysMs: [1, 1], sleep: async () => {} }, [], new AbortController().signal);
    expect(r).toEqual({ outcome: "done" });
    expect(seen).toEqual(["a", "a", "a", "b"]);
    expect(events.some((e) => e.type === "step" && e.step.label === "Switching model" && e.step.detail === "a → b")).toBe(true);
  });

  it("does not switch models once signed tool calls are in the history", async () => {
    const seen: string[] = [];
    const provider: LlmProvider = { listModels: async () => [], chat: async (req) => { seen.push(req.model); throw new AppError("provider-unavailable", "Gemini is overloaded or down right now (503)"); } };
    const history = [{ role: "assistant" as const, content: "", toolCalls: [{ id: "1", name: "x", arguments: "{}", extra: { google: { thought_signature: "s" } } }] }];
    const r = await runAgent({ provider, model: "a", fallbackModels: ["b"], tools: [], ctx: {} as never, redact: (s) => s, budgets, emit: () => {},
      retryDelaysMs: [1], sleep: async () => {} }, history, new AbortController().signal);
    expect(seen).toEqual(["a", "a"]);
    expect(r.outcome).toBe("error");
  });

  it("names every model it tried when all stay busy", async () => {
    const provider: LlmProvider = { listModels: async () => [], chat: async () => { throw new AppError("provider-unavailable", "Gemini is overloaded or down right now (503)"); } };
    const r = await runAgent({ provider, model: "a", fallbackModels: ["b"], tools: [], ctx: {} as never, redact: (s) => s, budgets, emit: () => {},
      retryDelaysMs: [1], sleep: async () => {} }, [], new AbortController().signal);
    expect(r).toEqual({ outcome: "error", message: "Gemini is overloaded or down right now (503). Tried a, b, each 2 times. Try again in a minute, or pick another model in Settings." });
  });

  it("waits as long as a rate-limited provider asks, with more attempts than for plain overload", async () => {
    let n = 0;
    const provider: LlmProvider = {
      listModels: async () => ["m"],
      async chat() {
        if (n++ < 6) throw new AppError("provider-rate-limit", "Gemini's rate limit was reached", { retryAfterMs: 4_600 });
        return { text: "ok", toolCalls: [], finishReason: "stop" };
      },
    };
    const { r, waits, events } = await go(provider);
    expect(r).toEqual({ outcome: "done" });
    expect(waits).toEqual([5_100, 5_100, 5_100, 5_100, 5_100, 5_100]);
    expect(events.some((e) => e.type === "step" && e.step.detail === "attempt 2 of 9 · waiting 6 s as asked")).toBe(true);
  });

  it("stops at once when the provider asks for a wait too long for a run (a daily quota)", async () => {
    const provider: LlmProvider = { listModels: async () => [], chat: async () => { throw new AppError("provider-rate-limit", "Gemini's rate limit was reached", { retryAfterMs: 21 * 3_600_000 }); } };
    const { r, waits } = await go(provider);
    expect(waits).toEqual([]);
    expect(r).toEqual({ outcome: "error", message: "Gemini's rate limit was reached. It asks for a wait of about 21 hours, so this run stops here. Try again later, or pick another model in Settings." });
  });

  it("never retries once text has streamed, so nothing is duplicated", async () => {
    const { r, waits } = await go(flaky(1, { streamFirst: true }));
    expect(waits).toEqual([]);
    expect(r.outcome).toBe("error");
  });
});

describe("cut-off answers", () => {
  function provider(results: Array<Partial<ChatResult>>): LlmProvider & { seen: ChatRequest[] } {
    const seen: ChatRequest[] = [];
    let i = 0;
    return {
      seen,
      listModels: async () => [],
      async chat(req) {
        seen.push({ ...req, messages: [...req.messages] });
        const r = results[i++] ?? { text: "", finishReason: "stop" };
        if (r.text) req.onText?.(r.text);
        return { text: r.text ?? "", toolCalls: r.toolCalls ?? [], finishReason: r.finishReason };
      },
    };
  }
  const go = async (p: LlmProvider) => {
    const events: RunEvent[] = [];
    const r = await runAgent({ provider: p, model: "m", tools: [], ctx: {} as never, redact: (s) => s, budgets, emit: (e) => events.push(e) }, [], new AbortController().signal);
    return { r, text: events.flatMap((e) => (e.type === "text" ? [e.delta] : [])).join("") };
  };

  it("asks the model to continue when the stream ends without a finish reason, and the text joins up", async () => {
    const p = provider([{ text: "## Cozy\n\nMinecraft 1.2" }, { text: "1.1, Fabric.", finishReason: "stop" }]);
    const { r, text } = await go(p);
    expect(r).toEqual({ outcome: "done" });
    expect(text).toBe("## Cozy\n\nMinecraft 1.21.1, Fabric.");
    expect(p.seen[1]!.messages.at(-1)).toMatchObject({ role: "user", content: expect.stringMatching(/cut off\. Continue exactly where it stopped/) });
  });

  it("continues after a 'length' stop, at most twice", async () => {
    const p = provider([{ text: "a", finishReason: "length" }, { text: "b", finishReason: "length" }, { text: "c", finishReason: "length" }, { text: "d" }]);
    const { r, text } = await go(p);
    expect(r).toEqual({ outcome: "done" });
    expect(text).toBe("abc");
    expect(p.seen).toHaveLength(3);
  });

  it("names a safety-filter stop", async () => {
    const { r } = await go(provider([{ text: "", finishReason: "content_filter" }]));
    expect(r).toEqual({ outcome: "blocked", message: "The provider's safety filter stopped this answer. Try rewording the request." });
  });
});
