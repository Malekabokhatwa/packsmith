import { describe, expect, it } from "vitest";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ChapterSpec, InstanceRecord } from "@shared/schema";
import { layoutQuests } from "@shared/questLayout";
import { taskText } from "@shared/questText";
import { Quests, questPathAllowed } from "../src/main/quests/service";
import { Journal } from "../src/main/instances/journal";
import type { Packs } from "../src/main/instances/manager";
import { ModrinthClient, Throttle } from "../src/main/sources/modrinth";
import { parseSnbt, stringifySnbt, Num } from "../src/main/quests/snbt";
import { buildRegistry, suggest } from "../src/main/quests/registry";
import { fakeHttp } from "./helpers";
import { questPack } from "./support/questPack";
import { modJar } from "./support/fakeJars";

const exists = (p: string) => access(p).then(() => true, () => false);

function service(record: InstanceRecord, dataDir: string, prismRoot: string, installs: string[] = []) {
  const packs = { list: async () => [record], installProject: async (_id: string, p: string) => { installs.push(p); return { entryId: "j-x" }; } } as unknown as Packs;
  const { http } = fakeHttp({ json: {} });
  const journal = new Journal(dataDir);
  return { q: new Quests({ dataDir, http, modrinth: new ModrinthClient(http, new Throttle(1000)), packs, journal, prismRoot: async () => prismRoot, now: () => new Date("2026-11-03T12:00:00Z") }), journal };
}

const chapter: ChapterSpec = {
  title: "First Steps",
  quests: [
    { key: "wood", title: "Wood First", description: "Punch a tree.", tasks: [{ kind: "item", item: "#minecraft:logs", count: 8 }], rewards: [{ kind: "xp", amount: 15 }], after: [] },
    { key: "bench", title: "A Bench", tasks: [{ kind: "item", item: "minecraft:crafting_table", count: 1 }], rewards: [{ kind: "item", item: "minecraft:torch", count: 4 }], after: ["wood"] },
    { key: "bread", title: "Bread", tasks: [{ kind: "item", item: "minecraft:bread", count: 3 }], rewards: [], after: ["wood"] },
    { key: "night", title: "First Night", tasks: [{ kind: "kill", entity: "minecraft:zombie", count: 1 }, { kind: "item", item: "farmers:tomato", count: 2 }], rewards: [], after: ["bench", "bread"] },
  ],
};

describe("quest write boundary", () => {
  it("allows only the quest folders: Heracles config, packsmith's data pack, and that data pack inside a world", () => {
    for (const ok of ["minecraft/config/heracles/groups.txt", "minecraft/config/heracles/quests/a/b.json", "minecraft/packsmith-datapacks/packsmith_quests/pack.mcmeta", "minecraft/saves/My World/datapacks/packsmith_quests/pack.mcmeta"]) expect(questPathAllowed(ok), ok).toBe(true);
    for (const bad of ["minecraft/config/heracles", "minecraft/config/other.toml", "minecraft/saves/W/level.dat", "minecraft/saves/W/datapacks/other/x.json", "minecraft/config/heracles/../../mods/x.jar", "minecraft/saves/a/b/datapacks/packsmith_quests/x", "mmc-pack.json"]) expect(questPathAllowed(bad), bad).toBe(false);
  });
});

describe("SNBT values", () => {
  it("parses FTB's newline style and writes it back", () => {
    const v = parseSnbt('{\n\tid: "1A"\n\tx: -1.5d\n\tcount: 8L\n\thide: false\n\tdeps: ["a" "b"]\n\tc: [I; 1, 2]\n\tname: \'it\\\'s\'\n}');
    expect(v).toEqual({ id: "1A", x: -1.5, count: 8, hide: false, deps: ["a", "b"], c: [1, 2], name: "it's" });
    const out = stringifySnbt({ id: "1A", x: new Num(2, "d"), list: [{ a: 1 }], empty: [] });
    expect(parseSnbt(out)).toEqual({ id: "1A", x: 2, list: [{ a: 1 }], empty: [] });
    expect(out).toContain("x: 2.0d");
  });
});

