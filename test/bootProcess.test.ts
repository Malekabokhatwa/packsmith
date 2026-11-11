import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runBoot, SERVER_MARKS, killAllTests } from "../src/main/testing/process";

const FAKE = join(__dirname, "support/fake-server.cjs");
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function boot(mode: string, extra: Partial<Parameters<typeof runBoot>[0]> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "ps-boot-"));
  return runBoot({ command: process.execPath, args: [FAKE, mode], cwd: dir, logPath: join(dir, "logs/boot.log"), timeoutMs: 3000, graceMs: 500, marks: SERVER_MARKS, stopInput: "stop\n", ...extra });
}

describe("runBoot (SPEC 8.6, 11.3)", () => {
  it("a clean boot reaches the world, proves it with the log lines, and stops by itself", async () => {
    const r = await boot("ok");
    expect(r.reached).toBe("world");
    expect(r.proof).toEqual([expect.stringContaining("Starting minecraft server"), expect.stringContaining("Done (")]);
    expect(r.exitCode).toBe(0);
    expect(r.timedOut).toBe(false);
    expect(await readFile(r.logPath, "utf8")).toContain("Stopping server");
  });

  it("a crash before booting reaches nothing and keeps the failing tail", async () => {
    const r = await boot("crash");
    expect(r.reached).toBe("none");
    expect(r.proof).toEqual([]);
    expect(r.tail.join("\n")).toContain("Incompatible mods found!");
    expect(r.exitCode).toBe(1);
  });

  it("a boot that never loads a world is cut off at the timeout with the rung it really reached", async () => {
    const r = await boot("hang", { timeoutMs: 400 });
    expect(r.timedOut).toBe(true);
    expect(r.reached).toBe("boots");
  });

  it("a server that ignores stop is killed after the grace period", async () => {
    const r = await boot("stubborn", { graceMs: 200 });
    expect(r.reached).toBe("world");
    expect(r.durationMs).toBeLessThan(2500);
  });

  it("STOP kills the whole process group, grandchildren too", async () => {
    const ctl = new AbortController();
    let grandchild = 0;
    const p = boot("child", { signal: ctl.signal, onLine: (l) => { const m = l.match(/GRANDCHILD (\d+)/); if (m) { grandchild = Number(m[1]); ctl.abort(); } } });
    const r = await p;
    expect(r.stopped).toBe(true);
    expect(grandchild).toBeGreaterThan(0);
    await new Promise((res) => setTimeout(res, 100));
    expect(alive(grandchild)).toBe(false);
  });

  it("killAllTests ends running tests (app quit)", async () => {
    const p = boot("hang", { timeoutMs: 10_000 });
    await new Promise((res) => setTimeout(res, 300));
    killAllTests();
    const r = await p;
    expect(r.durationMs).toBeLessThan(5000);
    expect(r.timedOut).toBe(false);
  });
});

describe("scrub", () => {
  it("removes tokens and account ids from launch lines", async () => {
    const { scrub } = await import("../src/main/testing/process");
    const line = "java ... --username Steve --uuid 1234abcd --accessToken eyJhbGciOiJIUzI1NiJ9.FAKE.TEST --userType msa";
    const out = scrub(line);
    expect(out).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(out).not.toContain("1234abcd");
    expect(out).toContain("--accessToken [redacted]");
    expect(scrub('{"accessToken": "FAKETESTTOKEN0123456789abc"}')).toBe('{"accessToken": "[redacted]"}');
  });
});
