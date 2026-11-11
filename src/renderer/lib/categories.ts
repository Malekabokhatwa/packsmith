// S06 category chips: each mod gets ONE group (so the counts add up to the pack), from its Modrinth
// categories. Libraries first (others depend on them), then the first category we know, else Other.
import type { ContentItem } from "@shared/schema";

const NAMES: Record<string, string> = {
  optimization: "Performance", adventure: "Adventure", worldgen: "World generation", mobs: "Creatures",
  magic: "Magic", equipment: "Gear", food: "Food & farming", decoration: "Building & decor",
  technology: "Technology", storage: "Storage", transportation: "Travel", utility: "Utility",
  "game-mechanics": "Gameplay", management: "Management", economy: "Economy", social: "Social",
  minigame: "Minigames", cursed: "Odd ones",
};
const ORDER = [...Object.values(NAMES), "Other", "Libraries", "Not on Modrinth"];

export function groupOf(c: ContentItem): string {
  if (c.match.status !== "modrinth") return "Not on Modrinth";
  if (c.match.categories.includes("library")) return "Libraries";
  for (const cat of c.match.categories) if (NAMES[cat]) return NAMES[cat]!;
  return "Other";
}

export function searchText(c: ContentItem): string {
  return `${c.match.status === "modrinth" ? `${c.match.title} ${c.match.summary}` : ""} ${c.relpath.split("/").pop()}`.toLowerCase();
}

// Groups in a stable order (the named categories, then Other, Libraries, Not on Modrinth).
export function groupItems(items: ContentItem[]): Array<{ name: string; items: ContentItem[] }> {
  const by = new Map<string, ContentItem[]>();
  for (const c of items) { const g = groupOf(c); by.set(g, [...(by.get(g) ?? []), c]); }
  return [...by.entries()].sort((a, b) => ORDER.indexOf(a[0]) - ORDER.indexOf(b[0])).map(([name, list]) => ({ name, items: list }));
}
