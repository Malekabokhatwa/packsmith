// S12 History: past chats, newest first, titled from the request (never "Untitled chat").
// Each row can be renamed in place or deleted; "Delete all chats" asks first. A chat that is still
// working is never deleted.
import { useEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Clock, Pencil, Trash2, X } from "lucide-react";
import type { ChatSummary } from "@shared/agent";
import { call, errorMessage } from "../lib/api";
import { Header } from "../components/Header";
import { EmptyState } from "../components/EmptyState";
import { Banner } from "../components/Banner";
import { Button } from "../components/Button";

function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}

type Confirm = { kind: "one"; chat: ChatSummary } | { kind: "all" } | null;

export function HistoryScreen({ onOpen, onDeleted }: { onOpen: (id: string) => void; onDeleted?: (ids: string[] | "all") => void }) {
  const [chats, setChats] = useState<ChatSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; title: string } | null>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const edit = useRef<HTMLInputElement>(null);
  const load = () => call("chat:list").then(setChats).catch((e) => { setError(errorMessage(e)); setChats([]); });
  useEffect(() => { void load(); }, []);
  useEffect(() => { if (editing) edit.current?.select(); }, [editing?.id]);

  async function saveTitle() {
    if (!editing) return;
    const { id, title } = editing;
    setEditing(null);
    if (!title.trim()) return;
    try { await call("chat:rename", { id, title }); await load(); } catch (e) { setError(errorMessage(e)); }
  }
  async function doDelete() {
    const c = confirm;
    setConfirm(null);
    if (!c) return;
    setError(null); setNotice(null);
    try {
      if (c.kind === "one") { await call("chat:delete", { id: c.chat.id }); onDeleted?.([c.chat.id]); }
      else {
        const r = await call("chat:deleteAll");
        onDeleted?.("all");
        if (r.kept) setNotice(`${r.kept} chat${r.kept === 1 ? " is" : "s are"} still working, so ${r.kept === 1 ? "it was" : "they were"} kept.`);
      }
      await load();
    } catch (e) { setError(errorMessage(e)); }
  }

  const icon = "rounded-sm p-1.5 text-muted hover:bg-bg hover:text-text focus-visible:opacity-100";
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <Header title="History" />
      <main className="flex-1 overflow-auto px-6 py-5">
        <div className="mx-auto max-w-(--content-max)">
          {error && <div className="mb-3"><Banner tone="danger">{error}</Banner></div>}
          {notice && <div className="mb-3"><Banner>{notice}</Banner></div>}
          {chats === null && <div className="ps-skeleton h-12 rounded-md bg-surface-2" />}
          {chats?.length === 0 && !error && <EmptyState icon={<Clock className="size-8" strokeWidth={1.5} />} text="No chats yet." />}
          <ul className="m-0 flex list-none flex-col gap-0.5 p-0" aria-label="Chats">
            {chats?.map((c) => (
              <li key={c.id} className="group flex items-center gap-1 rounded-md hover:bg-surface-2 focus-within:bg-surface-2">
                {editing?.id === c.id ? (
                  <input ref={edit} aria-label="Chat name" value={editing.title} maxLength={80}
                    onChange={(e) => setEditing({ id: c.id, title: e.target.value })}
                    onKeyDown={(e) => { if (e.key === "Enter") void saveTitle(); if (e.key === "Escape") setEditing(null); }}
                    onBlur={() => void saveTitle()}
                    className="mx-1.5 my-1 h-8 min-w-0 flex-1 rounded-sm border border-input bg-bg px-2 text-base outline-none focus:border-focus" />
                ) : (
                  <button type="button" onClick={() => onOpen(c.id)} className="flex min-w-0 flex-1 items-center gap-3 rounded-md px-3 py-2.5 text-left">
                    <span className="min-w-0 flex-1 truncate" title={c.title}>{c.title}</span>
                    <span className="shrink-0 text-xs text-subtle">{ago(c.updatedAt)}</span>
                  </button>
                )}
                <span className="flex shrink-0 gap-0.5 pe-1.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">
                  <button type="button" aria-label={`Rename "${c.title}"`} className={icon} onClick={() => setEditing({ id: c.id, title: c.title })}><Pencil className="size-4" aria-hidden /></button>
                  <button type="button" aria-label={`Delete "${c.title}"`} className={`${icon} hover:text-danger`} onClick={() => setConfirm({ kind: "one", chat: c })}><Trash2 className="size-4" aria-hidden /></button>
                </span>
              </li>
            ))}
          </ul>
          {chats && chats.length > 0 && (
            <div className="mt-4 flex justify-end">
              <Button variant="ghost" size="sm" icon={<Trash2 className="size-3.5" aria-hidden />} onClick={() => setConfirm({ kind: "all" })}>Delete all chats</Button>
            </div>
          )}
        </div>
      </main>
      <Dialog.Root open={confirm !== null} onOpenChange={(o) => { if (!o) setConfirm(null); }}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-bg/70" />
          <Dialog.Content className="fixed top-1/2 left-1/2 w-110 max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 rounded-lg bg-surface p-5 shadow-pop outline-none">
            <div className="mb-2 flex items-start gap-3">
              <Dialog.Title className="m-0 flex-1 text-lg font-semibold">{confirm?.kind === "all" ? "Delete all chats?" : "Delete this chat?"}</Dialog.Title>
              <Dialog.Close aria-label="Close" className="rounded-sm p-1 text-muted hover:bg-surface-2 hover:text-text"><X className="size-4" /></Dialog.Close>
            </div>
            <Dialog.Description className="m-0 mb-4 text-sm text-muted">
              {confirm?.kind === "one" ? `"${confirm.chat.title}" and its steps are removed.` : "Every chat and its steps are removed."} Your packs stay exactly as they are.
            </Dialog.Description>
            <div className="flex justify-end gap-2">
              <Dialog.Close asChild><Button variant="ghost">Cancel</Button></Dialog.Close>
              <Button variant="danger" onClick={() => void doDelete()}>{confirm?.kind === "all" ? "Delete all" : "Delete"}</Button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
