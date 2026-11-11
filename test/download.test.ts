import { describe, expect, it } from "vitest";
import { lstat, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { downloadVerified, safeFilename } from "../src/main/download";
import { fakeHttp, hashes, tempDir } from "./helpers";

const URL1 = "https://cdn.modrinth.com/data/abc/versions/1/mod.jar";
const body = Buffer.from("pretend this is a jar");

describe("download_file core (spec 5.2, PERF-7)", () => {
  it("installs a file whose SHA-1 and SHA-512 both match, and restricts the host to the CDN", async () => {
    const dir = await tempDir();
    const { http, calls } = fakeHttp({ files: { [URL1]: body } });
    await downloadVerified(http, { url: URL1, filename: "mod.jar", size: body.length, hashes: hashes(body) }, join(dir, "mod.jar"));
    expect(await readFile(join(dir, "mod.jar"))).toEqual(body);
    expect(calls[0]!.opts?.allowHosts).toEqual(["cdn.modrinth.com"]);
    expect(await readdir(dir)).toEqual(["mod.jar"]);
  });

  it("refuses a hash mismatch loudly and leaves nothing behind", async () => {
    const dir = await tempDir();
    const { http } = fakeHttp({ files: { [URL1]: body } });
    const bad = { ...hashes(body), sha512: "0".repeat(128) };
    await expect(downloadVerified(http, { url: URL1, filename: "mod.jar", size: body.length, hashes: bad }, join(dir, "mod.jar")))
      .rejects.toMatchObject({ code: "hash-mismatch" });
    expect(await readdir(dir)).toEqual([]);
  });

  it("refuses a non-200 answer", async () => {
    const dir = await tempDir();
    const { http } = fakeHttp({ files: { [URL1]: 404 } });
    await expect(downloadVerified(http, { url: URL1, filename: "m.jar", size: 1, hashes: hashes(body) }, join(dir, "m.jar")))
      .rejects.toMatchObject({ code: "download-failed" });
  });

  it("replaces a symlink at the target instead of writing through it (INS-5)", async () => {
    const dir = await tempDir();
    const outside = join(await tempDir(), "victim.txt");
    await writeFile(outside, "do not touch");
    await symlink(outside, join(dir, "mod.jar"));
    const { http } = fakeHttp({ files: { [URL1]: body } });
    await downloadVerified(http, { url: URL1, filename: "mod.jar", size: body.length, hashes: hashes(body) }, join(dir, "mod.jar"));
    expect((await lstat(join(dir, "mod.jar"))).isSymbolicLink()).toBe(false);
    expect(await readFile(outside, "utf8")).toBe("do not touch");
  });

  it.each(["../x.jar", "a/b.jar", "a\\b.jar", ".hidden.jar", "", "..", "x\u0000.jar", "x\n.jar"])("rejects unsafe file name %j", (n) => {
    expect(() => safeFilename(n)).toThrow();
  });
  it("accepts a normal Modrinth file name", () => {
    expect(safeFilename("sodium-fabric-0.6.13+mc1.21.1.jar")).toBe("sodium-fabric-0.6.13+mc1.21.1.jar");
  });
});
