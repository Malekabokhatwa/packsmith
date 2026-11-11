import { describe, expect, it } from "vitest";
import { appendFile, mkdir, readFile, rm, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import type { InstanceRecord } from "@shared/schema";
import { Journal } from "../src/main/instances/journal";
import { writeMarker } from "../src/main/instances/marker";
import { tempDir } from "./helpers";

async function pack(): Promise<{ r: InstanceRecord; dataDir: string; j: Journal }> {
  const dataDir = await tempDir("ps-journal-data-");
  const root = await tempDir("ps-journal-pack-");
  await mkdir(join(root, "minecraft/config"), { recursive: true });
  await mkdir(join(root, "minecraft/mods"), { recursive: true });
  const createdAt = new Date().toISOString();
  await writeMarker(root, { createdBy: "packsmith", version: 1, instanceId: "packsmith-1.21.1-j", kind: "pack", mcVersion: "1.21.1", loader: "fabric", packName: "J", createdAt });
  const r: InstanceRecord = { id: "packsmith-1.21.1-j", origin: "own", launcher: "app-managed", path: root, name: "J", mcVersion: "1.21.1", loader: "fabric", createdAt, groupPending: false };
  return { r, dataDir, j: new Journal(dataDir) };
}

const exists = (p: string) => access(p).then(() => true, () => false);
const CFG = "minecraft/config/sodium.properties";

describe("Journal (spec 4.3)", () => {
  it("records a change with before/after hashes and a backup, then undoes it", async () => {
    const { r, j } = await pack();
    await writeFile(join(r.path, CFG), "a=1\n");
    const { entry } = await j.record(r, { action: "write", reason: "Lower particles" }, [CFG], async (abs) => {
      await writeFile(abs.get(CFG)!, "a=2\n");
    });
    expect(entry.state).toBe("committed");
    expect(entry.files[0]!.beforeSha256).not.toBe(entry.files[0]!.afterSha256);
    expect(await readFile(join(r.path, CFG), "utf8")).toBe("a=2\n");

    const undone = await j.rollback(r, entry.id);
    expect(undone.state).toBe("rolled-back");
    expect(await readFile(join(r.path, CFG), "utf8")).toBe("a=1\n");
    expect((await j.list(r))[0]).toMatchObject({ id: entry.id, state: "rolled-back" });
    await expect(j.rollback(r, entry.id)).rejects.toMatchObject({ code: "already-undone" });
  });

  it("undoing a new file removes it; undoing a removal brings it back", async () => {
    const { r, j } = await pack();
    const jar = "minecraft/mods/a.jar";
    const add = await j.record(r, { action: "download", reason: "Added A" }, [jar], async (abs) => writeFile(abs.get(jar)!, "jar"));
    expect(add.entry.files[0]!.beforeSha256).toBeNull();
    const del = await j.record(r, { action: "remove", reason: "Removed A" }, [jar], async (abs) => rm(abs.get(jar)!));
    expect(await exists(join(r.path, jar))).toBe(false);
    await j.rollback(r, del.entry.id);
    expect(await readFile(join(r.path, jar), "utf8")).toBe("jar");
    await j.rollback(r, add.entry.id);
    expect(await exists(join(r.path, jar))).toBe(false);
  });

  it("refuses to undo a change whose file was changed again later, and touches nothing", async () => {
    const { r, j } = await pack();
    await writeFile(join(r.path, CFG), "a=1\n");
    const first = await j.record(r, { action: "write", reason: "first" }, [CFG], async (abs) => writeFile(abs.get(CFG)!, "a=2\n"));
    await j.record(r, { action: "write", reason: "second" }, [CFG], async (abs) => writeFile(abs.get(CFG)!, "a=3\n"));
    await expect(j.rollback(r, first.entry.id)).rejects.toMatchObject({ code: "rollback-conflict" });
    expect(await readFile(join(r.path, CFG), "utf8")).toBe("a=3\n");
  });

  it("a change that fails half way is put back and marked rolled back", async () => {
    const { r, j } = await pack();
    await writeFile(join(r.path, CFG), "a=1\n");
    const jar = "minecraft/mods/b.jar";
    await expect(j.record(r, { action: "write", reason: "fails" }, [CFG, jar], async (abs) => {
      await writeFile(abs.get(CFG)!, "broken");
      await writeFile(abs.get(jar)!, "half");
      throw new Error("download died");
    })).rejects.toThrow("download died");
    expect(await readFile(join(r.path, CFG), "utf8")).toBe("a=1\n");
    expect(await exists(join(r.path, jar))).toBe(false);
    expect((await j.list(r))[0]!.state).toBe("rolled-back");
  });

  it("startup recovery rolls back entries left open by a crash", async () => {
    const { r, dataDir, j } = await pack();
    await writeFile(join(r.path, CFG), "a=1\n");
    // Simulate a crash mid-change: the open line and backup exist, the change is half done.
    let crashed = false;
    const never = j.record(r, { action: "write", reason: "crash" }, [CFG, "minecraft/mods/c.jar"], async (abs) => {
      await writeFile(abs.get(CFG)!, "half-written");
      await writeFile(`${abs.get("minecraft/mods/c.jar")!}.part`, "partial");
      crashed = true;
      await new Promise(() => undefined); // the process "dies" here
    });
    void never;
    await new Promise((res) => setTimeout(res, 50));
    expect(crashed).toBe(true);

    const fresh = new Journal(dataDir); // the next start
    expect((await fresh.list(r))[0]!.state).toBe("open");
    expect(await fresh.recover(r)).toBe(1);
    expect(await readFile(join(r.path, CFG), "utf8")).toBe("a=1\n");
    expect(await exists(join(r.path, "minecraft/mods/c.jar.part"))).toBe(false);
    expect((await fresh.list(r))[0]!.state).toBe("rolled-back");
    expect(await fresh.recover(r)).toBe(0);
  });

  it("refuses to undo when the saved copy is damaged", async () => {
    const { r, dataDir, j } = await pack();
    await writeFile(join(r.path, CFG), "a=1\n");
    const { entry } = await j.record(r, { action: "write", reason: "x" }, [CFG], async (abs) => writeFile(abs.get(CFG)!, "a=2\n"));
    await writeFile(join(dataDir, "journal", r.id, "backups", entry.id, CFG), "tampered");
    await expect(j.rollback(r, entry.id)).rejects.toMatchObject({ code: "backup-damaged" });
    expect(await readFile(join(r.path, CFG), "utf8")).toBe("a=2\n");
  });

  it("skips a torn last line and keeps the journal readable", async () => {
    const { r, dataDir, j } = await pack();
    await j.record(r, { action: "write", reason: "ok" }, [CFG], async (abs) => writeFile(abs.get(CFG)!, "x"));
    await appendFile(join(dataDir, "journal", r.id, "journal.jsonl"), '{"id":"j-torn","sta');
    expect(await j.list(r)).toHaveLength(1);
  });

  it("never records a path outside the pack", async () => {
    const { r, j } = await pack();
    await expect(j.record(r, { action: "write", reason: "escape" }, ["../outside.txt"], async () => undefined)).rejects.toMatchObject({ code: "bad-path" });
    expect(await j.list(r)).toEqual([]);
  });
});
