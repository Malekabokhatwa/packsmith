// The single write boundary (spec INS-3, architecture "access rule"). Every write into an
// instance goes through assertWritable. It allows only:
//   - instances in packsmith's registry with origin "own" whose marker names the same id
//   - adopted instances (the user clicked Manage), only inside the scopes they allowed (D-33)
//   - relative paths that stay inside the instance root after resolving symlinks
import { lstat, mkdir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { RelPath, type AdoptionScope, type InstanceRecord } from "@shared/schema";
import { readMarker } from "./marker";
import { AppError } from "../errors";

function inside(root: string, p: string): boolean {
  const rel = relative(root, p);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function nearestExisting(p: string): Promise<string> {
  for (let cur = p; ; cur = dirname(cur)) {
    try {
      await lstat(cur);
      return cur;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      if (dirname(cur) === cur) throw err;
    }
  }
}

export async function assertWritable(record: InstanceRecord, relpath: string): Promise<string> {
  if (record.origin !== "own" && record.origin !== "adopted") {
    throw new AppError("not-writable", `packsmith only changes packs it made or you let it manage. "${record.name}" isn't one of them.`);
  }
  const root = await realpath(record.path).catch(() => {
    throw new AppError("missing-instance", `The folder for "${record.name}" is gone.`);
  });
  if (!RelPath.safeParse(relpath).success) throw new AppError("bad-path", `Refused a path outside the pack: ${relpath}`);
  if (record.origin === "own") {
    const marker = await readMarker(root);
    if (!marker || marker.instanceId !== record.id) {
      throw new AppError("not-writable", `"${record.name}" no longer carries packsmith's marker, so packsmith won't change it.`);
    }
  } else {
    const scope = scopeOf(relpath);
    if (!scope) throw new AppError("not-writable", `packsmith doesn't change ${relpath} in "${record.name}": it's outside anything you let it manage (worlds never are).`);
    if (!record.scope?.includes(scope)) throw new AppError("out-of-scope", `You haven't let packsmith change ${SCOPE_NAME[scope]} in "${record.name}". Allow it in Packs > ${record.name} > Manage.`);
  }
  const target = resolve(root, relpath);
  if (!inside(root, target) || target === root) throw new AppError("bad-path", `Refused a path outside the pack: ${relpath}`);

  // Resolve the deepest existing ancestor of the parent folder: a symlinked folder that points
  // outside the instance is refused instead of written through.
  const parent = dirname(target);
  const existing = await nearestExisting(parent);
  const realExisting = await realpath(existing);
  if (!inside(root, realExisting)) throw new AppError("bad-path", `Refused: ${relpath} leads outside the pack through a link.`);
  await mkdir(parent, { recursive: true });
  const realParent = await realpath(parent);
  if (!inside(root, realParent)) throw new AppError("bad-path", `Refused: ${relpath} leads outside the pack through a link.`);
  // The final segment may itself be a symlink: callers replace it, never write through it (INS-5).
  return join(realParent, basename(target));
}

export const SCOPE_NAME: Record<AdoptionScope, string> = {
  mods: "mods", configs: "configs", settings: "game settings", shaders: "shaders",
  resourcepacks: "resource packs", quests: "quests", loader: "the mod loader",
};

// Which adoption scope a path inside an instance belongs to (D-33); null = never writable there.
export function scopeOf(relpath: string): AdoptionScope | null {
  const p = relpath.replace(/\\/g, "/");
  if (p === "mmc-pack.json") return "loader";
  if (p === "minecraft/options.txt") return "settings";
  if (/^minecraft\/config\/(heracles|ftbquests)\//.test(p)) return "quests";
  if (/^minecraft\/packsmith-datapacks\//.test(p) || /^minecraft\/saves\/[^/]+\/datapacks\/packsmith_quests\//.test(p)) return "quests";
  if (p.startsWith("minecraft/config/")) return "configs";
  if (p.startsWith("minecraft/mods/")) return "mods";
  if (p.startsWith("minecraft/shaderpacks/")) return "shaders";
  if (p.startsWith("minecraft/resourcepacks/")) return "resourcepacks";
  return null;
}
