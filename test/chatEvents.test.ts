import { describe, expect, it } from "vitest";
import type { ChatView, RunEnvelope } from "@shared/agent";
import { applyEvent } from "../src/renderer/lib/chatEvents";

const base = (seq?: number, text = ""): ChatView => ({
  id: "c-a-1", title: "t", updatedAt: "", selectors: { mc: "auto", loader: "auto", mode: "auto" }, seq, activeRunId: "r",
  display: [{ kind: "user", text: "go", at: "" }, { kind: "agent", at: "", text, steps: [], outcome: "running" }],
});
const txt = (seq: number, delta: string): RunEnvelope => ({ runId: "r", chatId: "c-a-1", seq, event: { type: "text", delta } });
const agentText = (c: ChatView) => (c.display[1] as { text: string }).text;

describe("live event replay (no lost or doubled stream text)", () => {
  it("replays buffered events onto a late snapshot, skipping what it already has", () => {
    // Snapshot taken after events 1-2 were applied in main; events 1-4 were buffered in the UI.
    const snap = base(2, "I'll make a");
    const buffered = [txt(1, "I'll "), txt(2, "make a"), txt(3, " small"), txt(4, " pack.")];
    expect(agentText(buffered.reduce(applyEvent, snap))).toBe("I'll make a small pack.");
  });
  it("applies everything to a snapshot from before the run produced events", () => {
    expect(agentText([txt(1, "Hello"), txt(2, " there")].reduce(applyEvent, base(0)))).toBe("Hello there");
  });
  it("ignores events for other chats and duplicates", () => {
    const c = applyEvent(base(0), txt(1, "a"));
    expect(agentText(applyEvent(c, txt(1, "a")))).toBe("a");
    expect(applyEvent(c, { ...txt(2, "x"), chatId: "c-b-2" })).toBe(c);
  });
  it("records the outcome of a finished run", () => {
    const c = applyEvent(base(0), { runId: "r", chatId: "c-a-1", seq: 1, event: { type: "finished", outcome: "blocked", message: "why" } });
    expect(c.display[1]).toMatchObject({ outcome: "blocked", message: "why" });
  });
  it("never puts an earlier run's events on a later run's answer (seq restarts per run)", () => {
    // Run r1 produced 5 events. A second message in the same chat starts r2; its snapshot has seq 1.
    const second = { ...base(1, "Building"), activeRunId: "r2" };
    const old = [1, 2, 3, 4, 5].map((n) => ({ ...txt(n, ` old${n}`), runId: "r1" }));
    expect(agentText(old.reduce(applyEvent, second))).toBe("Building");
    expect(agentText(applyEvent(second, { ...txt(2, " now"), runId: "r2" }))).toBe("Building now");
    // A finished chat (no active run) takes no live events at all.
    expect(applyEvent({ ...base(3), activeRunId: undefined }, txt(4, "late"))).toEqual({ ...base(3), activeRunId: undefined });
  });
});
