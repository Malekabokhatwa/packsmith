import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { branchFrom } from "../src/main/testing/service";
import type { BootResult } from "../src/main/testing/process";

const boot = (over: Partial<BootResult>): BootResult => ({ reached: "none", proof: [], tail: [], log: "", logPath: "/l", timedOut: false, stopped: false, exitCode: 1, durationMs: 4000, ...over });
const fixture = (n: string) => readFileSync(join(__dirname, "fixtures/crash", n), "utf8");

describe("what a boot proves (11.3)", () => {
  it("a download that failed before the start is 'not tested', never a failed rung", () => {
    // Real (e2e on a flaky network, 2026-11-03): Fabric's launcher timed out fetching a library.
    const log = "Caused by: java.net.SocketTimeoutException: Read timed out\n\tat net.fabricmc.installer.util.HttpClient.lambda$downloadFile$2(HttpClient.java:61)\n";
    const b = branchFrom("server", boot({ log, tail: log.split("\n") }), 1);
    expect(b).toMatchObject({ status: "not-tested", reached: 1 });
    expect(b.note).toMatch(/download failed .*network/);
    expect(b.failedAt).toBeUndefined();
  });

  it("a real pack failure stays a failure even if the log also mentions a network error", () => {
    const log = `${fixture("fabric-client-breaks.log")}\n[Render thread/ERROR]: io exception while checking versions: java.net.SocketTimeoutException\n`;
    const b = branchFrom("client", boot({ log }), 1);
    expect(b).toMatchObject({ status: "failed", failedAt: 2 });
    expect(b.diagnosis?.kind).toBe("incompatible_mods");
  });

  it("proves Loads a world only with rung 1, and a timeout is a failure at the rung it got stuck on", () => {
    expect(branchFrom("server", boot({ reached: "world", proof: ["Starting", "Done (3.3s)!"], exitCode: 0 }), 1)).toMatchObject({ status: "proven", reached: 3 });
    expect(branchFrom("server", boot({ reached: "world" }), 0)).toMatchObject({ status: "failed", failedAt: 1, reached: 0 });
    expect(branchFrom("server", boot({ reached: "boots", timedOut: true, log: "java.net.SocketTimeoutException" }), 1)).toMatchObject({ status: "failed", failedAt: 3, note: "The server didn't finish loading in time." });
  });
});
