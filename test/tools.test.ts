import { describe, expect, it } from "vitest";
import type { Plan } from "@shared/agent";
import { TOOLS, type ToolContext } from "../src/main/agent/tools";
import type { Packs } from "../src/main/instances/manager";
import { ModrinthClient, MODRINTH_API, Throttle, type ModrinthProject, type ModrinthVersion } from "../src/main/sources/modrinth";
import { fakeHttp, fixture } from "./helpers";

async function modrinth(over: (versions: Record<string, ModrinthVersion[]>) => void = () => undefined) {
  const f = (await fixture("resolver.json")) as { projects: ModrinthProject[]; versions: Record<string, ModrinthVersion[]> };
  over(f.versions);
  const { http } = fakeHttp({
    json: {
      [`${MODRINTH_API}/`]: (url: string) => {
        const u = new URL(url);
        if (u.pathname === "/v2/projects") {
          const ids = JSON.parse(u.searchParams.get("ids")!) as string[];
          return f.projects.filter((p) => ids.includes(p.id) || ids.includes(p.slug));
        }
        const m = /^\/v2\/project\/([^/]+)\/version$/.exec(u.pathname);
        if (m) return f.versions[m[1]!] ?? [];
        throw new Error(url);
      },
    },
  });
  return new ModrinthClient(http, new Throttle(1000));
}

const tool = (name: string) => TOOLS.find((t) => t.name === name)!;
// The changing tools must refuse before they reach the pack manager.
const untouchable = new Proxy({}, { get: () => () => { throw new Error("pack manager was called"); } }) as unknown as Packs;

describe("plan card tools (F02)", () => {
  it("propose_plan resolves the picks, shows the card, and then every change waits for the user", async () => {
    const shown: Plan[] = [];
    const ctx: ToolContext = { packs: untouchable, modrinth: await modrinth(), searchConfigured: false, plan: { pending: false, show: (p) => shown.push(p) } };
    const res = await tool("propose_plan").run(tool("propose_plan").input.parse({
      name: "Wayfarer", mc_version: "1.21.1", loader: "fabric", picks: [{ project_id: "waystones", reason: "Fast travel between bases" }],
    }) as never, ctx);
    expect(res.summary).toBe("3 files");
    expect(shown[0]).toMatchObject({
      name: "Wayfarer", files: 3,
      mods: [
        { title: "Waystones", why: "requested", reason: "Fast travel between bases", neededBy: [] },
        { title: "Fabric API", why: "dependency", neededBy: ["Waystones", "Balm"] },
        { title: "Balm", why: "dependency", neededBy: ["Waystones"] },
      ],
    });
    expect(ctx.plan!.pending).toBe(true);

    for (const [name, args] of [
      ["create_instance", { name: "x", mc_version: "1.21.1", loader: "fabric" }],
      ["download_file", { instance_id: "p", version_id: "v" }],
      ["write_file", { instance_id: "p", relpath: "minecraft/options.txt", content: "a:1" }],
      ["remove_file", { instance_id: "p", relpath: "minecraft/mods/a.jar" }],
      ["set_enabled", { instance_id: "p", relpath: "minecraft/mods/a.jar", enabled: false }],
      ["set_loader", { instance_id: "p", loader: "fabric" }],
    ] as const) {
      await expect(tool(name).run(tool(name).input.parse(args) as never, ctx), name).rejects.toMatchObject({ code: "plan-pending" });
    }
    await expect(tool("propose_plan").run(tool("propose_plan").input.parse({ name: "Again", mc_version: "1.21.1", loader: "fabric", picks: [{ project_id: "waystones" }] }) as never, ctx)).rejects.toMatchObject({ code: "plan-pending" });
  });

  it("propose_plan refuses conflicting picks with the explanation, and shows nothing", async () => {
    const shown: Plan[] = [];
    const ctx: ToolContext = { packs: untouchable, modrinth: await modrinth((v) => { v.MBAkmtvl = []; }), searchConfigured: false, plan: { pending: false, show: (p) => shown.push(p) } };
    await expect(tool("propose_plan").run(tool("propose_plan").input.parse({ name: "W", mc_version: "1.21.1", loader: "fabric", picks: [{ project_id: "waystones" }] }) as never, ctx))
      .rejects.toThrow("Waystones needs Balm, and Balm has no version for Fabric 1.21.1.");
    expect(shown).toEqual([]);
    expect(ctx.plan!.pending).toBe(false);
  });

  it("resolve_dependencies reports optional libraries and changes nothing", async () => {
    const ctx: ToolContext = { packs: untouchable, modrinth: await modrinth(), searchConfigured: false };
    const res = await tool("resolve_dependencies").run(tool("resolve_dependencies").input.parse({ selection: [{ project_id: "sodium-extra" }], mc_version: "1.21.1", loader: "fabric" }) as never, ctx);
    const data = res.data as { mods: Array<{ title: string; why: string }>; optional: unknown[]; files_to_download: number };
    expect(data.mods.map((m) => `${m.title}:${m.why}`)).toEqual(["Sodium Extra:requested", "Sodium:dependency"]);
    expect(data.optional).toHaveLength(3);
    expect(data.files_to_download).toBe(2);
  });
});

