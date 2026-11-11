// S10 Settings: AI provider and where packs go (S02). Search and budgets get their own sections
// when they become adjustable; this page shows only settings that work today (spec UX-9).
import { useEffect, useState } from "react";
import type { LauncherKind, Settings } from "@shared/schema";
import type { LauncherStatus } from "@shared/ipc";
import { call, errorMessage } from "../lib/api";
import { Header } from "../components/Header";
import { Button } from "../components/Button";
import { Banner } from "../components/Banner";
import { ProviderSection } from "./ProviderSection";
import { BudgetsSection } from "./BudgetsSection";

export function SettingsScreen({ onStart }: { onStart?: () => void }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [status, setStatus] = useState<LauncherStatus | null>(null);
  const [kind, setKind] = useState<LauncherKind>("app-managed");
  const [root, setRoot] = useState("");
  const [allowed, setAllowed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "info" | "danger"; text: string } | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const [s, st] = await Promise.all([call("settings:get"), call("launcher:status")]);
        setSettings(s);
        setStatus(st);
        setKind(s.launcher.kind);
        setRoot(s.launcher.root ?? st.prismRoot ?? "");
        setAllowed(s.launcher.prismWriteAllowed);
      } catch (e) {
        setMsg({ tone: "danger", text: errorMessage(e) });
      }
    })();
  }, []);

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      const next = await call("settings:setLauncher", { kind, root: kind === "prism" && root.trim() ? root.trim() : undefined, prismWriteAllowed: allowed });
      setSettings(next);
      setMsg({ tone: "info", text: "Saved." });
    } catch (e) {
      setMsg({ tone: "danger", text: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  }

  const option = (value: LauncherKind, label: string, hint: string, disabled = false) => (
    <label className={`flex items-start gap-2.5 rounded-sm border px-3 py-2.5 ${disabled ? "border-border opacity-50" : "cursor-pointer border-border has-checked:border-accent"}`}>
      <input type="radio" name="launcher" value={value} checked={kind === value} disabled={disabled} onChange={() => setKind(value)} className="mt-1 accent-accent" />
      <span className="flex flex-col"><span className="text-sm font-medium">{label}</span><span className="text-xs text-muted">{hint}</span></span>
    </label>
  );

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <Header title="Settings" />
      <main className="flex-1 overflow-auto px-6 py-6">
        <div className="mx-auto flex max-w-(--content-max) flex-col gap-6">
          <ProviderSection onStart={onStart} />
          <BudgetsSection settings={settings} onSaved={setSettings} />
          <section aria-labelledby="eula-h" className="rounded-lg border border-border bg-surface p-5">
            <h2 id="eula-h" className="m-0 text-lg font-semibold">Boot tests</h2>
            <p className="m-0 mt-1 mb-4 text-sm text-muted">packsmith proves a pack by starting a Minecraft server with it on this computer, then stopping it. Running Minecraft's server means agreeing to Mojang's EULA (<a className="text-info underline" href="https://www.minecraft.net/en-us/eula" target="_blank" rel="noreferrer">read it</a>).</p>
            {!settings ? <div className="ps-skeleton h-9 rounded-md bg-surface-2" /> : settings.eulaAcceptedAt
              ? <p role="status" className="m-0 text-sm">You accepted the Minecraft EULA on {new Date(settings.eulaAcceptedAt).toLocaleDateString()}. Boot tests are on.</p>
              : <Button variant="primary" onClick={() => void call("settings:acceptEula", { accept: true }).then(setSettings).catch((e) => setMsg({ tone: "danger", text: errorMessage(e) }))}>I accept the Minecraft EULA</Button>}
            <ClientLogin />
          </section>
          <section aria-labelledby="launcher-h" className="rounded-lg border border-border bg-surface p-5">
            <h2 id="launcher-h" className="m-0 text-lg font-semibold">Where should packs go?</h2>
            <p className="m-0 mt-1 mb-4 text-sm text-muted">packsmith only ever changes packs it made. Your other instances stay exactly as they are.</p>
            {!settings ? <div className="ps-skeleton h-32 rounded-md bg-surface-2" /> : (
              <div className="flex flex-col gap-2">
                {option("app-managed", "Keep them inside packsmith", "Simplest. Packs live in packsmith's own folder.")}
                {option("prism", "Prism Launcher", status?.prismRoot ? "Found Prism on this computer." : "Prism wasn't found automatically. Enter its folder below.")}
                {option("official", "Minecraft Launcher", "Coming in a later build.", true)}
                {kind === "prism" && (
                  <div className="mt-2 flex flex-col gap-3 rounded-md bg-bg p-3.5">
                    <label className="flex flex-col gap-1.5 text-sm font-medium">Prism folder
                      <input value={root} onChange={(e) => setRoot(e.target.value)} spellCheck={false}
                        className="h-8.5 rounded-sm border border-input bg-surface px-2.5 font-mono text-mono-sm outline-none focus-visible:outline-2 focus-visible:outline-focus" />
                    </label>
                    <label className="flex cursor-pointer items-start gap-2.5 text-sm">
                      <input type="checkbox" checked={allowed} onChange={(e) => setAllowed(e.target.checked)} className="mt-0.5 accent-accent" />
                      <span>Let packsmith create new instances in Prism, in a group called "packsmith". It never edits instances it didn't make.</span>
                    </label>
                    {status?.prismRunning && <Banner tone="info">Prism is open. New packs show up right away; they join the "packsmith" group after you close Prism.</Banner>}
                  </div>
                )}
                <div className="mt-2 flex items-center gap-3">
                  <Button variant="primary" loading={busy} onClick={() => void save()}>Save</Button>
                  {msg && <span role="status" className={`text-sm ${msg.tone === "danger" ? "text-danger" : "text-muted"}`}>{msg.text}</span>}
                </div>
              </div>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}

// The client test runs the real game, which needs the user's own Minecraft account (SPEC 8.9).
// They log in once through HeadlessMC in a terminal; packsmith never sees the password or token.
function ClientLogin() {
  const [st, setSt] = useState<{ loggedIn: boolean; ready: boolean; loginCommand: string } | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const check = (setUp = false) => {
    setChecking(true); setError(null);
    void call("client:status", { setUp }).then(setSt).catch((e) => setError(errorMessage(e))).finally(() => setChecking(false));
  };
  useEffect(() => check(), []);
  if (error && !st) return <p role="alert" className="m-0 mt-4 text-sm text-danger">{error}</p>;
  if (!st) return <div className="ps-skeleton mt-4 h-9 rounded-md bg-surface-2" />;
  return (
    <div className="mt-5 flex flex-col gap-2 border-t border-border pt-4">
      <h3 className="m-0 text-sm font-semibold">Game test</h3>
      {error && <p role="alert" className="m-0 text-sm text-danger">{error}</p>}
      {!st.ready ? (
        <>
          <p className="m-0 text-sm text-muted">To test the game itself (not only the server), packsmith uses HeadlessMC with your own Minecraft account. Setting it up downloads HeadlessMC (about 90 MB) from its GitHub releases.</p>
          <div><Button size="sm" loading={checking} onClick={() => check(true)}>Set up the game test</Button></div>
        </>
      ) : st.loggedIn
        ? <p role="status" className="m-0 text-sm">A Minecraft account is logged in for the game test. It runs the game on a hidden screen, never on yours.</p>
        : <>
            <p className="m-0 text-sm text-muted">To test the game itself (not only the server), log in once with your Minecraft account. Run this in a terminal and follow the sign-in link it prints. The login stays with HeadlessMC; packsmith never sees your password or token.</p>
            <code className="block overflow-x-auto rounded-sm border border-border bg-bg p-2.5 font-mono text-mono-sm whitespace-pre">{st.loginCommand}</code>
            <div className="flex gap-2">
              <Button size="sm" onClick={() => void navigator.clipboard.writeText(st.loginCommand)}>Copy</Button>
              <Button size="sm" variant="ghost" loading={checking} onClick={() => check()}>I've logged in</Button>
            </div>
          </>}
    </div>
  );
}
