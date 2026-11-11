// The Journal tab (spec 4.3, G-5): every change packsmith made to this pack, newest first, each
// undoable. Undo asks first and says which files it puts back.
import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { History, Undo2, X } from "lucide-react";
import type { JournalEntry } from "@shared/schema";
import { Button } from "../components/Button";
import { Banner } from "../components/Banner";
import { EmptyState } from "../components/EmptyState";
import { plural, relativeTime } from "../lib/format";

const ACTION: Record<JournalEntry["action"], string> = {
  write: "Setting", download: "Added", update: "Updated", remove: "Removed", enable: "Turned on", disable: "Turned off", "set-loader": "Loader", "write-quests": "Quests",
};

export function JournalTab({ entries, onUndo }: { entries: JournalEntry[] | null; onUndo: (e: JournalEntry) => Promise<void> }) {
  const [asking, setAsking] = useState<JournalEntry | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (entries === null) return <ul className="m-0 flex list-none flex-col gap-2 p-0" aria-label="Loading">{[0, 1].map((i) => <li key={i} className="ps-skeleton h-13 rounded-md bg-surface-2" />)}</ul>;
  if (entries.length === 0) return <EmptyState icon={<History className="size-8" strokeWidth={1.5} />} text="No changes yet. Everything packsmith changes in this pack shows up here, and can be undone." />;

  async function confirm() {
    if (!asking) return;
    setBusy(true);
    setError(null);
    try {
      await onUndo(asking);
      setAsking(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <ol aria-label="Journal" className="m-0 flex list-none flex-col gap-0.5 p-0">
        {entries.map((e) => (
          <li key={e.id} className="grid grid-cols-[7rem_1fr_auto] items-center gap-3 rounded-md px-3 py-2.5 hover:bg-surface-2">
            <span className="text-xs text-subtle">{relativeTime(e.at)}</span>
            <div className="min-w-0">
              <div className="flex items-baseline gap-2">
                <span className="shrink-0 rounded-xs border border-border px-1.5 text-xs text-muted">{ACTION[e.action]}</span>
                <span className={`truncate ${e.state === "rolled-back" ? "text-subtle line-through" : ""}`} title={e.reason}>{e.reason}</span>
              </div>
              <div className="truncate font-mono text-mono-sm text-subtle" title={e.files.map((f) => f.relpath).join("\n")}>
                {e.files.map((f) => f.relpath.split("/").pop()).join(", ")}
              </div>
            </div>
            {e.state === "committed" ? (
              <Button size="sm" variant="ghost" icon={<Undo2 className="size-3.5" aria-hidden />} aria-label={`Undo: ${e.reason}`} onClick={() => { setError(null); setAsking(e); }}>Undo</Button>
            ) : (
              <span className="px-2 text-xs text-subtle">{e.state === "rolled-back" ? "Undone" : "Unfinished"}</span>
            )}
          </li>
        ))}
      </ol>
      <Dialog.Root open={asking !== null} onOpenChange={(o) => { if (!o && !busy) setAsking(null); }}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-bg/70" />
          <Dialog.Content className="fixed top-1/2 left-1/2 w-120 max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 rounded-lg bg-surface p-5 shadow-pop outline-none">
            <div className="mb-3 flex items-center">
              <Dialog.Title className="m-0 flex-1 text-lg font-semibold">Undo this change?</Dialog.Title>
              <Dialog.Close aria-label="Close" className="rounded-sm p-1 text-muted hover:bg-surface-2 hover:text-text"><X className="size-4" /></Dialog.Close>
            </div>
            {asking && (
              <Dialog.Description className="m-0 mb-3 text-sm text-muted">
                “{asking.reason}”. packsmith puts {plural(asking.files.length, "file")} back exactly as {asking.files.length === 1 ? "it was" : "they were"} before:
              </Dialog.Description>
            )}
            <ul className="m-0 mb-4 max-h-40 list-none overflow-auto p-0 font-mono text-mono-sm text-subtle">
              {asking?.files.map((f) => <li key={f.relpath} className="truncate" title={f.relpath}>{f.relpath}</li>)}
            </ul>
            {error && <div className="mb-3"><Banner tone="danger">{error}</Banner></div>}
            <div className="flex justify-end gap-2">
              <Dialog.Close asChild><Button type="button" variant="ghost" disabled={busy}>Cancel</Button></Dialog.Close>
              <Button variant="primary" loading={busy} onClick={() => void confirm()}>Undo change</Button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