describe("quest tools", () => {
  it("write_quests takes flat tasks from the model and checks them into chapter specs", () => {
    const input = tool("write_quests").input.parse({
      instance_id: "p", engine: "heracles",
      chapters: [{ title: "Start", quests: [
        { key: "wood", title: "Wood", tasks: [{ kind: "item", item: "#minecraft:logs", count: 8 }], rewards: [{ kind: "xp", amount: 10 }, { kind: "item", item: "minecraft:torch", count: 4 }] },
        { key: "night", title: "Night", tasks: [{ kind: "kill", entity: "minecraft:zombie" }, { kind: "check", text: "Sleep in a bed" }], after: ["wood"] },
      ] }],
    }) as unknown as { chapters: Array<{ quests: Array<{ tasks: unknown[]; rewards: unknown[]; after: string[] }> }> };
    expect(input.chapters[0]!.quests[0]!.rewards).toEqual([{ kind: "xp", amount: 10 }, { kind: "item", item: "minecraft:torch", count: 4 }]);
    expect(input.chapters[0]!.quests[1]).toMatchObject({ after: ["wood"], tasks: [{ kind: "kill", entity: "minecraft:zombie", count: 1 }, { kind: "check", text: "Sleep in a bed" }], rewards: [] });
    const bad = tool("write_quests").input.safeParse({ instance_id: "p", engine: "heracles", chapters: [{ title: "S", quests: [{ key: "Bad Key", title: "x", tasks: [{ kind: "check" }] }] }] });
    expect(bad.success).toBe(false);
    expect(bad.error!.issues.map((i) => i.path.join("."))).toEqual(expect.arrayContaining(["chapters.0.quests.0.key", "chapters.0.quests.0.tasks.0.text"]));
  });

  it("write_quests and remove_quest_chapter wait while a plan is on screen", async () => {
    const ctx: ToolContext = { packs: untouchable, modrinth: await modrinth(), searchConfigured: false, plan: { pending: true, show: () => undefined } };
    await expect(tool("write_quests").run(tool("write_quests").input.parse({ instance_id: "p", engine: "vanilla", chapters: [{ title: "S", quests: [{ key: "a", title: "A", tasks: [{ kind: "item", item: "minecraft:bread" }] }] }] }) as never, ctx)).rejects.toMatchObject({ code: "plan-pending" });
    await expect(tool("remove_quest_chapter").run(tool("remove_quest_chapter").input.parse({ instance_id: "p", engine: "vanilla", title: "S" }) as never, ctx)).rejects.toMatchObject({ code: "plan-pending" });
  });
});
