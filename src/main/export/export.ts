// M-12 export (SPEC 6.8, 9.4): a .mrpack that references every Modrinth file by its download URL
// and hashes (EXP-1), an explicit list of what couldn't be referenced, never embedded (EXP-2), a
// plain folder export (EXP-3), and the licence manifest in both (EXP-4).
import { cp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type { ContentItem, InstanceRecord } from "@shared/schema";
import type { ModrinthVersion } from "../sources/modrinth";
import { GAME_DIR } from "../launchers/layout";
import { createPrismInstance } from "../launchers/prism";
import { AppError } from "../errors";
import { ZipWriter } from "./zipWriter";

export interface LeftOut { relpath: string; why: string }
export interface ExportReport { path: string; referenced: number; overrides: number; leftOut: LeftOut[]; licenceFlags: string[] }

const LOADER_KEY = { fabric: "fabric-loader", forge: "forge", neoforge: "neoforge" } as const;
// Configs and game settings travel as overrides; worlds, logs and caches don't.
const OVERRIDE_DIRS = ["config", "defaultconfigs", "kubejs"];
const OVERRIDE_FILES = ["options.txt"];
const MAX_OVERRIDE_BYTES = 64 * 1024 * 1024;

// In an .mrpack "optional" means a launcher may offer to skip the file; a pack's mods and the
// libraries they need must all be there, so only a side the mod doesn't run on is left out.
const env = (s: string) => (s === "unsupported" ? "unsupported" : "required");

// The modrinth.index.json of a pack, from its scanned content and the Modrinth versions its
// files' SHA-512s resolve to. Pure.
export function mrpackIndex(r: InstanceRecord, loaderVersion: string | undefined, items: ContentItem[], byHash: Record<string, ModrinthVersion>) {
  const leftOut: LeftOut[] = [];
  const files: Array<Record<string, unknown>> = [];
  // "Couldn't ask Modrinth" isn't "not on Modrinth": exporting then would leave real mods out.
  if (items.some((c) => c.enabled && c.match.status === "unmatched" && c.match.reason === "offline")) {
    throw new AppError("offline", "Modrinth couldn't be reached, so packsmith can't look up the download links. Try the export again when you're online.");
  }
  for (const c of items) {
    if (!c.enabled) { leftOut.push({ relpath: c.relpath, why: "turned off" }); continue; }
    if (c.match.status !== "modrinth") { leftOut.push({ relpath: c.relpath, why: "not on Modrinth, so it can't be referenced; ask its author before sharing it" }); continue; }
    const file = byHash[c.sha512]?.files.find((f) => f.hashes.sha512 === c.sha512);
    if (!file) throw new AppError("offline", `Modrinth didn't return the download link for ${c.match.title}, so the export stopped. Try again in a moment.`);
    files.push({
      path: relative(GAME_DIR, c.relpath).split("\\").join("/"),
      hashes: { sha1: c.sha1, sha512: c.sha512 },
      env: { client: env(c.match.clientSide), server: env(c.match.serverSide) },
      downloads: [file.url],
      fileSize: c.bytes,
    });
  }
  const dependencies: Record<string, string> = { minecraft: r.mcVersion };
  if (r.loader !== "vanilla") {
    if (!loaderVersion) throw new AppError("no-loader", `packsmith doesn't know which ${r.loader} build this pack uses, so it can't export it.`);
    dependencies[LOADER_KEY[r.loader]] = loaderVersion;
  }
  return { index: { formatVersion: 1, game: "minecraft", versionId: "1.0.0", name: r.name, summary: "Made with packsmith", files, dependencies }, leftOut };
}

// LICENSES.md (9.4): every project with its version, source and licence; unclear ones flagged.
export function licenceManifest(r: InstanceRecord, items: ContentItem[]): { text: string; flags: string[] } {
  const flags: string[] = [];
  const rows = items.filter((c) => c.enabled).map((c) => {
    if (c.match.status !== "modrinth") {
      flags.push(`${c.relpath}: not on Modrinth; sharing it needs its author's permission`);
      return `| ${c.relpath.split("/").pop()} | ? | not on Modrinth | unknown (ask the author) |`;
    }
    const lic = c.match.license?.trim();
    if (!lic || /^(LicenseRef-)?(unknown|all-rights-reserved|ARR)$/i.test(lic)) flags.push(`${c.match.title}: licence ${lic ? `"${lic}"` : "missing"}; check before sharing outside Modrinth`);
    return `| ${c.match.title} | ${c.match.versionNumber} | https://modrinth.com/project/${c.match.projectId} | ${lic || "missing"} |`;
  });
  const text = [
    `# Licences in ${r.name}`, "",
    "Every project in this pack, from Modrinth's metadata. Files hosted on Modrinth may be used in modpacks; anything else needs its author's permission.", "",
    "| project | version | source | licence |", "| --- | --- | --- | --- |", ...rows, "",
    ...(flags.length ? ["## Check before sharing", "", ...flags.map((f) => `- ${f}`), ""] : []),
  ].join("\n");
  return { text, flags };
}

// Files that go into overrides/: the pack's configs and game settings, relative to minecraft/.
async function overrideFiles(packRoot: string): Promise<string[]> {
  const game = join(packRoot, GAME_DIR);
  const out: string[] = [];
  const walk = async (rel: string): Promise<void> => {
    for (const e of await readdir(join(game, rel), { withFileTypes: true }).catch(() => [])) {
      const child = `${rel}/${e.name}`;
      if (e.isDirectory()) await walk(child);
      else if (e.isFile()) out.push(child);
    }
  };
  for (const d of OVERRIDE_DIRS) await walk(d);
  for (const f of OVERRIDE_FILES) if (await stat(join(game, f)).then((s) => s.isFile(), () => false)) out.push(f);
  return out;
}

export async function writeMrpack(dest: string, r: InstanceRecord, loaderVersion: string | undefined, items: ContentItem[], byHash: Record<string, ModrinthVersion>): Promise<ExportReport> {
  const { index, leftOut } = mrpackIndex(r, loaderVersion, items, byHash);
  const lic = licenceManifest(r, items);
  const overrides = await overrideFiles(r.path);
  let total = 0;
  const zip = ZipWriter.create(dest);
  try {
    await zip.add("modrinth.index.json", Buffer.from(JSON.stringify(index, null, 2)));
    await zip.add("LICENSES.md", Buffer.from(lic.text));
    for (const rel of overrides) {
      const data = await readFile(join(r.path, GAME_DIR, rel));
      total += data.length;
      if (total > MAX_OVERRIDE_BYTES) throw new AppError("too-big", "The pack's config files add up to more than 64 MB, which is too much for an export.");
      await zip.add(`overrides/${rel}`, data);
    }
    await zip.close();
  } catch (err) {
    await zip.abort();
    throw err;
  }
  return { path: dest, referenced: index.files.length, overrides: overrides.length, leftOut, licenceFlags: lic.flags };
}

// EXP-3: the whole pack as a Prism instance folder (minecraft/ + mmc-pack.json), into a new
// folder the user picked; packsmith's own marker stays behind.
export async function writeFolder(dest: string, r: InstanceRecord, loaderVersion: string | undefined, items: ContentItem[]): Promise<ExportReport> {
  await createPrismInstance({ dir: dest, name: r.name, mcVersion: r.mcVersion, loader: r.loader, loaderVersion });
  await cp(join(r.path, GAME_DIR), join(dest, GAME_DIR), { recursive: true });
  const lic = licenceManifest(r, items);
  await writeFile(join(dest, "LICENSES.md"), lic.text);
  return { path: dest, referenced: items.length, overrides: 0, leftOut: [], licenceFlags: lic.flags };
}