describe("quest layout and wording", () => {
  it("puts a quest after the longest chain before it; branches meet at a gate", () => {
    const { pos, cols } = layoutQuests(chapter.quests.map((q) => ({ id: q.key, dependsOn: q.after })));
    expect(Object.fromEntries([...pos].map(([k, p]) => [k, `${p.col}.${p.row}`]))).toEqual({ wood: "0.0", bench: "1.0", bread: "1.1", night: "2.0" });
    expect(cols).toBe(3);
    expect(layoutQuests([{ id: "a", dependsOn: ["b"] }, { id: "b", dependsOn: ["a"] }]).cols).toBeGreaterThan(0); // a loop doesn't hang
    expect(taskText({ kind: "item", item: "#minecraft:logs", count: 8 })).toBe("Collect any logs ×8");
    expect(taskText({ kind: "kill", entity: "minecraft:zombie", count: 1 }, { "minecraft:zombie": "Zombie" })).toBe("Defeat Zombie");
  });
});

describe("game registry (QST-4)", () => {
  it("reads items, names, tags and entities from the jars; vanilla variant models aren't items", async () => {
    const p = await questPack({ mods: { "farmers.jar": modJar("farmers", ["tomato"]), "heracles.jar": modJar("heracles") } });
    const jar = join(p.prismRoot, "libraries/com/mojang/minecraft/1.21.1/minecraft-1.21.1-client.jar");
    const reg = await buildRegistry(p.root, "1.21.1", jar);
    expect(reg.items.get("minecraft:oak_log")).toBe("Oak Log");
    expect(reg.items.has("minecraft:bow_pulling_0")).toBe(false);
    expect(reg.items.get("farmers:tomato")).toBe("tomato");
    expect(reg.itemTags.has("minecraft:logs")).toBe(true);
    expect(reg.entities.get("minecraft:zombie")).toBe("Zombie");
    expect(reg.modIds).toEqual(new Set(["farmers", "heracles"]));
    expect(reg.dataFormat).toEqual({ major: 48, minor: 0 });
    expect(reg.advancementStyle).toMatchObject({ iconKey: "id", itemsAsList: false });
    expect(suggest("minecraft:oak_logg", reg.items.keys())).toEqual(["minecraft:oak_log"]);
  });
});

