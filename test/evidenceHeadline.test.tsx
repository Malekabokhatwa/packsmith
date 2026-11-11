import { describe, expect, it } from "vitest";
import { headline } from "../src/renderer/components/EvidenceLadder";
import type { BranchReport, TestReport } from "../src/shared/schema";

const branch = (b: BranchReport["branch"], status: BranchReport["status"], reached: number): BranchReport => ({ branch: b, status, reached, proof: [], tail: [], note: "" });
const report = (...branches: BranchReport[]): TestReport => ({ instanceId: "p", at: "2026-11-10T00:00:00.000Z", resolved: { ok: true, note: "" }, branches });

describe("evidence ladder headline", () => {
  it("names both branches when both loaded a world (live 2026-11-10 it said only 'server')", () => {
    expect(headline(report(branch("server", "proven", 3), branch("client", "proven", 3))).text).toBe("Proven up to: Loads a world (server and client)");
  });
  it("names only the branch that got there", () => {
    expect(headline(report(branch("server", "proven", 3), branch("client", "not-tested", 1))).text).toBe("Proven up to: Loads a world (server)");
  });
});
