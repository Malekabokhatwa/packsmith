// Export a pack packsmith made (F08): scan it, resolve its files' Modrinth download URLs by hash,
// then write the .mrpack or folder the user picked.
import type { Http } from "../net/http";
import type { Packs } from "../instances/manager";
import type { ModrinthClient } from "../sources/modrinth";
import { latestLoaderVersion } from "../loaders";
import { AppError } from "../errors";
import { writeFolder, writeMrpack, type ExportReport } from "./export";

export type ExportKind = "mrpack" | "folder";

export class Exporter {
  constructor(private readonly d: { packs: Packs; modrinth: ModrinthClient; http: Http }) {}

  // The name the save dialog suggests: the pack's name as a file name.
  async suggestedName(id: string, kind: ExportKind): Promise<string> {
    const r = await this.record(id);
    const base = r.name.replace(/[^\w .()-]+/g, "").trim().replace(/\s+/g, " ") || r.id;
    return kind === "mrpack" ? `${base}.mrpack` : base;
  }

  async export(id: string, kind: ExportKind, dest: string): Promise<ExportReport> {
    const r = await this.record(id);
    const items = await this.d.packs.scan(id);
    const loaderVersion = r.loader === "vanilla" ? undefined : (r.loaderVersion ?? (await latestLoaderVersion(this.d.http, r.loader, r.mcVersion)));
    if (kind === "folder") return writeFolder(dest, r, loaderVersion, items);
    const hashes = items.filter((c) => c.enabled && c.match.status === "modrinth").map((c) => c.sha512);
    const byHash = hashes.length ? await this.d.modrinth.versionsByHash(hashes) : {};
    return writeMrpack(dest, r, loaderVersion, items, byHash);
  }

  private async record(id: string) {
    const r = (await this.d.packs.list()).find((x) => x.id === id);
    if (!r) throw new AppError("unknown-pack", "That pack isn't in packsmith's list any more.");
    return r;
  }
}
