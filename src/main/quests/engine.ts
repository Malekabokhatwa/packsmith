// M-7 QuestEngine (architecture "Quest engines", D-12/D-26): each engine reads its book into the
// engine-neutral shape and plans the files for chapters packsmith writes. Plans are applied by
// quests/service.ts through the journal, so every quest write is undoable.
import type { Chapter, ChapterSpec, QuestEngineId } from "@shared/schema";
import type { GameRegistry } from "./registry";
import type { QuestManifest } from "./manifest";

export interface WritePlan {
  files: Map<string, string>; // relpath -> content (created or replaced)
  remove: string[];           // relpaths to delete (old files of rewritten or removed chapters)
  manifest: QuestManifest;    // written to the engine's manifest path
}

export interface QuestEngine {
  id: QuestEngineId;
  label: string;
  manifestPath: string;       // relpath of .packsmith-quests.json
  installed(reg: GameRegistry): boolean;
  read(root: string, reg: GameRegistry): Promise<{ chapters: Chapter[]; notes: string[] }>;
  // Absent: packsmith reads this engine's books but doesn't write them (yet).
  planWrite?(root: string, specs: ChapterSpec[], reg: GameRegistry, now: string): Promise<WritePlan>;
  planRemove?(root: string, title: string, reg: GameRegistry): Promise<WritePlan>;
}
