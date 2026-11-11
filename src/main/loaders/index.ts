// M-4 loader versions (LDR-1/2). A pack only records the loader as a component (Prism) and in
// its marker; Prism downloads the loader itself on first launch, so all we need is a version
// that exists for this Minecraft version.
// - Fabric: Fabric's own meta service (fabric.ts).
// - Forge, NeoForge: Prism's meta service, the same list Prism resolves components from, with
//   the exact Minecraft version each build needs and a "recommended" flag (DECISIONS D-21).
import { z } from "zod";
import type { Loader } from "@shared/schema";
import type { Http } from "../net/http";
import { latestStableFabricLoader } from "./fabric";
import { AppError } from "../errors";

export const PRISM_META = "https://meta.prismlauncher.org/v1";
export const LOADER_UID = { fabric: "net.fabricmc.fabric-loader", forge: "net.minecraftforge", neoforge: "net.neoforged" } as const;
const NAME: Record<Exclude<Loader, "vanilla">, string> = { fabric: "Fabric", forge: "Forge", neoforge: "NeoForge" };

const MetaIndex = z.object({
  versions: z.array(z.object({
    version: z.string(),
    recommended: z.boolean().optional(),
    releaseTime: z.string(),
    type: z.string().optional(),
    requires: z.array(z.object({ uid: z.string(), equals: z.string().optional() })).optional(),
  })),
});
type MetaIndex = z.infer<typeof MetaIndex>;

// The indexes are large (Forge ~2 MB) and change a few times a day: keep them for an hour.
const cache = new Map<string, { at: number; data: MetaIndex }>();

async function prismIndex(http: Http, uid: string, now: number): Promise<MetaIndex> {
  const hit = cache.get(uid);
  if (hit && now - hit.at < 3_600_000) return hit.data;
  const parsed = MetaIndex.safeParse(await http.json(`${PRISM_META}/${uid}/index.json`, { allowHosts: ["meta.prismlauncher.org"] }));
  if (!parsed.success) throw new AppError("loader-format", "Prism's version list arrived in a format packsmith doesn't understand.");
  cache.set(uid, { at: now, data: parsed.data });
  return parsed.data;
}

// Recommended build for this Minecraft version, else the newest release, else the newest build.
export function pickPrismLoader(index: MetaIndex, mcVersion: string): string | undefined {
  const fitting = index.versions
    .filter((v) => v.requires?.some((r) => r.uid === "net.minecraft" && r.equals === mcVersion))
    .sort((a, b) => b.releaseTime.localeCompare(a.releaseTime));
  return (fitting.find((v) => v.recommended) ?? fitting.find((v) => !v.type || v.type === "release") ?? fitting[0])?.version;
}

export async function latestLoaderVersion(http: Http, loader: Loader, mcVersion: string, now = Date.now()): Promise<string | undefined> {
  if (loader === "vanilla") return undefined;
  if (loader === "fabric") return latestStableFabricLoader(http, mcVersion);
  const v = pickPrismLoader(await prismIndex(http, LOADER_UID[loader], now), mcVersion);
  if (!v) throw new AppError("no-loader", `${NAME[loader]} has no build for Minecraft ${mcVersion}.`);
  return v;
}

export function clearLoaderCache(): void {
  cache.clear();
}
