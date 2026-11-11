// S01/S03/S04 Forge: describe a pack, watch the agent work, read its answer (spec 5.3, CHT-5).
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ArrowUp, Hammer, Pause, Paperclip, Plus, Square, X } from "lucide-react";
import type { ChatView, DisplayItem, ProviderStatus, RunEnvelope, Selectors } from "@shared/agent";
import { call, errorMessage } from "../lib/api";
import { Header } from "../components/Header";
import { Button } from "../components/Button";
import { Banner } from "../components/Banner";
import { Markdown } from "../components/Markdown";
import { Activity } from "../components/Activity";
import { PlanCard } from "../components/PlanCard";
import { EvidenceLadder } from "../components/EvidenceLadder";
import { DoneCard } from "../components/DoneCard";
import { applyEvent } from "../lib/chatEvents";

const CHIPS = ["A cozy farming pack for 1.21.1 with a minimap", "Make my game run smoother", "Shaders that keep 60 fps", "A light exploration pack for Fabric"];
const DEFAULT_SEL: Selectors = { mc: "auto", loader: "auto", mode: "auto" };
const selectCls = "h-8 rounded-sm border border-input bg-surface px-2 text-sm outline-none focus-visible:outline-2 focus-visible:outline-focus";

type AgentItem = Extract<DisplayItem, { kind: "agent" }>;

