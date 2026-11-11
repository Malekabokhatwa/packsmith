import { useEffect, useState, type FormEvent } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { InstanceRecord, Loader, Settings } from "@shared/schema";
import { call, errorMessage } from "../lib/api";
import { Button } from "../components/Button";
import { Banner } from "../components/Banner";

const LOADERS: ReadonlyArray<readonly [Loader, string, string]> = [
  ["fabric", "Fabric", "Light and quick to update. Most performance and map mods live here."],
  ["neoforge", "NeoForge", "Big tech, magic and adventure mods on recent versions."],
  ["forge", "Forge", "The classic home of large mods, mostly on older versions."],
  ["vanilla", "None", "Shaders and resource packs only."],
];

const field = "h-8.5 w-full rounded-sm border border-input bg-bg px-2.5 text-sm outline-none focus-visible:outline-2 focus-visible:outline-focus";

export function NewPackDialog({ open, onOpenChange, onCreated, onGoSettings }: {
  open: boolean; onOpenChange: (o: boolean) => void; onCreated: (r: InstanceRecord) => void; onGoSettings: () => void;
}) {
  const [name, setName] = useState("");
  const [versions, setVersions] = useState<string[] | null>(null);
  const [mc, setMc] = useState("");
  const [loader, setLoader] = useState<Loader>("fabric");
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError(null);
    call("settings:get").then(setSettings).catch((e) => setError(errorMessage(e)));
    if (!versions) call("mc:versions").then((v) => { setVersions(v); setMc((cur) => cur || v[0] || ""); }).catch((e) => setError(errorMessage(e)));
  }, [open, versions]);

  const needsPermission = settings?.launcher.kind === "prism" && !settings.launcher.prismWriteAllowed;
  const where = settings?.launcher.kind === "prism" ? "Prism Launcher, in its \"packsmith\" group" : "packsmith's own folder";

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await call("packs:create", { name, mcVersion: mc, loader });
      onCreated(r);
      onOpenChange(false);
      setName("");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-bg/70" />
        <Dialog.Content className="fixed top-1/2 left-1/2 w-120 max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 rounded-lg bg-surface p-5 shadow-pop outline-none">
          <div className="mb-4 flex items-center">
            <Dialog.Title className="m-0 flex-1 text-lg font-semibold">New pack</Dialog.Title>
            <Dialog.Close aria-label="Close" className="rounded-sm p-1 text-muted hover:bg-surface-2 hover:text-text"><X className="size-4" /></Dialog.Close>
          </div>
          <Dialog.Description className="m-0 mb-4 text-sm text-muted">It goes into {where}.</Dialog.Description>
          {needsPermission ? (
            <Banner tone="warning" action={<Button size="sm" onClick={() => { onOpenChange(false); onGoSettings(); }}>Open Settings</Button>}>
              packsmith needs your permission once before it creates instances in Prism.
            </Banner>
          ) : (
            <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
              <label className="flex flex-col gap-1.5 text-sm font-medium">Name
                <input className={field} value={name} onChange={(e) => setName(e.target.value)} maxLength={60} required placeholder="Hearthwood" />
              </label>
              <label className="flex flex-col gap-1.5 text-sm font-medium">Minecraft version
                <select className={field} value={mc} onChange={(e) => setMc(e.target.value)} disabled={!versions} required>
                  {!versions && <option>Loading versions…</option>}
                  {versions?.map((v) => <option key={v} value={v}>{v}</option>)}
                </select>
              </label>
              <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
                <legend className="mb-1.5 p-0 text-sm font-medium">Mod loader</legend>
                {LOADERS.map(([v, label, hint]) => (
                  <label key={v} className="flex cursor-pointer items-start gap-2.5 rounded-sm border border-border px-3 py-2 has-checked:border-accent">
                    <input type="radio" name="loader" value={v} checked={loader === v} onChange={() => setLoader(v)} className="mt-1 accent-accent" />
                    <span className="flex flex-col"><span className="text-sm font-medium">{label}</span><span className="text-xs text-muted">{hint}</span></span>
                  </label>
                ))}
                <p className="m-0 text-xs text-subtle">Prism downloads the loader the first time you play.</p>
              </fieldset>
              {error && <Banner tone="danger">{error}</Banner>}
              <div className="flex justify-end gap-2">
                <Dialog.Close asChild><Button type="button" variant="ghost">Cancel</Button></Dialog.Close>
                <Button type="submit" variant="primary" loading={busy} disabled={!name.trim() || !mc}>Create pack</Button>
              </div>
            </form>
          )}
          {needsPermission && error && <div className="mt-3"><Banner tone="danger">{error}</Banner></div>}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
