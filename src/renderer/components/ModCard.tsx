// Inline mod card in an answer (S04/S12): icon, name, one-line summary. The agent writes
// {{mod:<project id>}}; cards come from one shared cache filled in batches, so streaming text
// around them never makes a card reload or flicker (CHT-1).
import { useEffect, useState } from "react";
import type { Out } from "@shared/ipc";
import { call } from "../lib/api";
import { ProjectIcon } from "./ProjectIcon";

type Card = Out<"modrinth:cards">[number];
type Entry = { state: "loading" } | { state: "done"; card: Card } | { state: "missing" };

const cache = new Map<string, Entry>();
const listeners = new Set<() => void>();
let queued = new Set<string>();
let timer: ReturnType<typeof setTimeout> | null = null;

function request(id: string): void {
  if (cache.has(id)) return;
  cache.set(id, { state: "loading" });
  queued.add(id);
  timer ??= setTimeout(flush, 30);
}

async function flush(): Promise<void> {
  const ids = [...queued].slice(0, 50);
  queued = new Set([...queued].slice(50));
  timer = queued.size ? setTimeout(flush, 30) : null;
  const found = await call("modrinth:cards", { ids }).catch(() => [] as Card[]);
  for (const id of ids) {
    const card = found.find((c) => c.id === id);
    cache.set(id, card ? { state: "done", card } : { state: "missing" });
  }
  for (const l of listeners) l();
}

// For tests.
export function resetModCards(): void { cache.clear(); queued.clear(); }

export function ModCard({ id }: { id: string }) {
  const [, rerender] = useState(0);
  useEffect(() => {
    const l = () => rerender((n) => n + 1);
    listeners.add(l);
    request(id);
    return () => { listeners.delete(l); };
  }, [id]);
  const e = cache.get(id) ?? { state: "loading" as const };
  const card = e.state === "done" ? e.card : null;
  const title = card?.title ?? (e.state === "missing" ? "A Modrinth project" : "");
  return (
    <a href={`https://modrinth.com/project/${id}`} target="_blank" rel="noreferrer"
      aria-label={card ? `${card.title} on Modrinth` : "A Modrinth project"}
      className="my-0.5 inline-flex w-full max-w-90 items-center gap-2.5 rounded-md border border-border bg-surface-2 px-2.5 py-1.5 align-middle no-underline hover:border-input">
      {e.state === "loading"
        ? <span className="size-8 shrink-0 rounded-sm bg-surface" aria-hidden />
        : <ProjectIcon url={card?.iconUrl} title={title} dashed={!card} />}
      <span className="flex min-w-0 flex-col">
        {e.state === "loading"
          ? <span className="h-3.5 w-32 rounded-xs bg-surface" aria-hidden />
          : <span className="truncate text-sm font-semibold text-text">{title}</span>}
        <span className="truncate text-xs text-muted">{card?.summary ?? (e.state === "missing" ? id : " ")}</span>
      </span>
    </a>
  );
}
