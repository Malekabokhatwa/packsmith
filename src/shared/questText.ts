// One line per task and reward, in plain words, shared by the Quests tab and the quest files
// packsmith writes (task titles). Names come from the pack's own lang files when known.
import type { QuestReward, QuestTask } from "./schema";

// "minecraft:oak_log" -> "Oak Log"; "#minecraft:logs" -> "any logs"
export function idName(id: string, names: Record<string, string> = {}): string {
  if (id.startsWith("#")) return `any ${id.slice(1).split(":").pop()!.split("/").pop()!.replace(/_/g, " ")}`;
  return names[id] ?? id.split(":").pop()!.split("/").pop()!.split("_").map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w)).join(" ");
}

const times = (n: number) => (n > 1 ? ` ×${n}` : "");

export function taskText(t: QuestTask, names: Record<string, string> = {}): string {
  switch (t.kind) {
    case "item": return `Collect ${idName(t.item, names)}${times(t.count)}`;
    case "kill": return `Defeat ${idName(t.entity, names)}${times(t.count)}`;
    case "dimension": return `Travel to ${idName(t.dimension, names)}`;
    case "check": return t.text;
    case "other": return t.text;
  }
}

export function rewardText(r: QuestReward, names: Record<string, string> = {}): string {
  switch (r.kind) {
    case "item": return `${idName(r.item, names)}${times(r.count)}`;
    case "xp": return `${r.amount} XP`;
    case "other": return r.text;
  }
}
