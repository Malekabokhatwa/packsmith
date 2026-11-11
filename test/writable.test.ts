import { describe, expect, it } from "vitest";
import { mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import type { InstanceRecord } from "@shared/schema";
import { assertWritable } from "../src/main/instances/writable";
import { writeMarker } from "../src/main/instances/marker";
import { writeJsonAtomic } from "../src/main/store/jsonFile";
import { tempDir } from "./helpers";

async function ownPack(id = "packsmith-1.21.1-test") {
  const root = join(await tempDir(), id);
  await mkdir(join(root, "minecraft/mods"), { recursive: true });
  await writeMarker(root, { createdBy: "packsmith", version: 1, instanceId: id, kind: "pack", mcVersion: "1.21.1", loader: "fabric", packName: "Test", createdAt: new Date().toISOString() });
  const record: InstanceRecord = { id, origin: "own", launcher: "app-managed", path: root, name: "Test", mcVersion: "1.21.1", loader: "fabric", createdAt: new Date().toISOString(), groupPending: false };
  return { root, record };
}

describe("assertWritable: the INS-3 write boundary", () => {
  it("allows a path inside an own pack and creates missing folders", async () => {
    const { root, record } = await ownPack();
    expect(await assertWritable(record, "minecraft/shaderpacks/x.zip")).toBe(join(root, "minecraft/shaderpacks/x.zip"));
  });

  it.each(["../escape.jar", "minecraft/../../escape.jar", "/etc/passwd", "minecraft/mods/../../../x"])("refuses path %s", async (p) => {
    const { record } = await ownPack();
    await expect(assertWritable(record, p)).rejects.toMatchObject({ code: "bad-path" });
  });

  it("refuses writing through a symlinked folder that leads outside the pack", async () => {
    const { root, record } = await ownPack();
    const outside = await tempDir("outside-");
    await symlink(outside, join(root, "minecraft/config"));
    await expect(assertWritable(record, "minecraft/config/evil.toml")).rejects.toMatchObject({ code: "bad-path" });
  });

  it("refuses an instance that isn't marked as packsmith's (e.g. a decoy or another tool's pack)", async () => {
    const { root, record } = await ownPack();
    await writeJsonAtomic(join(root, ".packsmith-instance.json"), { createdBy: "another-tool" });
    await expect(assertWritable(record, "minecraft/mods/a.jar")).rejects.toMatchObject({ code: "not-writable" });
  });

  it("refuses when the marker names a different instance", async () => {
    const { record } = await ownPack();
    await expect(assertWritable({ ...record, id: "someone-else" }, "minecraft/mods/a.jar")).rejects.toMatchObject({ code: "not-writable" });
  });

  it("an adopted instance is writable only inside its scope (D-33)", async () => {
    const { record } = await ownPack();
    await expect(assertWritable({ ...record, origin: "adopted" }, "minecraft/mods/a.jar")).rejects.toMatchObject({ code: "out-of-scope" });
    await expect(assertWritable({ ...record, origin: "adopted", scope: ["mods"] }, "minecraft/mods/a.jar")).resolves.toContain("a.jar");
    await expect(assertWritable({ ...record, origin: "adopted", scope: ["mods"] }, "minecraft/saves/w/level.dat")).rejects.toMatchObject({ code: "not-writable" });
  });

  it("reports a missing pack folder clearly", async () => {
    const { record } = await ownPack();
    await expect(assertWritable({ ...record, path: "/nonexistent/packsmith" }, "minecraft/mods/a.jar")).rejects.toMatchObject({ code: "missing-instance" });
  });
});
