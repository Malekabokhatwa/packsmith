import { describe, expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ZipReader, withZip } from "../src/main/archive/zip";
import { makeZip } from "./support/zipWriter";
import { tempDir } from "./helpers";

describe("zip reader (jars)", () => {
  it("lists and reads stored and deflated entries", async () => {
    const dir = await tempDir();
    for (const store of [false, true]) {
      const p = join(dir, `t${store}.jar`);
      await writeFile(p, makeZip({ "fabric.mod.json": '{"id":"x"}', "assets/x/textures/item/a.png": Buffer.from([1, 2, 3]) }, { store }));
      await withZip(p, async (z) => {
        expect(z.names()).toEqual(["fabric.mod.json", "assets/x/textures/item/a.png"]);
        expect(await z.text("fabric.mod.json")).toBe('{"id":"x"}');
        expect(await z.read("assets/x/textures/item/a.png")).toEqual(Buffer.from([1, 2, 3]));
        expect(await z.read("missing")).toBeNull();
      });
    }
  });

  it("refuses a file that isn't a zip", async () => {
    const p = join(await tempDir(), "x.jar");
    await writeFile(p, "not a zip at all");
    await expect(ZipReader.open(p)).rejects.toMatchObject({ code: "bad-zip" });
  });
});
