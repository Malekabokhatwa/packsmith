import { describe, expect, it } from "vitest";
import { checkConfig, checkSnbt, formatFor } from "../src/main/config/formats";

describe("config formats (M-6, CFG-2)", () => {
  it("knows the formats by file name", () => {
    expect(formatFor("minecraft/options.txt")).toBe("options");
    expect(formatFor("minecraft/config/sodium-options.json")).toBe("json");
    expect(formatFor("minecraft/config/jei/jei-client.ini")).toBe("plain");
    expect(formatFor("minecraft/config/create-common.toml")).toBe("toml");
    expect(formatFor("minecraft/config/iris.properties")).toBe("properties");
    expect(formatFor("minecraft/config/ftbquests/quests/data.snbt")).toBe("snbt");
    expect(formatFor("minecraft/config/x.yml")).toBe("yaml");
    expect(formatFor("minecraft/config/x.json5")).toBe("json5");
    expect(formatFor("minecraft/mods/sodium.jar")).toBeNull();
    expect(formatFor("minecraft/kubejs/server_scripts/a.js")).toBeNull();
  });

  it("accepts valid files and names the line of an invalid one", () => {
    expect(checkConfig("options", "renderDistance:8\nparticles:2\n\n")).toEqual({ ok: true });
    expect(checkConfig("options", "renderDistance:8\nparticles = 2\n")).toEqual({ ok: false, error: 'Line 2 isn\'t key:value: "particles = 2"' });
    expect(checkConfig("properties", "# Iris\nshaderPack=Complementary.zip\nenableShaders=true\nlong=a\\\n  b\n")).toEqual({ ok: true });
    expect(checkConfig("properties", "=nokey\n").ok).toBe(false);
    expect(checkConfig("toml", "[client]\nmaxEntities = 20\n")).toEqual({ ok: true });
    expect(checkConfig("toml", "[client\nmaxEntities = 20\n").ok).toBe(false);
    expect(checkConfig("json", '{"quality": {"weather": "FAST"}}')).toEqual({ ok: true });
    expect(checkConfig("json", '{"quality": }').ok).toBe(false);
    expect(checkConfig("json5", "{quality: 'fast', // comment\n}")).toEqual({ ok: true });
    expect(checkConfig("yaml", "a: 1\nb:\n  - x\n")).toEqual({ ok: true });
    expect(checkConfig("yaml", "a: [1, 2\n").ok).toBe(false);
    expect(checkConfig("plain", "anything at all")).toEqual({ ok: true });
    expect(checkConfig("plain", "bad\u0000").ok).toBe(false);
    expect(checkConfig("plain", "x".repeat(600 * 1024)).ok).toBe(false);
  });

  it("checks SNBT as FTB Quests writes it (newline separators, typed arrays, suffixes)", () => {
    const ftb = `{
\tid: "6A3F1B2C3D4E5F60"
\tgroup: ""
\tquests: [
\t\t{
\t\t\tid: "1"
\t\t\ttasks: [{ id: "2", type: "item", item: "minecraft:oak_log", count: 8L }]
\t\t\trewards: [{ type: "xp", xp: 15 }]
\t\t\tx: -1.5d
\t\t\tdependencies: ["0"]
\t\t\tcolors: [I; 1, 2, 3]
\t\t\thide: false
\t\t}
\t]
}
`;
    expect(checkSnbt(ftb)).toEqual({ ok: true });
    expect(checkSnbt("{a: 1, b: 'it\\'s'}").ok).toBe(true);
    expect(checkSnbt("{a: 1\nb: [1, 2\n}")).toEqual({ ok: false, error: 'Line 3: unexpected "}"' });
    expect(checkSnbt('{title: "unterminated}')).toEqual({ ok: false, error: "Line 1: a quoted string never ends" });
    expect(checkSnbt("{a 1}").ok).toBe(false);
    expect(checkSnbt("{a: 1} extra").ok).toBe(false);
  });
});
