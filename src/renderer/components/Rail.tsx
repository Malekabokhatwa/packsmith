import type { ReactNode } from "react";
import { Boxes, Clock, Hammer, Settings } from "lucide-react";

export type Screen = "forge" | "packs" | "history" | "settings";

function Item({ id, label, icon, current, onGo }: { id: Screen; label: string; icon: ReactNode; current: Screen; onGo: (s: Screen) => void }) {
  const active = id === current;
  return (
    <button
      type="button"
      onClick={() => onGo(id)}
      aria-current={active ? "page" : undefined}
      className={`relative flex w-14 flex-col items-center gap-0.5 rounded-sm pt-2 pb-1.5 text-xs hover:bg-surface-2 hover:text-text ${active ? "text-text" : "text-muted"}`}
    >
      {active && <span className="absolute top-2 bottom-2 -left-1 w-0.75 rounded-full bg-accent" aria-hidden />}
      {icon}
      {label}
    </button>
  );
}

export function Rail({ current, onGo }: { current: Screen; onGo: (s: Screen) => void }) {
  return (
    <nav aria-label="Main" className="flex w-(--rail) shrink-0 flex-col items-center gap-1 border-r border-border bg-bg py-2.5">
      <Hammer className="mb-3.5 size-7 text-accent" strokeWidth={1.75} aria-label="packsmith" />
      <Item id="forge" label="Forge" icon={<Hammer className="size-5" strokeWidth={1.75} aria-hidden />} current={current} onGo={onGo} />
      <Item id="packs" label="Packs" icon={<Boxes className="size-5" strokeWidth={1.75} aria-hidden />} current={current} onGo={onGo} />
      <span className="flex-1" />
      <Item id="history" label="History" icon={<Clock className="size-5" strokeWidth={1.75} aria-hidden />} current={current} onGo={onGo} />
      <Item id="settings" label="Settings" icon={<Settings className="size-5" strokeWidth={1.75} aria-hidden />} current={current} onGo={onGo} />
    </nav>
  );
}
