// Semantic validation of quest chapters before anything is written (QST-4, layer 2): unique keys,
// "after" links that exist and don't loop, every item / tag / entity / dimension id present in the
// pack's jars or in Minecraft itself, with "did you mean" suggestions (QST-3). Ids packsmith
// can't check (no Minecraft game file) are listed as unverified, never passed silently.
import type { ChapterSpec, QuestEngineId } from "@shared/schema";
import { suggest, type GameRegistry } from "./registry";

export interface QuestCheck { errors: string[]; warnings: string[]; unverified: string[] }

const MAX_CHAPTERS = 12; // QST-3: 3-5 by default, up to 12

export function validateChapters(chapters: ChapterSpec[], engine: QuestEngineId, reg: GameRegistry, foreignTitles: Set<string>): QuestCheck {
  const out: QuestCheck = { errors: [], warnings: [], unverified: [] };
  if (chapters.length > MAX_CHAPTERS) out.errors.push(`At most ${MAX_CHAPTERS} chapters at a time; got ${chapters.length}.`);
  const titles = new Set<string>();
  for (const ch of chapters) {
    const where = `Chapter "${ch.title}"`;
    if (titles.has(ch.title.toLowerCase())) out.errors.push(`${where} appears twice.`);
    titles.add(ch.title.toLowerCase());
    if (foreignTitles.has(ch.title.toLowerCase())) out.errors.push(`${where} already exists and wasn't written by packsmith, so packsmith won't replace it. Pick another title.`);

    const keys = new Set<string>();
    for (const q of ch.quests) {
      if (keys.has(q.key)) out.errors.push(`${where}: quest key "${q.key}" is used twice.`);
      keys.add(q.key);
    }
    for (const q of ch.quests) {
      const at = `${where}, quest "${q.title}"`;
      for (const a of q.after) {
        if (a === q.key) out.errors.push(`${at} comes after itself.`);
        else if (!keys.has(a)) out.errors.push(`${at} comes after "${a}", which isn't a quest key in this chapter.${hint(a, keys)}`);
      }
      if (engine === "vanilla" && q.after.length > 1) out.warnings.push(`${at}: vanilla advancements show one "after" line; the others are listed in its description.`);
      if (q.icon) checkItem(out, reg, q.icon, `${at} icon`, false);
      for (const t of q.tasks) {
        if (t.kind === "item") checkItem(out, reg, t.item, at, true);
        if (t.kind === "kill") checkId(out, reg, t.entity, reg.entities.keys(), reg.entities.has(t.entity), `${at}: entity`);
        if (t.kind === "dimension") checkId(out, reg, t.dimension, reg.dimensions, reg.dimensions.has(t.dimension), `${at}: dimension`);
        if (t.kind === "check" && engine === "vanilla") out.errors.push(`${at}: vanilla advancements can't have a "tick it yourself" task. Use an item, kill or dimension task.`);
      }
      for (const r of q.rewards) if (r.kind === "item") checkItem(out, reg, r.item, `${at} reward`, false);
    }
    const loop = findLoop(ch.quests.map((q) => ({ id: q.key, after: q.after })));
    if (loop) out.errors.push(`${where}: quests come after each other in a loop (${loop.join(" -> ")}).`);
  }
  return out;
}

function hint(id: string, known: Iterable<string>): string {
  const s = suggest(id, known);
  return s.length ? ` Did you mean ${s.map((x) => `"${x}"`).join(" or ")}?` : "";
}

function checkItem(out: QuestCheck, reg: GameRegistry, ref: string, at: string, tagsAllowed: boolean): void {
  if (ref.startsWith("#")) {
    const tag = ref.slice(1);
    if (!tagsAllowed) { out.errors.push(`${at}: "${ref}" is a tag; this needs one item.`); return; }
    checkId(out, reg, tag, reg.itemTags, reg.itemTags.has(tag), `${at}: item tag`, "#");
    return;
  }
  checkId(out, reg, ref, reg.items.keys(), reg.items.has(ref), `${at}: item`);
}

function checkId(out: QuestCheck, reg: GameRegistry, id: string, known: Iterable<string>, present: boolean, what: string, prefix = ""): void {
  if (present) return;
  if (id.startsWith("minecraft:") && !reg.vanilla) {
    out.unverified.push(`${prefix}${id}`);
    return;
  }
  const s = suggest(id, known);
  out.errors.push(`${what} "${prefix}${id}" doesn't exist in this pack.${s.length ? ` Did you mean ${s.map((x) => `"${prefix}${x}"`).join(" or ")}?` : ""}`);
}

function findLoop(nodes: Array<{ id: string; after: string[] }>): string[] | null {
  const next = new Map(nodes.map((n) => [n.id, n.after]));
  const state = new Map<string, number>();
  const stack: string[] = [];
  const visit = (id: string): string[] | null => {
    state.set(id, 1);
    stack.push(id);
    for (const a of next.get(id) ?? []) {
      if (state.get(a) === 1) return [...stack.slice(stack.indexOf(a)), a];
      if (!state.has(a) && next.has(a)) { const l = visit(a); if (l) return l; }
    }
    stack.pop();
    state.set(id, 2);
    return null;
  };
  for (const n of nodes) if (!state.has(n.id)) { const l = visit(n.id); if (l) return l; }
  return null;
}
