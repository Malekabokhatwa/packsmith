// Runs one Minecraft boot test as a child process (SPEC 8.6): its own process group, low CPU
// priority, a hard timeout, output to a log file. STOP (the run's abort signal) and app quit kill
// the whole group. The log is watched for the evidence-ladder marks; a rung counts only when its
// line was actually printed (SPEC 11.3).
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export interface BootMarks { boots: RegExp; world: RegExp }
export const SERVER_MARKS: BootMarks = { boots: /Starting minecraft server version /, world: /\bDone \(\d/ };

export interface BootResult {
  reached: "none" | "boots" | "world";
  proof: string[];          // the log lines that prove each reached mark
  tail: string[];           // last lines of output (for a failure)
  log: string;              // the whole output (also in logPath), capped
  logPath: string;
  timedOut: boolean;
  stopped: boolean;         // aborted by STOP
  exitCode: number | null;
  durationMs: number;
}

export interface BootSpec {
  command: string;
  args: string[];
  cwd: string;
  logPath: string;
  timeoutMs: number;
  marks: BootMarks;
  stopInput?: string;       // written to stdin once the world mark is seen (server: "stop\n")
  graceMs?: number;         // how long to wait for a clean exit after stopInput / timeout
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  onLine?: (line: string) => void;
}

const live = new Set<number>(); // process group ids of running tests

function killGroup(pid: number, sig: NodeJS.Signals): void {
  try { process.kill(-pid, sig); } catch { /* already gone */ }
}

// App quit: no test may outlive packsmith.
export function killAllTests(): void {
  for (const pid of live) killGroup(pid, "SIGKILL");
  live.clear();
}

const MAX_LOG = 4 * 1024 * 1024;

// Launch lines carry the account's token and ids: they never reach a log file, the UI or the
// model (SPEC 8.3, 8.9).
export function scrub(line: string): string {
  return line
    .replace(/(--(?:accessToken|session|uuid|xuid|clientId|userType)\s+)\S+/gi, "$1[redacted]")
    .replace(/((?:accessToken|session|token)["']?\s*[:=]\s*["']?)[A-Za-z0-9._-]{16,}/gi, "$1[redacted]");
}

export async function runBoot(spec: BootSpec): Promise<BootResult> {
  await mkdir(dirname(spec.logPath), { recursive: true });
  const out = createWriteStream(spec.logPath);
  const started = Date.now();
  // `nice` keeps the desktop responsive (PERF-6); detached = own process group.
  const child = spawn("nice", ["-n", "10", spec.command, ...spec.args], { cwd: spec.cwd, detached: true, stdio: ["pipe", "pipe", "pipe"], env: spec.env ?? process.env });
  const pid = child.pid!;
  live.add(pid);

  let reached: BootResult["reached"] = "none";
  const proof: string[] = [];
  const tail: string[] = [];
  let log = "";
  let timedOut = false;
  let stopped = false;
  let killTimer: NodeJS.Timeout | undefined;

  const finish = (sig: NodeJS.Signals = "SIGTERM") => {
    killGroup(pid, sig);
    killTimer ??= setTimeout(() => killGroup(pid, "SIGKILL"), spec.graceMs ?? 15_000);
  };
  const onAbort = () => { stopped = true; finish("SIGKILL"); };
  if (spec.signal?.aborted) onAbort();
  spec.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => { timedOut = true; finish(); }, spec.timeoutMs);

  let partial = "";
  const onData = (chunk: Buffer) => {
    const text = partial + chunk.toString("utf8");
    const lines = text.split(/\r?\n/);
    partial = lines.pop() ?? "";
    for (const line of lines) handle(line);
  };
  const handle = (raw: string) => {
    const line = scrub(raw);
    out.write(`${line}\n`);
    if (log.length < MAX_LOG) log += `${line}\n`;
    tail.push(line);
    if (tail.length > 40) tail.shift();
    spec.onLine?.(line);
    if (reached === "none" && spec.marks.boots.test(line)) { reached = "boots"; proof.push(line); }
    if (reached !== "world" && spec.marks.world.test(line)) {
      reached = "world"; proof.push(line);
      if (spec.stopInput) child.stdin.write(spec.stopInput);
      killTimer ??= setTimeout(() => killGroup(pid, "SIGKILL"), spec.graceMs ?? 15_000);
    }
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  child.stdin.on("error", () => undefined);

  const exitCode = await new Promise<number | null>((res) => {
    child.on("error", () => res(null));
    child.on("close", (code) => res(code));
  });
  if (partial) handle(partial);
  clearTimeout(timer);
  if (killTimer) clearTimeout(killTimer);
  spec.signal?.removeEventListener("abort", onAbort);
  killGroup(pid, "SIGKILL"); // anything the game left behind in its group
  live.delete(pid);
  await new Promise<void>((res) => out.end(() => res()));
  return { reached, proof: [...new Set(proof)], tail, log, logPath: spec.logPath, timedOut, stopped, exitCode, durationMs: Date.now() - started };
}
