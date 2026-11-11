// S05 adoption (SPEC 6.13, D-33): a Prism instance packsmith didn't make is shown read-only
// (name and versions only) until the user picks what packsmith may change in it. Only this click
// adopts an instance; the agent can't. Stop managing hands it back.
import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Lock, X } from "lucide-react";
import type { AdoptionScope, InstanceRecord } from "@shared/schema";
import type { Out } from "@shared/ipc";
import { call, errorMessage } from "../lib/api";
import { loaderName } from "../lib/format";
import { Button } from "../components/Button";
import { Banner } from "../components/Banner";

export type Found = Out<"adoption:discover">[number];

const SCOPES: Array<{ scope: AdoptionScope; label: string; hint: string }> = [
  { scope: "mods", label: "Mods", hint: "add, remove, turn on/off, update" },
  { scope: "configs", label: "Configs", hint: "files in config/" },
  { scope: "settings", label: "Game settings", hint: "options.txt" },
  { scope: "shaders", label: "Shaders", hint: "shaderpacks/" },
  { scope: "resourcepacks", label: "Resource packs", hint: "resourcepacks/" },
  { scope: "quests", label: "Quests", hint: "quest files only" },
  { scope: "loader", label: "Mod loader", hint: "add Fabric, Forge or NeoForge to a vanilla instance" },
];
const DEFAULT_SCOPES: AdoptionScope[] = ["mods", "configs", "settings"];

export function FoundDetail({ found, onManaged }: { found: Found; onManaged: (r: InstanceRecord) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-auto px-6 py-5">
      <div className="mb-4 flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <h2 className="m-0 truncate text-xl font-semibold" title={found.name}>{found.name}</h2>
          <p className="m-0 mt-1 text-sm text-muted">
            {found.loader ? loaderName(found.loader) : "Unsupported loader"}{found.mcVersion ? ` · Minecraft ${found.mcVersion}` : ""} · {found.modFiles} file{found.modFiles === 1 ? "" : "s"} in mods
          </p>
        </div>
        <Button variant="primary" disabled={!found.adoptable} onClick={() => setOpen(true)}>Manage this instance…</Button>
      </div>
      <Banner>
        packsmith is only reading this instance's name and versions. It won't open or change anything in it until you choose Manage.
      </Banner>
      {!found.adoptable && found.reason && <div className="mt-3"><Banner tone="warning">{found.reason}</Banner></div>}
      <ManageDialog found={found} open={open} onOpenChange={setOpen} onManaged={onManaged} />
    </div>
  );
}

function ManageDialog({ found, open, onOpenChange, onManaged }: { found: Found; open: boolean; onOpenChange: (o: boolean) => void; onManaged: (r: InstanceRecord) => void }) {
  const [scope, setScope] = useState<AdoptionScope[]>(found.loader === "vanilla" ? [...DEFAULT_SCOPES, "loader"] : DEFAULT_SCOPES);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toggle = (s: AdoptionScope) => setScope((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]));
  const adopt = async () => {
    setBusy(true); setError(null);
    try { onManaged(await call("adoption:adopt", { ref: found.ref, scope })); onOpenChange(false); }
    catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  };
  return (
    <Dialog.Root open={open} onOpenChange={(o) => { if (!busy) onOpenChange(o); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-bg/70" />
        <Dialog.Content className="fixed top-1/2 left-1/2 w-120 max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 rounded-lg bg-surface p-5 shadow-pop outline-none">
          <div className="mb-2 flex items-center gap-2">
            <Dialog.Title className="m-0 flex-1 truncate text-lg font-semibold">Let packsmith change {found.name}?</Dialog.Title>
            <Dialog.Close aria-label="Close" className="rounded-sm p-1 text-muted hover:bg-surface-2 hover:text-text"><X className="size-4" /></Dialog.Close>
          </div>
          <Dialog.Description className="m-0 mb-3 text-sm text-muted">
            Pick what it may change. It records the files first, every change can be undone from the Journal tab, and worlds are never touched.
          </Dialog.Description>
          <fieldset className="m-0 mb-4 flex flex-col gap-1.5 border-0 p-0">
            <legend className="sr-only">What packsmith may change</legend>
            {SCOPES.filter((s) => s.scope !== "loader" || found.loader === "vanilla").map((s) => (
              <label key={s.scope} className="flex items-center gap-2.5 rounded-sm px-1 py-1 text-sm hover:bg-surface-2">
                <input type="checkbox" className="size-4 accent-accent" checked={scope.includes(s.scope)} onChange={() => toggle(s.scope)} />
                <span className="font-medium">{s.label}</span>
                <span className="text-xs text-subtle">{s.hint}</span>
              </label>
            ))}
          </fieldset>
          {error && <div className="mb-3"><Banner tone="danger">{error}</Banner></div>}
          <div className="flex justify-end gap-2">
            <Dialog.Close asChild><Button type="button" variant="ghost" disabled={busy}>Cancel</Button></Dialog.Close>
            <Button type="button" variant="primary" loading={busy} disabled={busy || scope.length === 0} onClick={() => void adopt()}>Allow selected changes</Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// A managed instance's header action: hand it back (INS-3's boundary again). Nothing is deleted.
export function StopManaging({ pack, onStopped }: { pack: InstanceRecord; onStopped: () => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stop = async () => {
    setBusy(true); setError(null);
    try { await call("adoption:revoke", { id: pack.id }); setOpen(false); onStopped(); }
    catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  };
  return (
    <>
      <Button variant="ghost" icon={<Lock className="size-4" aria-hidden />} onClick={() => setOpen(true)}>Stop managing</Button>
      <Dialog.Root open={open} onOpenChange={(o) => { if (!busy) setOpen(o); }}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-bg/70" />
          <Dialog.Content className="fixed top-1/2 left-1/2 w-120 max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 rounded-lg bg-surface p-5 shadow-pop outline-none">
            <Dialog.Title className="m-0 mb-2 text-lg font-semibold">Stop managing {pack.name}?</Dialog.Title>
            <Dialog.Description className="m-0 mb-4 text-sm text-muted">
              packsmith won't change it again, and its changes can't be undone from here until you manage it again. Nothing is deleted and the instance stays as it is now.
            </Dialog.Description>
            {error && <div className="mb-3"><Banner tone="danger">{error}</Banner></div>}
            <div className="flex justify-end gap-2">
              <Dialog.Close asChild><Button type="button" variant="ghost" disabled={busy}>Cancel</Button></Dialog.Close>
              <Button type="button" variant="danger" loading={busy} onClick={() => void stop()}>Stop managing</Button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
