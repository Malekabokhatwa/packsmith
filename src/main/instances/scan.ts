// Installed-tab scan: list the content files of an instance, hash them (streamed), and match
// them against Modrinth in one batch request. Files Modrinth doesn't know are reported as
// unmatched, never guessed (spec DEP-4).
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ContentItem, ContentKind, Loader } from "@shared/schema";
import { CONTENT_DIR } from "../launchers/layout";
import type { ModrinthClient, ModrinthProject, ModrinthVersion } from "../sources/modrinth";
import { AppError } from "../errors";

const EXT: Record<keyof typeof CONTENT_DIR, RegExp> = {
  mod: /\.jar(\.disabled)?$/i,
  shader: /\.zip(\.disabled)?$/i,
  resourcepack: /\.zip(\.disabled)?$/i,
};

async function hashFile(path: string): Promise<{ sha1: string; sha512: string; bytes: number }> {
  const sha1 = createHash("sha1");
  const sha512 = createHash("sha512");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    sha1.update(chunk as Buffer);
    sha512.update(chunk as Buffer);
    bytes += (chunk as Buffer).length;
  }
  return { sha1: sha1.digest("hex"), sha512: sha512.digest("hex"), bytes };
}

const SIDES = new Set(["required", "optional", "unsupported", "unknown"]);
const side = (s: string) => (SIDES.has(s) ? s : "unknown") as "required" | "optional" | "unsupported" | "unknown";

// pack: when given, also ask Modrinth for newer versions that fit the pack (one request per kind).
export async function scanInstance(root: string, modrinth: ModrinthClient, pack?: { mcVersion: string; loader: Loader }): Promise<ContentItem[]> {
  const files: Array<{ kind: ContentKind; relpath: string; enabled: boolean; sha1: string; sha512: string; bytes: number }> = [];
  for (const [kind, dir] of Object.entries(CONTENT_DIR) as Array<[keyof typeof CONTENT_DIR, string]>) {
    let names: string[];
    try {
      names = await readdir(join(root, dir));
    } catch {
      continue;
    }
    for (const name of names.sort((a, b) => a.localeCompare(b))) {
      if (!EXT[kind].test(name) || name.endsWith(".part")) continue;
      const abs = join(root, dir, name);
      if (!(await stat(abs)).isFile()) continue; // folders (unzipped shaders) are listed in a later milestone
      files.push({ kind, relpath: `${dir}/${name}`, enabled: !name.endsWith(".disabled"), ...(await hashFile(abs)) });
    }
  }
  if (files.length === 0) return [];

  let byHash: Awaited<ReturnType<ModrinthClient["versionsByHash"]>> = {};
  let projects = new Map<string, ModrinthProject>();
  let offline = false;
  let updates: Record<string, ModrinthVersion> = {};
  try {
    byHash = await modrinth.versionsByHash(files.map((f) => f.sha512));
    const ids = [...new Set(Object.values(byHash).map((v) => v.project_id))];
    projects = new Map((await modrinth.projects(ids)).map((p) => [p.id, p]));
  } catch (err) {
    // Network trouble: list everything as unmatched("offline") and still render the tab.
    // Anything else (e.g. a response we can't parse) is a real error and surfaces.
    if (!(err instanceof AppError) || (err.code !== "network" && err.code !== "http")) throw err;
    offline = true;
  }
  if (pack && !offline) {
    // Updates are a bonus: if this check fails the matches above still show.
    updates = await findUpdates(modrinth, files, byHash, pack).catch((err) => {
      if (err instanceof AppError && (err.code === "network" || err.code === "http")) return {};
      throw err;
    });
  }

  return files.map((f): ContentItem => {
    const v = byHash[f.sha512];
    const p = v ? projects.get(v.project_id) : undefined;
    const base = { relpath: f.relpath, kind: f.kind, enabled: f.enabled, sha1: f.sha1, sha512: f.sha512, bytes: f.bytes, reason: { kind: "unknown" as const, of: [] } };
    if (!v || !p) return { ...base, match: { status: "unmatched", reason: offline ? "offline" : "not-on-modrinth" } };
    return {
      ...base,
      match: {
        status: "modrinth", projectId: p.id, versionId: v.id, title: p.title, summary: p.description,
        iconUrl: p.icon_url ?? undefined, versionNumber: v.version_number, categories: p.categories,
        license: p.license?.id, clientSide: side(p.client_side), serverSide: side(p.server_side),
        update: updates[f.sha512] ? { versionId: updates[f.sha512]!.id, versionNumber: updates[f.sha512]!.version_number } : undefined,
      },
    };
  });
}

// Newer versions for matched files: mods by the pack's loader, shaders and resource packs by game
// version only. A newer version is one Modrinth published after the installed one.
async function findUpdates(modrinth: ModrinthClient, files: Array<{ kind: ContentKind; sha512: string }>, byHash: Record<string, ModrinthVersion>, pack: { mcVersion: string; loader: Loader }): Promise<Record<string, ModrinthVersion>> {
  const out: Record<string, ModrinthVersion> = {};
  for (const mods of [true, false]) {
    const hashes = files.filter((f) => (f.kind === "mod") === mods && byHash[f.sha512]).map((f) => f.sha512);
    if (!hashes.length || (mods && pack.loader === "vanilla")) continue;
    const latest = await modrinth.latestByHash(hashes, mods ? [pack.loader] : undefined, [pack.mcVersion]);
    for (const h of hashes) {
      const now = byHash[h]!;
      const next = latest[h];
      if (next && next.id !== now.id && next.date_published > now.date_published) out[h] = next;
    }
  }
  return out;
}
