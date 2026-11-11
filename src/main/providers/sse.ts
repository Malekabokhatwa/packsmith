// Server-sent events parser for OpenAI-style streaming chat completions, plus the accumulator
// that turns tool-call deltas into whole calls. It accepts chunks with or without `index`
// (Gemini's OpenAI layer has been reported to omit it) and whole calls in a single chunk.
import type { Readable } from "node:stream";
import type { ToolCall } from "./types";

export async function* sseData(body: Readable): AsyncGenerator<string> {
  let buf = "";
  for await (const chunk of body) {
    buf += (chunk as Buffer).toString("utf8");
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, "");
      buf = buf.slice(nl + 1);
      if (line.startsWith("data:")) yield line.slice(5).trimStart();
    }
  }
  const last = buf.trim();
  if (last.startsWith("data:")) yield last.slice(5).trimStart();
}

interface DeltaCall { index?: number; id?: string; function?: { name?: string; arguments?: string }; extra_content?: unknown }

export class ToolCallAccumulator {
  private calls: Array<{ id: string; name: string; args: string; extra?: unknown }> = [];
  private byIndex = new Map<number, number>();
  private byId = new Map<string, number>();

  add(deltas: DeltaCall[]): void {
    for (const d of deltas) {
      let slot: number | undefined;
      if (d.index !== undefined) slot = this.byIndex.get(d.index);
      if (slot === undefined && d.id) slot = this.byId.get(d.id);
      // A delta that names a new call (id or name) without an index starts a new slot;
      // a bare argument fragment continues the latest call.
      const startsNew = slot === undefined && (d.index !== undefined || d.id !== undefined || d.function?.name !== undefined || this.calls.length === 0);
      if (startsNew) {
        slot = this.calls.push({ id: "", name: "", args: "" }) - 1;
        if (d.index !== undefined) this.byIndex.set(d.index, slot);
      }
      slot ??= this.calls.length - 1;
      const c = this.calls[slot]!;
      if (d.id && !c.id) { c.id = d.id; this.byId.set(d.id, slot); }
      if (d.function?.name) c.name += d.function.name;
      if (d.function?.arguments) c.args += d.function.arguments;
      if (d.extra_content !== undefined && d.extra_content !== null && c.extra === undefined) c.extra = d.extra_content;
    }
  }

  result(): ToolCall[] {
    return this.calls.map((c, i) => ({ id: c.id || `call_${i}`, name: c.name, arguments: c.args || "{}", ...(c.extra !== undefined ? { extra: c.extra } : {}) }));
  }
}
