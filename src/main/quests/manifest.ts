// .packsmith-quests.json: which chapters packsmith wrote, per engine folder (so packsmith
// never mistakes someone else's chapters for its own). Only chapters listed here are ever rewritten or
// removed; everything else in a quest book belongs to someone else.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { ChapterSpec } from "@shared/schema";

export const QuestManifest = z.object({
  version: z.literal(1),
  chapters: z.array(z.object({
    title: z.string(),
    slug: z.string(),
    files: z.array(z.string()),  // relpaths from the instance root
    questIds: z.array(z.string()),
    spec: ChapterSpec,           // what was written, so a rewrite can start from it
    writtenAt: z.string(),
  })),
});
export type QuestManifest = z.infer<typeof QuestManifest>;

export async function readManifest(root: string, relpath: string): Promise<QuestManifest> {
  try {
    const parsed = QuestManifest.safeParse(JSON.parse(await readFile(join(root, relpath), "utf8")));
    if (parsed.success) return parsed.data;
  } catch { /* missing or unreadable: no chapters of ours */ }
  return { version: 1, chapters: [] };
}

export function chapterSlug(title: string, taken: Set<string>): string {
  const base = title.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 32) || "chapter";
  let slug = base;
  for (let n = 2; taken.has(slug); n++) slug = `${base}_${n}`;
  return slug;
}
