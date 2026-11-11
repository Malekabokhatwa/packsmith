import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { diagnose } from "../src/main/crash/diagnose";
import {
  compareVersions, complement, intersect, limitsOn, packFabricMods, parsePredicate, rangeText, withPackLimits, withVersionLimits, type FabricMod,
} from "../src/main/crash/limits";
import { ZipWriter } from "../src/main/export/zipWriter";

// depends/breaks as read from the jars in Malek's live "Fabric Waystones & Minimap" pack (2026-11-10).
const mod = (id: string, name: string, version: string, depends: Record<string, unknown>, breaks: Record<string, unknown>): FabricMod => ({ id, name, version, depends, breaks });
const xmxw = mod("xmxw", "Xaero's Maps x Waystones", "2.12.1+1.21.1-fabric", { "fabric-api": "*", waystones: ">=21", xaerominimap: ">=25" }, { xaerominimap: ">=26.2.0" });
const worldMap147 = mod("xaeroworldmap", "Xaero's World Map", "1.47.0", { minecraft: ">1.20.6 <1.21.2" }, { openpartiesandclaims: "<0.27.0", xaerominimap: "<26.4.0" });
const worldMap142 = mod("xaeroworldmap", "Xaero's World Map", "1.42.0", { minecraft: ">1.20.6 <1.21.2" }, { xaerominimap: "<26.2.0" });
const minimap = (v: string) => mod("xaerominimap", "Xaero's Minimap", v, { minecraft: "1.21.1" }, { xaeroworldmap: "<1.40.2" });
const fixture = (name: string) => readFileSync(join(__dirname, "fixtures/crash", name), "utf8");

describe("versions and ranges", () => {
  it("compares Fabric versions numerically, ignoring build metadata, pre-releases first", () => {
    expect(compareVersions("26.10.0", "26.2.0")).toBe(1);
    expect(compareVersions("26.2", "26.2.0")).toBe(0);
    expect(compareVersions("2.12.1+1.21.1-fabric", "2.12.1")).toBe(0);
    expect(compareVersions("1.0.0-beta.2", "1.0.0")).toBe(-1);
    expect(compareVersions("1.0.0-beta.1", "1.0.0-beta.2")).toBe(-1);
  });

  it("reads comparators, space-separated ANDs, arrays as ORs and *", () => {
    expect(rangeText(parsePredicate(">=26.2.0")!)).toBe("26.2.0 or later");
    expect(rangeText(parsePredicate(">1.20.6 <1.21.2")!)).toBe("1.20.6 (exclusive) or later and below 1.21.2");
    expect(rangeText(parsePredicate("1.21.1")!)).toBe("exactly 1.21.1");
    expect(rangeText(parsePredicate("*")!)).toBe("any version");
    expect(rangeText(parsePredicate(["<1.0", ">=2.0"])!)).toBe("below 1.0, or 2.0 or later");
    expect(rangeText(parsePredicate(">=2 <1")!)).toBe("no version");
  });

  it("claims nothing for forms it doesn't model", () => {
    expect(parsePredicate("^1.2.0")).toBeNull();
    expect(parsePredicate("~1.2")).toBeNull();
    expect(parsePredicate("1.2.x")).toBeNull();
    expect(parsePredicate(42)).toBeNull();
  });

  it("complements and intersects", () => {
    expect(rangeText(complement(parsePredicate(">=26.2.0")!))).toBe("below 26.2.0");
    expect(rangeText(complement(parsePredicate(">1 <3")!))).toBe("up to 1, or 3 or later");
    expect(complement(parsePredicate("*")!)).toEqual([]);
    expect(rangeText(intersect(parsePredicate(">=25")!, complement(parsePredicate(">=26.2.0")!)))).toBe("25 or later and below 26.2.0");
    expect(intersect(parsePredicate("<26.2.0")!, parsePredicate(">=26.4.0")!)).toEqual([]);
  });
});

