import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TOOLS, type ToolContext } from "../src/main/agent/tools";
import { diagnose } from "../src/main/crash/diagnose";
import type { TestReport } from "../src/shared/schema";

const tool = TOOLS.find((t) => t.name === "launch_test")!;
const record = { id: "p1", origin: "own", name: "Trail", path: "/nowhere", mcVersion: "1.21.1", loader: "fabric", launcher: "app-managed", createdAt: "2026-11-03T00:00:00.000Z", groupPending: false };
const log = readFileSync(join(__dirname, "fixtures/crash/fabric-missing-dependency.log"), "utf8");

function failing(stamp: string): TestReport {
  return {
    instanceId: "p1", at: "2026-11-03T00:00:00.000Z",
    resolved: { ok: false, note: "Missing required: Balm, Fabric API." },
    branches: [
      { branch: "server", status: "failed", reached: 0, failedAt: 2, proof: [], tail: [`[${stamp}] [main/ERROR]: Incompatible mods found!`], note: "The server stopped before it started.", diagnosis: diagnose(log.replaceAll("18:05:41", stamp)) },
      { branch: "client", status: "not-tested", reached: 0, proof: [], tail: [], note: "not set up" },
    ],
  };
}
const proven: TestReport = {
  instanceId: "p1", at: "2026-11-03T00:00:00.000Z", resolved: { ok: true, note: "3 mods" },
  branches: [
    { branch: "server", status: "proven", reached: 3, proof: ["Starting minecraft server version 1.21.1", "Done (3.3s)!"], tail: [], note: "ok" },
    { branch: "client", status: "not-tested", reached: 1, proof: [], tail: [], note: "not set up" },
  ],
};

function ctx(reports: TestReport[], extra: Partial<ToolContext> = {}) {
  const shown: TestReport[] = [];
  const c: ToolContext = {
    packs: { list: async () => [record] } as never,
    modrinth: { projects: async (ids: string[]) => ids.filter((i) => i === "balm" || i === "fabric-api").map((i) => ({ id: `ID-${i}`, slug: i })) } as never,
    searchConfigured: false,
    tester: { test: async () => structuredClone(reports.shift()!) } as never,
    onTestReport: (r) => shown.push(r),
    testRuns: { used: 0, limit: 3 },
    ...extra,
  };
  return { c, shown };
}
const run = (c: ToolContext) => tool.run(tool.input.parse({ instance_id: "p1" }) as never, c);

describe("launch_test tool", () => {
  it("a failure is an error naming the culprits with Modrinth ids, the same text every time (stagnation)", async () => {
    const { c, shown } = ctx([failing("18:05:41"), failing("09:00:00")]);
    const a = await run(c).catch((e: Error) => e.message);
    const b = await run(c).catch((e: Error) => e.message);
    expect(a).toContain("server: proven nothing, failed at \"Boots\"");
    expect(a).toContain("balm (missing, needed by waystones, Modrinth project ID-balm)");
    expect(a).toContain("fabric-api (missing, needed by waystones, Modrinth project ID-fabric-api)");
    expect(a).toContain("client: not tested");
    expect(a).toBe(b);
    expect(shown).toHaveLength(2); // the ladder is shown either way
  });

  it("a pass returns the proven rungs and their log lines", async () => {
    const { c } = ctx([proven]);
    const res = await run(c);
    expect(res.summary).toBe("server: proven up to \"Loads a world\" · client: not tested");
    expect(JSON.stringify(res.data)).toContain("Done (3.3s)!");
  });

  it("stops at the test-run budget (PERF-5) without testing", async () => {
    const { c } = ctx([proven], { testRuns: { used: 3, limit: 3 } });
    await expect(run(c)).rejects.toThrow(/used its 3 boot tests/);
  });

  it("refuses while a plan waits for the user", async () => {
    const { c } = ctx([proven], { plan: { pending: true, show: () => undefined } });
    await expect(run(c)).rejects.toThrow(/plan is on screen/);
  });
});

describe("diagnose_crash tool", () => {
  const diag = TOOLS.find((t) => t.name === "diagnose_crash")!;
  async function pack(withLog: boolean) {
    const { mkdtemp, mkdir, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const dir = await mkdtemp(join(tmpdir(), "ps-diag-"));
    await mkdir(join(dir, "minecraft/logs"), { recursive: true });
    if (withLog) await writeFile(join(dir, "minecraft/logs/latest.log"), readFileSync(join(__dirname, "fixtures/crash/fabric-breaks-before.log"), "utf8"));
    return { ...record, path: dir };
  }
  const ctxFor = (rec: typeof record, last: TestReport = failing("18:05:41"), history: Array<{ at: string }> = []) =>
    ctx([], { packs: { list: async () => [rec], history: async () => history } as never, tester: { last: async () => last } as never }).c;

  it("without a log in the pack, reads the last boot test's failure instead of failing", async () => {
    const res = await diag.run(diag.input.parse({ instance_id: "p1" }) as never, ctxFor(await pack(false)));
    expect(res.data).toMatchObject({ file: "the last boot test (server, 2026-11-03T00:00:00.000Z)", kind: "missing_dependency" });
  });

  it("a log in the pack still wins over the last boot test", async () => {
    const res = await diag.run(diag.input.parse({ instance_id: "p1" }) as never, ctxFor(await pack(true)));
    expect(res.data).toMatchObject({ file: "minecraft/logs/latest.log", kind: "incompatible_mods" });
  });

  it("re-reads the last test's own log: a diagnosis stored by older code was 'unknown' (live 2026-11-10)", async () => {
    const { writeFile } = await import("node:fs/promises");
    const rec = await pack(false);
    const logPath = join(rec.path, "server.log");
    await writeFile(logPath, readFileSync(join(__dirname, "fixtures/crash/fabric-breaks-before.log"), "utf8"));
    const stale = failing("18:05:41");
    stale.branches[0] = { ...stale.branches[0]!, logPath, diagnosis: { ...diagnose(""), kind: "unknown" } };
    const res = await diag.run(diag.input.parse({ instance_id: "p1" }) as never, ctxFor(rec, stale));
    expect(res.data).toMatchObject({ kind: "incompatible_mods" });
    expect(res.data).not.toHaveProperty("note");
  });

  it("says when the pack changed after that test", async () => {
    const res = await diag.run(diag.input.parse({ instance_id: "p1" }) as never, ctxFor(await pack(false), failing("18:05:41"), [{ at: "2026-11-04T00:00:00.000Z" }]));
    expect(res.summary).toBe("missing dependency (last boot test, pack changed since)");
    expect(res.data).toMatchObject({ note: expect.stringMatching(/changed since this test: run launch_test/) });
  });
});
