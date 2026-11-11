// Prism Launcher adapter (spec D-5, INS-2). packsmith creates its own instances inside Prism's
// instances folder and lists them in a "packsmith" group. It never edits any other instance.
// Prism rewrites instgroups.json while it runs, so the group is only written while Prism is
// closed; until then the record keeps groupPending=true and we retry later.
import { readdir, readFile, mkdir, access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import type { Loader } from "@shared/schema";
import { writeFileAtomic, writeJsonAtomic } from "../store/jsonFile";
import { LOADER_UID } from "../loaders";
import { AppError } from "../errors";

export const PRISM_GROUP = "packsmith";

export function prismRootCandidates(): string[] {
  const h = homedir();
  return [join(h, ".local/share/PrismLauncher"), join(h, ".var/app/org.prismlauncher.PrismLauncher/data/PrismLauncher")];
}

export async function detectPrismRoot(candidates = prismRootCandidates()): Promise<string | null> {
  for (const c of candidates) {
    try {
      await access(join(c, "prismlauncher.cfg"));
      return c;
    } catch { /* try the next one */ }
  }
  return null;
}

export async function prismInstancesDir(root: string): Promise<string> {
  let dir = "instances";
  try {
    const cfg = await readFile(join(root, "prismlauncher.cfg"), "utf8");
    const m = /^InstanceDir=(.+)$/m.exec(cfg);
    if (m?.[1]) dir = m[1].trim().replace(/^"(.*)"$/, "$1");
  } catch { /* default */ }
  return isAbsolute(dir) ? dir : join(root, dir);
}

export async function isPrismRunning(): Promise<boolean> {
  let pids: string[];
  try {
    pids = (await readdir("/proc")).filter((p) => /^\d+$/.test(p));
  } catch {
    return false;
  }
  for (const pid of pids) {
    try {
      const comm = (await readFile(`/proc/${pid}/comm`, "utf8")).trim();
      if (comm === "prismlauncher" || comm === "PrismLauncher") return true;
    } catch { /* process exited */ }
  }
  return false;
}

// QSettings ini value: always quoted, so commas and leading spaces survive.
function iniString(v: string): string {
  return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export interface PrismInstanceSpec {
  dir: string; // absolute instance folder (must not exist yet)
  name: string;
  mcVersion: string;
  loader: Loader;
  loaderVersion?: string;
}

// mmc-pack.json for a pack: Minecraft plus the loader component. Prism adds the loader's own
// requirements (intermediary, lwjgl) itself when it loads the pack.
export function prismPack(mcVersion: string, loader: Loader, loaderVersion?: string): { formatVersion: 1; components: Array<Record<string, unknown>> } {
  const components: Array<Record<string, unknown>> = [{ uid: "net.minecraft", version: mcVersion, important: true }];
  if (loader !== "vanilla") {
    if (!loaderVersion) throw new AppError("unsupported-loader", `A ${loader} pack needs a loader version.`);
    components.push({ uid: LOADER_UID[loader], version: loaderVersion });
  }
  return { formatVersion: 1, components };
}

const LOADER_UIDS = new Set<string>([...Object.values(LOADER_UID), "net.fabricmc.intermediary", "org.quiltmc.quilt-loader"]);
const PackJson = z.looseObject({ formatVersion: z.number(), components: z.array(z.looseObject({ uid: z.string() })) });

// Swap the loader in an existing mmc-pack.json (set_loader, ADP-4 later): every other component
// Prism added (lwjgl, Minecraft and its settings) stays exactly as it was.
export function withLoader(text: string, loader: Loader, loaderVersion?: string): string {
  const parsed = PackJson.safeParse(JSON.parse(text));
  if (!parsed.success) throw new AppError("corrupt-file", "This pack's mmc-pack.json isn't in the format packsmith expects, so it was left alone.");
  const components = parsed.data.components.filter((c) => !LOADER_UIDS.has(c.uid));
  if (loader !== "vanilla") {
    if (!loaderVersion) throw new AppError("unsupported-loader", `A ${loader} pack needs a loader version.`);
    components.push({ uid: LOADER_UID[loader], version: loaderVersion });
  }
  return JSON.stringify({ ...parsed.data, components }, null, 2) + "\n";
}

export async function createPrismInstance(spec: PrismInstanceSpec): Promise<void> {
  await mkdir(spec.dir, { recursive: false }).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "EEXIST") throw new AppError("exists", `An instance folder named ${spec.dir} already exists.`);
    throw err;
  });
  await writeFileAtomic(join(spec.dir, "instance.cfg"),
    `[General]\nConfigVersion=1.2\nInstanceType=OneSix\niconKey=default\nname=${iniString(spec.name)}\n`);
  await writeJsonAtomic(join(spec.dir, "mmc-pack.json"), prismPack(spec.mcVersion, spec.loader, spec.loaderVersion));
}

