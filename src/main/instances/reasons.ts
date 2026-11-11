// GRP-1 "why it is here": recorded when packsmith installs something, read back by every scan.
// Kept in <data>/reasons/<pack id>.json by Modrinth project, so a reason survives updates of the
// file; it's packsmith's bookkeeping, not part of the pack (an undone install leaves a reason for a
// file that's gone, which no scan ever shows).
import { join } from "node:path";
import { z } from "zod";
import type { ContentItem } from "@shared/schema";
import { readJson, writeJsonAtomic } from "../store/jsonFile";

type Reason = ContentItem["reason"];
const ReasonFile = z.object({
  schemaVersion: z.literal(1).prefault(1),
  byProject: z.record(z.string(), z.object({ kind: z.enum(["requested", "dependency", "agent-chosen", "pre-existing", "unknown"]), of: z.array(z.string()).default([]), text: z.string().optional() })).default({}),
});

export class ReasonStore {
  constructor(private readonly dataDir: string) {}
  private path(packId: string) { return join(this.dataDir, "reasons", `${packId}.json`); }

  async all(packId: string): Promise<Record<string, Reason>> {
    return (await readJson(this.path(packId), ReasonFile, {})).byProject;
  }

  // A mod asked for again keeps its first reason; a library gains every mod that needs it.
  async record(packId: string, reasons: Array<{ projectId: string; reason: Reason }>): Promise<void> {
    if (!reasons.length) return;
    const file = await readJson(this.path(packId), ReasonFile, {});
    for (const { projectId, reason } of reasons) {
      const had = file.byProject[projectId];
      if (!had || had.kind === "unknown" || had.kind === "pre-existing") file.byProject[projectId] = { ...reason, of: [...reason.of] };
      else if (had.kind === "dependency" && reason.kind === "dependency") had.of = [...new Set([...had.of, ...reason.of])];
    }
    await writeJsonAtomic(this.path(packId), file);
  }
}

export function withReasons(items: ContentItem[], reasons: Record<string, Reason>): ContentItem[] {
  return items.map((c) => (c.match.status === "modrinth" && reasons[c.match.projectId] ? { ...c, reason: reasons[c.match.projectId]! } : c));
}
