import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReasonStore } from "../src/main/instances/reasons";

describe("why it is here (GRP-1)", () => {
  it("keeps a mod's first reason, merges every mod that needs a library, upgrades 'unknown'", async () => {
    const dir = await mkdtemp(join(tmpdir(), "packsmith-reasons-"));
    try {
      const s = new ReasonStore(dir);
      expect(await s.all("p")).toEqual({});
      await s.record("p", [{ projectId: "map", reason: { kind: "agent-chosen", of: [], text: "a map in the corner" } }, { projectId: "fapi", reason: { kind: "dependency", of: ["map"] } }, { projectId: "old", reason: { kind: "unknown", of: [] } }]);
      await s.record("p", [{ projectId: "map", reason: { kind: "requested", of: [] } }, { projectId: "fapi", reason: { kind: "dependency", of: ["way", "map"] } }, { projectId: "old", reason: { kind: "requested", of: [] } }]);
      expect(await s.all("p")).toEqual({
        map: { kind: "agent-chosen", of: [], text: "a map in the corner" },
        fapi: { kind: "dependency", of: ["map", "way"] },
        old: { kind: "requested", of: [] },
      });
      expect(await s.all("other")).toEqual({});
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
