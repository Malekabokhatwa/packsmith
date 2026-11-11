import { useState } from "react";
import { iconSrc } from "../lib/api";

// Modrinth icon via the guarded psicon: scheme; falls back to initials, never to a broken image.
export function ProjectIcon({ url, title, dashed = false }: { url?: string; title: string; dashed?: boolean }) {
  const [failed, setFailed] = useState(false);
  const src = iconSrc(url);
  const box = `grid size-8 shrink-0 place-items-center overflow-hidden rounded-sm text-xs font-semibold ${dashed ? "border border-dashed border-input text-subtle" : "bg-surface-2 text-muted"}`;
  if (src && !failed) return <img src={src} alt="" className={`${box} object-cover`} onError={() => setFailed(true)} />;
  const initials = dashed ? "?" : title.replace(/[^A-Za-z0-9 ]/g, "").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "?";
  return <div className={box} aria-hidden>{initials}</div>;
}
