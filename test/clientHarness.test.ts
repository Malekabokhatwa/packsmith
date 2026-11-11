import { describe, expect, it } from "vitest";
import { CLIENT_MARKS, hasAccount, hmcBuild, profileName } from "../src/main/testing/client";

describe("client harness", () => {
  it("reads HeadlessMC's account list: dashes mean nobody is logged in", () => {
    expect(hasAccount("name   uuid   type   provider\n-      -      -      -\n")).toBe(false);
    expect(hasAccount("name   uuid   type   provider\nSteve  0000-FAKE  msa  default\n")).toBe(true);
    expect(hasAccount("something went wrong")).toBe(false);
  });
  it("marks: the test mod's first tick is Boots, its success line is Loads a world", () => {
    expect(CLIENT_MARKS.boots.test("[12:00:00] [Render thread/INFO]: Waiting for player to load... screen: null")).toBe(true);
    expect(CLIENT_MARKS.world.test("[12:00:30] [Render thread/INFO]: Successfully finished.")).toBe(true);
    expect(CLIENT_MARKS.world.test("[12:00:30] [Render thread/INFO]: No tests found, Successfully finished.")).toBe(true);
    expect(CLIENT_MARKS.world.test("Successfully finished. or not")).toBe(false);
  });
  it("finds the pack's exact loader build in HeadlessMC's version list", () => {
    // Real output shape (3.0.0-RC8, 2026-11-03).
    const list = "name                          parent   type\nfabric-loader-0.17.2-1.21.1   1.21.1   release\n1.21.1                        -        release\nfabric-loader-0.20.1-1.21.1   1.21.1   release\n";
    expect(profileName(list, "fabric", "1.21.1", "0.20.1")).toBe("fabric-loader-0.20.1-1.21.1");
    expect(profileName(list, "fabric", "1.21.1", "0.16.0")).toBeNull();
    const forgeish = "name parent type\nneoforge-21.1.209 1.21.1 release\n1.20.1-forge-47.4.0 1.20.1 release\n";
    expect(profileName(forgeish, "neoforge", "1.21.1", "21.1.209")).toBe("neoforge-21.1.209");
    expect(profileName(forgeish, "forge", "1.20.1", "47.4.0")).toBe("1.20.1-forge-47.4.0");
    expect(profileName(forgeish, "forge", "1.21.1", "21.1.209")).toBeNull();
  });
  it("names loader builds the way HeadlessMC's version list does", () => {
    expect(hmcBuild("fabric", "1.21.1", "0.20.1")).toBe("0.20.1");
    expect(hmcBuild("forge", "1.20.1", "47.4.0")).toBe("47.4.0");
    expect(hmcBuild("neoforge", "1.21.1", "21.1.209")).toBe("209");
    expect(hmcBuild("neoforge", "1.21", "21.0.167")).toBe("167");
    expect(hmcBuild("neoforge", "1.20.1", "47.1.106")).toBe("47.1.106");
  });
});
