// Minecraft's own game files from Mojang's official endpoints (spec 4.1), SHA-1 verified, cached
// in packsmith's data folder. The client jar is the source of truth for vanilla ids, the data pack
// format and item textures (QST-4); the server jar runs boot tests (M-8, SPEC 8.8: only after the
// user accepted the EULA). Read-only; never redistributed.
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { access, mkdir, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { z } from "zod";
import type { Http } from "./net/http";
import { AppError } from "./errors";

const MANIFEST = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";
const MOJANG_HOSTS = ["piston-meta.mojang.com", "piston-data.mojang.com", "launchermeta.mojang.com", "launcher.mojang.com"];

const Manifest = z.object({ versions: z.array(z.object({ id: z.string(), url: z.string() })) });
const Download = z.object({ sha1: z.string(), size: z.number(), url: z.string() });
const VersionJson = z.object({
  downloads: z.object({ client: Download, server: Download.optional() }),
  javaVersion: z.object({ majorVersion: z.number().int() }).optional(),
});
export type VersionInfo = z.infer<typeof VersionJson>;

const exists = (p: string) => access(p).then(() => true, () => false);

export interface JarLocations { prismRoots: string[]; cacheDir: string }

export function defaultLocations(dataDir: string, prismRoot: string | null): JarLocations {
  return { prismRoots: prismRoot ? [prismRoot] : [], cacheDir: join(dataDir, "cache", "minecraft") };
}

// A client jar that is already on this computer, or null.
export async function localClientJar(mc: string, loc: JarLocations): Promise<string | null> {
  const candidates = [
    ...loc.prismRoots.map((r) => join(r, "libraries/com/mojang/minecraft", mc, `minecraft-${mc}-client.jar`)),
    join(homedir(), ".minecraft/versions", mc, `${mc}.jar`),
    join(loc.cacheDir, `${mc}-client.jar`),
  ];
  for (const c of candidates) if (await exists(c)) return c;
  return null;
}

// Mojang's details for one version (downloads, the Java it needs).
export async function versionInfo(http: Http, mc: string): Promise<VersionInfo> {
  const manifest = Manifest.safeParse(await http.json(MANIFEST, { allowHosts: MOJANG_HOSTS }));
  if (!manifest.success) throw new AppError("mojang-format", "Mojang's version list arrived in a format packsmith doesn't understand.");
  const entry = manifest.data.versions.find((v) => v.id === mc);
  if (!entry) throw new AppError("no-version", `Mojang has no Minecraft ${mc}.`);
  const vj = VersionJson.safeParse(await http.json(entry.url, { allowHosts: MOJANG_HOSTS }));
  if (!vj.success) throw new AppError("mojang-format", `Mojang's details for ${mc} arrived in a format packsmith doesn't understand.`);
  return vj.data;
}

export async function clientJar(http: Http, mc: string, loc: JarLocations): Promise<string> {
  const local = await localClientJar(mc, loc);
  if (local) return local;
  const info = await versionInfo(http, mc);
  return fetchVerified(http, info.downloads.client, join(loc.cacheDir, `${mc}-client.jar`), `the Minecraft ${mc} game file`);
}

// The dedicated server jar, cached. Callers must have the user's EULA acceptance (SPEC 8.8).
export async function serverJar(http: Http, mc: string, loc: JarLocations, info?: VersionInfo): Promise<string> {
  const dest = join(loc.cacheDir, `${mc}-server.jar`);
  if (await exists(dest)) return dest;
  const v = info ?? (await versionInfo(http, mc));
  if (!v.downloads.server) throw new AppError("no-server", `Mojang publishes no dedicated server for Minecraft ${mc}.`);
  return fetchVerified(http, v.downloads.server, dest, `the Minecraft ${mc} server`);
}

async function fetchVerified(http: Http, d: z.infer<typeof Download>, dest: string, what: string): Promise<string> {
  await mkdir(join(dest, ".."), { recursive: true });
  const part = `${dest}.part`;
  await rm(part, { force: true });
  const res = await http.request(d.url, { allowHosts: MOJANG_HOSTS, maxBytes: d.size + 1024, timeoutMs: 10 * 60_000 });
  if (res.status !== 200) { res.body.resume(); throw new AppError("download-failed", `Mojang answered ${res.status} for ${what}.`); }
  const h = createHash("sha1");
  try {
    await pipeline(res.body, new Transform({ transform(c: Buffer, _e, cb) { h.update(c); cb(null, c); } }), createWriteStream(part, { flags: "wx" }));
  } catch (err) {
    await rm(part, { force: true });
    throw err instanceof AppError ? err : new AppError("download-failed", `Downloading ${what} failed: ${(err as Error).message}`);
  }
  if (h.digest("hex") !== d.sha1.toLowerCase()) {
    await rm(part, { force: true });
    throw new AppError("hash-mismatch", `${what.charAt(0).toUpperCase()}${what.slice(1)} didn't match Mojang's checksum, so packsmith discarded it.`);
  }
  await rename(part, dest);
  return dest;
}