describe("Heracles chapters (write, read, rewrite, remove, undo)", () => {
  async function setup() {
    const p = await questPack({ mods: { "farmers.jar": modJar("farmers", ["tomato"]), "heracles.jar": modJar("heracles") } });
    return { ...p, ...service(p.record, p.dataDir, p.prismRoot) };
  }

  it("refuses wrong ids with suggestions, a bad link and a loop, and writes nothing", async () => {
    const s = await setup();
    const bad: ChapterSpec = { title: "Bad", quests: [
      { key: "a", title: "A", tasks: [{ kind: "item", item: "minecraft:oak_logg", count: 1 }], rewards: [], after: ["b"] },
      { key: "b", title: "B", tasks: [{ kind: "kill", entity: "minecraft:zombi", count: 1 }], rewards: [], after: ["a", "nope"] },
    ] };
    await expect(s.q.write(s.record.id, "heracles", [bad])).rejects.toThrow(/item "minecraft:oak_logg" doesn't exist in this pack\. Did you mean "minecraft:oak_log"\?/);
    const err = await s.q.write(s.record.id, "heracles", [bad]).catch((e: Error) => e.message);
    expect(err).toContain('entity "minecraft:zombi" doesn\'t exist in this pack. Did you mean "minecraft:zombie"?');
    expect(err).toContain('comes after "nope", which isn\'t a quest key in this chapter.');
    expect(err).toContain("quests come after each other in a loop (a -> b -> a)");
    expect(await exists(join(s.root, "minecraft/config/heracles"))).toBe(false);
  });

  it("writes Heracles files, reads them back as packsmith's, and the write undoes", async () => {
    const s = await setup();
    const res = await s.q.write(s.record.id, "heracles", [chapter]);
    expect(res.entry).toMatchObject({ action: "write-quests", reason: 'Wrote the "First Steps" chapter (Heracles)' });
    const dir = join(s.root, "minecraft/config/heracles");
    expect(await readFile(join(dir, "groups.txt"), "utf8")).toBe("First Steps\n");
    const night = JSON.parse(await readFile(join(dir, "quests/first_steps/ps_first_steps_night.json"), "utf8"));
    expect(night.dependencies).toEqual(["ps_first_steps_bench", "ps_first_steps_bread"]);
    expect(night.tasks.task_1).toEqual({ type: "heracles:kill_entity", title: "Defeat Zombie", entity: { type: "minecraft:zombie" }, amount: 1 });
    expect(night.tasks.task_2).toMatchObject({ type: "heracles:item", item: "farmers:tomato", amount: 2, collection: "AUTOMATIC", title: "Collect tomato ×2" });
    expect(night.display.groups["First Steps"].position).toEqual([128, 0]);

    const book = await s.q.book(s.record.id);
    expect(book.installed).toEqual(["heracles", "vanilla"]);
    expect(book.chapters).toHaveLength(1);
    expect(book.chapters[0]).toMatchObject({ title: "First Steps", engine: "heracles", writtenBy: "packsmith" });
    expect(book.chapters[0]!.quests.map((q) => q.title)).toEqual(["Wood First", "A Bench", "Bread", "First Night"]);
    expect(book.chapters[0]!.quests[1]!.rewards).toEqual([{ kind: "item", item: "minecraft:torch", count: 4 }]);
    expect(book.names["minecraft:zombie"]).toBe("Zombie");

    await s.journal.rollback(s.record, res.entry.id);
    expect(await exists(join(dir, "quests/first_steps"))).toBe(true); // folder stays, files go
    expect(await readdir(join(dir, "quests/first_steps"))).toEqual([]);
    expect((await s.q.book(s.record.id)).chapters).toEqual([]);
  });

  it("rewriting a chapter replaces its quests; removing it leaves other chapters alone", async () => {
    const s = await setup();
    // Someone else's chapter in the same book.
    const dir = join(s.root, "minecraft/config/heracles");
    await mkdir(join(dir, "quests/theirs"), { recursive: true });
    await writeFile(join(dir, "quests/theirs/their_one.json"), JSON.stringify({ display: { title: { text: "Theirs" }, groups: { "Their Chapter": {} } }, tasks: {}, rewards: {} }));
    await writeFile(join(dir, "groups.txt"), "Their Chapter\n");
    await s.q.write(s.record.id, "heracles", [chapter]);
    const shorter: ChapterSpec = { title: "First Steps", quests: [chapter.quests[0]!] };
    await s.q.write(s.record.id, "heracles", [shorter]);
    expect(await readdir(join(dir, "quests/first_steps"))).toEqual(["ps_first_steps_wood.json"]);
    expect(await readFile(join(dir, "groups.txt"), "utf8")).toBe("Their Chapter\nFirst Steps\n");
    await expect(s.q.write(s.record.id, "heracles", [{ ...shorter, title: "Their Chapter" }])).rejects.toThrow("already exists and wasn't written by packsmith");
    const book = await s.q.book(s.record.id);
    expect(book.chapters.map((c) => `${c.title}:${c.writtenBy}`)).toEqual(["Their Chapter:other", "First Steps:packsmith"]);

    await s.q.removeChapter(s.record.id, "heracles", "First Steps");
    expect(await readFile(join(dir, "groups.txt"), "utf8")).toBe("Their Chapter\n");
    expect(await exists(join(dir, "quests/theirs/their_one.json"))).toBe(true);
    await expect(s.q.removeChapter(s.record.id, "heracles", "Their Chapter")).rejects.toMatchObject({ code: "not-ours" });
  });

  it("never adds an engine on its own (QST-1)", async () => {
    const p = await questPack({ mods: { "farmers.jar": modJar("farmers", ["tomato"]) } });
    const installs: string[] = [];
    const { q } = service(p.record, p.dataDir, p.prismRoot, installs);
    await expect(q.write(p.record.id, "heracles", [chapter])).rejects.toMatchObject({ code: "engine-missing" });
    expect(installs).toEqual([]);
    await q.installEngine(p.record.id, "heracles");
    expect(installs).toEqual(["odyssey-quests"]);
    await expect(q.installEngine(p.record.id, "ftbquests")).rejects.toMatchObject({ code: "cannot-install" });
  });

  it("lists vanilla ids as unverified when Minecraft's game file can't be read, instead of passing them", async () => {
    const p = await questPack({ client: null, mods: { "farmers.jar": modJar("farmers", ["tomato"]), "heracles.jar": modJar("heracles") } });
    const { q } = service(p.record, p.dataDir, p.prismRoot);
    const res = await q.write(p.record.id, "heracles", [chapter]);
    expect(res.unverified).toEqual(expect.arrayContaining(["#minecraft:logs", "minecraft:crafting_table", "minecraft:zombie"]));
    expect(res.unverified).not.toContain("farmers:tomato");
  });
});

describe("vanilla advancements", () => {
  it("writes a data pack in this version's shapes, into the pack and every world, and undoes", async () => {
    const p = await questPack({ worlds: ["My World"], mods: { "farmers.jar": modJar("farmers", ["tomato"]) } });
    const s = service(p.record, p.dataDir, p.prismRoot);
    const res = await s.q.write(p.record.id, "vanilla", [chapter]);
    expect(res.warnings).toEqual(['Chapter "First Steps", quest "First Night": vanilla advancements show one "after" line; the others are listed in its description.']);
    const home = join(p.root, "minecraft/packsmith-datapacks/packsmith_quests");
    expect(JSON.parse(await readFile(join(home, "pack.mcmeta"), "utf8"))).toEqual({ pack: { description: "Quests written by packsmith", pack_format: 48 } });
    const wood = JSON.parse(await readFile(join(home, "data/packsmith/advancement/quests/first_steps/wood.json"), "utf8"));
    expect(wood.parent).toBe("packsmith:quests/first_steps/root");
    expect(wood.criteria.task_1).toEqual({ trigger: "minecraft:inventory_changed", conditions: { items: [{ items: "#minecraft:logs", count: { min: 8 } }] } });
    expect(wood.rewards).toEqual({ experience: 15 });
    const bench = JSON.parse(await readFile(join(home, "data/packsmith/advancement/quests/first_steps/bench.json"), "utf8"));
    expect(bench.display.icon).toEqual({ id: "minecraft:crafting_table" });
    expect(bench.rewards.loot).toEqual(["packsmith:quests/first_steps/bench"]);
    expect(await exists(join(home, "data/packsmith/loot_table/quests/first_steps/bench.json"))).toBe(true);
    const world = join(p.root, "minecraft/saves/My World/datapacks/packsmith_quests/data/packsmith/advancement/quests/first_steps/night.json");
    expect(JSON.parse(await readFile(world, "utf8")).display.frame).toBe("goal");

    const book = await s.q.book(p.record.id);
    expect(book.chapters[0]).toMatchObject({ title: "First Steps", engine: "vanilla", writtenBy: "packsmith" });
    await s.journal.rollback(p.record, res.entry.id);
    expect(await exists(world)).toBe(false);
  });

  it("refuses tick-it-yourself tasks, which advancements can't express", async () => {
    const p = await questPack();
    const { q } = service(p.record, p.dataDir, p.prismRoot);
    await expect(q.write(p.record.id, "vanilla", [{ title: "C", quests: [{ key: "a", title: "A", tasks: [{ kind: "check", text: "Build a house" }], rewards: [], after: [] }] }]))
      .rejects.toThrow('vanilla advancements can\'t have a "tick it yourself" task');
  });

  it("uses the 1.20 shapes on 1.20 (icon item key, list of items, plural folders)", async () => {
    const p = await questPack({ client: "1.20" });
    const { q } = service(p.record, p.dataDir, p.prismRoot);
    await q.write(p.record.id, "vanilla", [{ title: "Old", quests: [{ key: "a", title: "A", tasks: [{ kind: "item", item: "minecraft:bread", count: 2 }], rewards: [], after: [] }] }]);
    const a = JSON.parse(await readFile(join(p.root, "minecraft/packsmith-datapacks/packsmith_quests/data/packsmith/advancements/quests/old/a.json"), "utf8"));
    expect(a.display.icon).toEqual({ item: "minecraft:bread" });
    expect(a.criteria.task_1.conditions.items).toEqual([{ items: ["minecraft:bread"], count: { min: 2 } }]);
  });
});

describe("FTB Quests books (read-only, D-26)", () => {
  it("shows a book that came with the pack, titles from the lang file, in book order", async () => {
    const p = await questPack({ mods: { "ftbquests.jar": modJar("ftbquests", [], { neoforge: true }) } });
    const dir = join(p.root, "minecraft/config/ftbquests/quests");
    await mkdir(join(dir, "chapters"), { recursive: true });
    await mkdir(join(dir, "lang"), { recursive: true });
    await writeFile(join(dir, "chapter_groups.snbt"), '{\n\tchapter_groups: [\n\t\t{ id: "G1" }\n\t]\n}\n');
    await writeFile(join(dir, "chapters/b.snbt"), '{\n\tid: "C2"\n\tgroup: "G1"\n\torder_index: 0\n\tquests: [ ]\n}\n');
    await writeFile(join(dir, "chapters/a.snbt"), `{
\tid: "C1"
\tgroup: ""
\torder_index: 0
\tquests: [
\t\t{
\t\t\tid: "Q1"
\t\t\ttasks: [{ id: "T1", item: { count: 1, id: "minecraft:oak_log" }, type: "item", count: 8L }]
\t\t\trewards: [{ id: "R1", type: "xp", xp: 100 }]
\t\t\tx: 0.0d
\t\t\ty: 0.0d
\t\t}
\t\t{
\t\t\tdependencies: ["Q1"]
\t\t\tid: "Q2"
\t\t\ttasks: [{ entity: "minecraft:zombie", id: "T2", type: "kill", value: 3L }, { id: "T3", type: "checkmark" }, { id: "T4", type: "advancement" }]
\t\t}
\t]
}
`);
    await writeFile(join(dir, "lang/en_us.snbt"), '{\n\tchapter.C1.title: "&aGetting Started"\n\tchapter.C2.title: "Later"\n\tquest.Q2.title: "Night Watch"\n\tquest.Q2.quest_desc: ["Stay up.", "&7Bring torches."]\n}\n');
    const { q } = service(p.record, p.dataDir, p.prismRoot);
    const book = await q.book(p.record.id);
    expect(book.installed).toEqual(["ftbquests", "vanilla"]);
    expect(book.chapters.map((c) => c.title)).toEqual(["Getting Started", "Later"]);
    const [q1, q2] = book.chapters[0]!.quests;
    expect(q1).toMatchObject({ title: "Collect Oak Log ×8", icon: "minecraft:oak_log", rewards: [{ kind: "xp", amount: 100 }] });
    expect(q2).toMatchObject({ title: "Night Watch", description: ["Stay up.", "Bring torches."], dependsOn: ["Q1"] });
    expect(q2!.tasks).toEqual([{ kind: "kill", entity: "minecraft:zombie", count: 3 }, { kind: "check", text: "Tick it off" }, { kind: "other", text: "advancement" }]);
    expect(book.chapters[0]).toMatchObject({ engine: "ftbquests", writtenBy: "other" });
    await expect(q.write(p.record.id, "ftbquests", [chapter])).rejects.toMatchObject({ code: "cannot-write" });
  });
});
