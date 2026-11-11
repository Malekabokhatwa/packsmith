import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { Http } from "../src/main/net/http";
import { forgeInstaller, installerArtifact, serverArgs } from "../src/main/testing/forge";

// Answers each URL from a table; everything else is a 404.
function fakeHttp(files: Record<string, Buffer | string>): Http & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    json: async () => { throw new Error("no json here"); },
    request: async (url: string) => {
      asked.push(url);
      const body = files[url];
      return { status: body === undefined ? 404 : 200, headers: {}, body: Readable.from(body === undefined ? [] : [Buffer.from(body)]) } as never;
    },
  };
}

const tmp = () => mkdtemp(join(tmpdir(), "packsmith-forge-"));

describe("Forge and NeoForge servers", () => {
  it("knows where each loader publishes its installer", () => {
    expect(installerArtifact("forge", "1.21.1", "52.1.21").url).toBe("https://maven.minecraftforge.net/net/minecraftforge/forge/1.21.1-52.1.21/forge-1.21.1-52.1.21-installer.jar");
    expect(installerArtifact("neoforge", "1.21.1", "21.1.209").url).toBe("https://maven.neoforged.net/releases/net/neoforged/neoforge/21.1.209/neoforge-21.1.209-installer.jar");
    // NeoForge's 1.20.1 builds kept the old artifact name.
    expect(installerArtifact("neoforge", "1.20.1", "47.1.106").url).toBe("https://maven.neoforged.net/releases/net/neoforged/forge/1.20.1-47.1.106/forge-1.20.1-47.1.106-installer.jar");
  });

  it("keeps an installer only when it matches the published SHA-256", async () => {
    const dir = await tmp();
    try {
      const jar = Buffer.from("PK fake installer");
      const { url } = installerArtifact("neoforge", "1.21.1", "21.1.209");
      const good = fakeHttp({ [url]: jar, [`${url}.sha256`]: `${createHash("sha256").update(jar).digest("hex")}\n` });
      const path = await forgeInstaller(good, dir, "neoforge", "1.21.1", "21.1.209");
      expect(await readFile(path)).toEqual(jar);
      // Cached: no second download.
      good.asked.length = 0;
      await forgeInstaller(good, dir, "neoforge", "1.21.1", "21.1.209");
      expect(good.asked).toEqual([]);

      const other = installerArtifact("forge", "1.21.1", "52.1.21").url;
      const bad = fakeHttp({ [other]: jar, [`${other}.sha256`]: "0".repeat(64) });
      await expect(forgeInstaller(bad, dir, "forge", "1.21.1", "52.1.21")).rejects.toMatchObject({ code: "hash-mismatch" });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("falls back to SHA-1, and refuses an installer with no checksum at all", async () => {
    const dir = await tmp();
    try {
      const jar = Buffer.from("PK older installer");
      const { url } = installerArtifact("forge", "1.20.1", "47.4.0");
      const sha1 = fakeHttp({ [url]: jar, [`${url}.sha1`]: createHash("sha1").update(jar).digest("hex") });
      await expect(forgeInstaller(sha1, dir, "forge", "1.20.1", "47.4.0")).resolves.toContain("forge-1.20.1-47.4.0-installer.jar");
      const none = fakeHttp({ [installerArtifact("forge", "1.20.1", "47.3.0").url]: jar, [`${installerArtifact("forge", "1.20.1", "47.3.0").url}.sha256`]: "<html>not found</html>" });
      await expect(forgeInstaller(none, dir, "forge", "1.20.1", "47.3.0")).rejects.toMatchObject({ code: "no-checksum" });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("starts a modern install from its args files, an old one from its jar", async () => {
    const dir = await tmp();
    try {
      await mkdir(join(dir, "libraries/net/neoforged/neoforge/21.1.209"), { recursive: true });
      await writeFile(join(dir, "libraries/net/neoforged/neoforge/21.1.209/unix_args.txt"), "-cp x");
      await writeFile(join(dir, "user_jvm_args.txt"), "");
      expect(await serverArgs(dir, "neoforge", "1.21.1", "21.1.209")).toEqual(["@user_jvm_args.txt", "@libraries/net/neoforged/neoforge/21.1.209/unix_args.txt", "nogui"]);

      await writeFile(join(dir, "forge-1.16.5-36.2.39.jar"), "PK");
      await writeFile(join(dir, "forge-1.16.5-36.2.39-installer.jar"), "PK");
      expect(await serverArgs(dir, "forge", "1.16.5", "36.2.39")).toEqual(["-jar", "forge-1.16.5-36.2.39.jar", "nogui"]);
      await expect(serverArgs(dir, "forge", "1.18.2", "40.2.0")).rejects.toMatchObject({ code: "install-incomplete" });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