describe("the limits a pack puts on one mod", () => {
  it("live squeeze: no Minimap satisfies both Xaero's Maps x Waystones and World Map 1.47.0", () => {
    const l = limitsOn([xmxw, worldMap147, minimap("26.6.0")], "xaerominimap");
    expect(l.allowed).toEqual([]);
    expect(l.installed).toBe("26.6.0");
    expect(l.limits.map((x) => x.by.id)).toEqual(["xmxw", "xmxw", "xaeroworldmap"]);
  });

  it("the diagnosis of the real client log says changing Minimap can't fix it, before the old advice", () => {
    const d = withVersionLimits(diagnose(fixture("fabric-client-breaks.log")), [xmxw, worldMap147, minimap("26.6.0")]);
    expect(d.suggested[0]).toBe(
      "No version of Xaero's Minimap works with every mod in this pack (Xaero's Maps x Waystones 2.12.1+1.21.1-fabric accepts 25 or later and below 26.2.0; Xaero's World Map 1.47.0 accepts 26.4.0 or later), so changing Xaero's Minimap's version can't fix this: remove one of those mods, or change the version of one of them.",
    );
    expect(d.suggested[1]).toMatch(/use an older Xaero's Minimap/);
    expect(d.signature).toBe(diagnose(fixture("fabric-client-breaks.log")).signature); // stagnation still sees the same crash
  });

  it("the downgrade the model tried live (World Map 1.42.0) is still impossible, and says so", () => {
    const d = withVersionLimits(diagnose(fixture("fabric-breaks-before.log")), [xmxw, worldMap142, minimap("26.1.0")]);
    expect(d.suggested[0]).toMatch(/^No version of Xaero's Minimap works .* Xaero's World Map 1\.42\.0 accepts 26\.2\.0 or later\)/);
  });

  it("when versions do fit, names the range every mod accepts", () => {
    const worldMapOld = mod("xaeroworldmap", "Xaero's World Map", "1.40.0", {}, { xaerominimap: "<26.0.0" });
    const d = withVersionLimits(diagnose(fixture("fabric-client-breaks.log")), [xmxw, worldMapOld, minimap("26.6.0")]);
    expect(d.suggested[0]).toBe("Every mod in this pack accepts Xaero's Minimap 26.0.0 or later and below 26.2.0 (installed: 26.6.0) (Xaero's Maps x Waystones 2.12.1+1.21.1-fabric accepts 25 or later and below 26.2.0; Xaero's World Map 1.40.0 accepts 26.0.0 or later).");
  });

  it("adds nothing when one mod alone sets the limit (the log already says it), or for other kinds", () => {
    const one = withVersionLimits(diagnose(fixture("fabric-client-breaks.log")), [xmxw, minimap("26.6.0")]);
    expect(one.suggested).toEqual(diagnose(fixture("fabric-client-breaks.log")).suggested);
    const missing = diagnose(fixture("fabric-missing-dependency.log"));
    expect(withVersionLimits(missing, [xmxw, worldMap147])).toBe(missing);
  });

  it("an unmodelled range never yields an 'accepts' claim, but an impossible subset still counts", () => {
    const caret = mod("other", "Other", "1.0", { xaerominimap: "^26.0.0" }, {});
    const fits = withVersionLimits(diagnose(fixture("fabric-client-breaks.log")), [xmxw, caret, mod("w", "W", "1", {}, { xaerominimap: "<25.5" }), minimap("26.6.0")]);
    expect(fits.suggested.join(" ")).not.toMatch(/Every mod/);
    const impossible = withVersionLimits(diagnose(fixture("fabric-client-breaks.log")), [xmxw, caret, worldMap147, minimap("26.6.0")]);
    expect(impossible.suggested[0]).toMatch(/^No version of Xaero's Minimap/);
  });
});

describe("reading a pack's jars", () => {
  async function jar(path: string, json?: object) {
    const z = ZipWriter.create(path);
    if (json) await z.add("fabric.mod.json", Buffer.from(JSON.stringify(json)));
    await z.add("assets/x/icon.png", Buffer.from("png"));
    await z.close();
  }

  it("reads enabled jars' fabric.mod.json, skips disabled jars and jars without one", async () => {
    const root = await mkdtemp(join(tmpdir(), "ps-limits-"));
    const mods = join(root, "minecraft/mods");
    await mkdir(mods, { recursive: true });
    await jar(join(mods, "xmxw.jar"), { schemaVersion: 1, ...xmxw });
    await jar(join(mods, "worldmap.jar"), { schemaVersion: 1, ...worldMap147 });
    await jar(join(mods, "minimap.jar"), { schemaVersion: 1, ...minimap("26.6.0") });
    await jar(join(mods, "forge-only.jar"));
    await jar(join(mods, "off.jar"), { schemaVersion: 1, id: "off", breaks: { xaerominimap: "*" } });
    await rename(join(mods, "off.jar"), join(mods, "off.jar.disabled"));

    const read = await packFabricMods(root);
    expect(read.map((m) => m.id).sort()).toEqual(["xaerominimap", "xaeroworldmap", "xmxw"]);

    const d = await withPackLimits(diagnose(fixture("fabric-client-breaks.log")), "fabric", root);
    expect(d.suggested[0]).toMatch(/^No version of Xaero's Minimap works/);
    // Other loaders: not read (their jars carry mods.toml ranges, not modelled yet).
    const neo = diagnose(fixture("fabric-client-breaks.log"));
    expect(await withPackLimits(neo, "neoforge", root)).toBe(neo);
  });
});
