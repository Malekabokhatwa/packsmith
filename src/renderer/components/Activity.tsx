import { useState } from "react";
import { Check, ChevronRight, X } from "lucide-react";
import type { Step } from "@shared/agent";

function Glyph({ state }: { state: Step["state"] }) {
  if (state === "running") return <span className="ms-1 size-2 rounded-full bg-accent [animation:ps-pulse_1.4s_ease-in-out_infinite]" aria-label="working" />;
  if (state === "failed") return <X className="size-3.5 text-danger" aria-label="failed" />;
  return <Check className="size-3.5 text-muted" aria-label="done" />;
}

function Line({ s }: { s: Step }) {
  return (
    <li className="grid grid-cols-[1rem_1fr_auto] items-center gap-2 py-0.5">
      <Glyph state={s.state} />
      <span className="min-w-0 truncate text-sm" title={`${s.label}: ${s.detail}`}>
        <span className={s.state === "failed" ? "text-danger" : s.state === "running" ? "text-text" : "text-muted"}>{s.label}</span>
        {s.detail && <span className="ms-2 font-mono text-mono-sm text-subtle">{s.detail}</span>}
      </span>
      {s.result && <span className={`max-w-64 truncate text-xs ${s.state === "failed" ? "text-danger" : "text-subtle"}`} title={s.result}>{s.result}</span>}
    </li>
  );
}

// The live feed of what the agent is doing (spec 5.3, UX-2). While running every step shows;
// once finished it folds into one line that can be opened again.
export function Activity({ steps, running }: { steps: Step[]; running: boolean }) {
  const [open, setOpen] = useState(false);
  if (steps.length === 0) return null;
  const failed = steps.filter((s) => s.state === "failed").length;
  if (!running && !open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="mb-3 flex items-center gap-1.5 text-sm text-subtle hover:text-text">
        <ChevronRight className="size-4" aria-hidden />
        {steps.length} step{steps.length === 1 ? "" : "s"}{failed ? `, ${failed} failed` : ""}
      </button>
    );
  }
  return (
    <div className="mb-3">
      {!running && (
        <button type="button" onClick={() => setOpen(false)} className="mb-1 flex items-center gap-1.5 text-sm text-subtle hover:text-text">
          <ChevronRight className="size-4 rotate-90" aria-hidden />Hide steps
        </button>
      )}
      <ol aria-label="Activity" className="m-0 list-none border-l border-border p-0 pl-4">
        {steps.map((s) => <Line key={s.id} s={s} />)}
      </ol>
    </div>
  );
}
