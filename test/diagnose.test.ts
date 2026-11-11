import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { diagnose } from "../src/main/crash/diagnose";

const fixture = (name: string) => readFileSync(join(__dirname, "fixtures/crash", name), "utf8");
const ids = (d: ReturnType<typeof diagnose>) => d.culprits.map((c) => `${c.role}:${c.modId}`).sort();

describe("diagnose (crash fixture suite, M-9)", () => {
  it("real Fabric log: names both missing libraries and who needs them", () => {
    const d = diagnose(fixture("fabric-missing-dependency.log"));
    expect(d.kind).toBe("missing_dependency");
    expect(ids(d)).toEqual(["missing:balm", "missing:fabric-api"]);
    expect(d.culprits.every((c) => c.neededBy.includes("waystones"))).toBe(true);
    expect(d.confidence).toBe("high");
    expect(d.evidence.map((e) => e.line)).toEqual([13, 14]);
  });

  it("real Fabric log: a mod built for another Minecraft version", () => {
    const d = diagnose(fixture("fabric-wrong-minecraft.log"));
    expect(d.kind).toBe("version_mismatch");
    expect(d.culprits).toEqual([expect.objectContaining({ modId: "lithium", role: "wrong_version", wanted: "Minecraft 1.20.1" })]);
    expect(d.suggested[0]).toMatch(/Replace Lithium with a build for Minecraft 1\.21\.1/);
  });

  it("a clean boot has nothing to diagnose", () => {
    const d = diagnose(fixture("fabric-server-ok.log"));
    expect(d.kind).toBe("unknown");
    expect(d.evidence).toEqual([]);
  });

  it.each([
    ["neoforge-missing-dependency.log", "missing_dependency", ["missing:balm"]],
    ["neoforge-wrong-version.log", "version_mismatch", ["wrong_version:resourcefullib"]],
    ["fabric-incompatible.log", "incompatible_mods", ["conflict:embeddium", "conflict:sodium"]],
    ["fabric-mixin.log", "mixin_failure", ["cause:coolmod"]],
    ["java-version.log", "java_version", []],
    ["out-of-memory.log", "out_of_memory", []],
    ["neoforge-config.log", "config_parse", ["cause:waystones-common.toml"]],
    ["forge-wrong-side.log", "wrong_side", []],
  ])("%s -> %s", (file, kind, culprits) => {
    const d = diagnose(fixture(file));
    expect(d.kind).toBe(kind);
    expect(ids(d)).toEqual(culprits);
    expect(d.evidence.length).toBeGreaterThan(0);
  });

  it("reads a real Fabric version-range break with apostrophes in the names", () => {
    const d = diagnose(fixture("fabric-client-breaks.log"));
    expect(d.kind).toBe("incompatible_mods");
    expect(ids(d)).toEqual(["conflict:xaerominimap", "conflict:xmxw"]);
    expect(d.culprits.find((c) => c.modId === "xaerominimap")?.wanted).toBe("not version 26.2.0 or later");
    expect(d.suggested.join(" ")).toContain("Xaero's Maps x Waystones can't run with Xaero's Minimap version 26.2.0 or later (found 26.6.0)");
  });

  it("reads a real Fabric break on older versions (\"any version before X\")", () => {
    const d = diagnose(fixture("fabric-breaks-before.log"));
    expect(d.kind).toBe("incompatible_mods");
    expect(ids(d)).toEqual(["conflict:xaerominimap", "conflict:xaeroworldmap"]);
    expect(d.culprits.find((c) => c.modId === "xaerominimap")?.wanted).toBe("not any version before 26.4.0");
    expect(d.suggested.join(" ")).toContain("Xaero's World Map can't run with Xaero's Minimap any version before 26.4.0 (found 26.1.0)");
  });

  it("merges one library needed by two mods into one culprit", () => {
    const d = diagnose(fixture("neoforge-missing-dependency.log"));
    expect(d.culprits).toEqual([expect.objectContaining({ modId: "balm", neededBy: ["waystones", "trashslot"], wanted: "[21.0.0,)" })]);
  });

  it("java version suggestion names the Java needed", () => {
    expect(diagnose(fixture("java-version.log")).suggested[0]).toMatch(/Java 21 or newer \(this was Java 17\)/);
  });

  it("the signature ignores timestamps, so a repeated failure is recognised (stagnation)", () => {
    const a = diagnose(fixture("fabric-missing-dependency.log"));
    const b = diagnose(fixture("fabric-missing-dependency.log").replaceAll("18:05:41", "09:12:00"));
    expect(a.signature).toBe(b.signature);
    expect(a.signature).not.toBe(diagnose(fixture("neoforge-missing-dependency.log")).signature);
    const u1 = diagnose("[10:00:00] [main/ERROR]: boom 12");
    const u2 = diagnose("[11:11:11] [main/ERROR]: boom 99");
    expect(u1.signature).toBe(u2.signature);
  });
});
