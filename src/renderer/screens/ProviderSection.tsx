// S10 Settings: AI provider (spec 8.2, UX-1). The cost line is shown before connecting; the key
// is tested by listing models and only saved if the provider accepts it; it is stored in the
// system keyring, never in a plain file.
import { useEffect, useState } from "react";
import { ExternalLink } from "lucide-react";
import type { ProviderStatus } from "@shared/agent";
import { call, errorMessage } from "../lib/api";
import { Button } from "../components/Button";

const field = "h-8.5 rounded-sm border border-input bg-bg px-2.5 text-sm outline-none focus-visible:outline-2 focus-visible:outline-focus";

export function ProviderSection({ onStart }: { onStart?: () => void }) {
  const [st, setSt] = useState<ProviderStatus | null>(null);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "info" | "danger"; text: string } | null>(null);
  const [justConnected, setJustConnected] = useState(false); // UX-1: one click from a working key to the first prompt

  useEffect(() => { call("provider:status").then(setSt).catch((e) => setMsg({ tone: "danger", text: errorMessage(e) })); }, []);

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      if (st?.provider === "ollama") {
        const next = await call("provider:setLocalEndpoint", { endpoint: key });
        setSt(next); setKey(""); setJustConnected(true);
        setMsg({ tone: "info", text: `Connected. ${next.models.length} model${next.models.length === 1 ? "" : "s"} found on the local server.` });
        return;
      }
      const next = await call("provider:setKey", { key });
      setSt(next);
      setKey("");
      setJustConnected(true);
      setMsg({ tone: "info", text: next.persistent ? "Key works. Saved in your system keyring." : "Key works. No system keyring was found, so it's kept for this session only." });
    } catch (e) {
      setMsg({ tone: "danger", text: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  }

  async function act(fn: () => Promise<ProviderStatus>) {
    setMsg(null);
    try { setSt(await fn()); } catch (e) { setMsg({ tone: "danger", text: errorMessage(e) }); }
  }

  return (
    <section aria-labelledby="provider-h" className="rounded-lg border border-border bg-surface p-5">
      <h2 id="provider-h" className="m-0 text-lg font-semibold">AI provider</h2>
      <p className="m-0 mt-1 mb-4 text-sm text-muted">packsmith uses your own key. You pay the provider directly, if anything; packsmith charges nothing.</p>
      {!st ? <div className="ps-skeleton h-24 rounded-md bg-surface-2" /> : (
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1.5 text-sm font-medium">Provider
            <select className={field} value={st.provider} disabled={busy}
              onChange={(e) => { setKey(""); void act(() => call("provider:setProvider", { id: e.target.value as ProviderStatus["provider"] })); }}>
              {st.choices.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
            </select>
          </label>
          <div className="rounded-md border border-border px-3.5 py-3">
            <div className="text-sm font-medium">{st.label}</div>
            <p className="m-0 mt-0.5 text-sm text-muted">{st.cost}</p>
            <div className="mt-1.5 flex gap-4 text-sm">
              {st.provider === "ollama" ? (<>
                <a href={st.pricingUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent hover:underline">Ollama <ExternalLink className="size-3.5" aria-hidden /></a>
                <a href={st.keyUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent hover:underline">LM Studio <ExternalLink className="size-3.5" aria-hidden /></a>
              </>) : (<>
              <a href={st.pricingUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent hover:underline">Pricing <ExternalLink className="size-3.5" aria-hidden /></a>
              <a href={st.keyUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent hover:underline">{st.provider === "gemini" ? "Get a free key" : "Get a key"} <ExternalLink className="size-3.5" aria-hidden /></a>
              </>)}
            </div>
          </div>
          {st.hasKey ? (
            <div className="flex flex-col gap-3">
              <p className="m-0 text-sm">{st.provider === "ollama" ? <>Connected to <code className="font-mono text-mono-sm">{st.endpoint}</code>. packsmith talks only to this address.</> : <>Connected. {st.persistent ? "The key is in your system keyring." : "The key is kept for this session only."}</>}</p>
              <label className="flex flex-col gap-1.5 text-sm font-medium">Model
                <select className={field} value={st.model ?? ""} onChange={(e) => void act(() => call("provider:setModel", { model: e.target.value }))}>
                  {!st.model && <option value="">Choose a model</option>}
                  {(st.models.length ? st.models : st.model ? [st.model] : []).map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
              </label>
              <div><Button variant="ghost" onClick={() => void act(() => call("provider:clearKey"))}>{st.provider === "ollama" ? "Disconnect" : "Remove key"}</Button></div>
            </div>
          ) : (
            <form className="flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); void save(); }}>
              {st.provider === "ollama" ? (
                <label className="flex flex-col gap-1.5 text-sm font-medium">Address of your local model server
                  <input type="url" autoComplete="off" spellCheck={false} value={key} onChange={(e) => setKey(e.target.value)} placeholder="http://127.0.0.1:11434/v1" className={`${field} font-mono`} />
                  <span className="text-xs font-normal text-subtle">Type it yourself: {st.keyHint}. Only this address may use plain HTTP.</span>
                </label>
              ) : (
                <label className="flex flex-col gap-1.5 text-sm font-medium">API key
                  <input type="password" autoComplete="off" spellCheck={false} value={key} onChange={(e) => setKey(e.target.value)} placeholder={st.keyHint} className={`${field} font-mono`} />
                </label>
              )}
              <div><Button type="submit" variant="primary" loading={busy} disabled={key.trim().length < (st.provider === "ollama" ? 8 : 10)}>{st.provider === "ollama" ? "Connect" : "Test and save"}</Button></div>
            </form>
          )}
          {msg && <p role="status" className={`m-0 text-sm ${msg.tone === "danger" ? "text-danger" : "text-muted"}`}>{msg.text}</p>}
          {justConnected && st.hasKey && onStart && <div><Button variant="primary" onClick={onStart}>Start building</Button></div>}
        </div>
      )}
    </section>
  );
}
