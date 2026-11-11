// PERF-5 budgets per run (S10), followed by the web search section (WEB-1..3, AC-6).
import { useEffect, useState } from "react";
import type { Settings } from "@shared/schema";
import { call, errorMessage } from "../lib/api";
import { Button } from "../components/Button";
import { SearchSection } from "./SearchSection";

type Budgets = Omit<Settings["budgets"], "spendUsd">;
const FIELDS: Array<{ key: keyof Budgets; label: string; unit: string; min: number; max: number; help: string }> = [
  { key: "wallClockMin", label: "Time", unit: "minutes", min: 1, max: 240, help: "How long one run may work before it stops." },
  { key: "diskMb", label: "Downloads", unit: "MB", min: 64, max: 65536, help: "How much one run may download." },
  { key: "testRuns", label: "Boot tests", unit: "per run", min: 1, max: 50, help: "How many times one run may boot the pack." },
  { key: "attemptsPerIssue", label: "Attempts per problem", unit: "tries", min: 1, max: 20, help: "Tries at one failing step before the run stops." },
  { key: "stagnationRepeats", label: "Same error", unit: "times", min: 2, max: 10, help: "Stop when the very same error comes back this often." },
];
const field = "h-8.5 w-24 rounded-sm border border-input bg-bg px-2.5 text-sm outline-none focus-visible:outline-2 focus-visible:outline-focus";

export function BudgetsSection({ settings, onSaved }: { settings: Settings | null; onSaved: (s: Settings) => void }) {
  const [draft, setDraft] = useState<Budgets | null>(null);
  const [msg, setMsg] = useState<{ tone: "info" | "danger"; text: string } | null>(null);
  useEffect(() => { if (settings) { const { spendUsd: _s, ...b } = settings.budgets; setDraft(b); } }, [settings]);
  const invalid = draft ? FIELDS.find((f) => !Number.isInteger(draft[f.key]) || draft[f.key] < f.min || draft[f.key] > f.max) : undefined;
  async function save() {
    if (!draft) return;
    setMsg(null);
    try { onSaved(await call("settings:setBudgets", draft)); setMsg({ tone: "info", text: "Saved. New runs use these limits." }); }
    catch (e) { setMsg({ tone: "danger", text: errorMessage(e) }); }
  }
  return (
    <>
      <section aria-labelledby="budgets-h" className="rounded-lg border border-border bg-surface p-5">
        <h2 id="budgets-h" className="m-0 text-lg font-semibold">Budgets per run</h2>
        <p className="m-0 mt-1 mb-4 text-sm text-muted">A run stops when it reaches one of these and says which one. Spend limits come later: the providers here don't report cost per request.</p>
        {!draft ? <div className="ps-skeleton h-40 rounded-md bg-surface-2" /> : (
          <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); void save(); }}>
            {FIELDS.map((f) => (
              <label key={f.key} className="flex items-center gap-3 text-sm">
                <span className="w-44 shrink-0 font-medium">{f.label}</span>
                <input aria-label={f.label} type="number" inputMode="numeric" min={f.min} max={f.max} step={1} value={Number.isNaN(draft[f.key]) ? "" : draft[f.key]} className={field}
                  aria-describedby={`budget-${f.key}`} onChange={(e) => setDraft({ ...draft, [f.key]: e.target.valueAsNumber })} />
                <span className="text-muted">{f.unit}</span>
                <span id={`budget-${f.key}`} className="hidden text-xs text-subtle md:inline">{f.help}</span>
              </label>
            ))}
            {invalid && <p className="m-0 text-sm text-danger">{invalid.label}: use a whole number from {invalid.min} to {invalid.max}.</p>}
            <div><Button type="submit" variant="primary" disabled={Boolean(invalid)}>Save budgets</Button></div>
            {msg && <p role="status" className={`m-0 text-sm ${msg.tone === "danger" ? "text-danger" : "text-muted"}`}>{msg.text}</p>}
          </form>
        )}
      </section>
      <SearchSection />
    </>
  );
}
