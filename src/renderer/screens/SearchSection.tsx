// S10 Web search (WEB-1..3, AC-6, D-34): off (visibly degraded), Google Search through the user's
// Gemini key, or Tavily with its own key. Each option says what it needs and what it can cost
// before it's chosen (WEB-2).
import { useEffect, useState } from "react";
import { ExternalLink } from "lucide-react";
import type { SearchStatus } from "@shared/ipc";
import { call, errorMessage } from "../lib/api";
import { Button } from "../components/Button";

type Choice = "none" | "provider-native" | "tavily";
const OPTIONS: Array<{ id: Choice; label: string; cost: string; link?: { href: string; text: string } }> = [
  { id: "none", label: "Off", cost: "Picks come from Modrinth's data only: packsmith can't read mod docs or reports of known conflicts, so its picks are weaker." },
  { id: "tavily", label: "Tavily", cost: "Free: its own key with 1,000 searches a month, no card. Paid plans only if you choose one.", link: { href: "https://app.tavily.com", text: "Get a free key" } },
  { id: "provider-native", label: "Google Search, through your Gemini key", cost: "Nothing new to set up, but Google gives free keys no search allowance (checked 2026-11-10: refused on every model), so this needs a paid key. Each search is one of its requests.", link: { href: "https://ai.google.dev/gemini-api/docs/pricing", text: "Pricing" } },
];

export function SearchSection() {
  const [st, setSt] = useState<SearchStatus | null>(null);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "danger"; text: string } | null>(null);
  useEffect(() => { void call("search:status").then(setSt).catch((e) => setMsg({ tone: "danger", text: errorMessage(e) })); }, []);

  const pick = async (provider: Choice) => {
    setMsg(null);
    setSt((cur) => (cur ? { ...cur, provider, active: false } : cur)); // the choice shows at once; the status follows
    try { setSt(await call("search:set", { provider })); } catch (e) { setMsg({ tone: "danger", text: errorMessage(e) }); }
  };
  const saveKey = async () => {
    setBusy(true); setMsg(null);
    try { setSt(await call("search:setKey", { key })); setKey(""); setMsg({ tone: "ok", text: "Key works. Saved in your system keyring." }); }
    catch (e) { setMsg({ tone: "danger", text: errorMessage(e) }); }
    finally { setBusy(false); }
  };

  const chosen = (st?.provider ?? "none") as Choice;
  const state = !st ? null
    : st.active ? <><span className="font-medium text-text">On.</span> {OPTIONS.find((o) => o.id === chosen)?.label}.</>
    : chosen === "provider-native" && !st.geminiReady ? <><span className="font-medium text-warning">Off.</span> Google Search needs Gemini as the AI provider, with its key.</>
    : chosen === "tavily" && !st.tavilyKey ? <><span className="font-medium text-warning">Off.</span> Tavily needs its key below.</>
    : <><span className="font-medium text-warning">Off.</span> {OPTIONS[0]!.cost}</>;

  return (
    <section aria-labelledby="search-h" className="rounded-lg border border-border bg-surface p-5">
      <h2 id="search-h" className="m-0 text-lg font-semibold">Web search</h2>
      <p role="status" className="m-0 mt-1 mb-3 text-sm">{state}</p>
      <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
        <legend className="sr-only">Search provider</legend>
        {OPTIONS.map((o) => (
          <label key={o.id} className="flex gap-2.5 rounded-sm px-1 py-1 text-sm hover:bg-surface-2">
            <input type="radio" name="search" className="mt-0.5 size-4 accent-accent" checked={chosen === o.id} onChange={() => void pick(o.id)} />
            <span className="flex flex-col">
              <span className="font-medium">{o.label}</span>
              <span className="text-xs text-subtle">
                {o.cost}{o.link && <> <a href={o.link.href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-accent hover:underline">{o.link.text}<ExternalLink className="size-3" aria-hidden /></a></>}
              </span>
            </span>
          </label>
        ))}
      </fieldset>
      {chosen === "tavily" && (
        <form className="mt-3 flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); void saveKey(); }}>
          <label className="flex min-w-60 flex-1 flex-col gap-1 text-sm">
            <span className="font-medium">Tavily key{st?.tavilyKey ? " (saved; paste a new one to replace it)" : ""}</span>
            <input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="tvly-…" autoComplete="off"
              className="h-8.5 rounded-sm border border-input bg-bg px-2.5 font-mono text-sm outline-none focus-visible:outline-2 focus-visible:outline-focus" />
          </label>
          <Button type="submit" variant="primary" className="self-end" loading={busy} disabled={busy || key.trim().length < 8}>Test and save</Button>
        </form>
      )}
      {msg && <p role="status" className={`m-0 mt-2 text-sm ${msg.tone === "danger" ? "text-danger" : "text-muted"}`}>{msg.text}</p>}
    </section>
  );
}
