import { describe, expect, it } from "vitest";
import { Settings, PacksFile, McVersion } from "@shared/schema";

describe("storage schemas", () => {
  it("fills every nested default from an empty settings file (zod 4 prefault)", () => {
    const s = Settings.parse({});
    expect(s.launcher).toEqual({ kind: "app-managed", prismWriteAllowed: false });
    expect(s.budgets).toMatchObject({ wallClockMin: 30, attemptsPerIssue: 5, stagnationRepeats: 3 });
    expect(s.search.provider).toBe("none");
    expect(s.theme).toBe("dark");
  });
  it("starts an empty registry", () => {
    expect(PacksFile.parse({})).toEqual({ schemaVersion: 1, instances: [] });
  });
  it.each(["1.21.1", "1.20", "26.2", "26.1.2"])("accepts Minecraft version %s", (v) => expect(McVersion.safeParse(v).success).toBe(true));
  it.each(["1.21.1-pre1", "24w14a", "", "latest"])("rejects %j", (v) => expect(McVersion.safeParse(v).success).toBe(false));
});
