import type { ContentItem, InstanceRecord } from "@shared/schema";

const LOADER_NAME: Record<InstanceRecord["loader"], string> = { vanilla: "No mod loader", fabric: "Fabric", forge: "Forge", neoforge: "NeoForge" };
export const loaderName = (l: InstanceRecord["loader"]) => LOADER_NAME[l];

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function compactNumber(n: number): string {
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(n);
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

// The one-line pack description, built from the real scan (never a template: real counts on
// every imported pack; this always counts what is actually there).
export function describePack(r: InstanceRecord, items: ContentItem[] | null): string {
  const base = `${loaderName(r.loader)} · Minecraft ${r.mcVersion}`;
  if (!items) return base;
  const mods = items.filter((i) => i.kind === "mod").length;
  const shaders = items.filter((i) => i.kind === "shader").length;
  const rps = items.filter((i) => i.kind === "resourcepack").length;
  const parts = [plural(mods, "mod")];
  if (shaders) parts.push(plural(shaders, "shader"));
  if (rps) parts.push(plural(rps, "resource pack"));
  return `${base} · ${parts.join(", ")}`;
}

export function relativeTime(iso: string, now = Date.now()): string {
  const s = Math.round((now - Date.parse(iso)) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return plural(Math.round(s / 60), "minute") + " ago";
  if (s < 86400) return plural(Math.round(s / 3600), "hour") + " ago";
  if (s < 172800) return "yesterday";
  return new Date(iso).toLocaleDateString("en", { day: "numeric", month: "short" });
}
