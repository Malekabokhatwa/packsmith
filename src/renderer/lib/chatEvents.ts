import type { ChatView, DisplayItem, RunEnvelope } from "@shared/agent";

type AgentItem = Extract<DisplayItem, { kind: "agent" }>;

// Apply one live event to a chat snapshot, unless the snapshot already contains it (seq).
// seq counts per run, so an event only applies to the run the snapshot is showing: events of an
// earlier run in the same chat must never land on a later answer.
export function applyEvent(c: ChatView, env: RunEnvelope): ChatView {
  if (c.id !== env.chatId || c.activeRunId !== env.runId || (c.seq !== undefined && env.seq <= c.seq)) return c;
  const display = [...c.display];
  const last = display[display.length - 1];
  if (!last || last.kind !== "agent") return { ...c, seq: env.seq };
  const item: AgentItem = { ...last, steps: [...last.steps] };
  const ev = env.event;
  if (ev.type === "text") item.text += ev.delta;
  if (ev.type === "step") {
    const i = item.steps.findIndex((x) => x.id === ev.step.id);
    if (i >= 0) item.steps[i] = ev.step; else item.steps.push(ev.step);
  }
  if (ev.type === "plan") item.plan = ev.plan;
  if (ev.type === "evidence") item.evidence = ev.report;
  if (ev.type === "finished") { item.outcome = ev.outcome; item.message = ev.message; }
  display[display.length - 1] = item;
  return { ...c, display, seq: env.seq };
}