const InstGroups = z.looseObject({
  formatVersion: z.string().default("1"),
  groups: z.record(z.string(), z.looseObject({ hidden: z.boolean().optional(), instances: z.array(z.string()) })).default({}),
});

// Add `dirName` to the packsmith group, keeping every other group exactly as it was.
export async function addToPrismGroup(instancesDir: string, dirName: string): Promise<void> {
  const file = join(instancesDir, "instgroups.json");
  let current: z.infer<typeof InstGroups> = { formatVersion: "1", groups: {} };
  try {
    const parsed = InstGroups.safeParse(JSON.parse(await readFile(file, "utf8")));
    if (!parsed.success) throw new AppError("corrupt-file", "Prism's group list isn't in the expected format, so packsmith left it alone.");
    current = parsed.data;
  } catch (err) {
    if (err instanceof AppError) throw err;
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const group = current.groups[PRISM_GROUP] ?? { hidden: false, instances: [] };
  if (!group.instances.includes(dirName)) group.instances.push(dirName);
  current.groups[PRISM_GROUP] = group;
  await writeJsonAtomic(file, current);
}

// How to start Prism: its own binary on PATH, else the Flatpak. null when neither is installed.
export async function prismCommand(pathDirs = (process.env.PATH ?? "").split(":")): Promise<{ command: string; args: string[] } | null> {
  for (const d of pathDirs.filter(Boolean)) {
    for (const name of ["prismlauncher", "PrismLauncher"]) {
      const p = join(d, name);
      if (await access(p, fsConstants.X_OK).then(() => true, () => false)) return { command: p, args: [] };
    }
  }
  for (const d of pathDirs.filter(Boolean)) {
    const p = join(d, "flatpak");
    if (await access(p, fsConstants.X_OK).then(() => true, () => false)) {
      if (await access(join(homedir(), ".var/app/org.prismlauncher.PrismLauncher")).then(() => true, () => false)) return { command: p, args: ["run", "org.prismlauncher.PrismLauncher"] };
    }
  }
  return null;
}

// Prism's own command line (seen in `prismlauncher --help`, 2026-11-03): --show opens an
// instance's window; --import adds an .mrpack through Prism's own import dialog.
export function prismArgs(action: { show: string } | { import: string }): string[] {
  return "show" in action ? ["--show", action.show] : ["--import", action.import];
}

// ---------- reading an existing instance (discovery, ADP-1; read-only) ----------

export interface PrismInstanceInfo {
  name: string;
  mcVersion?: string;
  loader?: Loader;          // undefined = a loader packsmith doesn't support (e.g. Quilt)
  loaderVersion?: string;
}

// instance.cfg is a QSettings ini: `name=...`, sometimes quoted with escapes.
export function cfgName(text: string): string | undefined {
  const line = text.split(/\r?\n/).find((l) => /^name\s*=/.test(l));
  if (!line) return undefined;
  const v = line.replace(/^name\s*=\s*/, "").trim();
  return v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1).replace(/\\(["\\])/g, "$1") : v;
}

const UID_LOADER = new Map<string, Loader>(Object.entries(LOADER_UID).map(([l, uid]) => [uid, l as Loader]));

export function readPackComponents(text: string): Omit<PrismInstanceInfo, "name"> {
  const parsed = PackJson.safeParse(JSON.parse(text));
  if (!parsed.success) return {};
  const comps = parsed.data.components as Array<{ uid: string; version?: unknown }>;
  const mc = comps.find((c) => c.uid === "net.minecraft");
  const loaderComp = comps.find((c) => UID_LOADER.has(c.uid));
  const unsupported = comps.some((c) => c.uid === "org.quiltmc.quilt-loader");
  return {
    mcVersion: typeof mc?.version === "string" ? mc.version : undefined,
    loader: unsupported ? undefined : loaderComp ? UID_LOADER.get(loaderComp.uid) : "vanilla",
    loaderVersion: typeof loaderComp?.version === "string" ? loaderComp.version : undefined,
  };
}

export async function readPrismInstance(dir: string): Promise<PrismInstanceInfo | null> {
  const cfg = await readFile(join(dir, "instance.cfg"), "utf8").catch(() => null);
  const pack = await readFile(join(dir, "mmc-pack.json"), "utf8").catch(() => null);
  if (cfg === null || pack === null) return null;
  let comps: Omit<PrismInstanceInfo, "name"> = {};
  try { comps = readPackComponents(pack); } catch { /* unreadable: listed without versions */ }
  return { name: cfgName(cfg) ?? dir.split("/").pop()!, ...comps };
}