export function ForgeScreen({ chatId, onChatChange, onGoSettings, prefill, onPrefillTaken }: {
  chatId: string | null; onChatChange: (id: string | null) => void; onGoSettings: () => void; prefill?: string | null; onPrefillTaken?: () => void;
}) {
  const [chat, setChat] = useState<ChatView | null>(null);
  const [sel, setSel] = useState<Selectors>(DEFAULT_SEL);
  const [text, setText] = useState("");
  const [runId, setRunId] = useState<string | null>(null);
  const [pausing, setPausing] = useState(false);
  useEffect(() => { if (!runId) setPausing(false); }, [runId]);
  const [error, setError] = useState<string | null>(null);
  const [attached, setAttached] = useState<{ name: string; text: string } | null>(null); // a diagnosed crash log
  const [provider, setProvider] = useState<ProviderStatus | null>(null);
  const [versions, setVersions] = useState<string[]>([]);
  const [started, setStarted] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const scroller = useRef<HTMLDivElement>(null);
  const buffered = useRef<RunEnvelope[]>([]);       // every live event, for snapshots that arrive late
  const finished = useRef<Set<string>>(new Set());  // runs that already ended
  const input = useRef<HTMLTextAreaElement>(null);

  // A prefilled request: in the composer, cursor at the end, nothing sent.
  useEffect(() => {
    if (!prefill) return;
    setText(prefill);
    onPrefillTaken?.();
    requestAnimationFrame(() => { const el = input.current; if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } });
  }, [prefill, onPrefillTaken]);

  // Arriving on Forge with a provider set up: the cursor is in the composer, ready to type (UX-1).
  useEffect(() => { if (provider?.hasKey) input.current?.focus(); }, [provider?.hasKey]);

  useEffect(() => {
    call("provider:status").then(setProvider).catch(() => setProvider(null));
    call("mc:versions").then(setVersions).catch(() => setVersions([]));
  }, []);

  useEffect(() => {
    setError(null);
    if (!chatId) { setChat(null); setSel(DEFAULT_SEL); return; }
    call("chat:get", { id: chatId }).then(adopt).catch((e) => setError(errorMessage(e)));
  }, [chatId]);

  // Take a snapshot, then replay buffered events newer than it.
  const adopt = useCallback((snap: ChatView) => {
    const c = buffered.current.reduce(applyEvent, snap);
    setChat(c);
    setSel(c.selectors);
    setRunId(c.activeRunId && !finished.current.has(c.activeRunId) ? c.activeRunId : null);
  }, []);

  // Live events for the open chat.
  useEffect(() => window.packsmith.onRunEvent((env) => {
    buffered.current.push(env);
    if (buffered.current.length > 2000) buffered.current.splice(0, 1000);
    if (env.event.type === "finished") {
      finished.current.add(env.runId);
      setRunId((r) => (r === env.runId ? null : r));
      setStarted(null);
    }
    setChat((c) => (c ? applyEvent(c, env) : c));
  }), []);

  useEffect(() => {
    if (!started) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [started]);

  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight; // auto-scroll the live feed (CHT-5 running state)
  }, [chat]);

  const send = useCallback(async (override?: string) => {
    const typed = (override ?? text).trim();
    const log = override === undefined ? attached : null;
    if ((!typed && !log) || runId) return;
    const t = [typed || "My game crashed. Fix it.", ...(log ? [`[Attached crash log ${log.name}, read by packsmith]\n${log.text}`] : [])].join("\n\n");
    setError(null);
    try {
      const res = await call("chat:send", { chatId: chat?.id, text: t, selectors: log && sel.mode === "auto" ? { ...sel, mode: "fix-crash" } : sel });
      if (override === undefined) { setText(""); setAttached(null); }
      setStarted(Date.now());
      setNow(Date.now());
      if (res.chatId !== chat?.id) onChatChange(res.chatId);
      adopt(await call("chat:get", { id: res.chatId }));
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [text, attached, runId, chat, sel, onChatChange, adopt]);

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); }
  }

  const running = runId !== null;
  const noKey = provider !== null && !provider.hasKey;
  const elapsed = started ? Math.max(0, Math.floor((now - started) / 1000)) : 0;
  const lastSteps = (chat?.display.at(-1) as AgentItem | undefined)?.steps;
  const phase = lastSteps?.findLast((s) => s.state === "running")?.label ?? "Thinking";

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <Header title="Forge">
        {chat && <span className="max-w-96 truncate rounded-full bg-surface-2 px-2.5 py-0.5 text-xs font-medium" title={chat.title}>{chat.title}</span>}
        <span className="flex-1" />
        {running && started && (
          <span className="flex items-center gap-2 text-sm text-muted" aria-live="polite">
            <span className="size-2 rounded-full bg-accent [animation:ps-pulse_1.4s_ease-in-out_infinite]" aria-hidden />
            {phase} · {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, "0")}
          </span>
        )}
        {chat && !running && <Button size="sm" variant="ghost" icon={<Plus className="size-4" aria-hidden />} onClick={() => onChatChange(null)}>New chat</Button>}
      </Header>

      <div className="flex flex-wrap items-center gap-3 border-b border-border px-5 py-2 text-xs text-subtle">
        <label className="flex items-center gap-2">Minecraft
          <select className={selectCls} value={sel.mc} disabled={running} onChange={(e) => setSel({ ...sel, mc: e.target.value })}>
            <option value="auto">Let packsmith pick</option>
            {versions.map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-2">Loader
          <select className={selectCls} value={sel.loader} disabled={running} onChange={(e) => setSel({ ...sel, loader: e.target.value as Selectors["loader"] })}>
            <option value="auto">Let packsmith pick</option><option value="fabric">Fabric</option><option value="neoforge">NeoForge</option>
            <option value="forge">Forge</option><option value="vanilla">No mod loader</option>
          </select>
        </label>
        <label className="flex items-center gap-2">Task
          <select className={selectCls} value={sel.mode} disabled={running} onChange={(e) => setSel({ ...sel, mode: e.target.value as Selectors["mode"] })}>
            <option value="auto">Let packsmith decide</option><option value="custom-pack">Build a custom pack</option><option value="mods">Add mods</option>
            <option value="shaders">Shaders</option><option value="resourcepacks">Resource packs</option><option value="settings">Change settings</option><option value="fix-crash">Fix a crash</option>
          </select>
        </label>
      </div>

      <div ref={scroller} className="min-h-0 flex-1 overflow-auto px-6 py-6">
        <div className="mx-auto flex max-w-(--content-max) flex-col gap-5">
          {noKey && <Banner action={<Button size="sm" variant="primary" onClick={onGoSettings}>Add a provider</Button>}>packsmith needs an AI provider to work. Your key stays on this computer.</Banner>}
          {error && <Banner tone="danger">{error}</Banner>}
          {!chat && (
            <div className="flex flex-col items-center gap-3 py-12 text-center">
              <Hammer className="size-8 text-subtle" strokeWidth={1.5} aria-hidden />
              <h2 className="m-0 text-display font-semibold">What should we forge?</h2>
              <p className="m-0 max-w-lg text-muted">Describe the pack you want. packsmith finds the mods on Modrinth, works out what they need, and installs them into a new pack.</p>
              <div className="mt-2 flex max-w-xl flex-wrap justify-center gap-2">
                {CHIPS.map((c) => (
                  <button key={c} type="button" onClick={() => { setText(c); input.current?.focus(); }}
                    className="rounded-full bg-surface-2 px-3 py-1 text-sm hover:text-text">{c}</button>
                ))}
              </div>
            </div>
          )}
          {chat?.display.map((d, i) => d.kind === "user" ? (
            <div key={i} className="ms-auto max-w-140 rounded-md rounded-br-xs bg-surface-2 px-3.5 py-2.5 whitespace-pre-wrap">{d.text}</div>
          ) : (
            <section key={i} aria-label="packsmith's answer">
              <Activity steps={d.steps} running={d.outcome === "running"} />
              {d.plan && (
                // The plan's buttons only answer the latest plan, once its run has finished.
                i === chat.display.length - 1 && d.outcome === "done" && !running
                  ? <PlanCard plan={d.plan} onForge={() => void send("Forge it")}
                      onChange={() => { setText("Change the plan: "); requestAnimationFrame(() => { const el = input.current; if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } }); }} />
                  : <PlanCard plan={d.plan} />
              )}
              {d.text && <Markdown text={d.text} streaming={d.outcome === "running"} />}
              {d.evidence && (d.outcome === "done" && !d.evidence.branches.some((b) => b.status === "failed")
                ? <DoneCard report={d.evidence} />
                : <div className="mt-1 mb-3"><EvidenceLadder report={d.evidence} /></div>)}
              {d.outcome === "running" && !d.text && d.steps.length === 0 && <p className="m-0 text-sm text-subtle">Thinking…</p>}
              {d.outcome === "stopped" && <Banner>{d.message && d.message !== "Stopped." ? d.message : "Stopped. Files that finished downloading are in the pack; nothing is left half-written."}</Banner>}
              {(d.outcome === "blocked" || d.outcome === "error") && d.message && <Banner tone={d.outcome === "error" ? "danger" : "warning"}>{d.message}</Banner>}
              {d.outcome === "paused" && (
                // CHT-3: resuming continues the same chat from the step it paused after.
                <Banner action={i === chat.display.length - 1 && !running
                  ? <Button size="sm" variant="primary" onClick={() => void send("Continue where you paused.")}>Resume</Button> : undefined}>
                  {d.message ?? "Paused. Nothing is half-written."}
                </Banner>
              )}
              {d.outcome === "full" && (
                // CHT-2: a designed state, not an error. The new chat starts with the last request.
                <Banner action={<Button size="sm" variant="primary" onClick={() => {
                  const last = chat.display.slice(0, i).reverse().find((x) => x.kind === "user");
                  onChatChange(null);
                  if (last?.kind === "user") setText(last.text);
                  requestAnimationFrame(() => input.current?.focus());
                }}>Start a new chat</Button>}>{d.message ?? "This chat is full. Start a new chat to go on."}</Banner>
              )}
            </section>
          ))}
        </div>
      </div>

      <div className="border-t border-border px-6 pt-3 pb-4">
        <div className="mx-auto flex max-w-(--content-max) items-end gap-2 rounded-lg border border-border bg-surface p-2 focus-within:border-input">
          <Button variant="ghost" aria-label="Attach a crash log" title="Attach a crash log" disabled={running || noKey} icon={<Paperclip className="size-4" aria-hidden />}
            onClick={() => void call("crash:pick").then((a) => { if (a) { setAttached(a); input.current?.focus(); } }).catch((e) => setError(errorMessage(e)))} />
          {attached && (
            <span className="flex max-w-56 items-center gap-1 self-center rounded-full bg-surface-2 py-0.5 ps-2.5 pe-1 text-xs">
              <span className="truncate" title={attached.name}>{attached.name}</span>
              <button type="button" aria-label={`Remove ${attached.name}`} className="rounded-full p-0.5 text-muted hover:text-text" onClick={() => setAttached(null)}><X className="size-3" aria-hidden /></button>
            </span>
          )}
          <label className="sr-only" htmlFor="composer">Describe a pack</label>
          <textarea id="composer" ref={input} rows={1} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey}
            disabled={running || noKey}
            placeholder={running ? "packsmith is working. Stop to interrupt." : noKey ? "Add an AI provider in Settings to start." : attached ? "Add a note, or just send" : "Describe a pack, or paste a crash log"}
            className="field-sizing-content max-h-48 min-h-8.5 flex-1 resize-none bg-transparent px-1.5 py-1.5 outline-none placeholder:text-subtle" />
          {running && (
            <Button variant="ghost" aria-label="Pause" title="Pause after the current step" disabled={pausing} icon={<Pause className="size-4" aria-hidden />}
              onClick={() => { if (runId) { setPausing(true); void call("run:pause", { runId }); } }}>{pausing ? "Pausing…" : "Pause"}</Button>
          )}
          {running
            ? <Button variant="danger" aria-label="Stop" icon={<Square className="size-4" fill="currentColor" aria-hidden />} onClick={() => runId && void call("run:stop", { runId })}>Stop</Button>
            : <Button variant="primary" aria-label="Send" icon={<ArrowUp className="size-4" aria-hidden />} disabled={(!text.trim() && !attached) || noKey} onClick={() => void send()} />}
        </div>
      </div>
    </div>
  );
}
